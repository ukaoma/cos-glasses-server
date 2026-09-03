import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { QueryJobAdmissionResult, QueryJobMutationResult } from './query-job-store.js'
import type { QueryJobRequest, QueryJobSnapshot } from './query-job-types.js'
import {
  __resetTaskDispatcherForTests,
  runTaskNow,
  taskClientJobId,
} from './task-dispatcher.js'
import {
  TaskRunError,
  projectTaskRun,
  saveTaskLedger,
  serializeTaskWork,
  taskStorePaths,
  type BridgeTaskRow,
  type TaskRun,
} from './task-store.js'

const TZ = 'America/Chicago'
const DAY = '2026-09-02'

function snapshot(jobId: string, request: QueryJobRequest, status: QueryJobSnapshot['status'] = 'accepted'): QueryJobSnapshot {
  return {
    schemaVersion: 1,
    jobId,
    clientJobId: request.clientJobId,
    generation: 1,
    turnId: randomUUID(),
    requestFingerprint: 'fp',
    status,
    eventSeq: 1,
    oldestEventSeq: 1,
    sessionId: request.sessionId,
    messageEra: request.messageEra,
    globalMsgNum: request.globalMsgNum,
    attachments: [],
    partialText: '',
    partialTruncated: false,
    activity: [],
    acceptedAt: '2026-09-02T16:00:00.000Z',
    updatedAt: '2026-09-02T16:00:00.000Z',
    retentionUntil: '2026-09-09T16:00:00.000Z',
  }
}

function row(overrides: Partial<BridgeTaskRow> = {}): BridgeTaskRow {
  return {
    ref: 'quilt-1',
    id: 'aaaaaaaaaaaa',
    domain: 'quilt',
    description: 'Call Jeremy about Q3',
    priority: 'inbox',
    is_checked: false,
    archived: false,
    line_number: 1,
    source: null,
    owner: null,
    delegated: false,
    needs_review: false,
    thread: null,
    run_at: '2026-09-02 10:00',
    agent_state: null,
    agent_no: null,
    section: 'inbox',
    section_day: null,
    ...overrides,
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cos-task-dispatch-'))
  const paths = taskStorePaths(root)
  const jobs = new Map<string, QueryJobSnapshot>()
  const submissions: QueryJobRequest[] = []
  const markers: string[] = []
  const rows = [row()]
  let now = Date.parse('2026-09-02T16:00:00.000Z')
  const deps = {
    now: () => now,
    paths,
    submit: async (request: QueryJobRequest): Promise<QueryJobAdmissionResult> => {
      submissions.push(request)
      const job = snapshot(randomUUID(), request)
      jobs.set(job.jobId, job)
      return { created: true, job }
    },
    findByClientGeneration: async (clientJobId: string) => [...jobs.values()].find(job => job.clientJobId === clientJobId),
    getSnapshot: async (jobId: string) => {
      const job = jobs.get(jobId)
      if (!job) throw new Error('not found')
      return job
    },
    getExecution: async (jobId: string) => {
      const job = jobs.get(jobId)
      if (!job) throw new Error('not found')
      return { request: submissions.find(item => item.clientJobId === job.clientJobId)! }
    },
    cancel: async (jobId: string): Promise<QueryJobMutationResult> => ({ applied: true, job: { ...jobs.get(jobId)!, status: 'canceled' } }),
    complete: async (jobId: string): Promise<QueryJobMutationResult> => ({ applied: true, job: { ...jobs.get(jobId)!, status: 'completed' } }),
    createSession: () => 'session-task',
    currentMessageEra: () => 'era-test',
    currentMessageMax: () => 40,
    durableJobsEnabled: () => true,
    admissionsOpen: () => true,
    loadRows: async () => rows,
    setMarker: async (_domain: string, _id: string, marker: string | null) => { markers.push(marker ?? 'clear') },
    config: () => ({
      enabled: true,
      time: '07:00',
      timezone: TZ,
      days: [1, 2, 3, 4, 5],
      catchUpMinutes: 180,
      taskCatchUpMinutes: 180,
      model: 'sonnet',
      sources: [],
    } as never),
    acquireDispatchLease: () => ({ id: 'lease', setPhase() {}, release() {} }),
  }
  return { root, paths, deps, submissions, markers, rows, setNow: (ms: number) => { now = ms } }
}

describe('taskClientJobId', () => {
  it('mints two distinct ids for sequential attempts and never a task| prefix', () => {
    const first = taskClientJobId('aaaaaaaaaaaa', DAY, 1, TZ)
    const second = taskClientJobId('aaaaaaaaaaaa', DAY, 2, TZ)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
    expect(first.startsWith('task|')).toBe(false)
  })
})

describe('runTaskNow', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    __resetTaskDispatcherForTests()
    h = harness()
  })
  afterEach(() => {
    __resetTaskDispatcherForTests()
    rmSync(h.root, { recursive: true, force: true })
  })

  it('returns 202 with a run id, stamps dispatch+model, and writes the marker last', async () => {
    const result = await runTaskNow('aaaaaaaaaaaa', 'quilt', h.deps)
    expect(result.runId).toBeTruthy()
    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0].model).toBe('sonnet')
    expect(h.submissions[0].dispatch).toEqual({ restricted: true, tools: ['Read', 'Grep', 'Glob'] })
    expect(h.submissions[0].origin).toEqual({ kind: 'task', id: 'aaaaaaaaaaaa' })
    expect(h.markers).toEqual(['running'])
    const ledger = JSON.parse(readFileSync(h.paths.runs, 'utf8')) as { runs: TaskRun[] }
    expect(ledger.runs).toHaveLength(1)
    expect(ledger.runs[0].status).toBe('running')
    expect(ledger.runs[0].jobId).toBeTruthy()
  })

  it('refuses a second live run on the same task with 409 task_running', async () => {
    await runTaskNow('aaaaaaaaaaaa', 'quilt', h.deps)
    await expect(runTaskNow('aaaaaaaaaaaa', 'quilt', h.deps)).rejects.toMatchObject({
      status: 409,
      code: 'task_running',
    })
    expect(h.submissions).toHaveLength(1)
  })

  it('refuses when durable jobs are off', async () => {
    await expect(runTaskNow('aaaaaaaaaaaa', 'quilt', { ...h.deps, durableJobsEnabled: () => false }))
      .rejects.toBeInstanceOf(TaskRunError)
    await expect(runTaskNow('aaaaaaaaaaaa', 'quilt', { ...h.deps, durableJobsEnabled: () => false }))
      .rejects.toMatchObject({ status: 409, code: 'durable_jobs_off' })
  })
})

describe('projectTaskRun', () => {
  it('maps the six ledger statuses onto the wire strings', () => {
    const run: TaskRun = {
      id: 'run-1',
      identity: 'id',
      taskId: 'aaaaaaaaaaaa',
      ref: 'quilt-1',
      domain: 'quilt',
      line: 'Call Jeremy about Q3',
      day: DAY,
      attempt: 1,
      trigger: 'manual',
      firedAt: '2026-09-02T15:00:00.000Z',
      clientJobId: '00000000-0000-4000-8000-000000000000',
      generation: 1,
      sessionId: 's',
      status: 'dispatching',
      submitAttempts: 1,
      model: 'sonnet',
      activityToolMode: 'status',
    }
    expect(projectTaskRun(run).status).toBe('submitting')
    expect(projectTaskRun({ ...run, status: 'running' }, { status: 'accepted' }).status).toBe('accepted')
    expect(projectTaskRun({ ...run, status: 'done' }).status).toBe('completed')
    expect(projectTaskRun({ ...run, status: 'superseded' }).error?.code).toBe('superseded')
    expect(projectTaskRun({ ...run, status: 'failed', error: { code: 'job_lost', message: 'lost' } }).status).toBe('failed')
    expect(projectTaskRun({ ...run, status: 'orphaned' }).status).toBe('canceled')
  })
})

describe('serializeTaskWork', () => {
  it('throws on nested calls and leaves saveTaskLedger raw', async () => {
    await expect(serializeTaskWork(() => serializeTaskWork(() => 1))).rejects.toThrow('nested serializeTaskWork')
    const root = mkdtempSync(join(tmpdir(), 'cos-task-fifo-'))
    try {
      saveTaskLedger(taskStorePaths(root), [])
      expect(readFileSync(taskStorePaths(root).runs, 'utf8')).toContain('"runs": []')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
