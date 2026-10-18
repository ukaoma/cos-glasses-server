// 6.78.0 Messages steer: the journal side, against the REAL QueryJobStore and files. A steer
// row is journal-only like a trail row (no eventSeq, no ring slot, no updatedAt), idempotent by
// state rank, found by lineage across generations, carried only out of an interrupted or
// failed generation, and invisible to a 6.51.0 or 6.77.0 reader (ST-4).
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { QUERY_JOB_JOURNAL_EVENT_TYPES, QueryJobSteerConflictError, QueryJobStore, type QueryJobSteerFrame } from './query-job-store.js'
import { QueryJobStore as QueryJobStore6510 } from './__fixtures__/query-job-store-6.51.0.js'
import { requestFingerprint, parseQueryJobRequest, steerFallback, steerReadState, type QueryJobEventType } from './query-job-types.js'

const ALLOWLIST_6_77_0 = QUERY_JOB_JOURNAL_EVENT_TYPES.filter(type => type !== 'steer') as QueryJobEventType[]
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-steer-store-'))
  roots.push(root)
  return root
}
const S = () => randomUUID()

function request(clientJobId = randomUUID(), generation = 1): Record<string, unknown> {
  return { clientJobId, generation, query: 'read the README', sessionId: 'session-steer-store', activityToolMode: 'preview', steerable: true }
}

async function lines(root: string): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = []
  for (const file of (await readdir(root)).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(join(root, file), 'utf8')).split('\n')) if (line.trim()) out.push(JSON.parse(line))
  }
  return out
}

async function running(store: QueryJobStore, clientJobId = randomUUID(), generation = 1, sessionId = 'session-steer-store'): Promise<string> {
  const { job } = await store.admit({ ...request(clientJobId, generation), sessionId })
  await store.markStarting(job.jobId)
  await store.markRunning(job.jobId, { provider: 'claude' })
  await store.updateLinkage(job.jobId, { provider: 'claude', claudeRunId: 'owned' })
  return job.jobId
}

describe('steer rows are journal rows, never job events', () => {
  it('carry the current eventSeq, take no ring slot, never move updatedAt, and reach only steer subscribers', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const before = await store.getSnapshot(jobId)
    const events: unknown[] = []
    const frames: QueryJobSteerFrame[] = []
    const sub = await store.subscribe(jobId, 1, before.eventSeq, event => events.push(event), undefined, { listener: frame => frames.push(frame) })
    const steerId = S()
    await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'also check the tests', create: true })
    await store.appendSteer(jobId, { steerId, state: 'delivered' })
    await store.appendSteer(jobId, { steerId, state: 'folded' })
    sub.unsubscribe()
    const after = await store.getSnapshot(jobId)
    expect(after.eventSeq).toBe(before.eventSeq)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect((await store.replay(jobId, 1, 0)).events.map(e => e.eventSeq)).toEqual((await store.replay(jobId, 1, 0)).events.map(e => e.eventSeq))
    expect((await store.replay(jobId, 1, 0)).events.every(e => e.type !== 'steer')).toBe(true)
    expect(events).toEqual([])
    expect(frames.map(f => f.state)).toEqual(['accepted', 'delivered', 'folded'])
    expect(after.steers).toEqual([{ steerId, state: 'folded', at: expect.any(String), text: 'also check the tests' }])
    const rows = (await lines(root)).filter(r => r.type === 'steer')
    expect(rows.map(r => r.eventSeq)).toEqual([before.eventSeq, before.eventSeq, before.eventSeq])
    // The text is on the first row only.
    expect(rows.map(r => 'text' in r.eventData)).toEqual([true, false, false])
  })

  it('a state never moves back and a final state never changes; a lower row is history', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const steerId = S()
    await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })
    await store.appendSteer(jobId, { steerId, state: 'folded' })
    expect((await store.appendSteer(jobId, { steerId, state: 'delivered' })).applied).toBe(false)
    expect((await store.appendSteer(jobId, { steerId, state: 'too_late' })).applied).toBe(false)
    expect((await store.getSnapshot(jobId)).steers![0]!.state).toBe('folded')
  })

  it('hydration applies rows by rank: a duplicate or lower row an older process wrote changes nothing', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const steerId = S()
    await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })
    await store.appendSteer(jobId, { steerId, state: 'folded' })
    const folded = (await lines(root)).find(r => r.type === 'steer' && r.eventData.state === 'folded')!
    const stale = { ...folded, recordId: randomUUID(), eventData: { ...folded.eventData, state: 'delivered' } }
    const file = join(root, (await readdir(root)).find(f => f.endsWith('.jsonl'))!)
    await appendFile(file, `${JSON.stringify(stale)}\n`)
    const reboot = new QueryJobStore({ root, bootId: 'boot-b' })
    expect((await reboot.init()).malformedRows).toBe(0)
    expect((await reboot.getSnapshot(jobId)).steers!.map(s => s.state)).toEqual(['folded'])
  })

  it('a steer row with a state that is never journaled (not_applied) or a bad id is malformed', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const steerId = S()
    await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })
    const row = (await lines(root)).find(r => r.type === 'steer')!
    const file = join(root, (await readdir(root)).find(f => f.endsWith('.jsonl'))!)
    await appendFile(file, `${JSON.stringify({ ...row, recordId: randomUUID(), eventData: { ...row.eventData, state: 'not_applied' } })}\n`)
    await appendFile(file, `${JSON.stringify({ ...row, recordId: randomUUID(), eventData: { ...row.eventData, steerId: 'bad' } })}\n`)
    const reboot = new QueryJobStore({ root, bootId: 'boot-b' })
    expect((await reboot.init()).malformedRows).toBe(2)
    expect((await reboot.getSnapshot(jobId)).steers!.map(s => s.state)).toEqual(['accepted'])
  })

  it('the same id with the same text replays; with other text it is a conflict', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const steerId = S()
    expect((await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })).applied).toBe(true)
    expect(await store.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })).toMatchObject({ applied: false, steer: { state: 'accepted' } })
    await expect(store.appendSteer(jobId, { steerId, state: 'accepted', text: 'y', create: true })).rejects.toBeInstanceOf(QueryJobSteerConflictError)
    expect((await lines(root)).filter(r => r.type === 'steer')).toHaveLength(1)
  })

  it('accepted on a job that is answering or ended is written too_late, decided inside the write', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    await store.markAnswerReady(jobId, 'done')
    expect((await store.appendSteer(jobId, { steerId: S(), state: 'accepted', text: 'x', create: true })).steer.state).toBe('too_late')
    await store.complete(jobId, { text: 'done' })
    const late = await store.appendSteer(jobId, { steerId: S(), state: 'accepted', text: 'y', create: true })
    expect(late.steer.state).toBe('too_late')
    expect(late.job.status).toBe('completed')
  })
})

describe('reading: not_applied is computed, never journaled', () => {
  it('an accepted or delivered steer of an ended job reads not_applied, and a live frame says so before the terminal event', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    const [a, b, c] = [S(), S(), S()]
    await store.appendSteer(jobId, { steerId: a, state: 'accepted', text: 'a', create: true })
    await store.appendSteer(jobId, { steerId: b, state: 'accepted', text: 'b', create: true })
    await store.appendSteer(jobId, { steerId: b, state: 'delivered' })
    await store.appendSteer(jobId, { steerId: c, state: 'accepted', text: 'c', create: true })
    await store.appendSteer(jobId, { steerId: c, state: 'folded' })
    const order: string[] = []
    const seq = (await store.getSnapshot(jobId)).eventSeq
    const sub = await store.subscribe(jobId, 1, seq, event => order.push(`event:${event.type}`), undefined, { listener: frame => order.push(`steer:${frame.state}`) })
    await store.fail(jobId, { code: 'provider_failed', message: 'boom' })
    sub.unsubscribe()
    expect(order).toEqual(['steer:not_applied', 'steer:not_applied', 'event:failed'])
    const snapshot = await store.getSnapshot(jobId)
    expect(snapshot.steers!.map(s => s.state)).toEqual(['accepted', 'delivered', 'folded'])
    expect(snapshot.steers!.map(s => steerReadState(s.state, snapshot.status))).toEqual(['not_applied', 'not_applied', 'folded'])
    expect((await lines(root)).filter(r => r.type === 'steer').some(r => r.eventData.state === 'not_applied')).toBe(false)
  })

  it('fallbacks: queue a follow-up for too_late, unsupported, and not_applied on a completed job only', () => {
    expect(steerFallback('too_late', 'completed')).toBe('queue_follow_up')
    expect(steerFallback('unsupported', 'running')).toBe('queue_follow_up')
    expect(steerFallback('not_applied', 'completed')).toBe('queue_follow_up')
    expect(steerFallback('not_applied', 'interrupted')).toBeNull()
    expect(steerFallback('not_applied', 'canceled')).toBeNull()
    expect(steerFallback('folded', 'answer_ready')).toBeNull()
    expect(steerFallback('accepted', 'running')).toBeNull()
    // P7 S1: decided from the journaled state. An accepted steer on a completed job falls
    // back; a delivered one (the CLI has it) never does, on any terminal.
    expect(steerFallback('accepted', 'completed')).toBe('queue_follow_up')
    for (const status of ['completed', 'failed', 'interrupted', 'canceled'] as const) {
      expect(steerFallback('delivered', status), status).toBeNull()
    }
  })
})

describe('the lineage index (V3 N7)', () => {
  it('finds a steer by clientJobId at its newest generation, after a restart and after its job body was evicted', async () => {
    const root = await tempRoot()
    const clientJobId = randomUUID()
    const a = new QueryJobStore({ root, bootId: 'boot-a' })
    await a.init()
    const gen1 = await running(a, clientJobId, 1)
    const steerId = S()
    await a.appendSteer(gen1, { steerId, state: 'accepted', text: 'carry me', create: true })
    await a.interrupt(gen1, 'server_shutdown')
    const gen2 = (await a.admit(request(clientJobId, 2))).job.jobId
    await a.appendSteer(gen2, { steerId, state: 'included', text: 'carry me', carriedFrom: 1, create: true })

    const b = new QueryJobStore({ root, bootId: 'boot-b', maxHydratedJobs: 1 })
    await b.init()
    // Fill the hydrated set with unrelated jobs so both generations are evicted.
    for (let i = 0; i < 3; i++) await b.admit({ ...request(), sessionId: `other-${i}` })
    const found = await b.findSteer(clientJobId, steerId)
    expect(found).toMatchObject({ jobId: gen2, generation: 2, steer: { state: 'included', carriedFrom: 1 } })
    expect(await b.findSteer(clientJobId, S())).toBeUndefined()
    expect(await b.findSteer(randomUUID(), steerId)).toBeUndefined()
  })
})

describe('carry-forward (ST-3)', () => {
  it('a Retry or Resume carries steers out of an interrupted or failed generation, never a canceled or completed one', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const carry = async (end: 'interrupt' | 'fail' | 'cancel' | 'complete', states: string[]) => {
      const clientJobId = randomUUID()
      const jobId = await running(store, clientJobId, 1, `session-${end}`)
      const ids: string[] = []
      for (const state of states) {
        const steerId = S()
        ids.push(steerId)
        await store.appendSteer(jobId, { steerId, state: state === 'too_late' || state === 'unsupported' ? state as never : 'accepted', text: `steer ${state}`, create: true })
        if (state === 'delivered' || state === 'folded') await store.appendSteer(jobId, { steerId, state: state as never })
      }
      if (end === 'interrupt') await store.interrupt(jobId, 'server_shutdown')
      else if (end === 'fail') await store.fail(jobId, { code: 'x', message: 'y' })
      else if (end === 'cancel') await store.cancel(jobId, 1)
      else await store.complete(jobId, { text: 'done' })
      return { clientJobId, ids, carried: await store.listCarryableSteers(clientJobId, 2) }
    }
    const interrupted = await carry('interrupt', ['accepted', 'delivered', 'folded', 'too_late', 'unsupported'])
    expect(interrupted.carried.map(s => s.steerId)).toEqual(interrupted.ids.slice(0, 3))
    expect(interrupted.carried.every(s => s.carriedFrom === 1)).toBe(true)
    expect((await carry('fail', ['accepted'])).carried).toHaveLength(1)
    expect((await carry('cancel', ['accepted', 'delivered'])).carried).toEqual([])
    expect((await carry('complete', ['accepted'])).carried).toEqual([])
  })

  it('carried steers do not count toward the per-job cap', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const jobId = await running(store)
    await store.appendSteer(jobId, { steerId: S(), state: 'included', text: 'carried', carriedFrom: 1, create: true })
    await store.appendSteer(jobId, { steerId: S(), state: 'accepted', text: 'own', create: true })
    expect(await store.steerCount(jobId)).toBe(1)
  })
})

describe('the answer checkpoint (ST-5): every terminal but cancel completes with it', () => {
  async function checkpointed(store: QueryJobStore, sessionId = 'session-steer-store'): Promise<{ jobId: string; steerId: string }> {
    const { job } = await store.admit({ ...request(), sessionId })
    await store.markStarting(job.jobId)
    await store.markRunning(job.jobId, { provider: 'claude', resolvedModel: 'opus' })
    await store.updateLinkage(job.jobId, { provider: 'claude', claudeRunId: 'owned' })
    const steerId = S()
    await store.appendSteer(job.jobId, { steerId, state: 'accepted', text: 'one more thing', create: true })
    await store.appendPartial(job.jobId, 'The whole answer.', 'The whole answer.')
    await store.appendSteerCheckpoint(job.jobId, 'The whole answer.')
    await store.appendPartial(job.jobId, '\n\nAnd the start of a second', 'The whole answer.\n\nAnd the start of a second')
    return { jobId: job.jobId, steerId }
  }

  it('a deadline, an inactivity kill or a second-turn error (store.fail) completes with the checkpoint', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const { jobId } = await checkpointed(store)
    const result = await store.fail(jobId, { code: 'provider_timeout', message: 'deadline' })
    expect(result.job).toMatchObject({ status: 'completed', response: 'The whole answer.', provider: 'claude' })
    expect(steerReadState(result.job.steers![0]!.state, result.job.status)).toBe('not_applied')
  })

  it('a restart completes with it, on the boot path and the graceful one, with no orphan fence', async () => {
    const root = await tempRoot()
    const a = new QueryJobStore({ root, bootId: 'boot-a' })
    await a.init()
    const crashed = await checkpointed(a, 'session-crash')
    const graceful = await checkpointed(a, 'session-graceful')
    expect((await a.interrupt(graceful.jobId, 'server_shutdown')).job).toMatchObject({ status: 'completed', response: 'The whole answer.' })
    const b = new QueryJobStore({ root, bootId: 'boot-b' })
    const health = await b.init()
    expect(health.interruptedOnBoot).toBe(0)
    const snapshot = await b.getSnapshot(crashed.jobId)
    expect(snapshot).toMatchObject({ status: 'completed', response: 'The whole answer.' })
    expect(snapshot).not.toHaveProperty('orphanFenceUntil')
  })

  it('cancel stays a cancel', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const { jobId } = await checkpointed(store)
    expect((await store.cancel(jobId, 1)).job.status).toBe('canceled')
  })

  it('a checkpoint is written only on a running job, and never reaches a snapshot', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-a' })
    await store.init()
    const { job } = await store.admit(request())
    expect((await store.appendSteerCheckpoint(job.jobId, 'x')).applied).toBe(false)
    const { jobId } = await checkpointed(store)
    expect(JSON.stringify(await store.getSnapshot(jobId))).not.toContain('checkpoint')
  })
})

describe('rollback (ST-4): 6.51.0 and the 6.77.0 allowlist skip steer rows, reuse no eventSeq, keep the terminal', () => {
  it('both readers hydrate the job whole, skip only the steer rows, and a roll-forward keeps the steers', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await running(writer)
    const steerId = S()
    await writer.appendSteer(jobId, { steerId, state: 'accepted', text: 'x', create: true })
    await writer.appendPartial(jobId, 'The answer', 'The answer')
    await writer.appendSteer(jobId, { steerId, state: 'folded' })
    await writer.markAnswerReady(jobId, 'The answer')
    await writer.complete(jobId, { text: 'The answer' })
    await writer.appendSteer(jobId, { steerId: S(), state: 'accepted', text: 'late', create: true })
    const current = await writer.getSnapshot(jobId)

    const old677 = new QueryJobStore({ root, bootId: 'boot-b', journalEventTypes: ALLOWLIST_6_77_0 })
    expect((await old677.init()).malformedRows).toBe(3)
    const { steers: _steers, ...withoutSteers } = current
    expect(await old677.getSnapshot(jobId)).toEqual(withoutSteers)

    const old651 = new QueryJobStore6510({ root, bootId: 'boot-c' })
    expect((await old651.init()).malformedRows).toBe(3)
    const rolledBack = await old651.getSnapshot(jobId)
    expect(rolledBack).toMatchObject({ status: 'completed', response: 'The answer', eventSeq: current.eventSeq })

    const forward = new QueryJobStore({ root, bootId: 'boot-d' })
    expect((await forward.init()).malformedRows).toBe(0)
    expect(await forward.getSnapshot(jobId)).toEqual(current)
    const jobSeqs = (await lines(root)).filter(r => r.jobId === jobId && r.type !== 'steer').map(r => r.eventSeq)
    expect(new Set(jobSeqs).size).toBe(jobSeqs.length)
  })

  it('a job left mid-steer: a rolled-back reader interrupts it at its boot and numbers its event after the last it can read', async () => {
    const root = await tempRoot()
    const writer = new QueryJobStore({ root, bootId: 'boot-a' })
    await writer.init()
    const jobId = await running(writer)
    await writer.appendSteer(jobId, { steerId: S(), state: 'accepted', text: 'x', create: true })
    await writer.appendSteerCheckpoint(jobId, 'whole')
    const seq = (await writer.getSnapshot(jobId)).eventSeq
    const old = new QueryJobStore6510({ root, bootId: 'boot-b' })
    await old.init()
    expect(await old.getSnapshot(jobId)).toMatchObject({ status: 'interrupted', eventSeq: seq + 1 })
  })

  it('steerable is outside the fingerprint, so a build that does not know it hydrates the job', () => {
    const withIt = parseQueryJobRequest(request())
    const { steerable: _s, ...withoutIt } = withIt
    expect(withIt.steerable).toBe(true)
    expect(requestFingerprint(withIt)).toBe(requestFingerprint(withoutIt as typeof withIt))
    expect(parseQueryJobRequest({ ...request(), steerable: 'yes' })).not.toHaveProperty('steerable')
  })
})
