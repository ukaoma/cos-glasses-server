// Key lanes K1, P11 wiring on the P1 routes: the phone reads status (cap, spend, reset time,
// never the key) with its token; Control's cap saves reach the relay meter; enabling lanes at run
// time installs the relay's status seams; the catalog route reads P5's key-catalog.ts.
// Harness copied from key-lanes.test.ts (index.ts mount order, socket stand-in).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'key-lanes-p11-route-'))
const downloads = mkdtempSync(join(tmpdir(), 'key-lanes-downloads-'))
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_KEY_LANES

const { requireApiToken } = await import('../lib/api-auth.js')
const { createKeyLanesBodyParser, createKeyLanesRouter } = await import('./key-lanes.js')
const lanes = await import('../lib/key-lanes.js')
const { dataPath } = await import('../lib/data-dir.js')
const meterMod = await import('../lib/key-relay-meter.js')
const relayMod = await import('../lib/key-relay.js')
const catalogMod = await import('../lib/key-catalog.js')

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

function buildApp(withKeyLanes: boolean, withGate = true, liveCatalog = false) {
  const app = express()
  app.use(fakeSocketIp)
  if (withGate) app.use('/api', requireApiToken(TOKEN))
  if (withKeyLanes) app.use('/api/key-lanes', ...createKeyLanesBodyParser({ apiToken: () => TOKEN }))
  app.use(express.json({ limit: '10mb' }))
  if (withKeyLanes) app.use('/api', createKeyLanesRouter({ apiToken: () => TOKEN, validateKey, ...(liveCatalog ? {} : { fetchCatalog: () => fetchCatalog() }), downloadsDir: () => downloads }))
  return app
}

const servers: Server[] = []
async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

let base = '', live = ''
beforeAll(async () => {
  base = await listen(buildApp(true))
  live = await listen(buildApp(true, true, true))
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
beforeEach(async () => {
  delete process.env.COS_KEY_LANES; wipe(); validateKey.mockClear(); fetchCatalog = vi.fn(async () => FAKE_CATALOG)
  meterMod.__resetSharedKeyMeterForTests()
  await relayMod.__resetKeyRelayForTests()
  catalogMod.__setKeyCatalogForTests(null)
})
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


const PHONE = '100.64.1.5'
async function saveKey(capUsd = 2): Promise<string> {
  const r = await post('/api/key-lanes/keys', { kind: 'openrouter', key: FAKE_KEY, capUsd })
  expect(r.status).toBe(200)
  return json(r).key.ref as string
}

describe('status from the phone (P9 app half)', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })

  it('cap, today\'s spend and the reset time, with the token; never the key', async () => {
    const ref = await saveKey(2)
    relayMod.installKeyRelaySeams()
    const meter = meterMod.getSharedKeyMeter()
    const res = meter.reserve({ keyRef: ref, turnId: 'p11-turn', estimateUsd: 0.01 })
    if (!res.ok) throw new Error('refused')
    meter.settle({ reservationId: res.reservationId, usd: 0.37, tokens: { input: 1, output: 1 } })
    const r = await get('/api/key-lanes/status', { ip: PHONE })
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body.keys).toEqual([expect.objectContaining({ ref, capUsd: 2, spentTodayUsd: 0.37 })])
    expect(Date.parse(body.resetsAt)).toBeGreaterThan(Date.now())
    expect(r.text).not.toContain(FAKE_KEY)
    expect(r.text).not.toContain(FAKE_KEY.slice(0, 20))
  })

  it('without the token the phone gets the gate\'s refusal, not the status', async () => {
    await saveKey()
    const r = await get('/api/key-lanes/status', { ip: PHONE, token: null })
    expect(r.status).toBe(401)
    expect(r.text).not.toContain('capUsd')
  })

  it('writes stay Mac only: a phone cap change is refused and the cap is unchanged', async () => {
    const ref = await saveKey(2)
    const r = await post('/api/key-lanes/keys', { ref, capUsd: 50 }, { ip: PHONE })
    expect(r.status).toBe(403)
    expect(store()[0]).toMatchObject({ capUsd: 2 })
  })
})

describe('cap saves reach the relay meter (plan 4.5 "Cap value")', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })

  it('a cap Control saves is the one the relay meters against; a later file edit is ignored', async () => {
    const ref = await saveKey(2)
    const meter = meterMod.getSharedKeyMeter()
    expect(meter.capUsd(ref)).toBe(2)
    expect((await post('/api/key-lanes/keys', { ref, capUsd: 5 })).status).toBe(200)
    expect(meter.capUsd(ref)).toBe(5)
    // Something other than Control raises the cap in the file.
    const path = dataPath('key-secrets', 'provider-keys.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.keys[0].capUsd = 900
    writeFileSync(path, JSON.stringify(file))
    expect(meter.capUsd(ref)).toBe(5)
  })

  it('a fresh key save is noted too, before any turn reads the file', async () => {
    const ref = await saveKey(3)
    const path = dataPath('key-secrets', 'provider-keys.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.keys[0].capUsd = 700
    writeFileSync(path, JSON.stringify(file))
    expect(meterMod.getSharedKeyMeter().capUsd(ref)).toBe(3)
  })
})

describe('enable at run time installs the relay status seams', () => {
  it('before enable no spend answer; after POST /enable the relay answers', async () => {
    expect(lanes.keyLanesStatusProvider().spentTodayUsd).toBeUndefined()
    const r = await post('/api/key-lanes/enable', {})
    expect(r.status).toBe(200)
    expect(lanes.keyLanesStatusProvider().spentTodayUsd).toBeTypeOf('function')
  })
})

describe('catalog route reads P5 key-catalog.ts', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })

  it('live prices from the shared 24 h catalog and lanes from catalogLanesFor', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
      { id: 'meta/llama-9', name: 'Llama 9', pricing: { prompt: '0.0000002', completion: '0.0000002' }, architecture: { output_modalities: ['text'] } },
    ] }), { status: 200 }))
    catalogMod.__setKeyCatalogForTests(new catalogMod.KeyCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch }))
    const r = await call(live, { method: 'GET', path: '/api/key-lanes/catalog?q=llama' })
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body.pricesFrom).toBe('openrouter')
    expect(body.curated[0]).toEqual({ id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', inUsdPerM: 4, outUsdPerM: 20, role: 'default' })
    expect(body.search.map((m: { id: string; lanes: string[] }) => [m.id, m.lanes])).toEqual([['meta/llama-9', ['direct']]])
    // Public catalog: never a key header.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i)
  })

  it('catalog unreachable: the built-in curated prices', async () => {
    catalogMod.__setKeyCatalogForTests(new catalogMod.KeyCatalog({ fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch }))
    const fresh = await listen(buildApp(true, true, true)) // the route keeps its own 24 h copy too
    const body = json(await call(fresh, { method: 'GET', path: '/api/key-lanes/catalog' }))
    expect(body.pricesFrom).toBe('built-in')
    expect(body.curated.map((c: { inUsdPerM: number }) => c.inUsdPerM)).toEqual([2, 0.1])
  })
})

describe('QA U6 / W5: breaker reset route; profile off, change or removal stops its turns', () => {
  beforeEach(() => { process.env.COS_KEY_LANES = '1' })
  const profileBody = (ref: string, extra: Record<string, unknown> = {}) => ({ id: 'sonnet', label: 'Sonnet', keyRef: ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5', ...extra })

  it('POST /breaker/reset closes a paused key; refuses the phone, a bad ref and an unknown key', async () => {
    const ref = await saveKey()
    const relay = relayMod.getKeyRelay()
    for (let i = 0; i < 3; i++) relay.breakers.record('key', ref, 'key_rejected', false)
    expect(relay.breakerState('key', ref).open).toBe(true)
    expect((await post('/api/key-lanes/breaker/reset', { ref }, { ip: PHONE })).status).toBe(403)
    expect(relay.breakerState('key', ref).open).toBe(true)
    expect((await post('/api/key-lanes/breaker/reset', { ref: 'nope' })).status).toBe(400)
    expect((await post('/api/key-lanes/breaker/reset', { ref: 'key_000000000000' })).status).toBe(404)
    const r = await post('/api/key-lanes/breaker/reset', { ref })
    expect(r.status).toBe(200)
    expect(json(r)).toEqual({ reset: true, breaker: { open: false, failures: 0 } })
    expect(relay.breakerState('key', ref).open).toBe(false)
  })

  it('with lanes off the reset route is today\'s 404', async () => {
    delete process.env.COS_KEY_LANES
    lanes.__resetKeyLanesForTests()
    const r = await post('/api/key-lanes/breaker/reset', { ref: 'key_000000000000' })
    expect(r.status).toBe(404)
    expect(r.text).toContain('Cannot POST')
  })

  it('turning a profile off revokes its nonces; a model change also resets its breaker; delete revokes', async () => {
    const ref = await saveKey()
    expect((await post('/api/key-lanes/profiles', profileBody(ref))).status).toBe(200)
    const relay = relayMod.getKeyRelay()
    const revoke = vi.spyOn(relay, 'revokeProfile')
    const reset = vi.spyOn(relay, 'resetBreaker')
    // Same profile, nothing changed: nothing revoked.
    expect((await post('/api/key-lanes/profiles', profileBody(ref))).status).toBe(200)
    expect(revoke).not.toHaveBeenCalled()
    expect((await post('/api/key-lanes/profiles', profileBody(ref, { enabled: false }))).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('sonnet')
    expect(reset).not.toHaveBeenCalled()
    revoke.mockClear()
    expect((await post('/api/key-lanes/profiles', profileBody(ref, { model: 'anthropic/claude-haiku-5.5' }))).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('sonnet')
    expect(reset).toHaveBeenCalledWith('profile', 'sonnet')
    revoke.mockClear()
    expect((await call(base, { method: 'DELETE', path: '/api/key-lanes/profiles/sonnet' })).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('sonnet')
  })

  it('removing a key revokes the live turns of the profiles it turns off', async () => {
    const ref = await saveKey()
    await post('/api/key-lanes/profiles', profileBody(ref))
    const revoke = vi.spyOn(relayMod.getKeyRelay(), 'revokeProfile')
    expect((await call(base, { method: 'DELETE', path: `/api/key-lanes/keys/${ref}?force=1` })).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('sonnet')
  })
})

describe('relay revokeProfile', () => {
  it('drops only that profile\'s nonces', async () => {
    const relay = relayMod.createKeyRelay({ isActive: () => true, secretFor: () => 'sk-ant-api03-fakefakefakefakefakefake', keyKindOf: () => 'anthropic', log: () => {}, reconcileDelayMs: null, meter: new meterMod.KeyRelayMeter({ capUsd: () => 5, appendRow: () => {}, loadSettled: () => 0, log: () => {} }) })
    const turn = (profileId: string, turnId: string) => relay.issueTurn({ keyRef: 'key_0123456789ab', profileId, turnId, sessionId: 's', engine: 'claude', allowedModel: 'claude-sonnet-5-5' }, { wallMaxMs: 60_000 })
    await turn('a', 't1'); await turn('a', 't2'); await turn('b', 't3')
    expect(relay.liveTurnCount()).toBe(3)
    expect(relay.revokeProfile('a')).toBe(2)
    expect(relay.liveTurnCount()).toBe(1)
    await relay.close()
  })
})
