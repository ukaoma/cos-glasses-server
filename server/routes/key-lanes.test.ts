// Key lanes P1 (plan v4 3.1): /api/key-lanes/* with the switch off, on with no profile, and active.
//
// The app below is mounted in index.ts order: socket stand-in, the global X-Cos-Token gate, the
// key-lanes body parser, the global JSON parser, the key-lanes router, then nothing (Express's own
// 404). A second app without any key-lanes code is "today", and every off-state response is
// compared to it: status, headers (minus Date) and body bytes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'key-lanes-route-'))
const downloads = mkdtempSync(join(tmpdir(), 'key-lanes-downloads-'))
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_KEY_LANES

const { requireApiToken } = await import('../lib/api-auth.js')
const { createKeyLanesBodyParser, createKeyLanesRouter } = await import('./key-lanes.js')
const lanes = await import('../lib/key-lanes.js')
const { dataPath } = await import('../lib/data-dir.js')

const TOKEN = 'test-token-key-lanes-0123456789'
const FAKE_KEY = 'sk-or-v1-feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface9z9z'
const FAKE_CATALOG = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', inUsdPerM: 3, outUsdPerM: 15 },
  { id: 'meta/llama-9', name: 'Llama 9', inUsdPerM: 0.2, outUsdPerM: 0.2 },
]

// Test-only stand-in for the request's socket address (pairing.test.ts does the same).
const fakeSocketIp: RequestHandler = (req, _res, next) => {
  const ip = req.headers['x-test-socket-ip']
  Object.defineProperty(req.socket, 'remoteAddress', { value: typeof ip === 'string' ? ip : '127.0.0.1', configurable: true })
  next()
}

const validateKey = vi.fn(async () => ({ ok: true as const, limitRemainingUsd: 4.5, isFreeTier: false }))
let fetchCatalog = vi.fn(async () => FAKE_CATALOG)

function buildApp(withKeyLanes: boolean, withGate = true) {
  const app = express()
  app.use(fakeSocketIp)
  if (withGate) app.use('/api', requireApiToken(TOKEN))
  if (withKeyLanes) app.use('/api/key-lanes', ...createKeyLanesBodyParser({ apiToken: () => TOKEN }))
  app.use(express.json({ limit: '10mb' }))
  if (withKeyLanes) app.use('/api', createKeyLanesRouter({ apiToken: () => TOKEN, validateKey, fetchCatalog: () => fetchCatalog(), downloadsDir: () => downloads }))
  return app
}

const servers: Server[] = []
async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

let base = '', today = '', ungated = '', ungatedToday = ''
beforeAll(async () => {
  base = await listen(buildApp(true))
  today = await listen(buildApp(false))
  ungated = await listen(buildApp(true, false))
  ungatedToday = await listen(buildApp(false, false))
})
afterAll(() => {
  for (const s of servers) s.close()
  rmSync(dataDir, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true })
  delete process.env.COS_KEY_LANES
})

function wipe() {
  for (const f of readdirSync(dataDir)) rmSync(join(dataDir, f), { recursive: true, force: true })
  for (const f of readdirSync(downloads)) rmSync(join(downloads, f), { recursive: true, force: true })
  lanes.__resetKeyLanesForTests()
}
beforeEach(() => { delete process.env.COS_KEY_LANES; wipe(); validateKey.mockClear(); fetchCatalog = vi.fn(async () => FAKE_CATALOG) })
afterEach(() => { vi.restoreAllMocks() })
const listing = () => readdirSync(dataDir).sort()

interface Call { method: string; path: string; body?: string; ip?: string; token?: string | null; headers?: Record<string, string> }
async function call(origin: string, c: Call) {
  const headers: Record<string, string> = { ...(c.headers ?? {}) }
  if (c.token !== null) headers['x-cos-token'] = c.token ?? TOKEN
  if (c.ip) headers['x-test-socket-ip'] = c.ip
  if (c.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(origin + c.path, { method: c.method, headers, body: c.body })
  const text = await res.text()
  const h: Record<string, string> = {}
  res.headers.forEach((v, k) => { if (k !== 'date' && k !== 'keep-alive' && k !== 'connection') h[k] = v })
  return { status: res.status, headers: h, text }
}
const json = (r: { text: string }) => JSON.parse(r.text)
const store = () => (JSON.parse(readFileSync(dataPath('key-secrets', 'provider-keys.json'), 'utf8')) as { keys: Array<{ ref: string }> }).keys
const post = (path: string, body: unknown, extra: Partial<Call> = {}) => call(base, { method: 'POST', path, body: JSON.stringify(body), ...extra })
const get = (path: string, extra: Partial<Call> = {}) => call(base, { method: 'GET', path, ...extra })

// Every surface plan 3.1 lists, plus near misses. Each is sent with a valid token from loopback
// unless the row says otherwise.
const OFF_CASES: Call[] = [
  { method: 'GET', path: '/api/key-lanes/status' },
  { method: 'GET', path: '/api/key-lanes/catalog' },
  { method: 'POST', path: '/api/key-lanes/keys', body: JSON.stringify({ kind: 'openrouter', key: FAKE_KEY }) },
  { method: 'POST', path: '/api/key-lanes/profiles', body: '{}' },
  { method: 'DELETE', path: '/api/key-lanes/profiles/sonnet' },
  { method: 'DELETE', path: '/api/key-lanes/keys/key_0123456789ab' },
  { method: 'DELETE', path: '/api/key-lanes/keys/key_0123456789ab?force=1' },
  { method: 'POST', path: '/api/key-lanes/remove-all', body: '{}' },
  { method: 'POST', path: '/api/key-lanes/disable', body: '{}' },
  { method: 'GET', path: '/api/key-lanes/enable' },
  { method: 'PUT', path: '/api/key-lanes/enable', body: '{}' },
  { method: 'POST', path: '/api/key-lanes/enable/', body: '{}' },
  { method: 'POST', path: '/api/key-lanes/enable?x=1', body: '{}', ip: '100.64.1.5' },
  { method: 'POST', path: '/api/key-lanes', body: '{}' },
  { method: 'POST', path: '/api/key-lanes/other', body: '{}' },
  // Bigger than the key-lanes parser's 32 KB: the off state must not parse it at all.
  { method: 'POST', path: '/api/key-lanes/keys', body: JSON.stringify({ pad: 'x'.repeat(40_000) }) },
  // The door's own refusals: phone or G2 (Tailscale, LAN), WebView or browser, bad JSON from a phone.
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', ip: '100.64.1.5' },
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', ip: '192.168.1.20' },
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', headers: { origin: 'null' } },
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', headers: { origin: 'http://127.0.0.1:5173' } },
  { method: 'POST', path: '/api/key-lanes/enable', body: `{"key":"${FAKE_KEY}"`, ip: '100.64.1.5' },
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', token: null },
  { method: 'POST', path: '/api/key-lanes/enable', body: '{}', token: 'wrong' },
]

describe('switch off: every path is byte-identical to today, and nothing is written', () => {
  it('COS_KEY_LANES unset: each case matches the app with no key-lanes code', async () => {
    for (const c of OFF_CASES) {
      const mine = await call(base, c), theirs = await call(today, c)
      expect(mine, `${c.method} ${c.path} ${JSON.stringify(c.headers ?? {})} ${c.ip ?? ''}`).toEqual(theirs)
      expect(mine.status === 404 || mine.status === 401 || mine.status === 400).toBe(true)
    }
    expect(listing()).toEqual([])
  })

  it('COS_KEY_LANES=0: even the authenticated loopback enable is today\'s 404, and no file appears', async () => {
    process.env.COS_KEY_LANES = '0'
    for (const c of [...OFF_CASES, { method: 'POST', path: '/api/key-lanes/enable', body: '{}' }]) {
      expect(await call(base, c)).toEqual(await call(today, c))
    }
    expect(listing()).toEqual([])
  })

  it('the door checks the token itself: without the global gate, an unauthenticated enable is still today\'s 404', async () => {
    for (const token of [null, 'wrong']) {
      const c: Call = { method: 'POST', path: '/api/key-lanes/enable', body: '{}', token }
      const mine = await call(ungated, c)
      expect(mine).toEqual(await call(ungatedToday, c))
      expect(mine.status).toBe(404)
    }
    expect(listing()).toEqual([])
  })

  it('a torn body from a phone gets today\'s parser answer, not ours', async () => {
    const r = await call(base, { method: 'POST', path: '/api/key-lanes/keys', body: `{"key":"${FAKE_KEY}"`, ip: '100.64.1.5' })
    expect(r).toEqual(await call(today, { method: 'POST', path: '/api/key-lanes/keys', body: `{"key":"${FAKE_KEY}"`, ip: '100.64.1.5' }))
  })
})

describe('the enable door (the one deliberate off-state difference)', () => {
  it('authenticated loopback POST from a native client enables lanes and is the only writer of key-lanes.json', async () => {
    const r = await post('/api/key-lanes/enable', {})
    expect(r.status).toBe(200)
    expect(json(r)).toEqual({ enabled: true, active: false })
    expect(listing()).toEqual(['key-lanes.json'])
    expect(statSync(dataPath('key-lanes.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(dataPath('key-lanes.json'), 'utf8'))).toMatchObject({ v: 1, enabled: true })
    expect(lanes.keyLanesEnabled()).toBe(true)
  })

  it('a torn JSON body at the open door is refused without echoing a byte of it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await call(base, { method: 'POST', path: '/api/key-lanes/enable', body: `{"key":"${FAKE_KEY}"` })
    expect(r.status).toBe(400)
    expect(r.text).not.toContain(FAKE_KEY.slice(0, 16))
    expect(json(r)).toEqual({ error: 'bad_json', message: 'The request body is not valid JSON.' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(FAKE_KEY.slice(0, 16))
    expect(listing()).toEqual([])
  })
})

describe('switch on, no profile: only the exposure-list rows', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })

  it('status answers with the documented shape and writes nothing', async () => {
    const r = await get('/api/key-lanes/status')
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body).toEqual({ enabled: true, active: false, keys: [], profiles: [], keyedSessionIds: [], resetsAt: expect.stringMatching(/T00:00:00\.000Z$/) })
    // P11: the next UTC midnight, when every key's daily cap resets (the phone shows it).
    const untilReset = Date.parse(body.resetsAt) - Date.now()
    expect(untilReset).toBeGreaterThan(0)
    expect(untilReset).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    expect(listing()).toEqual([])
  })

  it('a path outside the exposure list is still today\'s 404', async () => {
    for (const c of [{ method: 'POST', path: '/api/key-lanes/other', body: '{}' }, { method: 'GET', path: '/api/key-lanes/keys' }, { method: 'POST', path: '/api/key-lanes/phone-outbox', body: '{}' }]) {
      expect(await call(base, c)).toEqual(await call(today, c))
    }
  })

  it('writes are Mac only: a phone, G2 or browser request is refused 403 and nothing is written', async () => {
    const writes: Array<[string, string, string]> = [
      ['POST', '/api/key-lanes/keys', JSON.stringify({ kind: 'openrouter', key: FAKE_KEY })],
      ['POST', '/api/key-lanes/profiles', '{}'],
      ['DELETE', '/api/key-lanes/profiles/sonnet', ''],
      ['DELETE', '/api/key-lanes/keys/key_0123456789ab?force=1', ''],
      ['POST', '/api/key-lanes/remove-all', '{}'],
      ['POST', '/api/key-lanes/enable', '{}'],
      ['POST', '/api/key-lanes/disable', '{}'],
    ]
    for (const [method, path, body] of writes) {
      for (const extra of [{ ip: '100.64.1.5' }, { headers: { origin: 'null' } }, { headers: { origin: 'https://evil.example' } }]) {
        const r = await call(base, { method, path, ...(body ? { body } : {}), ...extra })
        expect(r.status, `${method} ${path} ${JSON.stringify(extra)}`).toBe(403)
        expect(json(r).error).toBe('mac_only')
        expect(r.text).not.toContain(FAKE_KEY)
      }
    }
    expect(validateKey).not.toHaveBeenCalled()
    expect(listing()).toEqual([])
  })

  it('status is readable from the phone (no secret in it)', async () => {
    expect((await get('/api/key-lanes/status', { ip: '100.64.1.5' })).status).toBe(200)
  })

  it('disable with the env switch on reports that the env keeps lanes on', async () => {
    const r = await post('/api/key-lanes/disable', {})
    expect(json(r)).toEqual({ enabled: true, active: false, forcedOnBy: 'COS_KEY_LANES' })
  })
})

describe('keys and profiles (switch on)', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })

  async function saveKey() {
    const r = await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY, capUsd: 1 })
    expect(r.status).toBe(200)
    return json(r).key as { ref: string }
  }

  it('a saved key comes back as ref, kind, last 4 and cap; no route body or log ever carries the secret', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
    const bodies: string[] = []
    const save = await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY })
    bodies.push(save.text)
    expect(save.status).toBe(200)
    const saved = json(save)
    expect(saved).toEqual({ key: { ref: saved.key.ref, kind: 'openrouter', last4: '9z9z', capUsd: 1, savedAt: saved.key.savedAt, validatedAt: saved.key.validatedAt }, credit: { remainingUsd: 4.5, freeTier: false } })
    expect(validateKey).toHaveBeenCalledWith('openrouter', FAKE_KEY, undefined)
    bodies.push((await post('/api/key-lanes/keys', { ref: saved.key.ref, capUsd: 2 })).text)
    bodies.push((await post('/api/key-lanes/profiles', { id: 'sonnet', label: 'Sonnet 5.5', keyRef: saved.key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5' })).text)
    bodies.push((await get('/api/key-lanes/status')).text)
    bodies.push((await get('/api/key-lanes/catalog?q=llama')).text)
    validateKey.mockResolvedValueOnce({ ok: false, error: 'key_rejected', message: 'OpenRouter rejected this key. Check it and paste it again.' } as never)
    bodies.push((await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY.replace('9z9z', '8y8y') })).text)
    bodies.push((await post('/api/key-lanes/keys', { kind: 'anthropic', key: FAKE_KEY })).text)
    bodies.push((await call(base, { method: 'POST', path: '/api/key-lanes/keys', body: `{"kind":"openrouter","key":"${FAKE_KEY}"` })).text)
    bodies.push((await post('/api/key-lanes/remove-all', {})).text)
    for (const b of bodies) {
      expect(b).not.toContain(FAKE_KEY)
      expect(b).not.toContain(FAKE_KEY.slice(0, 20))
    }
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_KEY.slice(0, 20))
  })

  it('the key file is 0600, and saving a profile makes lanes active and fills keyProfiles', async () => {
    const key = await saveKey()
    expect(statSync(dataPath('key-secrets', 'provider-keys.json')).mode & 0o777).toBe(0o600)
    expect(lanes.keyLanesActive()).toBe(false)
    const r = await post('/api/key-lanes/profiles', { id: 'sonnet', label: 'Sonnet 5.5', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5' })
    expect(r.status).toBe(200)
    expect(json(r).active).toBe(true)
    expect(lanes.keyLanesHealthFields()).toEqual({ details: { keyLanes: { enabled: true, active: true } } })
    expect(lanes.keyProfilesModelsField().keyProfiles?.map(p => p.id)).toEqual(['sonnet'])
    expect(listing()).toEqual(['key-secrets', 'provider-profiles.json'])
  })

  it('refusals: bad kind, bad shape, bad cap, unknown key, disallowed model, provider says no', async () => {
    expect((await post('/api/key-lanes/keys', { kind: 'gemini', key: FAKE_KEY })).status).toBe(400)
    expect(json(await post('/api/key-lanes/keys', { kind: 'openrouter', key: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx' })).error).toBe('invalid_key')
    expect(json(await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY, capUsd: -1 })).error).toBe('invalid_cap')
    expect(json(await post('/api/key-lanes/keys', { kind: 'openai-compatible', key: 'abcdefghijklmnopqrstuvwxyz', baseUrl: 'ftp://x' })).error).toBe('invalid_base_url')
    expect((await post('/api/key-lanes/keys', { ref: 'key_000000000000', capUsd: 2 })).status).toBe(404)
    validateKey.mockResolvedValueOnce({ ok: false, error: 'no_credit_limit', message: 'Set a credit limit on this key at openrouter.ai first.' } as never)
    const refused = await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY })
    expect(refused.status).toBe(422)
    expect(json(refused)).toEqual({ error: 'no_credit_limit', message: 'Set a credit limit on this key at openrouter.ai first.' })
    expect(listing()).toEqual([])
    const key = await saveKey()
    expect(json(await post('/api/key-lanes/profiles', { id: 'x', label: 'X', keyRef: 'key_000000000000', engine: 'claude', model: 'anthropic/a' })).error).toBe('unknown_key')
    expect(json(await post('/api/key-lanes/profiles', { id: 'x', label: 'X', keyRef: key.ref, engine: 'claude', model: 'openai/gpt-x' })).error).toBe('model_not_allowed')
  })

  it('disabling or deleting the last enabled profile runs the inactive hooks once', async () => {
    const seen: string[] = []
    lanes.onKeyLanesInactive('test', r => { seen.push(r) })
    const key = await saveKey()
    await post('/api/key-lanes/profiles', { id: 'a', label: 'A', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5' })
    await post('/api/key-lanes/profiles', { id: 'a', label: 'A', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5', enabled: false })
    expect(seen).toEqual(['no_enabled_profile'])
    await post('/api/key-lanes/profiles', { id: 'a', label: 'A', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5' })
    const del = await call(base, { method: 'DELETE', path: '/api/key-lanes/profiles/a' })
    expect(json(del)).toEqual({ removed: true, active: false })
    expect(seen).toEqual(['no_enabled_profile', 'no_enabled_profile'])
    expect((await call(base, { method: 'DELETE', path: '/api/key-lanes/profiles/a' })).status).toBe(404)
  })

  it('removing one key: 409 while an enabled profile uses it, ?force=1 turns those off, and no body carries the secret', async () => {
    const seen: string[] = []
    lanes.onKeyLanesInactive('test', r => { seen.push(r) })
    const key = await saveKey()
    const other = json(await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY.replace('9z9z', '7x7x') })).key
    await post('/api/key-lanes/profiles', { id: 'a', label: 'Sonnet A', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5' })
    await post('/api/key-lanes/profiles', { id: 'b', label: 'Haiku B', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5', enabled: false })
    const del = (path: string) => call(base, { method: 'DELETE', path })
    const bodies: string[] = []
    const refused = await del(`/api/key-lanes/keys/${key.ref}`)
    bodies.push(refused.text)
    expect(refused.status).toBe(409)
    expect(json(refused)).toEqual({ error: 'key_in_use', message: 'Turn off the profiles that use this key first: Sonnet A.', profiles: ['a'] })
    expect(store().map(k => k.ref).sort()).toEqual([key.ref, other.ref].sort())
    expect(lanes.keyLanesActive()).toBe(true)
    const forced = await del(`/api/key-lanes/keys/${key.ref}?force=1`)
    bodies.push(forced.text)
    expect(forced.status).toBe(200)
    expect(json(forced)).toEqual({ removed: true, disabledProfiles: ['a'], active: false })
    expect(store().map(k => k.ref)).toEqual([other.ref])
    expect(statSync(dataPath('key-secrets', 'provider-keys.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(dataPath('key-secrets', 'provider-keys.json'), 'utf8')).not.toContain(FAKE_KEY)
    expect(json(await get('/api/key-lanes/status')).profiles.map((p: { id: string; enabled: boolean }) => [p.id, p.enabled])).toEqual([['a', false], ['b', false]])
    expect(seen).toEqual(['no_enabled_profile'])
    // A key only a disabled profile names goes without force; unknown and malformed refs are refused.
    await post('/api/key-lanes/profiles', { id: 'c', label: 'C', keyRef: other.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5', enabled: false })
    const plain = await del(`/api/key-lanes/keys/${other.ref}`)
    bodies.push(plain.text)
    expect(json(plain)).toEqual({ removed: true, disabledProfiles: [], active: false })
    expect((await del(`/api/key-lanes/keys/${other.ref}`)).status).toBe(404)
    expect((await del('/api/key-lanes/keys/not-a-ref')).status).toBe(400)
    for (const b of bodies) expect(b).not.toContain(FAKE_KEY.slice(0, 20))
  })

  it('status takes spend, breaker and keyed sessions from the registered provider', async () => {
    const key = await saveKey()
    lanes.registerKeyLanesStatusProvider({ spentTodayUsd: () => 0.25, breaker: () => ({ open: true, failures: 3 }), keyedSessionIds: () => ['s1'] })
    expect(json(await get('/api/key-lanes/status'))).toMatchObject({ keys: [{ ref: key.ref, spentTodayUsd: 0.25, breaker: { open: true, failures: 3 } }], keyedSessionIds: ['s1'] })
  })
})

describe('remove all keys (plan 12)', () => {
  beforeEach(() => { delete process.env.COS_KEY_LANES })

  it('exports the ledger on request, removes keys, profiles, codex homes and ledger, keeps keyed sessions, turns lanes off', async () => {
    expect((await post('/api/key-lanes/enable', {})).status).toBe(200)
    const key = json(await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY })).key
    await post('/api/key-lanes/profiles', { id: 'a', label: 'A', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5' })
    writeFileSync(dataPath('key-ledger.jsonl'), '{"kind":"settle","usd":0.01}\n')
    mkdirSync(dataPath('codex-homes', 'a'), { recursive: true })
    writeFileSync(dataPath('keyed-sessions.json'), '{"sessions":[]}')
    const seen: string[] = []
    lanes.onKeyLanesInactive('test', r => { seen.push(r) })
    const r = await post('/api/key-lanes/remove-all', { exportLedger: true })
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body).toMatchObject({ removed: ['keys', 'profiles', 'codexHomes', 'ledger'], enabled: false, active: false })
    expect(body.ledgerExportedTo).toMatch(/cos-key-ledger-\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(readFileSync(body.ledgerExportedTo, 'utf8')).toContain('settle')
    expect(seen).toEqual(['remove_all'])
    expect(listing()).toEqual(['key-lanes.json', 'keyed-sessions.json'])
    expect(lanes.keyLanesEnabled()).toBe(false)
    // Off again: the routes are back to today's 404.
    const c: Call = { method: 'GET', path: '/api/key-lanes/status' }
    expect(await call(base, c)).toEqual(await call(today, c))
  })

  it('a failed export removes nothing', async () => {
    await post('/api/key-lanes/enable', {})
    await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY })
    writeFileSync(dataPath('key-ledger.jsonl'), 'x\n')
    rmSync(downloads, { recursive: true, force: true })
    writeFileSync(downloads, 'a file where the folder should be')
    try {
      const r = await post('/api/key-lanes/remove-all', { exportLedger: true })
      expect(r.status).toBe(500)
      expect(existsSync(dataPath('key-secrets', 'provider-keys.json'))).toBe(true)
      expect(existsSync(dataPath('key-ledger.jsonl'))).toBe(true)
      expect(lanes.keyLanesEnabled()).toBe(true)
    } finally {
      rmSync(downloads, { force: true }); mkdirSync(downloads)
    }
  })
})

describe('catalog (plan 10.4)', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })
  it('curated two with live prices, search marks Lane B models, and a failed fetch falls back to built-in prices', async () => {
    const r = json(await get('/api/key-lanes/catalog?q=a'))
    expect(r.curated.map((m: { id: string }) => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'])
    expect(r.curated[0]).toMatchObject({ inUsdPerM: 3, outUsdPerM: 15, role: 'default' })
    expect(r.pricesFrom).toBe('openrouter')
    // QA G5 (P11): rows come from P5's downselect and carry its lens label.
    expect(r.search).toEqual([
      { ...FAKE_CATALOG[0], lanes: ['key', 'direct'], label: 'Claude Sonnet 5.5 | $3/$15 per M' },
      { ...FAKE_CATALOG[1], lanes: ['direct'], label: 'Llama 9 | $0.20/$0.20 per M' },
    ])
  })
  it('a failed catalog fetch uses the built-in prices', async () => {
    const { createKeyLanesRouter: make } = await import('./key-lanes.js')
    const app = express(); app.use(express.json()); app.use('/api', make({ fetchCatalog: async () => { throw new Error('down') } }))
    const origin = await listen(app)
    const r = await (await fetch(`${origin}/api/key-lanes/catalog`)).json()
    expect(r.pricesFrom).toBe('built-in')
    expect(r.curated[0]).toMatchObject({ inUsdPerM: 2, outUsdPerM: 10 })
    expect(r.search).toBeUndefined()
  })
})

describe('default provider check (plan 10.3)', () => {
  it('OpenRouter: key in the Authorization header only; 401, no limit and no credit are refused', async () => {
    const { defaultValidateKey } = await import('./key-lanes.js')
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const reply = (status: number, body: unknown) => vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers })
      return new Response(JSON.stringify(body), { status })
    })
    vi.stubGlobal('fetch', reply(200, { data: { limit: 5, limit_remaining: 4, is_free_tier: false } }))
    expect(await defaultValidateKey('openrouter', FAKE_KEY)).toEqual({ ok: true, limitRemainingUsd: 4, isFreeTier: false })
    expect(seen[0]).toEqual({ url: 'https://openrouter.ai/api/v1/key', headers: { authorization: `Bearer ${FAKE_KEY}` } })
    vi.stubGlobal('fetch', reply(401, {}))
    expect(await defaultValidateKey('openrouter', FAKE_KEY)).toMatchObject({ ok: false, error: 'key_rejected' })
    vi.stubGlobal('fetch', reply(200, { data: { limit: null, limit_remaining: null } }))
    expect(await defaultValidateKey('openrouter', FAKE_KEY)).toMatchObject({ ok: false, error: 'no_credit_limit' })
    vi.stubGlobal('fetch', reply(200, { data: { limit: 5, limit_remaining: 0 } }))
    expect(await defaultValidateKey('openrouter', FAKE_KEY)).toMatchObject({ ok: false, error: 'out_of_credit' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`boom ${FAKE_KEY}`) }))
    const down = await defaultValidateKey('anthropic', FAKE_KEY)
    expect(down).toMatchObject({ ok: false, error: 'validation_unreachable' })
    expect(JSON.stringify(down)).not.toContain(FAKE_KEY)
    for (const s of seen) expect(s.url).not.toContain(FAKE_KEY)
    vi.unstubAllGlobals()
  })
})
