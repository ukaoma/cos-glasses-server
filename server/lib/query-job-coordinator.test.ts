import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi, afterAll } from 'vitest'

vi.mock('./conversation.js', () => ({
  getOrCreateSession: () => 'test-conversation',
}))

import {
  DRAIN_HOLD_STATUS,
  QueryJobCoordinator,
  holdClock,
  orphanFenceHoldStatus,
  type QueryJobRunner,
  type QueryJobRunnerContext,
} from './query-job-coordinator.js'
import { acquireModelSessionRunLock } from './model-router.js'
import {
  NodeQueryJobJournalStorage,
  QUERY_JOB_ORPHAN_FENCE_MS,
  QueryJobAnswerCommittingError,
  QueryJobGenerationMismatchError,
  QueryJobIdentityConflictError,
  QueryJobStore,
  type QueryJobJournalStorage,
} from './query-job-store.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const roots: string[] = []

class FailRunningStorage implements QueryJobJournalStorage {
  private readonly inner = new NodeQueryJobJournalStorage()
  prepare(root: string) { return this.inner.prepare(root) }
  listPartitions(root: string) { return this.inner.listPartitions(root) }
  readPartition(root: string, partition: string) { return this.inner.readPartition(root, partition) }
  removePartition(root: string, partition: string) { return this.inner.removePartition(root, partition) }
  append(root: string, partitionDay: string, line: string): Promise<void> {
    const record = JSON.parse(line) as { type?: string }
    if (record.type === 'running') return Promise.reject(new Error('injected running journal failure'))
    return this.inner.append(root, partitionDay, line)
  }
}

class FailTerminalStorage implements QueryJobJournalStorage {
  private readonly inner = new NodeQueryJobJournalStorage()
  constructor(private readonly terminalType: 'completed' | 'failed') {}
  prepare(root: string) { return this.inner.prepare(root) }
  listPartitions(root: string) { return this.inner.listPartitions(root) }
  readPartition(root: string, partition: string) { return this.inner.readPartition(root, partition) }
  removePartition(root: string, partition: string) { return this.inner.removePartition(root, partition) }
  append(root: string, partitionDay: string, line: string): Promise<void> {
    const record = JSON.parse(line) as { type?: string }
    if (record.type === this.terminalType) {
      return Promise.reject(new Error(`injected ${this.terminalType} journal failure`))
    }
    return this.inner.append(root, partitionDay, line)
  }
}

async function coordinator(
  runner: QueryJobRunner,
  options: ConstructorParameters<typeof QueryJobCoordinator>[2] = {},
): Promise<QueryJobCoordinator> {
  const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-coordinator-')))
  roots.push(root)
  const value = new QueryJobCoordinator(
    new QueryJobStore({ root, bootId: randomUUID() }),
    runner,
    { resolveSessionId: () => 'resolved-session', partialFlushMs: 0, ...options },
  )
  await value.init()
  return value
}

function admission(clientJobId = randomUUID(), generation = 1, query = 'hello'): Record<string, unknown> {
  return { clientJobId, generation, query, activityToolMode: 'preview' }
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    value = await read()
  }
  if (!accept(value)) throw new Error('condition_not_reached')
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('QueryJobCoordinator provider ownership', () => {
  it('persists provider-run ownership before allowing the runner to continue', async () => {
    let linkagePersisted = false
    const value = await coordinator(async ctx => {
      await ctx.callbacks.onStart({
        provider: 'codex',
        resolvedModel: 'codex-frontier',
        sessionId: ctx.request.sessionId,
      })
      await ctx.callbacks.onProviderProcess({
        provider: 'codex',
        resolvedModel: 'codex-frontier',
        codexRunId: 'codex-run-public-1',
      })
      linkagePersisted = true
      await ctx.callbacks.onDone({ text: 'owned answer' })
    })
    const admitted = await value.submit(admission())
    const completed = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )

    expect(linkagePersisted).toBe(true)
    expect(completed).toMatchObject({
      provider: 'codex',
      resolvedModel: 'codex-frontier',
      codexRunId: 'codex-run-public-1',
      response: 'owned answer',
    })
  })

  it('waits for a delayed terminal callback after the runner spawn promise resolves', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      setTimeout(() => {
        void Promise.resolve(ctx.callbacks.onDone({ text: 'delayed durable answer', provider: 'codex' }))
      }, 25)
    })
    const admitted = await value.submit(admission())

    const completed = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(context).toBeDefined()
    expect(completed.response).toBe('delayed durable answer')
    expect(completed.error).toBeUndefined()
    expect(value.getHealth().activeRuns).toBe(0)
  })

  it('continues provider work after every subscriber disconnects', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ provider: 'claude', resolvedModel: 'opus', sessionId: ctx.request.sessionId })
    })
    const admitted = await value.submit(admission())
    await waitFor(() => context, Boolean)

    const subscription = await value.subscribe(admitted.job.jobId, 1, 0, () => {})
    expect(subscription.replay.events.length).toBeGreaterThan(0)
    subscription.unsubscribe()
    expect(context!.signal.aborted).toBe(false)

    context!.callbacks.onChunk('still running')
    await context!.callbacks.onDone({ text: 'finished without subscribers', provider: 'claude' })
    const completed = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(completed.response).toBe('finished without subscribers')
    expect(context!.signal.aborted).toBe(false)
  })

  it('allocates one session and spawns once for simultaneous immutable retries', async () => {
    let allocations = 0
    let runs = 0
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      runs++
      context = ctx
    }, {
      resolveSessionId: () => {
        allocations++
        return 'one-session'
      },
    })
    const raw = admission()
    const [first, retry] = await Promise.all([value.submit(raw), value.submit({ ...raw })])
    expect(first.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(retry.job.jobId).toBe(first.job.jobId)
    expect(retry.job.sessionId).toBe('one-session')
    await waitFor(() => context, Boolean)
    expect(allocations).toBe(1)
    expect(runs).toBe(1)

    await expect(value.submit({ ...raw, query: 'mutated retry' }))
      .rejects.toBeInstanceOf(QueryJobIdentityConflictError)
    await value.cancel(first.job.jobId, 1)
  })

  it('generation-fences cancellation and never lets a late old cancel abort new work', async () => {
    const contexts = new Map<string, QueryJobRunnerContext>()
    const value = await coordinator(async ctx => { contexts.set(ctx.jobId, ctx) })
    const clientJobId = randomUUID()
    const first = await value.submit(admission(clientJobId, 1, 'first'))
    await waitFor(() => contexts.get(first.job.jobId), Boolean)

    await expect(value.cancel(first.job.jobId, 2)).rejects.toBeInstanceOf(QueryJobGenerationMismatchError)
    expect(contexts.get(first.job.jobId)!.signal.aborted).toBe(false)
    const canceled = await value.cancel(first.job.jobId, 1)
    expect(canceled.job.status).toBe('canceled')
    expect(contexts.get(first.job.jobId)!.signal.aborted).toBe(true)
    const canceledAgain = await value.cancel(first.job.jobId, 1)
    expect(canceledAgain.job.eventSeq).toBe(canceled.job.eventSeq)

    const second = await value.submit(admission(clientJobId, 2, 'second'))
    await waitFor(() => contexts.get(second.job.jobId), Boolean)
    await value.cancel(first.job.jobId, 1) // stale retry against the old job
    expect(contexts.get(second.job.jobId)!.signal.aborted).toBe(false)
    await contexts.get(second.job.jobId)!.callbacks.onDone({ text: 'new generation survived' })
    expect((await waitFor(
      () => value.getSnapshot(second.job.jobId),
      job => job.status === 'completed',
    )).response).toBe('new generation survived')
  })

  it('rejects a stale provider completion after cancellation without rewriting the terminal', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => { context = ctx })
    const admitted = await value.submit(admission())
    await waitFor(() => context, Boolean)
    const canceled = await value.cancel(admitted.job.jobId, 1)
    expect(canceled.job.status).toBe('canceled')

    expect(await context!.callbacks.onDone({ text: 'late provider output' })).toBe(false)
    expect(await context!.callbacks.onError({ code: 'late_error', message: 'also stale' })).toBe(false)
    expect(await value.getSnapshot(admitted.job.jobId)).toMatchObject({
      status: 'canceled',
      error: { code: 'canceled' },
    })
  })

  it('returns lost ownership to late provider and answer barriers after cancellation', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      return new Promise<void>(() => {})
    })
    const admitted = await value.submit(admission())
    await waitFor(() => context, Boolean)
    await value.cancel(admitted.job.jobId, 1)

    expect(await context!.callbacks.onProviderProcess({
      provider: 'codex', codexRunId: 'must-not-own',
    })).toBe(false)
    expect(await context!.callbacks.onAnswerReady('must not project', { provider: 'codex' })).toBe(false)
    expect(await value.getSnapshot(admitted.job.jobId)).toMatchObject({ status: 'canceled', partialText: '' })
  })

  it('6.58.2: a session the provider names mid-run is on the job while it is still running', async () => {
    const SID = '8f7a53b9-b478-4d88-88e4-4a915b256da5'
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const value = await coordinator(async ctx => {
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude', resolvedModel: 'opus' })
      await ctx.callbacks.onProviderProcess({ provider: 'claude', claudeRunId: 'claude-run-1' })
      await ctx.callbacks.onLinkage?.({ provider: 'claude', cliSessionId: SID })
      await gate
      await ctx.callbacks.onDone({ text: 'done' })
    })
    const admitted = await value.submit(admission())
    const running = await waitFor(() => value.getSnapshot(admitted.job.jobId), job => job?.cliSessionId === SID)
    expect(running).toMatchObject({ status: 'running', cliSessionId: SID, claudeRunId: 'claude-run-1' })
    release()
    const completed = await waitFor(() => value.getSnapshot(admitted.job.jobId), job => job?.status === 'completed')
    expect(completed.cliSessionId).toBe(SID)
  })

  it('6.58.2: a link that arrives after the job ended changes nothing', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      return new Promise<void>(() => {})
    })
    const admitted = await value.submit(admission())
    await waitFor(() => context, Boolean)
    await value.cancel(admitted.job.jobId, 1)
    await context!.callbacks.onLinkage?.({ provider: 'claude', cliSessionId: '8f7a53b9-b478-4d88-88e4-4a915b256da5' })
    const job = await value.getSnapshot(admitted.job.jobId)
    expect(job).toMatchObject({ status: 'canceled' })
    expect(job?.cliSessionId).toBeUndefined()
  })

  it('treats answer-ready as the commit point and refuses a late cancel', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      await ctx.callbacks.onAnswerReady('committing answer', { provider: 'codex' })
      return new Promise<void>(() => {})
    })
    const admitted = await value.submit(admission())
    await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'answer_ready',
    )
    await expect(value.cancel(admitted.job.jobId, 1)).rejects.toBeInstanceOf(QueryJobAnswerCommittingError)
    expect(context?.signal.aborted).toBe(false)
    expect(await context!.callbacks.onDone({ text: 'committing answer', provider: 'codex' })).toBe(true)
    expect((await value.getSnapshot(admitted.job.jobId)).status).toBe('completed')
  })

  it('persists typed runner failures and times out a runner that never settles', async () => {
    const busy = await coordinator(async () => {
      throw Object.assign(new Error('session already has an active model run'), { code: 'session_busy' })
    })
    const busyJob = await busy.submit(admission())
    const failed = await waitFor(
      () => busy.getSnapshot(busyJob.job.jobId),
      job => job.status === 'failed',
    )
    expect(failed.error).toMatchObject({ code: 'session_busy' })

    let timeoutContext: QueryJobRunnerContext | undefined
    const timed = await coordinator(async ctx => {
      timeoutContext = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      return new Promise<void>(() => {})
    }, { providerTimeoutMs: 1_000 })
    const timedJob = await timed.submit(admission())
    const timedOut = await waitFor(
      () => timed.getSnapshot(timedJob.job.jobId),
      job => job.status === 'failed',
      2_500,
    )
    expect(timedOut.error).toMatchObject({ code: 'provider_timeout', retryable: true })
    expect(timeoutContext?.signal.aborted).toBe(true)
  }, 5_000)

  it('does not spend the provider deadline while waiting for a session slot', async () => {
    const timed = await coordinator(async ctx => {
      // Models can queue behind a 15-20 minute turn in model-router. This
      // scaled wait exceeds the execution budget and would fail immediately
      // if the deadline started before onStart/session-lock acquisition.
      await new Promise(resolve => setTimeout(resolve, 1_100))
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      await new Promise(resolve => setTimeout(resolve, 100))
      await ctx.callbacks.onDone({ text: 'full execution budget preserved' })
    }, { providerTimeoutMs: 1_000 })
    const admitted = await timed.submit(admission())
    const completed = await waitFor(
      () => timed.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
      2_500,
    )
    expect(completed.response).toBe('full execution budget preserved')
  }, 4_000)

  it('commits an answer-ready response when only post-processing times out', async () => {
    let context: QueryJobRunnerContext | undefined
    const timed = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      await ctx.callbacks.onAnswerReady('provider already finished', { provider: 'claude' })
      return new Promise<void>(() => {})
    }, { providerTimeoutMs: 1_000 })
    const admitted = await timed.submit(admission())
    const completed = await waitFor(
      () => timed.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
      2_500,
    )
    expect(completed.response).toBe('provider already finished')
    expect(context?.signal.aborted).toBe(true)
  }, 4_000)

  it('releases the coordinator-owned session lease when answer post-processing hangs', async () => {
    let locked = false
    let releases = 0
    let runs = 0
    const value = await coordinator(async ctx => {
      runs++
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      if (runs === 1) {
        expect(await ctx.callbacks.onAnswerReady('durable before hang', { provider: 'claude' })).toBe(true)
        return new Promise<void>(() => {})
      }
      await ctx.callbacks.onDone({ text: 'second run acquired the released lease', provider: 'claude' })
    }, {
      providerTimeoutMs: 1_000,
      acquireSessionLock: async () => {
        if (locked) throw Object.assign(new Error('still locked'), { code: 'session_busy' })
        locked = true
        return () => {
          if (!locked) return
          locked = false
          releases++
        }
      },
    })

    const first = await value.submit(admission())
    expect((await waitFor(
      () => value.getSnapshot(first.job.jobId),
      job => job.status === 'completed',
      2_500,
    )).response).toBe('durable before hang')
    expect(locked).toBe(false)
    expect(releases).toBe(1)

    const second = await value.submit(admission())
    expect((await waitFor(
      () => value.getSnapshot(second.job.jobId),
      job => job.status === 'completed',
    )).response).toBe('second run acquired the released lease')
    expect(releases).toBe(2)
  }, 5_000)

  it('keeps the committed answer when the bridge reports an error after answer-ready', async () => {
    let errorOwned: boolean | undefined
    const value = await coordinator(async ctx => {
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      await ctx.callbacks.onAnswerReady('generation already committed', { provider: 'codex' })
      errorOwned = await ctx.callbacks.onError({
        code: 'postprocess_failed',
        message: 'bridge failed after generation',
      })
    })
    const admitted = await value.submit(admission())
    const completed = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(completed.response).toBe('generation already committed')
    expect(completed.error).toBeUndefined()
    expect(errorOwned).toBe(false)
    expect(value.getHealth().activeRuns).toBe(0)
  })

  it('settles answer-ready as completed during graceful shutdown', async () => {
    let context: QueryJobRunnerContext | undefined
    const value = await coordinator(async ctx => {
      context = ctx
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      await ctx.callbacks.onAnswerReady('survives graceful shutdown', { provider: 'claude' })
      return new Promise<void>(() => {})
    })
    const admitted = await value.submit(admission())
    await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'answer_ready',
    )

    await value.shutdown('server_shutdown')
    expect(await value.getSnapshot(admitted.job.jobId)).toMatchObject({
      status: 'completed',
      response: 'survives graceful shutdown',
      provider: 'claude',
    })
    expect(context?.signal.aborted).toBe(true)
    expect(value.getHealth().activeRuns).toBe(0)
  })

  it('aborts and releases active state when callback persistence fails', async () => {
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-coordinator-failure-')))
    roots.push(root)
    let context: QueryJobRunnerContext | undefined
    const value = new QueryJobCoordinator(
      new QueryJobStore({ root, bootId: randomUUID(), storage: new FailRunningStorage() }),
      async ctx => {
        context = ctx
        await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      },
      { resolveSessionId: () => 'resolved-session' },
    )
    await value.init()
    await value.submit(admission())
    const health = await waitFor(
      () => value.getHealth(),
      current => current.callbackPersistenceFailures === 1 && current.activeRuns === 0,
    )
    expect(health.store.state).toBe('degraded')
    expect(context?.signal.aborted).toBe(true)
  })

  it('absorbs complete and fail journal rejection without false display ownership', async () => {
    for (const terminalType of ['completed', 'failed'] as const) {
      const root = trackedTemp(await mkdtemp(join(tmpdir(), `cos-query-${terminalType}-failure-`)))
      roots.push(root)
      let context: QueryJobRunnerContext | undefined
      let terminalOwned: boolean | undefined
      let runnerReturned = false
      const value = new QueryJobCoordinator(
        new QueryJobStore({
          root,
          bootId: randomUUID(),
          storage: new FailTerminalStorage(terminalType),
        }),
        async ctx => {
          context = ctx
          await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
          terminalOwned = terminalType === 'completed'
            ? await ctx.callbacks.onDone({ text: 'must not display without terminal fsync' })
            : await ctx.callbacks.onError({ code: 'provider_failed', message: 'injected provider failure' })
          runnerReturned = true
        },
        { resolveSessionId: () => 'resolved-session', partialFlushMs: 0 },
      )
      await value.init()
      const admitted = await value.submit(admission())
      const health = await waitFor(
        () => value.getHealth(),
        current => current.callbackPersistenceFailures === 1 && current.activeRuns === 0,
      )

      expect(terminalOwned).toBe(false)
      expect(runnerReturned).toBe(true)
      expect(context?.signal.aborted).toBe(true)
      expect(health.store.state).toBe('degraded')
      expect((await value.getSnapshot(admitted.job.jobId)).status)
        .toBe(terminalType === 'completed' ? 'answer_ready' : 'running')
    }
  })

  it('releases the provider/session slot when terminal conversation projection fails', async () => {
    let completionOwned: boolean | undefined
    let runnerReturned = false
    const value = await coordinator(async ctx => {
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'codex' })
      completionOwned = await ctx.callbacks.onDone({ text: 'journal is still authoritative' })
      runnerReturned = true
    }, {
      projectTerminal: async () => {
        throw Object.assign(new Error('injected conversation fsync failure'), { code: 'EIO' })
      },
    })
    const admitted = await value.submit(admission())
    const completed = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    const health = await waitFor(
      () => value.getHealth(),
      current => current.activeRuns === 0 && current.terminalProjectionFailures === 1,
    )

    expect(completed.response).toBe('journal is still authoritative')
    expect(completionOwned).toBe(false)
    expect(runnerReturned).toBe(true)
    expect(health.store.state).toBe('ready')
  })
})

// 6.61.3, Miles 2026-10-02 17:38: every prompt from the glasses failed "Provider closing ·
// retry in 1192s" for twenty minutes after a restart interrupted a running job, and a phone
// that lost signal would never have sent them again. The contract under test: a prompt the
// Mac accepted runs to an answer with NO phone attached. None of these tests subscribes.
describe('QueryJobCoordinator orphan-fence hold (6.61.3)', () => {
  const HELD_SESSION = 'session-held'

  function heldRequest(clientJobId = randomUUID(), query = 'held prompt'): Record<string, unknown> {
    return { clientJobId, generation: 1, query, sessionId: HELD_SESSION, activityToolMode: 'preview' }
  }

  /** A journal whose last boot shut down with a provider child running in HELD_SESSION,
   *  so the next boot finds that session fenced until `fenceEndsAtMs`. */
  async function fencedRoot(fenceEndsAtMs: number): Promise<string> {
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-held-')))
    roots.push(root)
    const killedAt = new Date(fenceEndsAtMs - QUERY_JOB_ORPHAN_FENCE_MS)
    const priorBoot = new QueryJobStore({ root, bootId: randomUUID(), now: () => new Date(killedAt) })
    const owner = await priorBoot.admit(heldRequest(randomUUID(), 'the run the restart killed'))
    await priorBoot.markStarting(owner.job.jobId)
    await priorBoot.markRunning(owner.job.jobId, { provider: 'claude' })
    await priorBoot.updateLinkage(owner.job.jobId, { provider: 'claude', claudeRunId: 'orphan-child' })
    // The fence is stamped by whoever interrupts, at THEIR clock: interrupt here, as a
    // graceful shutdown does, so it ends at `fenceEndsAtMs` and not 21 minutes from now.
    await priorBoot.interrupt(owner.job.jobId, 'server_shutdown')
    return root
  }

  /** The store production builds: it re-queues never-started work for its coordinator. */
  function liveStore(root: string, storage?: QueryJobJournalStorage): QueryJobStore {
    return new QueryJobStore({ root, bootId: randomUUID(), requeueNeverStartedOnBoot: true, ...(storage ? { storage } : {}) })
  }

  function answeringRunner(calls: Array<{ query: string; atMs: number }>): QueryJobRunner {
    return async ctx => {
      calls.push({ query: ctx.request.query, atMs: Date.now() })
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      await ctx.callbacks.onDone({ text: `answer to ${ctx.request.query}` })
    }
  }

  const statuses = (job: { activity: Array<{ kind: string; text: string }> }) =>
    job.activity.filter(entry => entry.kind === 'status').map(entry => entry.text)

  it('words the hold for an 18-character lens header: the reason, then a clock time rounded UP', () => {
    const at = (h: number, m: number, sec: number, ms = 0) => new Date(2026, 9, 2, h, m, sec, ms).getTime()
    expect(orphanFenceHoldStatus(at(17, 52, 1))).toEqual(['An earlier run may still be running', 'Starts 5:53 PM'])
    expect(holdClock(at(17, 53, 0))).toBe('5:53 PM')
    expect(holdClock(at(17, 52, 59, 999))).toBe('5:53 PM')
    expect(holdClock(at(23, 59, 30))).toBe('12:00 AM')
    for (let hour = 0; hour < 24; hour++) {
      const [, line] = orphanFenceHoldStatus(at(hour, 58, 30))
      expect(line.length, line).toBeLessThanOrEqual(18)
      expect(line).toMatch(/^Starts \d{1,2}:\d{2} [AP]M$/)
    }
    expect(DRAIN_HOLD_STATUS.length).toBeLessThanOrEqual(18)
  })

  it('accepts a fenced prompt, says why it waits, and answers it once the fence clears', async () => {
    const fenceEndsAtMs = Date.now() + 400
    const root = await fencedRoot(fenceEndsAtMs)
    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root), answeringRunner(calls), { partialFlushMs: 0 })
    await value.init()

    const admitted = await value.submit(heldRequest())
    expect(admitted).toMatchObject({ created: true, job: { status: 'accepted', sessionId: HELD_SESSION } })
    const held = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => statuses(job).length >= 2,
    )
    expect(held.status).toBe('accepted')
    expect(statuses(held)[0]).toBe('An earlier run may still be running')
    expect(statuses(held)[1]).toMatch(/^Starts \d{1,2}:\d{2} [AP]M$/)
    expect(value.getHealth().heldRuns).toBe(1)
    expect(calls).toEqual([])

    const done = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(done.response).toBe('answer to held prompt')
    expect(statuses(done)).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0].atMs).toBeGreaterThanOrEqual(fenceEndsAtMs)
    expect(value.getHealth()).toMatchObject({ heldRuns: 0, activeRuns: 0 })
  })

  it('ends a hold on cancel, and the canceled prompt never reaches a provider after the fence clears', async () => {
    const fenceEndsAtMs = Date.now() + 400
    const root = await fencedRoot(fenceEndsAtMs)
    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root), answeringRunner(calls), { partialFlushMs: 0 })
    await value.init()

    const admitted = await value.submit(heldRequest())
    await waitFor(() => value.getSnapshot(admitted.job.jobId), job => statuses(job).length >= 2)
    const canceled = await value.cancel(admitted.job.jobId, 1)
    expect(canceled).toMatchObject({ applied: true, job: { status: 'canceled' } })
    await waitFor(() => value.getHealth(), health => health.heldRuns === 0, 1_000)
    // Past the fence: a hold that ignored the cancel would have started by now.
    await waitFor(() => Date.now(), now => now > fenceEndsAtMs + 500)
    expect(calls).toEqual([])
    expect((await value.getSnapshot(admitted.job.jobId)).status).toBe('canceled')
  })

  it('starts the held prompts of one session in admission order, through the real session lock', async () => {
    const fenceEndsAtMs = Date.now() + 400
    const root = await fencedRoot(fenceEndsAtMs)
    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root), answeringRunner(calls), {
      partialFlushMs: 0,
      acquireSessionLock: acquireModelSessionRunLock,
    })
    await value.init()
    const ids: string[] = []
    for (const query of ['P1', 'P2', 'P3', 'P4']) {
      ids.push((await value.submit(heldRequest(randomUUID(), query))).job.jobId)
    }
    await waitFor(() => value.getHealth(), health => health.heldRuns === 4)
    for (const jobId of ids) {
      await waitFor(() => value.getSnapshot(jobId), job => job.status === 'completed', 4_000)
    }
    expect(calls.map(call => call.query)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(calls[0].atMs).toBeGreaterThanOrEqual(fenceEndsAtMs)
  }, 8_000)

  it('keeps a prompt waiting on its session lock `accepted`, so a restart re-queues it', async () => {
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-held-')))
    roots.push(root)
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstCalls: string[] = []
    let leases = 0
    const first = new QueryJobCoordinator(liveStore(root), async ctx => {
      firstCalls.push(ctx.request.query)
      await ctx.callbacks.onStart({ sessionId: ctx.request.sessionId, provider: 'claude' })
      await firstBlocked
    }, {
      partialFlushMs: 0,
      acquireSessionLock: acquireModelSessionRunLock,
      acquireMaintenanceWork: () => {
        leases++
        let released = false
        return { id: randomUUID(), setPhase: () => {}, release: () => { if (!released) { released = true; leases-- } } }
      },
    })
    await first.init()
    const running = await first.submit({ ...heldRequest(randomUUID(), 'long run'), sessionId: 'session-lock-wait' })
    await waitFor(() => first.getSnapshot(running.job.jobId), job => job.status === 'running')
    const queued = await first.submit({ ...heldRequest(randomUUID(), 'queued behind it'), sessionId: 'session-lock-wait' })
    await waitFor(() => first.getHealth(), health => health.heldRuns === 1)
    expect((await first.getSnapshot(queued.job.jobId)).status).toBe('accepted')
    // Only the running job holds a lease: one queued behind it must not hold a drain open.
    expect(leases).toBe(1)

    await first.shutdown('server_shutdown')
    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(firstCalls).toEqual(['long run'])
    expect((await first.getSnapshot(queued.job.jobId)).status).toBe('accepted')

    const secondCalls: Array<{ query: string; atMs: number }> = []
    const second = new QueryJobCoordinator(liveStore(root), answeringRunner(secondCalls), {
      partialFlushMs: 0,
      acquireSessionLock: acquireModelSessionRunLock,
    })
    expect((await second.init()).store.requeuedOnBoot).toBe(1)
    const done = await waitFor(() => second.getSnapshot(queued.job.jobId), job => job.status === 'completed')
    expect(done.response).toBe('answer to queued behind it')
  })

  it('never spawns a provider for a start that lands after shutdown began', async () => {
    // The start write is slowed so shutdown begins inside it: markStarting applies, and
    // the coordinator must still not reach the runner (QA 2026-10-03, the Skeptic's probe).
    class SlowStartStorage extends NodeQueryJobJournalStorage {
      async append(root: string, partitionDay: string, line: string): Promise<void> {
        if ((JSON.parse(line) as { type?: string }).type === 'starting') {
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        return super.append(root, partitionDay, line)
      }
    }
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-held-')))
    roots.push(root)
    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root, new SlowStartStorage()), answeringRunner(calls), { partialFlushMs: 0 })
    await value.init()
    const admitted = await value.submit(heldRequest(randomUUID(), 'mid-shutdown'))
    await new Promise(resolve => setTimeout(resolve, 100))
    await value.shutdown('server_shutdown')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(calls).toEqual([])
    // Applied just before shutdown: `starting`, which the next boot interrupts (no fence).
    expect((await value.getSnapshot(admitted.job.jobId)).status).toBe('starting')
  })

  it('keeps a held prompt through a restart mid-hold and answers it on the next boot', async () => {
    const fenceEndsAtMs = Date.now() + 600
    const root = await fencedRoot(fenceEndsAtMs)
    const firstCalls: Array<{ query: string; atMs: number }> = []
    const first = new QueryJobCoordinator(liveStore(root), answeringRunner(firstCalls), { partialFlushMs: 0 })
    await first.init()
    const admitted = await first.submit(heldRequest(randomUUID(), 'asked before the update'))
    await waitFor(() => first.getSnapshot(admitted.job.jobId), job => statuses(job).length >= 2)
    await first.shutdown('server_shutdown')
    await waitFor(() => first.getHealth(), health => health.heldRuns === 0, 1_000)
    expect((await first.getSnapshot(admitted.job.jobId)).status).toBe('accepted')
    expect(firstCalls).toEqual([])

    const secondCalls: Array<{ query: string; atMs: number }> = []
    const second = new QueryJobCoordinator(liveStore(root), answeringRunner(secondCalls), { partialFlushMs: 0 })
    const health = await second.init()
    expect(health.store.requeuedOnBoot).toBe(1)
    const done = await waitFor(
      () => second.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(done.response).toBe('answer to asked before the update')
    // The restart re-announced nothing: the two hold lines are still the job's only ones.
    expect(statuses(done)).toHaveLength(2)
    expect(secondCalls).toHaveLength(1)
    expect(secondCalls[0].atMs).toBeGreaterThanOrEqual(fenceEndsAtMs)
    // The process that shut down must not ALSO start it once the fence clears.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(firstCalls).toEqual([])
  })

  it('ends a long hold at once on cancel, and on shutdown during a drain hold', async () => {
    // A 21-minute fence: nothing but the wake can end these holds inside the test.
    const root = await fencedRoot(Date.now() + QUERY_JOB_ORPHAN_FENCE_MS)
    const calls: Array<{ query: string; atMs: number }> = []
    let draining = false
    const value = new QueryJobCoordinator(liveStore(root), answeringRunner(calls), {
      partialFlushMs: 0,
      acquireMaintenanceWork: () => {
        if (draining) throw Object.assign(new Error('drain'), { code: 'maintenance_drain_active' })
        return { id: randomUUID(), setPhase: () => {}, release: () => {} }
      },
    })
    await value.init()
    const fenced = await value.submit(heldRequest())
    await waitFor(() => value.getSnapshot(fenced.job.jobId), job => statuses(job).length >= 2)
    await value.cancel(fenced.job.jobId, 1)
    await waitFor(() => value.getHealth(), health => health.heldRuns === 0, 300)

    expect(calls).toEqual([])

    // A drain refuses admission itself, so it must begin while a job is already held: a
    // short fence, then Update Server's drain outlasting it, then shutdown.
    const shortRoot = await fencedRoot(Date.now() + 200)
    const drainCalls: Array<{ query: string; atMs: number }> = []
    const drainingCoordinator = new QueryJobCoordinator(liveStore(shortRoot), answeringRunner(drainCalls), {
      partialFlushMs: 0,
      acquireMaintenanceWork: () => {
        if (draining) throw Object.assign(new Error('drain'), { code: 'maintenance_drain_active' })
        return { id: randomUUID(), setPhase: () => {}, release: () => {} }
      },
    })
    await drainingCoordinator.init()
    const drained = await drainingCoordinator.submit(heldRequest(randomUUID(), 'during update'))
    await waitFor(() => drainingCoordinator.getSnapshot(drained.job.jobId), job => statuses(job).length >= 2)
    draining = true
    await waitFor(() => drainingCoordinator.getSnapshot(drained.job.jobId), job => statuses(job).includes(DRAIN_HOLD_STATUS))
    await drainingCoordinator.shutdown('server_shutdown')
    await waitFor(() => drainingCoordinator.getHealth(), health => health.heldRuns === 0, 300)
    expect((await drainingCoordinator.getSnapshot(drained.job.jobId)).status).toBe('accepted')
    expect(drainCalls).toEqual([])
  })

  it('leaves a start that was still waiting its turn when shutdown began `accepted`, for the next boot', async () => {
    // Job A's start write is slowed, so job B's markStarting waits behind it in the store's
    // write queue while shutdown begins. B must be refused inside its own write (accepted,
    // re-queued at boot), not merely kept from spawning after it is `starting`.
    class SlowFirstStartStorage extends NodeQueryJobJournalStorage {
      private slowed = false
      async append(root: string, partitionDay: string, line: string): Promise<void> {
        if (!this.slowed && (JSON.parse(line) as { type?: string }).type === 'starting') {
          this.slowed = true
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        return super.append(root, partitionDay, line)
      }
    }
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-held-')))
    roots.push(root)
    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root, new SlowFirstStartStorage()), answeringRunner(calls), { partialFlushMs: 0 })
    await value.init()
    const a = await value.submit({ ...heldRequest(randomUUID(), 'A'), sessionId: 'session-a' })
    const b = await value.submit({ ...heldRequest(randomUUID(), 'B'), sessionId: 'session-b' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await value.shutdown('server_shutdown')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(calls).toEqual([])
    expect((await value.getSnapshot(a.job.jobId)).status).toBe('starting')
    expect((await value.getSnapshot(b.job.jobId)).status).toBe('accepted')
  })

  it('runs a never-started prompt from the last boot even with no fence at all', async () => {
    const root = trackedTemp(await mkdtemp(join(tmpdir(), 'cos-query-held-')))
    roots.push(root)
    const priorBoot = new QueryJobStore({ root, bootId: randomUUID() })
    const orphaned = await priorBoot.admit({ ...heldRequest(randomUUID(), 'admitted then crashed'), sessionId: 'session-clean' })

    const calls: Array<{ query: string; atMs: number }> = []
    const value = new QueryJobCoordinator(liveStore(root), answeringRunner(calls), { partialFlushMs: 0 })
    await value.init()
    const done = await waitFor(
      () => value.getSnapshot(orphaned.job.jobId),
      job => job.status === 'completed',
    )
    expect(done.response).toBe('answer to admitted then crashed')
    expect(calls).toHaveLength(1)
  })

  it('releases its lease for the hold and waits out a drain before taking a start lease', async () => {
    const fenceEndsAtMs = Date.now() + 300
    const root = await fencedRoot(fenceEndsAtMs)
    const calls: Array<{ query: string; atMs: number }> = []
    let draining = false
    let live = 0
    let refusals = 0
    const value = new QueryJobCoordinator(
      liveStore(root),
      answeringRunner(calls),
      {
        partialFlushMs: 0,
        holdRecheckMs: 40,
        acquireMaintenanceWork: () => {
          if (draining) {
            refusals++
            throw Object.assign(new Error('Server is closed for a committed maintenance operation.'), {
              code: 'maintenance_drain_active',
            })
          }
          live++
          let released = false
          return {
            id: randomUUID(),
            setPhase: () => {},
            release: () => { if (!released) { released = true; live-- } },
          }
        },
      },
    )
    await value.init()

    const admitted = await value.submit(heldRequest())
    // Held for the fence with NO lease: a fence must not hold Update Server's drain open.
    await waitFor(() => value.getSnapshot(admitted.job.jobId), job => statuses(job).length >= 2)
    await waitFor(() => live, count => count === 0)
    draining = true
    // The drain must OUTLAST the fence, or the fence alone would keep the job from
    // starting and a hold that ignored the drain would pass (the gate caught exactly that).
    await waitFor(() => Date.now(), now => now > fenceEndsAtMs + 300)
    expect(refusals).toBeGreaterThanOrEqual(2)
    expect(calls).toEqual([])
    const drained = await value.getSnapshot(admitted.job.jobId)
    expect(drained.status).toBe('accepted')
    expect(statuses(drained).at(-1)).toBe(DRAIN_HOLD_STATUS)

    draining = false
    const done = await waitFor(
      () => value.getSnapshot(admitted.job.jobId),
      job => job.status === 'completed',
    )
    expect(done.response).toBe('answer to held prompt')
    expect(calls).toHaveLength(1)
    await waitFor(() => live, count => count === 0)
  })
})
