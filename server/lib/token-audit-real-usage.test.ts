// 6.97.0: the audit row with real usage. COS Control reads these exact names, and the Python readers
// share the file, so a row with no real usage must stay byte-identical to 6.96.4. Each test can fail:
// the row string is written out, and the file test reads back what was appended.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/cos-token-audit-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  process.env.COS_TOKEN_AUDIT_FILE = `${dir}/audit.jsonl`
  return { dir, file: `${dir}/audit.jsonl` }
})
import { buildTokenAuditRecord, logTokenAudit } from './token-audit.js'

mkdirSync(scratch.dir, { recursive: true })
afterAll(() => rmSync(scratch.dir, { recursive: true, force: true }))

const at = new Date('2026-10-31T17:00:00.000Z')
const base = { source: 'g2-query', model: 'sonnet', inputChars: 400, outputChars: 80, durationMs: 1200, caller: 'voice_query' }
const ROW_6964 = '{"ts":"2026-10-31T17:00:00.000Z","source":"g2-query","model":"sonnet","input_chars":400,"output_chars":80,"est_input_tokens":100,"est_output_tokens":20,"duration_ms":1200,"caller":"voice_query","usage_kind":"estimated"}'
const real = { inputTokens: 2, outputTokens: 5, cacheReadTokens: 542, cacheWriteTokens: 60, cacheWrite1hTokens: 60, costUsd: 2.012e-05, resolvedModel: 'claude-haiku-5-5' }

describe('buildTokenAuditRecord', () => {
  it('with nothing new set, the row is byte-identical to 6.96.4', () => {
    expect(JSON.stringify(buildTokenAuditRecord(base, at))).toBe(ROW_6964)
  })
  it('writes the names COS Control reads, after every existing key, with the existing keys unchanged', () => {
    const rec = buildTokenAuditRecord({ ...base, runId: 'run-1', cliSessionId: 'sess-1', realUsage: real }, at)
    expect(JSON.stringify(rec)).toBe(
      '{"ts":"2026-10-31T17:00:00.000Z","source":"g2-query","model":"sonnet","input_chars":400,"output_chars":80,"est_input_tokens":100,"est_output_tokens":20,"duration_ms":1200,"caller":"voice_query","usage_kind":"provider_final",'
      + '"run_id":"run-1","cli_session_id":"sess-1","input_tokens":2,"output_tokens":5,"cache_read_tokens":542,"cache_write_tokens":60,"cache_write_1h_tokens":60,"cost_usd":0.00002012,"resolved_model":"claude-haiku-5-5"}',
    )
  })
  it('a Codex row has no cost and no cache write, and says so by leaving them out', () => {
    const rec = buildTokenAuditRecord({ ...base, realUsage: { inputTokens: 173, outputTokens: 5, cacheReadTokens: 19456 } }, at)
    expect(rec).toMatchObject({ usage_kind: 'provider_final', input_tokens: 173, output_tokens: 5, cache_read_tokens: 19456 })
    for (const key of ['cost_usd', 'cache_write_tokens', 'cache_write_1h_tokens', 'resolved_model']) expect(rec).not.toHaveProperty(key)
  })
  it('provider_final only with real numbers: asking for it does not make it so', () => {
    expect(buildTokenAuditRecord({ ...base, usageKind: 'provider_final' }, at)).toMatchObject({ usage_kind: 'estimated' })
    for (const bad of [{ inputTokens: 0, outputTokens: 0 }, { inputTokens: Number.NaN, outputTokens: 2 }, { inputTokens: 5 }, 'garbage', { inputTokens: -1, outputTokens: 1 }]) {
      const rec = buildTokenAuditRecord({ ...base, usageKind: 'provider_final', realUsage: bad as any }, at)
      expect(JSON.stringify(rec)).toBe(ROW_6964)
    }
  })
  it('a usd on a keyed row stays what it is, beside the provider cost', () => {
    const rec = buildTokenAuditRecord({ ...base, usd: 0.5, lane: 'key', realUsage: real }, at)
    expect(rec).toMatchObject({ usd: 0.5, cost_usd: 2.012e-05 })
  })
  it('no prompt or answer text can enter through an id or a model name', () => {
    const secret = 'please summarise my private meeting'
    const rec = buildTokenAuditRecord({ ...base, cliSessionId: secret, realUsage: { inputTokens: 1, outputTokens: 1, resolvedModel: secret } }, at)
    expect(JSON.stringify(rec)).not.toContain('private')
    expect(rec).not.toHaveProperty('cli_session_id')
    expect(rec).not.toHaveProperty('resolved_model')
  })
  it('a row only carries the keys it is built from, so extra text on the usage object is dropped', () => {
    const rec = buildTokenAuditRecord({ ...base, realUsage: { inputTokens: 1, outputTokens: 1, text: 'SECRET ANSWER', prompt: 'SECRET PROMPT' } as any }, at)
    expect(JSON.stringify(rec)).not.toContain('SECRET')
  })
})

describe('logTokenAudit', () => {
  beforeEach(() => rmSync(scratch.file, { force: true }))
  const rows = () => readFileSync(scratch.file, 'utf8').split('\n').slice(0, -1)

  it('appends one parseable line per call, even when an id or model tries to carry a newline', () => {
    logTokenAudit({ ...base, realUsage: real })
    logTokenAudit({ ...base, cliSessionId: 'a\nb', realUsage: { inputTokens: 1, outputTokens: 1, resolvedModel: 'x\ny' } })
    logTokenAudit(base)
    const lines = rows()
    expect(lines).toHaveLength(3)
    expect(lines.map(line => JSON.parse(line).usage_kind)).toEqual(['provider_final', 'provider_final', 'estimated'])
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('cli_session_id')
  })
  it('a row that cannot be built costs only the row', () => {
    const entry = { ...base } as any
    Object.defineProperty(entry, 'model', { enumerable: true, get() { throw new Error('boom') } })
    expect(() => logTokenAudit(entry)).not.toThrow()
  })
})
