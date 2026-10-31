// 6.97.0: warm dictation polish records what the provider reported, and polish's prompt_chars counts what
// the model is sent, while input_chars stays the words dictated. Real pipeline, real warm process machinery, with a scratch script as the Claude CLI.
// The cold path stays plain text and estimated: JSON there would add failures that feed the breaker.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SHARED = vi.hoisted(() => {
  const shared = { dataDir: process.env.COS_DATA_DIR, profile: process.env.COS_PROFILE_PATH }
  process.env.COS_DATA_DIR = `${shared.dataDir ?? '/tmp'}/private-polish-usage-${process.pid}-${Math.random().toString(36).slice(2)}`
  process.env.COS_PROFILE_PATH = `${process.env.COS_DATA_DIR}/.cos-profile.json`
  return shared
})
afterAll(() => {
  for (const [key, value] of [['COS_DATA_DIR', SHARED.dataDir], ['COS_PROFILE_PATH', SHARED.profile]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

const audit = vi.hoisted(() => vi.fn())
const binary = vi.hoisted(() => ({ path: '' }))
const coldCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: audit }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: binary.path }) }))
vi.mock('./whisper-local.js', () => ({ applyCorrections: (t: string) => t }))
vi.mock('./dictation-clean.js', async original => ({
  ...(await original<typeof import('./dictation-clean.js')>()),
  autoCleanDictation: vi.fn(async (text: string) => { coldCalls.count++; return `${text} Polished cold.` }),
}))

import { buildDictationPolishPrompt, DICTATION_POLISH_SYSTEM_PROMPTS } from './dictation-clean.js'
import { _resetPrewarmsForTest, startPolishPrewarm } from './dictation-prewarm.js'
import { getVocabulary } from './profile.js'
import { cleanOutboundDictation, polishBreakerOpen, polishPromptVersionFor } from './dictation-polish-pipeline.js'

const DICTATED = 'please send the secret plan to dana'
const POLISHED = 'Please send the secret plan to Dana.'
const warmResult = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: POLISHED, session_id: 'warm-session-1', uuid: 'warm-1',
  usage: { input_tokens: 3, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 700 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 700, costUSD: 0.0002 } },
  model_usage_since_last_result: { 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 700, cacheCreationEphemeral1hInputTokens: 700, costUSD: 0.0002 } },
  total_cost_usd: 0.0002, ...over,
})

let dir = ''
function warmCli(line: string) {
  writeFileSync(join(dir, 'out.txt'), `${line}\n`)
  const script = join(dir, 'fake-claude')
  // Reads the one user message, like the real process, then prints its result.
  writeFileSync(script, `#!/bin/sh\nread -r _line\ncat "${join(dir, 'out.txt')}"\n`)
  chmodSync(script, 0o755)
  binary.path = script
}
async function polishWarm(bucket: 'message' | 'meeting' = 'message') {
  const { token } = startPolishPrewarm('haiku')
  return cleanOutboundDictation(DICTATED, { enabled: true, model: 'haiku', bucket, prewarmToken: token })
}
const row = () => { expect(audit).toHaveBeenCalledTimes(1); return audit.mock.calls[0]![0] as Record<string, any> }
/** The whole row as the real builder writes it, with the clock and the run's duration held still. */
const wholeRow = async () => {
  const { buildTokenAuditRecord } = await vi.importActual<typeof import('./token-audit.js')>('./token-audit.js')
  return JSON.stringify(buildTokenAuditRecord({ ...row(), durationMs: 7 } as any, new Date('2026-10-31T17:00:00.000Z')))
}
const ROW_BEFORE_NEW_FIELDS = (chars: number, outputChars: number) => `{"ts":"2026-10-31T17:00:00.000Z","source":"g2-dictation-autoclean","model":"haiku","input_chars":${chars},"output_chars":${outputChars},"est_input_tokens":${Math.floor(chars / 4)},"est_output_tokens":${Math.floor(outputChars / 4)},"duration_ms":7,"caller":"dictation_autoclean_message","usage_kind":"estimated","custom_instructions":false,"learned_style":false,"polish_prompt":"v3","polish_outcome":"polished"`
const sentChars = (bucket: 'message' | 'meeting' = 'message') => {
  const version = polishPromptVersionFor(bucket, undefined, 'haiku')
  return DICTATION_POLISH_SYSTEM_PROMPTS[version].length + buildDictationPolishPrompt(DICTATED, getVocabulary(), version, '', { learnedStyle: '', register: 'default' }).length
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-polish-usage-'))
  process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE = join(dir, 'count.json')
  audit.mockClear()
  coldCalls.count = 0
})
afterEach(() => {
  _resetPrewarmsForTest()
  delete process.env.COS_DICTATION_AUTOCLEAN_COUNT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe('warm polish', () => {
  it('records real usage, the session, and the same answer', async () => {
    warmCli(warmResult())
    const out = await polishWarm()
    expect(out).toMatchObject({ text: POLISHED, prewarm: 'used' })
    expect(coldCalls.count).toBe(0)
    expect(row()).toMatchObject({
      source: 'g2-dictation-autoclean', caller: 'dictation_autoclean_message', cliSessionId: 'warm-session-1',
      realUsage: { inputTokens: 3, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 700, cacheWrite1hTokens: 700, costUsd: 0.0002, resolvedModel: 'claude-haiku-5-5' },
    })
  })
  it('input_chars stays the words dictated; prompt_chars counts the system prompt and the built message', async () => {
    warmCli(warmResult())
    await polishWarm()
    expect(row().inputChars).toBe(DICTATED.length)
    expect(row().promptChars).toBe(sentChars())
    expect(row().promptChars).toBeGreaterThan(DICTATED.length + DICTATION_POLISH_SYSTEM_PROMPTS.v3.length)
  })
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['strings', { usage: 'garbage', modelUsage: 'garbage', model_usage_since_last_result: 'garbage', total_cost_usd: 'free' }],
    ['null', { usage: null, modelUsage: null, model_usage_since_last_result: null }],
    ['negative', { usage: { input_tokens: -1, output_tokens: 1 }, modelUsage: { m: { inputTokens: -1, outputTokens: 1 } }, model_usage_since_last_result: { m: { inputTokens: -1, outputTokens: 1 } } }],
    ['empty', { usage: {}, modelUsage: {}, model_usage_since_last_result: {} }],
  ]
  it.each(BAD)('malformed usage, %s: same answer, no skip, breaker closed, no cold retry, row estimated', async (_name, over) => {
    warmCli(warmResult(over))
    const out = await polishWarm()
    expect(out).toMatchObject({ text: POLISHED, prewarm: 'used' })
    expect(out.polishSkipped).toBeUndefined()
    expect(polishBreakerOpen('haiku', 'message')).toBe(false)
    expect(coldCalls.count).toBe(0)
    expect(row()).not.toHaveProperty('realUsage')
    expect(row().inputChars).toBe(DICTATED.length)
    expect(row().promptChars).toBe(sentChars())
  })
  it('no dictation or answer text reaches the audit, even through an id field', async () => {
    warmCli(warmResult({ session_id: 'please send the secret plan' }))
    await polishWarm()
    const written = JSON.stringify(row())
    expect(written).not.toContain('secret plan')
    expect(await wholeRow()).not.toContain('secret plan')
    expect(row()).not.toHaveProperty('cliSessionId')
  })
})

describe('cold polish', () => {
  it('stays estimated, and also counts what the model is sent', async () => {
    const out = await cleanOutboundDictation(DICTATED, { enabled: true, model: 'haiku', bucket: 'message' })
    expect(out.text).toBe(`${DICTATED} Polished cold.`)
    expect(row()).not.toHaveProperty('realUsage')
    expect(row()).not.toHaveProperty('cliSessionId')
    expect(row().inputChars).toBe(DICTATED.length)
    expect(row().promptChars).toBe(sentChars())
  })
  it('the whole estimated row is what 6.96.4 wrote, byte for byte, with prompt_chars after it', async () => {
    const out = await cleanOutboundDictation(DICTATED, { enabled: true, model: 'haiku', bucket: 'message' })
    const polished = (out.modelText as string).length
    expect(await wholeRow()).toBe(`${ROW_BEFORE_NEW_FIELDS(DICTATED.length, polished)},"prompt_chars":${sentChars()}}`)
  })
})
