// 6.83.0: the Claude bridge hands each `rate_limit_event` frame of a plan-lane job to the Work orchestrator's usage
// monitor (canary C1: a free passive refresh the bridge used to drop), by execution against a fake child.
import { beforeEach, expect, it, vi } from 'vitest'
import { CLAUDE_RUN } from './__fixtures__/job-trail-runs.js'

const state = vi.hoisted(() => ({
  frames: [] as unknown[],
  child: null as any,
  spawn: null as any,
  history: [] as unknown[][],
  terminateProviderProcess: null as any,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { vi: vitest } = await import('vitest')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vitest.fn(), end: vitest.fn() })
    pid = 2468
    exitCode = null
    signalCode = null
    kill = vitest.fn()
  }
  state.spawn = vitest.fn(() => {
    state.child = new FakeChild()
    return state.child
  })
  return { spawn: state.spawn }
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
  addExchange: (...args: unknown[]) => { state.history.push(['addExchange', ...args]); return { id: `exchange-${state.history.length}` } },
  setExchangeAttachments: (...args: unknown[]) => { state.history.push(['setExchangeAttachments', ...args]) },
  removeExchange: (...args: unknown[]) => { state.history.push(['removeExchange', ...args]) },
  formatHistoryForPrompt: () => '',
  getOrCreateSession: (sid?: string) => sid ?? 'session-test',
  isNewSession: () => false,
  markSessionNotified: vi.fn(),
  getSessionModel: () => null,
  getSessionRaw: () => ({ contextBreaks: [] }),
  replaceLastExchangeWithSummary: (...args: unknown[]) => { state.history.push(['replaceLastExchangeWithSummary', ...args]) },
}))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./claude-run-ledger.js', () => ({
  finishClaudeRun: vi.fn(),
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-test' }),
  updateClaudeRun: vi.fn(),
}))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: (...args: unknown[]) => state.terminateProviderProcess(...args),
}))

vi.mock('./work-orchestrator/usage-events.js', () => ({ noteClaudeRateLimitFrame: (frame: unknown) => { state.frames.push(frame) } }))

import { callClaudeStreaming } from './claude-bridge.js'

beforeEach(() => {
  state.frames = []
  state.history = []
  state.terminateProviderProcess = vi.fn(async () => ({ closed: true, escalated: false, code: null, signal: 'SIGTERM' }))
})

it('passes each rate_limit_event frame of a plan-lane run to the usage monitor, and nothing else', async () => {
  const done = vi.fn(async () => true)
  const callbacks = { onStart() {}, onChunk() {}, onToolStatus() {}, onActivityLine() {}, onProviderProcess: async () => true, onAnswerReady: async () => true, onDone: done, onError: async () => {} }
  await callClaudeStreaming('what port?', 'session-test', callbacks as any, 'opus', undefined, undefined, undefined, { lightweight: true, clientJobId: 'job-1', generation: 1 })
  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793101874, rateLimitType: 'seven_day' } }
  for (const line of [...CLAUDE_RUN, rejected]) state.child.stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`))
  state.child.stdout.emit('end'); state.child.emit('close', 0)
  await vi.waitFor(() => expect(done).toHaveBeenCalled())
  expect(state.frames).toEqual([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, rejected])
})
