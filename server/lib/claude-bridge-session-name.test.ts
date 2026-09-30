import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  child: null as any,
  finishClaudeRun: vi.fn(),
  terminateProviderProcess: vi.fn(),
  resolveTermination: null as null | ((value: any) => void),
  updateClaudeRun: vi.fn(),
  spawnArgs: [] as string[][],
  nameSupported: true,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
    pid = 2468
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    spawn: vi.fn((_cmd: string, args: string[]) => {
      state.spawnArgs.push([...args])
      state.child = new FakeChild()
      return state.child
    }),
  }
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
  updateClaudeRun: state.updateClaudeRun,
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
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: state.terminateProviderProcess,
}))
vi.mock('./claude-cli-support.js', () => ({
  claudeSupportsSessionName: vi.fn(async () => state.nameSupported),
}))

import { callClaudeStreaming, preWarmCLI, type CallOptions } from './claude-bridge.js'

const SID = '8f7a53b9-b478-4d88-88e4-4a915b256da5'

function callbacks(overrides: Record<string, unknown> = {}) {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onAnswerReady: vi.fn(async () => {}),
    ...overrides,
  } as any
}

async function run(cosSession: string, options: Partial<CallOptions>, callbackSet = callbacks(), model: 'opus' | 'sonnet' = 'opus') {
  await callClaudeStreaming('hello', cosSession, callbackSet, model, undefined, undefined, undefined, { lightweight: true, ...options })
  expect(state.child).toBeTruthy()
  return { callbackSet, args: state.spawnArgs.at(-1)! }
}

function emit(...events: unknown[]) {
  state.child.stdout.emit('data', Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'))
}

function nameOf(args: string[]): string | undefined {
  const flag = args.find(arg => arg === '--name' || arg.startsWith('--name='))
  if (!flag) return undefined
  return flag === '--name' ? args[args.indexOf(flag) + 1] : flag.slice('--name='.length)
}

afterEach(() => {
  state.child = null
  state.spawnArgs.length = 0
  state.updateClaudeRun.mockClear()
  state.nameSupported = true
})

describe('6.58.2: a New session is named after its task, and names itself at once', () => {
  it('a session this COS session starts gets --name', async () => {
    const { args } = await run('work-new-1', { sessionName: 'Get the live SBS site URL' })
    expect(nameOf(args)).toBe('Get the live SBS site URL')
    expect(args).not.toContain('--resume')
  })

  it('passes the name as one --name=<name> argument, so a name that starts with a dash stays a name', async () => {
    const { args } = await run('work-new-dash', { sessionName: '--help me ship' })
    expect(args).toContain('--name=--help me ship')
    expect(args).not.toContain('--name')
  })

  it('a Claude CLI without --name runs the session unnamed', async () => {
    state.nameSupported = false
    const { args } = await run('work-new-old-cli', { sessionName: 'Task title' })
    expect(nameOf(args)).toBeUndefined()
    expect(args.some(arg => arg.startsWith('--name'))).toBe(false)
  })

  it('no name asked, no --name', async () => {
    const { args } = await run('work-new-2', {})
    expect(args.some(arg => arg.startsWith('--name'))).toBe(false)
  })

  it('a read-only dispatch is never named', async () => {
    const { args } = await run('work-new-3', { sessionName: 'x', dispatch: { restricted: true, tools: ['Read'] } })
    expect(args.some(arg => arg.startsWith('--name'))).toBe(false)
  })

  it('a Continue into the session it already has is never renamed', async () => {
    const first = await run('work-cont-1', { sessionName: 'Task title' })
    expect(nameOf(first.args)).toBe('Task title')
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SID })
    await vi.waitFor(() => expect(first.callbackSet.onDone).toHaveBeenCalledTimes(1))
    const second = await run('work-cont-1', { sessionName: 'Task title' })
    expect(second.args).toContain('--resume')
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(SID)
    expect(nameOf(second.args)).toBeUndefined()
  })

  it('a named New session never takes the warmed session; the next unnamed one still does', async () => {
    const WARM = '0b7c2a4e-5d1f-4c3b-9a8e-7f6d5c4b3a21'
    const warming = preWarmCLI()
    state.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: WARM }) + '\n'))
    state.child.emit('close', 0)
    await warming
    const named = await run('work-warm-1', { sessionName: 'Task title' }, callbacks(), 'sonnet')
    expect(named.args).not.toContain('--resume')
    expect(nameOf(named.args)).toBe('Task title')
    const unnamed = await run('glasses-warm-2', {}, callbacks(), 'sonnet')
    expect(unnamed.args[unnamed.args.indexOf('--resume') + 1]).toBe(WARM)
    expect(nameOf(unnamed.args)).toBeUndefined()
  })

  it('the first event that names the session links it, once, long before the result', async () => {
    const onNativeSession = vi.fn()
    const { callbackSet } = await run('work-link-1', {}, callbacks({ onNativeSession }))
    emit({ type: 'system', subtype: 'hook_started', session_id: SID })
    expect(onNativeSession).toHaveBeenCalledTimes(1)
    expect(onNativeSession).toHaveBeenCalledWith({ cliSessionId: SID })
    expect(state.updateClaudeRun).toHaveBeenCalledWith('claude-run-test', { cliSessionId: SID })
    emit({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5' }, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SID })
    await vi.waitFor(() => expect(callbackSet.onDone).toHaveBeenCalledTimes(1))
    expect(onNativeSession).toHaveBeenCalledTimes(1)
  })

  it('an event without a session id links nothing; a dispatch never links', async () => {
    const onNativeSession = vi.fn()
    await run('work-link-2', {}, callbacks({ onNativeSession }))
    emit({ type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'init', session_id: '' })
    expect(onNativeSession).not.toHaveBeenCalled()
    const dispatched = vi.fn()
    await run('work-link-3', { dispatch: { restricted: true, tools: ['Read'] } }, callbacks({ onNativeSession: dispatched }))
    emit({ type: 'system', subtype: 'init', session_id: SID })
    expect(dispatched).not.toHaveBeenCalled()
  })
})
