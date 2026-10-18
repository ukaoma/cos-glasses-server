// 6.78.0 Messages steer: the Claude bridge's thin wiring, against a FakeChild (no CLI, no
// spawn). The protocol decisions are claude-steer.ts's; this proves the bridge applies them:
// the two flags, one JSON first line with stdin left open, coverage before finishing, the
// settle window (with the inactivity timer paused), the second-turn separator, the checkpoint
// on the wall clock, and stdin closed plus a reaper on every terminal path.
//
// node:fs is mocked for /tmp/cos-cli-sessions.json only (see the off-identity test).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ child: null as any, spawnArgs: [] as string[][], terminate: null as any }))
const CLI_SESSIONS = '/tmp/cos-cli-sessions.json'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const guard = (path: unknown) => String(path) === CLI_SESSIONS
  return {
    ...actual,
    existsSync: (path: any) => guard(path) ? false : actual.existsSync(path),
    unlinkSync: (path: any) => { if (guard(path)) throw new Error('test refused to unlink the live CLI session file'); return actual.unlinkSync(path) },
    writeFileSync: (path: any, ...rest: any[]) => guard(path) ? undefined : (actual.writeFileSync as any)(path, ...rest),
    readFileSync: (path: any, ...rest: any[]) => guard(path) ? '{}' : (actual.readFileSync as any)(path, ...rest),
  }
})
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writable: true })
    pid = 4242
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
  finishClaudeRun: vi.fn(),
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-identity' }),
  updateClaudeRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({ claudeToolInputPreview: () => undefined, claudeToolResultPreviewLines: () => [] }))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => {
  state.terminate = vi.fn(async () => ({ closed: true, code: null }))
  return { terminateProviderProcess: (...args: unknown[]) => state.terminate(...args) }
})
vi.mock('./claude-cli-support.js', () => ({ claudeSupportsSessionName: vi.fn(async () => true) }))

import { callClaudeStreaming } from './claude-bridge.js'
import { SteerPort } from './claude-steer.js'

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/pi-durable/claude-bridge-off-6.77.0.json'), 'utf8'))
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function events() {
  return { onIncluded: vi.fn(), onDelivered: vi.fn(), onFolded: vi.fn(), onCheckpoint: vi.fn() }
}

function callbacks() {
  return {
    onChunk: vi.fn(), onDone: vi.fn(async () => true), onError: vi.fn(async () => true),
    onAnswerReady: vi.fn(async () => true), onProviderProcess: vi.fn(async () => true), onToolStatus: vi.fn(),
  } as any
}

let session = 0
async function run(port: SteerPort | undefined, options: Record<string, unknown> = {}, query = 'Read the README.', model: 'haiku' | 'opus' = 'haiku') {
  const cb = callbacks()
  session++
  await callClaudeStreaming(query, `steer-bridge-${session}`, cb, model, undefined, undefined, undefined, { lightweight: true, ...(port ? { steer: port } : {}), ...options } as any)
  // onProviderProcess is awaited before the first write.
  await vi.waitFor(() => expect(state.child.stdin.write).toHaveBeenCalled())
  const raw = state.child.stdin.write.mock.calls[0][0] as string
  const first = port ? JSON.parse(raw) : raw
  return { cb, args: state.spawnArgs.at(-1)!, child: state.child, prompt: (port ? first.uuid : '') as string, first }
}

function emit(child: any, ...lines: unknown[]) {
  child.stdout.emit('data', Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'))
}
const text = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
const result = (uuids?: string[], extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '', ...(uuids ? { user_message_uuids: uuids } : {}), ...extra })

beforeEach(() => { state.terminate.mockClear() })
afterEach(() => { vi.useRealTimers(); state.child = null })

describe('steer mode: the spawn', () => {
  it('appends exactly --input-format stream-json --replay-user-messages, writes one JSON line, and leaves stdin open', async () => {
    const { args, child, first } = await run(new SteerPort(), {}, 'What changed on the page this week?', 'opus')
    expect(args).toEqual([...GOLDEN.scenarios.plain.args, '--input-format', 'stream-json', '--replay-user-messages'])
    expect(first).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: GOLDEN.scenarios.plain.stdinWrites[0] } })
    expect(child.stdin.write).toHaveBeenCalledTimes(1)
    expect(child.stdin.end).not.toHaveBeenCalled()
  })

  it('the prompt line carries the job\'s turn id as its uuid', async () => {
    const turnId = '0e5a9c1d-3333-4333-8333-000000000001'
    const { prompt } = await run(new SteerPort(), { turnId })
    expect(prompt).toBe(turnId)
    const other = await run(new SteerPort(), { turnId: 'not-a-uuid' })
    expect(other.prompt).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a dispatch never steers: a port is ignored and the spawn is the 6.77.0 one', async () => {
    const cb = callbacks()
    await callClaudeStreaming('Summarize the task file.', 'steer-bridge-dispatch', cb, 'sonnet', undefined, undefined, undefined, {
      lightweight: true, dispatch: { restricted: true, tools: ['Read', 'Grep', 'Glob'] }, steer: new SteerPort(),
    } as any)
    await vi.waitFor(() => expect(state.child.stdin.end).toHaveBeenCalled())
    expect(state.spawnArgs.at(-1)).toEqual(GOLDEN.scenarios.dispatch.args)
    expect(state.child.stdin.write.mock.calls.map((c: unknown[]) => c[0])).toEqual(GOLDEN.scenarios.dispatch.stdinWrites)
  })

  it('steers offered before the first line ride in it; one offered while it is written goes right behind it', async () => {
    const port = new SteerPort(events())
    port.offer({ steerId: B, text: 'keep it short' })
    const { first, child } = await run(port)
    expect(first.message.content).toContain('Read the README.')
    expect(first.message.content).toContain('- keep it short')
    expect(port.events.onIncluded).toHaveBeenCalledWith([{ steerId: B, text: 'keep it short' }])
    expect(port.offer({ steerId: C, text: 'and the tests' })).toBe('written')
    expect(JSON.parse(child.stdin.write.mock.calls[1][0])).toMatchObject({ uuid: C, message: { content: 'and the tests' } })
  })
})

describe('steer mode: finishing only on coverage (ST-1)', () => {
  it('a fold: the echo is a delivery, the covering result finishes, folds, closes stdin and the port', async () => {
    const port = new SteerPort(events())
    const { cb, child, prompt } = await run(port)
    expect(port.offer({ steerId: B, text: 'also the tests' })).toBe('written')
    emit(child, { type: 'user', uuid: prompt, isReplay: true }, text('Reading. '), { type: 'user', uuid: B, isReplay: true }, text('ALPHA BRAVO'))
    expect(port.events.onDelivered).toHaveBeenCalledWith(B)
    emit(child, result([prompt, B]))
    await vi.waitFor(() => expect(cb.onAnswerReady).toHaveBeenCalledWith('Reading. ALPHA BRAVO'))
    expect(port.events.onFolded).toHaveBeenCalledWith([B])
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    expect(port.isClosed).toBe(true)
    expect(port.offer({ steerId: C, text: 'late' })).toBe('closed')
  })

  it('a result that covers nothing ("now"-style, empty) does not finish', async () => {
    const port = new SteerPort(events())
    const { cb, child } = await run(port)
    port.offer({ steerId: B, text: 'x' })
    emit(child, result([]))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cb.onAnswerReady).not.toHaveBeenCalled()
    expect(port.events.onCheckpoint).not.toHaveBeenCalled()
    expect(child.stdin.end).not.toHaveBeenCalled()
  })

  it('a second turn: checkpoint at the first result, a separator before its text, finish when it covers the steer', async () => {
    const port = new SteerPort(events())
    const { cb, child, prompt } = await run(port)
    port.offer({ steerId: B, text: 'and the tests' })
    emit(child, text('First answer.'), result([prompt]))
    expect(port.events.onCheckpoint).toHaveBeenCalledWith('First answer.')
    expect(cb.onAnswerReady).not.toHaveBeenCalled()
    emit(child, text('Tests pass.'), result([B]))
    await vi.waitFor(() => expect(cb.onAnswerReady).toHaveBeenCalledWith('First answer.\n\nTests pass.'))
    expect(cb.onChunk.mock.calls.map((c: unknown[]) => c[0])).toEqual(['First answer.', '\n\n', 'Tests pass.'])
    expect(port.events.onFolded).toHaveBeenCalledWith([B])
  })

  it('a result without user_message_uuids turns steering off: finish on it', async () => {
    const port = new SteerPort(events())
    const { cb, child } = await run(port)
    port.offer({ steerId: B, text: 'x' })
    emit(child, text('Done.'), result(undefined))
    await vi.waitFor(() => expect(cb.onAnswerReady).toHaveBeenCalledWith('Done.'))
    expect(port.isClosed).toBe(true)
  })

  it('an error result after the checkpoint goes the error path (the store then completes with the checkpoint)', async () => {
    const port = new SteerPort(events())
    const { cb, child, prompt } = await run(port)
    port.offer({ steerId: B, text: 'x' })
    emit(child, text('Whole.'), result([prompt]), result([B], { subtype: 'error_during_execution', is_error: true, result: 'boom' }))
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalled())
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
  })
})

describe('steer mode: timers', () => {
  it('the settle window pauses the inactivity timer, then closes stdin; the close finishes with what it has', async () => {
    vi.useFakeTimers()
    const port = new SteerPort(events())
    const pending = run(port)
    await vi.advanceTimersByTimeAsync(0)
    const { cb, child, prompt } = await pending
    port.offer({ steerId: B, text: 'x' })
    emit(child, text('Whole.'), result([prompt]))
    // Haiku's inactivity limit is 15 s; the settle window is 20 s and owns this quiet.
    await vi.advanceTimersByTimeAsync(16_000)
    expect(state.terminate).not.toHaveBeenCalled()
    expect(child.stdin.end).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_100)
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onAnswerReady).toHaveBeenCalledWith('Whole.')
  })

  it('output during the settle window resets it', async () => {
    vi.useFakeTimers()
    const port = new SteerPort(events())
    const pending = run(port)
    await vi.advanceTimersByTimeAsync(0)
    const { child, prompt } = await pending
    port.offer({ steerId: B, text: 'x' })
    emit(child, text('Whole.'), result([prompt]))
    await vi.advanceTimersByTimeAsync(15_000)
    emit(child, text('Second turn going.'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(child.stdin.end).not.toHaveBeenCalled()
  })

  it('a finished run whose child has not exited is terminated by the reaper at 15 s; one that exits is not', async () => {
    vi.useFakeTimers()
    const port = new SteerPort(events())
    const pending = run(port)
    await vi.advanceTimersByTimeAsync(0)
    const { child, prompt } = await pending
    emit(child, text('Done.'), result([prompt]))
    await vi.advanceTimersByTimeAsync(14_900)
    expect(state.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(state.terminate).toHaveBeenCalledTimes(1)

    const port2 = new SteerPort(events())
    const pending2 = run(port2)
    await vi.advanceTimersByTimeAsync(0)
    const second = await pending2
    emit(second.child, text('Done.'), result([second.prompt]))
    second.child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(state.terminate).toHaveBeenCalledTimes(1)
  })

  it('the wall clock after the first whole answer finishes with the checkpoint, not the half second turn', async () => {
    vi.useFakeTimers()
    const port = new SteerPort(events())
    const pending = run(port)
    await vi.advanceTimersByTimeAsync(0)
    const { cb, child, prompt } = await pending
    port.offer({ steerId: B, text: 'x' })
    emit(child, text('Whole.'), result([prompt]), text('half of a second'))
    // Keep output flowing so neither inactivity nor settle decides, then hit the 60 s wall.
    for (let t = 0; t < 61; t += 5) { emit(child, text('.')); await vi.advanceTimersByTimeAsync(5_000) }
    await vi.advanceTimersByTimeAsync(0)
    expect(state.terminate).toHaveBeenCalled()
    await vi.waitFor(() => expect(cb.onAnswerReady).toHaveBeenCalledWith('Whole.'))
  })

  it('without a port the bridge never waits: the first result finishes, as in 6.77.0', async () => {
    const { cb, child } = await run(undefined)
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    emit(child, text('Done.'), result([]))
    await vi.waitFor(() => expect(cb.onAnswerReady).toHaveBeenCalledWith('Done.'))
  })
})

describe('steer mode: a stdin that cannot take a line', () => {
  it('closes the port, so the coordinator journals too_late', async () => {
    const port = new SteerPort(events())
    const { child } = await run(port)
    child.stdin.writable = false
    expect(port.offer({ steerId: B, text: 'x' })).toBe('closed')
  })
})
