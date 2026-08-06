import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

const JOB_NAME = /^[A-Za-z0-9:_-]{3,96}\.json$/

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
  pending: number
  failed: number
  oldestUpdatedAt: string | null
  lastError: string | null
  malformed: number
} {
  const jobs = new MeetingFinalizationJobStore().list()
  const failed = jobs.filter(job => Boolean(job.lastError))
  const oldest = jobs.map(job => job.updatedAt).sort()[0] ?? null
  const mostRecentFailure = failed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return {
    pending: jobs.length,
    failed: failed.length,
    oldestUpdatedAt: oldest,
    lastError: mostRecentFailure?.lastError?.slice(0, 200) ?? null,
    malformed: new MeetingFinalizationJobStore().malformedCount(),
  }
}
