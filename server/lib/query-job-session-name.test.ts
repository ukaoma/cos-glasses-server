import { describe, expect, it } from 'vitest'
import { QUERY_JOB_SESSION_NAME_MAX, parseQueryJobRequest, requestFingerprint, sanitizeSessionName } from './query-job-types.js'

const base = { clientJobId: '8a0e1c2e-4d5f-4a6b-9c7d-0e1f2a3b4c5d', generation: 1, query: 'hello', sessionId: 'work-abc' }

describe('6.58.2: a New session from Work carries its task name', () => {
  it('keeps a clean name as it is', () => {
    expect(sanitizeSessionName('Get the live Small Business Season site URL to the content team')).toBe('Get the live Small Business Season site URL to the content team')
  })

  it('turns control and direction characters into spaces and collapses whitespace', () => {
    expect(sanitizeSessionName('  Launch\n\tthe\u202esite\u2066 now\u0000  ')).toBe('Launch the site now')
    expect(sanitizeSessionName('a\u200bb\ufeffc')).toBe('a b c')
  })

  it('is no name when it is not a string or holds nothing', () => {
    for (const raw of [undefined, null, 42, {}, '', '   ', '\u0000\u202e']) expect(sanitizeSessionName(raw)).toBeUndefined()
  })

  it('cuts a long name at a word boundary within the limit', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const cut = sanitizeSessionName(words)!
    expect(cut.length).toBeLessThanOrEqual(QUERY_JOB_SESSION_NAME_MAX)
    expect(words.startsWith(cut)).toBe(true)
    expect(words.charAt(cut.length)).toBe(' ')
    // A single unbroken run is cut at the limit.
    expect(sanitizeSessionName('x'.repeat(QUERY_JOB_SESSION_NAME_MAX + 50))).toBe('x'.repeat(QUERY_JOB_SESSION_NAME_MAX))
    // Exactly the limit is kept whole, spaces and all (never trimmed back to a word).
    expect(sanitizeSessionName('y'.repeat(QUERY_JOB_SESSION_NAME_MAX))).toBe('y'.repeat(QUERY_JOB_SESSION_NAME_MAX))
    const exact = ('abcd '.repeat(QUERY_JOB_SESSION_NAME_MAX / 5)).slice(0, QUERY_JOB_SESSION_NAME_MAX - 1) + 'z'
    expect(exact.length).toBe(QUERY_JOB_SESSION_NAME_MAX)
    expect(sanitizeSessionName(exact)).toBe(exact)
  })

  it('the request carries the sanitized name, and the name is not part of what the job is', () => {
    const named = parseQueryJobRequest({ ...base, sessionName: '  Get the live\nSBS URL ' })
    expect(named.sessionName).toBe('Get the live SBS URL')
    const unnamed = parseQueryJobRequest(base)
    expect(unnamed.sessionName).toBeUndefined()
    expect('sessionName' in unnamed).toBe(false)
    // A retry that renames the same job is the same job.
    expect(requestFingerprint(named)).toBe(requestFingerprint(unnamed))
    expect(parseQueryJobRequest({ ...base, sessionName: 7 }).sessionName).toBeUndefined()
  })
})
