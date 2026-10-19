// Key lanes K1, package P11: the wiring between the packages (key-lanes-wiring.ts), the direct
// relay adapter over P2's meter and breakers, and the meter's two P11 additions (per-turn spend,
// Control's saved cap). The Lane B bridges are mocked here: their own suites (P3, P4) prove what
// a keyed turn spawns; this file proves which runner and which relay each seam reaches.
//
// Scratch HOME, COS_DATA_DIR and COS_PROFILE_PATH: importing server modules runs them.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'kl-p11-wiring-'))
const savedEnv = { ...process.env }
process.env.HOME = join(scratch, 'home')
process.env.COS_DATA_DIR = join(scratch, 'data')
process.env.COS_PROFILE_PATH = join(scratch, 'profile.json')
delete process.env.COS_KEY_LANES

const mocks = vi.hoisted(() => ({
  claude: vi.fn(async (..._args: unknown[]) => 'claude-sid'),
  codex: vi.fn(async (..._args: unknown[]) => 'codex-sid'),
  direct: vi.fn(async (..._args: unknown[]) => 'direct-sid'),
  directRegistered: false,
  directResolver: null as null | (() => unknown),
}))
vi.mock('./claude-bridge.js', () => ({ callClaudeStreaming: mocks.claude }))
vi.mock('./codex-bridge.js', () => ({ runCodexKeyProfileTurn: mocks.codex }))
vi.mock('./direct-bridge.js', () => ({
  callDirectStreaming: mocks.direct,
  directRelayRegistered: () => mocks.directRegistered,
  registerDirectRelay: (r: () => unknown) => { mocks.directRegistered = true; mocks.directResolver = r },
}))

const wiring = await import('./key-lanes-wiring.js')
const lanes = await import('./key-lanes.js')
const routing = await import('./key-profile-routing.js')
const laneB = await import('./lane-b-env.js')
const codexHome = await import('./codex-profile-home.js')
const keyed = await import('./keyed-sessions.js')
const relayMod = await import('./key-relay.js')
const { KeyRelayMeter, FALLBACK_PRICE, TURN_SPEND_MAX } = await import('./key-relay-meter.js')
const { RelayBreakers } = await import('./key-relay-errors.js')
const { keyCatalogPeekPrice } = await import('./key-lanes-pricing.js')
import type { KeyProfile } from './key-relay-contract.js'

afterAll(async () => {
  await relayMod.__resetKeyRelayForTests()
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  rmSync(scratch, { recursive: true, force: true })
})

const PROFILE: KeyProfile = {
  id: 'sonnet-key', label: 'Sonnet', keyRef: 'key_0123456789ab', engine: 'claude', model: 'anthropic/claude-sonnet-5.5',
  enabled: true, timeoutTier: 'haiku', offerOnV1: false, directTools: false, createdAt: '', updatedAt: '',
} as KeyProfile
const TURN = { binding: 'profile:sonnet-key', profile: PROFILE, keyKind: 'openrouter' } as never
const cb = () => ({ onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }) as never

const catalogMod = await import('./key-catalog.js')
/** Tests never reach the network: the catalog fetch fails offline unless a test seeds it. */
function offlineCatalog(models?: Array<{ id: string; name: string; inUsdPerM: number; outUsdPerM: number }>) {
  const body = models ? JSON.stringify({ data: models.map(m => ({ id: m.id, name: m.name, pricing: { prompt: String(m.inUsdPerM / 1e6), completion: String(m.outUsdPerM / 1e6) }, architecture: { output_modalities: ['text'] } })) }) : null
  const catalog = new catalogMod.KeyCatalog({ fetchImpl: (async () => { if (!body) throw new Error('offline'); return new Response(body, { status: 200 }) }) as unknown as typeof fetch })
  catalogMod.__setKeyCatalogForTests(catalog)
  return catalog
}

async function rewire(env: string | undefined) {
  offlineCatalog()
  if (env === undefined) delete process.env.COS_KEY_LANES
  else process.env.COS_KEY_LANES = env
  lanes.__resetKeyLanesForTests()
  routing.__resetKeyProfileEnginesForTests()
  laneB.registerLaneBRelay(null)
  codexHome.__resetCodexProfileSeamsForTests()
  await relayMod.__resetKeyRelayForTests()
  wiring.__resetKeyLanesWiringForTests()
  wiring.wireKeyLanes()
}

describe('wireKeyLanes: every seam filled, the relay seams only while enabled', () => {
  beforeEach(() => { mocks.claude.mockClear(); mocks.codex.mockClear(); mocks.direct.mockClear(); mocks.directRegistered = false })

  it('lanes off: the three engines and both Lane B relays are registered, the relay status seams are not', async () => {
    await rewire(undefined)
    for (const e of ['claude', 'codex', 'direct'] as const) expect(routing.keyProfileEngineRunner(e), e).toBeTypeOf('function')
    expect(laneB.laneBRelayRegistered()).toBe(true)
    expect(codexHome.codexKeyRelayRegistered()).toBe(true)
    const provider = lanes.keyLanesStatusProvider()
    expect(provider.spentTodayUsd).toBeUndefined()
    expect(provider.breaker).toBeUndefined()
    expect(provider.keyedSessionIds).toBeTypeOf('function')
  })

  it('COS_KEY_LANES=0 forces the relay seams off too', async () => {
    await rewire('0')
    expect(lanes.keyLanesStatusProvider().spentTodayUsd).toBeUndefined()
  })

  it('lanes on at boot: the relay answers spend and breaker on the status route', async () => {
    await rewire('1')
    const provider = lanes.keyLanesStatusProvider()
    expect(provider.spentTodayUsd).toBeTypeOf('function')
    expect(provider.breaker).toBeTypeOf('function')
  })

  it('both Lane B relay seams reach the one shared relay, and wiring opens no listener', async () => {
    await rewire('1')
    const a = await laneB.laneBRelay()
    const b = await codexHome.codexKeyRelay()
    expect(a.port()).toBeNull()
    expect(b.port()).toBeNull()
    const shared = relayMod.getKeyRelay()
    const revoke = vi.spyOn(shared, 'revokeAll')
    a.revokeAll('cancel'); b.revokeAll('cancel')
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('claude runner: callClaudeStreaming with the timeout tier and the profile, options kept', async () => {
    await rewire('1')
    const callbacks = cb()
    const sid = await routing.keyProfileEngineRunner('claude')!('q', 's1', callbacks, TURN, undefined, undefined, 7, { lightweight: true, turnId: 't1' })
    expect(sid).toBe('claude-sid')
    const args = mocks.claude.mock.calls[0]!
    expect([...args.slice(0, 2), ...args.slice(3, 7)]).toEqual(['q', 's1', 'haiku', undefined, undefined, 7])
    expect(args[7]).toEqual({ lightweight: true, turnId: 't1', keyProfile: PROFILE })
    // The callbacks are the caller's, with onError reading the relay's line for the turn.
    const wrapped = args[2] as { onChunk: unknown; onError: (e: string) => Promise<void> }
    expect(wrapped.onChunk).toBe((callbacks as { onChunk: unknown }).onChunk)
  })

  it('codex runner: runCodexKeyProfileTurn with the resolved turn', async () => {
    await rewire('1')
    await routing.keyProfileEngineRunner('codex')!('q', 's2', cb(), TURN, undefined, undefined, undefined, { turnId: 't2' })
    expect(mocks.codex.mock.calls[0]![3]).toBe(TURN)
    expect(mocks.codex.mock.calls[0]![7]).toEqual({ turnId: 't2' })
  })

  it('direct runner: loads the direct lane on first use, registers the relay once, passes the profile', async () => {
    await rewire('1')
    await routing.keyProfileEngineRunner('direct')!('q', 's3', cb(), TURN)
    expect(mocks.directRegistered).toBe(true)
    expect(mocks.direct.mock.calls[0]![3]).toBe(PROFILE)
    expect(typeof (mocks.directResolver!() as { openTurn?: unknown }).openTurn).toBe('function')
  })

  it('a keyed Codex thread is recorded like a Claude one (P3 store)', async () => {
    await rewire('1')
    expect(keyed.isKeyedSession('019a0000-codex-thread-p11')).toBe(false)
    codexHome.recordKeyedCodexThread({ id: '019a0000-codex-thread-p11', engine: 'codex', profileId: 'gpt-key', cosSessionId: 'cos-1' })
    expect(keyed.isKeyedSession('019a0000-codex-thread-p11')).toBe(true)
    expect(lanes.keyLanesStatusProvider().keyedSessionIds!()).toContain('019a0000-codex-thread-p11')
  })
})

// ── The direct relay adapter ──────────────────────────────────────────────────

const SECRET = 'sk-or-v1-p11directfakefakefakefakefakefakefakefakefakefakefake77'
const REF = 'key_00000000beef'
const BINDING = { keyRef: REF, keyKind: 'openrouter' as const, profileId: 'direct-p', turnId: 'turn-direct-1', sessionId: 's', model: 'meta/llama-9', endpoint: 'https://openrouter.example/api/v1/chat/completions' }
const PRICE = { inUsdPerM: 1, outUsdPerM: 2 }

function rig(opts: { cap?: number | null; active?: boolean; secret?: string | null; respond?: (url: string, init: RequestInit) => Response | Promise<Response> } = {}) {
  const rows: unknown[] = []
  const meter = new KeyRelayMeter({ capUsd: () => (opts.cap === undefined ? 1 : opts.cap), appendRow: r => { rows.push(r) }, loadSettled: () => 0, log: () => {} })
  const breakers = new RelayBreakers()
  const calls: Array<{ url: string; init: RequestInit }> = []
  const relay = wiring.createDirectRelay({
    isActive: () => opts.active ?? true,
    secretFor: () => (opts.secret === undefined ? SECRET : opts.secret),
    meter,
    breakers: () => breakers,
    priceFor: () => PRICE,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return opts.respond ? opts.respond(String(url), init!) : new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch,
  })
  return { relay, meter, breakers, calls, rows }
}
const signal = () => new AbortController().signal

describe('createDirectRelay: P2 meter, breakers and the secret read, in process', () => {
  it('refuses before any request: lanes off, key gone, cap used', async () => {
    expect(await rig({ active: false }).relay.openTurn(BINDING)).toEqual({ ok: false, refused: 'lanes_inactive' })
    expect(await rig({ secret: null }).relay.openTurn(BINDING)).toEqual({ ok: false, refused: 'key_missing' })
    expect(await rig({ cap: null }).relay.openTurn(BINDING)).toEqual({ ok: false, refused: 'cap_refused' })
  })

  it('posts only to the endpoint, with the key as Bearer and the profile model whatever the body says', async () => {
    const r = rig()
    const opened = await r.relay.openTurn(BINDING)
    if (!opened.ok) throw new Error('refused')
    const post = await opened.turn.post({ model: 'anthropic/claude-opus-9', messages: [], max_tokens: 100 }, signal())
    expect('response' in post).toBe(true)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.url).toBe(BINDING.endpoint)
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(String(r.calls[0]!.init.body)).model).toBe('meta/llama-9')
    expect(r.calls[0]!.init.redirect).toBe('error')
  })

  it('reserves before sending and settles the measured cost on the shared counter and the turn', async () => {
    const r = rig()
    const opened = await r.relay.openTurn(BINDING)
    if (!opened.ok) throw new Error('refused')
    const post = await opened.turn.post({ messages: [], max_tokens: 100 }, signal())
    if (!('response' in post)) throw new Error('refused')
    expect(r.meter.openReservationsUsd(REF)).toBeGreaterThan(0)
    post.settle({ input: 1000, output: 500, costUsd: 0.004 })
    expect(r.meter.openReservationsUsd(REF)).toBe(0)
    expect(r.meter.spentTodayUsd(REF)).toBeCloseTo(0.004, 9)
    expect(r.meter.turnSettledUsd('turn-direct-1')).toBeCloseTo(0.004, 9)
    // No provider cost: tokens times the price.
    const p2 = await opened.turn.post({ messages: [] }, signal())
    if (!('response' in p2)) throw new Error('refused')
    p2.settle({ input: 1_000_000, output: 0 })
    expect(r.meter.turnSettledUsd('turn-direct-1')).toBeCloseTo(1.004, 9)
    expect(opened.turn.spentTodayUsd!()).toBeCloseTo(1.004, 9)
  })

  it('a cut stream (no usage) settles the full reservation', async () => {
    const r = rig()
    const opened = await r.relay.openTurn(BINDING)
    if (!opened.ok) throw new Error('refused')
    const post = await opened.turn.post({ messages: [], max_tokens: 100 }, signal())
    if (!('response' in post)) throw new Error('refused')
    const reserved = r.meter.openReservationsUsd(REF)
    post.settle(null)
    expect(r.meter.spentTodayUsd(REF)).toBeCloseTo(reserved, 9)
  })

  it('a post that would pass the cap is refused before sending', async () => {
    const r = rig({ cap: 0.0000001 })
    // atCap is false at 0 spent, so the turn opens; the reserve does not fit.
    const opened = await r.relay.openTurn(BINDING)
    if (!opened.ok) throw new Error('refused at open')
    expect(await opened.turn.post({ messages: [], max_tokens: 4096 }, signal())).toEqual({ refused: 'cap_refused' })
    expect(r.calls).toHaveLength(0)
  })

  it('a network error releases the reservation and never carries the key', async () => {
    const r = rig({ respond: () => { throw new Error(`connect failed for ${SECRET}`) } })
    const opened = await r.relay.openTurn(BINDING)
    if (!opened.ok) throw new Error('refused')
    const err = await opened.turn.post({ messages: [] }, signal()).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(SECRET)
    expect(r.meter.openReservationsUsd(REF)).toBe(0)
    expect(r.meter.spentTodayUsd(REF)).toBe(0)
  })

  it('401 three times opens the key breaker; the error body reaching the lane is scrubbed of the key', async () => {
    const r = rig({ respond: () => new Response(`{"error":"bad key ${SECRET}"}`, { status: 401 }) })
    for (let i = 0; i < 3; i++) {
      const opened = await r.relay.openTurn(BINDING)
      if (!opened.ok) throw new Error(`refused at ${i}`)
      const post = await opened.turn.post({ messages: [] }, signal())
      if (!('response' in post)) throw new Error('refused')
      expect(post.response.status).toBe(401)
      const text = await post.response.text()
      expect(text).not.toContain(SECRET)
      expect(text).toContain('[redacted]')
      post.settle({ input: 0, output: 0 })
    }
    expect(r.breakers.isOpen('key', REF)).toBe(true)
    expect(await r.relay.openTurn(BINDING)).toEqual({ ok: false, refused: 'breaker_open' })
  })

  it('a 429 never counts toward a breaker; a 404 counts toward the profile breaker', async () => {
    const r429 = rig({ respond: () => new Response('slow down', { status: 429 }) })
    for (let i = 0; i < 4; i++) {
      const o = await r429.relay.openTurn(BINDING)
      if (!o.ok) throw new Error('refused')
      await o.turn.post({ messages: [] }, signal())
    }
    expect(r429.breakers.isOpen('key', REF)).toBe(false)
    const r404 = rig({ respond: () => new Response('no endpoints found', { status: 404 }) })
    for (let i = 0; i < 3; i++) {
      const o = await r404.relay.openTurn(BINDING)
      if (!o.ok) throw new Error('refused')
      await o.turn.post({ messages: [] }, signal())
    }
    expect(r404.breakers.isOpen('profile', 'direct-p')).toBe(true)
    expect(r404.breakers.isOpen('key', REF)).toBe(false)
  })
})

// ── The meter's P11 additions ─────────────────────────────────────────────────

describe('KeyRelayMeter: per-turn spend and the cap Control saved', () => {
  it('keeps the first cap seen (or the one Control saved) when the file changes under it', () => {
    let fileCap: number | null = 2
    const logs: string[] = []
    const meter = new KeyRelayMeter({ capUsd: () => fileCap, appendRow: () => {}, loadSettled: () => 0, log: l => logs.push(l) })
    expect(meter.capUsd(REF)).toBe(2)
    fileCap = 500 // a Lane A turn editing provider-keys.json
    expect(meter.capUsd(REF)).toBe(2)
    expect(meter.capUsd(REF)).toBe(2)
    expect(logs.filter(l => l.includes('changed outside COS Control'))).toHaveLength(1)
    meter.noteSavedCap(REF, 5) // COS Control saved a new cap
    fileCap = 5
    expect(meter.capUsd(REF)).toBe(5)
    fileCap = null // the key was removed
    expect(meter.capUsd(REF)).toBeNull()
  })

  it('a bad saved cap is ignored', () => {
    const meter = new KeyRelayMeter({ capUsd: () => 3, appendRow: () => {}, loadSettled: () => 0, log: () => {} })
    meter.noteSavedCap(REF, Number.NaN)
    meter.noteSavedCap(REF, -1)
    expect(meter.capUsd(REF)).toBe(3)
  })

  it('turnSettledUsd sums one turn, never another, and forgets the oldest past the bound', () => {
    const meter = new KeyRelayMeter({ capUsd: () => 100, appendRow: () => {}, loadSettled: () => 0, log: () => {} })
    const settle = (turnId: string, usd: number) => {
      const r = meter.reserve({ keyRef: REF, turnId, estimateUsd: 0.01 })
      if (!r.ok) throw new Error('refused')
      meter.settle({ reservationId: r.reservationId, usd, tokens: { input: 0, output: 0 } })
    }
    settle('a', 0.25); settle('a', 0.5); settle('b', 1)
    expect(meter.turnSettledUsd('a')).toBeCloseTo(0.75, 9)
    expect(meter.turnSettledUsd('b')).toBeCloseTo(1, 9)
    expect(meter.turnSettledUsd('never')).toBe(0)
    for (let i = 0; i < TURN_SPEND_MAX; i++) settle(`t${i}`, 0.001)
    expect(meter.turnSettledUsd('a')).toBe(0)
    expect(meter.turnSettledUsd(`t${TURN_SPEND_MAX - 1}`)).toBeCloseTo(0.001, 9)
    meter.clear()
    expect(meter.turnSettledUsd(`t${TURN_SPEND_MAX - 1}`)).toBe(0)
  })
})

describe('keyCatalogPeekPrice', () => {
  it('curated price for a curated slug, the fallback for an unknown one (never cheaper)', () => {
    expect(keyCatalogPeekPrice('anthropic/claude-haiku-5.5')).toEqual({ inUsdPerM: 0.1, outUsdPerM: 0.5 })
    expect(keyCatalogPeekPrice('someone/unknown-model')).toEqual(FALLBACK_PRICE)
  })
})

// ── Codex engine sessions: one slot per lane (P11) ────────────────────────────

describe('codex engine sessions keyed by profile', () => {
  const file = join(scratch, 'codex-engine-sessions.json')
  beforeEach(() => { process.env.COS_CODEX_ENGINE_SESSIONS_FILE = file; rmSync(file, { force: true }) })

  it('a keyed turn and a subscription turn of one session keep separate resumes', async () => {
    const ces = await import('./codex-engine-sessions.js')
    const base = { cosSessionId: 'cos-x', model: 'codex-frontier' as never, cwd: '/w', trustMode: 'read-only' as const }
    ces.saveCodexEngineSession({ ...base, codexThreadId: 'sub-thread' })
    ces.saveCodexEngineSession({ ...base, codexThreadId: 'key-thread', profileId: 'gpt-key' })
    expect(ces.getCodexEngineSession(base)?.codexThreadId).toBe('sub-thread')
    expect(ces.getCodexEngineSession({ ...base, profileId: 'gpt-key' })?.codexThreadId).toBe('key-thread')
    // Clearing one lane's slot leaves the other.
    expect(ces.clearCodexEngineSession('cos-x', base.model, 'gpt-key')).toBe(1)
    expect(ces.getCodexEngineSession(base)?.codexThreadId).toBe('sub-thread')
    ces.saveCodexEngineSession({ ...base, codexThreadId: 'key-thread-2', profileId: 'gpt-key' })
    expect(ces.clearCodexEngineSession('cos-x', base.model)).toBe(1)
    expect(ces.getCodexEngineSession({ ...base, profileId: 'gpt-key' })?.codexThreadId).toBe('key-thread-2')
    // Deleting the COS session clears every slot.
    expect(ces.clearCodexEngineSession('cos-x')).toBe(1)
  })

  it('a subscription row is written exactly as before: no profileId field, the 6.79.0 key', async () => {
    const ces = await import('./codex-engine-sessions.js')
    ces.saveCodexEngineSession({ cosSessionId: 'cos-y', model: 'codex-frontier' as never, cwd: '/w', trustMode: 'read-only', codexThreadId: 't' })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, Record<string, unknown>> }
    expect(Object.keys(raw.sessions)).toEqual(['cos-y:codex-frontier'])
    expect(raw.sessions['cos-y:codex-frontier']).not.toHaveProperty('profileId')
  })

  it('a row with a malformed profileId is dropped on read, never resumed', async () => {
    const ces = await import('./codex-engine-sessions.js')
    writeFileSync(file, JSON.stringify({ savedAt: '', sessions: { x: {
      cosSessionId: 'cos-z', model: 'codex-frontier', codexThreadId: 't', cwd: '/w', trustMode: 'read-only',
      lastUsedAt: Date.now(), expiresAt: new Date(Date.now() + 60_000).toISOString(), profileId: '../etc',
    } } }))
    expect(ces.listCodexEngineSessions()).toEqual([])
  })
})

// ── One source of copy (P8), and the composition root ─────────────────────────

describe('key-lane refusal lines live in key-notices.ts', () => {
  it('every package reads the same line, and no line carries an em dash, arrow or blank glyph', async () => {
    const notices = await import('./key-notices.js')
    const C = notices.KEY_LANE_REFUSAL_COPY
    const direct = await vi.importActual<typeof import('./direct-bridge.js')>('./direct-bridge.js')
    const rejects = await import('./key-profile-rejects.js')
    expect(laneB.LANE_B_COPY.relayUnavailable).toBe(C.relayUnavailable)
    expect(codexHome.CODEX_LANE_B_COPY.relayUnavailable).toBe(C.relayUnavailable)
    expect(direct.DIRECT_COPY.relayUnavailable).toBe(C.relayUnavailable)
    expect(laneB.LANE_B_COPY.profileOff('X')).toBe(routing.keyProfileOffLine('X'))
    expect(rejects.KEY_PROFILE_SCHEDULED_REJECT).toBe(C.scheduled)
    expect(routing.KEY_PROFILE_V1_NOT_OFFERED).toBe(C.v1NotOffered)
    const lines = Object.values(C).map(v => (typeof v === 'function' ? (v as (l: string) => string)('Sonnet') : v))
    for (const line of lines) {
      expect(line, line).not.toMatch(/[–—←-⇿]/u)
      for (const g of notices.KEY_NOTICE_BLANK_GLYPHS) expect(line.includes(g), line).toBe(false)
      expect(line.toLowerCase(), line).not.toContain('sign in')
      expect(notices.keyNoticeWidthPx(line), line).toBeLessThanOrEqual(notices.KEY_NOTICE_BODY_PX * 2)
    }
  })
})

describe('same-Mac residual risk copy (QA B1, pinned by COS Control)', () => {
  it('is exactly the agreed sentence and fits the house copy rules', async () => {
    const notices = await import('./key-notices.js')
    expect(notices.KEY_LANE_SAME_MAC_COPY).toBe("Your key is saved on this Mac. Apps and agents that run on this Mac as you can read it. Your provider's spending limit is the real stop.")
    expect(notices.KEY_LANE_SAME_MAC_COPY).not.toMatch(/[\u2013\u2014\u2190-\u21ff]/u)
  })
})

describe('composition root (source shape: index.ts cannot be executed in a test)', () => {
  it('index.ts wires the key lanes exactly once, after the key-lanes router is mounted', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
    expect(src.split('\nwireKeyLanes()\n').length - 1).toBe(1)
    expect(src.indexOf('\nwireKeyLanes()\n')).toBeGreaterThan(src.indexOf("app.use('/api', createKeyLanesRouter("))
  })
})


// ── Relay turn failures read as the key-notices line (P11) ───────────────────

describe('a keyed turn the relay failed shows the key-notices line, not the CLI error', () => {
  const RAW = 'claude-bridge: API Error: 402 {"error":{"message":"Insufficient credits"}}'
  async function claudeTurn(turnId?: string) {
    await rewire('1')
    mocks.claude.mockClear()
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await routing.keyProfileEngineRunner('claude')!('q', 's', callbacks as never, TURN, undefined, undefined, undefined, turnId ? { turnId } : {})
    const args = mocks.claude.mock.calls[0]!
    return { callbacks, wrapped: args[2] as { onError: (e: string) => Promise<void>; onDone: (...a: unknown[]) => unknown }, turnId: (args[7] as { turnId: string }).turnId }
  }

  it('402 mid-turn: the out-of-credit line', async () => {
    const t = await claudeTurn('turn-402')
    wiring.recordKeyTurnFailure({ turnId: 'turn-402', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'out_of_credit', status: 402 })
    await t.wrapped.onError(RAW)
    const line = t.callbacks.onError.mock.calls[0]![0] as string
    expect(line).toMatch(/out of credit/i)
    expect(line).not.toContain('API Error')
  })

  it('cap mid-turn and 401: the cap line and the rejected-key line', async () => {
    const a = await claudeTurn('turn-cap')
    wiring.recordKeyTurnFailure({ turnId: 'turn-cap', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'cap_refused', status: 402 })
    await a.wrapped.onError(RAW)
    expect(a.callbacks.onError.mock.calls[0]![0]).toMatch(/cap on this key is used/)
    const b = await claudeTurn('turn-401')
    wiring.recordKeyTurnFailure({ turnId: 'turn-401', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'key_rejected', status: 401 })
    await b.wrapped.onError(RAW)
    expect(b.callbacks.onError.mock.calls[0]![0]).toMatch(/was rejected/)
  })

  it('the failure that opened the breaker reads as the pause', async () => {
    const t = await claudeTurn('turn-brk')
    const br = relayMod.getKeyRelay().breakers
    for (let i = 0; i < 3; i++) br.record('key', PROFILE.keyRef, 'key_rejected', false)
    wiring.recordKeyTurnFailure({ turnId: 'turn-brk', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'key_rejected', status: 401 })
    await t.wrapped.onError(RAW)
    expect(t.callbacks.onError.mock.calls[0]![0]).toMatch(/^Key paused 1 hour after 3 failures\.$/)
  })

  it('a turn refused before spawn (lanes went off) reads the profile-off line, not "could not start"', async () => {
    const t = await claudeTurn('turn-pre')
    delete process.env.COS_KEY_LANES
    lanes.__resetKeyLanesForTests()
    const view = await laneB.laneBRelay()
    await expect(view.issueTurn({ keyRef: PROFILE.keyRef, profileId: PROFILE.id, turnId: 'turn-pre', sessionId: 's', engine: 'claude', allowedModel: PROFILE.model }, { wallMaxMs: 1000 })).rejects.toThrow()
    await t.wrapped.onError(laneB.LANE_B_COPY.relayUnavailable)
    expect(t.callbacks.onError.mock.calls[0]![0]).toBe('Key profile Sonnet is off. Pick a model.')
  })

  it('no recorded failure: the error passes through unchanged; onDone forgets a stale one; the turn gets an id', async () => {
    const t = await claudeTurn()
    expect(t.turnId).toMatch(/^[0-9a-f-]{36}$/)
    await t.wrapped.onError(RAW)
    expect(t.callbacks.onError).toHaveBeenCalledWith(RAW)
    const d = await claudeTurn('turn-done')
    wiring.recordKeyTurnFailure({ turnId: 'turn-done', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'out_of_credit', status: 402 })
    await d.wrapped.onDone('answer', 'opus')
    expect(wiring.keyTurnFailureLine('turn-done', PROFILE)).toBeNull()
  })

  it('QA U2: every kind maps to a line; a turn-ending failure is never hidden by a later retry note', async () => {
    const f = (turnId: string, kind: string, status: number, endsTurn: boolean) => wiring.recordKeyTurnFailure({ turnId, sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: kind as never, status, endsTurn })
    f('k429', 'rate_limited', 429, false)
    expect(wiring.keyTurnFailureLine('k429', PROFILE)).toMatch(/busy for this key/)
    f('k5xx', 'upstream_error', 500, false)
    expect(wiring.keyTurnFailureLine('k5xx', PROFILE)).toMatch(/had an error/)
    f('knet', 'network_error', 502, false)
    expect(wiring.keyTurnFailureLine('knet', PROFILE)).toMatch(/Could not reach/)
    f('k403', 'upstream_refused', 403, false)
    expect(wiring.keyTurnFailureLine('k403', PROFILE)).toMatch(/refused this request/)
    f('kexp', 'nonce_expired', 401, false)
    expect(wiring.keyTurnFailureLine('kexp', PROFILE)).toMatch(/ran past its time limit/)
    f('krev', 'nonce_revoked', 401, false)
    expect(wiring.keyTurnFailureLine('krev', PROFILE)).toMatch(/was stopped/)
    f('kmix', 'rate_limited', 429, false); f('kmix', 'out_of_credit', 402, true); f('kmix', 'nonce_revoked', 401, false)
    expect(wiring.keyTurnFailureLine('kmix', PROFILE)).toMatch(/out of credit/i)
  })

  it('the shared relay reports its turn failures into the same table', async () => {
    await rewire('1')
    const relay = wiring.sharedKeyRelay() as unknown as { onTurnFailure: (f: unknown) => void }
    relay.onTurnFailure({ turnId: 'turn-shared', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'out_of_credit', status: 402 })
    expect(wiring.keyTurnFailureLine('turn-shared', PROFILE)).toMatch(/out of credit/i)
  })

  it('the Codex runner reads the same lines', async () => {
    await rewire('1')
    mocks.codex.mockClear()
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await routing.keyProfileEngineRunner('codex')!('q', 's', callbacks as never, TURN, undefined, undefined, undefined, { turnId: 'turn-codex-402' })
    const wrapped = mocks.codex.mock.calls[0]![2] as { onError: (e: string) => Promise<void> }
    wiring.recordKeyTurnFailure({ turnId: 'turn-codex-402', sessionId: 's', profileId: PROFILE.id, keyRef: PROFILE.keyRef, kind: 'out_of_credit', status: 402 })
    await wrapped.onError('Codex failed (codex.unknown). Retry or check Codex Debug.')
    expect(callbacks.onError.mock.calls[0]![0]).toMatch(/out of credit/i)
  })
})


describe('QA C11: an OpenRouter slug that left the catalog is refused before anything runs', () => {
  beforeEach(() => { mocks.claude.mockClear(); mocks.codex.mockClear(); mocks.direct.mockClear() })

  it('cached catalog without the slug: the model-gone line, no bridge; with it, or with no cache, the turn runs', async () => {
    await rewire('1')
    const catalog = offlineCatalog([{ id: 'anthropic/claude-haiku-5.5', name: 'Haiku', inUsdPerM: 1, outUsdPerM: 5 }])
    await catalog.get()
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    for (const engine of ['claude', 'codex', 'direct'] as const) {
      await routing.keyProfileEngineRunner(engine)!('q', 's', callbacks as never, TURN)
    }
    expect(mocks.claude).not.toHaveBeenCalled(); expect(mocks.codex).not.toHaveBeenCalled(); expect(mocks.direct).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(3)
    expect(callbacks.onError.mock.calls[0]![0]).toMatch(/is no longer on OpenRouter/)
    const present = offlineCatalog([{ id: PROFILE.model, name: 'Sonnet', inUsdPerM: 2, outUsdPerM: 10 }])
    await present.get()
    await routing.keyProfileEngineRunner('claude')!('q', 's', cb(), TURN)
    expect(mocks.claude).toHaveBeenCalledTimes(1)
    offlineCatalog()
    await routing.keyProfileEngineRunner('claude')!('q', 's', cb(), TURN)
    expect(mocks.claude).toHaveBeenCalledTimes(2)
  })

  it('a key with no OpenRouter catalog (Anthropic) is never checked against it', async () => {
    await rewire('1')
    await offlineCatalog([{ id: 'x/y', name: 'Y', inUsdPerM: 1, outUsdPerM: 1 }]).get()
    expect(wiring.keyProfileSlugGoneLine({ profile: PROFILE, keyKind: 'anthropic' } as never)).toBeNull()
  })
})
