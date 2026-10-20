// Key lanes P2 (plan v4 4.7): the loopback metering relay against local mock upstreams shaped like
// Anthropic /v1/messages (SSE) and OpenAI /v1/responses (SSE and JSON), plus OpenRouter's /key and
// /generation. Fake keys only; a private temp data dir; never the live ~/.cos-glasses.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'key-relay-'))
process.env.COS_DATA_DIR = dataDir
process.env.COS_KEY_LANES = '1'

const lanes = await import('./key-lanes.js')
const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const ledger = await import('./key-ledger.js')
const { KeyRelayMeter } = await import('./key-relay-meter.js')
const meterMod = await import('./key-relay-meter.js')
const errorsMod = await import('./key-relay-errors.js')
const relayMod = await import('./key-relay.js')
const { RELAY_LIMITS, RELAY_PATHS } = await import('./key-relay-contract.js')
type KeyRelayServer = import('./key-relay.js').KeyRelayServer
type KeyRelayDeps = import('./key-relay.js').KeyRelayDeps
type RelayNonceBinding = import('./key-relay-contract.js').RelayNonceBinding
type RelayTurnHandle = import('./key-relay-contract.js').RelayTurnHandle

const FAKE_KEY = 'sk-or-v1-RELAYFAKE0123456789abcdef0123456789abcdef0123456789abcdef01'
const FAKE_ANTHROPIC = 'sk-ant-api03-RELAYFAKE0123456789abcdef0123456789abcdef'
const FAKE_OPENAI = 'sk-proj-RELAYFAKE0123456789abcdef0123456789abcdef'
const SLUG = 'anthropic/claude-sonnet-5.5'
const CODEX_SLUG = 'openai/gpt-5.3-codex'

// ── Mock upstream ────────────────────────────────────────────────────────────

interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void | Promise<void>

interface Mock {
  origin: string
  seen: Seen[]
  usageDaily: number
  keyStatus: number
  keyData: Record<string, unknown> | null
  messages: Handler
  responses: Handler
  generation: Record<string, unknown> | null
  closed: number
  close(): Promise<void>
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

function anthropicEvents(model: string, opts: { input?: number; output?: number; text?: string; cost?: number } = {}): Array<[string, unknown]> {
  const usage: Record<string, unknown> = { output_tokens: opts.output ?? 7 }
  if (opts.cost !== undefined) usage.cost = opts.cost
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: opts.input ?? 40, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text ?? 'pong' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

function openaiEvents(opts: { input?: number; output?: number } = {}): Array<[string, unknown]> {
  return [
    ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'pong' }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: opts.input ?? 50, output_tokens: opts.output ?? 20 } } }],
  ]
}

function bodyModel(s: Seen): string {
  try { return (JSON.parse(s.body) as { model: string }).model } catch { return '' }
}

const defaultMessages: Handler = (_req, res, seen) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-1', 'set-cookie': 'track=1' })
  res.end(sse(anthropicEvents(bodyModel(seen))))
}
const defaultResponses: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(sse(openaiEvents()))
}

async function startMock(): Promise<Mock> {
  const mock = {
    seen: [] as Seen[], usageDaily: 0, keyStatus: 200, keyData: null as Record<string, unknown> | null,
    messages: defaultMessages, responses: defaultResponses, generation: null as Record<string, unknown> | null, closed: 0,
  } as Mock
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const seen: Seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
    mock.seen.push(seen)
    res.on('close', () => { if (!res.writableFinished) mock.closed += 1 })
    const path = seen.path.split('?')[0]
    if (path === '/api/v1/key') {
      res.writeHead(mock.keyStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mock.keyStatus === 200 ? { data: mock.keyData ?? { limit: 10, limit_remaining: 10, usage_daily: mock.usageDaily } } : { error: { message: 'User not found.' } }))
      return
    }
    if (path === '/api/v1/generation') {
      res.writeHead(mock.generation ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mock.generation ? { data: mock.generation } : {}))
      return
    }
    if (path.endsWith('/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"input_tokens":12}')
      return
    }
    if (path.endsWith('/messages')) return mock.messages(req, res, seen)
    if (path.endsWith('/responses')) return mock.responses(req, res, seen)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  mock.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.close = () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() })
  return mock
}

// ── Harness ──────────────────────────────────────────────────────────────────

let mock: Mock
let offset = 0
const now = () => Date.now() + offset
const relays: KeyRelayServer[] = []
let keyRef = ''

function wipe() {
  for (const f of readdirSync(dataDir)) rmSync(join(dataDir, f), { recursive: true, force: true })
  lanes.__resetKeyLanesForTests()
}

function saveKeyAndProfile(secret = FAKE_KEY, kind: 'openrouter' | 'anthropic' | 'openai' = 'openrouter', model = SLUG, engine: 'claude' | 'codex' = 'claude', capUsd = 1) {
  const key = store.saveKey({ kind, secret, capUsd, validatedAt: new Date(now()).toISOString() })
  const v = profiles.validateProfileInput({ id: engine === 'claude' ? 'sonnet' : 'codex', label: 'Test', keyRef: key.ref, engine, model, enabled: true }, ref => store.getPublicKey(ref)?.kind)
  if (!v.ok) throw new Error(v.message)
  profiles.upsertProfile(v.profile)
  return key.ref
}

function makeRelay(extra: Partial<KeyRelayDeps> = {}) {
  const logs: string[] = []
  const failures: Array<{ kind: string; status: number }> = []
  const meter = new KeyRelayMeter({ now })
  const relay = relayMod.createKeyRelay({
    now,
    meter,
    upstreams: {
      openrouterMessages: `${mock.origin}/api/v1/messages`,
      openrouterResponses: `${mock.origin}/api/v1/responses`,
      anthropicMessages: `${mock.origin}/anthropic/v1/messages`,
      openaiResponses: `${mock.origin}/openai/v1/responses`,
    },
    openrouterApiBase: `${mock.origin}/api/v1`,
    reconcileDelayMs: null,
    log: line => logs.push(line),
    onTurnFailure: f => failures.push({ kind: f.kind, status: f.status }),
    ...extra,
  })
  relays.push(relay)
  return { relay, logs, failures, meter }
}

function binding(over: Partial<RelayNonceBinding> = {}): RelayNonceBinding {
  return { keyRef, profileId: 'sonnet', turnId: 't1', sessionId: 's1', engine: 'claude', allowedModel: SLUG, ...over }
}

function msgBody(model = SLUG, extra: Record<string, unknown> = {}) {
  return { model, max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'ping' }], ...extra }
}

function post(h: Pick<RelayTurnHandle, 'origin' | 'nonce'>, path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.nonce}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  })
}

const MSG = RELAY_PATHS.anthropicMessages
const RESP = RELAY_PATHS.openaiResponses
const upstreamCalls = (suffix: string) => mock.seen.filter(s => s.path.split('?')[0].endsWith(suffix))
const ledgerRows = () => ledger.readKeyLedger()

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  wipe()
  offset = 0
  process.env.COS_KEY_LANES = '1'
  mock = await startMock()
  keyRef = saveKeyAndProfile()
})
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close()
  await relayMod.__resetKeyRelayForTests()
  await mock.close()
})
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.COS_KEY_LANES })

// ── Tests ────────────────────────────────────────────────────────────────────

describe('key relay: zero impact until the first keyed turn (plan 3, 4.1)', () => {
  it('importing and creating the relay opens no listener, starts no timer, writes no file and registers no seam', () => {
    const before = process.getActiveResourcesInfo().length
    const files = readdirSync(dataDir).sort()
    const { relay } = makeRelay()
    expect(relay.port()).toBeNull()
    expect(relay.address()).toBeNull()
    expect(process.getActiveResourcesInfo().length).toBe(before)
    expect(readdirSync(dataDir).sort()).toEqual(files)
    expect(lanes.keyLanesStatusProvider().spentTodayUsd).toBeUndefined()
  })

  it('refuses to issue while key lanes are inactive, and opens nothing', async () => {
    const { relay } = makeRelay({ isActive: () => false })
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'lanes_inactive' })
    expect(relay.port()).toBeNull()
    expect(mock.seen).toEqual([])
  })
})

describe('key relay: bind (plan 4.1)', () => {
  it('listens on 127.0.0.1 only, on an ephemeral port, and closes', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    expect(relay.address()).toBe('127.0.0.1')
    expect(relay.port()).toBeGreaterThan(0)
    expect([3141, 3143]).not.toContain(relay.port())
    expect(h.origin).toBe(`http://127.0.0.1:${relay.port()}`)
    await relay.close()
    expect(relay.port()).toBeNull()
  })
})

describe('key relay: nonce (plan 4.3)', () => {
  it('issues 32 random bytes, verifies, and answers an unknown nonce with 401 in the caller shape', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    expect(Buffer.from(h.nonce, 'base64url').length).toBe(32)
    expect(h.nonce).not.toContain(FAKE_KEY)
    const ok = await post(h, MSG, msgBody())
    expect(ok.status).toBe(200)
    await ok.text()
    const bad = await post({ origin: h.origin, nonce: 'not-a-real-nonce' }, MSG, msgBody())
    expect(bad.status).toBe(401)
    expect(await bad.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    const none = await fetch(`${h.origin}${MSG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msgBody()) })
    expect(none.status).toBe(401)
    await none.text()
    expect(upstreamCalls('/messages')).toHaveLength(1)
  })

  it('the nonce works as x-api-key too, and never reaches the upstream', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await fetch(`${h.origin}${MSG}`, { method: 'POST', headers: { 'x-api-key': h.nonce, 'content-type': 'application/json' }, body: JSON.stringify(msgBody()) })
    expect(r.status).toBe(200)
    await r.text()
    const seen = upstreamCalls('/messages')[0]
    expect(seen.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(JSON.stringify(seen)).not.toContain(h.nonce)
  })

  it('expires at child close plus 5 s', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 600_000 })
    h.childClosed()
    offset += 4_000
    const live = await post(h, MSG, msgBody())
    expect(live.status).toBe(200)
    await live.text()
    offset += 1_001
    const dead = await post(h, MSG, msgBody())
    expect(dead.status).toBe(401)
    await dead.text()
    expect(upstreamCalls('/messages')).toHaveLength(1)
  })

  it('expires at the tier wall max plus 60 s when the child never closes', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 1_000 })
    offset += 60_500
    const live = await post(h, MSG, msgBody())
    expect(live.status).toBe(200)
    await live.text()
    offset += 600
    const dead = await post(h, MSG, msgBody())
    expect(dead.status).toBe(401)
    await dead.text()
  })

  it('is revoked on cancel, by turn id, and by revokeAll', async () => {
    const { relay } = makeRelay()
    const a = await relay.issueTurn(binding({ turnId: 'a' }), { wallMaxMs: 60_000 })
    const b = await relay.issueTurn(binding({ turnId: 'b' }), { wallMaxMs: 60_000 })
    const c = await relay.issueTurn(binding({ turnId: 'c' }), { wallMaxMs: 60_000 })
    a.revoke('cancel')
    relay.revokeTurn('b', 'steer_abort')
    for (const h of [a, b]) {
      const r = await post(h, MSG, msgBody())
      expect(r.status).toBe(401)
      await r.text()
    }
    const r = await post(c, MSG, msgBody())
    expect(r.status).toBe(200)
    await r.text()
    relay.revokeAll('remove_all')
    const after = await post(c, MSG, msgBody())
    expect(after.status).toBe(401)
    await after.text()
    expect(relay.liveTurnCount()).toBe(0)
  })

  it('a Claude nonce does not open the Codex route, and a second issue for the same turn replaces the first', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const cross = await post(h, RESP, { model: SLUG, input: 'x' })
    expect(cross.status).toBe(401)
    expect(await cross.json()).toMatchObject({ error: { code: 'nonce_invalid' } })
    const again = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const old = await post(h, MSG, msgBody())
    expect(old.status).toBe(401)
    await old.text()
    const fresh = await post(again, MSG, msgBody())
    expect(fresh.status).toBe(200)
    await fresh.text()
  })

  it('every request is refused once key lanes turn inactive', async () => {
    let active = true
    const { relay } = makeRelay({ isActive: () => active })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    active = false
    const r = await post(h, MSG, msgBody())
    expect(r.status).toBe(401)
    await r.text()
    expect(relay.liveTurnCount()).toBe(0)
  })

  it('holds at most RELAY_LIMITS.inFlightPerNonce requests in flight per nonce (past the wait, a 429)', async () => {
    const release: Array<() => void> = []
    mock.messages = (_req, res, seen) => new Promise<void>(resolve => {
      release.push(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(anthropicEvents(bodyModel(seen)))); resolve() })
    })
    // P11 (canary QA): requests past the cap wait for a slot; a short wait here reaches the 429.
    const { relay } = makeRelay({ inFlightWaitMs: 50 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const n = RELAY_LIMITS.inFlightPerNonce
    const held = Array.from({ length: n }, () => post(h, MSG, msgBody()))
    await waitFor(() => release.length === n)
    const ninth = await post(h, MSG, msgBody())
    expect(ninth.status).toBe(429)
    expect(ninth.headers.get('retry-after')).toBe('1')
    await ninth.text()
    for (const go of release) go()
    for (const r of await Promise.all(held)) { expect(r.status).toBe(200); await r.text() }
  })
})

describe('key relay: paths (plan 4.2)', () => {
  it('answers health with no key facts, and 404 for anything unlisted', async () => {
    const { relay, logs } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const health = await fetch(`${h.origin}/relay/health`)
    expect(await health.json()).toEqual({ ok: true })
    for (const [method, path] of [['POST', '/relay/a/v1/models'], ['GET', MSG], ['POST', '/relay/x'], ['POST', '/v1/messages'], ['POST', '/relay/o/v1/chat/completions']] as const) {
      const r = await fetch(`${h.origin}${path}`, { method, headers: { authorization: `Bearer ${h.nonce}` }, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(r.status, `${method} ${path}`).toBe(404)
      await r.text()
    }
    expect(mock.seen.filter(s => s.path.includes('messages') || s.path.includes('responses'))).toEqual([])
    expect(logs.some(l => l.includes('404 POST /relay/x'))).toBe(true)
    expect(logs.join('\n')).not.toContain(h.nonce)
  })

  it('refuses a browser (any Origin header)', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody(), { origin: 'https://example.com' })
    expect(r.status).toBe(403)
    await r.text()
    expect(upstreamCalls('/messages')).toEqual([])
  })

  it('keeps ?beta=true, forwards count_tokens unmetered', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, `${MSG}?beta=true`, msgBody())
    await r.text()
    expect(upstreamCalls('/messages')[0].path).toBe('/api/v1/messages?beta=true')
    const before = ledgerRows().length
    const ct = await post(h, `${RELAY_PATHS.anthropicCountTokens}?beta=true`, { model: 'claude-haiku-4-5', messages: [] })
    expect(await ct.json()).toEqual({ input_tokens: 12 })
    const seen = upstreamCalls('/messages/count_tokens')[0]
    expect(seen.path).toBe('/api/v1/messages/count_tokens?beta=true')
    expect(bodyModel(seen)).toBe(SLUG)
    expect(ledgerRows().length).toBe(before)
  })
})

describe('key relay: model policy (plan 4.4)', () => {
  it('forwards the profile slug byte for byte', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const raw = JSON.stringify(msgBody()) + '  '
    const r = await post(h, MSG, raw)
    await r.text()
    expect(upstreamCalls('/messages')[0].body).toBe(raw)
  })

  it('rewrites Claude ids and aliases to the slug and logs it', async () => {
    const { relay, logs } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (const m of ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'haiku', 'opus', 'claude-sonnet-5-5[1m]']) {
      const r = await post(h, MSG, msgBody(m))
      expect(r.status, m).toBe(200)
      await r.text()
    }
    expect(upstreamCalls('/messages').map(bodyModel)).toEqual([SLUG, SLUG, SLUG, SLUG, SLUG])
    expect(logs.filter(l => l.includes('model rewritten'))).toHaveLength(5)
  })

  it('refuses any other model with 400 and never calls upstream', async () => {
    const { relay, logs } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (const m of ['openai/gpt-x', 'anthropic/claude-opus-5.5', 'meta-llama/llama-4', '']) {
      const r = await post(h, MSG, msgBody(m))
      expect(r.status, m).toBe(400)
      expect((await r.json()).error.message).toBe('Model not allowed on this key profile')
    }
    expect(upstreamCalls('/messages')).toEqual([])
    expect(logs.filter(l => l.includes('model refused'))).toHaveLength(4)
  })

  it('decideRelayModel table, both engines', () => {
    const d = relayMod.decideRelayModel
    expect(d(SLUG, SLUG, 'claude').action).toBe('forward')
    expect(d('claude-opus-4-1', SLUG, 'claude')).toEqual({ action: 'rewrite', model: SLUG, requested: 'claude-opus-4-1' })
    expect(d('Sonnet', SLUG, 'claude').action).toBe('rewrite')
    expect(d('fable', SLUG, 'claude').action).toBe('rewrite')
    expect(d('x[1m]', SLUG, 'claude').action).toBe('rewrite')
    expect(d('openai/gpt-x', SLUG, 'claude').action).toBe('reject')
    expect(d(undefined, SLUG, 'claude').action).toBe('reject')
    expect(d(CODEX_SLUG, CODEX_SLUG, 'codex').action).toBe('forward')
    expect(d('gpt-5.1-codex-mini', CODEX_SLUG, 'codex').action).toBe('rewrite')
    expect(d('claude-opus-4-1', CODEX_SLUG, 'codex').action).toBe('reject')
    expect(d('anthropic/claude-x', CODEX_SLUG, 'codex').action).toBe('reject')
  })

  it('issueTurn refuses a slug that is Lane C only', async () => {
    const { relay } = makeRelay()
    await expect(relay.issueTurn(binding({ allowedModel: 'meta-llama/llama-4' }), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'model_not_allowed' })
    await expect(relay.issueTurn(binding({ engine: 'codex', allowedModel: SLUG }), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'model_not_allowed' })
    expect(relay.port()).toBeNull()
  })
})

describe('key relay: metering and the cap (plan 4.5)', () => {
  const price = () => ({ inUsdPerM: 1, outUsdPerM: 10 })

  it('10 parallel requests against a $0.05 cap: settled spend stays within the cap plus one in-flight response', async () => {
    store.updateKeyCap(keyRef, 0.05)
    mock.messages = async (_req, res, seen) => {
      await new Promise(r => setTimeout(r, 30))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(anthropicEvents(bodyModel(seen), { input: 50, output: 900 })))
    }
    const { relay, meter, failures } = makeRelay({ priceFor: price })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const results = await Promise.all(Array.from({ length: 10 }, () => post(h, MSG, msgBody())))
    const statuses = results.map(r => r.status)
    const bodies = await Promise.all(results.map(r => r.text()))
    const ok = statuses.filter(s => s === 200).length
    const refused = statuses.filter(s => s === 402).length
    expect(ok + refused).toBe(10)
    expect(ok).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    const refusedBody = bodies[statuses.indexOf(402)]
    expect(JSON.parse(refusedBody)).toEqual({ type: 'error', error: { type: 'billing_error', message: 'Daily cap reached for this key.' } })
    // The relay never retries: one upstream call per admitted request.
    expect(upstreamCalls('/messages')).toHaveLength(ok)
    const settled = ledgerRows().filter(r => r.kind === 'settle').reduce((s, r) => s + r.usd, 0)
    const oneResponse = (50 + 900 * 10) / 1e6
    expect(settled).toBeLessThanOrEqual(0.05 + oneResponse)
    expect(meter.spentTodayUsd(keyRef)).toBeCloseTo(settled)
    expect(failures.filter(f => f.kind === 'cap_refused')).toHaveLength(refused)
  })

  it('a fake usage_daily jump between requests (another device) refuses the next one', async () => {
    const { relay } = makeRelay({ priceFor: price, usagePollMs: 0 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const first = await post(h, MSG, msgBody())
    expect(first.status).toBe(200)
    await first.text()
    // QA W2 (P11): a request now reserves within the headroom, so the jump must leave less than
    // the input plus a short reply (256 output tokens at $10 per M is $0.00256).
    mock.usageDaily = 0.999
    const second = await post(h, MSG, msgBody())
    expect(second.status).toBe(402)
    await second.text()
    expect(upstreamCalls('/messages')).toHaveLength(1)
  })

  it('QA W2: a reply that runs past the cap is cut mid-stream, settled at what streamed, and reported as cap_refused', async () => {
    mock.usageDaily = 0.95 // $0.05 left of the $1 cap
    mock.messages = async (_req, res, seen) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = anthropicEvents(bodyModel(seen))
      res.write(sse([ev[0]!, ev[1]!]))
      // 60 chunks of 2,000 characters: about $0.005 each at $10 per M output, $0.30 in all.
      for (let i = 0; i < 60 && !res.destroyed; i++) {
        res.write(sse([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(2000) } }]]))
        await new Promise(r => setTimeout(r, 2))
      }
      if (!res.destroyed) res.end(sse(ev.slice(3)))
    }
    const { relay, failures } = makeRelay({ priceFor: price, usagePollMs: 60_000 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody(SLUG, { max_tokens: 32_000 }))
    const text = await r.text()
    expect(text).not.toContain('message_stop')
    expect(failures).toContainEqual({ kind: 'cap_refused', status: 402 })
    const settle = ledgerRows().filter(x => x.kind === 'settle')
    expect(settle).toHaveLength(1)
    // Cut within one chunk of the cap's $0.05 headroom.
    expect(settle[0]!.usd).toBeGreaterThan(0.04)
    expect(settle[0]!.usd).toBeLessThan(0.05 + 0.006)
  })

  it('QA W2: max_tokens is reserved in full (no 4096 clamp) when it fits under the cap', () => {
    const p = { inUsdPerM: 1, outUsdPerM: 10 }
    expect(meterMod.reserveWithinHeadroomUsd({ bodyBytes: 4000, maxTokens: 32_000, price: p, headroomUsd: 10 })).toBeCloseTo(0.001 + 0.32, 9)
    expect(meterMod.reserveWithinHeadroomUsd({ bodyBytes: 4000, maxTokens: 32_000, price: p, headroomUsd: 0.05 })).toBe(0.05)
    expect(meterMod.reserveWithinHeadroomUsd({ bodyBytes: 4000, maxTokens: 32_000, price: p, headroomUsd: 0.002 })).toBeNull()
  })

  it('refuses the turn before spawn when the key is already at its cap', async () => {
    mock.usageDaily = 1
    const { relay } = makeRelay()
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'cap_refused' })
  })

  it('settles from stream usage times price, and prefers the provider cost when sent', async () => {
    const { relay } = makeRelay({ priceFor: price })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    await (await post(h, MSG, msgBody())).text()
    let settle = ledgerRows().filter(r => r.kind === 'settle')
    expect(settle[0]).toMatchObject({ tokens: { input: 40, output: 7 }, generationId: 'gen-1', profile: 'sonnet', lane: 'key', turnId: 't1' })
    expect(settle[0].usd).toBeCloseTo((40 * 1 + 7 * 10) / 1e6)
    mock.messages = (_req, res, seen) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(anthropicEvents(bodyModel(seen), { cost: 0.0123 }))) }
    await (await post(h, MSG, msgBody())).text()
    settle = ledgerRows().filter(r => r.kind === 'settle')
    expect(settle[1].usd).toBeCloseTo(0.0123)
  })

  it('non-stream JSON usage is parsed from the body', async () => {
    mock.messages = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 11, output_tokens: 22 } }))
    }
    const { relay } = makeRelay({ priceFor: price })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody(SLUG, { stream: false }))
    expect((await r.json()).usage).toEqual({ input_tokens: 11, output_tokens: 22 })
    expect(ledgerRows().find(x => x.kind === 'settle')?.tokens).toEqual({ input: 11, output: 22 })
  })

  it('reconciles later from the OpenRouter generation cost', async () => {
    mock.generation = { total_cost: 0.5, native_tokens_prompt: 40, native_tokens_completion: 7 }
    const { relay, meter } = makeRelay({ priceFor: price, reconcileDelayMs: 0 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    await (await post(h, MSG, msgBody())).text()
    await waitFor(() => ledgerRows().some(r => r.kind === 'reconcile'))
    const settled = ledgerRows().find(r => r.kind === 'settle')!.usd
    const rec = ledgerRows().find(r => r.kind === 'reconcile')!
    expect(rec).toMatchObject({ generationId: 'gen-1', tokens: { input: 40, output: 7 } })
    expect(rec.usd).toBeCloseTo(0.5 - settled)
    expect(meter.spentTodayUsd(keyRef)).toBeCloseTo(0.5)
    expect(upstreamCalls('/generation')[0].path).toBe('/api/v1/generation?id=gen-1')
  })
})

describe('key relay: streaming (plan 4.6)', () => {
  it('bytes to the child are identical, the first byte arrives before upstream ends, usage is parsed', async () => {
    const events = anthropicEvents(SLUG, { input: 123, output: 45, text: 'streamed' })
    const first = sse(events.slice(0, 2))
    const rest = sse(events.slice(2))
    let releaseRest!: () => void
    const gate = new Promise<void>(r => { releaseRest = r })
    mock.messages = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(first)
      await gate
      res.end(rest)
    }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody())
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    const reader = r.body!.getReader()
    const got: Uint8Array[] = []
    const firstRead = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('first byte held back until upstream ended')), 3000))])
    expect(firstRead.done).toBe(false)
    got.push(firstRead.value!)
    releaseRest()
    for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(value) }
    expect(Buffer.concat(got).toString('utf8')).toBe(first + rest)
    expect(ledgerRows().find(x => x.kind === 'settle')?.tokens).toEqual({ input: 123, output: 45 })
  })

  it('strips set-cookie, passes x-generation-id and retry-after', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody())
    await r.text()
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('x-generation-id')).toBe('gen-1')
    expect(upstreamCalls('/messages')[0].headers['accept-encoding']).toBe('identity')
  })

  it('a child disconnect aborts upstream and records a partial settle', async () => {
    const events = anthropicEvents(SLUG, { input: 100, text: 'hello world' })
    mock.messages = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(events.slice(0, 3)))
      // never ends
    }
    const { relay } = makeRelay({ priceFor: () => ({ inUsdPerM: 1, outUsdPerM: 10 }) })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const ac = new AbortController()
    const r = await post(h, MSG, msgBody(), {}, ac.signal)
    const reader = r.body!.getReader()
    await reader.read()
    ac.abort()
    await waitFor(() => mock.closed === 1)
    await waitFor(() => ledgerRows().some(x => x.kind === 'settle'))
    const settle = ledgerRows().find(x => x.kind === 'settle')!
    expect(settle.tokens).toEqual({ input: 100, output: 3 })
    expect(settle.usd).toBeCloseTo((100 + 3 * 10) / 1e6)
  })

  it('a disconnect before any usage settles the full reservation', async () => {
    mock.messages = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n') }
    const { relay } = makeRelay({ priceFor: () => ({ inUsdPerM: 1, outUsdPerM: 10 }) })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const ac = new AbortController()
    const r = await post(h, MSG, msgBody(), {}, ac.signal)
    await r.body!.getReader().read()
    ac.abort()
    await waitFor(() => ledgerRows().some(x => x.kind === 'settle'))
    const reserve = ledgerRows().find(x => x.kind === 'reserve')!
    expect(ledgerRows().find(x => x.kind === 'settle')!.usd).toBeCloseTo(reserve.usd)
  })
})

describe('QA N10 / U2: a request on a token the relay ended says why', () => {
  it('revoked: 401 to the child and nonce_revoked to the turn; an unknown token reports nothing', async () => {
    const { relay, failures } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    h.revoke('cancel')
    expect((await post(h, MSG, msgBody())).status).toBe(401)
    expect(failures).toEqual([{ kind: 'nonce_revoked', status: 401 }])
    expect((await post({ origin: h.origin, nonce: 'not-a-nonce-the-relay-made' }, MSG, msgBody())).status).toBe(401)
    expect(failures).toHaveLength(1)
  })

  it('expired: nonce_expired', async () => {
    const { relay, failures } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 1 })
    offset += 5 * 60_000
    expect((await post(h, MSG, msgBody())).status).toBe(401)
    expect(failures.map(f => f.kind)).toEqual(['nonce_expired'])
  })
})

describe('canary QA: parallel requests past the in-flight cap wait for a slot', () => {
  it('20 parallel requests on one nonce: at most RELAY_LIMITS.inFlightPerNonce upstream at once, every one answered', async () => {
    let live = 0, peak = 0
    const release: Array<() => void> = []
    mock.messages = async (_req, res, seen) => {
      live++; peak = Math.max(peak, live)
      await new Promise<void>(r => release.push(r))
      live--
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(anthropicEvents(bodyModel(seen))))
    }
    const { relay, failures } = makeRelay({ usagePollMs: 60_000 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const all = Array.from({ length: 20 }, () => post(h, MSG, msgBody()).then(async r => { await r.text(); return r.status }))
    const cap = RELAY_LIMITS.inFlightPerNonce
    expect(cap).toBe(16)
    for (let i = 0; i < 400 && release.length < cap; i++) await new Promise(r => setTimeout(r, 5))
    await new Promise(r => setTimeout(r, 50))
    expect(release.length).toBe(cap)
    // Release one at a time: each freed slot goes to a waiter.
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 400 && release.length === 0; j++) await new Promise(r => setTimeout(r, 5))
      release.shift()?.()
    }
    expect(await Promise.all(all)).toEqual(Array(20).fill(200))
    expect(peak).toBe(cap)
    expect(failures).toEqual([])
  })

  it('a wait past the bound gets the busy 429, reported to the turn as relay_busy', async () => {
    const release: Array<() => void> = []
    mock.messages = async (_req, res, seen) => {
      await new Promise<void>(r => release.push(r))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(anthropicEvents(bodyModel(seen))))
    }
    const { relay, failures } = makeRelay({ usagePollMs: 60_000, inFlightWaitMs: 50 })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const held = Array.from({ length: RELAY_LIMITS.inFlightPerNonce }, () => post(h, MSG, msgBody()))
    for (let i = 0; i < 400 && release.length < RELAY_LIMITS.inFlightPerNonce; i++) await new Promise(r => setTimeout(r, 5))
    const extra = await post(h, MSG, msgBody())
    expect(extra.status).toBe(429)
    await extra.text()
    expect(failures).toContainEqual({ kind: 'relay_busy', status: 429 })
    for (const r of release.splice(0)) r()
    await Promise.all(held.map(p => p.then(r => r.text())))
  })

  it("HEAD /relay/a/api/hello is answered 204, never metered or logged as a 404", async () => {
    const { relay, logs } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await fetch(`${h.origin}/relay/a/api/hello`, { method: 'HEAD' })
    expect(r.status).toBe(204)
    expect(logs.some(l => l.includes('404'))).toBe(false)
    expect(ledgerRows()).toEqual([])
  })
})

describe('canary R9: cut-at-cap pricing and reconcile', () => {
  it('cache reads and writes are priced at their own rates', () => {
    const p = { inUsdPerM: 1, outUsdPerM: 10 }
    expect(relayMod.cachePricedUsd({ input: 100_000, output: 0, cacheRead: 100_000 }, p)).toBeCloseTo(0.01, 9)
    expect(relayMod.cachePricedUsd({ input: 100_000, output: 0, cacheWrite: 100_000 }, p)).toBeCloseTo(0.125, 9)
    expect(relayMod.cachePricedUsd({ input: 100_000, output: 1000, cacheRead: 90_000 }, p)).toBeCloseTo((10_000 + 9_000 + 10_000) / 1e6, 9)
  })

  it('a cache-heavy reply that fits under the headroom is not cut; a cut one is reconciled from its generation', async () => {
    const reconciled: string[] = []
    // 200k cached input tokens: full price $0.20, cache-read price $0.02. Headroom $0.05.
    mock.usageDaily = 0.95
    mock.messages = (_req, res, seen) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = anthropicEvents(bodyModel(seen))
      const start = ev[0]![1] as { message: { id: string; usage: Record<string, number> } }
      start.message.id = 'gen-cut-1'
      start.message.usage = { input_tokens: 10, cache_read_input_tokens: 200_000, output_tokens: 1 }
      res.end(sse(ev))
    }
    const { relay, failures } = makeRelay({ priceFor: () => ({ inUsdPerM: 1, outUsdPerM: 10 }), usagePollMs: 60_000, reconcileDelayMs: 1,
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/generation?')) reconciled.push(String(url))
        return fetch(url, init)
      }) as typeof fetch })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody(SLUG, { max_tokens: 100 }))
    expect(await r.text()).toContain('message_stop')
    expect(failures).toEqual([])
    // Now one that really passes the cap: plain input at full price.
    mock.messages = async (_req, res, seen) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = anthropicEvents(bodyModel(seen))
      const start = ev[0]![1] as { message: { id: string; usage: Record<string, number> } }
      start.message.id = 'gen-cut-2'
      start.message.usage = { input_tokens: 200_000, output_tokens: 1 }
      res.write(sse([ev[0]!, ev[1]!]))
      await new Promise(rr => setTimeout(rr, 5))
      if (!res.destroyed) res.end(sse(ev.slice(2)))
    }
    const r2 = await post(h, MSG, msgBody(SLUG, { max_tokens: 100 }))
    await r2.text()
    expect(failures).toContainEqual({ kind: 'cap_refused', status: 402 })
    const cutSettle = ledgerRows().filter(x => x.kind === 'settle').at(-1)!
    expect(cutSettle.generationId).toBe('gen-cut-2')
    for (let i = 0; i < 100 && !reconciled.some(u => u.includes('gen-cut-2')); i++) await new Promise(rr => setTimeout(rr, 10))
    expect(reconciled.some(u => u.includes('gen-cut-2'))).toBe(true)
  })
})

describe('QA N3 / N6: redaction of escaped forms; the rewrite log line', () => {
  it('redacts the plain, JSON-escaped and URL-encoded forms', () => {
    const s = 'sk-or-v1-abc/def+ghi"jkl'
    const text = `a ${s} b ${JSON.stringify(s).slice(1, -1)} c ${encodeURIComponent(s)}`
    const out = errorsMod.redactSecrets(text, [s])
    expect(out).not.toContain('abc/def')
    expect(out.split('[redacted]')).toHaveLength(4)
  })

  it('a child-sent model name with control characters reaches the log as safe characters only', async () => {
    const { relay, logs } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    await (await post(h, MSG, msgBody('claude-opus\n[key-relay] forged line\u001b[31m'))).text()
    const line = logs.find(l => l.includes('model rewritten'))!
    expect(line).toBeDefined()
    expect(line).not.toMatch(/[\n\u001b]/)
    expect(line.split('\n')).toHaveLength(1)
  })
})

describe('key relay: status mapping (plan 4.6, every row)', () => {
  const rows: Array<{ name: string; status: number; body: string; headers?: Record<string, string>; kind: string | null; breaker: 'key' | 'profile' | null }> = [
    { name: 'upstream 401', status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}', kind: 'key_rejected', breaker: 'key' },
    { name: 'upstream 402', status: 402, body: '{"error":{"message":"Insufficient credits"}}', kind: 'out_of_credit', breaker: 'key' },
    { name: 'model 404', status: 404, body: '{"error":{"message":"No endpoints found"}}', kind: 'model_gone', breaker: 'profile' },
    { name: 'model 400', status: 400, body: '{"error":{"message":"model not found"}}', kind: 'model_gone', breaker: 'profile' },
    // QA N10 / U2 (P11): retried rows are reported too, so a turn that still fails reads why.
    { name: '429', status: 429, body: '{"error":{"message":"slow down"}}', headers: { 'retry-after': '7' }, kind: 'rate_limited', breaker: null },
    { name: '5xx', status: 500, body: '{"error":{"message":"boom"}}', kind: 'upstream_error', breaker: null },
    { name: '529', status: 529, body: '{"type":"error","error":{"type":"overloaded_error"}}', kind: 'upstream_error', breaker: null },
    { name: '403 (moderation): upstream_refused, no breaker', status: 403, body: '{"error":{"message":"flagged"}}', kind: 'upstream_refused', breaker: null },
  ]
  for (const row of rows) {
    it(row.name, async () => {
      mock.messages = (_req, res) => { res.writeHead(row.status, { 'content-type': 'application/json', ...(row.headers ?? {}) }); res.end(row.body) }
      const { relay, failures, meter } = makeRelay()
      const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
      const r = await post(h, MSG, msgBody())
      expect(r.status).toBe(row.status)
      expect(await r.text()).toBe(row.body)
      if (row.headers?.['retry-after']) expect(r.headers.get('retry-after')).toBe('7')
      expect(failures.map(f => f.kind)).toEqual(row.kind ? [row.kind] : [])
      expect(relay.breakerState('key', keyRef).failures).toBe(row.breaker === 'key' ? 1 : 0)
      expect(relay.breakerState('profile', 'sonnet').failures).toBe(row.breaker === 'profile' ? 1 : 0)
      // An upstream error is not billed: the reservation is released.
      expect(meter.spentTodayUsd(keyRef)).toBe(0)
      expect(upstreamCalls('/messages')).toHaveLength(1)
    })
  }

  it('network error or timeout: 502 overloaded_error, no breaker', async () => {
    const dead = http.createServer()
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()))
    const port = (dead.address() as AddressInfo).port
    await new Promise<void>(r => dead.close(() => r()))
    const { relay, failures } = makeRelay({ upstreams: { openrouterMessages: `http://127.0.0.1:${port}/api/v1/messages` } })
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const r = await post(h, MSG, msgBody())
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ type: 'error', error: { type: 'overloaded_error' } })
    expect(relay.breakerState('key', keyRef).failures).toBe(0)
    expect(failures.map(f => f.kind)).toContain('network_error')

    mock.messages = () => { /* never answers */ }
    const slow = makeRelay({ upstreamHeadersTimeoutMs: 50 })
    const h2 = await slow.relay.issueTurn(binding({ turnId: 't2' }), { wallMaxMs: 60_000 })
    const t = await post(h2, MSG, msgBody())
    expect(t.status).toBe(502)
    await t.text()
    expect(slow.meter.spentTodayUsd(keyRef)).toBe(0)
  })

  it('OpenAI-shaped errors on the Codex route', async () => {
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding({ engine: 'codex', profileId: 'codex', allowedModel: CODEX_SLUG }), { wallMaxMs: 60_000 })
    const r = await post(h, RESP, { model: 'anthropic/claude-x', input: 'x' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'model_not_allowed' } })
  })
})

describe('key relay: breaker (plan 4.6)', () => {
  it('three 429s never open it; three 401s do, revoke the nonce and refuse new turns', async () => {
    let status = 429
    mock.messages = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{}') }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (let i = 0; i < 3; i++) await (await post(h, MSG, msgBody())).text()
    expect(relay.breakerState('key', keyRef)).toEqual({ open: false, failures: 0 })
    status = 401
    for (let i = 0; i < 3; i++) await (await post(h, MSG, msgBody())).text()
    expect(relay.breakerState('key', keyRef).open).toBe(true)
    const after = await post(h, MSG, msgBody())
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: { type: 'authentication_error' } })
    expect(upstreamCalls('/messages')).toHaveLength(6)
    await expect(relay.issueTurn(binding({ turnId: 't2' }), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'key_rejected', code: 'breaker_open' })
  })

  it('model-gone opens the profile breaker only', async () => {
    mock.messages = (_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}') }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (let i = 0; i < 3; i++) await (await post(h, MSG, msgBody())).text()
    expect(relay.breakerState('profile', 'sonnet').open).toBe(true)
    expect(relay.breakerState('key', keyRef).open).toBe(false)
    await expect(relay.issueTurn(binding({ turnId: 't2' }), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'model_gone' })
    await expect(relay.issueTurn(binding({ turnId: 't3', profileId: 'other' }), { wallMaxMs: 1000 })).resolves.toBeTruthy()
  })

  it('resets on key change (a fresh validation of the key)', async () => {
    mock.messages = (_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (let i = 0; i < 3; i++) await (await post(h, MSG, msgBody())).text()
    await expect(relay.issueTurn(binding({ turnId: 't2' }), { wallMaxMs: 1000 })).rejects.toMatchObject({ code: 'breaker_open' })
    offset += 1000
    store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1, validatedAt: new Date(now()).toISOString() })
    await expect(relay.issueTurn(binding({ turnId: 't3' }), { wallMaxMs: 1000 })).resolves.toBeTruthy()
    expect(relay.breakerState('key', keyRef).open).toBe(false)
  })

  it('a success between failures resets the count', async () => {
    let status = 401
    mock.messages = (_req, res, seen) => {
      if (status === 200) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(anthropicEvents(bodyModel(seen)))); return }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end('{}')
    }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    for (const s of [401, 401, 200, 401, 401]) { status = s; await (await post(h, MSG, msgBody())).text() }
    expect(relay.breakerState('key', keyRef)).toEqual({ open: false, failures: 2 })
  })
})

describe('key relay: pre-spawn key check (plan 7.2)', () => {
  it('a rejected OpenRouter key stops the turn before spawn', async () => {
    mock.keyStatus = 401
    const { relay } = makeRelay()
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'key_rejected', code: 'key_rejected' })
    expect(relay.port()).toBeNull()
  })

  it('no credit limit, or nothing remaining, stops the turn', async () => {
    mock.keyData = { limit: null, usage_daily: 0 }
    const { relay } = makeRelay()
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'out_of_credit', code: 'no_credit_limit' })
    mock.keyData = { limit: 5, limit_remaining: 0, usage_daily: 0 }
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'out_of_credit', code: 'out_of_credit' })
  })

  it('a key that is gone from the store is refused', async () => {
    store.deleteKeyStore()
    const { relay } = makeRelay({ isActive: () => true })
    await expect(relay.issueTurn(binding(), { wallMaxMs: 1000 })).rejects.toMatchObject({ kind: 'key_rejected', code: 'key_missing' })
  })
})

describe('key relay: upstream per key kind (plan 4.2)', () => {
  it('OpenRouter key on Codex: /responses with Bearer, SSE usage parsed', async () => {
    const { relay } = makeRelay({ priceFor: () => ({ inUsdPerM: 1, outUsdPerM: 10 }) })
    const h = await relay.issueTurn(binding({ engine: 'codex', profileId: 'codex', allowedModel: CODEX_SLUG }), { wallMaxMs: 60_000 })
    const r = await post(h, RESP, { model: CODEX_SLUG, input: 'ping', stream: true, max_output_tokens: 500 }, { originator: 'codex_exec' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(sse(openaiEvents()))
    const seen = upstreamCalls('/responses')[0]
    expect(seen.path).toBe('/api/v1/responses')
    expect(seen.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(seen.headers.originator).toBe('codex_exec')
    expect(ledgerRows().find(x => x.kind === 'settle')?.tokens).toEqual({ input: 50, output: 20 })
  })

  it('OpenAI key on Codex: api.openai.com path, JSON usage, no preflight', async () => {
    wipe()
    keyRef = saveKeyAndProfile(FAKE_OPENAI, 'openai', 'gpt-5.3-codex', 'codex')
    mock.responses = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'r', usage: { input_tokens: 5, output_tokens: 6 } })) }
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding({ engine: 'codex', profileId: 'codex', allowedModel: 'gpt-5.3-codex' }), { wallMaxMs: 60_000 })
    await (await post(h, RESP, { model: 'gpt-5.3-codex', input: 'x' })).text()
    const seen = upstreamCalls('/responses')[0]
    expect(seen.path).toBe('/openai/v1/responses')
    expect(seen.headers.authorization).toBe(`Bearer ${FAKE_OPENAI}`)
    expect(upstreamCalls('/key')).toEqual([])
    expect(ledgerRows().find(x => x.kind === 'settle')?.tokens).toEqual({ input: 5, output: 6 })
  })

  it('Anthropic key on Claude: x-api-key, no Authorization, no preflight', async () => {
    wipe()
    keyRef = saveKeyAndProfile(FAKE_ANTHROPIC, 'anthropic', 'claude-sonnet-5-5', 'claude')
    const { relay } = makeRelay()
    const h = await relay.issueTurn(binding({ allowedModel: 'claude-sonnet-5-5' }), { wallMaxMs: 60_000 })
    await (await post(h, MSG, msgBody('claude-opus-5-5'))).text()
    const seen = upstreamCalls('/messages')[0]
    expect(seen.path).toBe('/anthropic/v1/messages')
    expect(seen.headers['x-api-key']).toBe(FAKE_ANTHROPIC)
    expect(seen.headers.authorization).toBeUndefined()
    expect(bodyModel(seen)).toBe('claude-sonnet-5-5')
    expect(upstreamCalls('/key')).toEqual([])
  })
})

describe('key relay: redaction (plan 4.7)', () => {
  it('a fake key through every error path appears in no response, header, log, ledger or status', async () => {
    const echo = (req: IncomingMessage) => `${req.headers.authorization ?? ''} ${req.headers['x-api-key'] ?? ''}`
    let status = 401
    mock.messages = (req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-echo': echo(req) })
      res.end(JSON.stringify({ error: { message: `invalid key ${echo(req)}` } }))
    }
    const { relay, logs, failures } = makeRelay()
    lanes.__resetKeyLanesForTests()
    relayMod.installKeyRelaySeams()
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    const out: string[] = []
    for (const s of [401, 402, 400, 404, 429, 500, 529]) {
      status = s
      const r = await post(h, MSG, msgBody())
      out.push(String(r.status), await r.text(), JSON.stringify([...r.headers.entries()]))
    }
    // The upstream really did get the key, so the checks below are not vacuous.
    expect(upstreamCalls('/messages').every(x => x.headers.authorization === `Bearer ${FAKE_KEY}`)).toBe(true)
    expect(out.join('\n')).toContain('[redacted]')
    mock.keyStatus = 401
    const refusal = await relay.issueTurn(binding({ turnId: 'x' }), { wallMaxMs: 1000 }).catch(e => e as Error)
    const provider = lanes.keyLanesStatusProvider()
    const everything = [
      ...out, ...logs, JSON.stringify(failures), readFileSync(ledger.keyLedgerPath(), 'utf8'),
      String(refusal), (refusal as Error).message, JSON.stringify(provider.breaker?.(keyRef)), String(provider.spentTodayUsd?.(keyRef)),
    ].join('\n')
    expect(everything.includes(FAKE_KEY)).toBe(false)
    expect(everything.includes(FAKE_KEY.slice(0, 24))).toBe(false)
    expect(everything.includes(h.nonce)).toBe(false)
  })
})

describe('key relay: shared instance and lifecycle seams (plan 4.1)', () => {
  it('lanes going inactive (Remove all keys) revokes every nonce and closes the listener', async () => {
    lanes.__resetKeyLanesForTests()
    const relay = relayMod.getKeyRelay({
      now,
      upstreams: { openrouterMessages: `${mock.origin}/api/v1/messages` },
      openrouterApiBase: `${mock.origin}/api/v1`,
      reconcileDelayMs: null,
      log: () => {},
    })
    expect(relayMod.getKeyRelay()).toBe(relay)
    expect(lanes.keyLanesStatusProvider().spentTodayUsd).toBeTypeOf('function')
    const h = await relay.issueTurn(binding(), { wallMaxMs: 60_000 })
    await (await post(h, MSG, msgBody())).text()
    expect(lanes.keyLanesStatusProvider().spentTodayUsd!(keyRef)).toBeGreaterThan(0)
    const failed = await lanes.runKeyLanesInactiveHooks('remove_all')
    expect(failed).toEqual([])
    expect(relay.port()).toBeNull()
    expect(relay.liveTurnCount()).toBe(0)
    await expect(fetch(`${h.origin}/relay/health`)).rejects.toThrow()
  })
})
