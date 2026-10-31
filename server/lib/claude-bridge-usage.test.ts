// 6.97.0: the Claude bridge's audit row, by execution against a fake child. The usage numbers are the
// ones claude 2.1.316 printed on 2026-10-31: the same line carries a turn's own cost and a session
// total, and only the first may be counted. The answer path must not notice any of this.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ child: null as any, spawnArgs: [] as string[][], terminate: null as any, audit: [] as Record<string, any>[] }))
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
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn((entry: Record<string, unknown>) => { state.audit.push(entry) }) }))
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
  startClaudeRun: () => ({ runId: 'claude-run-usage' }),
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

import { callClaudeStreaming, preWarmCLI } from './claude-bridge.js'
import { SteerPort } from './claude-steer.js'

const HAIKU = 'claude-haiku-5-5'
const row = (inputTokens: number, outputTokens: number, read: number, write: number, costUSD: number) => ({ inputTokens, outputTokens, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD })
const usage = (input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number) => ({ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens })
const result = (over: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, result: 'SECRET RESULT WORDS', session_id: 'cli-usage-1', ...over })
const STEER_1 = (extra: Record<string, unknown> = {}) => result({ uuid: 'r1', usage: usage(2, 4, 0, 533), total_cost_usd: 0.0001088, modelUsage: { [HAIKU]: row(2, 4, 0, 533, 0.0001088) }, model_usage_since_last_result: { [HAIKU]: row(2, 4, 0, 533, 0.0001088) }, ...extra })
const STEER_2 = (extra: Record<string, unknown> = {}) => result({ uuid: 'r2', usage: usage(2, 5, 0, 566), total_cost_usd: 0.0002247, modelUsage: { [HAIKU]: row(4, 9, 0, 1099, 0.0002247) }, model_usage_since_last_result: { [HAIKU]: row(2, 5, 0, 566, 0.0001159) }, ...extra })
const RESUMED = result({ uuid: 'r3', usage: usage(2, 5, 542, 60), total_cost_usd: 0.00024552, modelUsage: { [HAIKU]: row(6, 15, 542, 1160, 0.00024552) }, model_usage_since_last_result: { [HAIKU]: row(2, 5, 542, 60, 2.012e-05) } })
const text = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })

function callbacks() {
  return {
    onChunk: vi.fn(), onDone: vi.fn(async () => true), onError: vi.fn(async () => true),
    onAnswerReady: vi.fn(async () => true), onProviderProcess: vi.fn(async () => true), onToolStatus: vi.fn(),
  } as any
}
function emit(child: any, ...lines: unknown[]) { child.stdout.emit('data', Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n')) }

let n = 0
async function start(options: Record<string, unknown> = {}, sid = `usage-${++n}`) {
  const cb = callbacks()
  await callClaudeStreaming('SECRET PROMPT WORDS', sid, cb, 'haiku', undefined, undefined, undefined, { lightweight: true, ...options } as any)
  await vi.waitFor(() => expect(state.child.stdin.write).toHaveBeenCalled())
  const child = state.child
  const first = options.steer ? JSON.parse(child.stdin.write.mock.calls[0][0]).uuid as string : ''
  return { cb, child, first, sid }
}
const finished = (cb: any) => vi.waitFor(() => expect(cb.onDone).toHaveBeenCalledTimes(1))

beforeEach(() => { state.audit.length = 0; state.spawnArgs.length = 0 })
afterEach(() => { state.child = null })

describe('a fresh run', () => {
  it('writes real usage, its own run id and the CLI session, with the answer untouched', async () => {
    const { cb, child } = await start()
    emit(child, text('The answer.'), STEER_1())
    await finished(cb)
    expect(cb.onDone.mock.calls[0][0]).toBe('The answer.')
    expect(cb.onError).not.toHaveBeenCalled()
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).toMatchObject({
      source: 'g2-voice', caller: 'voice_query', model: 'haiku', outputChars: 'The answer.'.length, runId: 'claude-run-usage', cliSessionId: 'cli-usage-1',
      realUsage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 533, costUsd: 0.0001088, resolvedModel: HAIKU },
    })
  })
  it('the init event names the model the provider ran', async () => {
    const { cb, child } = await start()
    emit(child, { type: 'system', subtype: 'init', model: 'claude-haiku-resolved', session_id: 'cli-usage-1' }, text('Done.'), STEER_1())
    await finished(cb)
    expect(state.audit[0]!.realUsage.resolvedModel).toBe('claude-haiku-resolved')
  })
  it('a last line with no newline counts, and counts once', async () => {
    const { cb, child } = await start()
    emit(child, text('Done.'))
    child.stdout.emit('data', Buffer.from(JSON.stringify(result({ usage: usage(7, 8, 0, 0), model_usage_since_last_result: { [HAIKU]: row(7, 8, 0, 0, 0.5) } }))))
    child.emit('close', 0)
    await finished(cb)
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]!.realUsage).toMatchObject({ inputTokens: 7, outputTokens: 8, costUsd: 0.5 })
  })
})

describe('a resumed run', () => {
  it('passes --resume and writes this turn\'s cost, 2.012e-05, never the session total on the same line', async () => {
    const sid = `usage-resume-${++n}`
    const firstRun = await start({}, sid)
    emit(firstRun.child, text('One.'), STEER_1())
    await finished(firstRun.cb)
    firstRun.child.emit('close', 0)
    state.audit.length = 0
    const second = await start({}, sid)
    expect(state.spawnArgs.at(-1)).toContain('--resume')
    emit(second.child, text('Two.'), RESUMED)
    await finished(second.cb)
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]!.realUsage).toEqual({ inputTokens: 2, outputTokens: 5, cacheReadTokens: 542, cacheWriteTokens: 60, costUsd: 2.012e-05, resolvedModel: HAIKU })
    expect(state.audit[0]!.cliSessionId).toBe('cli-usage-1')
  })
  it('on a CLI without the per-result field: this turn\'s tokens, and no cost at all', async () => {
    const sid = `usage-resume-${++n}`
    const firstRun = await start({}, sid)
    emit(firstRun.child, text('One.'), STEER_1())
    await finished(firstRun.cb)
    firstRun.child.emit('close', 0)
    state.audit.length = 0
    const second = await start({}, sid)
    const { model_usage_since_last_result: _dropped, ...older } = RESUMED as Record<string, unknown>
    emit(second.child, text('Two.'), older)
    await finished(second.cb)
    expect(state.audit[0]!.realUsage).toMatchObject({ inputTokens: 2, outputTokens: 5, cacheReadTokens: 542, cacheWriteTokens: 60 })
    expect(state.audit[0]!.realUsage).not.toHaveProperty('costUsd')
  })
})

describe('a steered run with several results', () => {
  it('counts each result once: the since fields add up, and the row is one row', async () => {
    const port = new SteerPort()
    const { cb, child, first } = await start({ steer: port })
    expect(port.offer({ steerId: '22222222-2222-4222-8222-222222222222', text: 'also the tests' })).toBe('written')
    emit(child, text('First part.'), STEER_1({ user_message_uuids: [first] }))
    await new Promise(r => setTimeout(r, 10))
    expect(cb.onDone).not.toHaveBeenCalled()
    expect(state.audit).toHaveLength(0)
    emit(child, text('Second part.'), STEER_2({ user_message_uuids: ['22222222-2222-4222-8222-222222222222'] }))
    await finished(cb)
    expect(state.audit).toHaveLength(1)
    const real = state.audit[0]!.realUsage
    expect(real).toMatchObject({ inputTokens: 4, outputTokens: 9, cacheWriteTokens: 1099 })
    expect(real.costUsd).toBeCloseTo(0.0002247, 10)
    expect(real.costUsd).not.toBeCloseTo(0.0001088 + 0.0002247, 10)
  })
  it('the same result delivered twice counts once', async () => {
    const { cb, child } = await start()
    emit(child, text('Done.'), STEER_1(), STEER_1())
    await finished(cb)
    expect(state.audit[0]!.realUsage).toMatchObject({ inputTokens: 2, outputTokens: 4 })
  })
  it('a result that comes after the row is written gets one row of its own, with only its own usage', async () => {
    const { cb, child } = await start()
    emit(child, text('Eight of twelve reported.'), STEER_1())
    await finished(cb)
    expect(state.audit).toHaveLength(1)
    emit(child, STEER_2())
    child.emit('close', 0)
    await new Promise(r => setTimeout(r, 10))
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onDone.mock.calls[0][0]).toBe('Eight of twelve reported.')
    expect(state.audit).toHaveLength(2)
    expect(state.audit[1]).toMatchObject({
      caller: 'voice_query:late_result', runId: 'claude-run-usage', inputChars: 0, outputChars: 0,
      realUsage: { inputTokens: 2, outputTokens: 5, cacheWriteTokens: 566, costUsd: 0.0001159 },
    })
    const total = state.audit[0]!.realUsage.inputTokens + state.audit[1]!.realUsage.inputTokens
    expect(total).toBe(4)
  })
  it('a run with nothing after its row writes no second row', async () => {
    const { cb, child } = await start()
    emit(child, text('Done.'), STEER_1())
    await finished(cb)
    child.emit('close', 0)
    await new Promise(r => setTimeout(r, 10))
    expect(state.audit).toHaveLength(1)
  })
})

describe('malformed usage changes nothing on this live path', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['strings', { usage: 'garbage', modelUsage: 'garbage', model_usage_since_last_result: 'garbage', total_cost_usd: 'free' }],
    ['null', { usage: null, modelUsage: null, model_usage_since_last_result: null, total_cost_usd: null }],
    ['negative', { usage: { input_tokens: -1, output_tokens: 1 }, modelUsage: { m: { inputTokens: -1, outputTokens: 1 } }, model_usage_since_last_result: { m: { inputTokens: -1, outputTokens: 1 } } }],
    ['arrays', { usage: [], modelUsage: [], model_usage_since_last_result: [1] }],
    ['empty', { usage: {}, modelUsage: {}, model_usage_since_last_result: {} }],
  ]
  it.each(BAD)('%s: same answer, no error, one row, estimated, ids still written', async (_name, over) => {
    const { cb, child } = await start()
    emit(child, text('The answer.'), result(over))
    await finished(cb)
    expect(cb.onDone.mock.calls[0][0]).toBe('The answer.')
    expect(cb.onError).not.toHaveBeenCalled()
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).not.toHaveProperty('realUsage')
    expect(state.audit[0]).toMatchObject({ runId: 'claude-run-usage', cliSessionId: 'cli-usage-1', outputChars: 'The answer.'.length })
  })
  it('no result usage at all: the same, as the bridge saw before 6.97.0', async () => {
    const { cb, child } = await start()
    emit(child, text('The answer.'), { type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: 'cli-usage-1' })
    await finished(cb)
    expect(cb.onDone.mock.calls[0][0]).toBe('The answer.')
    expect(state.audit[0]).not.toHaveProperty('realUsage')
  })
  it('an error result still fails the turn exactly as before, with no row', async () => {
    const { cb, child } = await start()
    emit(child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 'x', usage: usage(1, 1, 0, 0) })
    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalled())
    expect(cb.onDone).not.toHaveBeenCalled()
    expect(state.audit).toHaveLength(0)
  })
})

describe('no prompt or answer text reaches the audit', () => {
  it('holds for the prompt, the streamed answer, the result text and text in an id field', async () => {
    const { cb, child } = await start()
    emit(child, text('SECRET ANSWER WORDS'), STEER_1({ session_id: 'SECRET in an id' }))
    await finished(cb)
    expect(JSON.stringify(state.audit)).not.toContain('SECRET')
  })
})

describe('the boot pre-warm row', () => {
  it('reports what it used and its session, not just its fixed guess', async () => {
    const warm = preWarmCLI()
    await vi.waitFor(() => expect(state.child).not.toBeNull())
    emit(state.child, STEER_1({ session_id: 'cli-prewarm-1' }))
    state.child.emit('close', 0)
    await warm
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).toMatchObject({ source: 'g2-prewarm', caller: 'prewarm', cliSessionId: 'cli-prewarm-1', realUsage: { inputTokens: 2, outputTokens: 4 } })
  })
})
