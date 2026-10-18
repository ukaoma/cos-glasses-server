// 6.78.0 (MVP-C): the query-job boot requeue behind the crash-loop gate, executed against the
// REAL QueryJobStore journal and the real gate (lib/boot-resume.ts). Each boot is a new store
// with a new boot id, a new gate over the same ledger and a new coordinator, the way a new
// process opens them. A start that kills the process (what CL-2 models) is a session lock that
// never resolves: the boot is abandoned there, before markStarting, with no shutdown code run.
//
// Deliberately does not import model-router.js (its graph reaches claude-bridge.ts, which
// touches /tmp/cos-cli-sessions.json at import); the session lock is injected instead.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('./conversation.js', () => ({
  getOrCreateSession: () => 'test-conversation',
}))

import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'
import { normalizeQueryJobError } from './query-job-types.js'
import { RESTART_LIMIT, createBootResumeGate, crashLoopParkedError, type BootResumeGate } from './boot-resume.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SESSION = 'session-boot-resume'
const BOOTS = RESTART_LIMIT * 2 + 2

function request(clientJobId: string, generation = 1): Record<string, unknown> {
  return { clientJobId, generation, query: 'a question whose start crashes the server', sessionId: SESSION, activityToolMode: 'preview' }
}

/** A prior boot that opened its ledger, admitted one question and died before starting it. */
async function priorBoot(options: { ledgerAtCrash?: boolean } = {}): Promise<{ root: string; ledger: string; clientJobId: string; jobId: string }> {
  const root = mkdtempSync(join(tmpdir(), 'cos-qj-boot-resume-'))
  roots.push(root)
  const store = new QueryJobStore({ root: join(root, 'query-jobs'), bootId: randomUUID(), requeueNeverStartedOnBoot: true })
  await store.init()
  const clientJobId = randomUUID()
  const { job } = await store.admit(request(clientJobId))
  const ledger = join(root, 'boot-resume-ledger.json')
  // What that process left: it opened its boot (marker cleared) and never shut down cleanly.
  if (options.ledgerAtCrash !== false) writeFileSync(ledger, JSON.stringify({ version: 1, cleanShutdown: false, entries: {} }))
  return { root, ledger, clientJobId, jobId: job.jobId }
}

interface Boot {
  coordinator: QueryJobCoordinator
  store: QueryJobStore
  gate: BootResumeGate
  /** Jobs handed to a start this boot (the session lock is requested first thing in execute). */
  handedBack: string[]
  runnerCalls: number
  /** The ledger file as it was when each start began. */
  ledgerAtStart: string[]
}

async function boot(root: string, ledger: string, options: {
  start?: 'crash' | 'run'
  gated?: boolean
  env?: NodeJS.ProcessEnv
} = {}): Promise<Boot> {
  const store = new QueryJobStore({ root: join(root, 'query-jobs'), bootId: randomUUID(), requeueNeverStartedOnBoot: true })
  const gate = createBootResumeGate({ path: ledger, env: options.env ?? {}, log: () => {} })
  // index.ts opens the boot before the runtime starts; an ungated boot (6.77.0) has no gate at all.
  if (options.gated !== false) gate.openBoot()
  const state: Boot = { coordinator: null as unknown as QueryJobCoordinator, store, gate, handedBack: [], runnerCalls: 0, ledgerAtStart: [] }
  const runner: QueryJobRunner = async ctx => {
    state.runnerCalls++
    await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
    await ctx.callbacks.onDone({ text: 'answer' })
  }
  state.coordinator = new QueryJobCoordinator(store, runner, {
    partialFlushMs: 0,
    acquireSessionLock: () => {
      state.handedBack.push('start')
      state.ledgerAtStart.push(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '')
      return options.start === 'run' ? () => {} : new Promise<() => void>(() => {})
    },
    ...(options.gated === false ? {} : { bootResumeGate: () => gate }),
  })
  await state.coordinator.init()
  await new Promise(resolve => setImmediate(resolve))
  return state
}

async function snapshotAfterReboot(root: string, jobId: string) {
  // Production's store: a never-started job stays `accepted` across this read's own boot.
  const reader = new QueryJobStore({ root: join(root, 'query-jobs'), bootId: randomUUID(), requeueNeverStartedOnBoot: true })
  await reader.init()
  return reader.getSnapshot(jobId)
}

describe('query-job boot requeue behind the crash-loop gate (6.78.0)', () => {
  it('a question whose start crashes the server is handed back on at most 3 crashed boots, then parked, never run', async () => {
    const { root, ledger, clientJobId, jobId } = await priorBoot()
    let handedBack = 0, runs = 0
    for (let i = 0; i < BOOTS; i++) {
      const b = await boot(root, ledger, { start: 'crash' })
      handedBack += b.handedBack.length
      runs += b.runnerCalls
    }
    expect(handedBack).toBe(RESTART_LIMIT)
    expect(runs).toBe(0)
    // Keyed by lineage (clientJobId), not by the generation's jobId.
    const gate = createBootResumeGate({ path: ledger, env: {}, log: () => {} })
    expect(gate.status('query_job', clientJobId)).toMatchObject({ parked: true, reason: 'restart_limit', phase: 'start', attempts: RESTART_LIMIT + 1 })
    expect(gate.status('query_job', jobId)).toBeNull()
  })

  it('a parked question ends interrupted with restart_limit, the copy and the cause, and survives a reboot that way', async () => {
    const { root, ledger, jobId } = await priorBoot()
    for (let i = 0; i < RESTART_LIMIT + 1; i++) await boot(root, ledger, { start: 'crash' })
    const job = await snapshotAfterReboot(root, jobId)
    expect(job.status).toBe('interrupted')
    expect(job.error).toEqual(crashLoopParkedError())
    expect(job.error).toEqual({
      code: 'restart_limit',
      message: 'Stopped after 3 server crashes.',
      retryable: true,
      cause: 'crash_loop_parked',
    })
    // It never started, so no provider can own its session: no orphan fence.
    expect(job.orphanFenceUntil).toBeUndefined()
    expect(job.startedAt).toBeUndefined()
  })

  it('the app\'s Resume (generation 2 of the same clientJobId) is admitted and gets a fresh count', async () => {
    const { root, ledger, clientJobId } = await priorBoot()
    for (let i = 0; i < RESTART_LIMIT + 1; i++) await boot(root, ledger, { start: 'crash' })
    // Another crashed boot; the person taps Resume while it is up. Its start crashes again.
    const resumedBoot = await boot(root, ledger, { start: 'crash' })
    expect(resumedBoot.handedBack).toEqual([])
    const resumed = await resumedBoot.coordinator.submit(request(clientJobId, 2))
    expect(resumed).toMatchObject({ created: true, job: { clientJobId, generation: 2, status: 'accepted' } })
    expect(resumedBoot.gate.status('query_job', clientJobId)).toMatchObject({ parked: false, attempts: 0, retriedAt: expect.any(String) })
    expect(JSON.parse(readFileSync(ledger, 'utf8')).entries[`query_job:${clientJobId}`]).toMatchObject({ parked: false, attempts: 0 })
    // The next boot hands generation 2 back: Resume really is another chance.
    const next = await boot(root, ledger, { start: 'crash' })
    expect(next.handedBack).toHaveLength(1)
    expect(next.gate.status('query_job', clientJobId)).toMatchObject({ parked: false, attempts: 1 })
  })

  it('counts before the start: the ledger already holds the count when the handed-back job starts', async () => {
    const { root, ledger, clientJobId } = await priorBoot()
    const b = await boot(root, ledger, { start: 'crash' })
    expect(b.ledgerAtStart).toHaveLength(1)
    expect(JSON.parse(b.ledgerAtStart[0]!).entries[`query_job:${clientJobId}`]).toMatchObject({ attempts: 1, phase: 'start' })
  })

  it('a handed-back question that starts is forgotten: a started job is never handed back by a boot again', async () => {
    const { root, ledger, clientJobId, jobId } = await priorBoot()
    await boot(root, ledger, { start: 'crash' })
    expect(createBootResumeGate({ path: ledger, env: {}, log: () => {} }).status('query_job', clientJobId)).toMatchObject({ attempts: 1 })
    const b = await boot(root, ledger, { start: 'run' })
    expect(b.handedBack).toHaveLength(1)
    const done = await vi.waitFor(async () => {
      const job = await b.store.getSnapshot(jobId)
      if (job.status !== 'completed') throw new Error(job.status)
      return job
    })
    expect(done.response).toBe('answer')
    expect(b.runnerCalls).toBe(1)
    expect(b.gate.status('query_job', clientJobId)).toBeNull()
  })

  it('with no ledger yet the first boot is clean: one uncounted hand-back, then 3 counted, then parked', async () => {
    const { root, ledger, clientJobId } = await priorBoot({ ledgerAtCrash: false })
    let handedBack = 0
    for (let i = 0; i < BOOTS; i++) handedBack += (await boot(root, ledger, { start: 'crash' })).handedBack.length
    expect(handedBack).toBe(RESTART_LIMIT + 1)
    expect(createBootResumeGate({ path: ledger, env: {}, log: () => {} }).status('query_job', clientJobId)).toMatchObject({ parked: true, attempts: RESTART_LIMIT + 1 })
  })

  it('routine restarts never park a held question (Update Server mid-hold)', async () => {
    const { root, ledger, jobId } = await priorBoot()
    let handedBack = 0
    for (let i = 0; i < BOOTS; i++) {
      const b = await boot(root, ledger, { start: 'crash' })
      handedBack += b.handedBack.length
      b.gate.markCleanShutdown()
    }
    expect(handedBack).toBe(BOOTS)
    expect((await snapshotAfterReboot(root, jobId)).status).toBe('accepted')
  })

  it('without a gate (and with COS_CRASH_LOOP_PARKING=0) every boot hands it back, as 6.77.0 did, and no ledger is written', async () => {
    for (const options of [{ gated: false }, { env: { COS_CRASH_LOOP_PARKING: '0' } }]) {
      const { root, ledger, jobId } = await priorBoot({ ledgerAtCrash: false })
      let handedBack = 0
      for (let i = 0; i < BOOTS; i++) handedBack += (await boot(root, ledger, { start: 'crash', ...options })).handedBack.length
      expect(handedBack, JSON.stringify(options)).toBe(BOOTS)
      expect(existsSync(ledger), JSON.stringify(options)).toBe(false)
      expect((await snapshotAfterReboot(root, jobId)).status).toBe('accepted')
    }
  })
})

describe('QueryJobStore.interruptParked (6.78.0)', () => {
  it('ends only a job that never started; a started or terminal job is left alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-qj-park-only-'))
    roots.push(root)
    const store = new QueryJobStore({ root, bootId: randomUUID() })
    await store.init()
    const never = await store.admit(request(randomUUID()))
    const started = await store.admit({ ...request(randomUUID()), sessionId: 'session-started' })
    await store.markStarting(started.job.jobId)
    expect(await store.interruptParked(never.job.jobId, crashLoopParkedError())).toMatchObject({
      applied: true, job: { status: 'interrupted', error: crashLoopParkedError() },
    })
    expect(await store.interruptParked(started.job.jobId, crashLoopParkedError())).toMatchObject({ applied: false, job: { status: 'starting' } })
    expect(await store.interruptParked(never.job.jobId, crashLoopParkedError())).toMatchObject({ applied: false, job: { status: 'interrupted' } })
    expect(store.lineageOf(never.job.jobId)).toBe(never.job.clientJobId)
    expect(store.lineageOf('no-such-job')).toBeNull()
  })
})

describe('error.cause is allowlisted (6.78.0)', () => {
  it('keeps crash_loop_parked and drops every other cause, including an Error\'s own', () => {
    expect(normalizeQueryJobError({ code: 'restart_limit', message: 'm', cause: 'crash_loop_parked' })).toMatchObject({ cause: 'crash_loop_parked' })
    expect(normalizeQueryJobError({ code: 'x', message: 'm', cause: 'server_restarted' })).not.toHaveProperty('cause')
    expect(normalizeQueryJobError(new Error('boom', { cause: new Error('inner') }))).not.toHaveProperty('cause')
  })
})
