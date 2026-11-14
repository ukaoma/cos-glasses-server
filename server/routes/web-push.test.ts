// X1 (iPhone pings, one-ping proof): the store, the sender and the routes; and that with COS_WEB_PUSH off nothing
// exists. A fake POST records exactly what would leave the Mac; a test phone key decrypts it. No network.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createDecipheriv, createECDH, hkdfSync, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64u, fromB64u, vapidPublicKeyObject } from '../lib/web-push-crypto.js'
import { isAllowedPushEndpoint, MAX_PUSH_DEVICES, PUSH_DIR_MODE, PUSH_FILE_MODE, TEST_PING_GAP_MS, TEST_PINGS_PER_DAY, WebPushStore } from '../lib/web-push-store.js'
import { applePushReason, PING_TTL_SECONDS, pingTopic, sendOnePing, VAPID_SUBJECT, type PushPost } from '../lib/web-push-sender.js'
import { createWebPushRouter, TEST_PING_REFUSED_COPY, webPushEnabled } from './web-push.js'
import { requireApiToken } from '../lib/api-auth.js'
import { isPublicApiRequest } from '../lib/api-auth.js'

const ORIGIN = 'https://mac-x1.example-tailnet.ts.net:3143'
const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMH6cTPXQ8xsAeBCs?x=1'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
function storeDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'web-push-'))
  dirs.push(base)
  return join(base, 'push')
}
/** A phone: its push key pair and auth secret, and the subscription it would hand the page. */
function phone() {
  const ua = createECDH('prime256v1'); ua.generateKeys()
  const auth = Buffer.from('fedcba9876543210')
  return { ua, auth, subscription: { endpoint: ENDPOINT, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } } }
}
function decrypt(body: Buffer, p: ReturnType<typeof phone>): string {
  const salt = body.subarray(0, 16), idlen = body.readUInt8(20), asPublic = body.subarray(21, 21 + idlen), record = body.subarray(21 + idlen)
  const secret = p.ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, p.auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), p.ua.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  return padded.subarray(0, padded.length - 1).toString()
}
const mode = (path: string) => statSync(path).mode & 0o777

describe('X1 web push: the switch COS_WEB_PUSH', () => {
  it('is off by default and on only for 1, true or on', () => {
    expect(webPushEnabled({})).toBe(false)
    for (const on of ['1', 'true', 'on']) expect(webPushEnabled({ COS_WEB_PUSH: on })).toBe(true)
    for (const off of ['', '0', 'off', 'yes']) expect(webPushEnabled({ COS_WEB_PUSH: off })).toBe(false)
  })

  it('off: index.ts mounts no route and builds no store; the switch is listed in the contract and .env.example', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const at = index.indexOf('if (webPushEnabled()) {')
    expect(at).toBeGreaterThan(0)
    // The only router mount and the only store construction sit inside that branch.
    expect(index.split('createWebPushRouter(').length - 1).toBe(1)
    expect(index.split('new WebPushStore(').length - 1).toBe(1)
    expect(index.indexOf('createWebPushRouter(')).toBeGreaterThan(at)
    expect(index.indexOf('new WebPushStore(')).toBeGreaterThan(at)
    expect(index.slice(at, index.indexOf('\n}\n', at))).toContain("store: new WebPushStore(dataPath('push')),")
    expect(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')).toContain('"COS_WEB_PUSH"')
    expect(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')).toMatch(/^# COS_WEB_PUSH=1$/m)
  })
})

describe('X1 web push: behind the sign-in', () => {
  it('every /web-push path needs the API token or the signed-in web session: none is public, and the router mounts after requireApiToken', () => {
    for (const [method, path] of [['GET', '/web-push/key'], ['GET', '/web-push/devices'], ['POST', '/web-push/devices'], ['DELETE', '/web-push/devices/0123456789abcdef'], ['POST', '/web-push/test']]) {
      expect({ method, path, public: isPublicApiRequest(method!, path!) }).toEqual({ method, path, public: false })
    }
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const auth = index.indexOf("app.use('/api', requireApiToken(")
    expect(auth).toBeGreaterThan(0)
    expect(index.indexOf('createWebPushRouter(')).toBeGreaterThan(auth)
  })
})

describe('X1 web push: the store', () => {
  it('makes nothing until asked: no folder for a new store, the key only on the first read, then the same key', () => {
    const dir = storeDir()
    const store = new WebPushStore(dir)
    expect(store.devices()).toEqual([])
    expect(existsSync(dir)).toBe(false)
    const k1 = store.vapidKeys()
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'vapid.json'))).toBe(0o600)
    expect([PUSH_DIR_MODE, PUSH_FILE_MODE]).toEqual([0o700, 0o600])
    expect(new WebPushStore(dir).vapidKeys()).toEqual(k1)
    expect(fromB64u(k1.publicKey).length).toBe(65)
  })

  it('endpoints only on Apple\'s push service, over https, with no port or user info', () => {
    for (const ok of [ENDPOINT, 'https://api.push.apple.com/x', 'https://push.apple.com/x']) expect(isAllowedPushEndpoint(ok)).toBe(true)
    for (const bad of ['http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://u:p@web.push.apple.com/x', 'https://evilpush.apple.com.example/x',
      'https://fcm.googleapis.com/fcm/send/x', 'https://notpush.apple.com/x', 'https://127.0.0.1/x', 'nonsense', 42]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false)
    }
  })

  it('adds a phone (0600), refreshes the same endpoint in place, caps at 8, removes by id, and its view hides the endpoint and keys', () => {
    const dir = storeDir()
    const store = new WebPushStore(dir)
    const p = phone()
    const a = store.add({ endpoint: p.subscription.endpoint, keys: p.subscription.keys, origin: ORIGIN, label: 'iPhone\u0007 Duo' })
    expect(a.ok).toBe(true)
    // Adding a phone writes only devices.json: the key is still made on its first read, never here (Q1 P8).
    expect(existsSync(join(dir, 'vapid.json'))).toBe(false)
    expect(mode(join(dir, 'devices.json'))).toBe(0o600)
    const again = store.add({ endpoint: p.subscription.endpoint, keys: p.subscription.keys, origin: ORIGIN })
    expect(again).toEqual(a)
    expect(store.devices()).toHaveLength(1)
    const view = store.view()
    expect(view).toEqual([{ id: (a as { id: string }).id, label: 'iPhone Duo', addedAt: expect.any(String), service: 'web.push.apple.com' }])
    expect(JSON.stringify(view)).not.toContain('QGuQ')
    expect(JSON.stringify(view)).not.toContain(p.subscription.keys.auth)
    expect(store.add({ endpoint: 'https://fcm.googleapis.com/x', keys: p.subscription.keys, origin: ORIGIN })).toEqual({ ok: false, reason: 'bad_endpoint' })
    expect(store.add({ endpoint: ENDPOINT + '2', keys: { p256dh: 'AA', auth: 'BB' }, origin: ORIGIN })).toEqual({ ok: false, reason: 'bad_keys' })
    for (let i = 1; i < MAX_PUSH_DEVICES; i++) expect(store.add({ endpoint: `${ENDPOINT}&d=${i}`, keys: phone().subscription.keys, origin: ORIGIN }).ok).toBe(true)
    expect(store.add({ endpoint: `${ENDPOINT}&d=99`, keys: phone().subscription.keys, origin: ORIGIN })).toEqual({ ok: false, reason: 'too_many_devices' })
    expect(store.remove((a as { id: string }).id)).toBe(true)
    expect(store.remove((a as { id: string }).id)).toBe(false)
    expect(store.devices()).toHaveLength(MAX_PUSH_DEVICES - 1)
  })
})

describe('X1 web push: one ping', () => {
  function rig() {
    const store = new WebPushStore(storeDir())
    const p = phone()
    const added = store.add({ endpoint: p.subscription.endpoint, keys: p.subscription.keys, origin: ORIGIN }) as { ok: true; id: string }
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = []
    let answer = { status: 201, reason: null as string | null }
    const post: PushPost = async (url, headers, body) => { sent.push({ url, headers, body }); return answer }
    return { store, p, id: added.id, sent, post, answer: (a: { status: number; reason: string | null }) => { answer = a } }
  }

  it('sends exactly one POST to the device endpoint, title only, opening his Control Web; Apple gets only ciphertext', async () => {
    const r = rig()
    const now = 1_794_670_000
    const res = await sendOnePing(r.store, r.id, 'test', { post: r.post, nowSeconds: () => now })
    expect(res).toEqual({ ok: true, status: 201, reason: null, removed: false })
    expect(r.sent).toHaveLength(1)
    const { url, headers, body } = r.sent[0]!
    expect(url).toBe(ENDPOINT)
    expect(JSON.parse(decrypt(body, r.p))).toEqual({ web_push: 8030, notification: { title: 'COS: Test ping', navigate: `${ORIGIN}/control`, silent: false } })
    expect(body.toString('latin1')).not.toContain('COS')
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe('300')
    expect(PING_TTL_SECONDS).toBe(300)
    expect(headers.Urgency).toBe('normal')
    // The Topic is opaque: URL-safe, at most 32 characters, the same for the same kind, and not the kind's words.
    const keys = r.store.vapidKeys()
    expect(headers.Topic).toBe(pingTopic('test', keys.publicKey))
    expect(headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(headers.Topic.toLowerCase()).not.toContain('test')
    // VAPID: our key, the push service as audience, the product URL as subject.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(headers.Authorization!)!
    expect(JSON.parse(fromB64u(m[2]!).toString())).toMatchObject({ aud: 'https://web.push.apple.com', sub: 'https://gotcos.com' })
    expect(VAPID_SUBJECT).toBe('https://gotcos.com')
    expect(m[4]).toBe(keys.publicKey)
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: vapidPublicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' }, fromB64u(m[3]!))).toBe(true)
  })

  it('410 or 404 (the subscription is gone) removes the device; other refusals keep it and return Apple\'s reason code', async () => {
    const r = rig()
    r.answer({ status: 403, reason: 'BadJwtToken' })
    expect(await sendOnePing(r.store, r.id, 'test', { post: r.post })).toEqual({ ok: false, status: 403, reason: 'BadJwtToken', removed: false })
    expect(r.store.get(r.id)).not.toBeNull()
    r.answer({ status: 410, reason: 'ExpiredSubscription' })
    expect(await sendOnePing(r.store, r.id, 'test', { post: r.post })).toMatchObject({ ok: false, status: 410, removed: true })
    expect(r.store.get(r.id)).toBeNull()
    const s2 = rig()
    s2.answer({ status: 404, reason: null })
    expect((await sendOnePing(s2.store, s2.id, 'test', { post: s2.post })).removed).toBe(true)
  })

  it('Apple\'s reason: only a plain word is kept; a URL, an id or other text in the body never comes back (Q1 P14)', () => {
    expect(applePushReason('{"reason":"BadJwtToken"}')).toBe('BadJwtToken')
    expect(applePushReason('{"reason":"ExpiredSubscription","timestamp":1}')).toBe('ExpiredSubscription')
    for (const raw of ['{"reason":"https://web.push.apple.com/QGuQyavXutnMH6cTPXQ8xsAeBCs"}', '{"reason":"Bad Jwt"}', '{"reason":"x".repeat(41)}',
      `{"reason":"${'x'.repeat(41)}"}`, '{"reason":42}', '{"reason":""}', 'not json', '']) {
      expect(applePushReason(raw)).toBeNull()
    }
  })

  it('the real POST runs Apple\'s answer through applePushReason (it is never run in tests, so its source is pinned; Q1 P14b)', () => {
    const src = readFileSync(new URL('../lib/web-push-sender.ts', import.meta.url), 'utf8')
    const post = src.slice(src.indexOf('export const httpsPushPost'), src.indexOf('export interface PingResult'))
    expect(post).toContain('resolve({ status: res.statusCode ?? 0, reason: applePushReason(raw) })')
    expect(post).not.toMatch(/JSON\.parse/)
  })

  it('a redirect is never followed: a 3xx is one request, reported, and the device is kept', async () => {
    const r = rig()
    r.answer({ status: 307, reason: null })
    expect(await sendOnePing(r.store, r.id, 'test', { post: r.post })).toEqual({ ok: false, status: 307, reason: null, removed: false })
    expect(r.sent).toHaveLength(1)
    expect(r.store.get(r.id)).not.toBeNull()
  })

  it('an unknown device, or a stored endpoint that is not Apple\'s, sends nothing', async () => {
    const r = rig()
    expect(await sendOnePing(r.store, '0000000000000000', 'test', { post: r.post })).toMatchObject({ ok: false, reason: 'unknown_device' })
    expect(r.sent).toHaveLength(0)
  })
})

describe('X1 web push: the routes (as mounted with the switch on)', () => {
  let server: Server | null = null
  afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = null })
  async function start(store: WebPushStore, post: PushPost): Promise<string> {
    const app = express()
    app.use(express.json())
    // Like isAllowedNetworkOrigin in index.ts: this Mac's name or IP, http OR https. The route itself must refuse http.
    app.use('/api', createWebPushRouter({ store, originAllowed: o => /^https?:\/\/(mac-x1\.example-tailnet\.ts\.net|100\.112\.1\.2)(:\d+)?$/.test(o), post }))
    await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}`
  }
  function call(base: string, method: string, path: string, body?: unknown, origin?: string): Promise<{ status: number; json: any; text: string }> {
    return new Promise(resolve => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = request(`${base}${path}`, { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(origin ? { origin } : {}) } }, res => {
        let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let json: any = {}; try { json = JSON.parse(raw) } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json, text: raw }) })
      })
      if (data) req.write(data)
      req.end()
    })
  }

  it('subscribe from his https origin, list without endpoints, send ONE test ping on the call, remove the device', async () => {
    const dir = storeDir()
    const store = new WebPushStore(dir)
    const sent: string[] = []
    const bodies: Buffer[] = []
    const base = await start(store, async (url, _h, body) => { sent.push(url); bodies.push(body); return { status: 201, reason: null } })
    expect(existsSync(dir)).toBe(false)
    const key = await call(base, 'GET', '/api/web-push/key')
    expect(fromB64u(key.json.publicKey).length).toBe(65)
    const p = phone()
    expect((await call(base, 'POST', '/api/web-push/devices', { subscription: p.subscription }, 'http://mac-x1.example-tailnet.ts.net:3141')).json).toEqual({ error: 'bad_origin' })
    expect((await call(base, 'POST', '/api/web-push/devices', { subscription: p.subscription })).json).toEqual({ error: 'bad_origin' })
    // An https origin that is not this Mac's: refused by the allow-list, not by the https rule.
    expect((await call(base, 'POST', '/api/web-push/devices', { subscription: p.subscription }, 'https://evil.example')).json).toEqual({ error: 'bad_origin' })
    expect(existsSync(join(dir, 'devices.json'))).toBe(false)
    const added = await call(base, 'POST', '/api/web-push/devices', { subscription: p.subscription, label: 'iPhone' }, ORIGIN)
    expect(added.status).toBe(201)
    const list = await call(base, 'GET', '/api/web-push/devices')
    expect(list.json.devices).toHaveLength(1)
    expect(list.text).not.toContain('QGuQ')
    expect(sent).toHaveLength(0)
    // Extra fields cannot change what is sent: the title is fixed, and so is where a tap goes.
    const ping = await call(base, 'POST', '/api/web-push/test', { deviceId: added.json.id, title: 'pwned', kind: 'other', body: 'secret words', navigate: 'https://evil.example' })
    expect(ping.json).toEqual({ ok: true, status: 201, reason: null, removed: false })
    expect(sent).toEqual([ENDPOINT])
    expect(JSON.parse(decrypt(bodies[0]!, p))).toEqual({ web_push: 8030, notification: { title: 'COS: Test ping', navigate: `${ORIGIN}/control`, silent: false } })
    expect(ping.text).not.toContain('QGuQ')
    expect((await call(base, 'DELETE', `/api/web-push/devices/${added.json.id}`)).json).toEqual({ removed: true })
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: added.json.id })).json).toMatchObject({ ok: false, reason: 'unknown_device' })
    expect(sent).toHaveLength(1)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: '../x' })).status).toBe(400)
  })
})

describe('X1 web push: the test-ping cap and the key behind the sign-in (lead 10:3x)', () => {
  const servers: Server[] = []
  afterEach(async () => { while (servers.length) { const sv = servers.pop()!; await new Promise<void>(r => sv.close(() => r())) } })
  async function app(store: WebPushStore, post: PushPost, token?: string): Promise<string> {
    const a = express()
    a.use(express.json())
    if (token) a.use('/api', requireApiToken(token))
    a.use('/api', createWebPushRouter({ store, originAllowed: o => o === ORIGIN, post }))
    const server: Server = await new Promise(r => { const sv = a.listen(0, '127.0.0.1', () => r(sv)) })
    servers.push(server)
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    return new Promise(resolve => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = request(`${base}${path}`, { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers } }, res => {
        let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let json: any = {}; try { json = JSON.parse(raw) } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json }) })
      })
      if (data) req.write(data)
      req.end()
    })
  }
  /** A store on a fake clock, with one phone added, and a fake POST that counts every request that would leave the Mac. */
  function rig(dir = storeDir(), start = Date.parse('2026-11-14T10:00:00')) {
    const clock = { now: start }
    const store = new WebPushStore(dir, () => clock.now)
    const id = (store.add({ endpoint: ENDPOINT, keys: phone().subscription.keys, origin: ORIGIN }) as { ok: true; id: string }).id
    const sent: string[] = []
    const post: PushPost = async url => { sent.push(url); return { status: 201, reason: null } }
    return { dir, clock, store, id, sent, post }
  }

  it('one test ping every 10 seconds: a second inside the gap is refused with its words and reaches no network', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    r.clock.now += TEST_PING_GAP_MS - 1
    const soon = await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })
    expect(soon.status).toBe(429)
    expect(soon.json).toEqual({ ok: false, status: 0, reason: 'too_soon', reasonCopy: 'Not sent. A test ping was just sent.', removed: false })
    expect(r.sent).toHaveLength(1)
    r.clock.now += 1
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    expect(r.sent).toHaveLength(2)
    expect(TEST_PING_GAP_MS).toBe(10_000)
  })

  it('20 a day: the 21st is refused with its words and reaches no network; the next day counts afresh', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    for (let i = 0; i < 20; i++) {
      expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
      r.clock.now += 11_000
    }
    const capped = await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })
    expect(capped.status).toBe(429)
    expect(capped.json).toMatchObject({ ok: false, reason: 'daily_cap', reasonCopy: "Not sent. Today's test pings are used up." })
    expect(r.sent).toHaveLength(20)
    r.clock.now = Date.parse('2026-11-15T09:00:00')
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    expect(r.sent).toHaveLength(21)
    expect([TEST_PINGS_PER_DAY, TEST_PING_REFUSED_COPY.daily_cap]).toEqual([20, "Not sent. Today's test pings are used up."])
  })

  it('kept across a restart: a new store and router on the same folder still refuse inside the gap; the ledger file is 0600', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    expect(mode(join(r.dir, 'test-pings.json'))).toBe(0o600)
    const restarted = new WebPushStore(r.dir, () => r.clock.now + 5_000)
    const base2 = await app(restarted, r.post)
    expect((await call(base2, 'POST', '/api/web-push/test', { deviceId: r.id })).json).toMatchObject({ ok: false, reason: 'too_soon' })
    expect(r.sent).toHaveLength(1)
  })

  it('a clock that went backwards after a ping reads as too soon, never as a fresh gap (Q1 Q3)', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    r.clock.now -= 5_000
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json).toMatchObject({ ok: false, reason: 'too_soon' })
    expect(r.sent).toHaveLength(1)
  })

  it('a far-future lastAt (the clock set back an hour, or a damaged file) locks for at most one gap, never until real time catches up (lead 10:4x)', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    r.clock.now -= 60 * 60_000
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json).toMatchObject({ ok: false, reason: 'too_soon' })
    r.clock.now += TEST_PING_GAP_MS
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    // A damaged file a year ahead: the same, one refusal, then free after one gap.
    writeFileSync(join(r.dir, 'test-pings.json'), JSON.stringify({ day: '2026-11-14', count: 3, lastAt: r.clock.now + 365 * 24 * 60 * 60_000 }))
    r.clock.now += 60_000
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json).toMatchObject({ ok: false, reason: 'too_soon' })
    r.clock.now += TEST_PING_GAP_MS
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
    expect(r.sent).toHaveLength(3)
  })

  it('a day stamp in the future counts as today: a full count stays full, never a fresh 20 (lead 10:4x)', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    writeFileSync(join(r.dir, 'test-pings.json'), JSON.stringify({ day: '2099-01-01', count: TEST_PINGS_PER_DAY, lastAt: r.clock.now - 60_000 }))
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json).toMatchObject({ ok: false, reason: 'daily_cap' })
    expect(r.sent).toHaveLength(0)
  })

  it('a count that cannot be written sends nothing: 503 cap_unavailable, no POST (Q1 Q5)', async () => {
    const r = rig()
    class BrokenCount extends WebPushStore { override claimTestPing(): never { throw new Error('EROFS') } }
    const broken = new BrokenCount(r.dir, () => r.clock.now)
    const base = await app(broken, r.post)
    const res = await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })
    expect(res.status).toBe(503)
    expect(res.json).toEqual({ ok: false, status: 0, reason: 'cap_unavailable', removed: false })
    expect(r.sent).toHaveLength(0)
  })

  it('an unknown device is not counted: it never uses up the gap', async () => {
    const r = rig()
    const base = await app(r.store, r.post)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: '0000000000000000' })).status).toBe(404)
    expect((await call(base, 'POST', '/api/web-push/test', { deviceId: r.id })).json.ok).toBe(true)
  })

  it('with the switch on, an unauthenticated request makes no key and sends nothing; a signed-in one makes the key once', async () => {
    const dir = storeDir()
    const store = new WebPushStore(dir)
    const sent: string[] = []
    const base = await app(store, async url => { sent.push(url); return { status: 201, reason: null } }, 'tok-0123456789abcdef')
    for (const [method, path] of [['GET', '/api/web-push/key'], ['GET', '/api/web-push/devices'], ['POST', '/api/web-push/test']] as const) {
      expect((await call(base, method, path, method === 'POST' ? { deviceId: '0123456789abcdef' } : undefined)).status).toBe(401)
    }
    expect(existsSync(join(dir, 'vapid.json'))).toBe(false)
    expect(sent).toHaveLength(0)
    const key = await call(base, 'GET', '/api/web-push/key', undefined, { 'x-cos-token': 'tok-0123456789abcdef' })
    expect(key.status).toBe(200)
    expect(existsSync(join(dir, 'vapid.json'))).toBe(true)
  })
})
