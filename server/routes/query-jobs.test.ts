import express from 'express'
import { get, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({
  getOrCreateSession: () => 'http-session',
}))

import { QueryJobCoordinator } from '../lib/query-job-coordinator.js'
import { QueryJobStore } from '../lib/query-job-store.js'
import { createQueryJobsRouter } from './query-jobs.js'

let root = ''
let server: Server
let disabledServer: Server
let base = ''
let disabledBase = ''
let coordinator: QueryJobCoordinator

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  return {
    server,
    base: typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '',
  }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function waitForTerminal(jobId: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/query-jobs/${jobId}?generation=1`)
    const body = await response.json() as { job?: { status?: string } }
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(body.job?.status ?? '')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('query job did not become terminal')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cos-query-job-routes-'))
  coordinator = new QueryJobCoordinator(
    new QueryJobStore({ root, bootId: randomUUID() }),
    async context => {
      await context.callbacks.onStart({
        provider: 'codex',
        resolvedModel: 'gpt-5',
        sessionId: context.request.sessionId,
      })
      context.callbacks.onToolStatus('Working in /Users/miles/private with Bearer supersecretcredential')
      context.callbacks.onChunk('http ')
      setTimeout(() => {
        void Promise.resolve(context.callbacks.onDone({ text: 'http durable answer', provider: 'codex' }))
      }, 30)
    },
    { resolveSessionId: () => 'http-session', partialFlushMs: 0 },
  )
  await coordinator.init()

  const app = express()
  app.use(express.json())
  app.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, heartbeatMs: 1_000 }))
  ;({ server, base } = await listen(app))

  const disabled = express()
  disabled.use(express.json())
  disabled.use('/api', createQueryJobsRouter(coordinator, { enabled: () => false }))
  ;({ server: disabledServer, base: disabledBase } = await listen(disabled))
})

afterAll(async () => {
  await Promise.all([close(server), close(disabledServer)])
  await rm(root, { recursive: true, force: true })
})

describe('durable query job HTTP contract', () => {
  it('admits with 202, recovers a lost response by client identity, and never reflects the prompt', async () => {
    const clientJobId = randomUUID()
    const secretPrompt = 'PRIVATE PROMPT THAT MUST NOT ENTER PUBLIC JOB STATE'
    const response = await fetch(`${base}/api/query-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientJobId,
        generation: 1,
        query: secretPrompt,
        reference: { query: 'private reference question', response: 'private reference answer' },
      }),
    })
    expect(response.status).toBe(202)
    const body = await response.json() as { job: Record<string, unknown> }
    expect(body.job).toMatchObject({ clientJobId, generation: 1, sessionId: 'http-session' })
    expect(JSON.stringify(body)).not.toContain(secretPrompt)
    expect(JSON.stringify(body)).not.toContain('private reference')

    const recovered = await fetch(`${base}/api/query-jobs/by-client/${clientJobId}?generation=1`)
    expect(recovered.status).toBe(200)
    const recoveredBody = await recovered.json() as { job: { jobId: string } }
    expect(recoveredBody.job.jobId).toBe(body.job.jobId)

    const missing = await fetch(`${base}/api/query-jobs/by-client/${randomUUID()}?generation=1`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'query_job_not_found' } })
  })

  it('returns the immutable duplicate and rejects a changed retry', async () => {
    const clientJobId = randomUUID()
    const payload = { clientJobId, generation: 1, query: 'same immutable payload' }
    const first = await fetch(`${base}/api/query-jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const firstBody = await first.json() as { job: { jobId: string } }

    const retry = await fetch(`${base}/api/query-jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    expect(retry.status).toBe(202)
    expect((await retry.json() as { job: { jobId: string } }).job.jobId).toBe(firstBody.job.jobId)

    const conflict = await fetch(`${base}/api/query-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, query: 'changed payload' }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'job_identity_conflict' } })
  })

  it('replays named SSE events, closes at terminal, and redacts activity details', async () => {
    const clientJobId = randomUUID()
    const admission = await fetch(`${base}/api/query-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientJobId, generation: 1, query: 'stream this' }),
    })
    const { job } = await admission.json() as { job: { jobId: string } }
    const streamResponse = await fetch(`${base}/api/query-jobs/${job.jobId}/events?generation=1&after=0`)
    expect(streamResponse.status).toBe(200)
    const stream = await streamResponse.text()
    expect(stream).toContain('event: accepted')
    expect(stream).toContain('event: completed')
    expect(stream).toContain('"clientJobId"')
    expect(stream).not.toContain('supersecretcredential')
    expect(stream).not.toContain('/Users/miles/private')
  }, 5_000)

  it('buffers a live terminal that arrives before SSE headers are installed', async () => {
    const jobId = randomUUID()
    const clientJobId = randomUUID()
    const snapshot = {
      jobId,
      clientJobId,
      generation: 1,
      status: 'running',
      eventSeq: 1,
      updatedAt: new Date().toISOString(),
    }
    const raceCoordinator = {
      subscribe: async (
        _jobId: string,
        _generation: number,
        _after: number,
        listener: (event: Record<string, unknown>) => void,
      ) => {
        listener({
          type: 'completed',
          eventSeq: 2,
          jobId,
          clientJobId,
          generation: 1,
          status: 'completed',
          at: new Date().toISOString(),
          data: { response: 'fast answer' },
        })
        return {
          replay: {
            events: [{
              type: 'running',
              eventSeq: 1,
              jobId,
              clientJobId,
              generation: 1,
              status: 'running',
              at: new Date().toISOString(),
              data: {},
            }],
            gap: false,
            oldestEventSeq: 1,
            latestEventSeq: 1,
            snapshot,
          },
          unsubscribe: () => {},
        }
      },
    } as unknown as QueryJobCoordinator
    const app = express()
    app.use('/api', createQueryJobsRouter(raceCoordinator, { enabled: () => true }))
    const race = await listen(app)
    try {
      const response = await fetch(`${race.base}/api/query-jobs/${jobId}/events?generation=1&after=0`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const stream = await response.text()
      expect(stream).toContain('event: running')
      expect(stream).toContain('event: completed')
      expect(stream).toContain('fast answer')
    } finally {
      await close(race.server)
    }
  })

  it('unsubscribes a delayed SSE subscription when the client closes before replay arrives', async () => {
    const jobId = randomUUID()
    const clientJobId = randomUUID()
    const unsubscribe = vi.fn()
    let releaseSubscription!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const delayed = new Promise<void>(resolve => { releaseSubscription = resolve })
    const delayedCoordinator = {
      subscribe: async () => {
        markStarted()
        await delayed
        return {
          replay: {
            events: [],
            gap: false,
            oldestEventSeq: 1,
            latestEventSeq: 1,
            snapshot: {
              jobId, clientJobId, generation: 1, status: 'running', eventSeq: 1,
              updatedAt: new Date().toISOString(),
            },
          },
          unsubscribe,
        }
      },
    } as unknown as QueryJobCoordinator
    const app = express()
    app.use('/api', createQueryJobsRouter(delayedCoordinator, { enabled: () => true }))
    const delayedServer = await listen(app)
    try {
      const request = get(`${delayedServer.base}/api/query-jobs/${jobId}/events?generation=1&after=0`)
      request.on('error', () => {})
      await started
      request.destroy()
      await new Promise(resolve => setTimeout(resolve, 20))
      releaseSubscription()
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    } finally {
      releaseSubscription()
      await close(delayedServer.server)
    }
  })

  it('generation-fences cancellation and persists an idempotent terminal ACK', async () => {
    const clientJobId = randomUUID()
    const admission = await fetch(`${base}/api/query-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientJobId, generation: 1, query: 'ack this' }),
    })
    const { job } = await admission.json() as { job: { jobId: string } }

    const wrongGeneration = await fetch(`${base}/api/query-jobs/${job.jobId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: 2 }),
    })
    expect(wrongGeneration.status).toBe(409)
    expect(await wrongGeneration.json()).toMatchObject({ error: { code: 'query_job_generation_mismatch' } })

    // Wait on authoritative state rather than a wall-clock guess; the full
    // suite intentionally stresses the event loop and can delay a 30ms child.
    await waitForTerminal(job.jobId)
    const ack = await fetch(`${base}/api/query-jobs/${job.jobId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    })
    expect(ack.status).toBe(200)
    const acked = await ack.json() as { job: { acknowledgedAt?: string; eventSeq: number } }
    expect(acked.job.acknowledgedAt).toBeTruthy()

    const retry = await fetch(`${base}/api/query-jobs/${job.jobId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    })
    const retryBody = await retry.json() as { job: { acknowledgedAt?: string; eventSeq: number } }
    expect(retry.status).toBe(200)
    expect(retryBody.job).toMatchObject(acked.job)
  })

  it('blocks new admission but drains existing durable jobs when the feature flag is off', async () => {
    const drainRoot = join(root, `drain-${randomUUID()}`)
    const drainCoordinator = new QueryJobCoordinator(
      new QueryJobStore({ root: drainRoot, bootId: randomUUID() }),
      async context => {
        await context.callbacks.onStart({ sessionId: context.request.sessionId, provider: 'codex' })
        return new Promise<void>(() => {})
      },
      { resolveSessionId: () => 'drain-session' },
    )
    await drainCoordinator.init()
    const clientJobId = randomUUID()
    const admitted = await drainCoordinator.submit({ clientJobId, generation: 1, query: 'existing job' })
    const app = express()
    app.use(express.json())
    app.use('/api', createQueryJobsRouter(drainCoordinator, { enabled: () => false }))
    const drain = await listen(app)
    try {
      const rejected = await fetch(`${drain.base}/api/query-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientJobId: randomUUID(), generation: 1, query: 'new disabled job' }),
      })
      expect(rejected.status).toBe(404)
      expect(await rejected.json()).toMatchObject({ error: { code: 'durable_query_jobs_disabled' } })

      expect((await fetch(`${drain.base}/api/query-jobs/${admitted.job.jobId}?generation=1`)).status).toBe(200)
      expect((await fetch(`${drain.base}/api/query-jobs/by-client/${clientJobId}?generation=1`)).status).toBe(200)
      const events = await fetch(`${drain.base}/api/query-jobs/${admitted.job.jobId}/events?generation=1&after=0`)
      expect(events.status).toBe(200)

      const canceled = await fetch(`${drain.base}/api/query-jobs/${admitted.job.jobId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 1 }),
      })
      expect(canceled.status).toBe(200)
      expect(await canceled.json()).toMatchObject({ job: { status: 'canceled' } })
      expect(await events.text()).toContain('event: canceled')

      const ack = await fetch(`${drain.base}/api/query-jobs/${admitted.job.jobId}/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 1 }),
      })
      expect(ack.status).toBe(200)
      expect(await ack.json()).toMatchObject({ job: { status: 'canceled' } })
    } finally {
      await drainCoordinator.shutdown('test_shutdown')
      await close(drain.server)
    }
  })
})
