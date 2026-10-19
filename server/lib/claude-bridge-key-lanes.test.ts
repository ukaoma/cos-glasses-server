// Key lanes K1 P3 (plan v4 7.1 to 7.3): a Lane B Claude turn through a FAKE relay.
//
// The relay is P2's; this file consumes only the KeyRelay contract (key-relay-contract.ts) and
// registers a fake through the lane-b-env seam. Real key and profile stores run against a scratch
// data dir, and HOME and the provider cwd are scratch dirs, so no live settings file is read.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  children: [] as any[],
  spawns: [] as Array<{ cmd: string; args: string[]; opts: any }>,
  cwd: '/tmp',
  audit: [] as any[],
  exchanges: [] as Array<{ role: string; model: unknown }>,
  removed: 0,
  publisher: null as any,
}))
const CLI_SESSIONS = '/tmp/cos-cli-sessions.json'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const guard = (path: unknown) => String(path) === CLI_SESSIONS
  return {
    ...actual,
    existsSync: (path: any) => guard(path) ? false : actual.existsSync(path),
    unlinkSync: (path: any) => { if (guard(path)) throw new Error('test refused to unlink the live CLI session file'); return actual.unlinkSync(path) },
    writeFileSync: (path: any, ...rest: any[]) => guard(path) ? undefined : (actual.writeFileSync as any)(path, ...rest),
    readFileSync: (path: any, ...rest: any[]) => guard(path) ? '{}' : (actual.readFileSync as any)(path, ...rest),
  }
})
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writable: true })
    pid = 5151
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    spawn: vi.fn((cmd: string, args: string[], opts: any) => {
      state.spawns.push({ cmd, args: [...args], opts })
      const child = new FakeChild()
      state.children.push(child)
      return child
    }),
  }
})
vi.mock('./python-bridge.js', () => ({ COS_SCRIPTS_DIR: '/tmp' }))
vi.mock('./launch-dir.js', () => ({ resolveProviderWorkDir: () => state.cwd }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn((entry: any) => { state.audit.push(entry) }) }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'system'),
  buildLightweightSystemPrompt: vi.fn(() => 'system'),
  buildPrewarmSystemPrompt: vi.fn(() => 'system'),
  getCachedContextInstant: vi.fn(() => ''),
}))
vi.mock('./conversation.js', () => ({
  getHistory: () => [],
  addExchange: (_sid: string, role: string, _c: string, _g: unknown, _a: unknown, _p: unknown, model: unknown) => {
    state.exchanges.push({ role, model })
    return { id: 'exchange' }
  },
  setExchangeAttachments: vi.fn(),
  removeExchange: vi.fn(() => { state.removed += 1 }),
  formatHistoryForPrompt: () => '',
  getOrCreateSession: (sid?: string) => sid ?? 'session-test',
  isNewSession: () => false,
  markSessionNotified: vi.fn(),
  getSessionModel: () => null,
  getSessionRaw: () => ({ contextBreaks: [] }),
  replaceLastExchangeWithSummary: vi.fn(),
}))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./claude-run-ledger.js', () => ({
  finishClaudeRun: vi.fn(),
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-key-lanes' }),
  updateClaudeRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({ claudeToolInputPreview: () => undefined, claudeToolResultPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(() => state.publisher ?? undefined),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({ terminateProviderProcess: vi.fn(async () => ({ closed: true, code: 0 })) }))
vi.mock('./claude-cli-support.js', () => ({ claudeSupportsSessionName: vi.fn(async () => true) }))

const scratch = mkdtempSync(join(tmpdir(), 'kl-p3-bridge-'))
const home = join(scratch, 'home'), cwd = join(scratch, 'cwd')
mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true })
const savedEnv = { ...process.env }
process.env.COS_DATA_DIR = join(scratch, 'data')
process.env.HOME = home
process.env.COS_KEY_LANES = '1'
state.cwd = cwd

// Fake values only. The key below is what the relay would hold; no child may ever see it.
const FAKE_KEY = 'sk-or-v1-p3fakefakefakefakefakefakefakefakefakefakefakefakefake1a2b'
const FAKE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fake-p3-0000',
  ANTHROPIC_AUTH_TOKEN: 'fake-auth-token-p3',
  ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
  ANTHROPIC_MODEL: 'claude-fake-model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fake-sonnet',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fake-fable',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-fake-sub',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  OPENROUTER_API_KEY: 'sk-or-v1-fake-server-env',
  OPENAI_API_KEY: 'sk-fake-openai-p3',
  OPENAI_BASE_URL: 'https://example.invalid/openai',
  COS_API_TOKEN: 'fake-cos-api-token-p3',
  UNRELATED_SETTING: 'keep-me',
}
Object.assign(process.env, FAKE_ENV)

const bridge = await import('./claude-bridge.js')
const laneB = await import('./lane-b-env.js')
const keyed = await import('./keyed-sessions.js')
const { saveKey } = await import('./key-store.js')
const { getProfile, upsertProfile, validateProfileInput } = await import('./key-profiles.js')
const { getPublicKey } = await import('./key-store.js')
import type { KeyProfile, KeyRelay, RelayNonceBinding, RelayTurnHandle } from './key-relay-contract.js'

const key = saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
const SLUG = 'anthropic/claude-sonnet-5.5'
const validated = validateProfileInput({ id: 'sonnet-key', label: 'Sonnet', keyRef: key.ref, engine: 'claude', model: SLUG }, ref => getPublicKey(ref)?.kind)
if (!validated.ok) throw new Error('fixture profile invalid: ' + validated.message)
upsertProfile(validated.profile)
const profile = getProfile('sonnet-key') as KeyProfile

// ── The fake relay (P2 contract only) ──
const relayLog = { issued: [] as Array<{ binding: RelayNonceBinding; wallMaxMs: number; handle: RelayTurnHandle }>, fail: false }
let nonceN = 0
const fakeRelay: KeyRelay = {
  issueTurn: vi.fn(async (binding: RelayNonceBinding, options: { wallMaxMs: number }) => {
    if (relayLog.fail) throw new Error('fake relay: limit_remaining 0')
    nonceN += 1
    const handle: RelayTurnHandle = { nonce: `fake-nonce-${nonceN}`, origin: 'http://127.0.0.1:45999', childClosed: vi.fn(), revoke: vi.fn() }
    relayLog.issued.push({ binding, wallMaxMs: options.wallMaxMs, handle })
    return handle
  }),
  revokeTurn: vi.fn(),
  revokeAll: vi.fn(),
  port: () => 45999,
  close: vi.fn(async () => {}),
}
laneB.registerLaneBRelay(() => fakeRelay)

afterAll(() => {
  laneB.registerLaneBRelay(null)
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  relayLog.fail = false
  state.publisher = null
  rmSync(join(home, '.claude'), { recursive: true, force: true })
  rmSync(join(cwd, '.claude'), { recursive: true, force: true })
})

function cb() {
  return {
    onChunk: vi.fn(), onDone: vi.fn(async () => {}), onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}),
    onProviderProcess: vi.fn(async () => true), onStart: vi.fn(),
  } as any
}
function finish(child: any, extra: Record<string, unknown> = {}) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', ...extra })}\n`))
  child.emit('close', 0)
}
const settle = () => new Promise(r => setTimeout(r, 0))

async function turn(sid: string, opts: Record<string, unknown> = {}, model: 'opus' | 'sonnet' | 'haiku' = 'opus', sessionId?: string) {
  const before = state.spawns.length
  const callbacks = cb()
  await bridge.callClaudeStreaming('What changed this week?', sid, callbacks, model, undefined, undefined, undefined, { lightweight: true, ...opts } as any)
  const spawned = state.spawns.length > before ? state.spawns.at(-1)! : null
  const child = spawned ? state.children.at(-1) : null
  if (child) finish(child, sessionId ? { session_id: sessionId } : {})
  await settle()
  return { callbacks, spawned, child }
}
const modelArg = (args: string[]) => args[args.indexOf('--model') + 1]
const resumeArg = (args: string[]) => args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null

describe('Lane B Claude: argv and child env (plan 7.1, 7.2)', () => {
  it('argv differs from the subscription turn only in --model, which is the profile slug with no [1m]', async () => {
    const a = await turn('argv-a', {}, 'sonnet')
    const b = await turn('argv-b', { keyProfile: profile })
    expect(modelArg(b.spawned!.args)).toBe(SLUG)
    expect(b.spawned!.args.join(' ')).not.toContain('[1m]')
    const strip = (args: string[]) => args.map((v, i) => args[i - 1] === '--model' ? '<model>' : args[i - 1] === '--resume' ? '<resume>' : v).filter(v => v !== '--resume' && v !== '<resume>')
    expect(strip(b.spawned!.args)).toEqual(strip(a.spawned!.args))
    expect(b.spawned!.cmd).toBe('claude')
  })

  it('the env-name difference A vs B is exactly the documented set, every other name and value kept', async () => {
    const a = await turn('env-a', {}, 'opus')
    const b = await turn('env-b', { keyProfile: profile })
    const envA: Record<string, string> = a.spawned!.opts.env, envB: Record<string, string> = b.spawned!.opts.env
    const issued = relayLog.issued.at(-1)!
    const onlyA = Object.keys(envA).filter(k => !(k in envB)).sort()
    const onlyB = Object.keys(envB).filter(k => !(k in envA)).sort()
    const changed = Object.keys(envB).filter(k => k in envA && envA[k] !== envB[k] && k !== 'COS_TURN_REQUEST_FILE').sort()
    expect(onlyA).toEqual(['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_USE_BEDROCK', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY'])
    expect(onlyB).toEqual(['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_MAX_RETRIES', 'COS_KEY_PROFILE'])
    expect(changed).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'])
    // Every differing name is one the plan documents.
    for (const name of [...onlyA, ...onlyB, ...changed]) {
      expect(laneB.isLaneBStrippedName(name) || laneB.LANE_B_CLAUDE_ADDED_NAMES.includes(name), name).toBe(true)
    }
    expect(envB.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:45999/relay/a')
    expect(envB.ANTHROPIC_AUTH_TOKEN).toBe(issued.handle.nonce)
    expect(envB.ANTHROPIC_API_KEY).toBe('')
    expect(envB.CLAUDE_CODE_MAX_RETRIES).toBe('2')
    for (const n of laneB.LANE_B_CLAUDE_MODEL_NAMES) expect(envB[n], n).toBe(SLUG)
    expect(envB.COS_KEY_PROFILE).toBe('sonnet-key')
    expect(envB.CLAUDECODE).toBeUndefined()
    // Kept: PATH, HOME, COS_API_TOKEN and everything unrelated, value for value.
    for (const n of ['PATH', 'HOME', 'COS_API_TOKEN', 'UNRELATED_SETTING', 'COS_DATA_DIR']) expect(envB[n], n).toBe(envA[n])
    expect(envB.COS_TURN_REQUEST_FILE).toBeTruthy()
  })

  it('process.env is never written by a keyed turn', async () => {
    const before = JSON.stringify(process.env)
    await turn('procenv', { keyProfile: profile })
    expect(JSON.stringify(process.env)).toBe(before)
  })

  it('no real key reaches the child: argv and env hold only the nonce', async () => {
    const b = await turn('nokey', { keyProfile: profile })
    const blob = JSON.stringify({ args: b.spawned!.args, env: b.spawned!.opts.env })
    expect(blob.includes(FAKE_KEY)).toBe(false)
    expect(blob.includes(FAKE_ENV.OPENROUTER_API_KEY)).toBe(false)
    expect(blob.includes(FAKE_ENV.ANTHROPIC_API_KEY)).toBe(false)
  })

  it('the nonce binding names the key, profile, session, engine and slug; timeouts come from the tier', async () => {
    await turn('binding-1', { keyProfile: { ...profile, timeoutTier: 'haiku' }, turnId: 'turn-binding-1' })
    const { binding, wallMaxMs } = relayLog.issued.at(-1)!
    expect(binding).toEqual({ keyRef: key.ref, profileId: 'sonnet-key', turnId: 'turn-binding-1', sessionId: 'binding-1', engine: 'claude', allowedModel: SLUG })
    expect(wallMaxMs).toBe(60_000)
  })

  it('the output image publisher env is re-applied on a profile run', async () => {
    state.publisher = { env: { COS_RUN_OUTPUT_IMAGE_DIR: '/tmp/p3-images' }, claudeAllowedTool: undefined, promptInstructions: 'images', cleanup: vi.fn(), stats: { published: 0, attached: 0, rejected: 0 } }
    const b = await turn('publisher', { keyProfile: profile, lightweight: false })
    expect(b.spawned!.opts.env.COS_RUN_OUTPUT_IMAGE_DIR).toBe('/tmp/p3-images')
    expect(b.spawned!.opts.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^fake-nonce-/)
  })

  it('the nonce is closed with the child, and revoked on a cancel', async () => {
    await turn('nonce-close', { keyProfile: profile })
    expect(relayLog.issued.at(-1)!.handle.childClosed).toHaveBeenCalledTimes(1)
    const abort = new AbortController()
    const callbacks = cb()
    await bridge.callClaudeStreaming('Long one', 'nonce-cancel', callbacks, 'opus', undefined, undefined, undefined, { lightweight: true, keyProfile: profile, abortSignal: abort.signal } as any)
    abort.abort()
    await settle()
    expect(relayLog.issued.at(-1)!.handle.revoke).toHaveBeenCalledWith('cancel')
    state.children.at(-1).emit('close', null)
    await settle()
  })
})

describe('Lane B Claude: keyed CLI sessions (plan 7.1, 7.3)', () => {
  it('a keyed turn uses its own session key: never handed out, never resumed by the subscription', async () => {
    await turn('mix-1', { keyProfile: profile }, 'opus', 'cli-keyed-mix-0001')
    expect(bridge.getCliSessionId('mix-1')).toBeUndefined()
    expect(bridge.getAvailableCliSessionId('mix-1')).not.toBe('cli-keyed-mix-0001')
    // Switch back: the subscription turn in the same COS session starts fresh.
    const sub = await turn('mix-1', {}, 'opus', 'cli-sub-mix-0001')
    expect(resumeArg(sub.spawned!.args)).toBeNull()
    // The profile asking again resumes its own transcript.
    const again = await turn('mix-1', { keyProfile: profile }, 'opus', 'cli-keyed-mix-0001')
    expect(resumeArg(again.spawned!.args)).toBe('cli-keyed-mix-0001')
    // And the subscription one is still its own.
    expect(bridge.getCliSessionId('mix-1')).toBe('cli-sub-mix-0001')
  })

  it('a keyed turn never resumes the subscription session of the same COS session', async () => {
    await turn('mix-2', {}, 'opus', 'cli-sub-mix-0002')
    const k = await turn('mix-2', { keyProfile: { ...profile, timeoutTier: 'opus' } }, 'opus')
    expect(resumeArg(k.spawned!.args)).toBeNull()
  })

  it('the pre-warmed subscription session is never handed to a keyed turn (tier = default model)', async () => {
    const warm = bridge.preWarmCLI()
    finish(state.children.at(-1), { session_id: 'warm-p3-0001' })
    await warm
    expect(profile.timeoutTier).toBe('sonnet')
    const k = await turn('warm-k', { keyProfile: profile }, 'sonnet')
    expect(resumeArg(k.spawned!.args)).toBeNull()
    // Still there for the next subscription default-model turn.
    const before = state.spawns.length
    await bridge.callClaudeStreaming('hi', 'warm-sub', cb(), 'sonnet', undefined, undefined, undefined, { lightweight: true })
    const subSpawn = state.spawns.at(-1)!
    expect(resumeArg(subSpawn.args)).toBe('warm-p3-0001')
    expect(state.spawns.length - before).toBe(2) // the next pre-warm, then the turn
    finish(state.children.at(-2), { session_id: 'warm-p3-0002' })
    finish(state.children.at(-1))
    await settle()
  })

  it('records the CLI session as keyed the moment the CLI names it, before any answer text', async () => {
    const callbacks = cb()
    await bridge.callClaudeStreaming('Q', 'record-1', callbacks, 'opus', undefined, undefined, undefined, { lightweight: true, keyProfile: profile } as any)
    const child = state.children.at(-1)
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-keyed-rec-0001', model: SLUG })}\n`))
    expect(keyed.isKeyedSession('cli-keyed-rec-0001')).toBe(true)
    expect(keyed.isKeyedCosSession('record-1')).toBe(true)
    expect(statSync(keyed.keyedSessionsPath()).mode & 0o777).toBe(0o600)
    finish(child, { session_id: 'cli-keyed-rec-0001' })
    await settle()
    // A subscription session is never recorded.
    await turn('record-2', {}, 'opus', 'cli-sub-rec-0002')
    expect(keyed.isKeyedSession('cli-sub-rec-0002')).toBe(false)
  })
})

describe('Lane B Claude: answer fields, history and token audit', () => {
  it('a keyed answer carries lane and credential; the exchange is stamped with the profile; audit gets key fields', async () => {
    state.audit.length = 0; state.exchanges.length = 0
    const k = await turn('fields-k', { keyProfile: profile })
    const [, doneModel, , meta] = k.callbacks.onDone.mock.calls[0]
    expect(doneModel).toBe('sonnet')
    expect(meta.keyLane).toEqual({ lane: 'key', credential: { kind: 'openrouter', ref: key.ref, profileId: 'sonnet-key' } })
    expect(k.callbacks.onStart.mock.calls[0][3].keyLane).toEqual(meta.keyLane)
    expect(state.exchanges.map(e => e.model)).toEqual(['profile:sonnet-key', 'profile:sonnet-key'])
    expect(state.audit.at(-1)).toMatchObject({ profile: 'sonnet-key', lane: 'key', credentialKind: 'openrouter' })
    // No profile: none of it.
    state.audit.length = 0; state.exchanges.length = 0
    const a = await turn('fields-a', {}, 'opus')
    expect('keyLane' in a.callbacks.onDone.mock.calls[0][3]).toBe(false)
    expect('keyLane' in a.callbacks.onStart.mock.calls[0][3]).toBe(false)
    expect(state.exchanges.map(e => e.model)).toEqual(['opus', 'opus'])
    for (const f of ['profile', 'lane', 'credentialKind', 'usd']) expect(f in state.audit.at(-1)).toBe(false)
  })
})

describe('Lane B Claude: refusals spawn nothing and never fall back to the subscription', () => {
  async function refused(sid: string, opts: Record<string, unknown>) {
    const spawnsBefore = state.spawns.length, issuedBefore = relayLog.issued.length
    const { callbacks } = await turn(sid, opts)
    expect(state.spawns.length, 'spawned').toBe(spawnsBefore)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onStart).not.toHaveBeenCalled()
    return { message: callbacks.onError.mock.calls[0][0] as string, issued: relayLog.issued.length - issuedBefore }
  }

  it('key lanes not active', async () => {
    delete process.env.COS_KEY_LANES
    try {
      const r = await refused('ref-off', { keyProfile: profile })
      expect(r.message).toBe(laneB.LANE_B_COPY.lanesOff)
      expect(r.issued).toBe(0)
    } finally { process.env.COS_KEY_LANES = '1' }
  })

  it('profile off, wrong engine, key gone, dispatch', async () => {
    expect((await refused('ref-disabled', { keyProfile: { ...profile, enabled: false } })).message).toBe('Key profile Sonnet is off. Pick a model.')
    expect((await refused('ref-engine', { keyProfile: { ...profile, engine: 'codex' } })).message).toBe(laneB.LANE_B_COPY.wrongEngine('Sonnet'))
    expect((await refused('ref-key', { keyProfile: { ...profile, keyRef: 'key_000000000000' } })).message).toBe(laneB.LANE_B_COPY.keyMissing('Sonnet'))
    expect((await refused('ref-dispatch', { keyProfile: profile, dispatch: { restricted: true, tools: ['Read'] } })).message).toBe(laneB.LANE_B_COPY.scheduled)
  })

  it('a Claude settings file that would bypass the relay refuses the profile (user, project, local)', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }))
    expect((await refused('ref-settings-user', { keyProfile: profile })).message).toBe('A Claude settings file sets ANTHROPIC_BASE_URL. Remove it to use a key.')
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/key-helper' }))
    expect((await refused('ref-settings-local', { keyProfile: profile })).message).toBe('A Claude settings file sets apiKeyHelper. Remove it to use a key.')
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}')
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }))
    expect((await refused('ref-settings-project', { keyProfile: profile })).message).toBe('A Claude settings file sets CLAUDE_CODE_USE_VERTEX. Remove it to use a key.')
  })

  it('settings that do not touch credentials (the MU project file shape) do not refuse', async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', MAX_THINKING_TOKENS: '1000' } }))
    const k = await turn('settings-ok', { keyProfile: profile })
    expect(k.spawned).not.toBeNull()
  })

  it('no relay registered, or the relay refuses to issue: nothing spawned, the exchange rolled back', async () => {
    laneB.registerLaneBRelay(null)
    try {
      expect((await refused('ref-norelay', { keyProfile: profile })).message).toBe(laneB.LANE_B_COPY.relayUnavailable)
    } finally { laneB.registerLaneBRelay(() => fakeRelay) }
    relayLog.fail = true
    const removedBefore = state.removed
    const spawnsBefore = state.spawns.length
    const { callbacks } = await turn('ref-issue', { keyProfile: profile })
    expect(state.spawns.length).toBe(spawnsBefore)
    expect(callbacks.onError).toHaveBeenCalledWith(laneB.LANE_B_COPY.relayUnavailable)
    expect(state.removed).toBe(removedBefore + 1)
  })
})

describe('Lane B Claude: P11 wiring (per-answer cost, steer abort)', () => {
  it('a keyed answer carries what the relay settled for its turn as usd, in done and the audit row', async () => {
    const { getSharedKeyMeter } = await import('./key-relay-meter.js')
    state.audit.length = 0
    const callbacks = cb()
    await bridge.callClaudeStreaming('What changed?', 'usd-k', callbacks, 'opus', undefined, undefined, undefined, { lightweight: true, keyProfile: profile, turnId: 'turn-usd-1' } as any)
    // The relay settles the child's request before the CLI prints its result.
    const meter = getSharedKeyMeter()
    const r = meter.reserve({ keyRef: key.ref, turnId: 'turn-usd-1', estimateUsd: 0.01 })
    if (!r.ok) throw new Error('reserve refused')
    meter.settle({ reservationId: r.reservationId, usd: 0.0421, tokens: { input: 10, output: 20 } })
    finish(state.children.at(-1))
    await settle()
    const meta = callbacks.onDone.mock.calls[0][3]
    expect(meta.usd).toBe(0.0421)
    expect(meta.keyLane).toMatchObject({ lane: 'key' })
    expect(state.audit.at(-1)).toMatchObject({ profile: 'sonnet-key', lane: 'key', usd: 0.0421 })
    // A subscription answer carries no usd.
    const a = await turn('usd-a', {}, 'opus')
    expect('usd' in a.callbacks.onDone.mock.calls[0][3]).toBe(false)
  })

  it('a steer abort (written steers no result covered) revokes the turn nonce with steer_abort', async () => {
    const { SteerPort } = await import('./claude-steer.js')
    const port = new SteerPort({ onIncluded: vi.fn(), onDelivered: vi.fn(), onFolded: vi.fn(), onCheckpoint: vi.fn() })
    const callbacks = cb()
    await bridge.callClaudeStreaming('Read the README.', 'steer-abort-k', callbacks, 'opus', undefined, undefined, undefined, { lightweight: true, keyProfile: profile, steer: port } as any)
    const child = state.children.at(-1)
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled())
    const handle = relayLog.issued.at(-1)!.handle
    expect(port.offer({ steerId: '22222222-2222-4222-8222-222222222222', text: 'also the tests' })).toBe('written')
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })}\n`))
    await vi.waitFor(() => expect(handle.revoke).toHaveBeenCalledWith('steer_abort'))
    child.emit('close', null)
    await settle()
  })
})
