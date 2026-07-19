import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  finishClaudeRun: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
    pid = 2468
    kill = vi.fn()
  }
  return {
    spawn: vi.fn(() => {
      state.child = new FakeChild()
      return state.child
    }),
  }
})

vi.mock('./python-bridge.js', () => ({ COS_SCRIPTS_DIR: '/tmp' }))
vi.mock('./launch-dir.js', () => ({ cosBrainDir: () => '/tmp' }))
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
  finishClaudeRun: state.finishClaudeRun,
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-test' }),
  updateClaudeRun: vi.fn(),
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

import { callClaudeStreaming } from './claude-bridge.js'

function callbacks() {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onAnswerReady: vi.fn(async () => {}),
  } as any
}

async function start(callbackSet: ReturnType<typeof callbacks>) {
  await callClaudeStreaming(
    'hello',
    'session-test',
    callbackSet,
    'opus',
    undefined,
    undefined,
    undefined,
    { lightweight: true },
  )
  expect(state.child).toBeTruthy()
}

afterEach(() => {
  state.child = null
  state.finishClaudeRun.mockClear()
})

describe('Claude exit-zero authentication finalization', () => {
  it('routes a success-shaped authentication failure through one redacted error', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)

    state.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'API Error: 401 Unauthorized Bearer sk-supersecret123456789',
    })}\n`))

    await vi.waitFor(() => expect(callbackSet.onError).toHaveBeenCalledTimes(1))
    const message = String(callbackSet.onError.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('authentication required')
    expect(message).not.toContain('sk-supersecret')
    expect(callbackSet.onChunk).not.toHaveBeenCalled()
    expect(callbackSet.onAnswerReady).not.toHaveBeenCalled()
    expect(callbackSet.onDone).not.toHaveBeenCalled()
  })

  it('streams and completes a normal answer beginning with a sign-in instruction', async () => {
    const callbackSet = callbacks()
    await start(callbackSet)
    const answer = 'Please sign in to the customer portal, then choose Billing.'

    state.child.stdout.emit('data', Buffer.from([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: answer }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer }),
      '',
    ].join('\n')))

    await vi.waitFor(() => expect(callbackSet.onDone).toHaveBeenCalledTimes(1))
    expect(callbackSet.onChunk).toHaveBeenCalledWith(answer)
    expect(callbackSet.onDone.mock.calls[0]?.[0]).toBe(answer)
    expect(callbackSet.onError).not.toHaveBeenCalled()
  })
})
