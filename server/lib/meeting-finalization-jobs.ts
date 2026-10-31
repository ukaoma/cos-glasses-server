import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

const JOB_NAME = /^[A-Za-z0-9:_-]{3,96}\.json$/

/**
 * 6.97.0: this job has stopped trying, durably, so it is no longer work in progress. Nothing is
 * running and no retry is pending, so it must not hold Restart or Update: those are the only way a
 * fix can reach it. Its audio and its job file stay.
 *   retries_exhausted  its attempts in one process all failed
 *   crash_parked       the boot gate parked it for crash-looping the server
 * Written only when a job stops; any later save drops it, because every save is a job moving again.
 */
export interface MeetingFinalizationStop {
  at: string
  reason: 'retries_exhausted' | 'crash_parked'
  /** The server version that gave up. A different one may have the fix. */
  version: string | null
}

/** A stopped job is tried again at a start this long after it stopped, or sooner on another version. */
export const FINALIZATION_STOPPED_RETRY_MS = 6 * 60 * 60 * 1000

export interface MeetingFinalizationJob {
  schemaVersion: 1
  sessionId: string
  meetingPath: string
  sidecarPath: string
  audioDir: string | null
  streamingWordCount: number
  phase: 'capture_pending' | 'batch_pending' | 'ops_pending'
  claimPending: boolean
  createdAt: string
  updatedAt: string
  lastError?: string
  stopped?: MeetingFinalizationStop
}

/** The job's stop, or null. A marker this build cannot read does not unlock anything. */
export function finalizationStop(job: Pick<MeetingFinalizationJob, 'stopped'>): MeetingFinalizationStop | null {
  const stop = job.stopped
  if (!stop || typeof stop !== 'object') return null
  if (stop.reason !== 'retries_exhausted' && stop.reason !== 'crash_parked') return null
  if (typeof stop.at !== 'string' || !Number.isFinite(Date.parse(stop.at))) return null
  return stop
}

/** Should this start try a job that gave up? Parked jobs are the boot gate's call, not this one's. */
export function stoppedFinalizationRetryDue(stop: MeetingFinalizationStop, now: number, version: string | null): boolean {
  if (stop.reason !== 'retries_exhausted') return true
  return stop.version !== version || now - Date.parse(stop.at) >= FINALIZATION_STOPPED_RETRY_MS
}

/** The fields `save` takes, from a stored job, without its stop. */
function savedFields(job: MeetingFinalizationJob): Omit<MeetingFinalizationJob, 'schemaVersion' | 'createdAt' | 'updatedAt'> {
  return {
    sessionId: job.sessionId,
    meetingPath: job.meetingPath,
    sidecarPath: job.sidecarPath,
    audioDir: job.audioDir,
    streamingWordCount: job.streamingWordCount,
    phase: job.phase,
    claimPending: job.claimPending,
    ...(job.lastError ? { lastError: job.lastError } : {}),
  }
}

function contained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

function validJob(raw: unknown): raw is MeetingFinalizationJob {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const job = raw as Partial<MeetingFinalizationJob>
  return job.schemaVersion === 1
    && typeof job.sessionId === 'string'
    && /^[A-Za-z0-9:_-]{3,96}$/.test(job.sessionId)
    && typeof job.meetingPath === 'string'
    && typeof job.sidecarPath === 'string'
    && (job.audioDir === null || typeof job.audioDir === 'string')
    && typeof job.streamingWordCount === 'number'
    && Number.isFinite(job.streamingWordCount)
    && (job.phase === 'capture_pending' || job.phase === 'batch_pending' || job.phase === 'ops_pending')
    && (job.claimPending === undefined || typeof job.claimPending === 'boolean')
    && typeof job.createdAt === 'string'
    && typeof job.updatedAt === 'string'
}

/** Durable replay ledger for the post-response HQ + operations handoff.
 * The meeting and sidecar remain the canonical data; this store contains only
 * bounded pointers and phase state so a server restart can resume safely. */
export class MeetingFinalizationJobStore {
  readonly root: string

  constructor(root = dataPath('meeting-finalization-jobs')) {
    this.root = resolve(root)
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) throw new Error('Invalid finalization sessionId')
    const path = resolve(this.root, `${sessionId}.json`)
    if (!contained(this.root, path)) throw new Error('Unsafe finalization job path')
    return path
  }

  private assertSafePointers(input: Pick<MeetingFinalizationJob, 'meetingPath' | 'sidecarPath' | 'audioDir'>): void {
    const dataRoot = dirname(this.root)
    const recordingsRoot = resolve(dataRoot, 'recordings')
    const pendingRoot = resolve(dataRoot, 'pending-batch')
    if (!contained(recordingsRoot, resolve(input.meetingPath))) throw new Error('Unsafe finalization meeting path')
    if (!contained(recordingsRoot, resolve(input.sidecarPath))) throw new Error('Unsafe finalization sidecar path')
    if (input.audioDir && !contained(pendingRoot, resolve(input.audioDir))) {
      throw new Error('Unsafe finalization audio path')
    }
  }

  save(input: Omit<MeetingFinalizationJob, 'schemaVersion' | 'createdAt' | 'updatedAt'>): MeetingFinalizationJob {
    this.assertSafePointers(input)
    this.ensureRoot()
    const prior = this.get(input.sessionId)
    const now = new Date().toISOString()
    const job: MeetingFinalizationJob = {
      schemaVersion: 1,
      ...input,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    }
    durableAtomicWriteFileSync(this.pathFor(input.sessionId), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
    return job
  }

  /** 6.97.0: nothing is trying this job any more. Keeps the job and its pointers; deletes nothing. */
  markStopped(job: MeetingFinalizationJob, reason: MeetingFinalizationStop['reason'], version: string | null, now = new Date()): MeetingFinalizationJob {
    return this.save({ ...savedFields(job), stopped: { at: now.toISOString(), reason, version } })
  }

  /** 6.97.0: an attempt is starting, so this is work in progress again and blocks like any other. */
  clearStopped(sessionId: string): void {
    const job = this.get(sessionId)
    if (job?.stopped !== undefined) this.save(savedFields(job))
  }

  get(sessionId: string): MeetingFinalizationJob | null {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!validJob(parsed)) return null
      const normalized = { ...parsed, claimPending: parsed.claimPending === true }
      this.assertSafePointers(normalized)
      return normalized
    } catch {
      return null
    }
  }

  list(): MeetingFinalizationJob[] {
    if (!existsSync(this.root)) return []
    let names: string[] = []
    try { names = readdirSync(this.root).filter(name => JOB_NAME.test(name)) } catch { return [] }
    return names.flatMap(name => {
      const sessionId = basename(name, '.json')
      const job = this.get(sessionId)
      return job ? [job] : []
    })
  }

  malformedCount(): number {
    if (!existsSync(this.root)) return 0
    try {
      return readdirSync(this.root)
        .filter(name => JOB_NAME.test(name))
        .filter(name => this.get(basename(name, '.json')) === null)
        .length
    } catch {
      return 0
    }
  }

  remove(sessionId: string): void {
    try { unlinkSync(this.pathFor(sessionId)) } catch { /* already absent */ }
  }

  /** Find a previously moved audio directory without trusting a stored path. */
  findPendingAudioDir(sessionId: string): string | null {
    const pendingRoot = resolve(dirname(this.root), 'pending-batch')
    if (!existsSync(pendingRoot)) return null
    try {
      const candidates = readdirSync(pendingRoot)
        .filter(name => name === sessionId || name.startsWith(`${sessionId}_`))
        .map(name => resolve(pendingRoot, name))
        .filter(path => contained(pendingRoot, path) && statSync(path).isDirectory())
        .sort()
      return candidates[0] ?? null
    } catch {
      return null
    }
  }

  /** Rebuild missing replay jobs from the canonical sidecar intent marker. */
  reconcileCanonicalSidecars(): MeetingFinalizationJob[] {
    const recordingsRoot = resolve(dirname(this.root), 'recordings')
    if (!existsSync(recordingsRoot)) return []
    const rebuilt: MeetingFinalizationJob[] = []
    let months: string[] = []
    try { months = readdirSync(recordingsRoot).filter(name => /^\d{4}-\d{2}$/.test(name)) } catch { return [] }
    for (const month of months) {
      const monthDir = resolve(recordingsRoot, month)
      let names: string[] = []
      try { names = readdirSync(monthDir).filter(name => name.endsWith('.g2-chunks.json')) } catch { continue }
      for (const name of names) {
        const sidecarPath = resolve(monthDir, name)
        try {
          const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>
          const sessionId = typeof sidecar.sessionId === 'string' ? sidecar.sessionId : ''
          if (sidecar.finalizationState === 'complete' || !sidecar.finalizationState || this.get(sessionId)) continue
          const meetingPath = sidecarPath.replace(/\.g2-chunks\.json$/, '.md')
          if (!existsSync(meetingPath)) continue
          const audioDir = this.findPendingAudioDir(sessionId)
          rebuilt.push(this.save({
            sessionId,
            meetingPath,
            sidecarPath,
            audioDir,
            streamingWordCount: Number(sidecar.streamingWordCount ?? 0),
            phase: audioDir ? 'batch_pending' : 'capture_pending',
            claimPending: sidecar.claimPending === true,
          }))
        } catch { /* malformed canonical sidecars are not executable */ }
      }
    }
    return rebuilt
  }
}

export function readFinalizationChunkEntries(job: MeetingFinalizationJob): unknown[] | null {
  if (!existsSync(job.meetingPath) || !existsSync(job.sidecarPath)) return null
  try {
    const sidecar = JSON.parse(readFileSync(job.sidecarPath, 'utf8')) as Record<string, unknown>
    if (sidecar.sessionId !== job.sessionId || !Array.isArray(sidecar.chunkEntries)) return null
    return sidecar.chunkEntries
  } catch {
    return null
  }
}

export function canonicalFinalizationIsComplete(job: MeetingFinalizationJob): boolean {
  try {
    const sidecar = JSON.parse(readFileSync(job.sidecarPath, 'utf8')) as Record<string, unknown>
    return sidecar.sessionId === job.sessionId && sidecar.finalizationState === 'complete'
  } catch {
    return false
  }
}

export function markCanonicalFinalizationState(
  sidecarPath: string,
  state: MeetingFinalizationJob['phase'] | 'complete',
  claimPending: boolean,
): void {
  if (!existsSync(sidecarPath)) return
  const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>
  parsed.finalizationState = state
  parsed.claimPending = claimPending
  parsed.finalizationUpdatedAt = new Date().toISOString()
  if (state === 'complete') delete parsed.finalizationError
  durableAtomicWriteFileSync(sidecarPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
}

export function getMeetingFinalizationSnapshot(): {
  /** Work in progress. COS Control disables Restart and Update while this is above zero. */
  pending: number
  /** Failed and still trying. COS Control shows this as "retrying". */
  failed: number
  /** 6.97.0: gave up, waiting for a later start. Not in `pending` or `failed`. */
  stopped: number
  oldestUpdatedAt: string | null
  lastError: string | null
  malformed: number
} {
  const all = new MeetingFinalizationJobStore().list()
  const jobs = all.filter(job => !finalizationStop(job))
  const failed = jobs.filter(job => Boolean(job.lastError))
  const oldest = jobs.map(job => job.updatedAt).sort()[0] ?? null
  const mostRecentFailure = all.filter(job => Boolean(job.lastError)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return {
    pending: jobs.length,
    failed: failed.length,
    stopped: all.length - jobs.length,
    oldestUpdatedAt: oldest,
    lastError: mostRecentFailure?.lastError?.slice(0, 200) ?? null,
    malformed: new MeetingFinalizationJobStore().malformedCount(),
  }
}
