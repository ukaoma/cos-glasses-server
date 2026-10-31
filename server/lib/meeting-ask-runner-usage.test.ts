// 6.97.0: runMeetingAskModel records what the provider reported. A real /bin/sh child prints scratch
// fixtures through the Ask's own parser, so the answer path is the production one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => vi.fn())
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: vi.fn(() => ({ ok: true, path: '/bin/sh' })) }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: audit }))

import { AskProcessError, runMeetingAskModel } from './meeting-ask-runner.js'

const CLAUDE = { engine: 'claude', model: 'haiku' } as const
const CODEX = { engine: 'codex', model: 'gpt-6-astra' } as const
const ANSWER = 'SECRET ANSWER WORDS'
const claudeOut = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: ANSWER, session_id: 'ask-session-1', uuid: 'u1',
  usage: { input_tokens: 2, cache_creation_input_tokens: 533, cache_read_input_tokens: 10, output_tokens: 4 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 10, cacheCreationInputTokens: 533, costUSD: 0.0001 } },
  total_cost_usd: 0.0001, ...over,
})

let workspace = ''
function ask(model: typeof CLAUDE | typeof CODEX, stdout: string, exitCode = 0, audited?: { caller: string }) {
  writeFileSync(join(workspace, 'out.txt'), stdout)
  return runMeetingAskModel(model, '', '', undefined, { workspace, args: ['-c', `cat >/dev/null; cat out.txt; exit ${exitCode}`], stdin: 'SECRET QUESTION' }, audited)
}
const row = () => { expect(audit).toHaveBeenCalledTimes(1); return audit.mock.calls[0]![0] as Record<string, any> }

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'cos-ask-usage-')); audit.mockClear() })
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('runMeetingAskModel records real usage', () => {
  it('Claude: tokens, cost, resolved model and session, with the answer unchanged', async () => {
    const run = await ask(CLAUDE, claudeOut())
    expect(run).toEqual({ text: ANSWER, model: 'claude-haiku-5-5', usage: { inputTokens: 545, cachedInputTokens: 10, outputTokens: 4, costUsd: 0.0001 } })
    expect(row()).toMatchObject({
      source: 'meeting-ask-web', model: 'claude:claude-haiku-5-5', cliSessionId: 'ask-session-1',
      realUsage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 533, costUsd: 0.0001, resolvedModel: 'claude-haiku-5-5' },
    })
  })
  it('Codex: cached tokens come out of input, and there is no cost', async () => {
    const stdout = [
      { type: 'thread.started', thread_id: 'ask-thread-1' },
      { type: 'item.completed', item: { type: 'agent_message', text: ANSWER } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } },
    ].map(e => JSON.stringify(e)).join('\n')
    const run = await ask(CODEX, stdout)
    expect(run.text).toBe(ANSWER)
    expect(row()).toMatchObject({ cliSessionId: 'ask-thread-1', realUsage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 7 } })
    expect(row().realUsage).not.toHaveProperty('costUsd')
  })
  it('keeps the caller label a failed-usage read could not touch', async () => {
    await ask(CLAUDE, claudeOut(), 0, { caller: 'meeting_fact_check_planner' })
    expect(row().caller).toBe('meeting_fact_check_planner')
  })
})

describe('a bad usage block changes nothing the caller sees', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['strings', { usage: 'garbage', modelUsage: 'garbage', total_cost_usd: 'free' }],
    ['null', { usage: null, modelUsage: null }],
    ['negative', { usage: { input_tokens: -5, output_tokens: 2 }, modelUsage: { m: { inputTokens: -1, outputTokens: 2 } } }],
    ['empty', { usage: {}, modelUsage: {} }],
  ]
  it.each(BAD)('%s: same answer, one row, estimated', async (_name, over) => {
    const run = await ask(CLAUDE, claudeOut(over))
    expect(run.text).toBe(ANSWER)
    expect(row()).not.toHaveProperty('realUsage')
    expect(row().outputChars).toBe(ANSWER.length)
  })
  it('an answer that fails its parse rejects as before, and the row keeps what it can prove', async () => {
    await expect(ask(CLAUDE, claudeOut({ is_error: true, subtype: 'error_during_execution' }))).rejects.toMatchObject({ message: 'invalid_provider_answer' })
    expect(row()).toMatchObject({ outputChars: 0, realUsage: { inputTokens: 2, outputTokens: 4 } })
  })
  it('a non-zero exit rejects as before, with one row and no made-up usage', async () => {
    await expect(ask(CLAUDE, 'not json', 3)).rejects.toBeInstanceOf(AskProcessError)
    expect(row()).not.toHaveProperty('realUsage')
  })
})

describe('no prompt or answer text reaches the audit', () => {
  it('holds for the question, the answer, and text in an id field', async () => {
    await ask(CLAUDE, claudeOut({ session_id: 'SECRET ANSWER WORDS as an id' }))
    const written = JSON.stringify(row())
    expect(written).not.toContain('SECRET')
    expect(row()).not.toHaveProperty('cliSessionId')
  })
})
