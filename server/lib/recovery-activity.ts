import type { NextFunction, Request, Response } from 'express'

export interface RecoveryBusyDetail { kind: string; id: string; ageMs: number }

interface ActivityLease {
  kind: string
  startedAt: number
  expiresAt: number | null
  disconnectedAt?: number
}

const active = new Map<string, ActivityLease>()
let maintenance = false
let sequence = 0

const RECORDING_LEASE_MS = 20_000
const DISCONNECTED_REQUEST_GRACE_MS = 120_000

export type RecoveryRouteClass = 'exempt' | 'request' | 'operation'

const EXEMPT_EXACT = new Set([
  'GET /api/health',
  'GET /api/live',
  'GET /api/display-stream',
  'POST /api/diag/client',
  'GET /api/diag/health',
  'GET /api/recovery/status',
  'POST /api/recovery/whisper/restart',
  'POST /api/recovery/server/restart',
])

const OPERATION_GET_PREFIXES = [
  '/api/models',
  '/v1/models',
  '/api/tasks',
  '/api/people',
  '/api/memory',
  '/api/calendar',
  '/api/threads',
  '/api/badges',
  '/api/welcome-context',
  '/api/handoffs',
  '/api/media/',
  '/api/tts/play/',
]

/**
 * Recovery admission is intentionally fail-safe: every API mutation and every
 * read known to spawn a child, populate a cache, or lazily create media is an
 * operation. Only explicitly inert health/stream/diagnostic routes are exempt.
 */
export function classifyRecoveryRoute(method: string, path: string): RecoveryRouteClass {
  const verb = method.toUpperCase()
  const normalized = path.split('?')[0]
  if (EXEMPT_EXACT.has(`${verb} ${normalized}`)) return 'exempt'
  if (!normalized.startsWith('/api/') && !normalized.startsWith('/v1/')) return 'exempt'
  if (verb !== 'GET' && verb !== 'HEAD') return 'operation'
  if (OPERATION_GET_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(prefix))) {
    return 'operation'
  }
  return 'request'
}

function prune(now = Date.now()): void {
  for (const [id, lease] of active) {
    if (lease.expiresAt != null && lease.expiresAt <= now) active.delete(id)
  }
}

function createLease(kind: string, id: string, expiresAt: number | null = null): () => void {
  active.set(id, { kind, startedAt: Date.now(), expiresAt })
  let released = false
  return () => {
    if (released) return
    released = true
    active.delete(id)
  }
}

export function createRecordingLease(kind: string, id: string): void {
  const now = Date.now()
  active.set(`recording:${id}`, { kind, startedAt: now, expiresAt: now + RECORDING_LEASE_MS })
}

export function renewRecordingLease(kind: string, id: string): void {
  createRecordingLease(kind, id)
}

export function releaseRecordingLease(id: string): void {
  active.delete(`recording:${id}`)
}

/** Acquire before the first side-effecting await; the owner releases only after
 * its durable/cache/background work truly settles. */
export function tryAcquireOperationLease(kind: string, ownerId?: string):
  | { ok: true; id: string; release: () => void }
  | { ok: false; reason: 'maintenance' } {
  if (maintenance) return { ok: false, reason: 'maintenance' }
  const id = ownerId ? `operation:${ownerId}` : `operation:${++sequence}`
  return { ok: true, id, release: createLease(kind, id) }
}

export async function withOperationLease<T>(kind: string, work: () => Promise<T>, ownerId?: string): Promise<T> {
  const lease = tryAcquireOperationLease(kind, ownerId)
  if (!lease.ok) throw Object.assign(new Error('Server recovery in progress'), { code: 'SERVER_MAINTENANCE' })
  try { return await work() } finally { lease.release() }
}

export function recoveryBusyDetails(): RecoveryBusyDetail[] {
  const now = Date.now()
  prune(now)
  return [...active.entries()].map(([id, item]) => ({
    kind: item.kind,
    id: id.startsWith('recording:') ? id.slice('recording:'.length) : id,
    ageMs: now - item.startedAt,
  }))
}

export function acquireMaintenance():
  | { ok: true; release: () => void }
  | { ok: false; busy: RecoveryBusyDetail[]; release: () => void } {
  if (maintenance) {
    return { ok: false, busy: [{ kind: 'maintenance', id: 'active', ageMs: 0 }], release: () => {} }
  }
  // Atomic in Node's event loop: close admission before looking at activity.
  maintenance = true
  let released = false
  const release = () => {
    if (released) return
    released = true
    maintenance = false
  }
  const busy = recoveryBusyDetails()
  if (busy.length > 0) return { ok: false, busy, release }
  return { ok: true, release }
}

export function recoveryAdmissionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const routeClass = classifyRecoveryRoute(req.method, req.originalUrl || req.path)
  if (routeClass === 'exempt') return next()
  if (maintenance) {
    res.status(503).json({ error: 'Server recovery in progress', reason: 'server_maintenance', retryable: true })
    return
  }

  const id = `${routeClass}:${++sequence}`
  const release = createLease(`${req.method} ${(req.originalUrl || req.path).split('?')[0]}`, id)
  res.once('finish', release)
  res.once('close', () => {
    const lease = active.get(id)
    if (!lease) return
    // Socket close is not operation settlement. Keep a bounded grace lease so
    // a handler/background owner cannot be restarted out from underneath.
    lease.disconnectedAt = Date.now()
    lease.expiresAt = Date.now() + DISCONNECTED_REQUEST_GRACE_MS
  })
  next()
}

export function getRecoveryActivityStatus(): { maintenance: boolean; active: RecoveryBusyDetail[] } {
  return { maintenance, active: recoveryBusyDetails() }
}

export function __resetRecoveryActivityForTests(): void {
  active.clear()
  maintenance = false
  sequence = 0
}
