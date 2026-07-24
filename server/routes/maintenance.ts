import { Router, type Request, type Response } from 'express'
import {
  MaintenanceLifecycleError,
  maintenanceErrorPayload,
  maintenanceLifecycle,
  type MaintenanceDrainRequest,
  type MaintenanceOperationCredentials,
  type MaintenanceOperationIdentity,
  type MaintenanceOperationKind,
  type MaintenanceOperationScope,
  type MaintenancePostcondition,
} from '../lib/maintenance-lifecycle.js'
import { managedRuntimeCapability, managedServerVersion, getServerGenerationId } from '../lib/managed-runtime.js'
import { getQueryJobRuntimeHealth } from '../lib/query-job-runtime.js'
import { serverMetrics } from '../lib/server-metrics.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { getWhisperHealth } from '../lib/whisper-local.js'
import { getActiveTranscriptionSessionCount } from './transcribe-stream.js'

export const maintenanceRouter = Router()

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

function operationIdentity(body: unknown): MaintenanceOperationIdentity {
  const value = bodyRecord(body)
  return {
    serverInstanceId: typeof value.serverInstanceId === 'string' ? value.serverInstanceId : '',
    bootId: typeof value.bootId === 'string' ? value.bootId : '',
    generationId: typeof value.generationId === 'string' ? value.generationId : '',
    operationId: typeof value.operationId === 'string' ? value.operationId : '',
  }
}

function drainRequest(body: unknown): MaintenanceDrainRequest {
  const value = bodyRecord(body)
  return {
    ...operationIdentity(value),
    operationKind: value.operationKind as MaintenanceOperationKind,
    scope: value.scope as MaintenanceOperationScope,
    postcondition: value.postcondition as MaintenancePostcondition,
    nonceSha256: typeof value.nonceSha256 === 'string' ? value.nonceSha256 : '',
    authorizedSuccessorGenerations: Array.isArray(value.authorizedSuccessorGenerations)
      ? value.authorizedSuccessorGenerations.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof value.ttlMs === 'number' ? { ttlMs: value.ttlMs } : {}),
  }
}

function operationCredentials(req: Request): MaintenanceOperationCredentials {
  return {
    leaseId: typeof req.headers['x-cos-maintenance-lease'] === 'string'
      ? req.headers['x-cos-maintenance-lease']
      : undefined,
    operationId: typeof req.headers['x-cos-maintenance-operation'] === 'string'
      ? req.headers['x-cos-maintenance-operation']
      : undefined,
    nonce: typeof req.headers['x-cos-maintenance-nonce'] === 'string'
      ? req.headers['x-cos-maintenance-nonce']
      : undefined,
  }
}

function statusSnapshot(credentials: MaintenanceOperationCredentials = {}) {
  const jobs = getQueryJobRuntimeHealth()
  const activeTranscriptionSessions = getActiveTranscriptionSessionCount()
  const managed = managedRuntimeCapability()
  const tracked = maintenanceLifecycle.snapshot(credentials, {
    recording_session: activeTranscriptionSessions,
  })
  const untrackedDurableRuns = Math.max(0, jobs.activeRuns - (tracked.activeByKind.durable_query ?? 0))
  const lifecycle = untrackedDurableRuns > 0
    ? maintenanceLifecycle.snapshot(credentials, {
      durable_query_runtime: untrackedDurableRuns,
      recording_session: activeTranscriptionSessions,
    })
    : tracked
  return {
    contractVersion: managed.contractVersion,
    managed: managed.managed,
    serverVersion: managedServerVersion(),
    generationId: getServerGenerationId(),
    serverInstanceId: getServerInstanceId(),
    bootId: serverMetrics.bootId,
    activeJobs: jobs.activeRuns,
    activeTranscriptionSessions,
    shuttingDown: jobs.shuttingDown,
    durableStoreState: jobs.store.state,
    lifecycle,
    safeToRestart: lifecycle.safeToRestart && !jobs.shuttingDown,
    whisper: getWhisperHealth(),
  }
}

function sendLifecycleError(res: Response, error: unknown) {
  if (error instanceof MaintenanceLifecycleError) {
    if (error.retryAfterSeconds != null) res.setHeader('Retry-After', String(error.retryAfterSeconds))
    res.status(error.status).json(maintenanceErrorPayload(error))
    return
  }
  res.status(500).json({ error: 'maintenance_internal_error', retryable: false })
}

function requireLoopback(req: Request, res: Response): boolean {
  if (isLoopback(req)) return true
  res.status(403).json({ error: 'loopback_required', retryable: false })
  return false
}

maintenanceRouter.get('/maintenance/status', (req, res) => {
  res.json(statusSnapshot(operationCredentials(req)))
})

maintenanceRouter.post('/maintenance/drain', (req, res) => {
  if (!requireLoopback(req, res)) return
  try {
    const leaseId = maintenanceLifecycle.beginDrain(drainRequest(req.body))
    res.json({ leaseId, ...statusSnapshot() })
  } catch (error) {
    sendLifecycleError(res, error)
  }
})

maintenanceRouter.post('/maintenance/drain/adopt', (req, res) => {
  if (!requireLoopback(req, res)) return
  const credentials = operationCredentials(req)
  try {
    maintenanceLifecycle.adoptDrain(operationIdentity(req.body), credentials)
    res.json({ adopted: true, ...statusSnapshot(credentials) })
  } catch (error) {
    sendLifecycleError(res, error)
  }
})

maintenanceRouter.post('/maintenance/drain/release', (req, res) => {
  if (!requireLoopback(req, res)) return
  try {
    maintenanceLifecycle.releaseDrain(operationIdentity(req.body), operationCredentials(req))
    res.json({ released: true, ...statusSnapshot() })
  } catch (error) {
    sendLifecycleError(res, error)
  }
})

maintenanceRouter.post('/maintenance/drain/cancel', (req, res) => {
  if (!requireLoopback(req, res)) return
  try {
    maintenanceLifecycle.cancelDrain(operationIdentity(req.body), operationCredentials(req))
    res.json({ canceled: true, ...statusSnapshot() })
  } catch (error) {
    sendLifecycleError(res, error)
  }
})
