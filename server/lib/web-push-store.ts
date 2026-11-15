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
/** Lead 10:3x: at most one test ping every 10 s, and 20 a day per Mac. Counted before the send, kept across a restart. */
export const TEST_PING_GAP_MS = 10_000
export const TEST_PINGS_PER_DAY = 20

/** The local calendar day ("today" in his time zone, as the Mac keeps it). */
function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
  /** Explicit per-device opt-in. Old proof subscriptions never receive production banners. */
  production?: boolean
  /** Lock-screen words are off unless explicitly chosen for this device. */
  showWords?: boolean
}

/** What a route may show: never the endpoint path or the keys. */
export interface PushDeviceView { id: string; label: string; addedAt: string; service: string; production: boolean; showWords: boolean }

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
  add(input: { endpoint: unknown; keys: unknown; origin: string; label?: unknown; production?: boolean; showWords?: boolean }): { ok: true; id: string } | { ok: false; reason: 'bad_endpoint' | 'bad_keys' | 'too_many_devices' } {
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
      // A proof-page refresh never silently enrolls a phone for production or changes its privacy preference.
      if (input.production !== undefined) existing.production = input.production === true
      if (input.showWords !== undefined) existing.showWords = input.showWords === true
      this.write('devices.json', { devices })
      return { ok: true, id: existing.id }
    }
    if (devices.length >= MAX_PUSH_DEVICES) return { ok: false, reason: 'too_many_devices' }
    const id = randomBytes(8).toString('hex')
    devices.push({ id, endpoint: input.endpoint, keys: { p256dh: (input.keys as PushKeys).p256dh, auth: (input.keys as PushKeys).auth }, origin: input.origin, label: label || 'Phone', addedAt: at, production: input.production === true, showWords: input.showWords === true })
    this.write('devices.json', { devices })
    return { ok: true, id }
  }

  preferences(id: string, showWords: boolean): boolean {
    const devices = this.devices(), device = devices.find(d => d.id === id)
    if (!device) return false
    device.showWords = showWords
    this.write('devices.json', { devices })
    return true
  }

  /** Removes one phone by id. True when it was there. */
  remove(id: string): boolean {
    const devices = this.devices()
    const kept = devices.filter(d => d.id !== id)
    if (kept.length === devices.length) return false
    this.write('devices.json', { devices: kept })
    return true
  }

  /**
   * Counts one test ping BEFORE it is sent, or refuses it. Kept in push/test-pings.json (0600), so a restart keeps
   * both limits. A clock that went backwards reads as too soon, for at most one gap. A failed write throws: no count,
   * no send.
   */
  claimTestPing(): { ok: true } | { ok: false; reason: 'too_soon' | 'daily_cap' } {
    const now = this.now()
    const stored = this.read('test-pings.json') as { day?: unknown; count?: unknown; lastAt?: unknown } | null
    const day = localDay(now)
    const storedDay = typeof stored?.day === 'string' ? stored.day : null
    const storedCount = typeof stored?.count === 'number' && Number.isInteger(stored.count) && stored.count >= 0 ? stored.count : 0
    // Lead 10:4x: a day stamp in the future (a clock set back, a damaged file) counts as TODAY, never as a fresh day.
    const count = storedDay !== null && (storedDay === day || storedDay > day) ? storedCount : 0
    const lastAt = typeof stored?.lastAt === 'number' && Number.isFinite(stored.lastAt) ? stored.lastAt : null
    // Q1 (10:4x): re-stamp a future day to today before anything returns, or a refusal would leave it there and lock
    // every later day until that date.
    if (storedDay !== null && storedDay > day) this.write('test-pings.json', { day, count, lastAt })
    // Lead 10:4x: a lastAt more than one gap ahead is a bad record. Refuse this one send and reset lastAt to now, so the
    // lock after any clock change or damaged file lasts at most one gap, never until real time catches up.
    if (lastAt !== null && lastAt - now > TEST_PING_GAP_MS) {
      this.write('test-pings.json', { day, count, lastAt: now })
      return { ok: false, reason: 'too_soon' }
    }
    if (lastAt !== null && now - lastAt < TEST_PING_GAP_MS) return { ok: false, reason: 'too_soon' }
    if (count >= TEST_PINGS_PER_DAY) return { ok: false, reason: 'daily_cap' }
    this.write('test-pings.json', { day, count: count + 1, lastAt: now })
    return { ok: true }
  }

  get(id: string): PushDevice | null {
    return this.devices().find(d => d.id === id) ?? null
  }

  /** The list a route shows. */
  view(): PushDeviceView[] {
    return this.devices().map(d => ({ id: d.id, label: d.label, addedAt: d.addedAt, service: new URL(d.endpoint).hostname, production: d.production === true, showWords: d.showWords === true }))
  }
}
