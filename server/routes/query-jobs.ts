import { Router, type Response } from 'express'
import { durableQueryJobsEnabled } from '../lib/query-job-feature.js'
import {
  QueryJobCoordinator,
  QueryJobCoordinatorError,
  queryJobErrorCode,
} from '../lib/query-job-coordinator.js'
import {
  QueryJobAnswerCommittingError,
  QueryJobActiveGenerationError,
  QueryJobGenerationMismatchError,
  QueryJobGenerationOrderError,
  QueryJobIdentityConflictError,
  QueryJobNotFoundError,
  QueryJobNotTerminalError,
  QueryJobPersistenceError,
  QueryJobProviderOrphanFenceError,
  QueryJobStoreError,
} from '../lib/query-job-store.js'
import {
  isTerminalQueryJobStatus,
  normalizeQueryJobError,
  parsePositiveInteger,
  QueryJobValidationError,
  type QueryJobEvent,
  type QueryJobSnapshot,
} from '../lib/query-job-types.js'

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface QueryJobsRouterOptions {
  enabled?: () => boolean
  heartbeatMs?: number
  prepareAdmission?: (raw: unknown) => unknown | Promise<unknown>
}

interface WireError {
  error: { code: string; message: string; retryable?: boolean; retryAfterMs?: number }
}

function wireError(error: unknown): { status: number; body: WireError } {
  let status = 500
  const explicitStatus = Number((error as { status?: unknown })?.status)
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) status = explicitStatus
  else if (error instanceof QueryJobValidationError) status = 400
  else if (error instanceof QueryJobNotFoundError) status = 404
  else if (error instanceof QueryJobGenerationMismatchError
    || error instanceof QueryJobIdentityConflictError
    || error instanceof QueryJobActiveGenerationError
    || error instanceof QueryJobGenerationOrderError
    || error instanceof QueryJobProviderOrphanFenceError
    || error instanceof QueryJobAnswerCommittingError
    || error instanceof QueryJobNotTerminalError) status = 409
  else if (error instanceof QueryJobPersistenceError
    || error instanceof QueryJobCoordinatorError) status = 503
  else if (error instanceof QueryJobStoreError) status = 409
  const normalized = normalizeQueryJobError(error, queryJobErrorCode(error))
  return { status, body: { error: normalized } }
}

function validJobId(raw: unknown): string {
  if (typeof raw !== 'string' || !JOB_ID_RE.test(raw)) throw new QueryJobValidationError('invalid_job_id')
  return raw.toLowerCase()
}

function validClientJobId(raw: unknown): string {
  if (typeof raw !== 'string' || !JOB_ID_RE.test(raw)) {
    throw new QueryJobValidationError('invalid_client_job_id')
  }
  return raw.toLowerCase()
}

function requiredGeneration(raw: unknown): number {
  const value = parsePositiveInteger(raw)
  if (value == null || value < 1) throw new QueryJobValidationError('invalid_generation')
  return value
}

function cursor(raw: unknown): number {
  if (raw == null || raw === '') return 0
  const value = parsePositiveInteger(raw)
  if (value == null) throw new QueryJobValidationError('invalid_event_cursor')
  return value
}

function writeSse(res: Response, type: string, event: Record<string, unknown>): void {
  const sequence = typeof event.eventSeq === 'number' ? event.eventSeq : undefined
  if (sequence != null) res.write(`id: ${sequence}\n`)
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function snapshotEvent(job: QueryJobSnapshot, reason: string): Record<string, unknown> {
  return {
    type: 'snapshot',
    eventSeq: job.eventSeq,
    jobId: job.jobId,
    clientJobId: job.clientJobId,
    generation: job.generation,
    status: job.status,
    at: job.updatedAt,
    data: { reason, job },
  }
}

export function createQueryJobsRouter(
  coordinator: QueryJobCoordinator,
  options: QueryJobsRouterOptions = {},
): Router {
  const router = Router()
  const enabled = options.enabled ?? durableQueryJobsEnabled
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 15_000)

  router.post('/query-jobs', async (req, res) => {
    if (!enabled()) {
      return res.status(404).json({
        error: {
          code: 'durable_query_jobs_disabled',
          message: 'Durable query jobs are not enabled on this server.',
        },
      } satisfies WireError)
    }
    try {
      const prepared = options.prepareAdmission ? await options.prepareAdmission(req.body) : req.body
      const admission = await coordinator.submit(prepared)
      return res.status(202).json({ job: admission.job })
    } catch (error) {
      const wire = wireError(error)
      return res.status(wire.status).json(wire.body)
    }
  })

  // Lost-202 recovery is keyed by the immutable client identity. Keep this
  // route explicit and ahead of the dynamic job lookup for future router
  // changes that may broaden the latter's matcher.
  router.get('/query-jobs/by-client/:clientJobId', async (req, res) => {
    try {
      const clientJobId = validClientJobId(req.params.clientJobId)
      const generation = requiredGeneration(req.query.generation)
      const job = await coordinator.getByClientGeneration(clientJobId, generation)
      if (!job) throw new QueryJobNotFoundError(`${clientJobId}:${generation}`)
      return res.json({ job })
    } catch (error) {
      const wire = wireError(error)
      return res.status(wire.status).json(wire.body)
    }
  })

  router.get('/query-jobs/:jobId', async (req, res) => {
    try {
      const jobId = validJobId(req.params.jobId)
      const generation = requiredGeneration(req.query.generation)
      const job = await coordinator.getSnapshot(jobId, generation)
      return res.json({ job })
    } catch (error) {
      const wire = wireError(error)
      return res.status(wire.status).json(wire.body)
    }
  })

  router.get('/query-jobs/:jobId/events', async (req, res) => {
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let closed = false
    let streamReady = false
    let sentSeq = -1
    const pendingLive: QueryJobEvent[] = []
    const cleanup = () => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    }
    const finish = () => {
      cleanup()
      if (!res.writableEnded) res.end()
    }
    // Register before subscribe(): a client can background/close while the
    // store is still preparing replay. The returned live listener must then
    // be released as soon as its delayed subscription arrives.
    res.on('close', cleanup)

    try {
      const jobId = validJobId(req.params.jobId)
      const generation = requiredGeneration(req.query.generation)
      const after = cursor(req.query.after)
      sentSeq = after

      const subscription = await coordinator.subscribe(jobId, generation, after, (event: QueryJobEvent) => {
        // subscribe() registers its live listener before returning the replay
        // snapshot so no append can fall into a gap. A very fast provider may
        // therefore publish while this route is still installing SSE headers.
        // Buffer that narrow window instead of allowing res.write() to commit
        // implicit non-SSE headers before writeHead() below.
        if (!streamReady) {
          pendingLive.push(event)
          return
        }
        if (closed || event.eventSeq <= sentSeq) return
        sentSeq = event.eventSeq
        writeSse(res, event.type, event as unknown as Record<string, unknown>)
        if (isTerminalQueryJobStatus(event.status)) finish()
      })
      unsubscribe = subscription.unsubscribe
      if (closed) {
        unsubscribe()
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      })
      res.flushHeaders()
      res.write(': keepalive\n\n')

      const { replay } = subscription
      if (replay.gap) {
        writeSse(res, 'snapshot', snapshotEvent(replay.snapshot, replay.reason ?? 'replay_gap'))
        sentSeq = replay.snapshot.eventSeq
      } else {
        for (const event of replay.events) {
          if (event.eventSeq <= sentSeq) continue
          sentSeq = event.eventSeq
          writeSse(res, event.type, event as unknown as Record<string, unknown>)
        }
      }

      const replayTerminal = replay.events.some(event => isTerminalQueryJobStatus(event.status))
      if (isTerminalQueryJobStatus(replay.snapshot.status) && !replayTerminal && !replay.gap) {
        writeSse(res, 'snapshot', snapshotEvent(replay.snapshot, 'terminal_snapshot'))
        sentSeq = replay.snapshot.eventSeq
      }
      if (isTerminalQueryJobStatus(replay.snapshot.status)) {
        finish()
        return
      }

      streamReady = true
      for (const event of pendingLive) {
        if (closed || event.eventSeq <= sentSeq) continue
        sentSeq = event.eventSeq
        writeSse(res, event.type, event as unknown as Record<string, unknown>)
        if (isTerminalQueryJobStatus(event.status)) {
          finish()
          break
        }
      }
      pendingLive.length = 0
      if (closed) return

      heartbeat = setInterval(() => {
        if (!closed && !res.writableEnded) res.write(': keepalive\n\n')
      }, heartbeatMs)
      heartbeat.unref?.()
    } catch (error) {
      cleanup()
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      const wire = wireError(error)
      res.status(wire.status).json(wire.body)
    }
  })

  router.post('/query-jobs/:jobId/cancel', async (req, res) => {
    try {
      const jobId = validJobId(req.params.jobId)
      const generation = requiredGeneration(req.body?.generation)
      const job = await coordinator.cancel(jobId, generation)
      return res.json({ job })
    } catch (error) {
      const wire = wireError(error)
      return res.status(wire.status).json(wire.body)
    }
  })

  router.post('/query-jobs/:jobId/ack', async (req, res) => {
    try {
      const jobId = validJobId(req.params.jobId)
      const generation = requiredGeneration(req.body?.generation)
      const job = await coordinator.acknowledge(jobId, generation)
      return res.json({ job })
    } catch (error) {
      const wire = wireError(error)
      return res.status(wire.status).json(wire.body)
    }
  })

  return router
}
