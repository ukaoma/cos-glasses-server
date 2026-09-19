// The Codex and Cursor bridges with and without the Messages trail (6.52.0), by execution.
// Same method as job-trail-claude-bridge.test.ts: identical stdout through the real bridge
// twice, and nothing the bridge decides may differ. activity-preview is real here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_RUN, CODEX_RUN_TRAIL, CURSOR_RUN, CURSOR_RUN_TRAIL } from './__fixtures__/job-trail-runs.js'
import type { JobTrailDraft } from './job-trail.js'

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

import { callCodexStreaming } from './codex-bridge.js'
import { callCursorStreaming } from './cursor-bridge.js'

beforeEach(() => {
  delete process.env.COS_CODEX_EXTRA_ARGS
  state.history = []
})

afterEach(() => {
  state.child = null
})

type Bridge = 'codex' | 'cursor'

async function drive(bridge: Bridge, withTrail: boolean, lines: readonly unknown[]) {
  state.history = []
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
  const options = { lightweight: true, clientJobId: 'job-1', generation: 1 } as any
  if (bridge === 'codex') {
    await callCodexStreaming('find the TODOs', 'session-test', callbackSet as any, undefined, undefined, undefined, undefined, options)
  } else {
    await callCursorStreaming('list files', 'session-test', callbackSet as any, undefined, undefined, undefined, undefined, options)
  }
  const child = state.child
  const dataListeners = child.stdout.listenerCount('data')
  for (const line of lines) child.stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`))
  child.stdout.emit('end')
  child.emit('close', 0)
  await vi.waitFor(() => expect(calls.some(([name]) => name === 'onDone' || name === 'onError')).toBe(true))
  return {
    calls,
    trail,
    dataListeners,
    argv: JSON.parse(JSON.stringify(state.spawn.mock.calls.at(-1).slice(0, 2))),
    stdin: child.stdin.write.mock.calls,
    history: JSON.parse(JSON.stringify(state.history)),
  }
}

describe.each([
  ['codex', CODEX_RUN, CODEX_RUN_TRAIL, 'Two TODOs found; fixing the first.Fixed.'],
  ['cursor', CURSOR_RUN, CURSOR_RUN_TRAIL, 'Let me look.All set.'],
] as const)('the %s bridge with the trail tee', (bridge, run, expectedTrail, answer) => {
  it('decides exactly the same run with or without a trail consumer; only the trail differs', async () => {
    const without = await drive(bridge, false, run)
    const withTrail = await drive(bridge, true, run)

    expect(without.dataListeners).toBe(1)
    expect(withTrail.dataListeners).toBe(2)
    expect(without.trail).toEqual([])
    expect(withTrail.trail).toEqual(expectedTrail)

    expect(withTrail.argv).toEqual(without.argv)
    expect(withTrail.stdin).toEqual(without.stdin)
    expect(withTrail.calls).toEqual(without.calls)
    expect(withTrail.history).toEqual(without.history)
    const done = withTrail.calls.find(([name]) => name === 'onDone')
    expect(done?.[1][0]).toBe(answer)
  })
})
