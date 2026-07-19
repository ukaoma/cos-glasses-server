import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  saveThrows: false,
  clearThrows: false,
  saveCalls: 0,
  clearCalls: 0,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
    pid = 4321
    kill = vi.fn()
  }
  return {
    spawn: vi.fn(() => {
      state.child = new FakeChild()
      return state.child
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: '--add-dir', stderr: '' })),
  }
})
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'system'),
  buildLightweightSystemPrompt: vi.fn(() => 'system'),
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
vi.mock('./codex-engine-sessions.js', () => ({
  getCodexEngineSession: () => ({
    codexThreadId: 'thread-existing',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  saveCodexEngineSession: () => {
    state.saveCalls++
    if (state.saveThrows) throw new Error('injected engine save failure')
    return { expiresAt: new Date(Date.now() + 60_000).toISOString() }
  },
  clearCodexEngineSession: () => {
    state.clearCalls++
    if (state.clearThrows) throw new Error('injected engine clear failure')
    return 1
  },
}))
vi.mock('./codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveCodexModelOption: () => ({
    id: 'gpt-test', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: [],
  }),
  resolveCodexEffortForModel: () => 'high',
  resolveCodexServiceTier: () => undefined,
}))
vi.mock('./codex-run-ledger.js', () => ({
  classifyCodexError: (message: string) => message.includes('authentication required') ? 'codex.auth_error' : 'codex.error',
  extractCodexThreadId: () => undefined,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-test' }),
  updateCodexRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({ codexActivityPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))

import { callCodexStreaming } from './codex-bridge.js'

function callbacks(overrides: Record<string, unknown> = {}) {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onAnswerReady: vi.fn(async () => {}),
    ...overrides,
  } as any
}

async function start(callbackSet: ReturnType<typeof callbacks>) {
  await callCodexStreaming('hello', 'session-test', callbackSet, undefined, undefined, undefined, undefined, {
    lightweight: true,
    onProviderProcess: undefined,
  } as any)
  expect(state.child).toBeTruthy()
}

function emitCompletedAnswer() {
  state.child.stdout.emit('data', Buffer.from([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'durable answer' } }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ].join('\n')))
}

afterEach(() => {
  state.child = null
  state.saveThrows = false
  state.clearThrows = false
  state.saveCalls = 0
  state.clearCalls = 0
})

describe('Codex detached finalization', () => {
  it('turns exit-zero auth output into one typed provider failure', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from([
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'API Error: 401 Unauthorized Bearer sk-supersecret must never escape' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
      '',
    ].join('\n')))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    expect(callbackSet.onError).toHaveBeenCalledWith('Codex auth failed. Run codex login on the Mac.')
    expect(callbackSet.onChunk).not.toHaveBeenCalled()
    expect(callbackSet.onAnswerReady).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
  })

  it('streams and completes a normal answer beginning with a sign-in instruction', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    const answer = 'Please sign in to the customer portal, then choose Billing.'
    state.child.stdout.emit('data', Buffer.from([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }),
      JSON.stringify({ type: 'turn.completed' }),
      '',
    ].join('\n')))
    await vi.waitFor(() => expect(callbackSet.onDone).toHaveBeenCalledTimes(1))
    expect(callbackSet.onChunk).toHaveBeenCalledWith(answer)
    expect(callbackSet.onDone.mock.calls[0]?.[0]).toBe(answer)
    expect(callbackSet.onError).not.toHaveBeenCalled()
  })

  it('classifies a structured 403 terminal event without exposing provider detail', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'turn.failed',
      error: { status: 403, message: 'Forbidden Bearer sk-supersecret must never escape' },
    })}\n`))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    expect(callbackSet.onError).toHaveBeenCalledWith('Codex auth failed. Run codex login on the Mac.')
    expect(String(callbackSet.onError.mock.calls[0]?.[0] ?? '')).not.toContain('sk-supersecret')
    expect(callbackSet.onAnswerReady).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
  })

  it('still invokes one completion when engine-session save throws', async () => {
    state.saveThrows = true
    const callbackSet = callbacks()
    await start(callbackSet)
    emitCompletedAnswer()
    await vi.waitFor(() => expect(callbackSet.onDone).toHaveBeenCalledTimes(1))

    state.child.emit('close', 0)
    emitCompletedAnswer()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callbackSet.onAnswerReady).toHaveBeenCalledTimes(1)
    expect(callbackSet.onDone).toHaveBeenCalledTimes(1)
    expect(callbackSet.onError).not.toHaveBeenCalled()
    expect(state.saveCalls).toBe(1)
  })

  it('still invokes one error when barrier cleanup engine-session clear throws', async () => {
    state.clearThrows = true
    const callbackSet = callbacks({
      onAnswerReady: vi.fn(async () => { throw new Error('injected durable barrier failure') }),
    })
    await start(callbackSet)
    emitCompletedAnswer()
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))

    state.child.emit('close', 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onError).toHaveBeenCalledTimes(1)
    expect(state.clearCalls).toBe(1)
  })

  it('abandons all terminal publication when durable answer ownership is lost', async () => {
    const callbackSet = callbacks({ onAnswerReady: vi.fn(async () => false) })
    await start(callbackSet)
    emitCompletedAnswer()
    await vi.waitFor(() => expect(state.clearCalls).toBe(1))
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onError).not.toHaveBeenCalled()
  })

  it('never writes the prompt when durable provider ownership is lost', async () => {
    const callbackSet = callbacks({ onProviderProcess: vi.fn(async () => false) })
    await start(callbackSet)
    expect(state.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(state.child.stdin.write).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onError).not.toHaveBeenCalled()
  })

  it('still invokes one provider error when finalizeError engine-session clear throws', async () => {
    state.clearThrows = true
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.emit('error', new Error('spawned provider failed'))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))

    state.child.emit('close', 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callbackSet.onAnswerReady).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onError).toHaveBeenCalledTimes(1)
    expect(state.clearCalls).toBe(1)
  })
})
