// Key lanes K1, canary rerun item 1 (evidence, not a fix): a Claude CLI that emits TWO `result`
// events in one run (background subagents finishing after the first answer). What does the bridge
// hand back as the answer, on the plan lane, in normal and in steer (stream-json input) mode? The
// same file runs unchanged on a0035a8 (6.79.1, no key-lane code) to show the behaviour predates
// key lanes; the keyed case is in claude-bridge-key-lanes.test.ts. FakeChild, no CLI, no spawn.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ child: null as any, spawnArgs: [] as string[][], terminate: null as any }))
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
vi.mock('./provider-process-lifecycle.js', () => {
  state.terminate = vi.fn(async () => ({ closed: true, code: null }))
  return { terminateProviderProcess: (...args: unknown[]) => state.terminate(...args) }
})
vi.mock('./claude-cli-support.js', () => ({ claudeSupportsSessionName: vi.fn(async () => true) }))

import { callClaudeStreaming } from './claude-bridge.js'
import { SteerPort } from './claude-steer.js'

function callbacks() {
  return {
    onChunk: vi.fn(), onDone: vi.fn(async () => true), onError: vi.fn(async () => true),
    onAnswerReady: vi.fn(async () => true), onProviderProcess: vi.fn(async () => true), onToolStatus: vi.fn(),
  } as any
}
const text = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
const result = (r: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: 'cli-two-results', ...extra })
function emit(child: any, ...lines: unknown[]) { child.stdout.emit('data', Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n')) }

let n = 0
async function twoResults(steer: boolean) {
  const cb = callbacks()
  n++
  await callClaudeStreaming('Run twelve background subagents.', `two-results-${n}`, cb, 'haiku', undefined, undefined, undefined, { lightweight: true, ...(steer ? { steer: new SteerPort() } : {}) } as any)
  await vi.waitFor(() => expect(state.child.stdin.write).toHaveBeenCalled())
  const child = state.child
  const first = steer ? JSON.parse(child.stdin.write.mock.calls[0][0]).uuid as string : ''
  emit(child, text('Eight of the 12 have reported.'), result('Eight of the 12 have reported.', steer ? { user_message_uuids: [first] } : {}))
  await new Promise(r => setTimeout(r, 30))
  emit(child, text(' All 12 reported: FULL ANSWER.'), result('All 12 reported: FULL ANSWER.', steer ? { user_message_uuids: [first] } : {}))
  child.emit('close', 0)
  await new Promise(r => setTimeout(r, 30))
  return { ready: cb.onAnswerReady.mock.calls.map((c: unknown[]) => c[0]), done: cb.onDone.mock.calls.map((c: unknown[]) => c[0]), errors: cb.onError.mock.calls.length }
}

describe('a CLI run with two results (background subagents): the plan lane today', () => {
  it('normal mode answers with the FIRST result; the later full answer never reaches the caller', async () => {
    const r = await twoResults(false)
    expect(r.done).toEqual(['Eight of the 12 have reported.'])
    expect(r.done.join(' ')).not.toContain('FULL ANSWER')
  })

  it('steer (stream-json input) mode does the same', async () => {
    const r = await twoResults(true)
    expect(r.done).toHaveLength(1)
    expect(r.done[0]).toContain('Eight of the 12 have reported.')
    expect(r.done[0]).not.toContain('FULL ANSWER')
  })
})
