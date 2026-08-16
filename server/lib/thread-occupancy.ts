// Is anyone else writing to this thread right now?
//
// Phase 0 of Continue Original Agent Thread. Protocol 1 attaches to a native
// desktop thread ONLY when no live process owns it (plan 4.3, resolved to
// option B on 2026-08-15). This module answers that one question and nothing
// else. It does not route, spawn, or bind — it decides attachable vs Fork-only.
//
// WHY A PRECONDITION AND NOT A LOCK. COS has no cross-process lock against a
// desktop app it does not own, and a transcript watermark cannot see a turn that
// is still generating (plan 4.3). So the race is not fenced, it is avoided: with
// no live owner there is no second writer for the race to involve.
//
// FAIL CLOSED, ALWAYS. Every unknown resolves to OCCUPIED. A missing field, an
// unreadable directory, a probe that throws, a provider we do not recognise —
// all of them return "occupied" with a reason, never "free". Absence of evidence
// is not evidence of absence, and the cost of a wrong "free" is a corrupted
// conversation while the cost of a wrong "occupied" is one Fork.
//
// FIVE THINGS THAT LOOK TRUE AND ARE NOT, all probed on this machine 2026-08-15:
//
//  1. A lock FILE is not a held lock. `~/.codex/thread-writer-locks/` keeps
//     `.coordination.lock` permanently, held by nobody, and a thread lock file
//     survives its `codex exec` by minutes. Only an open descriptor counts.
//  2. A socket file is not liveness — the same trap one layer over, already
//     documented in claude-session-registry.ts after an orphaned `.sock` was
//     found with a dead PID.
//  3. `entrypoint` and `kind` cannot identify our own spawns. A CLI `claude -p`
//     reports `entrypoint=claude-desktop, kind=interactive`, byte-identical to a
//     real desktop window, because those fields are baked per install and not
//     per invocation. Self-exclusion MUST come from a ledger of PIDs we spawned.
//  4. `lsof` on a Claude transcript returns nothing. Claude appends and closes,
//     so "who holds the file" finds no one even mid-session. Codex is the
//     opposite: its writer lock is held open for the life of the turn.
//  5. An 8-character session id is a DISPLAY value. `ClaudePeer.id` truncates,
//     and this file must never match on it — occupancy is a safety decision and
//     needs the full id.

/** Providers that have a certified occupancy detector. Anything else is occupied. */
export type OccupancyProvider = 'claude' | 'codex'

export interface ThreadOwner {
  provider: OccupancyProvider
  /** Full thread/session id. Never truncated. */
  threadId: string
  pid: number
  /** How the owner was established. */
  source: 'claude-registry' | 'codex-writer-lock'
  /** True when this PID is one COS spawned itself (plan 4.4, self-recursion). */
  selfOwned: boolean
}

export type OccupancyReason =
  | 'live_desktop_process'
  | 'unsupported_provider'
  | 'probe_failed'
  | 'unverifiable_process_start'

export interface Occupancy {
  attachable: boolean
  owners: ThreadOwner[]
  /** Null only when attachable. Surfaced in the Control/lens footer. */
  reason: OccupancyReason | null
}

export interface OccupancyProbes {
  /** signal-0 liveness. EPERM (another user's process) MUST resolve to false. */
  isAlive: (pid: number) => boolean
  /** Actual process start, epoch ms. Null when it cannot be determined. */
  processStartMs: (pid: number) => number | null
  fileExists: (path: string) => boolean
  /** Entry names only, no recursion. Throwing is allowed; callers fail closed. */
  readDir: (path: string) => string[]
  /** File contents, or null when unreadable. */
  readFile: (path: string) => string | null
  /** PIDs holding an open descriptor on this path, e.g. `lsof -t`. */
  lockHolders: (path: string) => number[]
  /** PIDs COS spawned. The ONLY sound basis for self-exclusion (see note 3). */
  cosSpawnedPids: () => ReadonlySet<number>
}

/** A Claude registry filename is exactly `<pid>.json`. Not `*.json`. */
export const CLAUDE_REGISTRY_FILENAME = /^\d+\.json$/

/**
 * Tolerance when comparing a recorded process start against the live one.
 *
 * `procStart` has one-second resolution, so an exact epoch comparison would
 * reject a valid match on rounding alone.
 */
export const PROC_START_TOLERANCE_MS = 1500

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Parse Claude's `procStart` to epoch ms.
 *
 * The field is `ps lstart` formatting but expressed in UTC, while `ps` itself
 * prints local time. A probe of this machine recorded
 * `Sun Aug 16 02:03:05 2026` for a process `ps` showed starting
 * `Sat Aug 15 21:03:05 2026` — the same instant at UTC-5, not a mismatch. An
 * earlier version of this check compared the two strings directly and reported
 * a false PID-reuse hit, which is exactly the bug this function exists to stop.
 */
export function parseProcStartUtcMs(procStart: unknown): number | null {
  if (typeof procStart !== 'string') return null
  // "Sun Aug 16 02:03:05 2026" -> [Aug, 16, 02:03:05, 2026]
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    procStart.trim().replace(/\s+/g, ' '),
  )
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return null
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Does this registry record still describe the process it names?
 *
 * Guards PID reuse: a stale record (Claude reaps on clean exit but not on a
 * crash) can name a PID the OS has since handed to something unrelated. Without
 * this, that record would be discarded as "not our session" only by accident, or
 * counted as a live owner of a thread nobody has open.
 *
 * Unverifiable resolves to FALSE — the record cannot be trusted either way, and
 * the caller turns that into `unverifiable_process_start`, not into "free".
 */
export function processStartMatches(
  recordedProcStart: unknown,
  actualStartMs: number | null,
): boolean {
  const recorded = parseProcStartUtcMs(recordedProcStart)
  if (recorded === null || actualStartMs === null) return false
  return Math.abs(recorded - actualStartMs) <= PROC_START_TOLERANCE_MS
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Live owners of a Claude thread, from `<config>/sessions/<pid>.json`.
 *
 * Four conditions, all required. Any one alone is a false positive:
 *   - the record names this EXACT full session id
 *   - the PID is alive
 *   - the recorded process start matches the live one (PID reuse)
 *   - the declared messaging socket is present (second liveness signal)
 *
 * Returns `null` to mean "could not determine", which the caller must treat as
 * occupied. An empty array means genuinely nobody.
 */
export function claudeOwners(
  threadId: string,
  probes: OccupancyProbes,
  sessionsDir: string,
): { owners: ThreadOwner[]; unverifiable: boolean } | null {
  if (!threadId) return null
  let entries: string[]
  try {
    entries = probes.readDir(sessionsDir)
  } catch {
    return null
  }

  const owners: ThreadOwner[] = []
  let unverifiable = false
  const self = probes.cosSpawnedPids()

  for (const entry of entries) {
    if (!CLAUDE_REGISTRY_FILENAME.test(entry)) continue
    let record: Record<string, unknown> | null
    try {
      record = parseJson(probes.readFile(`${sessionsDir}/${entry}`))
    } catch {
      return null
    }
    if (!record) continue

    // Full-id equality only. Never a prefix, never the 8-char display form.
    if (record.sessionId !== threadId) continue

    const pid = Number(record.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue

    let alive: boolean
    let startMs: number | null
    let socketOk: boolean
    try {
      alive = probes.isAlive(pid)
      if (!alive) continue
      startMs = probes.processStartMs(pid)
      const socketPath = typeof record.messagingSocketPath === 'string' ? record.messagingSocketPath : null
      socketOk = socketPath !== null && probes.fileExists(socketPath)
    } catch {
      return null
    }

    if (!processStartMatches(record.procStart, startMs)) {
      // Alive PID whose identity we cannot confirm. Not counted as an owner, but
      // it poisons the "nobody is here" conclusion for this thread.
      unverifiable = true
      continue
    }
    if (!socketOk) {
      unverifiable = true
      continue
    }

    owners.push({
      provider: 'claude',
      threadId,
      pid,
      source: 'claude-registry',
      selfOwned: self.has(pid),
    })
  }

  return { owners, unverifiable }
}

/** Path of the Codex per-thread writer lock. */
export function codexLockPath(threadId: string, locksDir: string): string {
  return `${locksDir}/${threadId}.lock`
}

/**
 * Live owners of a Codex thread, from `~/.codex/thread-writer-locks/<id>.lock`.
 *
 * Stronger than the Claude path and simpler for it: this is a real writer lock
 * held open for the life of the turn by both the desktop app and a CLI
 * `codex exec`, so an open descriptor is definitionally live and no process-start
 * guard is needed. A dead process cannot hold a descriptor, and PID reuse cannot
 * fabricate one on this exact path.
 *
 * The lock FILE outlives the run, so its existence proves nothing (note 1).
 */
export function codexOwners(
  threadId: string,
  probes: OccupancyProbes,
  locksDir: string,
): { owners: ThreadOwner[]; unverifiable: boolean } | null {
  if (!threadId) return null
  const path = codexLockPath(threadId, locksDir)

  let holders: number[]
  try {
    if (!probes.fileExists(path)) return { owners: [], unverifiable: false }
    holders = probes.lockHolders(path)
  } catch {
    return null
  }

  const self = probes.cosSpawnedPids()
  const owners = holders
    .filter(pid => Number.isInteger(pid) && pid > 0)
    .map<ThreadOwner>(pid => ({
      provider: 'codex',
      threadId,
      pid,
      source: 'codex-writer-lock',
      selfOwned: self.has(pid),
    }))

  return { owners, unverifiable: false }
}

export interface OccupancyDirs {
  /** `<CLAUDE_CONFIG_DIR|~/.claude>/sessions` */
  claudeSessionsDir: string
  /** `~/.codex/thread-writer-locks` */
  codexLocksDir: string
}

/**
 * The Phase 0 attach precondition.
 *
 * Attachable ONLY when a supported provider returns zero owners that are not our
 * own spawns. Our own spawns are excluded because COS continuing a thread it is
 * already driving is not a foreign writer (plan 4.4) — but that exclusion is
 * driven by the spawn ledger, never by anything the provider self-reports.
 */
export function threadOccupancy(
  provider: string,
  threadId: string,
  probes: OccupancyProbes,
  dirs: OccupancyDirs,
): Occupancy {
  let result: { owners: ThreadOwner[]; unverifiable: boolean } | null
  if (provider === 'claude') {
    result = claudeOwners(threadId, probes, dirs.claudeSessionsDir)
  } else if (provider === 'codex') {
    result = codexOwners(threadId, probes, dirs.codexLocksDir)
  } else {
    // Cursor and anything unrecognised. Not a failure — an honest capability gap.
    return { attachable: false, owners: [], reason: 'unsupported_provider' }
  }

  if (result === null) return { attachable: false, owners: [], reason: 'probe_failed' }

  const foreign = result.owners.filter(o => !o.selfOwned)
  if (foreign.length > 0) {
    return { attachable: false, owners: result.owners, reason: 'live_desktop_process' }
  }
  if (result.unverifiable) {
    return { attachable: false, owners: result.owners, reason: 'unverifiable_process_start' }
  }
  return { attachable: true, owners: result.owners, reason: null }
}
