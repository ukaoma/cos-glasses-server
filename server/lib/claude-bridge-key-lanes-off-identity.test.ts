// Key lanes K1 P3 G-off for the Claude bridge (plan v4 3.3, 3.4): with no key profile, every
// spawn of the turn path and the pre-warm (argv, cwd, spawn options and the env NAMES the child
// gets beyond or without process.env) equals the b7c620e recording.
//
// The golden was recorded by running THIS file, unchanged, inside a `git archive` of b7c620e
// with COS_BRIDGE_GOLDEN_OUT set. It imports only what b7c620e already had. Fake provider
// credentials are put in process.env first, so the recording also proves that without a profile
// they reach the child untouched (Lane A keeps today's env exactly).
//
// node:fs is mocked for the bridge's /tmp/cos-cli-sessions.json only, so importing the bridge
// can neither unlink nor write the live server's file.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ children: [] as any[], spawns: [] as Array<{ cmd: string; args: string[]; opts: any }> }))
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
    pid = 4343
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
vi.mock('./launch-dir.js', () => ({ resolveProviderWorkDir: () => '/tmp' }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'system'),
  buildLightweightSystemPrompt: vi.fn(() => 'system'),
  buildPrewarmSystemPrompt: vi.fn(() => 'system'),
  getCachedContextInstant: vi.fn(() => ''),
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
  getSessionModel: () => null,
  getSessionRaw: () => ({ contextBreaks: [] }),
  replaceLastExchangeWithSummary: vi.fn(),
}))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./claude-run-ledger.js', () => ({
  finishClaudeRun: vi.fn(),
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-off-identity' }),
  updateClaudeRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({ claudeToolInputPreview: () => undefined, claudeToolResultPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({ terminateProviderProcess: vi.fn(async () => ({ closed: true, code: 0 })) }))
vi.mock('./claude-cli-support.js', () => ({ claudeSupportsSessionName: vi.fn(async () => true) }))

// Fake provider credentials in the server env. Values are fakes; the recording keeps only names
// and whether the child's value equals the server's.
const FAKE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fake-off-identity-0000',
  ANTHROPIC_AUTH_TOKEN: 'fake-auth-token-off-identity',
  ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
  ANTHROPIC_MODEL: 'claude-fake-model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fake-sonnet',
  OPENROUTER_API_KEY: 'sk-or-v1-fake-off-identity',
  OPENAI_API_KEY: 'sk-fake-openai-off-identity',
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-fake-sub',
  COS_API_TOKEN: 'fake-cos-api-token',
  CLAUDECODE: '1',
}
const saved: Record<string, string | undefined> = {}
for (const [k, v] of Object.entries(FAKE_ENV)) { saved[k] = process.env[k]; process.env[k] = v }
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

const { callClaudeStreaming, preWarmCLI, getCliSessionId, getAvailableCliSessionId } = await import('./claude-bridge.js')

const GOLDEN = join(import.meta.dirname, '__fixtures__/key-lanes-p3/claude-bridge-off-b7c620e.json')
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16)

function describeSpawn(spawn: { cmd: string; args: string[]; opts: any }) {
  const env: Record<string, string | undefined> = spawn.opts?.env ?? {}
  const base = process.env
  const added = Object.keys(env).filter(k => !(k in base)).sort()
  const removed = Object.keys(base).filter(k => !(k in env)).sort()
  const changed = Object.keys(env).filter(k => k in base && env[k] !== base[k]).sort()
  // Credential-shaped names: present in the child with the server's value, by hash.
  const credentials = Object.fromEntries(Object.keys(FAKE_ENV).sort().map(k => [k, k in env ? (env[k] === FAKE_ENV[k] ? `same:${hash(FAKE_ENV[k])}` : 'different') : 'absent']))
  const { env: _env, ...rest } = spawn.opts ?? {}
  return { cmd: spawn.cmd, args: spawn.args, opts: rest, envAdded: added, envRemoved: removed, envChanged: changed, credentials }
}

function finish(child: any, result: Record<string, unknown> = { type: 'result', subtype: 'success', result: 'ok' }) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(result)}\n`))
  child.emit('close', 0)
}

const callbacks = () => ({
  onChunk: vi.fn(), onDone: vi.fn(async () => {}), onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}),
  onProviderProcess: vi.fn(async () => true),
}) as any

async function record(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const take = (name: string, from: number) => {
    out[name] = state.spawns.slice(from).map(describeSpawn)
  }

  // 1. Boot pre-warm, which then stands in for the first default-model turn.
  let from = state.spawns.length
  const warm = preWarmCLI()
  finish(state.children.at(-1), { type: 'result', subtype: 'success', result: 'ok', session_id: 'prewarm-session-0001' })
  await warm
  take('prewarm', from)

  // 2. A default-model (sonnet) turn takes the warmed session and starts the next pre-warm.
  from = state.spawns.length
  await callClaudeStreaming('What changed this week?', 'off-identity-1', callbacks(), 'sonnet', undefined, undefined, undefined, { lightweight: true })
  // The next pre-warm spawns inside the turn, before the turn's own child.
  const nextWarmChild = state.children.at(-2)
  const turnChild = state.children.at(-1)
  take('default-takes-prewarm', from)
  finish(nextWarmChild, { type: 'result', subtype: 'success', result: 'ok', session_id: 'prewarm-session-0002' })
  finish(turnChild, { type: 'result', subtype: 'success', result: 'ok', session_id: 'cli-session-0001' })
  await new Promise(r => setTimeout(r, 0))
  out.mappedAfterTurn = { cli: getCliSessionId('off-identity-1') ?? null, available: getAvailableCliSessionId('off-identity-1') ?? null }

  // 3. The same COS session again resumes its own CLI session.
  from = state.spawns.length
  await callClaudeStreaming('And the week before?', 'off-identity-1', callbacks(), 'sonnet', undefined, undefined, undefined, { lightweight: true })
  take('resume', from)
  finish(state.children.at(-1), { type: 'result', subtype: 'success', result: 'ok', session_id: 'cli-session-0001' })

  // 4. Opus, full path, extended effort.
  from = state.spawns.length
  await callClaudeStreaming('Refactor the bridge.', 'off-identity-2', callbacks(), 'opus', undefined, undefined, undefined, { effort: 'max' })
  take('opus-full', from)
  finish(state.children.at(-1))

  // 5. Haiku, durable job with a turn id.
  from = state.spawns.length
  await callClaudeStreaming('Read the README.', 'off-identity-3', callbacks(), 'haiku', undefined, undefined, undefined, {
    lightweight: true, clientJobId: '0e5a9c1d-1111-4111-8111-000000000003', generation: 1, turnId: 'turn-off-identity-3', sessionLockHeld: true,
  })
  take('haiku-durable', from)
  finish(state.children.at(-1))

  // 6. Named session and dispatch.
  from = state.spawns.length
  await callClaudeStreaming('Get the live site URL.', 'off-identity-4', callbacks(), 'sonnet', undefined, undefined, undefined, { lightweight: true, sessionName: 'Live site URL' })
  take('named-session', from)
  finish(state.children.at(-1))
  from = state.spawns.length
  await callClaudeStreaming('Summarize the task file.', 'off-identity-5', callbacks(), 'sonnet', undefined, undefined, undefined, { lightweight: true, dispatch: { restricted: true, tools: ['Read', 'Grep', 'Glob'] } })
  take('dispatch', from)
  finish(state.children.at(-1))
  return out
}

describe('no key profile: the b7c620e Claude spawns (key lanes G-off)', () => {
  it('argv, spawn options and env names of every spawn equal the b7c620e recording', async () => {
    const recorded = await record()
    if (process.env.COS_BRIDGE_GOLDEN_OUT) {
      writeFileSync(process.env.COS_BRIDGE_GOLDEN_OUT, `${JSON.stringify({ _source: process.env.COS_BRIDGE_GOLDEN_SOURCE ?? 'unknown', scenarios: recorded }, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(golden._source).toBe('b7c620e')
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(golden.scenarios).sort())
    for (const name of Object.keys(golden.scenarios)) expect(recorded[name], name).toEqual(golden.scenarios[name])
    // Guards the comparison can fail on its own: no relay, nonce or profile name reached a child,
    // and the server's credential names reached every turn child unchanged.
    const text = JSON.stringify(recorded)
    expect(text).not.toMatch(/COS_KEY_PROFILE|CLAUDE_CODE_MAX_RETRIES|\/relay\/a/)
    for (const name of ['default-takes-prewarm', 'resume', 'opus-full', 'haiku-durable', 'named-session', 'dispatch']) {
      const spawns = recorded[name] as Array<{ credentials: Record<string, string> }>
      expect(spawns[0].credentials.ANTHROPIC_API_KEY, name).toBe(`same:${hash(FAKE_ENV.ANTHROPIC_API_KEY)}`)
      expect(spawns[0].credentials.OPENROUTER_API_KEY, name).toBe(`same:${hash(FAKE_ENV.OPENROUTER_API_KEY)}`)
      expect(spawns[0].credentials.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, name).toBe(`same:${hash('1')}`)
    }
  })
})
