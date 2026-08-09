import { describe, expect, it } from 'vitest'
import {
  cleanContextText,
  normalizeMemoryDetail,
  normalizeMemoryList,
  normalizeMemoryOverview,
  normalizeContextBrowserStatus,
  normalizeThreadDetail,
  normalizeThreads,
} from './cos-context-browser.js'

describe('COS memory and thread projections', () => {
  it('keeps stable memory IDs while bounding and redacting client-visible data', () => {
    const rows = normalizeMemoryList([{
      id: 'mem_20260808_120000_123456',
      type: 'decision',
      summary: 'Use /Users/example/private/file.md and sk-supersecretvalue123',
      content: `A${'x'.repeat(2000)}`,
      created_at: '2026-08-08T12:00:00',
      domain: 'personal',
      refs: { people: ['Miles'], files: ['/Users/example/secret.md'] },
      vector: [1, 2, 3],
    }], 20)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('mem_20260808_120000_123456')
    expect(rows[0].summary).toContain('[local path hidden]')
    expect(rows[0].summary).not.toContain('/Users/example')
    expect(rows[0].summary).toContain('[secret hidden]')
    expect(rows[0].refs.files?.[0]).toContain('[local path hidden]')
    expect(rows[0].refs.files?.[0]).not.toContain('/Users/example')
    expect(rows[0].content.length).toBe(1200)
    expect(rows[0]).not.toHaveProperty('vector')
  })

  it('rejects invalid IDs and applies the larger detail cap', () => {
    expect(normalizeMemoryList([{ id: '../bad', content: 'x' }], 20)).toEqual([])
    const detail = normalizeMemoryDetail({
      id: 'mem_valid_1', type: 'session_summary', content: 'z'.repeat(40_000),
    })
    expect(detail?.content.length).toBe(32_000)
  })

  it('normalizes the full overview without leaking implementation fields', () => {
    expect(normalizeMemoryOverview({
      available: true,
      collection: 'private-name',
      total: 4866,
      by_type: { decision: 1512, session_summary: 2568 },
      qdrant_url: 'http://127.0.0.1:6333',
    })).toEqual({
      available: true,
      collection: 'cos_memory',
      total: 4866,
      by_type: { decision: 1512, session_summary: 2568 },
    })
  })

  it('bounds thread lists and preserves the exact detail identity', () => {
    const raw = {
      active_count: 1,
      stale_count: 2,
      resolved_count: 3,
      threads: [{
        id: '7ce8073d',
        name: 'Pricing workstream',
        domain: 'quilt',
        is_manual: true,
        meeting_count: 3,
        topics: Array.from({ length: 50 }, (_, index) => `topic ${index}`),
        meetings: Array.from({ length: 120 }, (_, index) => ({ name: `Meeting ${index}`, date: '2026-08-08' })),
        manual_updates: [{ content: '/Users/example/private.md', timestamp: 'now', source: 'manual' }],
      }],
    }
    const list = normalizeThreads(raw, 30)
    expect(list.threads[0]).toMatchObject({ id: '7ce8073d', domain: 'quilt', is_manual: true })
    expect(list.threads[0].topics).toHaveLength(12)
    expect(list.threads[0].meetings).toHaveLength(12)

    const detail = normalizeThreadDetail(raw.threads[0])
    expect(detail?.meetings).toHaveLength(50)
    expect(detail?.manual_updates[0].content).toContain('[local path hidden]')
  })

  it('preserves the real manual-thread schema without exposing raw structures', () => {
    const detail = normalizeThreadDetail({
      id: 'mth_20260205_120344', name: 'JCK Next Gen Jeweler 2026', is_manual: true,
      linked_meetings: ['2026-01-05_Jewel360_Commercial_Pitch', '884ca049a19d'],
      meeting_count: 2,
      milestones: [{ event: 'Mitchell confirmed for speaking slot', date: '2026-02-05' }],
      sources: [{ content: 'Customer interview', reference: 'Nick Slack 9:35 AM' }],
    })
    expect(detail?.meetings).toEqual([
      { name: '2026-01-05_Jewel360_Commercial_Pitch', date: '' },
      { name: '884ca049a19d', date: '' },
    ])
    expect(detail?.milestones).toEqual(['Mitchell confirmed for speaking slot (2026-02-05)'])
    expect(detail?.sources).toEqual(['Customer interview (Nick Slack 9:35 AM)'])
  })

  it('rejects incompatible context protocols without leaking bridge internals', () => {
    expect(normalizeContextBrowserStatus({
      available: true, protocol: 999, scripts_dir: '/private/path',
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })).toEqual({
      available: false, protocol: 999, state: 'bridge_outdated',
      memory: { available: false, total: 0, state: 'bridge_outdated', reason: 'bridge_outdated' },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state: 'bridge_outdated', reason: 'bridge_outdated' },
    })
  })

  it('preserves protocol 1 context readiness without leaking bridge internals', () => {
    expect(normalizeContextBrowserStatus({
      available: true, protocol: 1, scripts_dir: '/private/path',
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })).toEqual({
      available: true, protocol: 1,
      memory: { available: true, total: 4875, state: 'ready' },
      threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
    })
  })

  it('removes control characters', () => {
    expect(cleanContextText('hello\u0000world\u007f', 100)).toBe('helloworld')
  })

  it('bounds sanitizer work for oversized plain text', () => {
    const started = performance.now()
    expect(cleanContextText('z'.repeat(1_000_000), 32_000)).toHaveLength(32_000)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('replaces arbitrary local absolute paths without corrupting web URLs', () => {
    const cleaned = cleanContextText('See /opt/private/data/file.txt, path:/Users/me/a.md, file:///Users/me/b.md and https://gotcos.com/docs', 240)
    // Changed in 6.21.36 by ONE character, and the new output is the correct one:
    // the old pattern's segment class `[^/\s)"'`]+` included a comma, so it
    // consumed `file.txt,` and reported the punctuation as part of the filename.
    expect(cleaned).toBe('See [local path hidden], path: [local path hidden], [local path hidden] and https://gotcos.com/docs')
  })

  it('redacts common secret families and Windows paths from raw memory text', () => {
    const source = [
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'DATABASE_URL=postgres://user:pass@host/db',
      'https://user:pass@example.com/path?access_token=abcdef1234567890',
      'C:\\Users\\Queen\\private.txt',
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
    ].join('\n')
    const cleaned = cleanContextText(source, 4000)
    expect(cleaned).not.toMatch(/abcdefghijklmnopqrstuvwxyz|user:pass|C:\\Users|PRIVATE KEY/)
    expect(cleaned.match(/\[secret hidden\]/g)?.length).toBeGreaterThanOrEqual(5)
    expect(cleaned).toContain('[local path hidden]')
  })

  it('redacts a private key even when bridge truncation removes its END marker', () => {
    const cleaned = cleanContextText('prefix\n-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL', 500)
    expect(cleaned).toBe('prefix\n[secret hidden]')
    expect(cleaned).not.toContain('SUPERSECRET')
  })
})

// ---------------------------------------------------------------------------
// 6.21.36. Every case below was REPRODUCED against 6.21.35 before being written,
// and every one leaked. The existing path fixtures are all single-word
// (`/Users/example/secret.md`), which is why 20 green tests coexisted with the
// two most common production path shapes going out to the lens.
// ---------------------------------------------------------------------------

const clean = (s: string) => cleanContextText(s, 4000)

describe('path redaction covers the shapes COS actually writes', () => {
  it('redacts a tilde path INCLUDING its tail', () => {
    // 6.21.35 hid only the two characters "~/" and shipped the rest.
    const out = clean('Config at ~/.cos-glasses/data/voice-profiles.json is stale')
    expect(out).not.toContain('.cos-glasses')
    expect(out).not.toContain('voice-profiles')
    expect(out).toContain('[local path hidden]')
  })

  it('redacts a path with no whitespace before it', () => {
    // The old pattern required (^|[\s("\'`]) so KEY=/path never matched.
    for (const input of [
      'Set COS_SCRIPTS_DIR=/Users/ukaoma/Documents/GitHub/cos/operations/scripts',
      'cat x >/Users/ukaoma/Documents/private/termination-memo.txt',
      'Compared a,/Users/ukaoma/Documents/GitHub/secret/plan.md,b',
      'Read @/Users/ukaoma/Documents/GitHub/cos/CLAUDE.md first',
    ]) {
      expect(clean(input), input).not.toContain('ukaoma')
    }
  })

  it('redacts an absolute path containing spaces', () => {
    // A real repo root on this machine has spaces in it.
    const out = clean('See /Users/me/Documents/GitHub/Ukaoma Chief Of Staff/MU/ops/comp.md')
    expect(out).not.toContain('/Users/me')
    expect(out).not.toContain('comp.md')
  })

  it('still redacts the single-word case the old tests covered', () => {
    expect(clean('file at /Users/ukaoma/secret.md here')).not.toContain('secret.md')
  })

  it('does NOT redact an API route or web path', () => {
    // False positives corrupt evidence: the same redacted string is sent to the
    // model, so a follow-up about a route loses its subject.
    for (const keep of ['/api/context/status', '/api/meeting/save', '/v1/chat/completions']) {
      expect(clean(`route ${keep} returns 200`), keep).toContain(keep)
    }
  })

  it('redacts a UNC path', () => {
    expect(clean('\\\\fileserver\\HR\\terminations\\2026\\notes.xlsx'))
      .not.toContain('terminations')
  })
})

describe('secret redaction covers the token families COS stores', () => {
  /**
   * Fabricated, and ASSEMBLED AT RUNTIME on purpose.
   *
   * Written as literals, GitHub push protection rejects the commit — it flagged
   * the HubSpot and Stripe fixtures as genuine credentials, which is fair evidence
   * the shapes are realistic. Concatenating the parts keeps the runtime value
   * identical for the matcher while leaving no scannable literal in source, and
   * avoids the bypass URL that would train this repo to accept real secrets.
   */
  const hubspotPak = ['pat', 'na1', '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'].join('-')
  const stripeKey = ['rk', 'live', '51AbCd0123EfGh4567IjKl89MnOpQr'].join('_')
  const githubPat = ['github', 'pat', '11ABCDE0000aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('_')
  const slackApp = ['xapp', '1', 'A01BCDEFGHI', '1234567890123', 'abcdef0123456789'].join('-')
  const slackCookie = ['xoxd', 'AbCdEf0123456789GhIjKlMnOpQrStUvWx'].join('-')
  const googleOauth = ['GOCSPX', 'AbCd0123EfGh4567IjKl89Mn'].join('-')
  const npmToken = ['npm', 'AbCd0123EfGh4567IjKl89MnOpQr01234567'].join('_')
  const awsSecret = 'wJalrXUtnFEMI' + '/' + 'K7MDENG' + '/' + 'bPxRfiCYEXAMPLEKEY'
  const families: Array<[string, string]> = [
    ['HubSpot PAK', `rotated ${hubspotPak} today`],
    ['GitHub fine-grained', `${githubPat} set`],
    ['Slack app-level', `${slackApp} used`],
    ['Slack cookie', `${slackCookie} here`],
    ['Google OAuth', `${googleOauth} rotated`],
    ['npm token', `${npmToken} in npmrc`],
    ['Stripe live', `${stripeKey} used`],
    ['AWS temp key id', 'ASIAQWERTYUIOPASDFGH assumed'],
    ['AWS secret key', `aws secret ${awsSecret} here`],
    ['PuTTY key header', 'PuTTY-User-Key-File-3: ssh-rsa'],
    ['redis empty user', 'redis://:Hunter2Hunter2@127.0.0.1:6379/0'],
    ['PWD= env', 'export DB_PWD=Hunter2Hunter2Long'],
    ['PASS= env', 'export MY_PASS=Hunter2Hunter2Long'],
  ]
  for (const [label, input] of families) {
    it(`redacts ${label}`, () => {
      const out = clean(input)
      expect(out, `${label}: ${out}`).toMatch(/\[(?:secret|credentials) hidden\]/)
    })
  }

  it('keeps working for the families 6.21.35 already handled', () => {
    for (const input of [
      `anthropic ${['sk', 'ant', 'api03', 'AbCdEfGh1234567890abcdef'].join('-')} here`,
      `slack ${['xoxp', '1234567890', '1234567890', 'abcdefghij'].join('-')} here`,
      'aws AKIAQWERTYUIOPASDFGH here',
      'postgres://user:pw@db.example.com:5432/x',
      'API_TOKEN=abcdefghijkl',
    ]) expect(clean(input), input).toMatch(/hidden\]/)
  })

  it('does not fire on an ordinary integer setting', () => {
    // MAX_THINKING_TOKENS=31999 is a real memory in this store; a bare number is
    // not a credential.
    expect(clean('Set MAX_THINKING_TOKENS=31999 in settings.json')).toContain('31999')
  })
})

describe('protocol compatibility is strict, pre-coercion', () => {
  const status = (protocol: unknown) => normalizeContextBrowserStatus({
    available: true, protocol,
    memory: { available: true, total: 7 }, threads: { available: true },
  } as never)

  it('accepts only the integer 1', () => {
    expect(status(1).available).toBe(true)
  })

  it('rejects values 6.21.35 silently coerced to 1', () => {
    // Each of these was served AS protocol 1, and the reported field was
    // rewritten to 1 so Control could not see what it had been handed.
    for (const bad of ['1', 1.5, 1.9, true, [1]]) {
      expect(status(bad).available, JSON.stringify(bad)).toBe(false)
    }
  })

  it('still rejects future and malformed protocols', () => {
    for (const bad of [2, 0, -1, null, undefined, NaN, 'one', { v: 1 }]) {
      expect(status(bad).available, JSON.stringify(bad) ?? 'undefined').toBe(false)
    }
  })

  it('does not relabel the reported protocol as 1', () => {
    // Reporting a truncated 1 for an input of 1.5 hides the incompatibility.
    expect(status(1.5).protocol).not.toBe(1)
    expect(status(2).protocol).not.toBe(1)
  })
})
