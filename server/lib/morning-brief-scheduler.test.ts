import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { morningBriefPaths, MORNING_BRIEF_LIMITS } from './morning-brief-config.js'
import {
  MorningBriefRunError,
  MorningBriefScheduler,
  scheduledClientJobId,
  type MorningBriefSchedulerDeps,
  type MorningBriefSubmission,
} from './morning-brief-scheduler.js'
import type { QueryJobSnapshot } from './query-job-types.js'

const CHICAGO = 'America/Chicago'
const SLOT = Date.UTC(2026, 8, 1, 12, 0) // Tue 2026-09-01 07:00 CDT

interface FakeCoordinator {
  submissions: Array<Record<string, unknown>>
  jobs: Map<string, QueryJobSnapshot>
  failNext?: { code: string; message: string }
}

function snapshot(jobId: string, request: Record<string, unknown>, status: QueryJobSnapshot['status'] = 'running'): QueryJobSnapshot {
  return {
    schemaVersion: 1,
    jobId,
    clientJobId: String(request.clientJobId),
    generation: 1,
    turnId: randomUUID(),
    requestFingerprint: 'fp',
    status,
    eventSeq: 1,
    oldestEventSeq: 1,
    sessionId: String(request.sessionId),
    messageEra: typeof request.messageEra === 'string' ? request.messageEra : undefined,
    globalMsgNum: typeof request.globalMsgNum === 'number' ? request.globalMsgNum : undefined,
    attachments: [],
    partialText: '',
    partialTruncated: false,
    activity: [],
    acceptedAt: new Date(SLOT).toISOString(),
    updatedAt: new Date(SLOT).toISOString(),
    retentionUntil: new Date(SLOT + 7 * 86_400_000).toISOString(),
  }
}

function harness(overrides: Partial<MorningBriefSchedulerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-morning-brief-sched-'))
  const fake: FakeCoordinator = { submissions: [], jobs: new Map() }
  let now = SLOT
  let sessionCounter = 0
  let durable = true
  let admissions = true
  const logs: string[] = []
  const deps: MorningBriefSchedulerDeps = {
    paths: morningBriefPaths(root),
    submit: async (request): Promise<MorningBriefSubmission> => {
      if (fake.failNext) {
        const failure = fake.failNext
        fake.failNext = undefined
        throw Object.assign(new Error(failure.message), { code: failure.code })
      }
      const existing = [...fake.jobs.values()].find(job => job.clientJobId === request.clientJobId)
      if (existing) return { job: existing, created: false }
      fake.submissions.push(request)
      const job = snapshot(randomUUID(), request)
      fake.jobs.set(job.jobId, job)
      return { job, created: true }
    },
    findByClientGeneration: async (clientJobId) => [...fake.jobs.values()].find(job => job.clientJobId === clientJobId),
    getSnapshot: async (jobId) => {
      const job = fake.jobs.get(jobId)
      if (!job) throw new Error('not found')
      return job
    },
    createSession: () => `session-${++sessionCounter}`,
    currentMessageEra: () => 'era-test',
    currentMessageMax: () => 41,
    ownerName: () => 'Jun',
    durableJobsEnabled: () => durable,
    admissionsOpen: () => admissions,
    now: () => now,
    log: line => { logs.push(line) },
    ...overrides,
  }
  const scheduler = new MorningBriefScheduler(deps)
  scheduler.updateConfig({ timezone: CHICAGO })
  return {
    root,
    fake,
    scheduler,
    logs,
    setNow: (ms: number) => { now = ms },
    setDurable: (value: boolean) => { durable = value },
    setAdmissions: (value: boolean) => { admissions = value },
    complete: (jobId: string, text: string) => {
      const job = fake.jobs.get(jobId)!
      fake.jobs.set(jobId, { ...job, status: 'completed', response: text, completedAt: new Date(now).toISOString() })
    },
  }
}

let h: ReturnType<typeof harness>
beforeEach(() => { h = harness() })
afterEach(() => { h.scheduler.stop(); rmSync(h.root, { recursive: true, force: true }) })

describe('scheduledClientJobId', () => {
  it('is a v4-shaped UUID, stable per day and zone, different per day', () => {
    const a = scheduledClientJobId('2026-09-01', CHICAGO)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(scheduledClientJobId('2026-09-01', CHICAGO)).toBe(a)
    expect(scheduledClientJobId('2026-09-02', CHICAGO)).not.toBe(a)
    expect(scheduledClientJobId('2026-09-01', 'Europe/London')).not.toBe(a)
  })
})

describe('MorningBriefScheduler', () => {
  it('persists the default config on first construction and reports the next run', async () => {
    const onDisk = JSON.parse(readFileSync(morningBriefPaths(h.root).config, 'utf8')) as { enabled: boolean; timezone: string }
    expect(onDisk.enabled).toBe(true)
    expect(onDisk.timezone).toBe(CHICAGO)
    h.setNow(SLOT - 3_600_000)
    const status = await h.scheduler.status()
    expect(status.nextRunAt).toBe('2026-09-01T12:00:00.000Z')
    expect(status.gate).toBe('ready')
    expect(status.lastRun).toBeNull()
  })

  it('fires once at the slot with a reserved message number, then never again that day', async () => {
    h.setNow(SLOT - 60_000)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'before_slot' })

    h.setNow(SLOT)
    const first = await h.scheduler.tick()
    expect(first.fired).toBe(true)
    expect(h.fake.submissions).toHaveLength(1)
    const request = h.fake.submissions[0]
    expect(request).toMatchObject({
      clientJobId: scheduledClientJobId('2026-09-01', CHICAGO),
      generation: 1,
      sessionId: 'session-1',
      messageEra: 'era-test',
      globalMsgNum: 42,
      activityToolMode: 'status',
    })
    expect(String(request.query)).toContain('Morning brief for Jun. Tuesday, September 1, 2026, 07:00 America/Chicago.')

    h.setNow(SLOT + 30_000)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'already_fired' })
    h.setNow(SLOT + 2 * 3_600_000)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'already_fired' })
    expect(h.fake.submissions).toHaveLength(1)

    // The ledger on disk is what remembers this across a restart.
    const ledger = JSON.parse(readFileSync(morningBriefPaths(h.root).runs, 'utf8')) as { runs: Array<{ jobId?: string; day: string }> }
    expect(ledger.runs).toHaveLength(1)
    expect(ledger.runs[0].day).toBe('2026-09-01')
    expect(ledger.runs[0].jobId).toBeTruthy()
  })

  it('a restart after the fire does not re-run: the ledger is reloaded', async () => {
    h.setNow(SLOT)
    await h.scheduler.tick()
    const reloaded = new MorningBriefScheduler({ ...(h.scheduler as unknown as { deps: MorningBriefSchedulerDeps }).deps })
    h.setNow(SLOT + 60_000)
    expect(await reloaded.tick()).toEqual({ fired: false, reason: 'already_fired' })
    expect(h.fake.submissions).toHaveLength(1)
  })

  it('a crash between the ledger write and admission resumes by identity instead of duplicating', async () => {
    // Simulate: ledger row written, submit never returned (process died).
    h.setNow(SLOT)
    h.fake.failNext = { code: 'crash', message: 'simulated' }
    await h.scheduler.tick() // records a submitError for attempt 1
    // Now pretend the coordinator DID hold the job (the 202 was lost, not the admission).
    const request = { clientJobId: scheduledClientJobId('2026-09-01', CHICAGO), sessionId: 'session-1', messageEra: 'era-test', globalMsgNum: 42 }
    const held = snapshot('held-job', request)
    h.fake.jobs.set(held.jobId, held)
    // Remove the error so the row reads as "in flight" and let the spacing elapse.
    const paths = morningBriefPaths(h.root)
    const ledger = JSON.parse(readFileSync(paths.runs, 'utf8')) as { runs: Array<Record<string, unknown>> }
    delete ledger.runs[0].submitError
    const { saveMorningBriefLedger } = await import('./morning-brief-config.js')
    saveMorningBriefLedger(paths, ledger as never)
    const resumed = new MorningBriefScheduler((h.scheduler as unknown as { deps: MorningBriefSchedulerDeps }).deps)
    h.setNow(SLOT + 3 * 60_000)
    const result = await resumed.tick()
    expect(result).toMatchObject({ fired: true, run: { jobId: 'held-job' } })
    expect(h.fake.submissions).toHaveLength(0)
  })

  it('a failed submission retries two minutes later, then gives up after three attempts', async () => {
    h.setNow(SLOT)
    h.fake.failNext = { code: 'query_job_coordinator_shutting_down', message: 'down' }
    const first = await h.scheduler.tick()
    expect(first).toMatchObject({ fired: true, run: { attempt: 1, submitError: { code: 'query_job_coordinator_shutting_down' } } })

    h.setNow(SLOT + 30_000)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'backoff' })

    h.setNow(SLOT + 3 * 60_000)
    h.fake.failNext = { code: 'x', message: 'x' }
    expect(await h.scheduler.tick()).toMatchObject({ fired: true, run: { attempt: 2 } })
    h.setNow(SLOT + 6 * 60_000)
    h.fake.failNext = { code: 'x', message: 'x' }
    expect(await h.scheduler.tick()).toMatchObject({ fired: true, run: { attempt: 3 } })
    h.setNow(SLOT + 9 * 60_000)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'attempts_exhausted' })
    expect(h.fake.submissions).toHaveLength(0)
  })

  it('is inert while durable jobs are off or maintenance admissions are closed', async () => {
    h.setNow(SLOT)
    h.setDurable(false)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'durable_jobs_off' })
    expect((await h.scheduler.status()).gate).toBe('durable_jobs_off')
    h.setDurable(true)
    h.setAdmissions(false)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'admissions_closed' })
    await expect(h.scheduler.runNow()).rejects.toMatchObject({ status: 503, code: 'admissions_closed' })
    h.setAdmissions(true)
    expect(await h.scheduler.tick()).toMatchObject({ fired: true })
  })

  it('disabling the brief stops the schedule and the config change is durable', async () => {
    h.scheduler.updateConfig({ enabled: false })
    h.setNow(SLOT)
    expect(await h.scheduler.tick()).toEqual({ fired: false, reason: 'disabled' })
    expect((await h.scheduler.status()).nextRunAt).toBeNull()
    const onDisk = JSON.parse(readFileSync(morningBriefPaths(h.root).config, 'utf8')) as { enabled: boolean }
    expect(onDisk.enabled).toBe(false)
  })

  it('run now is refused while a brief is live, capped per day, and independent of the schedule', async () => {
    h.setNow(SLOT - 3_600_000) // 06:00, before the slot
    const manual = await h.scheduler.runNow()
    expect(manual.trigger).toBe('manual')
    expect(manual.jobId).toBeTruthy()
    expect(String(h.fake.submissions[0].query)).toContain('Requested now rather than on the schedule.')

    await expect(h.scheduler.runNow()).rejects.toMatchObject({ status: 409, code: 'brief_in_progress' })

    h.complete(manual.jobId!, 'CALENDAR\n09:00 Standup')
    for (let i = 1; i < MORNING_BRIEF_LIMITS.manualRunsPerDay; i++) {
      const run = await h.scheduler.runNow()
      h.complete(run.jobId!, 'done')
    }
    await expect(h.scheduler.runNow()).rejects.toMatchObject({ status: 429, code: 'manual_runs_exhausted' })

    // The scheduled fire still happens on top of the manual ones.
    h.setNow(SLOT)
    expect(await h.scheduler.tick()).toMatchObject({ fired: true, run: { trigger: 'scheduled' } })
  })

  it('run now surfaces a failed submission as a 503 with the coordinator code', async () => {
    h.fake.failNext = { code: 'query_job_store_degraded', message: 'store degraded' }
    await expect(h.scheduler.runNow()).rejects.toBeInstanceOf(MorningBriefRunError)
    h.fake.failNext = { code: 'query_job_store_degraded', message: 'store degraded' }
    await expect(h.scheduler.runNow()).rejects.toMatchObject({ status: 503, code: 'query_job_store_degraded' })
  })

  it('lists runs newest first with the live status, message number, and a bounded preview', async () => {
    h.setNow(SLOT)
    const { run } = (await h.scheduler.tick()) as { fired: true; run: { jobId: string } }
    let [view] = await h.scheduler.listRuns()
    expect(view).toMatchObject({ status: 'running', globalMsgNum: 42, trigger: 'scheduled' })
    expect(view.preview).toBeUndefined()

    h.complete(run.jobId, 'CALENDAR\n' + 'x'.repeat(500))
    ;[view] = await h.scheduler.listRuns()
    expect(view.status).toBe('completed')
    expect(view.preview).toHaveLength(120)
    expect(view.completedAt).toBeTruthy()

    const capability = await h.scheduler.capability()
    expect(capability).toMatchObject({ protocolVersion: 1, enabled: true, time: '07:00', timezone: CHICAGO, lastRunStatus: 'completed' })
    expect(JSON.stringify(capability)).not.toContain(run.jobId)
    expect(JSON.stringify(capability)).not.toContain('session-')
  })

  it('previewPrompt shows exactly what the next brief will ask', () => {
    h.scheduler.updateConfig({ sources: [{ id: 'skill', enabled: true, options: { name: '/good-morning' } }] })
    h.setNow(SLOT - 3_600_000)
    const prompt = h.scheduler.previewPrompt()
    expect(prompt).toContain('SKILL /good-morning')
    expect(prompt).toContain('September 1, 2026')
  })

  it('serialises overlapping ticks so a slow submission cannot double-fire', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = harness({
      submit: async (request) => {
        await gate
        const job = snapshot(randomUUID(), request)
        return { job, created: true }
      },
    })
    try {
      slow.setNow(SLOT)
      const a = slow.scheduler.tick()
      const b = slow.scheduler.tick()
      release()
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toBe(rb)
      expect(ra.fired).toBe(true)
    } finally {
      slow.scheduler.stop()
      rmSync(slow.root, { recursive: true, force: true })
    }
  })
})

describe('MorningBriefScheduler sections, outcomes, and reservations (6.43.1)', () => {
  it('stores the asked-for sections on the ledger row and reads the outcome back once the job completes', async () => {
    h.setNow(SLOT + 1_000)
    const tick = await h.scheduler.tick()
    expect(tick.fired).toBe(true)
    const run = (tick as { run: { id: string; jobId?: string; sections?: Array<{ id: string; label: string }> } }).run
    expect(run.sections?.map(s => s.id)).toEqual(['calendar', 'meetings', 'tasks', 'waiting'])
    const onDisk = JSON.parse(readFileSync(morningBriefPaths(h.root).runs, 'utf8')) as { runs: Array<{ sections?: unknown[] }> }
    expect(onDisk.runs[0].sections).toHaveLength(4)

    let [view] = await h.scheduler.listRuns(1)
    expect(view.sections?.every(s => s.state === 'pending')).toBe(true)

    h.complete(run.jobId!, 'CALENDAR\n9:00 Standup\nFROM RECENT MEETINGS\nBudget decided\nDUE\nInvoice Friday\nWaiting on you: unavailable (no Slack)\nOrder your energy: ship.')
    ;[view] = await h.scheduler.listRuns(1)
    expect(view.sections?.map(s => `${s.id}:${s.state}`)).toEqual([
      'calendar:present', 'meetings:present', 'tasks:present', 'waiting:unavailable',
    ])
  })

  it('holds the reserved number from the ledger write until the job is terminal', async () => {
    h.setNow(SLOT + 1_000)
    expect(h.scheduler.liveReservations('era-test')).toEqual([])
    const tick = await h.scheduler.tick()
    const run = (tick as { run: { jobId?: string; globalMsgNum?: number } }).run
    expect(run.globalMsgNum).toBe(42)
    expect(h.scheduler.liveReservations('era-test')).toEqual([{ globalMsgNum: 42, messageEra: 'era-test', owner: 'brief:2026-09-01' }])
    expect(h.scheduler.liveReservations('era-other')).toEqual([])

    h.complete(run.jobId!, 'CALENDAR\nnothing')
    await h.scheduler.listRuns(1) // observes the terminal status and records it
    expect(h.scheduler.liveReservations('era-test')).toEqual([])
  })

  it('drops a reservation older than a day, and one whose submit failed', async () => {
    h.fake.failNext = { code: 'boom', message: 'no' }
    h.setNow(SLOT + 1_000)
    await h.scheduler.tick()
    expect(h.scheduler.liveReservations('era-test')).toEqual([])
    h.setNow(SLOT + 2 * 60_000 + 1_000)
    const tick = await h.scheduler.tick()
    expect(tick.fired).toBe(true)
    expect(h.scheduler.liveReservations('era-test').map(r => r.globalMsgNum)).toEqual([42])
    h.setNow(SLOT + 25 * 60 * 60_000)
    expect(h.scheduler.liveReservations('era-test')).toEqual([])
  })

  it('answers coverage as null without probes and delegates to the service with the live config', async () => {
    expect(await h.scheduler.coverage()).toBeNull()
    const { MorningBriefCoverageService } = await import('./morning-brief-coverage.js')
    const seen: string[] = []
    const withProbes = harness({
      coverage: new MorningBriefCoverageService({
        meetings: () => ({ count: 7, newestMonth: '2026-09', layout: 'direct' }),
        skill: name => { seen.push(name); return { found: true, where: '.claude/skills' } },
      }),
    })
    try {
      withProbes.scheduler.updateConfig({ sources: [{ id: 'skill', enabled: true, options: { name: '/good-morning' } }] })
      const coverage = await withProbes.scheduler.coverage()
      expect(coverage?.sources.find(s => s.id === 'meetings')).toMatchObject({ state: 'ready', counts: { stored: 7 } })
      expect(coverage?.sources.find(s => s.id === 'skill')).toMatchObject({ state: 'ready' })
      expect(seen).toEqual(['/good-morning'])
    } finally {
      withProbes.scheduler.stop()
      rmSync(withProbes.root, { recursive: true, force: true })
    }
  })
})
