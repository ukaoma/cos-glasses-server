// Key lanes K1, package P6 (plan v4 5.2): a model preference that names a key profile is
// ACCEPTED at the turn path (routed to the profile's engine), ACCEPTED BY SYNTAX at persistence,
// and REFUSED with a lens line at resolve time when it cannot run. Never a silent subscription
// turn. Real conversation, key-lanes, key-store and key-profiles on a scratch HOME and data dir;
// the four provider bridges are mocks that record whether they were asked.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p6-pref-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.HOME = scratch
process.env.COS_DATA_DIR = dataDir
process.env.COS_PROFILE_PATH = join(dataDir, 'profile.json')
delete process.env.COS_KEY_LANES
delete process.env.COS_G2_DEFAULT_MODEL

const bridges = vi.hoisted(() => ({
  claude: vi.fn(async (_q: string, sid: string, cb: any, _model?: unknown) => { await cb.onDone('sub answer', 'sonnet'); return sid }),
  codex: vi.fn(async (_q: string, sid: string, cb: any, _model?: unknown) => { await cb.onDone('sub answer', 'codex-frontier'); return sid }),
  cursor: vi.fn(async (_q: string, sid: string) => sid),
  ollama: vi.fn(async (_q: string, sid: string) => sid),
}))
vi.mock('./claude-bridge.js', () => ({ callClaudeStreaming: bridges.claude }))
vi.mock('./codex-bridge.js', () => ({ callCodexStreaming: bridges.codex }))
vi.mock('./cursor-bridge.js', () => ({ callCursorStreaming: bridges.cursor }))
vi.mock('./ollama-bridge.js', () => ({ callOllamaStreaming: bridges.ollama }))

const lanes = await import('./key-lanes.js')
const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const conversation = await import('./conversation.js')
const routing = await import('./key-profile-routing.js')
const { callModelStreaming } = await import('./model-router.js')

const FAKE_KEY = 'sk-or-v1-' + 'ab'.repeat(32)
const KEY_FILES = ['key-lanes.json', 'provider-keys.json', 'provider-profiles.json']

function cb() {
  return { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onKeyProfileTurn: vi.fn() }
}

function saveProfile(opts: { id?: string; label?: string; engine?: 'claude' | 'codex' | 'direct'; model?: string; enabled?: boolean } = {}) {
  const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
  const v = profiles.validateProfileInput({
    id: opts.id ?? 'sonnet55', label: opts.label ?? 'Sonnet 5.5', keyRef: key.ref,
    engine: opts.engine ?? 'claude', model: opts.model ?? 'anthropic/claude-sonnet-5.5', enabled: opts.enabled ?? true,
  }, ref => store.getPublicKey(ref)?.kind)
  if (!v.ok) throw new Error(v.message)
  profiles.upsertProfile(v.profile)
  return v.profile
}

function wipeKeys() {
  for (const f of KEY_FILES) rmSync(join(dataDir, f), { force: true })
  lanes.refreshKeyLanesEnabled()  // not __resetKeyLanesForTests: that drops the remove-all hook conversation.ts registered
  routing.__resetKeyProfileEnginesForTests()
  routing.__resetEnvProfileWarningForTests()
}

beforeEach(() => {
  delete process.env.COS_KEY_LANES
  delete process.env.COS_G2_DEFAULT_MODEL
  wipeKeys()
  for (const b of Object.values(bridges)) b.mockClear()
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('P6 off: no profile anywhere', () => {
  it('runs on scratch data only', () => {
    expect(dataDir.startsWith(scratch)).toBe(true)
  })

  it('model slots, no model and junk route exactly as 6.79.0, and no key-lane file appears', async () => {
    const sid = conversation.createSession()
    const a = cb()
    await callModelStreaming('q', sid, a, 'sonnet')
    expect(bridges.claude).toHaveBeenCalledTimes(1)
    expect(bridges.claude.mock.calls[0][3]).toBe('sonnet')
    await callModelStreaming('q', sid, cb(), undefined)
    expect(bridges.claude.mock.calls[1][3]).toBe('sonnet')
    await callModelStreaming('q', sid, cb(), 'codex-high' as never)
    expect(bridges.codex.mock.calls[0][3]).toBe('codex-frontier')
    await callModelStreaming('q', sid, cb(), 'not-a-model' as never)
    // junk keeps the session's model (codex-frontier now), as today
    expect(bridges.codex).toHaveBeenCalledTimes(2)
    expect(a.onKeyProfileTurn).not.toHaveBeenCalled()
    expect(conversation.getSessionModel(sid)).toBe('codex-frontier')
    for (const f of KEY_FILES) expect(existsSync(join(dataDir, f))).toBe(false)
  })

  it('the onKeyProfileTurn callback never reaches a subscription bridge', async () => {
    await callModelStreaming('q', conversation.createSession(), cb(), 'sonnet')
    expect(bridges.claude.mock.calls[0][2]).not.toHaveProperty('onKeyProfileTurn')
  })
})

describe('P6 resolve-time refusal (never a silent subscription turn)', () => {
  it('lanes off: a profile request is refused with the lens line and no bridge runs', async () => {
    const sid = conversation.createSession()
    const c = cb()
    await callModelStreaming('q', sid, c, 'profile:sonnet55')
    expect(c.onError).toHaveBeenCalledWith('Key profile sonnet55 is off. Pick a model.')
    for (const b of Object.values(bridges)) expect(b).not.toHaveBeenCalled()
    expect(conversation.getSessionBinding(sid)).toBeNull()
  })

  it('unknown, disabled and keyless profiles refuse with the profile label; the binding is not written', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile({ id: 'other', label: 'Other' })
    const sid = conversation.createSession()
    const c1 = cb()
    await callModelStreaming('q', sid, c1, 'profile:ghost')
    expect(c1.onError).toHaveBeenCalledWith('Key profile ghost is off. Pick a model.')
    saveProfile({ id: 'sleepy', label: 'Sleepy', enabled: false })
    const c2 = cb()
    await callModelStreaming('q', sid, c2, 'profile:sleepy')
    expect(c2.onError).toHaveBeenCalledWith('Key profile Sleepy is off. Pick a model.')
    store.deleteKeyStore()
    const c3 = cb()
    await callModelStreaming('q', sid, c3, 'profile:other')
    expect(c3.onError).toHaveBeenCalledWith('Key profile Other is off. Pick a model.')
    for (const b of Object.values(bridges)) expect(b).not.toHaveBeenCalled()
    expect(conversation.getSessionBinding(sid)).toBeNull()
  })

  it('no runner registered for the engine: refused, never the subscription', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile({ id: 'gpt', label: 'GPT Key', engine: 'codex', model: 'openai/gpt-5.5' })
    const c = cb()
    await callModelStreaming('q', conversation.createSession(), c, 'profile:gpt')
    expect(c.onError).toHaveBeenCalledWith('Key profile GPT Key cannot answer on this server yet. Pick a model.')
    for (const b of Object.values(bridges)) expect(b).not.toHaveBeenCalled()
  })

  it('a scheduled dispatch never runs on a profile', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile()
    const runner = vi.fn()
    routing.registerKeyProfileEngine('claude', runner)
    const c = cb()
    await callModelStreaming('q', conversation.createSession(), c, 'profile:sonnet55', undefined, undefined, undefined, { dispatch: { restricted: true, tools: ['Read'] } })
    expect(c.onError).toHaveBeenCalledWith('dispatch_requires_claude')
    expect(runner).not.toHaveBeenCalled()
    expect(bridges.claude).not.toHaveBeenCalled()
  })
})

describe('P6 Accept: an active profile runs on its engine', () => {
  it('routes to the registered runner, persists the binding by syntax, and the next turn stays on the key', async () => {
    process.env.COS_KEY_LANES = '1'
    const profile = saveProfile()
    const runner = vi.fn(async (_q: string, sid: string, callbacks: any, _turn?: unknown) => { await callbacks.onDone('key answer', 'sonnet'); return sid })
    routing.registerKeyProfileEngine('claude', runner)
    const sid = conversation.createSession()
    const c = cb()
    await callModelStreaming('q', sid, c, 'profile:sonnet55')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][3]).toMatchObject({ binding: 'profile:sonnet55', keyKind: 'openrouter', profile: { id: profile.id, engine: 'claude' } })
    expect(c.onKeyProfileTurn).toHaveBeenCalledWith(expect.objectContaining({ binding: 'profile:sonnet55' }))
    expect(c.onDone).toHaveBeenCalledWith('key answer', 'sonnet', undefined, undefined)
    expect(conversation.getSessionBinding(sid)).toBe('profile:sonnet55')
    // CLOSED view: no pre-key-lanes caller can read the profile as a model slot.
    expect(conversation.getSessionModel(sid)).toBeNull()
    // No model on the next turn: the session binding wins, not COS_G2_DEFAULT_MODEL or the default.
    process.env.COS_G2_DEFAULT_MODEL = 'opus'
    await callModelStreaming('q2', sid, cb(), undefined)
    expect(runner).toHaveBeenCalledTimes(2)
    expect(bridges.claude).not.toHaveBeenCalled()
    // An explicit model slot switches back to the subscription.
    await callModelStreaming('q3', sid, cb(), 'haiku')
    expect(bridges.claude).toHaveBeenCalledTimes(1)
    expect(conversation.getSessionBinding(sid)).toBe('haiku')
  })

  it('the session run lock releases on the keyed terminal callback', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile()
    const held: any[] = []
    routing.registerKeyProfileEngine('claude', vi.fn(async (_q: string, sid: string, callbacks: any) => { held.push(callbacks); return sid }))
    const sid = conversation.createSession()
    await callModelStreaming('q', sid, cb(), 'profile:sonnet55')
    const second = callModelStreaming('q', sid, cb(), 'sonnet')
    await Promise.resolve()
    expect(bridges.claude).not.toHaveBeenCalled()
    await held[0].onError('relay said no')
    await second
    expect(bridges.claude).toHaveBeenCalledTimes(1)
  })

  it('a session bound to a profile whose lanes were turned off refuses instead of answering on the plan', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile()
    routing.registerKeyProfileEngine('claude', vi.fn(async (_q: string, sid: string, callbacks: any) => { await callbacks.onDone('k', 'sonnet'); return sid }))
    const sid = conversation.createSession()
    await callModelStreaming('q', sid, cb(), 'profile:sonnet55')
    process.env.COS_KEY_LANES = '0'
    const c = cb()
    await callModelStreaming('q', sid, c, undefined)
    expect(c.onError).toHaveBeenCalledWith('Key profile Sonnet 5.5 is off. Pick a model.')
    expect(bridges.claude).not.toHaveBeenCalled()
  })
})

describe('P6 persistence: Accept by syntax (conversation.ts :163 :168 :490 :628 :722)', () => {
  it('addExchange and reconcile stamp profile:<id>; the pair model resolves to it; junk is still dropped', () => {
    const sid = conversation.createSession()
    const user = conversation.addExchange(sid, 'user', 'q', 1, undefined, undefined, 'profile:sonnet55')
    expect(user.modelPreference).toBe('profile:sonnet55')
    const junk = conversation.addExchange(sid, 'user', 'q', 2, undefined, undefined, 'profile:Bad Id' as never)
    expect(junk).not.toHaveProperty('modelPreference')
    const { exchange } = conversation.reconcileExchangeByJobIdentity(sid, { clientJobId: 'job-p6', generation: 1 }, 'assistant', 'a', 1, undefined, undefined, 'profile:sonnet55')
    expect(exchange.modelPreference).toBe('profile:sonnet55')
    expect(conversation.resolveExchangePairModel(undefined, undefined, 'profile:sonnet55')).toBe('profile:sonnet55')
    expect(conversation.resolveExchangePairModel({ modelPreference: 'codex-high' as never }, undefined, null)).toBe('codex-frontier')
    expect(conversation.normalizeSessionBinding('profile:')).toBeUndefined()
    expect(conversation.normalizeSessionBinding('opus')).toBe('opus')
  })

  it('a restart keeps the session binding and the exchange stamp, so the next turn is refused, not answered on the plan', async () => {
    // P11: settle the earlier module instance's debounced save first. Under full-suite load its
    // timer fired while the fresh import below was loading and overwrote this file (seen once).
    conversation.flushConversationToDisk()
    const file = join(dataDir, 'sessions.json')
    writeFileSync(file, JSON.stringify({
      savedAt: new Date().toISOString(),
      sessions: {
        keyed01: {
          id: 'keyed01', createdAt: Date.now(), lastActivity: Date.now(), contextBreaks: [],
          modelPreference: 'profile:sonnet55',
          exchanges: [{ role: 'user', content: 'q', timestamp: Date.now(), modelPreference: 'profile:sonnet55' }],
        },
        plain01: {
          id: 'plain01', createdAt: Date.now(), lastActivity: Date.now(), contextBreaks: [],
          modelPreference: 'codex-high',
          exchanges: [{ role: 'user', content: 'q', timestamp: Date.now(), modelPreference: 'nonsense' }],
        },
      },
    }), { mode: 0o600 })
    vi.resetModules()
    const fresh = await import('./conversation.js')
    expect(fresh.getSessionBinding('keyed01')).toBe('profile:sonnet55')
    expect(fresh.getHistory('keyed01')[0].modelPreference).toBe('profile:sonnet55')
    expect(fresh.getSessionModel('keyed01')).toBeNull()
    expect(fresh.getSessionBinding('plain01')).toBe('codex-frontier')
    expect(fresh.getHistory('plain01')[0]).not.toHaveProperty('modelPreference')
    const router = await import('./model-router.js')
    const c = cb()
    await router.callModelStreaming('q', 'keyed01', c, undefined)
    expect(c.onError).toHaveBeenCalledWith('Key profile sonnet55 is off. Pick a model.')
    expect(bridges.claude).not.toHaveBeenCalled()
    rmSync(file, { force: true })
  })

  it('Remove all keys clears every profile binding and breaks context; exchange stamps stay', async () => {
    const sid = conversation.createSession()
    conversation.setSessionModel(sid, 'profile:sonnet55')
    conversation.addExchange(sid, 'user', 'q', 1, undefined, undefined, 'profile:sonnet55')
    const plain = conversation.createSession()
    conversation.setSessionModel(plain, 'opus')
    const breaksBefore = conversation.getSessionRaw(sid)!.contextBreaks.length
    expect(await lanes.runKeyLanesInactiveHooks('remove_all')).toEqual([])
    expect(conversation.getSessionBinding(sid)).toBeNull()
    expect(conversation.getSessionRaw(sid)!.contextBreaks.length).toBe(breaksBefore + 1)
    expect(conversation.getHistory(sid)[0].modelPreference).toBe('profile:sonnet55')
    expect(conversation.getSessionBinding(plain)).toBe('opus')
    // Disabling lanes keeps the binding (it refuses at resolve instead).
    conversation.setSessionModel(sid, 'profile:sonnet55')
    await lanes.runKeyLanesInactiveHooks('disabled')
    expect(conversation.getSessionBinding(sid)).toBe('profile:sonnet55')
  })
})

describe('P6 COS_G2_DEFAULT_MODEL stays closed', () => {
  it('a profile id in the env default is ignored with one warning, and the default model answers', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile()
    const runner = vi.fn()
    routing.registerKeyProfileEngine('claude', runner)
    process.env.COS_G2_DEFAULT_MODEL = 'profile:sonnet55'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sid = conversation.createSession()
    await callModelStreaming('q', sid, cb(), undefined)
    await callModelStreaming('q', conversation.createSession(), cb(), undefined)
    expect(runner).not.toHaveBeenCalled()
    expect(conversation.getSessionBinding(sid)).toBe('sonnet')
    expect(bridges.claude).toHaveBeenCalledTimes(2)
    expect(bridges.claude.mock.calls[0][3]).toBe('sonnet')
    expect(warn.mock.calls.filter(c => String(c[0]).includes('COS_G2_DEFAULT_MODEL names a key profile'))).toHaveLength(1)
    warn.mockRestore()
  })
})

describe('scratch hygiene', () => {
  it('wrote nothing outside the scratch dir', () => {
    expect(readdirSync(scratch).sort()).toEqual(['data'])
  })
})

describe('P6 labels (shared/model-preference.ts, labels only)', () => {
  it('a passed profile labels the turn; without one every label is the 6.79.0 one, Opus default included', async () => {
    const m = await import('../../shared/model-preference.js')
    expect(m.modelLabel('sonnet', { label: 'Sonnet 5.5 key' })).toBe('Sonnet 5.5 key')
    expect(m.modelShortLabel('sonnet', { label: 'A very long profile label' })).toBe('A very long ')
    expect(m.modelLabel('sonnet', { label: '   ' })).toBe('Sonnet')
    expect(m.modelLabel('sonnet')).toBe('Sonnet')
    expect(m.modelLabel('profile:x' as never)).toBe('Opus')
    expect(m.modelShortLabel('codex-balanced')).toBe('GPT Bal')
    expect(m.isModelPreference('profile:sonnet55')).toBe(false)
    expect(m.normalizeModelPreference('profile:sonnet55')).toBeUndefined()
  })
})
