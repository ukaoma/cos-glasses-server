// 7.0.57: the Cursor bridge's inactivity timer (job 59a4413f, 2026-11-18). An open tool call, a sub-agent included, counts
// as activity, with the 900 s wall timer as the only ceiling; a kill gives the thread a plain reason. The fake child and
// mocks are copied from job-trail-codex-cursor-bridges.test.ts; time is fake and every input is bounded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  spawn: null as any,
  history: [] as unknown[][],
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { vi: vitest } = await import('vitest')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vitest.fn(), end: vitest.fn() })
    pid = 4321
    exitCode = null
    signalCode = null
    kill = vitest.fn()
  }
  state.spawn = vitest.fn(() => {
    state.child = new FakeChild()
    return state.child
  })
  return {
    spawn: state.spawn,
    spawnSync: vitest.fn(() => ({ status: 0, stdout: '--add-dir', stderr: '' })),
  }
})
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'system'),
  buildLightweightSystemPrompt: vi.fn(() => 'system'),
}))
vi.mock('./conversation.js', () => {
  const log = (name: string) => (...args: unknown[]) => { state.history.push([name, ...args]); return { id: `exchange-${state.history.length}` } }
  return {
    getHistory: () => [],
    addExchange: log('addExchange'),
    reconcileExchangeByJobIdentity: (...args: unknown[]) => ({ exchange: log('reconcileExchangeByJobIdentity')(...args), created: true }),
    setExchangeAttachments: log('setExchangeAttachments'),
    removeExchange: log('removeExchange'),
    formatHistoryForPrompt: () => '',
    getOrCreateSession: (sid?: string) => sid ?? 'session-test',
    isNewSession: () => false,
    markSessionNotified: vi.fn(),
    getSessionRaw: () => ({ contextBreaks: [] }),
    replaceLastExchangeWithSummary: log('replaceLastExchangeWithSummary'),
  }
})
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./codex-engine-sessions.js', () => ({
  getCodexEngineSession: () => null,
  saveCodexEngineSession: () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  clearCodexEngineSession: () => 1,
}))
vi.mock('./codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveCodexModelOption: () => ({ id: 'gpt-test', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: [] }),
  resolveCodexEffortForModel: () => 'high',
  resolveCodexServiceTier: () => undefined,
}))
vi.mock('./codex-run-ledger.js', () => ({
  codexTerminalUsageLimitError: () => undefined,
  safeCodexUsageLimitMessage: (message: string) => message,
  classifyCodexError: () => 'codex.error',
  extractCodexThreadId: () => undefined,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp',
  isCodexPersistenceEnabled: () => false,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-test' }),
  updateCodexRun: vi.fn(),
}))
vi.mock('./cursor-engine-sessions.js', () => ({
  getCursorEngineSession: () => null,
  saveCursorEngineSession: () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  clearCursorEngineSession: () => 1,
}))
vi.mock('./cursor-model-catalog.js', () => ({
  getCursorModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveAgentBinary: () => '/usr/local/bin/agent',
  resolveCursorModelOption: () => ({ id: 'composer-test' }),
}))
vi.mock('./cursor-run-ledger.js', () => ({
  classifyCursorError: () => 'cursor.error',
  finishCursorRun: vi.fn(),
  getCursorExecutionCwd: () => '/tmp',
  isCursorPersistenceEnabled: () => false,
  startCursorRun: () => ({ runId: 'cursor-run-test' }),
  updateCursorRun: vi.fn(),
}))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: vi.fn(async () => ({ closed: true, escalated: false, code: null, signal: 'SIGTERM' })),
}))

import { callCursorStreaming, cursorInactivityReason, cursorWallReason, trackCursorToolCall } from './cursor-bridge.js'

const INACTIVITY = 180_000
const WALL = 900_000
const started = (id: string, key: string) => ({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { [key]: { args: {} } } })
const completed = (id: string, key: string) => ({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { [key]: { args: {} } } })

describe('trackCursorToolCall', () => {
  it('opens a call on started and closes it on completed, by call_id', () => {
    const open = new Map<string, string>()
    expect(trackCursorToolCall(open, started('c1', 'taskToolCall'))).toBe('taskToolCall')
    expect([...open]).toEqual([['c1', 'taskToolCall']])
    expect(trackCursorToolCall(open, completed('c1', 'taskToolCall'))).toBe('taskToolCall')
    expect(open.size).toBe(0)
  })
  it('never tracks a call without a call_id, so it cannot hold a run open', () => {
    const open = new Map<string, string>()
    expect(trackCursorToolCall(open, { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: {} } })).toBe('readToolCall')
    expect(open.size).toBe(0)
  })
  it('ignores every event that is not a tool call', () => {
    const open = new Map<string, string>()
    expect(trackCursorToolCall(open, { type: 'assistant', call_id: 'c1', subtype: 'started' })).toBeUndefined()
    expect(open.size).toBe(0)
  })
  it('closes on any end subtype, not only completed', () => {
    const open = new Map<string, string>([['c1', 'shellToolCall']])
    trackCursorToolCall(open, { type: 'tool_call', subtype: 'failed', call_id: 'c1', tool_call: { shellToolCall: {} } })
    expect(open.size).toBe(0)
  })
})

describe('cursorInactivityReason', () => {
  it('says how long there was no progress and what it was doing', () => {
    expect(cursorInactivityReason(INACTIVITY, 'taskToolCall')).toBe('Cursor stopped after 3 minutes with no progress while it was waiting on a sub-agent. Ask again.')
    expect(cursorInactivityReason(INACTIVITY, 'readToolCall')).toBe('Cursor stopped after 3 minutes with no progress while it was reading files. Ask again.')
  })
  it('leaves out what it was doing when that is not known', () => {
    expect(cursorInactivityReason(INACTIVITY)).toBe('Cursor stopped after 3 minutes with no progress. Ask again.')
    expect(cursorInactivityReason(INACTIVITY, 'someNewToolCall')).toBe('Cursor stopped after 3 minutes with no progress. Ask again.')
  })
  it('says one minute, never zero', () => {
    expect(cursorInactivityReason(60_000)).toBe('Cursor stopped after 1 minute with no progress. Ask again.')
    expect(cursorInactivityReason(5_000)).toBe('Cursor stopped after 1 minute with no progress. Ask again.')
  })
})

describe('cursorWallReason', () => {
  it('names the wall clock in minutes, derived from the constant', () => {
    expect(cursorWallReason(WALL)).toBe('Cursor stopped after 15 minutes while it was still working. Ask again.')
    expect(cursorWallReason(60_000)).toBe('Cursor stopped after 1 minute while it was still working. Ask again.')
  })
})

describe('the Cursor bridge inactivity timer, by execution (fake time)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    state.history = []
  })
  afterEach(() => {
    vi.useRealTimers()
    state.child = null
  })

  async function start() {
    const calls: Array<[string, unknown[]]> = []
    const record = (name: string) => (...args: unknown[]) => { calls.push([name, JSON.parse(JSON.stringify(args))]) }
    const callbackSet = {
      onStart: record('onStart'), onChunk: record('onChunk'), onToolStatus: record('onToolStatus'), onActivityLine: record('onActivityLine'),
      onProviderProcess: async (...args: unknown[]) => { record('onProviderProcess')(...args); return true },
      onAnswerReady: async (...args: unknown[]) => { record('onAnswerReady')(...args); return true },
      onDone: async (...args: unknown[]) => { record('onDone')(...args); return true },
      onError: async (...args: unknown[]) => { record('onError')(...args) },
    }
    await callCursorStreaming('read the live meeting', 'session-test', callbackSet as any, undefined, undefined, undefined, undefined,
      { lightweight: true, clientJobId: 'job-1', generation: 1 } as any)
    const child = state.child
    const send = (event: unknown) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`))
    const errors = () => calls.filter(([name]) => name === 'onError').map(([, args]) => args[0])
    return { child, send, errors, calls }
  }

  it('an open sub-agent is activity: no kill at 180 s or at 899 s, and the wall timer still ends it at 900 s', async () => {
    const { child, send, errors } = await start()
    send(started('t1', 'taskToolCall'))
    await vi.advanceTimersByTimeAsync(INACTIVITY + 1_000)
    expect(child.kill).not.toHaveBeenCalled()
    expect(errors()).toEqual([])
    await vi.advanceTimersByTimeAsync(WALL - INACTIVITY - 2_000)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // An open call at the wall clock fails with the wall's plain reason (Codex's read of ef1de8c9), not the inactivity one.
    expect(errors()).toEqual(['Cursor stopped after 15 minutes while it was still working. Ask again.'])
  })

  it('with no open call, 180 s of quiet kills the run and gives the thread a plain reason', async () => {
    const { child, send, errors } = await start()
    send(started('r1', 'readToolCall'))
    send(completed('r1', 'readToolCall'))
    await vi.advanceTimersByTimeAsync(INACTIVITY - 1_000)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(errors()).toEqual(['Cursor stopped after 3 minutes with no progress while it was reading files. Ask again.'])
  })

  it('a sub-agent that ends hands the run back to the inactivity timer, 180 s after its last event', async () => {
    const { child, send, errors } = await start()
    send(started('t1', 'taskToolCall'))
    await vi.advanceTimersByTimeAsync(400_000)
    send(completed('t1', 'taskToolCall'))
    await vi.advanceTimersByTimeAsync(INACTIVITY - 1_000)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(errors()).toEqual(['Cursor stopped after 3 minutes with no progress while it was waiting on a sub-agent. Ask again.'])
  })

  it('an interim line and a sub-agent still open at the wall clock: the ask FAILS with the wall reason, never completes', async () => {
    const { child, send, errors, calls } = await start()
    send({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'Reading...' }] } })
    send(started('t1', 'taskToolCall'))
    await vi.advanceTimersByTimeAsync(WALL)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(errors()).toEqual(['Cursor stopped after 15 minutes while it was still working. Ask again.'])
    expect(calls.some(([name]) => name === 'onDone' || name === 'onAnswerReady')).toBe(false)
    // The interim line was already streamed, so the job keeps it as the partial the thread shows under the reason.
    expect(calls.filter(([name]) => name === 'onChunk').map(([, args]) => args[0]).join('')).toBe('Reading...')
  })

  it('with no open call and text kept current to the wall clock, the text is the answer, completed as before', async () => {
    const { send, errors, calls } = await start()
    for (let i = 0; i < 9; i++) {
      send({ type: 'assistant', timestamp_ms: i + 1, message: { content: [{ type: 'text', text: `part ${i}. ` }] } })
      await vi.advanceTimersByTimeAsync(100_000)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(errors()).toEqual([])
    expect(calls.some(([name]) => name === 'onDone')).toBe(true)
  })

  it('the text already streamed reaches the job before the kill (the job keeps it as the partial answer)', async () => {
    const { send, calls } = await start()
    send({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'Reading the meeting now.' }] } })
    await vi.advanceTimersByTimeAsync(INACTIVITY)
    const chunks = calls.filter(([name]) => name === 'onChunk').map(([, args]) => args[0])
    expect(chunks.join('')).toBe('Reading the meeting now.')
    expect(calls.findIndex(([name]) => name === 'onChunk')).toBeLessThan(calls.findIndex(([name]) => name === 'onError'))
  })
})
