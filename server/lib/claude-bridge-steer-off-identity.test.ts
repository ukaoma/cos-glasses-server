// 6.78.0 G-off for the Claude bridge: with no steer port (COS_MESSAGES_STEER off, or a run
// that is not steerable), every spawn argument and every stdin byte is the 6.77.0 one. The
// golden file was recorded by running THIS file, unchanged, inside a `git archive` of 6.77.0
// (aa87c9d) with COS_BRIDGE_GOLDEN_OUT set; it imports only what 6.77.0 already had.
//
// node:fs is mocked for the bridge's /tmp/cos-cli-sessions.json only, so importing the bridge
// can neither unlink nor write the live server's file.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ child: null as any, spawnArgs: [] as string[][] }))
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
    pid = 4242
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    spawn: vi.fn((_cmd: string, args: string[]) => {
      state.spawnArgs.push([...args])
      state.child = new FakeChild()
      return state.child
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
  startClaudeRun: () => ({ runId: 'claude-run-identity' }),
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

import { callClaudeStreaming } from './claude-bridge.js'

const GOLDEN = join(import.meta.dirname, '__fixtures__/pi-durable/claude-bridge-off-6.77.0.json')

const SCENARIOS: Array<{ name: string; query: string; model: 'opus' | 'sonnet' | 'haiku'; options: Record<string, unknown> }> = [
  { name: 'plain', query: 'What changed on the page this week?', model: 'opus', options: { lightweight: true } },
  { name: 'ultracode', query: 'Refactor the bridge.', model: 'opus', options: { lightweight: true, effort: 'ultracode' } },
  { name: 'named-session', query: 'Get the live site URL.', model: 'sonnet', options: { lightweight: true, sessionName: 'Live site URL' } },
  { name: 'dispatch', query: 'Summarize the task file.', model: 'sonnet', options: { lightweight: true, dispatch: { restricted: true, tools: ['Read', 'Grep', 'Glob'] } } },
  { name: 'durable-job', query: 'Read the README and push.', model: 'opus', options: { lightweight: true, clientJobId: '0e5a9c1d-1111-4111-8111-000000000001', generation: 2, turnId: 'turn-identity-1', sessionLockHeld: true } },
]

async function record(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  let n = 0
  for (const scenario of SCENARIOS) {
    n++
    state.child = null
    await callClaudeStreaming(scenario.query, `identity-session-${n}`, {
      onChunk: vi.fn(), onDone: vi.fn(async () => {}), onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}),
      onProviderProcess: vi.fn(async () => true),
    } as any, scenario.model, undefined, undefined, undefined, scenario.options as any)
    const child = state.child
    out[scenario.name] = {
      args: state.spawnArgs.at(-1),
      stdinWrites: child.stdin.write.mock.calls.map((call: unknown[]) => call[0]),
      stdinEnds: child.stdin.end.mock.calls.length,
    }
    // Finish the run so its timers stop.
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`))
    child.emit('close', 0)
  }
  return out
}

afterEach(() => { state.child = null })

describe('no steer port: the 6.77.0 spawn (G-off)', () => {
  it('every argument and every stdin byte equals the 6.77.0 recording', async () => {
    const recorded = await record()
    if (process.env.COS_BRIDGE_GOLDEN_OUT) {
      writeFileSync(process.env.COS_BRIDGE_GOLDEN_OUT, `${JSON.stringify({ _source: process.env.COS_BRIDGE_GOLDEN_SOURCE ?? 'unknown', scenarios: recorded }, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(golden._source).toBe('6.77.0 aa87c9d')
    for (const scenario of SCENARIOS) expect(recorded[scenario.name], scenario.name).toEqual(golden.scenarios[scenario.name])
    // A guard the comparison can fail: no steer flag anywhere.
    expect(JSON.stringify(recorded)).not.toMatch(/--input-format|--replay-user-messages|stream-json"?,\s*"--replay/)
  })
})
