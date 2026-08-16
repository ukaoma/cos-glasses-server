// Which threads currently have a live desktop process, in ONE pass.
//
// WHY THIS EXISTS SEPARATELY FROM `threadOccupancy`.
//
// `claudeOwners(threadId, ...)` re-reads the whole session registry and shells
// out to `ps` per entry, for ONE thread. That is correct and cheap when a user is
// deciding whether to write into a single thread. Calling it once per row to
// decorate a 53-row session list would mean tens of directory scans and hundreds
// of process spawns on every list request.
//
// So this does the opposite shape: scan once, return the set of occupied ids, and
// let the caller join in memory.
//
// THE LOAD-BEARING RULE, AND THE REASON THIS IS SAFE:
//
//   WHAT THIS PRODUCES IS A DISPLAY HINT. IT MUST NEVER GATE A WRITE.
//
// The attach and turn paths keep calling `threadOccupancy` at the moment of the
// write, unchanged. That is deliberate: a list is rendered seconds or minutes
// before the user acts, and a desktop session opened in that gap is exactly the
// race the per-write probe exists to catch. This hint answers "should the UI show
// this session as busy", never "is it safe to write".
//
// Being a hint is also why its failure mode is the opposite of the gate's. The
// gate fails CLOSED — doubt means refuse. A hint that failed closed would paint
// every session as running the moment a probe hiccuped, so doubt here means "I do
// not know", rendered as not-running, and the real gate still refuses at the
// write. Getting a hint wrong costs a misleading badge; getting the gate wrong
// costs someone's conversation.

import {
  claudeOwners,
  codexLockPath,
  codexOwners,
  type OccupancyDirs,
  type OccupancyProbes,
  type ThreadOwner,
} from './thread-occupancy.js'
import { isValidNativeThreadId } from './native-thread-id.js'

export interface OccupiedThread {
  threadId: string
  /**
   * Every process holding this thread open, COS's own children included.
   *
   * WHAT THIS ACTUALLY MEASURES, stated plainly because the first version of the
   * feature got it wrong in user-facing copy: a registry record means A PROCESS
   * HOLDS THIS THREAD OPEN. It does NOT mean an agent is generating. A Claude
   * Code record reads `kind: interactive, entrypoint: claude-desktop` for an open
   * WINDOW, so a session that finished ten minutes ago with the window still up
   * has an owner forever. The lens said "ACTIVE NOW" off this number and was
   * lying; it now says the thread is OPEN, which is all this count can support.
   */
  owners: number
  /**
   * Owners that are NOT COS's own children.
   *
   * The separate count matters because it answers a different question: whether a
   * Continue would be refused. Self-owned work does not block a write; a desktop
   * window does.
   */
  foreignOwners: number
  /**
   * The transcript was WRITTEN inside the freshness window: an agent is
   * generating here, not merely holding the file open.
   *
   * This is the signal `owners` cannot give. Set only from a positive
   * observation of a recent write — see `withActiveRecently`, which is where it
   * is filled in. `occupiedThreads` itself has no path to a transcript and
   * always leaves it false.
   */
  activeRecently: boolean
}

export interface OccupiedScan {
  /** threadId -> occupancy, for every thread with at least one owner. */
  occupied: Map<string, OccupiedThread>
  /**
   * True when the scan could not see clearly (unreadable registry, missing
   * detector). The caller should render "unknown", never "everything is running".
   */
  degraded: boolean
}

const EMPTY: OccupiedScan = { occupied: new Map(), degraded: true }

/**
 * Probes that answer each identical question once per scan.
 *
 * MEASURED, not assumed. `claudeOwners` re-reads the whole registry directory and
 * re-runs `ps` for every entry, for ONE thread — so scanning 45 real sessions on
 * this machine cost 771ms of repeated identical I/O. With this wrapper the same
 * scan is one directory read, one read per entry, and one `ps` per pid.
 *
 * Correctness comes from reusing `claudeOwners` / `codexOwners` UNCHANGED, so the
 * self-ownership rule and the PID-reuse guard stay in exactly one place. This only
 * removes duplicate work; it makes no decisions.
 *
 * Scoped to a single scan on purpose. A longer-lived cache would answer "is a
 * desktop process holding this thread" from stale data, and liveness has a
 * lifetime of about now.
 */
function memoize(probes: OccupancyProbes): OccupancyProbes {
  const dirs = new Map<string, string[]>()
  const files = new Map<string, string | null>()
  const starts = new Map<number, number | null>()
  const alive = new Map<number, boolean>()
  const exists = new Map<string, boolean>()
  const dirsExist = new Map<string, boolean>()
  let ledger: ReturnType<OccupancyProbes['cosSpawnedPids']> | undefined

  const once = <K, V>(cache: Map<K, V>, key: K, compute: () => V): V => {
    if (cache.has(key)) return cache.get(key)!
    const value = compute()
    cache.set(key, value)
    return value
  }

  return {
    ...probes,
    readDir: (path: string) => once(dirs, path, () => probes.readDir(path)),
    readFile: (path: string) => once(files, path, () => probes.readFile(path)),
    processStartMs: (pid: number) => once(starts, pid, () => probes.processStartMs(pid)),
    isAlive: (pid: number) => once(alive, pid, () => probes.isAlive(pid)),
    fileExists: (path: string) => once(exists, path, () => probes.fileExists(path)),
    dirExists: (path: string) => once(dirsExist, path, () => probes.dirExists(path)),
    cosSpawnedPids: () => (ledger ??= probes.cosSpawnedPids()),
  }
}

/**
 * Scan one provider's registry once and return the threads a desktop process
 * holds.
 *
 * Reuses `claudeOwners` / `codexOwners` rather than reimplementing the parsing,
 * so the self-ownership rule (COS's own spawned children must not read as foreign
 * owners) and the PID-reuse guard stay in exactly one place. Reuse alone would
 * repeat the whole registry read per thread — `memoize` is what removes that, so
 * the saving is real I/O rather than a claim in a comment.
 */
export function occupiedThreads(
  provider: string,
  threadIds: readonly string[],
  probes: OccupancyProbes,
  dirs: OccupancyDirs,
): OccupiedScan {
  if (provider !== 'claude' && provider !== 'codex') return { occupied: new Map(), degraded: false }

  // Deduplicated and validated up front. An invalid id cannot match a record, and
  // it also reaches a filesystem path in `codexLockPath`.
  const ids = [...new Set(threadIds)].filter(isValidNativeThreadId)
  if (ids.length === 0) return { occupied: new Map(), degraded: false }

  // Every identical read answered once for the whole scan. See `memoize`.
  const probe = memoize(probes)
  const occupied = new Map<string, OccupiedThread>()
  let degraded = false

  for (const threadId of ids) {
    // MEASURED: `codexOwners` reaches `lsof` even when no writer lock exists, and
    // lsof costs ~45ms a call — 761ms across 17 codex threads on this machine,
    // against zero locks on disk. A missing lock means no writer, which is the
    // same conclusion lsof reaches the expensive way, so skip it.
    //
    // Only an explicit `false` skips. `fileExists` collapses absent with
    // unreadable, and an unreadable lock must still go through the real check
    // rather than being read as free.
    if (provider === 'codex') {
      let lockPresent = true
      try {
        lockPresent = probe.fileExists(codexLockPath(threadId, dirs.codexLocksDir))
      } catch {
        lockPresent = true
      }
      if (!lockPresent) continue
    }

    let owners: readonly ThreadOwner[]
    let doubt: string | null
    try {
      const result = provider === 'claude'
        ? claudeOwners(threadId, probe, dirs.claudeSessionsDir)
        : codexOwners(threadId, probe, dirs.codexLocksDir)
      owners = result.owners
      doubt = result.doubt
    } catch {
      // One thread's probe throwing does not invalidate the others.
      degraded = true
      continue
    }
    if (doubt !== null) degraded = true
    // ANY owner means an agent is working here. Counting only foreign ones would
    // hide COS's own queued turn from the very screen the user opens to watch it.
    const foreign = owners.filter(o => !o.selfOwned).length
    if (owners.length > 0) {
      // `activeRecently` is FALSE here and can only be raised by
      // `withActiveRecently`. This function reads a process registry; a registry
      // record cannot tell generating from idling, and inferring one from the
      // other is the exact defect this field exists to fix.
      occupied.set(threadId, { threadId, owners: owners.length, foreignOwners: foreign, activeRecently: false })
    }
  }

  return { occupied, degraded }
}

/** The safe answer when the caller cannot scan at all. */
export function noOccupancyKnown(): OccupiedScan {
  return { occupied: new Map(EMPTY.occupied), degraded: true }
}

/**
 * How recently the transcript must have been written for a held thread to read
 * as WORKING rather than merely OPEN.
 *
 * WHY A SECOND SIGNAL EXISTS AT ALL. `owners` answers "a process holds this
 * thread", which is not the question the user is asking when he looks at the
 * lens. He watched a session finish on his Mac while the glasses still showed it
 * active, because the window was still open and the registry record therefore
 * still existed. Occupancy has no clock in it; the transcript does.
 *
 * MEASURED, not assumed: while a session generates, its jsonl mtime tracks the
 * wall clock to within a second, and when generation stops the mtime goes stale
 * while the registry record stays exactly where it was. That divergence is the
 * whole signal.
 *
 * 30 seconds is deliberately far wider than the observed sub-second write
 * cadence. The gap this has to survive is a long tool call or a slow first token
 * between writes, and a window sized to the cadence would flap a working session
 * to OPEN and back every time the model paused to think. The cost of the wide
 * window is bounded and known: a session that stops is reported working for up
 * to 30 more seconds, which is a late correction rather than a permanent lie.
 */
export const ACTIVE_RECENTLY_WINDOW_MS = 30_000

/**
 * Was this transcript written inside the window?
 *
 * NULL IS NOT "RECENT". An unresolvable path, an unreadable file, a stat that
 * threw — every one of them arrives here as null and answers false, so the row
 * falls back to OPEN. That is not a fail-open: OPEN is still a true statement
 * about a thread with a live owner. It is the STRONGER claim, "an agent is
 * working in here", that has to be earned by an actual observation.
 *
 * A timestamp far in the FUTURE is refused for the same reason rather than
 * treated as maximally fresh. Skew of a few seconds is normal and lands inside
 * the window; a file dated next week is a clock this server cannot reason about,
 * and letting it manufacture a permanent "working" badge would rebuild the bug
 * from the other direction.
 */
export function isActiveRecently(mtimeMs: number | null | undefined, nowMs: number): boolean {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false
  if (!Number.isFinite(nowMs)) return false
  return Math.abs(nowMs - mtimeMs) <= ACTIVE_RECENTLY_WINDOW_MS
}

/**
 * Fill in `activeRecently` for a scan, from transcript write times.
 *
 * PURE, and separate from `occupiedThreads` on purpose. Resolving a thread id to
 * a transcript path is the session STORE's job (it owns the projects/rollouts
 * layout), and this module owns process occupancy; wiring the store in here
 * would make an occupancy scan depend on a filesystem it does not otherwise know
 * about. The caller stats — for HELD THREADS ONLY, which is what keeps this
 * cheap, since it is one stat per already-occupied row and never one per listed
 * row — and hands the readings in.
 *
 * A thread with no entry in the map is not an error and not "recent": it reads
 * exactly like an unreadable one, because from here the two are the same
 * absence of evidence.
 */
export function withActiveRecently(
  scan: OccupiedScan,
  transcriptMtimes: ReadonlyMap<string, number | null>,
  nowMs: number,
): OccupiedScan {
  const occupied = new Map<string, OccupiedThread>()
  for (const [threadId, record] of scan.occupied) {
    occupied.set(threadId, {
      ...record,
      activeRecently: isActiveRecently(transcriptMtimes.get(threadId), nowMs),
    })
  }
  return { occupied, degraded: scan.degraded }
}
