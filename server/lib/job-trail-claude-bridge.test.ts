// The Claude bridge with and without the Messages trail (6.52.0), by execution.
//
// The same stdout bytes go through the real `callClaudeStreaming` twice, once with an
// `onTrail` consumer and once without, against a fake child. Everything the bridge decides
// (argv, the prompt on stdin, every callback and its arguments, the history writes, the
// cancel path) must be identical; the only difference allowed is the trail itself. The
// activity-preview module is NOT faked here, so the activity lines compared are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_RUN, CLAUDE_RUN_TRAIL } from './__fixtures__/job-trail-runs.js'
import type { JobTrailDraft } from './job-trail.js'

const state = vi.hoisted(() => ({
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

import { callClaudeStreaming } from './claude-bridge.js'

beforeEach(() => {
  state.history = []
  state.terminateProviderProcess = vi.fn(async () => ({ closed: true, escalated: false, code: null, signal: 'SIGTERM' }))
})

afterEach(() => {
  state.child = null
})

interface Observed {
  calls: Array<[string, unknown[]]>
  trail: JobTrailDraft[]
  dataListeners: number
  argv: unknown[]
  stdin: unknown[]
  history: unknown[][]
  terminated: number
}

async function drive(withTrail: boolean, lines: readonly unknown[], cancelAfter?: number): Promise<Observed> {
  state.history = []
  state.terminateProviderProcess.mockClear()
  const calls: Array<[string, unknown[]]> = []
  const trail: JobTrailDraft[] = []
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, JSON.parse(JSON.stringify(args))]) }
  const callbackSet = {
    onStart: record('onStart'),
    onChunk: record('onChunk'),
    onToolStatus: record('onToolStatus'),
    onActivityLine: record('onActivityLine'),
    onProviderProcess: async (...args: unknown[]) => { record('onProviderProcess')(...args); return true },
    onAnswerReady: async (...args: unknown[]) => { record('onAnswerReady')(...args); return true },
    onDone: async (...args: unknown[]) => { record('onDone')(...args); return true },
    onError: async (...args: unknown[]) => { record('onError')(...args) },
    ...(withTrail ? { onTrail: (draft: JobTrailDraft) => { trail.push(draft) } } : {}),
  }
  const controller = new AbortController()
  await callClaudeStreaming('what port does the config use?', 'session-test', callbackSet as any, 'opus', undefined, undefined, undefined, {
    lightweight: true,
    clientJobId: 'job-1',
    generation: 1,
    abortSignal: controller.signal,
  })
  const child = state.child
  const dataListeners = child.stdout.listenerCount('data')
  const count = cancelAfter ?? lines.length
  for (const line of lines.slice(0, count)) child.stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`))
  if (cancelAfter != null) {
    controller.abort()
    await vi.waitFor(() => expect(calls.some(([name]) => name === 'onError')).toBe(true))
  } else {
    child.stdout.emit('end')
    child.emit('close', 0)
    await vi.waitFor(() => expect(calls.some(([name]) => name === 'onDone')).toBe(true))
  }
  return {
    calls,
    trail,
    dataListeners,
    argv: JSON.parse(JSON.stringify(state.spawn.mock.calls.at(-1).slice(0, 2))),
    stdin: child.stdin.write.mock.calls,
    history: JSON.parse(JSON.stringify(state.history)),
    terminated: state.terminateProviderProcess.mock.calls.length,
  }
}

describe('the Claude bridge with the trail tee', () => {
  it('decides exactly the same run with or without a trail consumer; only the trail differs', async () => {
    const without = await drive(false, CLAUDE_RUN)
    const withTrail = await drive(true, CLAUDE_RUN)

    expect(without.dataListeners).toBe(1)
    expect(withTrail.dataListeners).toBe(2)
    expect(without.trail).toEqual([])
    expect(withTrail.trail).toEqual(CLAUDE_RUN_TRAIL)

    expect(withTrail.argv).toEqual(without.argv)
    expect(withTrail.stdin).toEqual(without.stdin)
    expect(withTrail.calls).toEqual(without.calls)
    expect(withTrail.history).toEqual(without.history)

    // The final answer is the bridge's own, unchanged: narration and answer joined as
    // before, not the trail's split view.
    const done = withTrail.calls.find(([name]) => name === 'onDone')!
    expect(done[1][0]).toBe("I'll check the config first.The config sets port 3141.")
    expect(withTrail.calls.filter(([name]) => name === 'onActivityLine').length).toBeGreaterThan(0)
  })

  it('cancels exactly the same way with or without a trail consumer', async () => {
    const cut = CLAUDE_RUN.findIndex(line => (line as { type?: string }).type === 'user')
    const without = await drive(false, CLAUDE_RUN, cut)
    const withTrail = await drive(true, CLAUDE_RUN, cut)
    expect(withTrail.calls).toEqual(without.calls)
    expect(withTrail.history).toEqual(without.history)
    expect(withTrail.terminated).toBe(1)
    expect(without.terminated).toBe(1)
    expect(withTrail.calls.find(([name]) => name === 'onError')?.[1]).toEqual(['claude-bridge: client disconnected before Claude completed.'])
    // The trail kept what was seen before the cancel.
    expect(withTrail.trail.map(draft => draft.kind)).toEqual(['prose', 'tool', 'status'])
  })
})
