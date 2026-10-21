// Test-only harness for the 6.82.0 routine scheduler: a fake coordinator with the real
// scheduler, store and decision table. Imported by the routines tests; never by the server.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { routinePaths } from '../routines-config.js'
import { RoutineScheduler, type RoutineSchedulerDeps, type RoutineSubmission } from '../routines-scheduler.js'
import type { QueryJobSnapshot } from '../query-job-types.js'

export const CHICAGO = 'America/Chicago'
/** Tue 2026-09-01 08:00 CDT, a skill routine's default slot. */
export const SLOT_8AM = Date.UTC(2026, 8, 1, 13, 0)

export interface FakeJobs {
  submissions: Array<Record<string, unknown>>
  jobs: Map<string, QueryJobSnapshot>
  failNext: Array<{ code: string; message: string }>
}

export function fakeSnapshot(jobId: string, request: Record<string, unknown>, at: number, status: QueryJobSnapshot['status'] = 'running'): QueryJobSnapshot {
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
    acceptedAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
    retentionUntil: new Date(at + 7 * 86_400_000).toISOString(),
  } as QueryJobSnapshot
}

export function routineHarness(overrides: Partial<RoutineSchedulerDeps> = {}, root = mkdtempSync(join(tmpdir(), 'cos-routines-'))) {
  const fake: FakeJobs = { submissions: [], jobs: new Map(), failNext: [] }
  let now = SLOT_8AM
  let durable = true
  let admissions = true
  let master = true
  let sessions = 0
  const skills = new Set(['good-morning', 'tableau-report', 'reflect'])
  const logs: string[] = []
  const deps: RoutineSchedulerDeps = {
    paths: routinePaths(root),
    submit: async (request): Promise<RoutineSubmission> => {
      const failure = fake.failNext.shift()
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code })
      const existing = [...fake.jobs.values()].find(job => job.clientJobId === request.clientJobId)
      if (existing) return { job: existing, created: false }
      fake.submissions.push(request)
      const job = fakeSnapshot(randomUUID(), request, now)
      fake.jobs.set(job.jobId, job)
      return { job, created: true }
    },
    findByClientGeneration: async clientJobId => [...fake.jobs.values()].find(job => job.clientJobId === clientJobId),
    getSnapshot: async jobId => {
      const job = fake.jobs.get(jobId)
      if (!job) throw new Error('not found')
      return job
    },
    createSession: () => `session-${++sessions}`,
    currentMessageEra: () => 'era-test',
    currentMessageMax: () => 41,
    ownerName: () => 'Jun',
    durableJobsEnabled: () => durable,
    admissionsOpen: () => admissions,
    skillExists: name => skills.has(name),
    masterEnabled: () => master,
    now: () => now,
    log: line => { logs.push(line) },
    ...overrides,
  }
  const make = () => new RoutineScheduler(deps)
  const scheduler = make()
  const finish = (jobId: string, status: QueryJobSnapshot['status'], text = 'done') => {
    const job = fake.jobs.get(jobId)!
    fake.jobs.set(jobId, {
      ...job,
      status,
      ...(status === 'completed' ? { response: text } : {}),
      ...(status === 'failed' ? { error: { code: 'provider_failed', message: 'claude-bridge: exit 1', retryable: false } } : {}),
      completedAt: new Date(now).toISOString(),
    } as QueryJobSnapshot)
  }
  return {
    root, fake, scheduler, logs, skills, deps, make, finish,
    setNow: (ms: number) => { now = ms },
    advance: (ms: number) => { now += ms },
    now: () => now,
    setDurable: (value: boolean) => { durable = value },
    setAdmissions: (value: boolean) => { admissions = value },
    setMaster: (value: boolean) => { master = value },
    jobOf: (routineId: string) => fake.submissions.filter(s => (s.origin as { id?: string })?.id === routineId),
  }
}
