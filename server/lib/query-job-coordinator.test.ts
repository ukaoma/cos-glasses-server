import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./conversation.js', () => ({
  getOrCreateSession: () => 'test-conversation',
}))

import {
  QueryJobCoordinator,
  type QueryJobRunner,
  type QueryJobRunnerContext,
} from './query-job-coordinator.js'
import {
  NodeQueryJobJournalStorage,
  QueryJobAnswerCommittingError,
  QueryJobGenerationMismatchError,
  QueryJobIdentityConflictError,
  QueryJobStore,
  type QueryJobJournalStorage,
} from './query-job-store.js'

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
  const root = await mkdtemp(join(tmpdir(), 'cos-query-coordinator-'))
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
    expect(canceled.status).toBe('canceled')
    expect(contexts.get(first.job.jobId)!.signal.aborted).toBe(true)
    const canceledAgain = await value.cancel(first.job.jobId, 1)
    expect(canceledAgain.eventSeq).toBe(canceled.eventSeq)

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
    expect(canceled.status).toBe('canceled')

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
    const root = await mkdtemp(join(tmpdir(), 'cos-query-coordinator-failure-'))
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
      const root = await mkdtemp(join(tmpdir(), `cos-query-${terminalType}-failure-`))
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
