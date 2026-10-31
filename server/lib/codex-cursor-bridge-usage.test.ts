// 6.97.0: the Codex and Cursor bridges' audit rows, by execution against a fake child. Codex's usage is a
// running total for the thread (probed 2026-10-31 on codex-cli 0.166.0-alpha.5.1: 19,610 then 39,239 then
// 58,887 input on one thread), so a resumed turn is charged the difference. Cursor stays estimated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ child: null as any, audit: [] as Record<string, any>[], resumeThread: null as string | null, rollout: 1000, probes: 0 }))

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
  return {
    spawn: vitest.fn(() => { state.child = new FakeChild(); return state.child }),
    spawnSync: vitest.fn(() => ({ status: 0, stdout: '--add-dir', stderr: '' })),
  }
})
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn((entry: Record<string, unknown>) => { state.audit.push(entry) }) }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({ buildSystemPrompt: vi.fn(async () => 'system'), buildLightweightSystemPrompt: vi.fn(() => 'system') }))
vi.mock('./conversation.js', () => ({
  getHistory: () => [],
  addExchange: () => ({ id: 'exchange' }),
  reconcileExchangeByJobIdentity: () => ({ exchange: { id: 'exchange' }, created: true }),
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
vi.mock('./codex-engine-sessions.js', () => ({
  getCodexEngineSession: () => state.resumeThread ? { codexThreadId: state.resumeThread } : null,
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
  classifyCodexError: () => 'codex.error',
  extractCodexThreadId: (event: any) => event?.thread_id,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-usage' }),
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
  startCursorRun: () => ({ runId: 'cursor-run-usage' }),
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

import { callCodexStreaming } from './codex-bridge.js'
import { callCursorStreaming } from './cursor-bridge.js'
import { _resetCodexThreadTotalsForTest, forgetCodexThreadTotals, registerCodexRolloutProbe } from './provider-usage.js'

const ANSWER = 'SECRET ANSWER WORDS'
const totals = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({ type: 'turn.completed', usage: { input_tokens, cached_input_tokens, cache_write_input_tokens: 0, output_tokens, reasoning_output_tokens: 0 } })

function callbacks() {
  return { onChunk: vi.fn(), onToolStatus: vi.fn(), onDone: vi.fn(async () => true), onError: vi.fn(async () => true), onAnswerReady: vi.fn(async () => true), onProviderProcess: vi.fn(async () => true) } as any
}
function emit(child: any, ...lines: unknown[]) { child.stdout.emit('data', Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n')) }

let n = 0
async function codexTurn(thread: string, resumed: boolean, ...lines: unknown[]) {
  state.resumeThread = resumed ? thread : null
  state.child = null
  const cb = callbacks()
  await callCodexStreaming('SECRET PROMPT WORDS', `codex-usage-${++n}`, cb, 'codex-high' as any, undefined, undefined, undefined, { lightweight: true, clientJobId: `job-${n}` } as any)
  await vi.waitFor(() => expect(state.child?.stdin.end).toHaveBeenCalled())
  emit(state.child, { type: 'thread.started', thread_id: thread }, { type: 'item.completed', item: { type: 'agent_message', text: ANSWER } }, ...lines)
  await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledTimes(1))
  state.child.emit('close', 0)
  return { cb, row: state.audit.at(-1)! }
}

beforeEach(() => {
  state.audit.length = 0; state.resumeThread = null; state.rollout = 1000; state.probes = 0
  _resetCodexThreadTotalsForTest()
  registerCodexRolloutProbe(() => { state.probes++; return state.rollout })
  delete process.env.COS_CODEX_EXTRA_ARGS
})
afterEach(() => { state.child = null; registerCodexRolloutProbe(null) })

describe('Codex', () => {
  it('a fresh thread: real counts with cached subtracted from input, no cost, run id and thread id', async () => {
    const { cb, row } = await codexTurn('thread-fresh', false, totals(100, 80, 7))
    expect(cb.onDone.mock.calls[0][0]).toBe(ANSWER)
    expect(row).toMatchObject({ source: 'g2-voice', caller: 'voice_query', runId: 'codex-run-usage', cliSessionId: 'thread-fresh', realUsage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 7, resolvedModel: 'gpt-test' } })
    expect(row.realUsage).not.toHaveProperty('costUsd')
  })
  it('a resumed thread is charged its own turn, from the real probe numbers', async () => {
    await codexTurn('thread-probe', false, totals(19610, 0, 5))
    const second = await codexTurn('thread-probe', true, totals(39239, 19456, 10))
    expect(second.row.realUsage).toEqual({ inputTokens: 19629 - 19456, cacheReadTokens: 19456, outputTokens: 5, resolvedModel: 'gpt-test' })
    const third = await codexTurn('thread-probe', true, totals(58887, 38912, 15))
    expect(third.row.realUsage).toEqual({ inputTokens: 19648 - 19456, cacheReadTokens: 19456, outputTokens: 5, resolvedModel: 'gpt-test' })
  })
  it('an attached run between turns: estimated, not the 8,000 tokens it ran charged to this turn', async () => {
    await codexTurn('thread-attached', false, totals(1000, 500, 50))
    forgetCodexThreadTotals('thread-attached')
    const { cb, row } = await codexTurn('thread-attached', true, totals(9100, 8450, 510))
    expect(cb.onDone.mock.calls[0][0]).toBe(ANSWER)
    expect(row).not.toHaveProperty('realUsage')
    expect(row).toMatchObject({ runId: 'codex-run-usage', cliSessionId: 'thread-attached' })
  })
  it('the rollout grew between turns, as the desktop app would: estimated', async () => {
    await codexTurn('thread-desktop', false, totals(1000, 500, 50))
    state.rollout = 9000
    const { cb, row } = await codexTurn('thread-desktop', true, totals(9100, 8450, 510))
    expect(cb.onDone.mock.calls[0][0]).toBe(ANSWER)
    expect(row).not.toHaveProperty('realUsage')
  })
  it('a timed-out turn that saw no total leaves nothing for the next turn to overcharge against', async () => {
    await codexTurn('thread-timeout', false, totals(1000, 500, 50))
    state.resumeThread = 'thread-timeout'
    state.child = null
    const failed = callbacks()
    await callCodexStreaming('SECRET PROMPT WORDS', `codex-usage-${++n}`, failed, 'codex-high' as any, undefined, undefined, undefined, { lightweight: true, clientJobId: `job-${n}` } as any)
    await vi.waitFor(() => expect(state.child?.stdin.end).toHaveBeenCalled())
    emit(state.child, { type: 'thread.started', thread_id: 'thread-timeout' }, { type: 'turn.failed', error: { message: 'boom' } })
    await vi.waitFor(() => expect(failed.onError).toHaveBeenCalled())
    state.child.emit('close', 1)
    const { row } = await codexTurn('thread-timeout', true, totals(9100, 8450, 510))
    expect(row).not.toHaveProperty('realUsage')
  })
  it('a fresh run never reads the rollout before it starts', async () => {
    state.probes = 0
    state.resumeThread = null
    state.child = null
    const cb = callbacks()
    await callCodexStreaming('q', `codex-usage-${++n}`, cb, 'codex-high' as any, undefined, undefined, undefined, { lightweight: true, clientJobId: `job-${n}` } as any)
    await vi.waitFor(() => expect(state.child?.stdin.end).toHaveBeenCalled())
    expect(state.probes).toBe(0)
  })
  it('a resumed thread this server has no total for stays estimated, with its ids', async () => {
    const { row } = await codexTurn('thread-unknown', true, totals(39239, 19456, 10))
    expect(row).not.toHaveProperty('realUsage')
    expect(row).toMatchObject({ runId: 'codex-run-usage', cliSessionId: 'thread-unknown' })
  })
  it.each([
    ['a string', { type: 'turn.completed', usage: 'garbage' }],
    ['null', { type: 'turn.completed', usage: null }],
    ['negative', { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 1 } }],
    ['missing output', { type: 'turn.completed', usage: { input_tokens: 5 } }],
    ['no usage', { type: 'turn.completed' }],
  ])('malformed usage, %s: same answer, no error, one row, estimated', async (_name, event) => {
    const { cb, row } = await codexTurn('thread-bad', false, event)
    expect(cb.onDone.mock.calls[0][0]).toBe(ANSWER)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(state.audit).toHaveLength(1)
    expect(row).not.toHaveProperty('realUsage')
    expect(row).toMatchObject({ runId: 'codex-run-usage', outputChars: ANSWER.length })
  })
  it('no prompt or answer text reaches the audit', async () => {
    const { row } = await codexTurn('thread-text', false, totals(100, 80, 7))
    expect(JSON.stringify(row)).not.toContain('SECRET')
  })
})

describe('Cursor', () => {
  async function cursorTurn(...lines: unknown[]) {
    state.child = null
    const cb = callbacks()
    await callCursorStreaming('SECRET PROMPT WORDS', `cursor-usage-${++n}`, cb, 'cursor-composer' as any, undefined, undefined, undefined, { lightweight: true, clientJobId: `job-${n}` } as any)
    await vi.waitFor(() => expect(state.child?.stdin.end).toHaveBeenCalled())
    emit(state.child, ...lines)
    await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledTimes(1))
    return { cb, row: state.audit.at(-1)! }
  }
  it('stays estimated whatever usage it prints, and writes the run id and chat id', async () => {
    const { cb, row } = await cursorTurn({ type: 'system', subtype: 'init', session_id: 'chat-usage-1' }, { type: 'result', subtype: 'success', is_error: false, result: ANSWER, session_id: 'chat-usage-1', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 9 } })
    expect(cb.onDone.mock.calls[0][0]).toBe(ANSWER)
    expect(row).toMatchObject({ runId: 'cursor-run-usage', cliSessionId: 'chat-usage-1' })
    expect(row).not.toHaveProperty('realUsage')
  })
  it('no prompt or answer text reaches the audit', async () => {
    const { row } = await cursorTurn({ type: 'result', subtype: 'success', is_error: false, result: ANSWER, session_id: 'chat-usage-2' })
    expect(JSON.stringify(row)).not.toContain('SECRET')
  })
})
