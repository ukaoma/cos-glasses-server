// Key lanes K1 P4 (plan v4 8.1): a keyed (Lane B) Codex turn, at the wire. Scratch HOME (so
// `~/.codex` is a scratch directory), scratch data dir, a fake relay (P2's KeyRelay contract
// only) and a fake spawn that records argv and env. The real profile store, key store,
// generated home and resume store run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  const root = `/tmp/cos-p4-bridge-${process.pid}-${Date.now()}`
  process.env.HOME = `${root}/home`
  process.env.COS_DATA_DIR = `${root}/home/.cos-glasses/data`
  process.env.COS_GLASSES_HOME = `${root}/home/.cos-glasses`
  process.env.COS_CODEX_ENGINE_SESSIONS_FILE = `${root}/engine-sessions.json`
  delete process.env.CODEX_HOME
  return {
    root,
    spawns: [] as Array<{ binary: string; args: string[]; env: Record<string, string | undefined>; child: any }>,
    catalogReads: 0,
    resolveReads: 0,
    exchanges: [] as unknown[],
    audits: [] as Array<Record<string, unknown>>,
    throwSpawn: false,
  }
})

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() })
    pid = 6262
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    ...actual,
    spawn: vi.fn((binary: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      if (state.throwSpawn) throw new TypeError('spawn argv rejected')
      const child = new FakeChild()
      state.spawns.push({ binary, args: [...args], env: { ...options.env }, child })
      return child
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  }
})
vi.mock('./python-bridge.js', () => ({ COS_SCRIPTS_DIR: '/tmp' }))
vi.mock('./launch-dir.js', () => ({ resolveProviderWorkDir: () => '/tmp' }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn((e: Record<string, unknown>) => { state.audits.push(e) }) }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'SYSTEM'),
  buildLightweightSystemPrompt: vi.fn(() => 'SYSTEM'),
}))
vi.mock('./conversation.js', () => ({
  getHistory: () => [],
  addExchange: vi.fn((...a: unknown[]) => { state.exchanges.push(a[6]); return { id: 'exchange' } }),
  setExchangeAttachments: vi.fn(),
  removeExchange: vi.fn(),
  formatHistoryForPrompt: () => '',
  getOrCreateSession: (sid?: string) => sid ?? 'session-test',
  isNewSession: () => false,
  markSessionNotified: vi.fn(),
  getSessionRaw: () => ({ contextBreaks: [] }),
  replaceLastExchangeWithSummary: vi.fn(),
}))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./activity-preview.js', () => ({ codexActivityPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: vi.fn(async (child: any) => { child.emit('close', null, 'SIGTERM'); return { closed: true, escalated: false, code: null, signal: 'SIGTERM' } }),
}))
vi.mock('./provider-binary.js', () => ({
  resolveProviderBinary: () => ({ ok: true, path: '/opt/test/bin/codex', source: 'absolute' }),
}))
vi.mock('./codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => { state.catalogReads += 1; return { options: [] } }),
  resolveCodexModelOption: vi.fn(() => { state.resolveReads += 1; return { id: 'gpt-test', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: ['priority'] } }),
  resolveCodexEffortForModel: () => 'high',
  resolveCodexServiceTier: () => 'priority',
}))
vi.mock('./codex-run-ledger.js', () => ({
  classifyCodexError: () => 'codex.error',
  extractCodexThreadId: (event: any) => (typeof event?.thread_id === 'string' ? event.thread_id : undefined),
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp/cos-p4-cwd',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-test' }),
  updateCodexRun: vi.fn(),
}))

import { callCodexStreaming, runCodexKeyProfileTurn } from './codex-bridge.js'
import {
  CODEX_LANE_B_COPY,
  isCodexLaneBStrippedName,
  registerCodexKeyRelay,
  registerCodexKeyedThreadRecorder,
  __resetCodexProfileSeamsForTests,
} from './codex-profile-home.js'
import { codexProfileHome } from './codex-homes.js'
import { __resetKeyLanesForTests } from './key-lanes.js'
import type { KeyProfile, KeyRelay, RelayNonceBinding, RelayRevokeReason } from './key-relay-contract.js'

const HOME = join(state.root, 'home')
const USER_CODEX = join(HOME, '.codex')
const DATA = process.env.COS_DATA_DIR!
const FAKE_KEY = 'sk-or-v1-p4-bridge-fake-0000'
const NONCE = 'nonce-p4-fake-abcdefghijklmnop'
const THREAD = '019f3333-4444-5555-6666-777777777777'

function profile(over: Partial<KeyProfile> = {}): KeyProfile {
  return {
    id: 'gpt-key', label: 'GPT key', keyRef: 'key_0123456789ab', engine: 'codex', model: 'openai/gpt-5.3-codex',
    enabled: true, timeoutTier: 'sonnet', offerOnV1: false, directTools: false,
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', ...over,
  }
}

interface FakeRelay extends KeyRelay {
  issued: RelayNonceBinding[]
  closed: number
  revoked: RelayRevokeReason[]
  fail: boolean
}
function fakeRelay(): FakeRelay {
  const relay: FakeRelay = {
    issued: [], closed: 0, revoked: [], fail: false,
    async issueTurn(binding) {
      if (relay.fail) throw new Error('relay refused')
      relay.issued.push(binding)
      return { nonce: NONCE, origin: 'http://127.0.0.1:47123', childClosed: () => { relay.closed += 1 }, revoke: r => { relay.revoked.push(r) } }
    },
    revokeTurn: () => {},
    revokeAll: () => {},
    port: () => 47123,
    close: async () => {},
  }
  return relay
}

function seedUserCodex(): void {
  mkdirSync(USER_CODEX, { recursive: true })
  writeFileSync(join(USER_CODEX, 'config.toml'), 'model = "gpt-6.1-sol"\n\n[mcp_servers.paste]\ncommand = "paste-mcp"\n\n[projects."/tmp/cos-p4-cwd"]\ntrust_level = "trusted"\n')
  writeFileSync(join(USER_CODEX, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"chatgpt-fake"}}')
  writeFileSync(join(USER_CODEX, 'hooks.json'), '{"hooks":{}}\n')
}

function seedKeyAndProfiles(profiles: KeyProfile[] = [profile()]): void {
  mkdirSync(DATA, { recursive: true, mode: 0o700 })
  writeFileSync(join(DATA, 'provider-keys.json'), JSON.stringify({ v: 1, keys: [{ ref: 'key_0123456789ab', kind: 'openrouter', secret: FAKE_KEY, last4: '0000', capUsd: 1, savedAt: '2026-10-19T00:00:00.000Z' }] }), { mode: 0o600 })
  writeFileSync(join(DATA, 'provider-profiles.json'), JSON.stringify({ v: 1, profiles }), { mode: 0o600 })
}

function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[p.slice(dir.length)] = createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + (statSync(p).mode & 0o777).toString(8)
    }
  }
  walk(dir)
  return out
}

function cbs() {
  return { onChunk: vi.fn(), onDone: vi.fn(async () => {}), onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}), onStart: vi.fn() } as any
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function complete(rec: { child: any }, threadId?: string): void {
  const lines = [
    ...(threadId ? [JSON.stringify({ type: 'thread.started', thread_id: threadId })] : []),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ]
  rec.child.stdout.emit('data', Buffer.from(lines.join('\n')))
  rec.child.emit('close', 0, null)
}

const keyedRun = (p: KeyProfile = profile(), cb = cbs(), extra: Record<string, unknown> = {}) =>
  callCodexStreaming('what is on my calendar', 'session-p4', cb, 'codex-frontier', undefined, undefined, undefined, { lightweight: true, keyProfile: p, ...extra } as any)
const plainRun = (cb = cbs()) =>
  callCodexStreaming('what is on my calendar', 'session-p4', cb, 'codex-frontier', undefined, undefined, undefined, { lightweight: true } as any)

let relay: FakeRelay
beforeEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  seedUserCodex()
  seedKeyAndProfiles()
  state.spawns = []
  state.catalogReads = 0
  state.resolveReads = 0
  state.exchanges = []
  state.audits = []
  state.throwSpawn = false
  process.env.COS_KEY_LANES = '1'
  process.env.COS_CODEX_EXTRA_ARGS = '-c service_tier="flex" --model gpt-extra'
  process.env.OPENAI_API_KEY = 'sk-p4-inherited-fake'
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-p4-inherited-fake'
  process.env.COS_API_TOKEN ??= 'cos-p4-token'
  __resetKeyLanesForTests()
  __resetCodexProfileSeamsForTests()
  relay = fakeRelay()
  registerCodexKeyRelay(() => relay)
})
afterEach(async () => {
  for (const rec of state.spawns) rec.child.emit('close', 0, null)
  await flush()
  for (const k of ['COS_KEY_LANES', 'COS_CODEX_EXTRA_ARGS', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k]
  __resetKeyLanesForTests()
  __resetCodexProfileSeamsForTests()
})

describe('Lane B Codex turn', () => {
  it('leaves ~/.codex (config.toml, auth.json, hooks.json) byte-identical and process.env untouched', async () => {
    const before = treeHash(USER_CODEX)
    expect(Object.keys(before).sort()).toEqual(['/auth.json', '/config.toml', '/hooks.json'])
    const envBefore = JSON.stringify(Object.entries(process.env).sort())
    await keyedRun()
    const rec = state.spawns.at(-1)!
    complete(rec, THREAD)
    await flush()
    expect(treeHash(USER_CODEX)).toEqual(before)
    expect(JSON.stringify(Object.entries(process.env).sort())).toBe(envBefore)
    // The child ran in the profile home, never ~/.codex, and that home holds no login.
    expect(rec.env.CODEX_HOME).toBe(codexProfileHome('gpt-key'))
    expect(existsSync(join(codexProfileHome('gpt-key'), 'auth.json'))).toBe(false)
    const config = readFileSync(join(codexProfileHome('gpt-key'), 'config.toml'), 'utf8')
    expect(config).toContain('base_url = "http://127.0.0.1:47123/relay/o/v1"')
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('[mcp_servers.paste]')
    expect(config).not.toContain('chatgpt-fake')
  })

  it('passes an explicit --model slug and the relay provider, never COS_CODEX_EXTRA_ARGS or the ChatGPT catalog', async () => {
    await keyedRun()
    const rec = state.spawns.at(-1)!
    expect(rec.args).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      '-c', 'model_provider="cos-relay"',
      '--json', '--cd', '/tmp/cos-p4-cwd', '--model', 'openai/gpt-5.3-codex', '-',
    ])
    expect(rec.args.join(' ')).not.toContain('gpt-extra')
    expect(rec.args.join(' ')).not.toContain('service_tier')
    expect(rec.args.join(' ')).not.toContain('model_reasoning_effort')
    expect(state.catalogReads).toBe(0)
    expect(state.resolveReads).toBe(0)
  })

  it('gives the child the nonce, never the key, and differs from Lane A by exactly the documented names', async () => {
    await plainRun()
    const a = state.spawns.at(-1)!
    a.child.emit('close', 0, null)
    await keyedRun()
    const b = state.spawns.at(-1)!
    expect(b.env.COS_RELAY_TOKEN).toBe(NONCE)
    expect(b.env.COS_KEY_PROFILE).toBe('gpt-key')
    expect(Object.values(b.env).some(v => typeof v === 'string' && v.includes(FAKE_KEY))).toBe(false)
    const namesA = new Set(Object.keys(a.env)), namesB = new Set(Object.keys(b.env))
    expect([...namesB].filter(n => !namesA.has(n)).sort()).toEqual(['CODEX_HOME', 'COS_KEY_PROFILE', 'COS_RELAY_TOKEN'])
    // Exactly the provider-credential names this process happened to carry (the seeded two, plus
    // whatever the runner's own env holds), and nothing else.
    const removed = [...namesA].filter(n => !namesB.has(n)).sort()
    expect(removed).toEqual([...namesA].filter(isCodexLaneBStrippedName).sort())
    expect(removed).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'OPENROUTER_API_KEY']))
    expect(removed).not.toContain('COS_API_TOKEN')
    expect(removed).not.toContain('PATH')
    expect(relay.issued).toEqual([expect.objectContaining({ keyRef: 'key_0123456789ab', profileId: 'gpt-key', sessionId: 'session-p4', engine: 'codex', allowedModel: 'openai/gpt-5.3-codex' })])
  })

  it('stamps exchanges and the token audit with the profile, and records the keyed thread', async () => {
    const recorded: unknown[] = []
    registerCodexKeyedThreadRecorder(t => recorded.push(t))
    await keyedRun()
    complete(state.spawns.at(-1)!, THREAD)
    await flush()
    expect(state.exchanges).toEqual(['profile:gpt-key', 'profile:gpt-key'])
    expect(state.audits.at(-1)).toMatchObject({ profile: 'gpt-key', lane: 'key', credentialKind: 'openrouter' })
    expect(recorded).toEqual([{ id: THREAD, engine: 'codex', profileId: 'gpt-key', cosSessionId: 'session-p4' }])
    expect(relay.closed).toBe(1)
  })

  it('binds resume to the profile: same profile resumes, Lane A and another profile never do', async () => {
    seedKeyAndProfiles([profile(), profile({ id: 'gpt-key-2', label: 'GPT two' })])
    await keyedRun()
    complete(state.spawns.at(-1)!, THREAD)
    await flush()

    await plainRun()
    const laneA = state.spawns.at(-1)!
    expect(laneA.args).not.toContain('resume')
    expect(laneA.args).not.toContain(THREAD)
    laneA.child.emit('close', 0, null)
    await flush()

    await keyedRun(profile({ id: 'gpt-key-2', label: 'GPT two' }))
    const other = state.spawns.at(-1)!
    expect(other.args).not.toContain(THREAD)
    other.child.emit('close', 0, null)
    await flush()

    await keyedRun()
    const again = state.spawns.at(-1)!
    expect(again.args.slice(0, 13)).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_provider="cos-relay"',
      'resume', '--json', '--all', '--model', 'openai/gpt-5.3-codex', THREAD, '-',
    ])
  })

  it('runs through the engine-seam adapter with the turn profile', async () => {
    await runCodexKeyProfileTurn('hi', 'session-p4', cbs(), { profile: profile() }, undefined, undefined, undefined, { lightweight: true } as any)
    expect(state.spawns.at(-1)!.env.COS_KEY_PROFILE).toBe('gpt-key')
  })

  it('revokes the nonce when spawn throws synchronously', async () => {
    state.throwSpawn = true
    await expect(keyedRun()).rejects.toThrow('spawn argv rejected')
    expect(relay.revoked).toEqual(['cancel'])
  })

  it('revokes the nonce on cancel', async () => {
    const ac = new AbortController()
    await keyedRun(profile(), cbs(), { abortSignal: ac.signal })
    ac.abort()
    await flush()
    expect(relay.revoked).toContain('cancel')
  })
})

describe('Lane B Codex refusals spawn nothing and never fall back to the subscription', () => {
  it('refuses with key lanes off', async () => {
    delete process.env.COS_KEY_LANES
    __resetKeyLanesForTests()
    const cb = cbs()
    await keyedRun(profile(), cb)
    expect(cb.onError).toHaveBeenCalledWith(CODEX_LANE_B_COPY.lanesOff)
    expect(state.spawns).toEqual([])
    expect(existsSync(join(DATA, 'codex-homes'))).toBe(false)
    expect(state.catalogReads).toBe(0)
  })

  it('refuses with no relay registered', async () => {
    __resetCodexProfileSeamsForTests()
    const cb = cbs()
    await keyedRun(profile(), cb)
    expect(cb.onError).toHaveBeenCalledWith(CODEX_LANE_B_COPY.relayUnavailable)
    expect(state.spawns).toEqual([])
  })

  it('refuses when the relay cannot issue, before writing the home or spawning', async () => {
    relay.fail = true
    const cb = cbs()
    await keyedRun(profile(), cb)
    expect(cb.onError).toHaveBeenCalledWith(CODEX_LANE_B_COPY.relayUnavailable)
    expect(state.spawns).toEqual([])
    expect(existsSync(join(codexProfileHome('gpt-key'), 'config.toml'))).toBe(false)
  })

  it('refuses a scheduled dispatch', async () => {
    const cb = cbs()
    await keyedRun(profile(), cb, { dispatch: { restricted: true, tools: [] } })
    expect(cb.onError).toHaveBeenCalledWith(CODEX_LANE_B_COPY.scheduled)
    expect(state.spawns).toEqual([])
  })
})

describe('Lane B Codex: P11 wiring (answer fields, cost, one resume slot per lane)', () => {
  const PLAIN_THREAD = '019f8888-9999-aaaa-bbbb-cccccccccccc'

  it('a keyed answer carries lane, credential and the settled usd; a subscription answer none of them', async () => {
    const { getSharedKeyMeter } = await import('./key-relay-meter.js')
    const cb = cbs()
    await keyedRun(profile(), cb, { turnId: 'turn-codex-usd' })
    const meter = getSharedKeyMeter()
    const r = meter.reserve({ keyRef: profile().keyRef, turnId: 'turn-codex-usd', estimateUsd: 0.01 })
    if (!r.ok) throw new Error('reserve refused')
    meter.settle({ reservationId: r.reservationId, usd: 0.0077, tokens: { input: 5, output: 5 } })
    complete(state.spawns.at(-1)!, THREAD)
    await flush()
    const meta = cb.onDone.mock.calls[0][3]
    expect(meta.keyLane).toEqual({ lane: 'key', credential: { kind: 'openrouter', ref: profile().keyRef, profileId: 'gpt-key' } })
    expect(meta.usd).toBe(0.0077)
    expect(state.audits.at(-1)).toMatchObject({ lane: 'key', usd: 0.0077 })
    const plain = cbs()
    await plainRun(plain)
    complete(state.spawns.at(-1)!, PLAIN_THREAD)
    await flush()
    const plainMeta = plain.onDone.mock.calls[0][3]
    expect('keyLane' in plainMeta).toBe(false)
    expect('usd' in plainMeta).toBe(false)
  })

  it('a keyed turn never overwrites the subscription resume of the same session (and back)', async () => {
    await plainRun()
    complete(state.spawns.at(-1)!, PLAIN_THREAD)
    await flush()
    await keyedRun()
    complete(state.spawns.at(-1)!, THREAD)
    await flush()
    await plainRun()
    const back = state.spawns.at(-1)!
    expect(back.args).toContain(PLAIN_THREAD)
    expect(back.args).not.toContain(THREAD)
    back.child.emit('close', 0, null)
    await flush()
    await keyedRun()
    expect(state.spawns.at(-1)!.args).toContain(THREAD)
  })
})

describe('Lane B Codex: the resume fingerprint still binds the generated config (P11)', () => {
  // With one slot per profile (P11), the profile home's fingerprint is what stops a thread from
  // resuming under a changed config of the SAME profile (another model or relay provider).
  it('a profile whose model changed does not resume the thread its old config started', async () => {
    await keyedRun()
    complete(state.spawns.at(-1)!, THREAD)
    await flush()
    await keyedRun(profile({ model: 'openai/gpt-5.5' }))
    const changed = state.spawns.at(-1)!
    expect(changed.args).not.toContain(THREAD)
    expect(changed.args).not.toContain('resume')
  })
})
