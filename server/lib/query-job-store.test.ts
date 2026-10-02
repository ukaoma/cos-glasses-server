import { appendFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  NodeQueryJobJournalStorage,
  QUERY_JOB_BOOT_REQUEUE_MAX_AGE_MS,
  QUERY_JOB_ORPHAN_FENCE_MS,
  QueryJobPersistenceError,
  QueryJobProviderOrphanFenceError,
  QueryJobStore,
  type QueryJobJournalStorage,
} from './query-job-store.js'
import { QUERY_JOB_LIMITS } from './query-job-types.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cos-query-jobs-'))
  roots.push(root)
  return root
}

function request(
  clientJobId = randomUUID(),
  generation = 1,
  query = 'durable prompt',
): Record<string, unknown> {
  return {
    clientJobId,
    generation,
    query,
    sessionId: 'session-durable-1',
    activityToolMode: 'preview',
  }
}

class FailOnRecordStorage implements QueryJobJournalStorage {
  readonly inner = new NodeQueryJobJournalStorage()

  constructor(private readonly failType: string) {}

  prepare(root: string): Promise<void> { return this.inner.prepare(root) }
  listPartitions(root: string): Promise<string[]> { return this.inner.listPartitions(root) }
  readPartition(root: string, partition: string): Promise<string> {
    return this.inner.readPartition(root, partition)
  }
  removePartition(root: string, partition: string): Promise<void> {
    return this.inner.removePartition(root, partition)
  }
  append(root: string, partitionDay: string, line: string): Promise<void> {
    if ((JSON.parse(line) as { type?: string }).type === this.failType) {
      return Promise.reject(Object.assign(new Error(`injected ${this.failType} fsync failure`), { code: 'EIO' }))
    }
    return this.inner.append(root, partitionDay, line)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('QueryJobStore durable journal', () => {
  it('keeps a near-midnight partition through the exact per-job retention boundary', async () => {
    const root = await tempRoot()
    let clock = new Date('2026-07-11T04:59:00.000Z') // Jul 10 23:59 America/Chicago
    const original = new QueryJobStore({
      root,
      bootId: 'boot-retention-a',
      retentionDays: 1,
      now: () => new Date(clock),
    })
    await original.init()
    const admitted = await original.admit(request())
    expect(admitted.job.retentionUntil).toBe('2026-07-12T04:59:00.000Z')

    clock = new Date('2026-07-11T05:01:00.000Z') // next local day, TTL still has 23h58m
    const beforeExpiry = new QueryJobStore({
      root,
      bootId: 'boot-retention-b',
      retentionDays: 1,
      now: () => new Date(clock),
    })
    await beforeExpiry.init()
    expect((await beforeExpiry.getSnapshot(admitted.job.jobId)).retentionUntil)
      .toBe('2026-07-12T04:59:00.000Z')

    clock = new Date('2026-07-12T05:00:00.000Z') // first local midnight after TTL
    const afterExpiry = new QueryJobStore({
      root,
      bootId: 'boot-retention-c',
      retentionDays: 1,
      now: () => new Date(clock),
    })
    await afterExpiry.init()
    await expect(afterExpiry.getSnapshot(admitted.job.jobId)).rejects.toMatchObject({
      code: 'query_job_not_found',
    })
  })

  it('uses private modes and hydrates through a torn tail plus a terminal acknowledgement', async () => {
    const root = await tempRoot()
    const now = new Date('2026-07-17T16:00:00.000Z')
    const store = new QueryJobStore({ root, bootId: 'boot-a', now: () => new Date(now) })
    await store.init()

    const admitted = await store.admit(request())
    await store.markStarting(admitted.job.jobId)
    await store.markRunning(admitted.job.jobId, { provider: 'codex', resolvedModel: 'gpt-5' })
    await store.markAnswerReady(admitted.job.jobId, 'answer')
    await store.complete(admitted.job.jobId, { text: 'answer', provider: 'codex' })

    const [partition] = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, partition))).mode & 0o777).toBe(0o600)
    await appendFile(join(root, partition), '{"torn":', 'utf8')

    const restarted = new QueryJobStore({ root, bootId: 'boot-b', now: () => new Date(now) })
    const health = await restarted.init()
    expect(health.malformedRows).toBeGreaterThanOrEqual(1)
    expect((await restarted.getSnapshot(admitted.job.jobId)).status).toBe('completed')

    const acknowledged = await restarted.acknowledge(admitted.job.jobId, 1)
    expect(acknowledged.applied).toBe(true)
    expect(acknowledged.job.acknowledgedAt).toBe(now.toISOString())
    const duplicateAck = await restarted.acknowledge(admitted.job.jobId, 1)
    expect(duplicateAck.applied).toBe(false)
    expect(duplicateAck.job.eventSeq).toBe(acknowledged.job.eventSeq)

    const hydratedAgain = new QueryJobStore({ root, bootId: 'boot-c', now: () => new Date(now) })
    await hydratedAgain.init()
    expect((await hydratedAgain.getSnapshot(admitted.job.jobId)).acknowledgedAt).toBe(now.toISOString())
  })

  it('persists an ollama linkage through the journal and a rehydrate (6.39.1)', async () => {
    // 6.39.0 allowed provider 'ollama' in the types and the runtime stamped it,
    // but safeLinkage stripped it on persist -- so a replayed Ollama job came
    // back providerless and the phone could never acknowledge it. These two
    // asserts are against the JOURNAL round trip, not the in-memory snapshot.
    const root = await tempRoot()
    const clock = new Date('2026-08-26T20:00:00.000Z')
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-ollama', now: () => new Date(clock) })
    const admitted = await priorBoot.admit(request(randomUUID()))
    await priorBoot.markStarting(admitted.job.jobId)
    await priorBoot.markRunning(admitted.job.jobId, { provider: 'ollama', resolvedModel: 'ollama' })
    await priorBoot.updateLinkage(admitted.job.jobId, { provider: 'ollama', ollamaRunId: 'local-run-1' })

    const restarted = new QueryJobStore({ root, bootId: 'boot-ollama-2', now: () => new Date(clock) })
    await restarted.init()
    const replayed = await restarted.getSnapshot(admitted.job.jobId)
    expect(replayed.provider).toBe('ollama')
    expect(replayed.ollamaRunId).toBe('local-run-1')
  })

  it('still strips an unknown provider on persist', async () => {
    const root = await tempRoot()
    const clock = new Date('2026-08-26T20:10:00.000Z')
    const store = new QueryJobStore({ root, bootId: 'boot-unknown', now: () => new Date(clock) })
    const admitted = await store.admit(request(randomUUID()))
    await store.markStarting(admitted.job.jobId)
    await store.markRunning(admitted.job.jobId, { provider: 'lmstudio' as never, resolvedModel: 'x' })

    const restarted = new QueryJobStore({ root, bootId: 'boot-unknown-2', now: () => new Date(clock) })
    await restarted.init()
    const replayed = await restarted.getSnapshot(admitted.job.jobId)
    expect(replayed.provider).toBeUndefined()
  })

  it('classifies prior-boot work as interrupted and fences every client id in that provider session', async () => {
    const root = await tempRoot()
    let clock = new Date('2026-07-17T16:00:00.000Z')
    const clientJobId = randomUUID()
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-before-crash', now: () => new Date(clock) })
    const admitted = await priorBoot.admit(request(clientJobId))
    await priorBoot.markStarting(admitted.job.jobId)
    await priorBoot.markRunning(admitted.job.jobId, { provider: 'codex' })
    await priorBoot.updateLinkage(admitted.job.jobId, { provider: 'codex', codexRunId: 'spawned-run' })

    const restarted = new QueryJobStore({ root, bootId: 'boot-after-crash', now: () => new Date(clock) })
    const health = await restarted.init()
    const interrupted = await restarted.getSnapshot(admitted.job.jobId)
    expect(health.interruptedOnBoot).toBe(1)
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.error?.code).toBe('interrupted')
    expect(interrupted.providerOwnershipConfirmedAt).toBe(clock.toISOString())
    expect(interrupted.orphanFenceUntil).toBe(
      new Date(clock.getTime() + QUERY_JOB_ORPHAN_FENCE_MS).toISOString(),
    )

    // 6.61.3: the fence holds the START, never the admission. Both the retry and a fresh
    // client id in the same session are journaled now (the phone gets its 202) and
    // neither may start a provider until the fence clears.
    const retry = await restarted.admit(request(clientJobId, 2))
    const freshId = await restarted.admit(request(randomUUID(), 1))
    expect(retry).toMatchObject({ created: true, job: { status: 'accepted', generation: 2 } })
    expect(freshId).toMatchObject({ created: true, job: { status: 'accepted' } })
    expect(restarted.sessionFenceUntil('session-durable-1')).toBe(clock.getTime() + QUERY_JOB_ORPHAN_FENCE_MS)
    await expect(restarted.markStarting(retry.job.jobId)).rejects.toMatchObject({
      code: 'provider_orphan_fence',
      retryAfterMs: QUERY_JOB_ORPHAN_FENCE_MS,
    } satisfies Partial<QueryJobProviderOrphanFenceError>)
    await expect(restarted.markStarting(freshId.job.jobId)).rejects.toMatchObject({
      code: 'provider_orphan_fence',
      retryAfterMs: QUERY_JOB_ORPHAN_FENCE_MS,
    } satisfies Partial<QueryJobProviderOrphanFenceError>)
    expect((await restarted.getSnapshot(retry.job.jobId)).status).toBe('accepted')
    const unrelatedSession = await restarted.admit({
      ...request(randomUUID(), 1),
      sessionId: 'session-durable-unrelated',
    })
    expect(unrelatedSession.created).toBe(true)
    expect(restarted.sessionFenceUntil('session-durable-unrelated')).toBe(0)
    expect((await restarted.markStarting(unrelatedSession.job.jobId)).applied).toBe(true)

    clock = new Date(clock.getTime() + QUERY_JOB_ORPHAN_FENCE_MS + 1)
    const started = await restarted.markStarting(retry.job.jobId)
    expect(started).toMatchObject({ applied: true, job: { status: 'starting', generation: 2 } })
  })

  it('reports a canceled held job as not applied, never as fenced (6.61.3)', async () => {
    const root = await tempRoot()
    const clock = new Date('2026-07-17T18:00:00.000Z')
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-cancel-held-a', now: () => new Date(clock) })
    const owner = await priorBoot.admit(request())
    await priorBoot.markStarting(owner.job.jobId)
    await priorBoot.markRunning(owner.job.jobId, { provider: 'claude' })
    await priorBoot.updateLinkage(owner.job.jobId, { provider: 'claude', claudeRunId: 'owned-child' })

    const restarted = new QueryJobStore({ root, bootId: 'boot-cancel-held-b', now: () => new Date(clock) })
    await restarted.init()
    const held = await restarted.admit(request())
    await restarted.cancel(held.job.jobId, 1)
    const result = await restarted.markStarting(held.job.jobId)
    expect(result).toMatchObject({ applied: false, job: { status: 'canceled' } })
  })

  it('does not orphan-fence work that never reached a provider process', async () => {
    const root = await tempRoot()
    const clientJobId = randomUUID()
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-pre-provider' })
    const admitted = await priorBoot.admit(request(clientJobId))
    await priorBoot.markStarting(admitted.job.jobId)
    await priorBoot.markRunning(admitted.job.jobId, { provider: 'codex', codexRunId: 'allocated-before-spawn' })

    const restarted = new QueryJobStore({ root, bootId: 'boot-pre-provider-restart' })
    await restarted.init()
    const interrupted = await restarted.getSnapshot(admitted.job.jobId)
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted).not.toHaveProperty('orphanFenceUntil')
    const retry = await restarted.admit(request(clientJobId, 2))
    expect(retry).toMatchObject({ created: true, job: { generation: 2 } })
  })

  it('persists a session-scoped fence for graceful shutdown after provider ownership', async () => {
    const root = await tempRoot()
    const clock = new Date('2026-07-17T17:00:00.000Z')
    const store = new QueryJobStore({ root, bootId: 'boot-graceful-a', now: () => new Date(clock) })
    const admitted = await store.admit(request())
    await store.markStarting(admitted.job.jobId)
    await store.markRunning(admitted.job.jobId, { provider: 'claude' })
    await store.updateLinkage(admitted.job.jobId, { provider: 'claude', claudeRunId: 'owned-child' })
    const interrupted = await store.interrupt(admitted.job.jobId, 'server_shutdown')
    expect(interrupted.job).toMatchObject({
      status: 'interrupted',
      providerOwnershipConfirmedAt: clock.toISOString(),
      orphanFenceUntil: new Date(clock.getTime() + QUERY_JOB_ORPHAN_FENCE_MS).toISOString(),
    })

    const restarted = new QueryJobStore({ root, bootId: 'boot-graceful-b', now: () => new Date(clock) })
    await restarted.init()
    const held = await restarted.admit(request(randomUUID()))
    expect(held.created).toBe(true)
    await expect(restarted.markStarting(held.job.jobId)).rejects.toMatchObject({
      code: 'provider_orphan_fence',
    })
  })

  it('keeps a recent never-started job accepted across a restart and hands it over once (6.61.3)', async () => {
    const root = await tempRoot()
    let clock = new Date('2026-07-17T19:00:00.000Z')
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-requeue-a', now: () => new Date(clock) })
    const recent = await priorBoot.admit(request())
    const started = await priorBoot.admit({ ...request(), sessionId: 'session-requeue-started' })
    await priorBoot.markStarting(started.job.jobId)

    clock = new Date(clock.getTime() + 60_000)
    const restarted = new QueryJobStore({ root, bootId: 'boot-requeue-b', now: () => new Date(clock) })
    const health = await restarted.init()
    expect(health).toMatchObject({ requeuedOnBoot: 1, interruptedOnBoot: 1 })
    expect((await restarted.getSnapshot(recent.job.jobId)).status).toBe('accepted')
    // `starting` cannot go back to `accepted`, so it keeps the old classification.
    expect((await restarted.getSnapshot(started.job.jobId)).status).toBe('interrupted')
    expect(restarted.takeRequeuedOnBoot()).toEqual([recent.job.jobId])
    expect(restarted.takeRequeuedOnBoot()).toEqual([])
  })

  it('interrupts a never-started job older than the requeue bound, as before (6.61.3)', async () => {
    const root = await tempRoot()
    let clock = new Date('2026-07-17T08:00:00.000Z')
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-requeue-old-a', now: () => new Date(clock) })
    const stale = await priorBoot.admit(request())
    const edge = await priorBoot.admit({ ...request(), sessionId: 'session-requeue-edge' })

    clock = new Date(clock.getTime() + QUERY_JOB_BOOT_REQUEUE_MAX_AGE_MS)
    const atBound = new QueryJobStore({ root, bootId: 'boot-requeue-old-b', now: () => new Date(clock) })
    await atBound.init()
    expect(atBound.takeRequeuedOnBoot().sort()).toEqual([stale.job.jobId, edge.job.jobId].sort())

    clock = new Date(clock.getTime() + 1)
    const pastBound = new QueryJobStore({ root, bootId: 'boot-requeue-old-c', now: () => new Date(clock) })
    const health = await pastBound.init()
    expect(health).toMatchObject({ requeuedOnBoot: 0, interruptedOnBoot: 2 })
    expect((await pastBound.getSnapshot(stale.job.jobId))).toMatchObject({
      status: 'interrupted',
      error: { code: 'interrupted' },
    })
    expect(pastBound.takeRequeuedOnBoot()).toEqual([])
  })

  it('commits a prior-boot answer-ready reply with its era and provider identity intact', async () => {
    const root = await tempRoot()
    const clientJobId = randomUUID()
    const priorBoot = new QueryJobStore({ root, bootId: 'boot-answer-ready' })
    const admitted = await priorBoot.admit({
      ...request(clientJobId),
      messageEra: 'era-2026-07-17',
    })
    await priorBoot.markStarting(admitted.job.jobId)
    await priorBoot.markRunning(admitted.job.jobId, {
      provider: 'codex',
      resolvedModel: 'codex-frontier',
    })
    await priorBoot.updateLinkage(admitted.job.jobId, {
      provider: 'codex',
      codexRunId: 'answer-ready-run',
      codexThreadId: 'answer-ready-thread',
    })
    await priorBoot.markAnswerReady(admitted.job.jobId, 'reply survived restart')

    const restarted = new QueryJobStore({ root, bootId: 'boot-after-answer-ready' })
    const health = await restarted.init()
    expect(health.interruptedOnBoot).toBe(0)
    expect(await restarted.getSnapshot(admitted.job.jobId)).toMatchObject({
      status: 'completed',
      response: 'reply survived restart',
      messageEra: 'era-2026-07-17',
      provider: 'codex',
      resolvedModel: 'codex-frontier',
      codexRunId: 'answer-ready-run',
      codexThreadId: 'answer-ready-thread',
    })
  })

  it('fails closed when accepted or terminal persistence fails', async () => {
    const acceptedRoot = await tempRoot()
    const acceptedStore = new QueryJobStore({
      root: acceptedRoot,
      bootId: 'boot-accepted-failure',
      storage: new FailOnRecordStorage('accepted'),
    })
    await acceptedStore.init()
    await expect(acceptedStore.admit(request())).rejects.toBeInstanceOf(QueryJobPersistenceError)
    expect(acceptedStore.getHealth()).toMatchObject({ state: 'degraded', retainedIdentities: 0 })

    const terminalRoot = await tempRoot()
    const terminalStore = new QueryJobStore({
      root: terminalRoot,
      bootId: 'boot-terminal-failure',
      storage: new FailOnRecordStorage('completed'),
    })
    const admitted = await terminalStore.admit(request())
    await terminalStore.markStarting(admitted.job.jobId)
    await terminalStore.markAnswerReady(admitted.job.jobId, 'safe answer')
    const seen: string[] = []
    const subscription = await terminalStore.subscribe(admitted.job.jobId, 1, 0, event => seen.push(event.type))
    seen.splice(0, seen.length)
    await expect(terminalStore.complete(admitted.job.jobId, { text: 'safe answer' }))
      .rejects.toBeInstanceOf(QueryJobPersistenceError)
    expect((await terminalStore.getSnapshot(admitted.job.jobId)).status).toBe('answer_ready')
    expect(seen).not.toContain('completed')
    expect(terminalStore.getHealth().state).toBe('degraded')
    subscription.unsubscribe()
  })

  it('persists only bounded numeric output-image aggregates', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({ root, bootId: 'boot-image-stats' })
    const admitted = await store.admit(request())
    await store.markStarting(admitted.job.jobId)
    await store.complete(admitted.job.jobId, {
      text: 'answer with partial images',
      outputImageStats: {
        published: 2,
        attached: 1,
        rejected: 1,
        path: '/Users/miles/private-output.png',
        bytes: 'secret-image-bytes',
      },
    })
    expect((await store.getSnapshot(admitted.job.jobId)).outputImageStats).toEqual({
      published: 2,
      attached: 1,
      rejected: 1,
    })
    const journal = (await Promise.all(
      (await readdir(root)).filter(name => name.endsWith('.jsonl'))
        .map(name => import('node:fs/promises').then(fs => fs.readFile(join(root, name), 'utf8'))),
    )).join('\n')
    expect(journal).not.toContain('/Users/')
    expect(journal).not.toContain('secret-image-bytes')
  })

  it('bounds replay, hydrated jobs, activity, and partial text without losing identities', async () => {
    const root = await tempRoot()
    const store = new QueryJobStore({
      root,
      bootId: 'boot-bounds',
      maxHydratedJobs: 2,
      maxReplayEvents: 2,
      maxActivityEntries: 2,
    })
    const ids: string[] = []
    for (let index = 0; index < 3; index++) {
      const admitted = await store.admit(request(randomUUID(), 1, `prompt ${index}`))
      ids.push(admitted.job.jobId)
      await store.fail(admitted.job.jobId, { code: 'test_failure', message: 'done' })
    }
    expect(store.getHealth()).toMatchObject({ hydratedJobs: 2, retainedIdentities: 3 })
    expect((await store.getSnapshot(ids[0])).jobId).toBe(ids[0])
    expect(store.getHealth().hydratedJobs).toBe(2)

    const active = await store.admit(request())
    await store.markStarting(active.job.jobId)
    await store.markRunning(active.job.jobId, { provider: 'claude' })
    const replay = await store.replay(active.job.jobId, 1, 0)
    expect(replay.gap).toBe(true)
    expect(replay.reason).toBe('buffer_overflow')

    const oversized = 'x'.repeat(QUERY_JOB_LIMITS.partialChars + 20)
    await store.appendPartial(active.job.jobId, oversized, oversized, true)
    await store.appendActivity(active.job.jobId, 'output', `Bearer verysecretcredential /Users/miles/private ${'z'.repeat(3_000)}`)
    await store.appendActivity(active.job.jobId, 'status', 'working')
    await store.appendActivity(active.job.jobId, 'input', 'third item')
    const snapshot = await store.getSnapshot(active.job.jobId)
    expect(snapshot.partialText).toHaveLength(QUERY_JOB_LIMITS.partialChars)
    expect(snapshot.partialTruncated).toBe(true)
    expect(snapshot.activity).toHaveLength(2)
    expect(JSON.stringify(snapshot.activity)).not.toContain('verysecretcredential')
    expect(JSON.stringify(snapshot.activity)).not.toContain('/Users/')
  })

  it('removes daily partitions outside the seven-day retention window', async () => {
    const root = await tempRoot()
    const oldClock = new Date('2026-07-01T18:00:00.000Z')
    const oldStore = new QueryJobStore({ root, bootId: 'boot-old', now: () => new Date(oldClock) })
    await oldStore.admit(request())
    expect((await readdir(root)).some(name => name.endsWith('.jsonl'))).toBe(true)

    const currentClock = new Date('2026-07-17T18:00:00.000Z')
    const current = new QueryJobStore({ root, bootId: 'boot-current', now: () => new Date(currentClock) })
    await current.init()
    expect((await readdir(root)).filter(name => name.endsWith('.jsonl'))).toHaveLength(0)
    expect(current.getHealth().retainedIdentities).toBe(0)
  })
})
