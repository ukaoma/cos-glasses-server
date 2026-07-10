import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claudeCallbacks: [] as any[],
  codexCallbacks: [] as any[],
  callClaudeStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.claudeCallbacks.push(callbacks)
    return sid
  }),
  callCodexStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.codexCallbacks.push(callbacks)
    return sid
  }),
  sessionModels: new Map<string, string | null>(),
}))

vi.mock('./claude-bridge.js', () => ({
  callClaudeStreaming: mocks.callClaudeStreaming,
}))

vi.mock('./codex-bridge.js', () => ({
  callCodexStreaming: mocks.callCodexStreaming,
}))

vi.mock('./conversation.js', () => ({
  getOrCreateSession: (sid?: string) => sid ?? 'generated-session',
  getSessionModel: (sid: string) => mocks.sessionModels.get(sid) ?? null,
  setSessionModel: (sid: string, model: string | null) => { mocks.sessionModels.set(sid, model) },
}))

import { callModelStreaming } from './model-router.js'

function callbacks() {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

afterEach(() => {
  mocks.claudeCallbacks.length = 0
  mocks.codexCallbacks.length = 0
  mocks.callClaudeStreaming.mockClear()
  mocks.callCodexStreaming.mockClear()
  mocks.sessionModels.clear()
})

describe('per-session model run lock', () => {
  it('serializes turns in one session until the terminal callback fires', async () => {
    const firstCallbacks = callbacks()
    const secondCallbacks = callbacks()
    await callModelStreaming('first', 'same-session', firstCallbacks, 'sonnet')

    const second = callModelStreaming('second', 'same-session', secondCallbacks, 'sonnet')
    await Promise.resolve()
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(1)

    mocks.claudeCallbacks[0].onDone('first answer', 'sonnet')
    await second
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(2)
    mocks.claudeCallbacks[1].onDone('second answer', 'sonnet')
  })

  it('allows different sessions to run concurrently', async () => {
    await Promise.all([
      callModelStreaming('one', 'session-a', callbacks(), 'sonnet'),
      callModelStreaming('two', 'session-b', callbacks(), 'sonnet'),
    ])
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(2)
    mocks.claudeCallbacks[0].onDone('one', 'sonnet')
    mocks.claudeCallbacks[1].onDone('two', 'sonnet')
  })

  it('drops an aborted queued turn without spawning another model', async () => {
    await callModelStreaming('first', 'abort-session', callbacks(), 'sonnet')
    const controller = new AbortController()
    controller.abort()
    const queued = callModelStreaming('never run', 'abort-session', callbacks(), 'sonnet', undefined, undefined, undefined, { abortSignal: controller.signal })

    mocks.claudeCallbacks[0].onError('first failed')
    await expect(queued).rejects.toThrow('aborted before the model run')
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(1)
  })

  it('releases the session after an early bridge rejection', async () => {
    mocks.callClaudeStreaming.mockRejectedValueOnce(new Error('spawn failed early'))
    await expect(callModelStreaming('first', 'reject-session', callbacks(), 'sonnet')).rejects.toThrow('spawn failed early')

    await callModelStreaming('second', 'reject-session', callbacks(), 'sonnet')
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(2)
    mocks.claudeCallbacks[0].onDone('recovered', 'sonnet')
  })
})
