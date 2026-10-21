import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  finishClaudeRun: vi.fn(),
  terminateProviderProcess: vi.fn(),
  resolveTermination: null as null | ((value: any) => void),
  updateClaudeRun: vi.fn(),
  spawnArgs: [] as string[][],
  nameSupported: true,
  audit: [] as Array<Record<string, unknown>>,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
    pid = 2468
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
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn((entry: Record<string, unknown>) => { state.audit.push(entry) }) }))
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
  finishClaudeRun: state.finishClaudeRun,
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-test' }),
  updateClaudeRun: state.updateClaudeRun,
}))
vi.mock('./activity-preview.js', () => ({
  claudeToolInputPreview: () => undefined,
  claudeToolResultPreviewLines: () => [],
}))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: state.terminateProviderProcess,
}))
vi.mock('./claude-cli-support.js', () => ({
  claudeSupportsSessionName: vi.fn(async () => state.nameSupported),
}))

import { callClaudeStreaming } from './claude-bridge.js'

// 6.82.0: a routine's run is counted in the token audit under the routine that started it. The
// durable runtime hands the bridge `auditCaller` (query-job-runtime.ts, routineAuditCaller); without
// it every caller is exactly what it was.

const SID = '8f7a53b9-b478-4d88-88e4-4a915b256da5'

async function finished(options: Record<string, unknown>) {
  const onDone = vi.fn(async () => {})
  await callClaudeStreaming('run the skill', `audit-${Math.random()}`, { onChunk: vi.fn(), onDone, onError: vi.fn(async () => {}), onAnswerReady: vi.fn(async () => {}) } as any, 'sonnet', undefined, undefined, undefined, options as any)
  state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SID }) + '\n'))
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  return state.audit.at(-1)!
}

afterEach(() => { state.child = null; state.spawnArgs.length = 0; state.audit.length = 0 })

describe('6.82.0: the token-audit caller of a routine run', () => {
  it('a routine run is logged as routine:<id>, with the model it ran on', async () => {
    const row = await finished({ lightweight: true, auditCaller: 'routine:routine-0123456789' })
    expect(row).toMatchObject({ caller: 'routine:routine-0123456789', model: 'sonnet' })
  })
  it('every other run keeps its caller', async () => {
    expect((await finished({ lightweight: true })).caller).toBe('voice_query')
    expect((await finished({ lightweight: false })).caller).toBe('full_query')
  })
})
