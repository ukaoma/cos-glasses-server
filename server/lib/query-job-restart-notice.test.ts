// 6.78.0 restart truth (plan v3.1 P2) against the REAL QueryJobStore journal and coordinator:
// a crash then boot (`server_restarted`), a graceful shutdown (`server_shutdown`, what
// index.ts gracefulShutdown runs inside its 8-second budget), and crash-loop parking, each
// with COS_RESTART_NOTICE on (the default) and off. A "crash" abandons a store with no
// shutdown code run and opens a new one, with a new boot id, on the same directory.
//
// Deliberately does not import model-router.js (its graph reaches claude-bridge.ts, which
// touches /tmp/cos-cli-sessions.json at import) or query-job-runtime.js.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./conversation.js', () => ({
  getOrCreateSession: () => 'restart-notice-session',
}))

import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { NodeQueryJobJournalStorage, QueryJobStore } from './query-job-store.js'
import { QueryJobStore as QueryJobStore6510 } from './__fixtures__/query-job-store-6.51.0.js'
import { QUERY_JOB_RESTART_MESSAGE, type QueryJobEvent } from './query-job-types.js'
import { crashLoopParkedError } from './boot-resume.js'

const CONTRACT = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/pi-durable/contracts/interrupted-job.json'), 'utf8'))
const LEGACY_BOOT_MESSAGE = CONTRACT.legacy_6_77.error.message as string

const roots: string[] = []
const savedEnv = process.env.COS_RESTART_NOTICE
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.COS_RESTART_NOTICE
  else process.env.COS_RESTART_NOTICE = savedEnv
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-restart-notice-'))
  roots.push(root)
  return root
}

function request(clientJobId = randomUUID(), generation = 1, sessionId = 'session-restart-notice'): Record<string, unknown> {
  return { clientJobId, generation, query: 'push the branch, then read the README', sessionId, activityToolMode: 'preview' }
}

async function journal(root: string): Promise<Array<Record<string, any>>> {
  const files = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
  const rows: Array<Record<string, any>> = []
  for (const file of files) for (const line of (await readFile(join(root, file), 'utf8')).split('\n')) if (line.trim()) rows.push(JSON.parse(line))
  return rows
}

/** A run that owns its provider and journaled the QJ-6b steps: a finished push, a read in flight. */
async function runningWithSteps(store: QueryJobStore, sessionId?: string): Promise<string> {
  const { job } = await store.admit(request(randomUUID(), 1, sessionId))
  await store.markStarting(job.jobId)
  await store.markRunning(job.jobId, { provider: 'claude', resolvedModel: 'opus' })
  await store.updateLinkage(job.jobId, { provider: 'claude', claudeRunId: 'owned-child' })
  await store.appendTrail(job.jobId, { kind: 'tool', verb: 'bash', target: 'git push origin feature/logo-strip', detail: '', call: 'toolu_push_1' })
  await store.appendTrail(job.jobId, { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'pushed', call: 'toolu_push_1' } })
  await store.appendTrail(job.jobId, { kind: 'tool', verb: 'read', target: 'README.md', detail: '', call: 'toolu_read_2' })
  await store.appendPartial(job.jobId, 'Pushed. ', 'Pushed. ')
  return job.jobId
}

/** Trail appends take `delayMs` each; everything else is the real storage. */
class SlowTrailStorage extends NodeQueryJobJournalStorage {
  trailRows = 0
  constructor(private readonly delayMs: number) { super() }
  override async append(root: string, partitionDay: string, line: string): Promise<void> {
    if ((JSON.parse(line) as { type?: string }).type === 'trail') {
      await new Promise(resolve => setTimeout(resolve, this.delayMs))
      this.trailRows++
    }
    return super.append(root, partitionDay, line)
  }
}

/** A coordinator whose run owns its provider, reports `steps` edit steps without awaiting them, then waits for abort. */
function steppingCoordinator(store: QueryJobStore, steps: number, options: ConstructorParameters<typeof QueryJobCoordinator>[2] = {}) {
  let reported!: () => void
  const ready = new Promise<void>(resolve => { reported = resolve })
  const runner: QueryJobRunner = async ({ callbacks, request: req, signal }) => {
    await callbacks.onStart({ sessionId: req.sessionId, provider: 'claude' })
    await callbacks.onProviderProcess({ provider: 'claude', claudeRunId: 'owned-child' })
    for (let i = 0; i < steps; i++) callbacks.onTrail({ kind: 'tool', verb: 'edit', target: `file-${i}.ts`, detail: '', call: `toolu_step_${i}` })
    reported()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  const coordinator = new QueryJobCoordinator(store, runner, { partialFlushMs: 0, ...options })
  return {
    coordinator,
    submit: async () => {
      const { job } = await coordinator.submit(request())
      await ready
      return job.jobId
    },
  }
}

const QJ6B_INTERRUPTION = {
  cutOffDuring: 'reading README.md',
  alreadyDone: ['ran git push origin feature/logo-strip'],
  incomplete: false,
  resumable: true,
}

describe('a crash then boot names what it cut off (server_restarted, RN-1)', () => {
  it('error.cause and the interruption are set at construction, journaled, and survive another reboot', async () => {
    const root = await tempRoot()
    const clock = new Date('2026-10-18T19:31:02.000Z')
    const before = new QueryJobStore({ root, bootId: 'boot-before-crash', now: () => new Date(clock) })
    await before.init()
    const jobId = await runningWithSteps(before)

    const after = new QueryJobStore({ root, bootId: 'boot-after-crash', now: () => new Date(clock) })
    expect((await after.init()).interruptedOnBoot).toBe(1)
    const snapshot = await after.getSnapshot(jobId)
    expect(snapshot.status).toBe('interrupted')
    expect(snapshot.error).toEqual({ code: 'interrupted', message: QUERY_JOB_RESTART_MESSAGE, retryable: true, cause: 'server_restarted' })
    expect(snapshot.interruption).toEqual({ cause: 'server_restarted', at: clock.toISOString(), ...QJ6B_INTERRUPTION })
    // The contract's keys, exactly (values are this run's).
    expect(Object.keys(snapshot.interruption!).sort()).toEqual(Object.keys(CONTRACT.restart.interruption).sort())
    expect(Object.keys(snapshot.error!).sort()).toEqual(Object.keys(CONTRACT.restart.error).sort())
    // The orphan fence is untouched by the notice.
    expect(snapshot.orphanFenceUntil).toBeTruthy()

    const row = (await journal(root)).find(r => r.jobId === jobId && r.type === 'interrupted')!
    expect(row.patch.interruption).toEqual(snapshot.interruption)
    expect(row.eventData.interruption).toEqual(snapshot.interruption)
    expect(row.patch.error.cause).toBe('server_restarted')

    const again = new QueryJobStore({ root, bootId: 'boot-later', now: () => new Date(clock) })
    await again.init()
    expect(await again.getSnapshot(jobId)).toEqual(snapshot)
  })

  it('a job that never reached a provider was cut off during nothing', async () => {
    const root = await tempRoot()
    const before = new QueryJobStore({ root, bootId: 'boot-a' })
    await before.init()
    const { job } = await before.admit(request())
    await before.markStarting(job.jobId)
    const after = new QueryJobStore({ root, bootId: 'boot-b' })
    await after.init()
    expect((await after.getSnapshot(job.jobId)).interruption).toMatchObject({ cause: 'server_restarted', cutOffDuring: null, alreadyDone: [], incomplete: false, resumable: true })
  })

  it('a job at answer_ready still completes from the journal; it gets no interruption', async () => {
    const root = await tempRoot()
    const before = new QueryJobStore({ root, bootId: 'boot-a' })
    await before.init()
    const jobId = await runningWithSteps(before)
    await before.markAnswerReady(jobId, 'The answer.')
    const after = new QueryJobStore({ root, bootId: 'boot-b' })
    await after.init()
    const snapshot = await after.getSnapshot(jobId)
    expect(snapshot.status).toBe('completed')
    expect(snapshot).not.toHaveProperty('interruption')
    expect(snapshot.response).toBe('The answer.')
  })
})

describe('a graceful shutdown names what it cut off (server_shutdown, RN-1b)', () => {
  it('coordinator.shutdown, as gracefulShutdown runs it, interrupts the active run with the notice, live and on disk', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-graceful' })
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const runner: QueryJobRunner = async ({ callbacks, request: req, signal }) => {
      await callbacks.onStart({ sessionId: req.sessionId, provider: 'claude', resolvedModel: 'opus' })
      expect(await callbacks.onProviderProcess({ provider: 'claude', claudeRunId: 'owned-child' })).toBe(true)
      callbacks.onTrail({ kind: 'tool', verb: 'edit', target: 'api-client.ts', detail: '', call: 'toolu_edit_1' })
      callbacks.onTrail({ kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'ok', call: 'toolu_edit_1' } })
      callbacks.onTrail({ kind: 'tool', verb: 'bash', target: 'npm test', detail: '', call: 'toolu_test_2' })
      callbacks.onTrail({ kind: 'status', state: 'working', detail: 'Running the test suite.' })
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    const coordinator = new QueryJobCoordinator(store, runner, { partialFlushMs: 0 })
    await coordinator.init()
    const { job } = await coordinator.submit(request())
    await running
    // The trail callbacks were queued, not awaited: the interrupt must still see every one.
    const events: QueryJobEvent[] = []
    const sub = await coordinator.subscribe(job.jobId, 1, 0, event => events.push(event))
    const t0 = performance.now()
    await coordinator.shutdown('server_shutdown')
    const elapsedMs = performance.now() - t0
    sub.unsubscribe()

    const snapshot = await store.getSnapshot(job.jobId)
    expect(snapshot.status).toBe('interrupted')
    expect(snapshot.error).toEqual({ code: 'interrupted', message: QUERY_JOB_RESTART_MESSAGE, retryable: true, cause: 'server_shutdown' })
    expect(snapshot.interruption).toMatchObject({
      cause: 'server_shutdown', cutOffDuring: 'running the test suite', alreadyDone: ['edited api-client.ts'], incomplete: false, resumable: true,
    })
    // The live event a connected lens gets carries it too.
    const live = events.find(event => event.type === 'interrupted')!
    expect(live.data.interruption).toEqual(snapshot.interruption)
    expect((live.data.error as { message: string }).message).toBe(QUERY_JOB_RESTART_MESSAGE)
    // Far inside the 8-second force-exit budget (a journal write is the only I/O).
    expect(elapsedMs).toBeLessThan(2_000)
    // The raw reason never reaches a client any more.
    expect(JSON.stringify(snapshot)).not.toContain('"message":"server_shutdown"')

    const reboot = new QueryJobStore({ root, bootId: 'boot-after-graceful' })
    await reboot.init()
    expect(await reboot.getSnapshot(job.jobId)).toEqual(snapshot)
  })

  it('the drain is bounded: a run with slow queued writes is interrupted when the bound runs out', async () => {
    const root = await tempRoot()
    const slow = new SlowTrailStorage(150)
    const store = new QueryJobStore({ root, bootId: 'boot-slow', storage: slow })
    const { coordinator, submit } = steppingCoordinator(store, 10, { shutdownDrainMs: 100 })
    await coordinator.init()
    const jobId = await submit()
    const t0 = performance.now()
    await coordinator.shutdown('server_shutdown')
    const elapsedMs = performance.now() - t0
    expect((await store.getSnapshot(jobId)).status).toBe('interrupted')
    // Ten queued writes at 150 ms would take 1.5 s; the bound plus the write in flight is far less.
    expect(elapsedMs).toBeLessThan(800)
    expect(slow.trailRows).toBeLessThan(10)
  })

  it('with COS_RESTART_NOTICE=0 the interrupt is written at once, ahead of queued steps, as 6.77.0 did', async () => {
    for (const notice of [true, false]) {
      const root = await tempRoot()
      const store = new QueryJobStore({ root, bootId: `boot-${notice}` })
      const { coordinator, submit } = steppingCoordinator(store, 4, { restartNotice: () => notice })
      await coordinator.init()
      const jobId = await submit()
      await coordinator.shutdown('server_shutdown')
      const trailRows = (await journal(root)).filter(row => row.jobId === jobId && row.type === 'trail').length
      // Off: whatever was already in the store's queue, never all four (timing decides 0 or 1).
      if (notice) expect(trailRows).toBe(4)
      else expect(trailRows).toBeLessThan(4)
    }
  })

  it('built inside the serialized write: a trail row journaled just before the interrupt is in the record', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-race' })
    await store.init()
    const jobId = await runningWithSteps(store)
    // Not awaited: queued ahead of the interrupt on the store's append tail.
    const pending = [
      store.appendTrail(jobId, { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'ok', call: 'toolu_read_2' } }),
      store.appendTrail(jobId, { kind: 'tool', verb: 'write', target: 'notes.md', detail: '', call: 'toolu_write_3' }),
    ]
    const result = await store.interrupt(jobId, 'server_shutdown')
    await Promise.all(pending)
    expect(result.job.interruption).toMatchObject({ cutOffDuring: 'writing notes.md', alreadyDone: ['ran git push origin feature/logo-strip'] })
  })
})

describe('crash-loop parking carries its interruption (6.78.0)', () => {
  it('a parked job: restart_limit, the parked copy and cause, never resumable, the list never complete', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-park', now: () => new Date('2026-10-18T19:31:02.000Z') })
    await store.init()
    const { job } = await store.admit(request())
    const result = await store.interruptParked(job.jobId, crashLoopParkedError())
    expect(result.job.error).toEqual(CONTRACT.parked.error)
    expect(result.job.interruption).toEqual(CONTRACT.parked.interruption)
    expect(result.job.status).toBe(CONTRACT.parked.status)
  })
})

describe('COS_RESTART_NOTICE=0 is the MVP-C build exactly (G-off)', () => {
  it('boot: the 6.77.0 message, no cause, no interruption, in the snapshot and in the journal', async () => {
    process.env.COS_RESTART_NOTICE = '0'
    const root = await tempRoot()
    const before = new QueryJobStore({ root, bootId: 'boot-a' })
    await before.init()
    const jobId = await runningWithSteps(before)
    const after = new QueryJobStore({ root, bootId: 'boot-b' })
    await after.init()
    const snapshot = await after.getSnapshot(jobId)
    expect(snapshot.error).toEqual({ code: 'interrupted', message: LEGACY_BOOT_MESSAGE, retryable: true })
    expect(snapshot).not.toHaveProperty('interruption')
    const row = (await journal(root)).find(r => r.jobId === jobId && r.type === 'interrupted')!
    expect(Object.keys(row.patch).sort()).toEqual(['completedAt', 'error', 'orphanFenceUntil'])
    expect(Object.keys(row.eventData).sort()).toEqual(['error', 'orphanFenceUntil'])
  })

  it('graceful shutdown: the raw 6.77.0 reason, no cause, no interruption', async () => {
    for (const value of ['0', 'false', 'off', ' OFF ']) {
      process.env.COS_RESTART_NOTICE = value
      const root = await tempRoot()
      const store = new QueryJobStore({ root, bootId: 'boot-a' })
      await store.init()
      const jobId = await runningWithSteps(store, `session-${value.trim()}`)
      const { job } = await store.interrupt(jobId, 'server_shutdown')
      expect(job.error, value).toEqual({ code: 'interrupted', message: 'server_shutdown', retryable: true })
      expect(job, value).not.toHaveProperty('interruption')
    }
  })

  it('parked: the MVP-C error, no interruption', async () => {
    process.env.COS_RESTART_NOTICE = '0'
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-park' })
    await store.init()
    const { job } = await store.admit(request())
    const result = await store.interruptParked(job.jobId, crashLoopParkedError())
    expect(result.job.error).toEqual(crashLoopParkedError())
    expect(result.job).not.toHaveProperty('interruption')
  })

  it('the flag is read on every interrupt, and an unknown value is the default (on)', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    process.env.COS_RESTART_NOTICE = '0'
    const off = await store.interrupt(await runningWithSteps(store, 'session-1'), 'server_shutdown')
    process.env.COS_RESTART_NOTICE = 'maybe'
    const on = await store.interrupt(await runningWithSteps(store, 'session-2'), 'server_shutdown')
    expect(off.job).not.toHaveProperty('interruption')
    expect(on.job.interruption?.cause).toBe('server_shutdown')
  })

  it('any other interrupt reason is untouched by the notice, flag on', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const { job } = await store.interrupt(await runningWithSteps(store), 'session_reset')
    expect(job.error).toEqual({ code: 'interrupted', message: 'session_reset', retryable: true })
    expect(job).not.toHaveProperty('interruption')
  })
})

describe('rollback: a 6.51.0 to 6.77.x reader ignores the new fields (journal schema unchanged)', () => {
  it('the vendored 6.51.0 store hydrates an interrupted job with its cause and interruption, with no malformed row', async () => {
    const root = await tempRoot()
    const before = new QueryJobStore({ root, bootId: 'boot-a' })
    await before.init()
    const jobId = await runningWithSteps(before)
    const after = new QueryJobStore({ root, bootId: 'boot-b' })
    await after.init()

    const old = new QueryJobStore6510({ root, bootId: 'boot-rolled-back' })
    const health = await old.init()
    // The three trail rows are the only rows 6.51.0 cannot read (the 6.52.0 contract).
    expect(health.malformedRows).toBe(3)
    const rolledBack = await old.getSnapshot(jobId)
    expect(rolledBack.status).toBe('interrupted')
    expect(rolledBack.error).toMatchObject({ code: 'interrupted', message: QUERY_JOB_RESTART_MESSAGE, retryable: true })
    expect(rolledBack).not.toHaveProperty('interruption')
    expect(rolledBack.partialText).toBe('Pushed. ')
  })
})
