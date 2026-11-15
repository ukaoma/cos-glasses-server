// X1 (iPhone pings, one-ping proof): test pushes plus the independently gated production banner destination.
//
// What leaves the Mac: one HTTPS POST to the device's endpoint on Apple's push service, carrying the encrypted payload
// (RFC 8291; Apple cannot read it), the VAPID token (sub is the product URL, never a person's address), and the
// headers TTL, Urgency, Topic and Content-Encoding. The Topic is an opaque id per kind (a hash, so it says nothing),
// letting a newer ping replace an undelivered one. The payload is Declarative Web Push (iOS 18.4 and later, no service
// worker): a title and the URL a tap opens. Title only: "COS" and the kind, never words from a ping.

import { request } from 'node:https'
import { createHash } from 'node:crypto'
import { b64u, encryptPushMessage, vapidAuthorization } from './web-push-crypto.js'
import type { PingBanner } from './ping-engine.js'
import { isAllowedPushEndpoint, type WebPushStore } from './web-push-store.js'

/** Short: a stale ping is noise. Apple keeps an undelivered message at most this long. */
export const PING_TTL_SECONDS = 300
export const PUSH_POST_TIMEOUT_MS = 15_000
/** The VAPID subject: the product's URL, never Miles's address (RFC 8292 needs a URL or mailto). */
export const VAPID_SUBJECT = 'https://gotcos.com'

export type PingKind = 'test'
const KIND_TITLE: Record<PingKind, string> = { test: 'COS: Test ping' }

/** The declarative payload: title only, and where a tap goes (his Control Web origin). */
export function pingPayload(kind: PingKind, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ web_push: 8030, notification: { title: KIND_TITLE[kind], navigate: `${origin}/control`, silent: false } }))
}

/** An opaque Topic per kind and install: 22 URL-safe characters (Apple allows 32), revealing nothing. */
export function pingTopic(kind: string, vapidPublicKey: string): string {
  return b64u(createHash('sha256').update(`cos-ping:${vapidPublicKey}:${kind}`).digest()).slice(0, 22)
}

export type PushPost = (url: string, headers: Record<string, string>, body: Buffer, timeoutMs: number) => Promise<{ status: number; reason: string | null }>

/**
 * Apple's `reason` code from an error body (BadJwtToken, ExpiredSubscription, ...), or null. Only a plain word is
 * kept: anything else (a URL, an id, text from a body Apple did not write) never reaches a response or a log line.
 */
export function applePushReason(raw: string): string | null {
  try {
    const r = JSON.parse(raw).reason
    return typeof r === 'string' && /^[A-Za-z]{1,40}$/.test(r) ? r : null
  } catch {
    return null
  }
}

/** The real POST. Reads at most 4 KB of Apple's answer, keeps only its `reason` code. Never logs the URL. */
export const httpsPushPost: PushPost = (url, headers, body, timeoutMs) => new Promise(resolve => {
  const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': String(body.length) }, timeout: timeoutMs }, res => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { if (raw.length < 4096) raw += chunk })
    res.on('end', () => {
      resolve({ status: res.statusCode ?? 0, reason: applePushReason(raw) })
    })
  })
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, reason: 'IdleTimeout' }) })
  req.on('error', () => resolve({ status: 0, reason: 'NetworkError' }))
  req.end(body)
})

export interface PingResult { ok: boolean; status: number; reason: string | null; removed: boolean }

/**
 * Sends one ping of `kind` to the device `id`. 201 is accepted by Apple, not proof of delivery to a phone. 404 or 410 means the subscription is gone,
 * so the device is removed. Anything else keeps it and returns Apple's reason code. Never throws.
 */
export async function sendOnePing(store: WebPushStore, id: string, kind: PingKind, deps: { post?: PushPost; nowSeconds?: () => number } = {}): Promise<PingResult> {
  let device: ReturnType<WebPushStore['get']>
  try { device = store.get(id) } catch { return { ok: false, status: 0, reason: 'store_unavailable', removed: false } }
  if (!device) return { ok: false, status: 0, reason: 'unknown_device', removed: false }
  if (!isAllowedPushEndpoint(device.endpoint)) return { ok: false, status: 0, reason: 'bad_endpoint', removed: false }
  return sendPayload(store, id, pingPayload(kind, device.origin), kind, deps)
}

async function sendPayload(store: WebPushStore, id: string, payload: Buffer, topic: string, deps: { post?: PushPost; nowSeconds?: () => number }): Promise<PingResult> {
  try {
    const device = store.get(id)
    if (!device || !isAllowedPushEndpoint(device.endpoint)) return { ok: false, status: 0, reason: 'unknown_device', removed: false }
    const keys = store.vapidKeys()
    const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000)
    const body = encryptPushMessage(payload, device.keys)
    const headers: Record<string, string> = {
      Authorization: vapidAuthorization(device.endpoint, keys, now, VAPID_SUBJECT),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PING_TTL_SECONDS),
      Urgency: 'normal',
      Topic: pingTopic(topic, keys.publicKey),
    }
    const res = await (deps.post ?? httpsPushPost)(device.endpoint, headers, body, PUSH_POST_TIMEOUT_MS)
    if (res.status === 201) return { ok: true, status: 201, reason: null, removed: false }
    const gone = res.status === 404 || res.status === 410
    if (gone) store.remove(id)
    return { ok: false, status: res.status, reason: res.reason, removed: gone }
  } catch {
    return { ok: false, status: 0, reason: 'send_failed', removed: false }
  }
}


const SOURCE_LABEL: Record<PingBanner['sources'][number], string> = {
  reminder: 'Reminder', resolution: 'Follow-up', prep: 'Meeting prep', agent: 'Session update',
  followups: 'Follow-ups ready', stale: 'Update', checkin: 'Weekly check-in',
}
/** Only the kind leaves the Mac by default. Never copy the Mac banner title: it can contain private words. */
export function bannerPayload(banner: PingBanner, origin: string, showWords = false): Buffer {
  const kind = banner.feedIds.length > 1 ? `${banner.feedIds.length} updates` : SOURCE_LABEL[banner.sources[0]] ?? 'Update'
  const body = showWords ? Array.from(banner.line.split(/[\r\n]/, 1)[0]).slice(0, 100).join('') : kind
  const item = banner.feedIds[0]
  // Session completions belong in Sessions. Mixed digests retain their COS message so all updates remain visible.
  const sessionOnly = banner.sources.length > 0 && banner.sources.every(source => source === 'agent')
  const navigate = sessionOnly ? `${origin}/control#/sessions/t/sessions` : `${origin}/control#/messages/cos${item ? '/' + encodeURIComponent(item) : ''}`
  return Buffer.from(JSON.stringify({ web_push: 8030, notification: { title: 'COS', body, navigate, silent: false } }))
}

/** Called only for the engine's already-ledgered banners. No retries: a failed phone never repeats the Mac's ping. */
export async function sendBannerPush(store: WebPushStore, banner: PingBanner, deps: { post?: PushPost; nowSeconds?: () => number } = {}): Promise<void> {
  try {
    const devices = store.devices().filter(d => d.production === true)
    await Promise.all(devices.map(d => sendPayload(store, d.id, bannerPayload(banner, d.origin, d.showWords === true),
      banner.sources.join(':'), deps)))
  } catch { /* store, crypto and network failures never fail the original ping */ }
}
