// Key lanes P1 (plan v4 3.1): token-audit key fields are conditional spreads. A Lane A row must be
// byte-identical to 6.79.0, so the expected strings below are the 6.79.0 record, written out.
import { describe, expect, it } from 'vitest'
import { buildTokenAuditRecord } from './token-audit.js'

const at = new Date('2026-10-19T17:00:00.000Z')
const laneA = { source: 'g2-query', model: 'sonnet', inputChars: 400, outputChars: 80, durationMs: 1200, caller: 'voice_query', turnId: 't1', sessionId: 's1' }

describe('token audit key-lane fields', () => {
  it('a Lane A row is byte-identical to the 6.79.0 record', () => {
    expect(JSON.stringify(buildTokenAuditRecord(laneA, at))).toBe(
      '{"ts":"2026-10-19T17:00:00.000Z","source":"g2-query","model":"sonnet","input_chars":400,"output_chars":80,"est_input_tokens":100,"est_output_tokens":20,"duration_ms":1200,"caller":"voice_query","usage_kind":"estimated","turn_id":"t1","session_id":"s1"}',
    )
    expect(JSON.stringify(buildTokenAuditRecord({ source: 'g2-prewarm', model: 'opus', inputChars: 0, outputChars: 0, durationMs: 5, caller: 'prewarm', usageKind: 'provider_final' }, at))).toBe(
      '{"ts":"2026-10-19T17:00:00.000Z","source":"g2-prewarm","model":"opus","input_chars":0,"output_chars":0,"est_input_tokens":1,"est_output_tokens":1,"duration_ms":5,"caller":"prewarm","usage_kind":"provider_final"}',
    )
  })

  it('a keyed row appends exactly profile, lane, credentialKind and usd after the 6.79.0 keys', () => {
    const rec = buildTokenAuditRecord({ ...laneA, profile: 'sonnet', lane: 'key', credentialKind: 'openrouter', usd: 0.0042 }, at)
    const keys = Object.keys(rec)
    expect(keys.slice(-4)).toEqual(['profile', 'lane', 'credentialKind', 'usd'])
    expect(keys.slice(0, -4)).toEqual(Object.keys(buildTokenAuditRecord(laneA, at)))
    expect(rec).toMatchObject({ profile: 'sonnet', lane: 'key', credentialKind: 'openrouter', usd: 0.0042 })
  })

  it('usd 0 is kept; a non-finite usd is dropped', () => {
    expect(buildTokenAuditRecord({ ...laneA, lane: 'direct', usd: 0 }, at)).toMatchObject({ lane: 'direct', usd: 0 })
    expect('usd' in buildTokenAuditRecord({ ...laneA, usd: Number.NaN }, at)).toBe(false)
  })
})
