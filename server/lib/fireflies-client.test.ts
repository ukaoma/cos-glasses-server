// Fireflies client contract.
//
// Every vendor answer this file describes was either measured on the canary
// (60 calls/min, epoch-ms dates, minute durations, an invalid key answering
// HTTP 500 with a GraphQL auth_failed) or is a failure mode the importer has to
// survive without a person present.
//
// THE TRANSPORT IS ALWAYS FAKE. A real call from a test would spend a real
// budget against a real account, so the transport is injected everywhere and a
// guard below proves the real one is never reachable from here.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIREFLIES_CALLS_PER_MINUTE,
  FIREFLIES_DAILY_CAP_RESERVE,
  FIREFLIES_KEY_CHECK_THROTTLE_MS,
  FIREFLIES_PAGE_SIZES,
  FIREFLIES_PLAN_CAPS,
  FIREFLIES_SERVER_RETRY_DELAYS_MS,
  FirefliesBudget,
  FirefliesClient,
  type FirefliesTransport,
  type FirefliesTransportOutcome,
  normalizeFirefliesTranscript,
  parseRetryAfterSeconds,
} from './fireflies-client.js'

const roots: string[] = []
const KEY = 'ff_test_key_0123456789'

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-fireflies-client-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

interface Harness {
  client: FirefliesClient
  budget: FirefliesBudget
  requests: Array<{ limit?: number; skip?: number; withSentences: boolean }>
  sleeps: number[]
  setNow: (ms: number) => void
  budgetPath: string
}

function harness(
  handler: (call: number, request: { limit?: number; skip?: number; withSentences: boolean }) => FirefliesTransportOutcome,
  options: { plan?: 'free' | 'pro' | 'business'; now?: number } = {},
): Harness {
  const budgetPath = join(newRoot(), '.fireflies-budget.json')
  let now = options.now ?? Date.UTC(2026, 8, 14, 15, 0, 0)
  const requests: Harness['requests'] = []
  const sleeps: number[] = []
  const budget = new FirefliesBudget({ path: budgetPath, now: () => now })
  if (options.plan) budget.setPlan(options.plan)

  const transport: FirefliesTransport = async ({ body }) => {
    const parsed = JSON.parse(body) as { query: string; variables?: { limit?: number; skip?: number } }
    requests.push({
      limit: parsed.variables?.limit,
      skip: parsed.variables?.skip,
      withSentences: parsed.query.includes('sentences'),
    })
    return handler(requests.length, { ...(parsed.variables ?? {}), withSentences: requests[requests.length - 1].withSentences })
  }

  const client = new FirefliesClient({
    transport,
    key: () => KEY,
    budget,
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms },
  })
  return { client, budget, requests, sleeps, setNow: (ms: number) => { now = ms }, budgetPath }
}

function http(status: number, body: unknown, headers: Record<string, string> = {}): FirefliesTransportOutcome {
  return { kind: 'http', status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

function transcripts(count: number, startIndex = 0): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `01KTQDNA393VRVDRF8VATAFJ${String(startIndex + index).padStart(2, '0')}`,
    title: `Meeting ${startIndex + index}`,
    date: Date.UTC(2026, 8, 10, 14, 30),
    duration: 47,
    organizer_email: 'someone@example.com',
    participants: ['someone@example.com'],
    sentences: [{ speaker_name: 'Someone', speaker_id: 'a', text: 'hello', start_time: 0, end_time: 5 }],
  }))
}

const okPage = (count: number) => http(200, { data: { transcripts: transcripts(count) } })

describe('key check', () => {
  it('reports ok when the vendor returns a user', async () => {
    const { client, requests } = harness(() => http(200, { data: { user: { user_id: 'u1' } } }))
    const check = await client.checkKey({ userInitiated: true })
    expect(check.state).toBe('ok')
    expect(requests).toHaveLength(1)
    expect(requests[0].withSentences).toBe(false)
  })

  it('reads an invalid key out of a 500 body, and does not retry it', async () => {
    // The measured vendor behaviour. Status-first reading would call this a
    // vendor outage and burn three retries on a key that can never work.
    const { client, requests, sleeps } = harness(() => http(500, {
      errors: [{ message: 'Bad Authorization header', code: 'auth_failed', extensions: { code: 'auth_failed' } }],
    }))
    const check = await client.checkKey({ userInitiated: true })
    expect(check.state).toBe('invalid_key')
    expect(check.httpStatus).toBe(500)
    expect(requests).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it.each([401, 403])('treats HTTP %i as an invalid key', async (status) => {
    const { client } = harness(() => http(status, {}))
    expect((await client.checkKey({ userInitiated: true })).state).toBe('invalid_key')
  })

  it('throttles background checks and lets a person through', async () => {
    let now = Date.UTC(2026, 8, 14, 15, 0, 0)
    const h = harness(() => http(200, { data: { user: { user_id: 'u1' } } }), { now })
    expect((await h.client.checkKey({})).cached).toBe(false)
    expect((await h.client.checkKey({})).cached).toBe(true)
    expect(h.requests).toHaveLength(1)

    // A person asking is never throttled.
    expect((await h.client.checkKey({ userInitiated: true })).cached).toBe(false)
    expect(h.requests).toHaveLength(2)

    now += FIREFLIES_KEY_CHECK_THROTTLE_MS + 1
    h.setNow(now)
    expect((await h.client.checkKey({})).cached).toBe(false)
    expect(h.requests).toHaveLength(3)
  })

  it('says not_configured without a key, and never calls out', async () => {
    const budgetPath = join(newRoot(), '.fireflies-budget.json')
    const calls: number[] = []
    const client = new FirefliesClient({
      transport: async () => { calls.push(1); return http(200, {}) },
      key: () => null,
      budget: new FirefliesBudget({ path: budgetPath }),
    })
    expect((await client.checkKey({ userInitiated: true })).state).toBe('not_configured')
    expect(calls).toEqual([])
  })
})

describe('request limits reach the transport', () => {
  // The literals are spelled out rather than imported: a test that reads the
  // same constant it is checking passes no matter what the constant becomes.
  it('gives a list page 30s and a 20 MiB ceiling', async () => {
    const seen: Array<{ timeoutMs: number; maxBytes: number }> = []
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    const client = new FirefliesClient({
      transport: async ({ timeoutMs, maxBytes }) => {
        seen.push({ timeoutMs, maxBytes })
        return okPage(1)
      },
      key: () => KEY,
      budget,
    })
    await client.listPage({ skip: 0 })
    expect(seen[0]).toEqual({ timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 })

    await client.checkKey({ userInitiated: true })
    // A person is waiting on the key check, so it gets a shorter leash.
    expect(seen[1].timeoutMs).toBe(15_000)
  })
})

describe('failure taxonomy', () => {
  it('maps 429 to rate_limited with Retry-After seconds', async () => {
    const { client } = harness(() => http(429, {}, { 'Retry-After': '17' }))
    const page = await client.listPage({ skip: 0 })
    expect(page.failure).toEqual({ state: 'rate_limited', httpStatus: 429, retryAfterSeconds: 17 })
  })

  it('reads a Retry-After date and the vendor reset header', () => {
    const now = Date.UTC(2026, 8, 14, 15, 0, 0)
    expect(parseRetryAfterSeconds({ 'retry-after': new Date(now + 30_000).toUTCString() }, now)).toBe(30)
    expect(parseRetryAfterSeconds({ 'x-ratelimit-reset-api': '45' }, now)).toBe(45)
    expect(parseRetryAfterSeconds({}, now)).toBeUndefined()
  })

  it('retries a 5xx three times at 5s, 15s and 30s then reports vendor_down', async () => {
    const { client, requests, sleeps } = harness(() => http(503, { message: 'upstream boom' }))
    const page = await client.listPage({ skip: 0 })
    expect(page.failure?.state).toBe('vendor_down')
    // Literals: reading the same constant the code reads would make this pass
    // for any ladder at all.
    expect(sleeps).toEqual([5_000, 15_000, 30_000])
    expect(requests).toHaveLength(4)
    expect([...FIREFLIES_SERVER_RETRY_DELAYS_MS]).toEqual([5_000, 15_000, 30_000])
  })

  it('recovers when a retried 5xx succeeds', async () => {
    const { client, sleeps } = harness(call => (call === 1 ? http(503, {}) : okPage(50)))
    const page = await client.listPage({ skip: 0 })
    expect(page.failure).toBeUndefined()
    expect(page.transcripts).toHaveLength(50)
    expect(sleeps).toEqual([FIREFLIES_SERVER_RETRY_DELAYS_MS[0]])
  })

  it('reports another GraphQL error by code, and never echoes the body', async () => {
    const secret = 'confidential meeting title and account email'
    const { client } = harness(() => http(200, {
      errors: [{ message: secret, extensions: { code: 'object_not_found' } }],
    }))
    const page = await client.listPage({ skip: 0 })
    expect(page.failure).toEqual({ state: 'vendor_error', httpStatus: 200, code: 'object_not_found' })
    expect(JSON.stringify(page)).not.toContain(secret)
  })

  it('refuses a body that is not the shape it claims', async () => {
    const { client } = harness(() => http(200, 'not json at all'))
    expect((await client.listPage({ skip: 0 })).failure?.code).toBe('invalid_json')
    const missing = harness(() => http(200, { data: {} }))
    expect((await missing.client.listPage({ skip: 0 })).failure?.code).toBe('invalid_payload')
  })
})

describe('adaptive page size', () => {
  it('descends 50 then 10 when a full page times out', async () => {
    const { client, requests } = harness(call => (call === 1 ? { kind: 'timeout' } : okPage(10)))
    const page = await client.listPage({ skip: 0 })
    expect(requests.map(r => r.limit)).toEqual([50, 10, 10, 10, 10, 10])
    expect(page.transcripts).toHaveLength(50)
    expect(page.nextSkip).toBe(50)
    expect(page.failure).toBeUndefined()
  })

  it('descends to single transcripts only for the ten that need it', async () => {
    const { client, requests } = harness((call, request) => {
      if (request.limit === 50) return { kind: 'too_large' }
      if (request.limit === 10 && request.skip === 0) return { kind: 'too_large' }
      return okPage(request.limit ?? 1)
    })
    const page = await client.listPage({ skip: 0 })
    expect(requests.map(r => r.limit)).toEqual([50, 10, ...Array(10).fill(1), 10, 10, 10, 10])
    expect(page.transcripts).toHaveLength(50)
    expect(FIREFLIES_PAGE_SIZES).toEqual([50, 10, 1])
  })

  it('turns one oversized transcript into a retryable skip and moves the cursor past it', async () => {
    const { client } = harness((_call, request) => {
      if (request.limit === 50 || request.limit === 10) return { kind: 'too_large' }
      // The single transcript at skip 3 is the one too big to fetch WITH its
      // sentences. The id-only call that follows it (no sentences) is how the
      // skip gets a name a person can act on.
      if (request.skip === 3 && request.withSentences) return { kind: 'too_large' }
      return okPage(1)
      // Uncapped plan on purpose: a full descent costs 57 calls, and the free
      // cap would stop this run for a reason that has nothing to do with the
      // behaviour under test.
    }, { plan: 'business' })
    const page = await client.listPage({ skip: 0 })
    expect(page.oversized).toHaveLength(1)
    expect(page.oversized[0].skip).toBe(3)
    expect(page.oversized[0].id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(page.transcripts.length).toBeGreaterThan(0)
    expect(page.nextSkip).toBe(50)
  })

  it('calls the network unreachable when even one transcript times out', async () => {
    const { client } = harness(() => ({ kind: 'timeout' }))
    const page = await client.listPage({ skip: 0 })
    expect(page.failure).toEqual({ state: 'unreachable' })
  })

  it('stops at the end of the vendor list', async () => {
    const { client } = harness(() => okPage(12))
    const page = await client.listPage({ skip: 100 })
    expect(page.endOfList).toBe(true)
    expect(page.nextSkip).toBe(112)
  })
})

describe('budget', () => {
  it('stops imports two calls short of the plan cap', async () => {
    const cap = FIREFLIES_PLAN_CAPS.free
    const { client, budget } = harness(() => okPage(50), { plan: 'free' })
    let failure: string | undefined
    for (let i = 0; i < cap + 5 && !failure; i++) {
      const page = await client.listPage({ skip: i * 50 })
      failure = page.failure?.state
    }
    expect(failure).toBe('cap_exhausted')
    expect(budget.snapshot().calls).toBe(cap - FIREFLIES_DAILY_CAP_RESERVE)
  })

  it('keeps the reserve for a check a person started', async () => {
    const { client, budget } = harness(() => http(200, { data: { user: { user_id: 'u1' } } }), { plan: 'free' })
    while (budget.snapshot().remaining! > 0) budget.tryConsume({})
    // Imports are done for the day, but the button still works, twice.
    expect((await client.checkKey({ userInitiated: true })).state).toBe('ok')
    expect((await client.checkKey({ userInitiated: true })).state).toBe('ok')
    expect((await client.checkKey({ userInitiated: true })).state).toBe('cap_exhausted')
    expect(budget.snapshot().calls).toBe(FIREFLIES_PLAN_CAPS.free)
  })

  it('does not cap a plan that has no daily cap', () => {
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    budget.setPlan('business')
    expect(budget.cap()).toBeNull()
    // Past the largest CAPPED plan would be ideal, but every consume fsyncs a
    // ledger; comfortably past the free cap proves the same property in time.
    for (let i = 0; i < FIREFLIES_PLAN_CAPS.free + 20; i++) expect(budget.tryConsume({})).toBe(true)
  })

  it('resets on a new local day and persists at 0600', () => {
    let now = Date.UTC(2026, 8, 14, 15, 0, 0)
    const path = join(newRoot(), '.fireflies-budget.json')
    const budget = new FirefliesBudget({ path, now: () => now })
    budget.setPlan('pro')
    budget.tryConsume({})
    expect(budget.snapshot().calls).toBe(1)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).calls).toBe(1)

    now += 24 * 60 * 60_000
    expect(budget.snapshot().calls).toBe(0)
    expect(budget.snapshot().plan).toBe('pro')
  })
})

describe('pacing', () => {
  it('waits rather than exceeding the calls-per-minute pace', async () => {
    const { client, sleeps } = harness(() => okPage(50), { plan: 'business' })
    // Two spans of 50 calls each would be 2 calls; drive enough spans to cross
    // the per-minute pace with a clock that only moves when we sleep.
    for (let i = 0; i < FIREFLIES_CALLS_PER_MINUTE + 1; i++) await client.listPage({ skip: i * 50 })
    expect(sleeps.length).toBeGreaterThan(0)
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000)
  })
})

describe('summary', () => {
  // Canary-verified 2026-09-14: the field resolves, `overview` and
  // `action_items` are STRINGS and `keywords` is a list.
  const SUMMARY = {
    overview: 'The team agreed the launch date and split the follow-ups.',
    action_items: '**Miles**\nSend the brief\n\n**Gina**\n- Draft the post\n',
    keywords: ['launch', 'brief'],
  }

  it('asks for it alongside sentences, and not on the id-only probe', async () => {
    const queries: string[] = []
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    const client = new FirefliesClient({
      transport: async ({ body }) => {
        const parsed = JSON.parse(body) as { query: string; variables?: { limit?: number } }
        queries.push(parsed.query)
        // Fail the 50 and the 10 so the descent reaches the id-only probe.
        if (parsed.variables?.limit !== 1) return { kind: 'too_large' }
        return parsed.query.includes('sentences') ? { kind: 'too_large' } : okPage(1)
      },
      key: () => KEY,
      budget,
    })
    await client.listPage({ skip: 0 })

    const withSentences = queries.filter(query => query.includes('sentences'))
    const idOnly = queries.filter(query => !query.includes('sentences'))
    expect(withSentences.length).toBeGreaterThan(0)
    expect(idOnly.length).toBeGreaterThan(0)
    for (const query of withSentences) expect(query).toContain('summary { overview action_items keywords }')
    // The probe exists to name a transcript too big to fetch; asking it for
    // more would work against the one thing it is for.
    for (const query of idOnly) expect(query).not.toContain('summary')
  })

  it('carries overview, action items and keywords onto the record', () => {
    const result = normalizeFirefliesTranscript({ ...(transcripts(1)[0] as Record<string, unknown>), summary: SUMMARY })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.overview).toBe(SUMMARY.overview)
    // One string, newlines and all. Splitting is the render's job.
    expect(result.record.actionItems).toBe(SUMMARY.action_items)
    expect(result.record.keywords).toEqual(['launch', 'brief'])
  })

  it.each([
    ['absent', {}],
    ['null', { summary: null }],
    ['empty object', { summary: {} }],
    ['whitespace only', { summary: { overview: '   ', action_items: '\n\n' } }],
    ['wrong shape', { summary: 'a summary' }],
  ])('treats a %s summary as absent rather than an error', (_label, overrides) => {
    const result = normalizeFirefliesTranscript({ ...(transcripts(1)[0] as Record<string, unknown>), ...overrides })
    expect(result.ok, 'a missing summary must never refuse the transcript').toBe(true)
    if (!result.ok) return
    expect(result.record.overview).toBeNull()
    expect(result.record.actionItems).toBeNull()
    expect(result.record.keywords).toEqual([])
    // The thing we actually came for is still there.
    expect(result.record.sentences.length).toBeGreaterThan(0)
  })

  it('keeps only real keyword strings', () => {
    const result = normalizeFirefliesTranscript({
      ...(transcripts(1)[0] as Record<string, unknown>),
      summary: { keywords: ['launch', '', '  ', 42, null, { a: 1 }, 'brief'] },
    })
    expect(result.ok && result.record.keywords).toEqual(['launch', 'brief'])
  })
})

describe('one transcript by id', () => {
  it('asks for sentences and summary, and returns the transcript', async () => {
    const queries: string[] = []
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    const client = new FirefliesClient({
      transport: async ({ body }) => {
        const parsed = JSON.parse(body) as { query: string; variables?: { id?: string } }
        queries.push(parsed.query)
        return http(200, { data: { transcript: { id: parsed.variables?.id, title: 'One' } } })
      },
      key: () => KEY,
      budget,
    })
    const result = await client.getTranscript('01KTQDNA393VRVDRF8VATAFJZR')
    expect((result.transcript as { id: string }).id).toBe('01KTQDNA393VRVDRF8VATAFJZR')
    expect(queries[0]).toContain('transcript(id: $id)')
    expect(queries[0]).toContain('sentences {')
    expect(queries[0]).toContain('summary { overview action_items keywords }')
    expect(result.calls).toBe(1)
  })

  it('reports a transcript that is not there as absent, not as a failure', async () => {
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    const client = new FirefliesClient({
      transport: async () => http(200, { data: { transcript: null } }),
      key: () => KEY,
      budget,
    })
    const result = await client.getTranscript('01KTQDNA393VRVDRF8VATAFJZR')
    expect(result.transcript).toBeUndefined()
    expect(result.failure).toBeUndefined()
  })

  it('refuses an id of the wrong shape without spending a call', async () => {
    const calls: number[] = []
    const budget = new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') })
    const client = new FirefliesClient({
      transport: async () => { calls.push(1); return okPage(1) },
      key: () => KEY,
      budget,
    })
    const result = await client.getTranscript('../../etc/passwd')
    expect(result.failure).toEqual({ state: 'vendor_error', code: 'id_shape_changed' })
    expect(calls).toEqual([])
  })
})

describe('normalize', () => {
  const base = {
    id: '01KTQDNA393VRVDRF8VATAFJZR',
    title: 'Weekly sync',
    date: Date.UTC(2026, 8, 10, 14, 30),
    duration: 47,
    organizer_email: 'a@example.com',
    participants: ['a@example.com'],
    sentences: [{ speaker_name: 'A', speaker_id: '1', text: 'hi', start_time: 0, end_time: 10 }],
  }

  it('accepts a vendor record and converts minutes to seconds', () => {
    const result = normalizeFirefliesTranscript(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.durationSeconds).toBe(47 * 60)
    expect(result.record.durationSource).toBe('vendor')
    expect(result.record.dateMs).toBe(base.date)
  })

  it('refuses a date that arrived as a string', () => {
    const result = normalizeFirefliesTranscript({ ...base, date: '2026-09-10T14:30:00Z' })
    expect(result).toEqual({ ok: false, reason: 'date_string' })
  })

  it.each([
    ['missing_id', { ...base, id: undefined }],
    ['missing_date', { ...base, date: undefined }],
    ['id_shape_changed', { ...base, id: 'has spaces and /slashes' }],
    ['malformed_sentences', { ...base, sentences: [{ speaker_name: 'A', text: 'hi' }] }],
    ['malformed_sentences', { ...base, sentences: 'a transcript' }],
    ['still_processing', { ...base, sentences: [] }],
    ['still_processing', { ...base, sentences: null }],
  ])('refuses with %s', (reason, raw) => {
    expect(normalizeFirefliesTranscript(raw)).toEqual({ ok: false, reason })
  })

  it('falls back to the sentence span, then to an unknown duration', () => {
    const span = normalizeFirefliesTranscript({
      ...base,
      duration: null,
      sentences: [
        { speaker_name: 'A', speaker_id: '1', text: 'hi', start_time: 10, end_time: 20 },
        { speaker_name: 'B', speaker_id: '2', text: 'bye', start_time: 30, end_time: 130 },
      ],
    })
    expect(span.ok && span.record.durationSeconds).toBe(120)
    expect(span.ok && span.record.durationSource).toBe('sentence_span')

    const unknown = normalizeFirefliesTranscript({
      ...base,
      duration: null,
      sentences: [{ speaker_name: 'A', speaker_id: '1', text: 'hi', start_time: 5, end_time: 5 }],
    })
    expect(unknown.ok && unknown.record.durationSeconds).toBeNull()
    expect(unknown.ok && unknown.record.durationSource).toBe('unknown')
  })
})

describe('the tests can fail', () => {
  it('never reaches the real transport from this file', () => {
    // A guard on the guard: every harness above injects a transport, so nothing
    // here can reach api.fireflies.ai even if a default were added later. Only
    // the IMPORT BLOCK is checked, or this assertion would match its own text.
    const source = readFileSync(new URL('./fireflies-client.test.ts', import.meta.url), 'utf8')
    const importBlock = source.slice(0, source.indexOf("} from './fireflies-client.js'"))
    expect(importBlock.length).toBeGreaterThan(200)
    expect(importBlock).not.toContain(`createFetch${'Transport'}`)
  })
})
