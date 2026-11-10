// S1 (2026-11-09): a CORS rejection names its origin, once per origin per hour, bounded.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORS_REJECT_ORIGIN_CAP, __resetCorsRejectLogForTests, noteCorsRejection, sanitizeOrigin } from './cors-reject-log.js'

afterEach(() => __resetCorsRejectLogForTests())

describe('CORS rejection log (S1)', () => {
  it('logs the origin and reason the first time, then once an hour with the running count', () => {
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    expect(noteCorsRejection('https://evil.example', 'not_allowed', 1_000, log)).toBe(true)
    expect(noteCorsRejection('https://evil.example', 'not_allowed', 2_000, log)).toBe(false)
    expect(noteCorsRejection('http://192.168.1.9:5173', 'check_failed', 3_000, log)).toBe(true)
    expect(noteCorsRejection('https://evil.example', 'not_allowed', 1_000 + 60 * 60_000, log)).toBe(true)
    expect(lines).toEqual([
      '[cors] blocked origin=https://evil.example reason=not_allowed (1 from this origin since boot)',
      '[cors] blocked origin=http://192.168.1.9:5173 reason=check_failed (1 from this origin since boot)',
      '[cors] blocked origin=https://evil.example reason=not_allowed (3 from this origin since boot)',
    ])
  })

  it('a hostile origin cannot inject log lines or grow without bound', () => {
    expect(sanitizeOrigin('https://a.example\n[CRASH GUARD] fake')).toBe('https://a.example?[CRASH?GUARD]?fake')
    expect(sanitizeOrigin(`https://${'a'.repeat(500)}`)).toMatch(/…\(508 chars\)$/)
    const lines: string[] = []
    for (let i = 0; i < CORS_REJECT_ORIGIN_CAP + 250; i++) noteCorsRejection(`https://h${i}.example`, 'not_allowed', 1_000, l => lines.push(l))
    const listed = lines.filter(l => l.includes('origin=')).length
    expect(listed).toBe(CORS_REJECT_ORIGIN_CAP)
    expect(lines.filter(l => l.includes('beyond the first'))).toEqual([
      `[cors] blocked 1 request(s) from origins beyond the first ${CORS_REJECT_ORIGIN_CAP} distinct ones (not listed)`,
      `[cors] blocked 100 request(s) from origins beyond the first ${CORS_REJECT_ORIGIN_CAP} distinct ones (not listed)`,
      `[cors] blocked 200 request(s) from origins beyond the first ${CORS_REJECT_ORIGIN_CAP} distinct ones (not listed)`,
    ])
  })
})

// SOURCE-SHAPE, and it says so (repo convention for server/index.ts): both rejection paths of
// the cors() origin callback call noteCorsRejection before refusing.
describe('server/index.ts logs both CORS rejection paths (S1)', () => {
  it('not_allowed and check_failed', () => {
    const index = readFileSync(resolve(process.cwd(), 'server/index.ts'), 'utf8')
    const from = index.indexOf('app.use(cors({')
    const block = index.slice(from, index.indexOf('exposedHeaders', from))
    expect(block).toContain("noteCorsRejection(origin, 'not_allowed'); cb(new Error('CORS blocked'))")
    expect(block).toContain("noteCorsRejection(origin, 'check_failed'); cb(new Error('CORS blocked'))")
  })
})
