import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claudeCallbacks: [] as any[],
  codexCallbacks: [] as any[],
  ollamaCallbacks: [] as any[],
  ollamaReady: false,
  callClaudeStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.claudeCallbacks.push(callbacks)
    return sid
  }),
  callCodexStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.codexCallbacks.push(callbacks)
    return sid
  }),
  callOllamaStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.ollamaCallbacks.push(callbacks)
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

vi.mock('./ollama-bridge.js', () => ({
  callOllamaStreaming: mocks.callOllamaStreaming,
}))

vi.mock('./ollama-catalog.js', () => ({
  getOllamaCatalog: async () => ({ ready: mocks.ollamaReady }),
  isOllamaProviderReady: () => mocks.ollamaReady,
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
  mocks.ollamaCallbacks.length = 0
  mocks.ollamaReady = false
  mocks.callClaudeStreaming.mockClear()
  mocks.callCodexStreaming.mockClear()
  mocks.callOllamaStreaming.mockClear()
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

  it('awaits an async terminal callback before starting the same-session successor', async () => {
    let releaseTerminal!: () => void
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve })
    const firstCallbacks = callbacks()
    firstCallbacks.onDone.mockImplementation(async () => { await terminalGate })

    await callModelStreaming('first', 'async-terminal-session', firstCallbacks, 'sonnet')
    const second = callModelStreaming('second', 'async-terminal-session', callbacks(), 'sonnet')
    await Promise.resolve()

    const terminal = mocks.claudeCallbacks[0].onDone('first answer', 'sonnet')
    await Promise.resolve()
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(1)

    releaseTerminal()
    await terminal
    await second
    expect(mocks.callClaudeStreaming).toHaveBeenCalledTimes(2)
    await mocks.claudeCallbacks[1].onDone('second answer', 'sonnet')
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

describe('ollama routing', () => {
  it('never falls through to Claude or Codex when Ollama is picked', async () => {
    mocks.ollamaReady = true
    await callModelStreaming('hi', 'ollama-session', callbacks(), 'ollama')
    expect(mocks.callOllamaStreaming).toHaveBeenCalledTimes(1)
    expect(mocks.callClaudeStreaming).not.toHaveBeenCalled()
    expect(mocks.callCodexStreaming).not.toHaveBeenCalled()
    mocks.ollamaCallbacks[0].onDone('local', 'ollama')
  })

  it('fails closed when Ollama is picked but the daemon is down', async () => {
    const cb = callbacks()
    const sid = await callModelStreaming('hi', 'ollama-down', cb, 'ollama')
    expect(sid).toBe('ollama-down')
    expect(mocks.callOllamaStreaming).not.toHaveBeenCalled()
    expect(mocks.callClaudeStreaming).not.toHaveBeenCalled()
    expect(mocks.callCodexStreaming).not.toHaveBeenCalled()
    expect(cb.onError).toHaveBeenCalledWith(
      expect.stringMatching(/Ollama is not running/),
    )
  })
})
