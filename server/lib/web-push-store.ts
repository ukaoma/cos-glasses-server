// X1 (iPhone pings, one-ping proof): the Mac's VAPID key pair and the phones subscribed to it. Files, never logs.
//
//   <data dir>/push/                folder 0700, made only when something is first stored
//   <data dir>/push/vapid.json      0600 { privatePem, publicKey, createdAt }   made on the first key read, never sooner
//   <data dir>/push/devices.json    0600 { devices: [{ id, endpoint, keys, origin, label, addedAt }] }
//
// Both are written with durableAtomicWriteFileSync (fsync, exclusive temp, mode forced after rename). An endpoint is a
// capability URL: anyone holding it with the keys can push to that phone, so it is never logged, never returned by a
// route, and never put in a diagnostic. A device is removed by its id.
//
// Endpoints are accepted only on Apple's push service (https, a host under push.apple.com, no port, no user info):
// the Mac sends to exactly what Apple handed his phone, never to a URL a page made up.

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { newVapidKeys, validPushKeys, type PushKeys, type VapidKeys } from './web-push-crypto.js'

export const PUSH_DIR_MODE = 0o700
export const PUSH_FILE_MODE = 0o600
export const MAX_PUSH_DEVICES = 8
export const MAX_DEVICE_LABEL = 40

/** A subscription endpoint the sender may POST to: https on Apple's push service only. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false
  let u: URL
  try { u = new URL(endpoint) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  const host = u.hostname.toLowerCase()
  return host === 'push.apple.com' || host.endsWith('.push.apple.com')
}

export interface PushDevice {
  id: string
  endpoint: string
  keys: PushKeys
  /** The Control Web origin the phone subscribed from: where a tap on the notification opens. */
  origin: string
  label: string
  addedAt: string
}

/** What a route may show: never the endpoint path or the keys. */
export interface PushDeviceView { id: string; label: string; addedAt: string; service: string }

export class WebPushStore {
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: PUSH_DIR_MODE })
    chmodSync(this.dir, PUSH_DIR_MODE)
  }

  private write(name: string, value: unknown): void {
    this.ensureDir()
    durableAtomicWriteFileSync(join(this.dir, name), JSON.stringify(value), { mode: PUSH_FILE_MODE })
  }

  private read(name: string): unknown {
    try { return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) } catch { return null }
  }

  /** The key pair, made and stored on the first call. Nothing calls this while the switch is off. */
  vapidKeys(): VapidKeys {
    const stored = this.read('vapid.json') as Partial<VapidKeys> | null
    if (stored && typeof stored.privatePem === 'string' && typeof stored.publicKey === 'string') {
      return { privatePem: stored.privatePem, publicKey: stored.publicKey }
    }
    const keys = newVapidKeys()
    this.write('vapid.json', { ...keys, createdAt: new Date(this.now()).toISOString() })
    return keys
  }

  devices(): PushDevice[] {
    const stored = this.read('devices.json') as { devices?: unknown } | null
    const list = Array.isArray(stored?.devices) ? stored!.devices : []
    return list.filter((d): d is PushDevice => !!d && typeof d === 'object'
      && typeof (d as PushDevice).id === 'string'
      && isAllowedPushEndpoint((d as PushDevice).endpoint)
      && validPushKeys((d as PushDevice).keys)
      && typeof (d as PushDevice).origin === 'string')
  }

  /**
   * Adds a phone, or refreshes it when the same endpoint subscribes again (same id). Refuses an endpoint off Apple's
   * service, bad keys, and a ninth device. Returns the id.
   */
  add(input: { endpoint: unknown; keys: unknown; origin: string; label?: unknown }): { ok: true; id: string } | { ok: false; reason: 'bad_endpoint' | 'bad_keys' | 'too_many_devices' } {
    if (!isAllowedPushEndpoint(input.endpoint)) return { ok: false, reason: 'bad_endpoint' }
    if (!validPushKeys(input.keys)) return { ok: false, reason: 'bad_keys' }
    const label = typeof input.label === 'string' ? input.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_DEVICE_LABEL) : ''
    const devices = this.devices()
    const existing = devices.find(d => d.endpoint === input.endpoint)
    const at = new Date(this.now()).toISOString()
    if (existing) {
      existing.keys = { p256dh: (input.keys as PushKeys).p256dh, auth: (input.keys as PushKeys).auth }
      existing.origin = input.origin
      if (label) existing.label = label
      existing.addedAt = at
      this.write('devices.json', { devices })
      return { ok: true, id: existing.id }
    }
    if (devices.length >= MAX_PUSH_DEVICES) return { ok: false, reason: 'too_many_devices' }
    const id = randomBytes(8).toString('hex')
    devices.push({ id, endpoint: input.endpoint, keys: { p256dh: (input.keys as PushKeys).p256dh, auth: (input.keys as PushKeys).auth }, origin: input.origin, label: label || 'Phone', addedAt: at })
    this.write('devices.json', { devices })
    return { ok: true, id }
  }

  /** Removes one phone by id. True when it was there. */
  remove(id: string): boolean {
    const devices = this.devices()
    const kept = devices.filter(d => d.id !== id)
    if (kept.length === devices.length) return false
    this.write('devices.json', { devices: kept })
    return true
  }

  get(id: string): PushDevice | null {
    return this.devices().find(d => d.id === id) ?? null
  }

  /** The list a route shows. */
  view(): PushDeviceView[] {
    return this.devices().map(d => ({ id: d.id, label: d.label, addedAt: d.addedAt, service: new URL(d.endpoint).hostname }))
  }
}
