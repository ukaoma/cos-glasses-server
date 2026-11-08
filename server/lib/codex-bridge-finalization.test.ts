import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  saveThrows: false,
  clearThrows: false,
  saveCalls: 0,
  clearCalls: 0,
  terminateProviderProcess: vi.fn(),
  resolveTermination: null as null | ((value: any) => void),
  addExchange: vi.fn(() => ({ id: 'exchange' })),
  startCodexRun: vi.fn(() => ({ runId: 'codex-run-test' })),
  getCodexEngineSession: vi.fn(() => ({
    codexThreadId: 'thread-existing',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
    pid = 4321
    exitCode = null
    signalCode = null
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
  addExchange: state.addExchange,
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
  getCodexEngineSession: state.getCodexEngineSession,
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
vi.mock('./codex-run-ledger.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codex-run-ledger.js')>(),
  extractCodexThreadId: () => undefined,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: state.startCodexRun,
  updateCodexRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({ codexActivityPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: state.terminateProviderProcess,
}))

import { callCodexStreaming } from './codex-bridge.js'
import { classifyCodexError, finishCodexRun } from './codex-run-ledger.js'

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

beforeEach(() => {
  delete process.env.COS_CODEX_EXTRA_ARGS
  state.addExchange.mockClear()
  state.startCodexRun.mockClear()
  state.getCodexEngineSession.mockClear()
  vi.mocked(finishCodexRun).mockClear()
  state.terminateProviderProcess.mockResolvedValue({
    closed: true,
    escalated: false,
    code: null,
    signal: 'SIGTERM',
  })
})

afterEach(() => {
  delete process.env.COS_CODEX_EXTRA_ARGS
  vi.useRealTimers()
  state.child = null
  state.saveThrows = false
  state.clearThrows = false
  state.saveCalls = 0
  state.clearCalls = 0
  state.terminateProviderProcess.mockReset()
  state.resolveTermination = null
})

describe('Codex detached finalization', () => {
  it.each([
    { type: 'error', codex_error_info: 'usage_limit_exceeded', message: 'Provider refused this turn.' },
    { type: 'turn.failed', error: { codex_error_info: 'usage_limit_exceeded', message: 'Provider refused this turn.' } },
  ])('preserves structured quota identity from a $type terminal event', async event => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    expect(callbackSet.onError).toHaveBeenCalledWith('Codex usage limit reached. Try again later or choose another model.')
    const diagnostic = vi.mocked(finishCodexRun).mock.calls[0]?.[1]
    expect(classifyCodexError(diagnostic?.error ?? '')).toBe('provider_limit')
    expect(diagnostic?.status).toBe('failed')
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onAnswerReady).not.toHaveBeenCalled()
    state.child.emit('close', 1)
    expect(callbackSet.onError).toHaveBeenCalledTimes(1)
  })

  it('retains only the validated retry date from quota terminal detail', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'turn.failed',
      error: {
        codex_error_info: 'usage_limit_exceeded',
        message: 'Try again at November 10th, 2026 9:28 AM. Bearer sk-supersecret /Users/private/file https://untrusted.invalid/reset',
      },
    })}\n`))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    const expected = 'Codex usage limit reached. Try again at Nov 10, 2026 9:28 AM (provider time), or choose another model.'
    expect(callbackSet.onError).toHaveBeenCalledWith(expected)
    expect(vi.mocked(finishCodexRun).mock.calls[0]?.[1]?.error).toBe(expected)
    expect(callbackSet.onChunk).not.toHaveBeenCalled()
  })

  it('keeps authentication failure precedence over a conflicting quota field', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'error', codex_error_info: 'usage_limit_exceeded',
      error: { status: 403, message: 'Forbidden Bearer sk-private' },
    })}\n`))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    expect(callbackSet.onError).toHaveBeenCalledWith('Codex auth failed. Run codex login on the Mac.')
  })

  it('keeps ordinary permission failures distinct from quota failures', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'turn.failed', error: { message: 'Sandbox permission denied at /Users/private/file' },
    })}\n`))
    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    expect(classifyCodexError(vi.mocked(finishCodexRun).mock.calls[0]?.[1]?.error ?? '')).toBe('codex.permission_denied')
    expect(String(callbackSet.onError.mock.calls[0]?.[0])).not.toContain('/Users/private')
    expect(String(callbackSet.onError.mock.calls[0]?.[0])).not.toContain('usage limit')
  })

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
    expect(state.terminateProviderProcess).toHaveBeenCalledWith(state.child)
    expect(state.child.kill).not.toHaveBeenCalled()
    expect(state.child.stdin.write).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
    expect(callbackSet.onError).not.toHaveBeenCalled()
  })

  it('holds timeout finalization until the provider tree confirms close', async () => {
    vi.useFakeTimers()
    state.terminateProviderProcess.mockImplementation(() => new Promise(resolve => {
      state.resolveTermination = resolve
    }))
    const callbackSet = callbacks()
    await start(callbackSet)

    await vi.advanceTimersByTimeAsync(180_000)
    expect(state.terminateProviderProcess).toHaveBeenCalledWith(state.child)
    expect(callbackSet.onError).not.toHaveBeenCalled()

    state.resolveTermination!({ closed: true, escalated: true, code: null, signal: 'SIGKILL' })
    await Promise.resolve()
    await Promise.resolve()
    expect(callbackSet.onError).toHaveBeenCalledTimes(1)
    expect(callbackSet.onDone).not.toHaveBeenCalled()
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

  it('refuses extra args before startCodexRun, exchange, or spawn', async () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--sandbox danger-full-access'
    const callbackSet = callbacks()
    const sid = await callCodexStreaming('hello', 'session-test', callbackSet, undefined, undefined, undefined, undefined, {
      lightweight: true,
      onProviderProcess: undefined,
    } as any)
    expect(sid).toBe('session-test')
    expect(callbackSet.onError).toHaveBeenCalledWith(
      'Invalid COS_CODEX_EXTRA_ARGS (--sandbox). Edit ~/.cos-glasses/.env and restart the glasses server.',
    )
    expect(state.child).toBeNull()
    expect(state.startCodexRun).not.toHaveBeenCalled()
    expect(state.addExchange).not.toHaveBeenCalled()
    expect(state.getCodexEngineSession).not.toHaveBeenCalled()
  })

  it('passes engineFingerprint into getCodexEngineSession', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    expect(state.getCodexEngineSession).toHaveBeenCalledWith(expect.objectContaining({
      engineFingerprint: '',
    }))
    state.child = null
    state.getCodexEngineSession.mockClear()
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama'
    await start(callbacks())
    expect(state.getCodexEngineSession).toHaveBeenCalledWith(expect.objectContaining({
      engineFingerprint: '--oss\0--local-provider\0ollama',
    }))
  })
})

describe('codex maintenance pass lifecycle', () => {
  const begin = async (cb: ReturnType<typeof callbacks>) => {
    await callCodexStreaming('cleanup', 'session-test', cb, undefined, undefined, undefined, undefined,
      { lightweight: true, maintenancePass: true, sessionLockHeld: true })
  }
  it('waits for tree closure even with repeated terminal events', async () => {
    const cb = callbacks()
    state.terminateProviderProcess.mockImplementation(() => new Promise(resolve => { state.resolveTermination = resolve }))
    await begin(cb)
    state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial progress' } }) + '\n'))
    state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'))
    state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'))
    expect(cb.onDone).not.toHaveBeenCalled(); expect(cb.onAnswerReady).not.toHaveBeenCalled()
    expect(state.terminateProviderProcess).toHaveBeenCalledTimes(1)
    state.resolveTermination?.({ closed: true, code: 0, signal: null, escalated: false })
    await vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledTimes(1))
    expect(cb.onError).not.toHaveBeenCalled()
  })
  it('15-minute partial output yields a continuation signal, never success', async () => {
    vi.useFakeTimers()
    const cb = callbacks()
    state.terminateProviderProcess.mockResolvedValue({ closed: true, code: null, signal: 'SIGTERM', escalated: false })
    await begin(cb)
    for (let minute = 0; minute < 15; minute++) {
      state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial progress' } }) + '\n'))
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(cb.onError).toHaveBeenCalledWith('maintenance_pass_timeout')
    expect(cb.onDone).not.toHaveBeenCalled(); expect(cb.onAnswerReady).not.toHaveBeenCalled()
    expect(state.terminateProviderProcess).toHaveBeenCalledTimes(1)
  })
})
