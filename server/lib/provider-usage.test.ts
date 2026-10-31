// 6.97.0: the pure readers behind the audit's real usage. Every number in the probe fixtures below was
// printed by a real CLI on 2026-10-31 (claude 2.1.316, codex-cli 0.166.0-alpha.5.1, Haiku 5.5 and
// gpt-6-astra, in a scratch directory). They are here because the obvious reading of each is wrong.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ClaudeRunUsage, CodexRunUsage, SideRunTap, _resetCodexThreadTotalsForTest, cleanProviderId, normalizeRealUsage, readOneShotUsage,
} from './provider-usage.js'

const HAIKU = 'claude-haiku-5-5'
const row = (inputTokens: number, outputTokens: number, read: number, write: number, costUSD: number) => ({
  inputTokens, outputTokens, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD,
  cacheCreationEphemeral1hInputTokens: write, cacheCreationEphemeral5mInputTokens: 0,
})
const turn = (input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number) =>
  ({ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens })
const result = (over: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, result: 'THE ANSWER', session_id: 'sess-1', ...over })

// One process, two user messages (`--input-format stream-json`): the totals run on, the since field does not.
const STEER_1 = result({ uuid: 'r1', usage: turn(2, 4, 0, 533), total_cost_usd: 0.0001088, modelUsage: { [HAIKU]: row(2, 4, 0, 533, 0.0001088) }, model_usage_since_last_result: { [HAIKU]: row(2, 4, 0, 533, 0.0001088) } })
const STEER_2 = result({ uuid: 'r2', usage: turn(2, 5, 0, 566), total_cost_usd: 0.0002247, modelUsage: { [HAIKU]: row(4, 9, 0, 1099, 0.0002247) }, model_usage_since_last_result: { [HAIKU]: row(2, 5, 0, 566, 0.0001159) } })
// `--resume`, stream-json: the first result of the process already carries the earlier turns.
const RESUMED_STREAM = result({ uuid: 'r3', usage: turn(2, 5, 542, 60), total_cost_usd: 0.00024552, modelUsage: { [HAIKU]: row(6, 15, 542, 1160, 0.00024552) }, model_usage_since_last_result: { [HAIKU]: row(2, 5, 542, 60, 2.012e-05) } })
// `--resume`, `--output-format json`: no since field at all, and the totals still carry earlier turns.
const RESUMED_JSON = result({ uuid: 'r4', usage: turn(2, 6, 0, 567), total_cost_usd: 0.0002254, modelUsage: { [HAIKU]: row(4, 10, 0, 1100, 0.0002254) } })
// Fresh, `--output-format json`: no since field, and the totals are this one call.
const FRESH_JSON = result({ uuid: 'r5', usage: turn(2, 4, 0, 533), total_cost_usd: 0.0001088, modelUsage: { [HAIKU]: row(2, 4, 0, 533, 0.0001088) } })
// Codex on one thread: exec, then exec resume twice. The rollout's last_token_usage says each turn's
// input was 19,610, 19,629 and 19,648, so these are running totals.
const CODEX_1 = { type: 'turn.completed', usage: { input_tokens: 19610, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }
const CODEX_2 = { type: 'turn.completed', usage: { input_tokens: 39239, cached_input_tokens: 19456, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } }
const CODEX_3 = { type: 'turn.completed', usage: { input_tokens: 58887, cached_input_tokens: 38912, cache_write_input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 0 } }

function hostile(): Record<string, unknown> {
  const event: Record<string, unknown> = { type: 'result' }
  Object.defineProperty(event, 'usage', { enumerable: true, get() { throw new Error('boom') } })
  return event
}
const MALFORMED: unknown[] = [
  null, undefined, 7, 'text', [], {}, { type: 'result' }, hostile(),
  result({ usage: 'garbage', modelUsage: 'garbage', total_cost_usd: 'free' }),
  result({ usage: null, modelUsage: null, model_usage_since_last_result: null }),
  result({ usage: { input_tokens: -1, output_tokens: 2 } }),
  result({ usage: { input_tokens: 1.5, output_tokens: 2 } }),
  result({ usage: { input_tokens: '12', output_tokens: 2 } }),
  result({ usage: { input_tokens: 12 } }),
  result({ usage: { input_tokens: 0, output_tokens: 0 } }),
  result({ usage: { input_tokens: Number.MAX_VALUE, output_tokens: 2 } }),
  result({ model_usage_since_last_result: { x: 'not a row' }, modelUsage: [1, 2] }),
  result({ model_usage_since_last_result: { x: { inputTokens: 1 } } }),
]

describe('normalizeRealUsage: what may be called measured', () => {
  it('needs real input and output counts, and something actually used', () => {
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 0 })).toEqual({ inputTokens: 1, outputTokens: 0 })
    expect(normalizeRealUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 9 })).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 9 })
    for (const bad of [null, undefined, 3, {}, { inputTokens: 0, outputTokens: 0 }, { inputTokens: 5 }, { outputTokens: 5 }, { inputTokens: -1, outputTokens: 5 },
      { inputTokens: 1.5, outputTokens: 5 }, { inputTokens: Number.NaN, outputTokens: 5 }, { inputTokens: 1, outputTokens: 5, cacheReadTokens: -2 }, { inputTokens: 1, outputTokens: 5, cacheWriteTokens: 'x' }]) {
      expect(normalizeRealUsage(bad as any)).toBeNull()
    }
  })
  it('drops a bad cost or model without losing the counts; a stated 0 is kept', () => {
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, costUsd: -3, resolvedModel: 'two words' })).toEqual({ inputTokens: 1, outputTokens: 1 })
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, costUsd: Number.POSITIVE_INFINITY })).toEqual({ inputTokens: 1, outputTokens: 1 })
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0 })).toMatchObject({ costUsd: 0 })
  })
  it('keeps the 1h part only when it fits inside the writes', () => {
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 10, cacheWrite1hTokens: 10 })).toMatchObject({ cacheWrite1hTokens: 10 })
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 10, cacheWrite1hTokens: 11 })).not.toHaveProperty('cacheWrite1hTokens')
    expect(normalizeRealUsage({ inputTokens: 1, outputTokens: 1, cacheWrite1hTokens: 1 })).not.toHaveProperty('cacheWrite1hTokens')
  })
})

describe('cleanProviderId: no text can pass as an id', () => {
  it('takes real ids and slugs, refuses anything with a space, a newline or no shape', () => {
    for (const id of ['claude-haiku-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-sonnet-5.5', 'qwen3.8:27b', '01a00ab4-7350-74a3-bfac-743d1f129630']) expect(cleanProviderId(id)).toBe(id)
    for (const bad of ['the quarterly plan', 'a\nb', '', ' leading', 42, null, undefined, 'x'.repeat(129)]) expect(cleanProviderId(bad)).toBeUndefined()
  })
})

describe('ClaudeRunUsage', () => {
  it('a steered run counts each result once: the since fields add up, the running totals are not summed', () => {
    const run = new ClaudeRunUsage(false)
    run.observe(STEER_1)
    run.observe(STEER_2)
    const usage = run.take()!
    expect(usage).toMatchObject({ inputTokens: 4, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 1099, cacheWrite1hTokens: 1099, resolvedModel: HAIKU })
    expect(usage.costUsd).toBeCloseTo(0.0002247, 10)
  })
  it('a resumed run reports its own cost, 2.012e-05, not the session total of 0.00024552 that the same line prints', () => {
    const run = new ClaudeRunUsage(true)
    run.observe(RESUMED_STREAM)
    expect(run.take()).toEqual({ inputTokens: 2, outputTokens: 5, cacheReadTokens: 542, cacheWriteTokens: 60, cacheWrite1hTokens: 60, costUsd: 2.012e-05, resolvedModel: HAIKU })
  })
  it('a resumed run with no since field reports this turn\'s tokens and no cost: every cost it printed includes earlier turns', () => {
    const run = new ClaudeRunUsage(true)
    run.observe(RESUMED_JSON)
    const usage = run.take()!
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 567 })
    expect(usage).not.toHaveProperty('costUsd')
  })
  it('a fresh one-shot with no since field reads its totals, which are this call', () => {
    const run = new ClaudeRunUsage(false)
    run.observe(FRESH_JSON)
    expect(run.take()).toMatchObject({ inputTokens: 2, outputTokens: 4, cacheWriteTokens: 533, costUsd: 0.0001088, resolvedModel: HAIKU })
  })
  it('a fresh run on an older CLI reads the running totals once, as the latest, not the sum', () => {
    const run = new ClaudeRunUsage(false)
    const { model_usage_since_last_result: _a, ...first } = STEER_1 as Record<string, unknown>
    const { model_usage_since_last_result: _b, ...second } = STEER_2 as Record<string, unknown>
    run.observe(first)
    run.observe(second)
    expect(run.take()).toMatchObject({ inputTokens: 4, outputTokens: 9, cacheWriteTokens: 1099, costUsd: 0.0002247 })
    expect(run.take()).toBeNull()
  })
  it('on an older CLI, a result after the totals were read is not counted: the next total would repeat the first', () => {
    const run = new ClaudeRunUsage(false)
    const { model_usage_since_last_result: _a, ...first } = STEER_1 as Record<string, unknown>
    const { model_usage_since_last_result: _b, ...second } = STEER_2 as Record<string, unknown>
    run.observe(first)
    expect(run.take()).toMatchObject({ inputTokens: 2, outputTokens: 4 })
    run.observe(second)
    expect(run.take()).toBeNull()
  })
  it('the same result seen twice counts once', () => {
    const run = new ClaudeRunUsage(false)
    run.observe(STEER_1)
    run.observe(STEER_1)
    expect(run.take()).toMatchObject({ inputTokens: 2, outputTokens: 4 })
  })
  it('take() hands out each result once: a later result is reported alone, and an empty take is null', () => {
    const run = new ClaudeRunUsage(false)
    run.observe(STEER_1)
    expect(run.take()).toMatchObject({ inputTokens: 2, outputTokens: 4 })
    expect(run.take()).toBeNull()
    run.observe(STEER_2)
    expect(run.take()).toMatchObject({ inputTokens: 2, outputTokens: 5, cacheWriteTokens: 566, costUsd: 0.0001159 })
  })
  it('a result without the field beside one with it never mixes the two', () => {
    const run = new ClaudeRunUsage(true)
    const { model_usage_since_last_result: _dropped, ...second } = STEER_2 as Record<string, unknown>
    run.observe(STEER_1)
    run.observe(second)
    expect(run.take()).toMatchObject({ inputTokens: 4, outputTokens: 9, cacheWriteTokens: 1099 })
  })
  it('a zero cost beside real tokens is no cost: the CLI could not price them', () => {
    const run = new ClaudeRunUsage(false)
    run.observe(result({ total_cost_usd: 0, modelUsage: { 'claude-new-1': row(10, 10, 0, 0, 0) } }))
    expect(run.take()).not.toHaveProperty('costUsd')
  })
  it('names the model of the init event first, otherwise the one that did the most', () => {
    const two = result({ model_usage_since_last_result: { small: row(1, 1, 0, 0, 0.1), big: row(50, 50, 0, 0, 0.2) } })
    const named = new ClaudeRunUsage(false)
    named.observe({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 'sess-init' })
    named.observe(two)
    expect(named.take()).toMatchObject({ resolvedModel: 'claude-opus-5', inputTokens: 51 })
    const unnamed = new ClaudeRunUsage(false)
    unnamed.observe(two)
    expect(unnamed.take()).toMatchObject({ resolvedModel: 'big' })
  })
  it('session id: refuses text, and a result names the session over an earlier event', () => {
    const run = new ClaudeRunUsage(false)
    run.observe({ type: 'system', subtype: 'init', session_id: 'from-init' })
    expect(run.cliSessionId).toBe('from-init')
    run.observe({ type: 'result', session_id: 'free text the model said' })
    expect(run.cliSessionId).toBe('from-init')
    run.observe({ type: 'result', session_id: 'from-result' })
    expect(run.cliSessionId).toBe('from-result')
  })
  it('malformed usage of every shape: observe and take never throw, and nothing reads as measured', () => {
    for (const resumed of [false, true]) {
      for (const event of MALFORMED) {
        const run = new ClaudeRunUsage(resumed)
        expect(() => run.observe(event)).not.toThrow()
        expect(run.take()).toBeNull()
      }
    }
  })
})

describe('CodexRunUsage', () => {
  beforeEach(() => _resetCodexThreadTotalsForTest())
  const finish = (event: unknown, thread: string | undefined, resumedFrom: string | undefined) => {
    const run = new CodexRunUsage()
    run.observe(event)
    return run.finish(thread, resumedFrom)
  }

  it('input_tokens includes cached ones on Codex: the row subtracts them, so the counts stay separate', () => {
    expect(finish({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } }, 'thread-a', undefined))
      .toEqual({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 80 })
  })
  it('a resumed thread is charged its own turn, not the running total: 19,629 and 19,648 input, as the rollout says', () => {
    expect(finish(CODEX_1, 'thread-a', undefined)).toEqual({ inputTokens: 19610, outputTokens: 5, cacheReadTokens: 0 })
    expect(finish(CODEX_2, 'thread-a', 'thread-a')).toEqual({ inputTokens: 19629 - 19456, outputTokens: 5, cacheReadTokens: 19456 })
    expect(finish(CODEX_3, 'thread-a', 'thread-a')).toEqual({ inputTokens: 19648 - 19456, outputTokens: 5, cacheReadTokens: 19456 })
  })
  it('a resumed thread with no earlier total this server saw stays estimated, then the next turn is real', () => {
    expect(finish(CODEX_2, 'thread-b', 'thread-b')).toBeNull()
    expect(finish(CODEX_3, 'thread-b', 'thread-b')).toEqual({ inputTokens: 192, outputTokens: 5, cacheReadTokens: 19456 })
  })
  it('a total that went backwards is not a turn', () => {
    finish(CODEX_3, 'thread-c', undefined)
    expect(finish(CODEX_2, 'thread-c', 'thread-c')).toBeNull()
  })
  it('a total where only input went backwards is not a turn, though the other counts look fine', () => {
    finish({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 7 } }, 'thread-f', undefined)
    expect(finish({ type: 'turn.completed', usage: { input_tokens: 90, cached_input_tokens: 50, output_tokens: 9 } }, 'thread-f', 'thread-f')).toBeNull()
  })
  it('names the model COS passed on --model, since its stream names none', () => {
    const run = new CodexRunUsage('gpt-6-astra')
    run.observe(CODEX_1)
    expect(run.finish('thread-g', undefined)).toMatchObject({ resolvedModel: 'gpt-6-astra' })
    const resumed = new CodexRunUsage('gpt-6-astra')
    resumed.observe(CODEX_2)
    expect(resumed.finish('thread-g', 'thread-g')).toMatchObject({ resolvedModel: 'gpt-6-astra', inputTokens: 173 })
  })
  it('states no cost, and never a cache write', () => {
    expect(finish(CODEX_1, 'thread-d', undefined)).not.toHaveProperty('costUsd')
    expect(finish(CODEX_1, 'thread-e', undefined)).not.toHaveProperty('cacheWriteTokens')
  })
  it('malformed usage of every shape stays estimated and never throws', () => {
    const shapes: unknown[] = [...MALFORMED, { type: 'turn.completed' }, { type: 'turn.completed', usage: 'x' }, { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 1 } },
      { type: 'turn.completed', usage: { input_tokens: 1 } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 'x' } }, { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }]
    for (const event of shapes) {
      const run = new CodexRunUsage()
      expect(() => run.observe(event)).not.toThrow()
      expect(run.finish('thread-m', undefined)).toBeNull()
    }
  })
})

describe('readOneShotUsage', () => {
  beforeEach(() => _resetCodexThreadTotalsForTest())
  it('Claude: the one result object', () => {
    expect(readOneShotUsage('claude', JSON.stringify(FRESH_JSON) + '\n')).toEqual({
      realUsage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 533, cacheWrite1hTokens: 533, costUsd: 0.0001088, resolvedModel: HAIKU },
      cliSessionId: 'sess-1',
    })
  })
  it('Codex: JSON lines, cached split out', () => {
    const stdout = [{ type: 'thread.started', thread_id: 'thread-x' }, { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, CODEX_2].map(e => JSON.stringify(e)).join('\n')
    expect(readOneShotUsage('codex', stdout, 'gpt-6-astra')).toEqual({ realUsage: { inputTokens: 19783, outputTokens: 10, cacheReadTokens: 19456, resolvedModel: 'gpt-6-astra' }, cliSessionId: 'thread-x' })
  })
  it('Cursor: the session id only, whatever usage it prints', () => {
    const stdout = JSON.stringify({ type: 'result', session_id: 'chat-1', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 9 } })
    expect(readOneShotUsage('cursor', stdout)).toEqual({ cliSessionId: 'chat-1' })
  })
  it('anything else reads as nothing, and never throws', () => {
    for (const provider of ['claude', 'codex', 'cursor'] as const) {
      for (const stdout of ['', 'plain text', '{not json', '[1,2]', 'null', '{"type":"result","usage":"x"}']) expect(readOneShotUsage(provider, stdout)).toEqual({})
    }
    expect(readOneShotUsage('claude', undefined as any)).toEqual({})
  })
})

describe('SideRunTap', () => {
  const line = (e: unknown) => JSON.stringify(e) + '\n'
  it('Claude: reads a stream cut mid-line, reports this run only, and sees the end', () => {
    const tap = new SideRunTap('claude')
    const text = line({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's' }) + line(RESUMED_STREAM)
    tap.feed(text.slice(0, 40))
    tap.feed(Buffer.from(text.slice(40)))
    expect(tap.sawEnd).toBe(true)
    expect(tap.outputChars).toBe('THE ANSWER'.length)
    expect(tap.finish()).toMatchObject({ inputTokens: 2, costUsd: 2.012e-05, resolvedModel: 'claude-opus-5' })
  })
  it('a last line with no newline still counts, once', () => {
    const tap = new SideRunTap('claude')
    tap.feed(JSON.stringify(RESUMED_STREAM))
    expect(tap.sawEnd).toBe(false)
    expect(tap.finish()).toMatchObject({ inputTokens: 2 })
    expect(tap.sawEnd).toBe(true)
    expect(tap.finish()).toBeNull()
  })
  it('a thread\'s running totals never count, on a CLI with no per-result field: tokens of this turn, no cost', () => {
    const tap = new SideRunTap('claude')
    tap.feed(line(RESUMED_JSON))
    const usage = tap.finish()!
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 6, cacheWriteTokens: 567 })
    expect(usage).not.toHaveProperty('costUsd')
  })
  it('Codex stays estimated on a thread the user also runs elsewhere: chars only', () => {
    const tap = new SideRunTap('codex')
    tap.feed(line({ type: 'item.completed', item: { type: 'agent_message', text: 'FORKED' } }) + line(CODEX_3))
    expect(tap.finish()).toBeNull()
    expect(tap.outputChars).toBe(6)
    expect(tap.sawEnd).toBe(true)
  })
  it('Cursor stays estimated, whatever usage it prints', () => {
    const tap = new SideRunTap('cursor')
    tap.feed(line({ type: 'result', result: 'done', usage: { inputTokens: 9, outputTokens: 9 } }))
    expect(tap.finish()).toBeNull()
    expect(tap.outputChars).toBe(4)
  })
  it('junk never throws; a stdout that refuses a listener costs only the tap', () => {
    const tap = new SideRunTap('claude')
    for (const chunk of ['{"type":"result"', '\n', 'not json\n', '{"type":"result",\n', null, 7, Symbol('x') as any]) expect(() => tap.feed(chunk)).not.toThrow()
    expect(() => tap.attach({ on: () => { throw new Error('no listeners') } })).not.toThrow()
    expect(() => tap.attach(null)).not.toThrow()
    expect(tap.finish()).toBeNull()
  })
  it('skips lines that cannot carry usage without parsing them', () => {
    const tap = new SideRunTap('claude')
    tap.feed('{"type":"assistant","note":"not valid json on purpose"\n')
    expect(tap.sawEnd).toBe(false)
  })
})
