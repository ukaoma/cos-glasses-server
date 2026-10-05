/**
 * 6.63.0: the durable record of a background fork (`POST .../fork` with a `clientForkId`).
 *
 * WHY THIS EXISTS. A fork runs a real model turn in the copy before it can say what it
 * made, and the attached adapter lets that turn run for 21 minutes. COS Control waited 5,
 * so on 2026-10-05 a 6.5-minute fork that SUCCEEDED was reported to Miles as "Server
 * stopped", the card kept pointing at the original thread, and the copy only surfaced in
 * the server log. A caller that cannot hold a request open for 21 minutes (Control holds
 * its Work journal lock while it waits; iOS suspends the phone's WebView) needs to start a
 * fork, get an answer at once, and read the outcome later. That outcome lives here.
 *
 * WHAT IT HOLDS. One row per `clientForkId`: `running` until the fork settles, then the
 * exact status and body the synchronous route would have answered. The FIRST settle wins
 * and is never overwritten, so a replayed id always sees what its own fork did.
 *
 * RESTART. A `running` row written by an earlier server process cannot settle any more:
 * its promise died with that process, and its child may or may not have made a copy.
 * `load` turns such rows into the cautious `fork_orphan_possible` answer (not
 * retryable), which tells the user to look in Sessions before forking again. It never
 * reports them as failed: a copy may exist.
 *
 * PRIVACY. No prompt, no native thread id: the body is the one the route already puts on
 * the wire (a `forkRef` digest, never an id), and the source is kept only as a digest.
 */
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'

/** Same shape as a client turn id: what the client mints and can safely echo back. */
export const CLIENT_FORK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** Rows kept. A fork is a user action, so this is weeks of history, and the file stays small. */
export const MAX_FORK_JOBS = 200
/** A settled row older than this is dropped on the next write. */
export const FORK_JOB_TTL_MS = 7 * 24 * 60 * 60_000

export type ForkJobState = 'running' | 'done'

export interface ForkJobRow {
  clientForkId: string
  /** `opaqueRevision(targetKey(provider, sourceThreadId))`: which source this job forks, never the id. */
  source: string
  provider: string
  state: ForkJobState
  acceptedAt: number
  /** The process that accepted it. A `running` row from another process is interrupted. */
  instance: string
  settledAt?: number
  /** The HTTP status the synchronous route would have answered. */
  status?: number
  /** The body the synchronous route would have answered. */
  result?: Record<string, unknown>
}

export interface ForkJobPersistence {
  load: () => unknown
  save: (rows: ForkJobRow[]) => void
}

/** The answer an interrupted fork settles to. Copy matches the route's own orphan wording. */
export const INTERRUPTED_FORK_RESULT: Record<string, unknown> = {
  forked: false,
  forkRef: null,
  sourceIntegrity: null,
  orphanPossible: true,
  retryable: false,
  interrupted: true,
  reason: 'fork_orphan_possible',
  reasonCopy: 'The server restarted while COS was making the copy. A copy may exist: look for it in Sessions before forking again.',
}
export const INTERRUPTED_FORK_STATUS = 503

function isRow(value: unknown): value is ForkJobRow {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.clientForkId === 'string' && CLIENT_FORK_ID_RE.test(r.clientForkId)
    && typeof r.source === 'string' && typeof r.provider === 'string'
    && (r.state === 'running' || r.state === 'done')
    && typeof r.acceptedAt === 'number' && Number.isFinite(r.acceptedAt)
    && typeof r.instance === 'string'
    && (r.state === 'running' || (typeof r.status === 'number' && !!r.result && typeof r.result === 'object'))
}

export type BeginResult =
  | { kind: 'started'; row: ForkJobRow }
  /** This id already has a job: the caller replays it and never spawns. */
  | { kind: 'existing'; row: ForkJobRow }
  /** The id is already used for a different source thread. */
  | { kind: 'conflict' }
  /** The ledger could not be written, so the fork must not start (its outcome would be unreadable). */
  | { kind: 'unavailable' }

export class ForkJobLedger {
  private rows = new Map<string, ForkJobRow>()

  constructor(
    private readonly instance: string,
    private readonly persistence?: ForkJobPersistence,
    now: number = Date.now(),
  ) {
    let raw: unknown = []
    try { raw = persistence?.load() ?? [] } catch (error) {
      console.error(`[fork-job-ledger] load failed: ${error instanceof Error ? error.message : error}`)
      raw = []
    }
    let interrupted = 0
    for (const value of Array.isArray(raw) ? raw : []) {
      if (!isRow(value)) continue
      let row = value
      if (row.state === 'running' && row.instance !== instance) {
        row = { ...row, state: 'done', settledAt: now, status: INTERRUPTED_FORK_STATUS, result: { ...INTERRUPTED_FORK_RESULT } }
        interrupted += 1
      }
      this.rows.set(row.clientForkId, row)
    }
    if (interrupted > 0) {
      console.warn(`[fork-job-ledger] ${interrupted} fork job(s) were running when the server last stopped; recorded as orphan-possible`)
      this.save(now)
    }
  }

  get(clientForkId: string): ForkJobRow | null {
    return this.rows.get(clientForkId) ?? null
  }

  /** Records a running job. Persisted BEFORE the caller spawns anything. */
  begin(input: { clientForkId: string; source: string; provider: string }, now: number): BeginResult {
    const existing = this.rows.get(input.clientForkId)
    if (existing) return existing.source === input.source ? { kind: 'existing', row: existing } : { kind: 'conflict' }
    const row: ForkJobRow = {
      clientForkId: input.clientForkId, source: input.source, provider: input.provider,
      state: 'running', acceptedAt: now, instance: this.instance,
    }
    this.rows.set(row.clientForkId, row)
    if (!this.save(now)) {
      this.rows.delete(row.clientForkId)
      return { kind: 'unavailable' }
    }
    return { kind: 'started', row }
  }

  /** The first settle wins. Returns false if the row is unknown or already settled. */
  settle(clientForkId: string, status: number, result: Record<string, unknown>, now: number): boolean {
    const row = this.rows.get(clientForkId)
    if (!row || row.state !== 'running') return false
    this.rows.set(clientForkId, { ...row, state: 'done', settledAt: now, status, result })
    // A failed write keeps the settled row in memory, so this process still answers it.
    this.save(now)
    return true
  }

  /** Running rows in this process (for health). */
  runningCount(): number {
    let n = 0
    for (const row of this.rows.values()) if (row.state === 'running') n += 1
    return n
  }

  private save(now: number): boolean {
    // Drop settled rows past the TTL, then the oldest settled rows past the cap. Running
    // rows are never dropped: their outcome is still owed to a caller.
    for (const [id, row] of this.rows) {
      if (row.state === 'done' && now - (row.settledAt ?? row.acceptedAt) > FORK_JOB_TTL_MS) this.rows.delete(id)
    }
    if (this.rows.size > MAX_FORK_JOBS) {
      const settled = [...this.rows.values()].filter(r => r.state === 'done').sort((a, b) => a.acceptedAt - b.acceptedAt)
      for (const row of settled) {
        if (this.rows.size <= MAX_FORK_JOBS) break
        this.rows.delete(row.clientForkId)
      }
    }
    if (!this.persistence) return true
    try {
      this.persistence.save([...this.rows.values()])
      return true
    } catch (error) {
      console.error(`[fork-job-ledger] save failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }
}

/** File persistence: `<data>/fork-jobs.json`, written durably, quarantined if corrupt. */
export function fileForkJobPersistence(path: string): ForkJobPersistence {
  return {
    load: () => {
      const loaded = loadJsonOrQuarantine<unknown>(path)
      if (loaded.status === 'corrupt') {
        console.warn(`[fork-job-ledger] fork job file was corrupt, quarantined as ${loaded.quarantinedAs}`)
        return []
      }
      return loaded.status === 'ok' ? loaded.data : []
    },
    save: rows => durableAtomicWriteFileSync(path, `${JSON.stringify(rows)}\n`),
  }
}
