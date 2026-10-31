// 6.97.0: runLensGistEngine, which also serves cues and transcript cleanup, records what the provider
// reported. A real child process stands in for each CLI, from a scratch script. Answers are compared
// with and without a usable usage block, so a bad one cannot change what the caller gets.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => vi.fn())
const binary = vi.hoisted(() => ({ path: '' }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: audit }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: binary.path }) }))

import { LensGistLimitError, runLensGistEngine } from './lens-gist-engines.js'
import { _setOllamaCatalogFetchForTests } from './ollama-catalog.js'

const OPTS = { timeoutMs: 10_000, system: 'SECRET SYSTEM PROMPT' }
const PROMPT = 'SECRET PROMPT WORDS'
const ANSWER = 'SECRET ANSWER WORDS'
const claudeOut = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: ANSWER, session_id: 'gist-session-1',
  usage: { input_tokens: 2, cache_creation_input_tokens: 644, cache_read_input_tokens: 100, output_tokens: 12 },
  modelUsage: { 'claude-sonnet-5': { inputTokens: 2, outputTokens: 12, cacheReadInputTokens: 100, cacheCreationInputTokens: 644, cacheCreationEphemeral1hInputTokens: 644, costUSD: 0.0027 } },
  total_cost_usd: 0.0027, ...over,
})
const codexOut = (usage: unknown) => [
  { type: 'thread.started', thread_id: 'gist-thread-1' },
  { type: 'item.completed', item: { type: 'agent_message', text: ANSWER } },
  { type: 'turn.completed', usage },
].map(e => JSON.stringify(e)).join('\n')

let dir = ''
function cli(stdout: string, exitCode = 0) {
  writeFileSync(join(dir, 'out.txt'), stdout)
  const script = join(dir, 'fake-cli')
  writeFileSync(script, `#!/bin/sh\ncat >/dev/null\ncat "${join(dir, 'out.txt')}"\nexit ${exitCode}\n`)
  chmodSync(script, 0o755)
  binary.path = script
}
const row = () => { expect(audit).toHaveBeenCalledTimes(1); return audit.mock.calls[0]![0] as Record<string, any> }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-gist-usage-')); audit.mockClear() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('runLensGistEngine records real usage', () => {
  it('Claude: the four counts separate, its cost, the resolved model and the session', async () => {
    cli(claudeOut())
    const run = await runLensGistEngine('claude', 'sonnet', PROMPT, OPTS)
    expect(run.text).toBe(ANSWER)
    expect(row()).toMatchObject({
      source: 'g2-lens-gist', caller: 'lens_gist', model: 'claude:claude-sonnet-5', cliSessionId: 'gist-session-1',
      realUsage: { inputTokens: 2, outputTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 644, cacheWrite1hTokens: 644, costUsd: 0.0027, resolvedModel: 'claude-sonnet-5' },
    })
  })
  it('the same runner serves cues and cleanup, under their own source', async () => {
    cli(claudeOut())
    await runLensGistEngine('claude', 'sonnet', PROMPT, { ...OPTS, source: 'live-cues-v2' })
    expect(row()).toMatchObject({ source: 'live-cues-v2', caller: 'live-cues-v2', realUsage: { inputTokens: 2 } })
  })
  it('Codex: its input includes cached tokens, so the row subtracts them. No cost', async () => {
    cli(codexOut({ input_tokens: 19629, cached_input_tokens: 19456, output_tokens: 5 }))
    const run = await runLensGistEngine('codex', 'gpt-6-astra', PROMPT, OPTS)
    expect(run.text).toBe(ANSWER)
    expect(run.usage).toEqual({ inputTokens: 19629, cachedInputTokens: 19456, outputTokens: 5 })
    expect(row()).toMatchObject({ cliSessionId: 'gist-thread-1', realUsage: { inputTokens: 173, cacheReadTokens: 19456, outputTokens: 5 } })
    expect(row().realUsage).not.toHaveProperty('costUsd')
  })
  it('Cursor stays estimated even when it prints usage, and still names its chat', async () => {
    cli(JSON.stringify({ type: 'result', subtype: 'success', result: ANSWER, session_id: 'chat-1', usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 9 } }))
    const run = await runLensGistEngine('cursor', 'composer', PROMPT, OPTS)
    expect(run.text).toBe(ANSWER)
    expect(row()).toMatchObject({ cliSessionId: 'chat-1' })
    expect(row()).not.toHaveProperty('realUsage')
  })
  it('Ollama: its reply counts are real, with no cost', async () => {
    _setOllamaCatalogFetchForTests((async () => new Response(JSON.stringify({ response: ANSWER, prompt_eval_count: 300, eval_count: 20 }), { status: 200 })) as unknown as typeof fetch)
    try {
      await runLensGistEngine('ollama', 'qwen3.8:27b', PROMPT, OPTS)
      expect(row().realUsage).toEqual({ inputTokens: 300, outputTokens: 20, resolvedModel: 'qwen3.8:27b' })
    } finally {
      _setOllamaCatalogFetchForTests(null)
    }
  })
  it('Ollama without counts stays estimated', async () => {
    _setOllamaCatalogFetchForTests((async () => new Response(JSON.stringify({ response: ANSWER }), { status: 200 })) as unknown as typeof fetch)
    try {
      await runLensGistEngine('ollama', 'qwen3.8:27b', PROMPT, OPTS)
      expect(row()).not.toHaveProperty('realUsage')
    } finally {
      _setOllamaCatalogFetchForTests(null)
    }
  })
})

describe('a bad usage block changes nothing the caller sees', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['strings', { usage: 'garbage', modelUsage: 'garbage', total_cost_usd: 'free' }],
    ['null', { usage: null, modelUsage: null, total_cost_usd: null }],
    ['negative', { usage: { input_tokens: -5, output_tokens: 2 }, modelUsage: { m: { inputTokens: -5, outputTokens: 2 } } }],
    ['missing', { usage: undefined, modelUsage: undefined, total_cost_usd: undefined }],
    ['empty', { usage: {}, modelUsage: {} }],
  ]
  it.each(BAD)('Claude, %s: same answer, no failure, row estimated', async (_name, over) => {
    cli(claudeOut(over))
    const run = await runLensGistEngine('claude', 'sonnet', PROMPT, OPTS)
    expect(run.text).toBe(ANSWER)
    expect(row()).not.toHaveProperty('realUsage')
    expect(row().inputChars).toBe(PROMPT.length + OPTS.system.length)
    expect(row().outputChars).toBe(ANSWER.length)
  })
  it.each([['a string', 'garbage'], ['negative', { input_tokens: -1, output_tokens: 1 }], ['missing output', { input_tokens: 1 }], ['null', null]])('Codex, %s: same answer, no failure, row estimated', async (_name, usage) => {
    cli(codexOut(usage))
    const run = await runLensGistEngine('codex', 'gpt-6-astra', PROMPT, OPTS)
    expect(run.text).toBe(ANSWER)
    expect(row()).not.toHaveProperty('realUsage')
  })
})

describe('a call that fails after using tokens', () => {
  it('rejects exactly as before and the row keeps what it used', async () => {
    cli(claudeOut({ is_error: true, subtype: 'error_during_execution', result: 'limit: usage limit reached' }), 1)
    await expect(runLensGistEngine('claude', 'sonnet', PROMPT, OPTS)).rejects.toBeInstanceOf(LensGistLimitError)
    expect(row()).toMatchObject({ outputChars: 0, realUsage: { inputTokens: 2, outputTokens: 12 } })
  })
  it('a timeout has no result to read: the row stays estimated', async () => {
    const script = join(dir, 'slow-cli')
    writeFileSync(script, '#!/bin/sh\nsleep 5\n')
    chmodSync(script, 0o755)
    binary.path = script
    await expect(runLensGistEngine('claude', 'sonnet', PROMPT, { ...OPTS, timeoutMs: 100 })).rejects.toThrow(/timed out/)
    expect(row()).not.toHaveProperty('realUsage')
  })
})

describe('no prompt or answer text reaches the audit', () => {
  it('holds even when the provider puts text in the id fields', async () => {
    cli(claudeOut({ session_id: 'SECRET ANSWER WORDS in the id', modelUsage: { 'SECRET ANSWER WORDS as a model': { inputTokens: 2, outputTokens: 12, costUSD: 0.1 } } }))
    await runLensGistEngine('claude', 'sonnet', PROMPT, OPTS)
    const written = JSON.stringify(row())
    expect(row().realUsage).toMatchObject({ inputTokens: 2, outputTokens: 12 })
    expect(row()).not.toHaveProperty('cliSessionId')
    expect(row().realUsage).not.toHaveProperty('resolvedModel')
    // `model` is the answer parser's first model key, as it was before 6.97.0.
    const { model: _existing, ...rest } = row()
    expect(JSON.stringify(rest)).not.toContain('SECRET')
    expect(written).not.toContain(PROMPT)
    expect(written).not.toContain(OPTS.system)
  })
})
