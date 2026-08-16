// Is anyone else writing to this thread right now?
//
// Phase 0 of Continue Original Agent Thread. Protocol 1 attaches to a native
// desktop thread ONLY when no live process owns it (plan 4.3, resolved to
// option B). This module answers that one question: attachable, or Fork-only
// with a reason.
//
// THE RULE THAT GOVERNS EVERY LINE BELOW: "I found no owner" is NOT "there is
// no owner." Returning attachable requires POSITIVE proof of an empty registry
// — a validated id, a detector that demonstrably exists, a readable directory,
// and every candidate record parsed. Anything less is occupied.
//
// The first version of this file got that backwards and QA caught six inputs
// where a live desktop owner was present and it still returned attachable:
// a truncated id, a path-traversal id, corrupt JSON, an unreadable record, a
// malformed pid, and an empty directory on a build with no registry at all.
// Every one was "no match found" quietly becoming "free". That is the same
// absence-inference failure the project's own rules call out by name, so the
// verdict logic is now inverted: `claudeOwners` reports what it could NOT
// establish, and `threadOccupancy` refuses on any doubt.
//
// SIX THINGS THAT LOOK TRUE AND ARE NOT, all probed on this machine 2026-08-15:
//
//  1. A lock FILE is not a held lock. `~/.codex/thread-writer-locks/` keeps
//     `.coordination.lock` permanently, held by nobody, and a thread lock file
//     survives its `codex exec` by minutes. Only an open descriptor counts.
//  2. A socket file is not liveness — the same trap one layer over, already
//     documented in claude-session-registry.ts after an orphaned `.sock` was
//     found with a dead PID.
//  3. `entrypoint` and `kind` cannot identify our own spawns. A CLI `claude -p`
//     reports `entrypoint=claude-desktop, kind=interactive`, byte-identical to a
//     real desktop window. Self-exclusion MUST come from a spawn ledger.
//  4. A bare PID is not an identity. The ledger is keyed pid -> process start,
//     because a recycled PID would otherwise forge self-ownership — and
//     self-ownership is the ONLY path that turns a live owner into attachable.
//  5. `lsof` on a Claude transcript returns nothing. Claude appends and closes.
//     Codex is the opposite: its writer lock is held for the life of the turn.
//  6. An empty directory is not an empty registry. Claude Code only writes
//     `sessions/<pid>.json` from 2.1.224; on an older build the directory is
//     absent while fully attachable-looking threads exist in `projects/`.

import { isValidNativeThreadId } from './native-thread-id.js'

/** Providers that have a certified occupancy detector. Anything else is occupied. */
export type OccupancyProvider = 'claude' | 'codex'

export interface ThreadOwner {
  provider: OccupancyProvider
  /** Full thread id. Never truncated. */
  threadId: string
  pid: number
  source: 'claude-registry' | 'codex-writer-lock'
  /** True when the spawn ledger proves this PID is ours (plan 4.4). */
  selfOwned: boolean
}

export type OccupancyReason =
  | 'live_desktop_process'
  | 'unsupported_provider'
  | 'invalid_thread_id'
  | 'detector_unavailable'
  | 'registry_unreadable'
  | 'unverifiable_process_start'
  | 'unverifiable_liveness_socket'
  | 'probe_failed'
  // Not an occupancy finding: the write feature is switched off (plan 4.9). Set
  // before any probe runs, so a disabled install does no filesystem work and can
  // never report a thread free that it has no way to write to.
  | 'attach_disabled'

export interface Occupancy {
  attachable: boolean
  owners: ThreadOwner[]
  /** Null only when attachable. Drives the Control/lens footer copy. */
  reason: OccupancyReason | null
}

/**
 * What a scan could not establish. Any non-null value forbids attaching, even
 * with zero owners — that is the whole point of the type.
 */
type Doubt = Exclude<OccupancyReason, 'live_desktop_process' | 'unsupported_provider' | 'invalid_thread_id'> | null

interface ScanResult {
  owners: ThreadOwner[]
  doubt: Doubt
}

export interface OccupancyProbes {
  /** signal-0 liveness. See the EPERM note on `isAliveMeansPresent` below. */
  isAlive: (pid: number) => boolean
  /** Actual process start, epoch ms. Null when it cannot be determined. */
  processStartMs: (pid: number) => number | null
  fileExists: (path: string) => boolean
  /**
   * Does this directory exist? Required before any "nobody is here" verdict:
   * it is the only evidence the detection mechanism applies to this install.
   */
  dirExists: (path: string) => boolean
  /** Entry names only. MUST throw on an unreadable directory, never return []. */
  readDir: (path: string) => string[]
  /** File contents. Null means UNREADABLE and is treated as doubt, not absence. */
  readFile: (path: string) => string | null
  /** PIDs holding an open descriptor, e.g. `lsof -t`. No holders is [], not a throw. */
  lockHolders: (path: string) => number[]
  /**
   * PIDs COS spawned, mapped to their process start in epoch ms.
   *
   * A Set of bare pids is NOT sufficient. This is the only input that can turn
   * a live owner into attachable, so a recycled PID must not be able to forge
   * membership — the start time is what makes the claim checkable.
   */
  cosSpawnedPids: () => ReadonlyMap<number, number>
}

/** A Claude registry filename is exactly `<pid>.json`. Not `*.json`. */
export const CLAUDE_REGISTRY_FILENAME = /^\d+\.json$/

/** Upper bound on registry entries scanned, mirroring routes/claude-sessions.ts. */
export const MAX_REGISTRY_FILES = 500

/**
 * Tolerance when comparing a recorded process start against the live one.
 * `procStart` has one-second resolution, so an exact epoch comparison would
 * reject a valid match on rounding alone.
 */
export const PROC_START_TOLERANCE_MS = 1500

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Parse Claude's `procStart` to epoch ms.
 *
 * The field is `ps lstart` formatting expressed in UTC, while `ps` itself prints
 * local time. A live record read `Sun Aug 16 02:03:05 2026` for a process `ps`
 * showed starting `Sat Aug 15 21:03:05 2026` — the same instant at UTC-5. An
 * earlier version compared the strings directly and reported a false PID-reuse
 * hit, which is the bug this function exists to prevent.
 *
 * The mirror-image hazard lives in the `processStartMs` probe: it must NOT parse
 * localized `ps -o lstart` output, or the same bug reappears one layer down.
 */
export function parseProcStartUtcMs(procStart: unknown): number | null {
  if (typeof procStart !== 'string') return null
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    procStart.trim().replace(/\s+/g, ' '),
  )
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return null
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isFinite(ms) ? ms : null
}

/** Do two process-start readings describe the same process? Unverifiable is false. */
export function sameProcessStart(recordedMs: number | null, actualMs: number | null): boolean {
  if (recordedMs === null || actualMs === null) return false
  return Math.abs(recordedMs - actualMs) <= PROC_START_TOLERANCE_MS
}

export function processStartMatches(recordedProcStart: unknown, actualStartMs: number | null): boolean {
  return sameProcessStart(parseProcStartUtcMs(recordedProcStart), actualStartMs)
}

/**
 * Is this PID provably one of ours?
 *
 * Membership alone is not enough: the ledger outlives the process, and a
 * recycled PID would inherit the claim. The recorded start must match the live
 * one, using the same tolerance as the registry check.
 */
export function isSelfOwned(
  pid: number,
  actualStartMs: number | null,
  ledger: ReadonlyMap<number, number>,
): boolean {
  // A duck-typed `{ get: () => Date.now() }` satisfies the TYPE and was verified to
  // grant ownership over a fully live foreign owner. Production is saved one layer
  // up by occupancy-probes.sanitizeLedger, but `probes` is an INJECTED dependency,
  // so any other wiring loses that guard while this function's own doc promises a
  // recycled pid cannot forge membership. Self-ownership is the only path that
  // turns a live owner into attachable, so it validates its own input.
  if (!(ledger instanceof Map)) return false
  const spawnedAt = ledger.get(pid)
  if (typeof spawnedAt !== 'number') return false
  return sameProcessStart(spawnedAt, actualStartMs)
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Scan the Claude registry for live owners of one thread.
 *
 * Every skip AFTER the id matches records doubt. A record naming this exact
 * thread is positive evidence that some process claims it, so discarding one
 * silently — for corrupt JSON, an unreadable file, or a malformed pid — is how
 * the first version produced a false "free".
 */
export function claudeOwners(
  threadId: string,
  probes: OccupancyProbes,
  sessionsDir: string,
): ScanResult {
  if (!probes.dirExists(sessionsDir)) return { owners: [], doubt: 'detector_unavailable' }

  const entries = probes.readDir(sessionsDir).filter(e => CLAUDE_REGISTRY_FILENAME.test(e))
  if (entries.length > MAX_REGISTRY_FILES) return { owners: [], doubt: 'registry_unreadable' }

  const owners: ThreadOwner[] = []
  let doubt: Doubt = null
  const ledger = probes.cosSpawnedPids()

  for (const entry of entries) {
    const raw = probes.readFile(`${sessionsDir}/${entry}`)
    // Null is the documented "unreadable" signal. It cannot be distinguished
    // from a record for THIS thread, so it is doubt, not absence. (A file that
    // vanished between readDir and readFile is benign but indistinguishable
    // here; erring toward Fork costs one fork, the other way costs a
    // conversation.)
    if (raw === null) { doubt ??= 'registry_unreadable'; continue }

    const record = parseJson(raw)
    if (!record) { doubt ??= 'registry_unreadable'; continue }
    if (record.sessionId !== threadId) continue

    // From here the record claims THIS thread. Nothing may be dropped quietly.
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
      doubt ??= 'registry_unreadable'
      continue
    }
    const pid = record.pid

    if (!probes.isAlive(pid)) continue // genuinely dead: reaping missed it, no owner

    const startMs = probes.processStartMs(pid)
    if (!processStartMatches(record.procStart, startMs)) {
      doubt ??= 'unverifiable_process_start'
      continue
    }

    const socketPath = typeof record.messagingSocketPath === 'string' ? record.messagingSocketPath : null
    if (socketPath === null || !probes.fileExists(socketPath)) {
      doubt ??= 'unverifiable_liveness_socket'
      continue
    }

    owners.push({
      provider: 'claude',
      threadId,
      pid,
      source: 'claude-registry',
      selfOwned: isSelfOwned(pid, startMs, ledger),
    })
  }

  return { owners, doubt }
}

/** Path of the Codex per-thread writer lock. */
export function codexLockPath(threadId: string, locksDir: string): string {
  return `${locksDir}/${threadId}.lock`
}

/**
 * Scan the Codex writer lock for live owners of one thread.
 *
 * Stronger than the Claude path and simpler for it: this is a real lock held
 * open for the life of the turn by both the desktop app and a CLI `codex exec`,
 * so an open descriptor is definitionally live and no process-start guard is
 * needed on the record side. The ledger check still needs one.
 *
 * The lock FILE outlives the run, so its existence proves nothing — but the
 * DIRECTORY's existence is what proves the detector applies to this install.
 */
export function codexOwners(
  threadId: string,
  probes: OccupancyProbes,
  locksDir: string,
): ScanResult {
  if (!probes.dirExists(locksDir)) return { owners: [], doubt: 'detector_unavailable' }

  const path = codexLockPath(threadId, locksDir)
  // No fileExists pre-check: it adds a TOCTOU window and buys nothing, since
  // lockHolders on an absent file is simply empty.
  const holders = probes.lockHolders(path)
  const ledger = probes.cosSpawnedPids()

  const owners: ThreadOwner[] = []
  let doubt: Doubt = null

  for (const pid of holders) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      doubt ??= 'registry_unreadable'
      continue
    }
    owners.push({
      provider: 'codex',
      threadId,
      pid,
      source: 'codex-writer-lock',
      selfOwned: isSelfOwned(pid, probes.processStartMs(pid), ledger),
    })
  }

  return { owners, doubt }
}

export interface OccupancyDirs {
  /** `<CLAUDE_CONFIG_DIR|~/.claude>/sessions` */
  claudeSessionsDir: string
  /** `<CODEX_HOME|~/.codex>/thread-writer-locks` */
  codexLocksDir: string
}

/**
 * The Phase 0 attach precondition.
 *
 * Returns attachable ONLY when a supported provider proved its detector exists,
 * read every candidate record, and found no foreign owner. Every other outcome
 * names why. The whole function is wrapped: a throwing probe — including the
 * spawn ledger, which is the most safety-critical of them — is `probe_failed`,
 * never an exception escaping into a route.
 */
export function threadOccupancy(
  provider: string,
  threadId: string,
  probes: OccupancyProbes,
  dirs: OccupancyDirs,
): Occupancy {
  if (provider !== 'claude' && provider !== 'codex') {
    // Cursor and anything unrecognised: an honest capability gap, not a failure.
    return { attachable: false, owners: [], reason: 'unsupported_provider' }
  }
  // Validated BEFORE any scan. A truncated or malformed id matches no record,
  // and "matched nothing" must never reach the empty-means-free path. It also
  // reaches a filesystem path in codexLockPath.
  if (!isValidNativeThreadId(threadId)) {
    return { attachable: false, owners: [], reason: 'invalid_thread_id' }
  }

  let result: ScanResult
  try {
    result = provider === 'claude'
      ? claudeOwners(threadId, probes, dirs.claudeSessionsDir)
      : codexOwners(threadId, probes, dirs.codexLocksDir)
  } catch {
    return { attachable: false, owners: [], reason: 'probe_failed' }
  }

  const foreign = result.owners.filter(o => !o.selfOwned)
  if (foreign.length > 0) {
    return { attachable: false, owners: result.owners, reason: 'live_desktop_process' }
  }
  if (result.doubt !== null) {
    return { attachable: false, owners: result.owners, reason: result.doubt }
  }
  return { attachable: true, owners: result.owners, reason: null }
}
