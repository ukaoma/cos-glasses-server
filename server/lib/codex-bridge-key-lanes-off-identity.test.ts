// Key lanes K1 P4 (plan v4 3.1, 3.4, 8.1): with no key profile on the turn, the Codex spawn is
// byte-identical to 963fe25. Argv and the env NAMES the child gets (added to and removed from
// this process's env) are recorded in a fixture taken from 963fe25 itself (COS_P4_RECORD=1 on
// the unmodified tree), then replayed here three ways: key lanes unset, COS_KEY_LANES=0, and
// COS_KEY_LANES=1 with an enabled Codex profile saved on disk but not chosen for the turn.
// A difference in any of the three fails, so a profile branch that leaks into a subscription
// turn (an extra -c, a CODEX_HOME, a skipped catalog read) cannot pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const state = vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-p4-off-identity-${process.pid}-${Date.now()}`
  return {
    spawns: [] as Array<{ binary: string; args: string[]; env: Record<string, string | undefined>; child: any }>,
    codexEngine: null as null | { codexThreadId: string; expiresAt: string },
    catalogReads: 0,
    publisher: false,
  }
})

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() })
    pid = 5151
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    spawn: vi.fn((binary: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      const child = new FakeChild()
      state.spawns.push({ binary, args: [...args], env: { ...options.env }, child })
      return child
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: '--add-dir', stderr: '' })),
  }
})
vi.mock('./python-bridge.js', () => ({ COS_SCRIPTS_DIR: '/tmp' }))
vi.mock('./launch-dir.js', () => ({ resolveProviderWorkDir: () => '/tmp' }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'SYSTEM'),
  buildLightweightSystemPrompt: vi.fn(() => 'SYSTEM'),
}))
vi.mock('./conversation.js', () => ({
  getHistory: () => [],
  addExchange: () => ({ id: 'exchange' }),
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
  createRunOutputImagePublisher: vi.fn(() => {
    if (!state.publisher) throw new Error('publisher off in this scenario')
    return {
      writableDirectory: '/tmp/cos-p4-publisher',
      env: { COS_RUN_OUTPUT_DIR: '/tmp/cos-p4-publisher', COS_RUN_OUTPUT_TOKEN: 'publisher-token' },
      promptInstructions: 'PUBLISH',
      cleanup: vi.fn(),
      stats: { published: 0, attached: 0, rejected: 0 },
    }
  }),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: vi.fn(async () => ({ closed: true, escalated: false, code: null, signal: 'SIGTERM' })),
}))
vi.mock('./provider-binary.js', () => ({
  resolveProviderBinary: () => ({ ok: true, path: '/opt/test/bin/codex', source: 'absolute' }),
}))
vi.mock('./codex-engine-sessions.js', () => ({
  getCodexEngineSession: () => state.codexEngine,
  saveCodexEngineSession: () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  clearCodexEngineSession: () => 1,
}))
vi.mock('./codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => { state.catalogReads += 1; return { options: [] } }),
  resolveCodexModelOption: () => ({ id: 'gpt-test', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: ['priority'] }),
  resolveCodexEffortForModel: () => 'high',
  resolveCodexServiceTier: () => 'priority',
}))
vi.mock('./codex-run-ledger.js', () => ({
  classifyCodexError: () => 'codex.error',
  extractCodexThreadId: () => undefined,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp/cos-p4-cwd',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-test' }),
  updateCodexRun: vi.fn(),
}))

import { callCodexStreaming } from './codex-bridge.js'
import { __resetKeyLanesForTests } from './key-lanes.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'key-lanes-p4', 'codex-off-963fe25.json')
const RECORD = process.env.COS_P4_RECORD === '1'
const DATA = process.env.COS_DATA_DIR!

/** Names this test puts in process.env so the add/remove sets are not empty by luck. */
const SEEDED_ENV: Record<string, string> = {
  CLAUDECODE: '1',
  ANTHROPIC_API_KEY: 'sk-ant-p4-fake',
  OPENAI_API_KEY: 'sk-p4-fake',
  OPENROUTER_API_KEY: 'sk-or-v1-p4-fake',
  COS_API_TOKEN: 'cos-p4-token',
}

interface Scenario {
  name: string
  env?: Record<string, string>
  engine?: boolean
  publisher?: boolean
  options?: Record<string, unknown>
}

const SCENARIOS: Scenario[] = [
  { name: 'fresh-lightweight', options: { lightweight: true } },
  { name: 'fresh-full-publisher', publisher: true, options: {} },
  { name: 'resume', engine: true, options: { lightweight: true } },
  { name: 'extra-args', env: { COS_CODEX_EXTRA_ARGS: '-c service_tier="flex" --model gpt-extra' }, options: { lightweight: true } },
  { name: 'workspace-write', env: { COS_CODEX_SANDBOX: 'workspace-write' }, options: { lightweight: true, effort: 'low' } },
]

type Record_ = { argv: string[]; binary: string; added: string[]; removed: string[]; catalogReads: number }

async function runScenario(s: Scenario): Promise<Record_> {
  state.spawns = []
  state.catalogReads = 0
  state.publisher = s.publisher === true
  state.codexEngine = s.engine ? { codexThreadId: '0199a000-0000-7000-8000-000000000001', expiresAt: new Date(Date.now() + 60_000).toISOString() } : null
  const saved: Record<string, string | undefined> = {}
  const set = { ...SEEDED_ENV, ...(s.env ?? {}) }
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v }
  const before = new Set(Object.keys(process.env))
  try {
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(async () => {}), onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}) } as any
    await callCodexStreaming('what is on my calendar', 'session-p4', callbacks, 'codex-frontier', undefined, undefined, undefined, s.options as any)
    expect(callbacks.onError).not.toHaveBeenCalled()
    const rec = state.spawns.at(-1)!
    expect(rec, `${s.name} spawned`).toBeTruthy()
    const childNames = new Set(Object.keys(rec.env).filter(k => rec.env[k] !== undefined))
    const out = {
      argv: rec.args,
      binary: rec.binary,
      added: [...childNames].filter(k => !before.has(k)).sort(),
      removed: [...before].filter(k => !childNames.has(k)).sort(),
      catalogReads: state.catalogReads,
    }
    rec.child.emit('close', 0, null)
    return out
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

function writeEnabledCodexProfile(): void {
  mkdirSync(DATA, { recursive: true, mode: 0o700 })
  mkdirSync(join(DATA, 'key-secrets'), { recursive: true }); writeFileSync(join(DATA, 'key-secrets', 'provider-keys.json'), JSON.stringify({ v: 1, keys: [{ ref: 'key_0123456789ab', kind: 'openrouter', secret: 'sk-or-v1-p4-off-identity-fake', last4: 'fake', capUsd: 1, savedAt: '2026-10-19T00:00:00.000Z' }] }), { mode: 0o600 })
  writeFileSync(join(DATA, 'provider-profiles.json'), JSON.stringify({ v: 1, profiles: [{ id: 'gpt-key', label: 'GPT key', keyRef: 'key_0123456789ab', engine: 'codex', model: 'openai/gpt-5.3-codex', enabled: true, timeoutTier: 'sonnet', offerOnV1: false, directTools: false, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' }] }), { mode: 0o600 })
}

const savedLanes = process.env.COS_KEY_LANES
beforeEach(() => {
  rmSync(join(DATA, 'provider-profiles.json'), { force: true })
  rmSync(join(DATA, 'key-secrets'), { recursive: true, force: true })
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests()
})
afterEach(() => {
  if (savedLanes === undefined) delete process.env.COS_KEY_LANES
  else process.env.COS_KEY_LANES = savedLanes
  __resetKeyLanesForTests()
})

describe('Codex bridge with no key profile is byte-identical to 963fe25', () => {
  it('matches the 963fe25 argv and env-name fixture with key lanes unset', async () => {
    const got: Record<string, Record_> = {}
    for (const s of SCENARIOS) got[s.name] = await runScenario(s)
    if (RECORD) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, JSON.stringify({ base: '963fe25', note: 'Recorded on the unmodified 963fe25 tree with COS_P4_RECORD=1.', scenarios: got }, null, 2) + '\n')
    }
    expect(existsSync(FIXTURE), 'fixture recorded from 963fe25').toBe(true)
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    expect(golden.base).toBe('963fe25')
    expect(got).toEqual(golden.scenarios)
  })

  it('stays identical with COS_KEY_LANES=0 and a profile on disk', async () => {
    writeEnabledCodexProfile()
    process.env.COS_KEY_LANES = '0'
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')).scenarios
    for (const s of SCENARIOS) expect(await runScenario(s), s.name).toEqual(golden[s.name])
  })

  it('stays identical with key lanes ON and an enabled Codex profile that the turn did not pick', async () => {
    writeEnabledCodexProfile()
    process.env.COS_KEY_LANES = '1'
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')).scenarios
    for (const s of SCENARIOS) expect(await runScenario(s), s.name).toEqual(golden[s.name])
    // Nothing was generated for the unpicked profile.
    expect(existsSync(join(DATA, 'codex-homes'))).toBe(false)
  })
})
