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
   * Every process working in this thread, COS's own children included.
   *
   * This is the DISPLAY question — "is an agent working in here right now" — and
   * a turn COS queued is just as much a running agent as a desktop window is.
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
      occupied.set(threadId, { threadId, owners: owners.length, foreignOwners: foreign })
    }
  }

  return { occupied, degraded }
}

/** The safe answer when the caller cannot scan at all. */
export function noOccupancyKnown(): OccupiedScan {
  return { occupied: new Map(EMPTY.occupied), degraded: true }
}
