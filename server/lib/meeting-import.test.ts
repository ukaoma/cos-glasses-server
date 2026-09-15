// The Fireflies importer.
//
// The client below is the REAL client with a fake transport, so the budget,
// the pacing, the taxonomy and the adaptive paging are all exercised rather
// than stubbed. Only the vendor itself is fake.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FirefliesBudget,
  FirefliesClient,
  type FirefliesTransportOutcome,
} from './fireflies-client.js'
import { ImportedMeetingLibrary, importHash } from './imported-meeting-library.js'
import {
  DEFAULT_IMPORT_WINDOW_DAYS,
  FirefliesImporter,
  IMPORT_MAX_PAGES_PER_RUN,
  IMPORT_POLL_BUDGET_SHARE,
  IMPORT_POLL_INTERVAL_MS,
  ImportRefusedError,
  MS_PER_DAY,
  STILL_PROCESSING_BACKOFF_MS,
  STILL_PROCESSING_MAX_ATTEMPTS,
  buildFirefliesImport,
} from './meeting-import.js'
import { MaintenanceLifecycleError, type MaintenanceWorkLease } from './maintenance-lifecycle.js'

const roots: string[] = []
const IDS = [
  '01KTQDNA393VRVDRF8VATAFJZR',
  '01KVAWTTAC06C22CSMG0MG2K82',
  '01KVB5TSDB1AKKKA9V0GDSM8X8',
]

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function transcript(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Meeting ${id.slice(-4)}`,
    date: NOW - 2 * MS_PER_DAY,
    duration: 47,
    organizer_email: 'someone@example.com',
    participants: ['someone@example.com'],
    sentences: [{ speaker_name: 'Someone', speaker_id: 'a', text: 'hello there', start_time: 0, end_time: 30 }],
    ...overrides,
  }
}

const NOW = new Date(2026, 8, 14, 9, 0, 0).getTime()

interface Harness {
  importer: FirefliesImporter
  library: ImportedMeetingLibrary
  budget: FirefliesBudget
  root: string
  requests: Array<{ limit?: number; skip?: number }>
  leases: { taken: number; released: number }
  setNow: (ms: number) => void
  advance: (ms: number) => void
  setKey: (key: string | null) => void
  setMode: (mode: 'advise' | 'imports' | 'apply') => void
  setAdmissions: (open: boolean) => void
  failLease: (error: Error | null) => void
  sealed: Array<{ runId: string; written: string[] }>
}

function harness(options: {
  page?: (skip: number, call: number) => FirefliesTransportOutcome
  plan?: 'free' | 'pro' | 'business'
  library?: ImportedMeetingLibrary
  key?: string | null
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'cos-import-run-'))
  roots.push(root)
  let now = NOW
  let key: string | null = options.key === undefined ? 'ff_key_0123456789abcdef' : options.key
  let mode: 'advise' | 'imports' | 'apply' = 'imports'
  let admissions = true
  let leaseError: Error | null = null
  const requests: Harness['requests'] = []
  const leases = { taken: 0, released: 0 }
  const sealed: Harness['sealed'] = []

  const budget = new FirefliesBudget({ path: join(root, '.fireflies-budget.json'), now: () => now })
  budget.setPlan(options.plan ?? 'business')

  const client = new FirefliesClient({
    transport: async ({ body }) => {
      const parsed = JSON.parse(body) as { variables?: { limit?: number; skip?: number } }
      requests.push({ limit: parsed.variables?.limit, skip: parsed.variables?.skip })
      const handler = options.page ?? ((skip: number) => okPage(skip === 0 ? [transcript(IDS[0])] : []))
      return handler(parsed.variables?.skip ?? 0, requests.length)
    },
    key: () => key,
    budget,
    now: () => now,
    sleep: async (ms: number) => { now += ms },
  })

  const library = options.library ?? new ImportedMeetingLibrary({ root: join(root, 'imports') })
  const importer = new FirefliesImporter({
    library,
    client,
    budget,
    key: () => key,
    ledgerPath: join(root, 'imports', '.fireflies-ledger.json'),
    mode: () => mode,
    admissionsOpen: () => admissions,
    now: () => now,
    log: () => undefined,
    onPageSealed: summary => { sealed.push(summary) },
    acquireLease: (): MaintenanceWorkLease => {
      if (leaseError) throw leaseError
      leases.taken += 1
      return { id: 'lease', setPhase: () => undefined, release: () => { leases.released += 1 } }
    },
  })

  return {
    importer,
    library,
    budget,
    root,
    requests,
    leases,
    sealed,
    setNow: (ms: number) => { now = ms },
    advance: (ms: number) => { now += ms },
    setKey: (value: string | null) => { key = value },
    setMode: (value: 'advise' | 'imports' | 'apply') => { mode = value },
    setAdmissions: (open: boolean) => { admissions = open },
    failLease: (error: Error | null) => { leaseError = error },
  }
}

function okPage(items: unknown[]): FirefliesTransportOutcome {
  return { kind: 'http', status: 200, headers: {}, body: JSON.stringify({ data: { transcripts: items } }) }
}

async function runOnce(h: Harness, options: Parameters<FirefliesImporter['run']>[0] = {}): Promise<void> {
  h.importer.run(options)
  await h.importer.whenIdle()
}

describe('a successful import', () => {
  it('writes a record per meeting and counts them from a re-list', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? IDS.map(id => transcript(id)) : []) })
    await runOnce(h)

    const status = h.importer.status()
    expect(status.state).toBe('ok')
    expect(status.counts.imported).toBe(3)
    expect(h.library.list()).toHaveLength(3)
    for (const id of IDS) expect(h.library.has(importHash(id))).toBe(true)
    expect(status.lastRun?.written).toBe(3)
    expect(h.leases.taken).toBe(h.leases.released)
    expect(h.sealed).toHaveLength(1)
    expect(h.sealed[0].written).toHaveLength(3)
  })

  it('does not rewrite the same meetings on a second run', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    await runOnce(h)
    await runOnce(h)
    expect(h.importer.status().lastRun?.written).toBe(0)
    expect(h.importer.status().counts.imported).toBe(1)
  })

  it('stores the unedited sentences in the sidecar beside a readable record', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    await runOnce(h)
    const [row] = h.library.list()
    const sidecar = h.library.readSidecar('2026-09', row.filename) as Record<string, unknown>
    expect(sidecar.firefliesId).toBe(IDS[0])
    expect(sidecar.pairable).toBe(true)
    expect((sidecar.sentences as unknown[])).toHaveLength(1)
    expect(statSync(join(h.library.root, '2026-09', row.filename)).mode & 0o777).toBe(0o600)
  })

  it('builds a record whose length is unknown but which is never paired', () => {
    const write = buildFirefliesImport({
      id: IDS[0], title: 'No length', dateMs: NOW, durationSeconds: null, durationSource: 'unknown',
      organizerEmail: null, participants: [], sentences: [{ speakerName: 'A', speakerId: null, text: 'hi', startTime: 0, endTime: 0 }],
      overview: null, actionItems: null, keywords: [],
    }, { importedAt: new Date(NOW).toISOString() })
    expect((write.sidecar as { pairable: boolean }).pairable).toBe(false)
    expect(write.markdown).not.toContain('**Duration**')
  })
})

describe('the vendor summary end to end', () => {
  const SUMMARY = {
    overview: 'The team agreed the launch date and split the follow-ups.',
    action_items: '**Miles**\nSend the brief\n\n**Gina**\nDraft the post\n',
    keywords: ['launch', 'brief'],
  }

  it('renders the summary and keeps the vendor original in the sidecar', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0], { summary: SUMMARY })] : []) })
    await runOnce(h)

    const [row] = h.library.list()
    const markdown = readFileSync(join(h.library.root, '2026-09', row.filename), 'utf8')
    expect(markdown).toContain('## Summary')
    expect(markdown).toContain(SUMMARY.overview)
    expect(markdown).toContain('- Send the brief')
    expect(markdown).toContain('- Draft the post')

    const detail = h.library.detail('2026-09', row.filename)!
    expect(detail.summary).toBe(SUMMARY.overview)
    expect(detail.actionItems).toHaveLength(4)

    // The markdown collapses `**` so a sentence cannot forge a field; the
    // sidecar is where the vendor's own text survives that, unedited.
    const sidecar = h.library.readSidecar('2026-09', row.filename) as Record<string, unknown>
    expect(sidecar.overview).toBe(SUMMARY.overview)
    expect(sidecar.actionItems).toBe(SUMMARY.action_items)
    expect(sidecar.keywords).toEqual(['launch', 'brief'])
  })

  it('imports a meeting with no summary, with neither section', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0], { summary: null })] : []) })
    await runOnce(h)

    expect(h.importer.status().state).toBe('ok')
    const [row] = h.library.list()
    const markdown = readFileSync(join(h.library.root, '2026-09', row.filename), 'utf8')
    expect(markdown).not.toContain('## Summary')
    expect(markdown).not.toContain('## Action Items')
    const sidecar = h.library.readSidecar('2026-09', row.filename) as Record<string, unknown>
    expect(sidecar.overview).toBeNull()
    expect(sidecar.actionItems).toBeNull()
    expect(sidecar.keywords).toEqual([])
  })
})

describe('advise mode', () => {
  it('refuses the run, calls nothing, and writes nothing', async () => {
    const h = harness()
    h.setMode('advise')

    expect(() => h.importer.run({})).toThrow(ImportRefusedError)
    try { h.importer.run({}) } catch (error) {
      expect((error as ImportRefusedError).status).toBe(409)
      expect((error as ImportRefusedError).code).toBe('operations_pipeline_owns_fireflies')
    }
    // A filesystem diff, not an inspection of intent: nothing under the root.
    expect(existsSync(join(h.root, 'imports'))).toBe(false)
    expect(h.requests).toEqual([])
    expect(h.importer.status().state).toBe('refused_pipeline')
    expect(h.importer.pollDue()).toEqual({ due: false, reason: 'refused_pipeline' })
  })

  it('refuses settings too, so nothing in this path writes', () => {
    const h = harness()
    h.setMode('advise')
    expect(() => h.importer.settings({ keepImporting: false })).toThrow(/pipeline already brings in/)
    expect(existsSync(join(h.root, 'imports'))).toBe(false)
  })

  it('refuses in APPLY mode for the same reason, not only in advise', () => {
    // 6.47.0 added a third mode. A pipeline Mac in apply mode still has a pipeline that
    // owns Fireflies, so a refusal written as "is advise" rather than "is not imports"
    // would start importing every meeting a second time the moment a person switched.
    const h = harness()
    h.setMode('apply')
    expect(() => h.importer.run({})).toThrow(ImportRefusedError)
    expect(() => h.importer.settings({ keepImporting: false })).toThrow(/pipeline already brings in/)
    expect(h.importer.status().state).toBe('refused_pipeline')
    expect(h.importer.pollDue()).toEqual({ due: false, reason: 'refused_pipeline' })
    expect(existsSync(join(h.root, 'imports'))).toBe(false)
  })
})

describe('skip taxonomy', () => {
  it('counts every terminal reason', async () => {
    const h = harness({
      page: skip => okPage(skip === 0 ? [
        transcript(IDS[0], { id: undefined }),
        transcript(IDS[0], { id: 'has spaces' }),
        transcript(IDS[1], { date: undefined }),
        transcript(IDS[2], { date: '2026-09-10T14:30:00Z' }),
        transcript(IDS[0], { sentences: 'not an array' }),
      ] : []),
    })
    await runOnce(h)
    const skipped = h.importer.status().counts.skipped
    expect(skipped).toMatchObject({
      missing_id: 1, id_shape_changed: 1, missing_date: 1, date_string: 1, malformed_sentences: 1,
    })
    expect(h.library.list()).toEqual([])
    expect(h.importer.status().skipKinds.id_shape_changed).toBe('alarm')
  })

  it('retries a meeting the vendor is still transcribing, then gives up', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0], { sentences: [] })] : []) })
    await runOnce(h)

    const ledgerPath = join(h.root, 'imports', '.fireflies-ledger.json')
    const first = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const hash = importHash(IDS[0])
    expect(first.retryable[hash]).toMatchObject({ reason: 'still_processing', attempts: 1 })
    expect(Date.parse(first.retryable[hash].nextAt) - NOW).toBe(STILL_PROCESSING_BACKOFF_MS)
    expect(h.importer.status().state).toBe('partial')

    // A run before the backoff expires must not spend an attempt.
    await runOnce(h)
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).retryable[hash].attempts).toBe(1)

    for (let attempt = 1; attempt < STILL_PROCESSING_MAX_ATTEMPTS; attempt++) {
      h.advance(STILL_PROCESSING_BACKOFF_MS + 1_000)
      await runOnce(h)
    }
    const final = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    expect(final.retryable[hash]).toBeUndefined()
    expect(final.skipped.never_transcribed).toContain(hash)
  })

  it('imports a meeting with no length, and marks it so the engine never pairs it', async () => {
    const h = harness({
      page: skip => okPage(skip === 0 ? [transcript(IDS[0], {
        duration: null,
        sentences: [{ speaker_name: 'A', speaker_id: 'a', text: 'hi', start_time: 4, end_time: 4 }],
      })] : []),
    })
    await runOnce(h)
    expect(h.library.list()).toHaveLength(1)
    expect(h.importer.status().counts.skipped.duration_unknown).toBe(1)
    expect(h.importer.status().skipKinds.duration_unknown).toBe('imported')
  })
})

describe('refusals and failure states', () => {
  it('runs one at a time', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    h.importer.run({})
    expect(() => h.importer.run({})).toThrow(/already running/)
    await h.importer.whenIdle()
  })

  it('refuses without a key', () => {
    const h = harness({ key: null })
    expect(() => h.importer.run({})).toThrow(/Fireflies API key/)
  })

  it('refuses a window it was not given', () => {
    const h = harness()
    expect(() => h.importer.run({ windowDays: 45 })).toThrow(/windowDays must be one of/)
    expect(() => h.importer.run({ windowDays: 90 })).not.toThrow()
  })

  it('goes sticky on an invalid key until the key changes', async () => {
    const h = harness({
      page: () => ({
        kind: 'http', status: 500, headers: {},
        body: JSON.stringify({ errors: [{ code: 'auth_failed' }] }),
      }),
    })
    await runOnce(h)
    expect(h.importer.status().state).toBe('invalid_key')
    expect(() => h.importer.run({})).toThrow(/Fireflies refused this key/)
    expect(h.importer.pollDue()).toEqual({ due: false, reason: 'invalid_key' })

    h.setKey('ff_a_brand_new_key_012345')
    h.importer.onKeyChanged()
    expect(() => h.importer.run({})).not.toThrow()
    await h.importer.whenIdle()
  })

  it('clears the sticky state when a check later succeeds', async () => {
    const h = harness({
      page: () => ({ kind: 'http', status: 401, headers: {}, body: '{}' }),
    })
    await runOnce(h)
    expect(h.importer.status().state).toBe('invalid_key')
    h.importer.onKeyChecked({ state: 'ok', checkedAt: new Date(NOW).toISOString(), cached: false })
    expect(h.importer.status().state).toBe('idle')
  })

  it('records a rate limit and holds the poll until it passes', async () => {
    const h = harness({
      page: () => ({ kind: 'http', status: 429, headers: { 'Retry-After': '120' }, body: '{}' }),
    })
    await runOnce(h)
    const status = h.importer.status()
    expect(status.state).toBe('rate_limited')
    expect(status.lastRun?.failure?.retryAfterSeconds).toBe(120)
    expect(h.importer.pollDue()).toEqual({ due: false, reason: 'rate_limited' })
  })

  it.each([
    ['vendor_down', { kind: 'http' as const, status: 503, headers: {}, body: '{}' }],
    ['unreachable', { kind: 'timeout' as const }],
  ])('reports %s', async (state, outcome) => {
    const h = harness({ page: () => outcome })
    await runOnce(h)
    expect(h.importer.status().state).toBe(state)
  })

  it('stops when a written record does not come back from the library', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? IDS.map(id => transcript(id)) : []) })
    // A library that writes and then cannot see its own record is the one
    // failure a success count would otherwise hide.
    const realList = h.library.listHashes.bind(h.library)
    h.library.listHashes = () => new Set<string>()

    await runOnce(h)
    expect(h.importer.status().state).toBe('write_unlisted')
    // It stopped at the FIRST unlisted write rather than carrying on.
    expect(h.importer.status().lastRun?.written).toBe(1)
    h.library.listHashes = realList
  })
})

describe('budget and resume', () => {
  it('resumes from the cursor after the daily cap stops a backfill', async () => {
    // Every page is full, so the pass never ends on its own and the free cap is
    // what stops it.
    const h = harness({
      plan: 'free',
      // Full pages so the pass never ends on its own, of meetings the vendor is
      // still transcribing so the cursor advances without writing 2,400 files.
      page: skip => okPage(Array.from({ length: 50 }, (_, index) => transcript(
        `01KTQDNA393VRVDRF8VATAF${String(skip + index).padStart(3, '0')}`,
        { sentences: [] },
      ))),
    })
    await runOnce(h)
    const stopped = h.importer.status()
    expect(stopped.state).toBe('partial')
    expect(stopped.lastRun?.stopReason).toBe('cap_exhausted')
    expect(stopped.cursor).toBeGreaterThan(0)
    const cursor = stopped.cursor

    // Tomorrow the budget resets and the next run picks up where it stopped,
    // rather than re-reading the whole window from the top.
    h.requests.length = 0
    h.advance(MS_PER_DAY)
    await runOnce(h)
    expect(h.requests[0].skip).toBe(cursor)
  })

  it('ends the pass at the first meeting older than the window', async () => {
    // A FULL page, so the pass does not simply reach the end of the list: the
    // newest three are inside the window and everything after them is older,
    // which is the shape the vendor's newest-first order guarantees.
    const h = harness({
      page: () => okPage([
        transcript(IDS[0]),
        transcript(IDS[1]),
        transcript(IDS[2]),
        ...Array.from({ length: 47 }, (_, index) => transcript(
          `01KTQDNA393VRVDRF8VATAF${String(index).padStart(3, '0')}`,
          { date: NOW - (60 + index) * MS_PER_DAY },
        )),
      ]),
    })
    await runOnce(h, { windowDays: 30 })
    const status = h.importer.status()
    expect(status.state).toBe('ok')
    expect(status.lastRun?.stopReason).toBe('window_edge')
    // Only the in-window meetings were imported, and the cursor reset for the
    // next pass.
    expect(h.library.list()).toHaveLength(3)
    expect(status.cursor).toBe(0)
    expect(status.windowDays).toBe(30)
  })

  it('starts a new pass when the window changes', async () => {
    const h = harness({
      plan: 'free',
      // Full pages so the pass never ends on its own, of meetings the vendor is
      // still transcribing so the cursor advances without writing 2,400 files.
      page: skip => okPage(Array.from({ length: 50 }, (_, index) => transcript(
        `01KTQDNA393VRVDRF8VATAF${String(skip + index).padStart(3, '0')}`,
        { sentences: [] },
      ))),
    })
    await runOnce(h, { windowDays: 30 })
    expect(h.importer.status().cursor).toBeGreaterThan(0)

    h.advance(MS_PER_DAY)
    h.requests.length = 0
    await runOnce(h, { windowDays: 7 })
    expect(h.requests[0].skip).toBe(0)
    expect(h.importer.status().windowDays).toBe(7)
  })
})

describe('a vendor that never ends', () => {
  it('stops at the page cap rather than paging forever', async () => {
    // A Business plan has no daily cap, so if the vendor answers every page
    // with a full one and nothing is ever older than the window, the budget
    // cannot stop this run and the window cannot either. Found by mutating the
    // window guard: without this bound the run spun until the test timed out.
    //
    // The fake vendor ENDS a few pages past the cap rather than running
    // forever. A fake with no end can only prove the cap by timing out, and a
    // timeout is indistinguishable from a hang: mutating the cap away then
    // hangs the suite instead of failing it, which is not a test result.
    // A LITERAL, not the constant under test: a bound derived from the very
    // number the mutation changes moves with the mutant, and the run then
    // pages to 100,005 instead of failing. That is how this test first came
    // back "inconclusive (timeout)" rather than killing the mutant.
    const vendorEndsAtPage = 205
    const h = harness({
      plan: 'business',
      page: skip => (skip >= vendorEndsAtPage * 50 ? okPage([]) : okPage(Array.from({ length: 50 }, (_, index) => transcript(
        `01KTQDNA393VRVDRF8VATA${String(skip + index).padStart(4, '0')}`,
        { sentences: [] },
      )))),
    })
    await runOnce(h)
    const status = h.importer.status()
    expect(status.state).toBe('partial')
    expect(status.lastRun?.stopReason).toBe('page_cap')
    expect(status.lastRun?.pages).toBe(IMPORT_MAX_PAGES_PER_RUN)
  }, 60_000)

  it('pins the thresholds a person agreed to', () => {
    // Literals on purpose: an assertion that reads the same constant it checks
    // cannot fail when the constant changes.
    expect(IMPORT_MAX_PAGES_PER_RUN).toBe(200)
    expect(STILL_PROCESSING_MAX_ATTEMPTS).toBe(24)
    expect(STILL_PROCESSING_BACKOFF_MS).toBe(60 * 60_000)
    expect(IMPORT_POLL_INTERVAL_MS).toBe(6 * 60 * 60_000)
    expect(IMPORT_POLL_BUDGET_SHARE).toBe(0.5)
    expect(DEFAULT_IMPORT_WINDOW_DAYS).toBe(30)
  })
})

describe('maintenance', () => {
  it('defers the page when a drain takes the lease away', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    h.failLease(new MaintenanceLifecycleError('maintenance_drain_active', 'draining', { status: 503 }))

    await runOnce(h)
    const status = h.importer.status()
    expect(status.state).toBe('partial')
    expect(status.lastRun?.stopReason).toBe('maintenance_deferred')
    expect(h.library.list()).toEqual([])
  })

  it('does not even fetch while admissions are closed', async () => {
    const h = harness()
    h.setAdmissions(false)
    expect(() => h.importer.run({})).toThrow(/maintenance/i)
    expect(h.requests).toEqual([])
  })
})

describe('poll', () => {
  it('waits for the interval, then fires', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    expect(h.importer.tick()).toEqual({ fired: false, reason: 'not_due' })

    h.advance(IMPORT_POLL_INTERVAL_MS + 1)
    const fired = h.importer.tick()
    expect(fired.fired).toBe(true)
    await h.importer.whenIdle()
    expect(h.importer.status().lastRun?.trigger).toBe('poll')
    expect(h.importer.status().windowDays).toBe(DEFAULT_IMPORT_WINDOW_DAYS)
  })

  it('stays off when the user turned importing off', () => {
    const h = harness()
    h.importer.settings({ keepImporting: false })
    h.advance(IMPORT_POLL_INTERVAL_MS + 1)
    expect(h.importer.tick()).toEqual({ fired: false, reason: 'keep_importing_off' })
  })

  it('refuses to spend more than its share of the day', async () => {
    const h = harness({ plan: 'free' })
    // A LITERAL half of the free plan's 50, and a BOUNDED loop. Deriving the
    // ceiling from the constant under test moved it with the mutant, and the
    // unbounded `while` then spun forever once the budget refused a call: the
    // mutant hung the suite instead of failing it.
    const ceiling = 25
    for (let spent = 0; spent < ceiling && h.budget.snapshot().calls < ceiling; spent++) {
      h.budget.tryConsume({})
    }
    expect(h.budget.snapshot().calls).toBe(ceiling)

    h.advance(IMPORT_POLL_INTERVAL_MS + 1)
    // The PREDICATE, not tick(): asserting on tick() means a mutant that lets
    // the poll through starts a real run inside the assertion, and the test
    // then races that run instead of reporting on the decision.
    expect(h.importer.pollDue()).toEqual({ due: false, reason: 'poll_budget_share' })
    expect(h.importer.tick()).toEqual({ fired: false, reason: 'poll_budget_share' })
    expect(h.importer.isRunning()).toBe(false)
  })

  it('refuses without a key and while admissions are closed', () => {
    const h = harness({ key: null })
    h.advance(IMPORT_POLL_INTERVAL_MS + 1)
    expect(h.importer.tick()).toEqual({ fired: false, reason: 'fireflies_key_missing' })

    const open = harness()
    open.setAdmissions(false)
    open.advance(IMPORT_POLL_INTERVAL_MS + 1)
    expect(open.importer.tick()).toEqual({ fired: false, reason: 'admissions_closed' })
  })
})

describe('settings', () => {
  it('stores the plan cap and the keep-importing switch', () => {
    const h = harness()
    const status = h.importer.settings({ planCap: 'pro', keepImporting: true })
    expect(status.planCap).toBe('pro')
    expect(status.keepImporting).toBe(true)
    expect(h.importer.settings({ keepImporting: false }).keepImporting).toBe(false)
  })

  it('refuses values it does not understand', () => {
    const h = harness()
    expect(() => h.importer.settings({ planCap: 'enterprise' })).toThrow(/planCap must be/)
    expect(() => h.importer.settings({ keepImporting: 'yes' })).toThrow(/true or false/)
  })
})

describe('durability', () => {
  it('writes the ledger 0600 and treats a run interrupted by a crash as partial', async () => {
    const h = harness({ page: skip => okPage(skip === 0 ? [transcript(IDS[0])] : []) })
    await runOnce(h)
    const ledgerPath = join(h.root, 'imports', '.fireflies-ledger.json')
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600)

    // A ledger left saying `running` is a process that died mid-run. Reopening
    // the SAME ledger must not report a run that no longer exists.
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    expect(ledger.state).toBe('ok')
    writeFileSync(ledgerPath, JSON.stringify({ ...ledger, state: 'running' }))

    const reopened = new FirefliesImporter({
      library: h.library,
      client: new FirefliesClient({
        transport: async () => okPage([]),
        key: () => 'ff_key_0123456789abcdef',
        budget: new FirefliesBudget({ path: join(h.root, '.fireflies-budget.json') }),
      }),
      budget: new FirefliesBudget({ path: join(h.root, '.fireflies-budget.json') }),
      key: () => 'ff_key_0123456789abcdef',
      ledgerPath,
      mode: () => 'imports',
      admissionsOpen: () => true,
      log: () => undefined,
    })
    expect(reopened.status().state).toBe('partial')
    expect(reopened.status().counts.imported).toBe(1)
  })
})
