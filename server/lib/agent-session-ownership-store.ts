// Which provider processes did COS itself start?
//
// Plan 4.4 (self-recursion prevention). This is the ONLY sound basis for
// self-exclusion in the occupancy detector, because nothing a provider process
// reports about itself can distinguish our spawn from a human's desktop window.
// Verified on this machine 2026-08-15: a CLI `claude -p` spawned by Node writes
// `~/.claude/sessions/<pid>.json` with `kind: "interactive"` and
// `entrypoint: "claude-desktop"` — byte-identical to the live desktop record for
// pid 7872. There is no self-reported field to filter on. Either we remember
// what we started, or we cannot tell our own process from the user's.
//
// WHY THE VALUE IS A START TIME AND NOT A BOOLEAN. `cosSpawnedPids` is the one
// input to `threadOccupancy` that can turn a LIVE owner into `attachable`.
// Every other input can only add doubt. A bare `Set<number>` would mean a
// recycled PID inherits our claim and unlocks a stranger's live conversation,
// and PID reuse is not exotic — macOS wraps at 99999. The recorded start makes
// the claim checkable: `isSelfOwned` (thread-occupancy.ts) requires it to match
// the live process start within `PROC_START_TOLERANCE_MS`, so a recycled PID —
// which by construction started later — cannot forge membership.
//
// SCOPE, NAMED RATHER THAN IMPLIED. Plan 4.4 describes a durable ownership
// registry with four classes (`cos_created`, `externally_attached`, `external`,
// `unknown`). This file implements ONLY the in-process spawn ledger that such a
// registry would be forward-populated FROM. The durable classification store
// does not exist yet, and no caller should read absence from this ledger as
// `external`: absence here means "not a process this server started", which is
// the plan's `unknown` — Fork-only.
//
// EVERY UNKNOWN RESOLVES TO "NOT OURS". A rejected record, an expired entry, an
// evicted entry, a snapshot that failed internally: all produce a ledger that
// omits the pid, which makes a live owner read as foreign, which makes the
// thread Fork-only. That is a lost feature, not a lost conversation. The
// opposite mistake — claiming a process we did not start — hands a stranger's
// live thread to a COS turn. There is no symmetric risk here, so every judgment
// call in this file goes the same way.
//
// FOUR THINGS THAT LOOK TRUE AND ARE NOT:
//
//  1. "detached: true means the pid we get back is a wrapper." It is not, for
//     either provider. VERIFIED 2026-08-15 by spawning both exactly as the
//     bridges do (`detached: true`, stdio pipes):
//       - claude: `spawn('claude', ['-p', ...])` returned pid 98602 and Claude
//         wrote `~/.claude/sessions/98602.json` containing `"pid": 98602`.
//         `/opt/homebrew/bin/claude` is a symlink straight to a Mach-O binary,
//         so there is no shell wrapper to insert a pid.
//       - codex: the spawned pid 99301 was the exact pid `lsof -t` reported
//         holding the new `~/.codex/thread-writer-locks/<uuid>.lock`.
//     So the ledger is keyed on the spawned child pid. It does NOT need to
//     cover the process group, and must not: `detached: true` makes the child a
//     group LEADER (observed pgid 99301 == pid 99301), so a group-keyed ledger
//     would sweep in any grandchild the provider forks and claim those too.
//  2. "record it whenever, the start time sorts it out." No: an old start value
//     recorded late is a claim about a process that has been running for a
//     while, i.e. possibly the user's. A claim is only accepted if it describes
//     a process that started within `MAX_SPAWN_START_AGE_MS` of now.
//  3. "persisting the ledger would survive restarts, which is better." It is
//     worse, and this is the one place the safe direction is also the correct
//     one. Bridges spawn `detached: true`, so a provider child CAN outlive the
//     server. A restarted server cannot kill it, cannot see its stdout, and
//     cannot coordinate with it — it is exactly the second writer protocol 1
//     exists to avoid. In-process-only means such a child reads as foreign and
//     the thread is Fork-only. See `stats()` for how to tell that state apart
//     from an idle ledger.
//  4. "an empty snapshot means nothing is running." It can also mean the clock
//     probe threw. Both are safe, but they are different, so `stats()` counts
//     them separately rather than leaving an operator to guess (the same
//     detector-unavailable vs. detector-found-nothing distinction the occupancy
//     module draws).

import { PROC_START_TOLERANCE_MS } from './thread-occupancy.js'

/**
 * How long an entry survives after `record`, absent a `release`.
 *
 * The tension, stated so the choice is auditable: retain too long and a
 * recycled PID gets a second chance at forging self-ownership (the start check
 * still has to fail for that to bite, but defense in depth is the point of the
 * bound); evict too early and a genuine COS child ages out mid-run, after which
 * we treat our own process as a foreign writer. The second failure costs a
 * Fork; the first costs someone's conversation. So the bound is deliberately
 * near the low end of "long enough".
 *
 * 30 minutes is chosen against the longest legitimate run this server allows:
 * `providerTimeoutMs` defaults to 21 minutes (query-job-coordinator.ts:136) and
 * the Claude wall-clock ceiling tops out at 20 minutes
 * (`WALL_MAX_DEEP_EFFORT_MS`, claude-bridge.ts:78). 30 covers both with margin
 * and nothing longer is reachable, so a live entry expiring is a bug signal
 * rather than routine.
 */
export const SPAWN_ENTRY_TTL_MS = 30 * 60_000

/**
 * Hard cap on tracked spawns. Overflow evicts the oldest entry, which is the
 * fail-closed direction: the evicted process reverts to "not ours".
 *
 * 64 is far above the real concurrency (attached turns serialize on the native
 * target, ordinary ones on the COS session), so hitting it means something is
 * recording without releasing — which `stats().evictedCapacity` reports.
 */
export const MAX_TRACKED_SPAWNS = 64

/**
 * How stale a claimed start may be at `record` time.
 *
 * `record` is called from the provider-process callback microseconds-to-
 * milliseconds after `spawn` returns, so the honest window is small. A minute
 * absorbs a badly loaded event loop while still rejecting the dangerous input:
 * a timestamp lifted from somewhere else, describing a process that was already
 * running — which is the shape of the user's desktop app.
 */
export const MAX_SPAWN_START_AGE_MS = 60_000

/**
 * How far in the future a claimed start may be. Reuses the occupancy
 * tolerance because it exists for the same reason: process-start readings on
 * macOS have one-second resolution, so small disagreement is rounding, not a
 * different process.
 */
export const MAX_SPAWN_START_SKEW_MS = PROC_START_TOLERANCE_MS

/** Any real pid fits; this only rejects garbage that reached us as a number. */
export const MAX_PLAUSIBLE_PID = 2 ** 31 - 1

/**
 * Why a claim was or was not accepted.
 *
 * Distinct reasons rather than a boolean: "we never recorded it" and "we
 * rejected a malformed claim" produce the same safe verdict downstream but call
 * for different fixes, and a caller that logs `rejected_start_not_recent` finds
 * a wiring bug in one line.
 */
export type SpawnRecordOutcome =
  | 'recorded'
  | 'rejected_pid'
  | 'rejected_self_pid'
  | 'rejected_start'
  | 'rejected_start_not_recent'
  | 'rejected_internal'

export interface SpawnLedgerStats {
  /** Live entries at the last successful prune. */
  tracked: number
  recorded: number
  released: number
  rejected: number
  lastRejection: SpawnRecordOutcome | null
  evictedExpired: number
  evictedCapacity: number
  /**
   * Snapshots that failed internally and returned empty.
   *
   * Non-zero means an empty ledger may be a broken ledger rather than an idle
   * one. The verdict is the same either way; the diagnosis is not.
   */
  snapshotFailures: number
}

interface SpawnEntry {
  /** Process start, epoch ms, as claimed by the spawner. */
  startMs: number
  /** When the claim was accepted. Retention is measured from here, not startMs. */
  recordedAt: number
}

export interface SpawnLedgerOptions {
  /** Injectable for tests. Must return epoch ms. */
  now?: () => number
  maxEntries?: number
  ttlMs?: number
}

function isPlausiblePid(value: unknown): value is number {
  // Number.isSafeInteger rejects NaN, ±Infinity and floats in one call.
  // `> 0` matters beyond tidiness: 0 is the kernel and a NEGATIVE value is a
  // process GROUP in kill(2) semantics, so neither may ever enter a pid map.
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_PLAUSIBLE_PID
}

/**
 * The in-process record of provider children this server started.
 *
 * Not exported as a bare map anywhere: `snapshot()` hands out a copy, so a
 * caller cannot write an entry into the ledger by mutating what it was given.
 * That matters because the caller here is a probe passed into occupancy
 * detection, and an injected entry is a forged self-ownership claim.
 */
export class CosSpawnLedger {
  private readonly entries = new Map<number, SpawnEntry>()
  private readonly clock: () => number
  private readonly maxEntries: number
  private readonly ttlMs: number

  private recordedCount = 0
  private releasedCount = 0
  private rejectedCount = 0
  private lastRejection: SpawnRecordOutcome | null = null
  private evictedExpired = 0
  private evictedCapacity = 0
  private snapshotFailures = 0

  constructor(options: SpawnLedgerOptions = {}) {
    this.clock = options.now ?? Date.now
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && (options.maxEntries as number) > 0
      ? (options.maxEntries as number)
      : MAX_TRACKED_SPAWNS
    this.ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs as number) > 0
      ? (options.ttlMs as number)
      : SPAWN_ENTRY_TTL_MS
  }

  /**
   * Claim a pid as ours.
   *
   * Both arguments are `unknown` on purpose. `ProviderProcessMetadata.pid` is
   * optional (`pid?: number`, claude-bridge.ts:323), so `undefined` reaches
   * here at runtime on any provider path that does not report one, and the
   * compiler is not the thing standing between that and a forged claim.
   *
   * `startMs` MUST be `processStartMs(child.pid)` from occupancy-probes, NOT
   * `Date.now()` at the spawn call. Both are compared later against the KERNEL
   * start of the process, but only one of them matches it.
   *
   * Measured 2026-08-15, n=14 staggered across second boundaries:
   *   processStartMs(child.pid)  delta exactly 0ms (same truncated value both sides)
   *   Date.now() at spawn        delta 2ms to 992ms (uniform — it is the
   *                              one-second truncation of the kernel reading)
   *
   * `PROC_START_TOLERANCE_MS` is 1500, so `Date.now()` leaves ~508ms of headroom
   * for spawn latency. A `claude` CLI spawn under load exceeds that, and when it
   * does, every COS-spawned owner reads as a FOREIGN desktop process and the
   * thread is non-attachable forever — which looks exactly like a detector bug.
   * The probe costs 3-7ms, not the 45ms once assumed.
   *
   * Never throws: it runs inside the bridge's provider-start try block, where
   * an exception is treated as a provider start failure and kills the run.
   */
  record(pid: unknown, startMs: unknown): SpawnRecordOutcome {
    try {
      if (!isPlausiblePid(pid)) return this.reject('rejected_pid')
      // Our own pid is never a provider child. Accepting it would let the
      // server vouch for itself if it ever appeared in a provider registry.
      if (pid === process.pid) return this.reject('rejected_self_pid')
      if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs <= 0) {
        return this.reject('rejected_start')
      }

      const now = this.clock()
      if (!Number.isFinite(now)) return this.reject('rejected_internal')
      const age = now - startMs
      // Too old: describes a process that was already running, which is the
      // shape of the user's desktop app rather than the child we just made.
      // Too far ahead: a clock that cannot be reconciled with a kernel start.
      if (age > MAX_SPAWN_START_AGE_MS || age < -MAX_SPAWN_START_SKEW_MS) {
        return this.reject('rejected_start_not_recent')
      }

      // Delete first so an overwrite of a live key cannot trigger a capacity
      // eviction, and so the entry re-enters at the end of iteration order.
      // Overwrite is correct: one pid cannot name two live processes, so a
      // pre-existing entry for this pid is by definition stale.
      this.entries.delete(pid)
      this.prune(now)
      this.evictToCapacity()
      this.entries.set(pid, { startMs, recordedAt: now })
      this.recordedCount++
      return 'recorded'
    } catch {
      return this.reject('rejected_internal')
    }
  }

  /**
   * Give up the claim, normally when the child exits.
   *
   * Deletion is always the safe direction, so this validates nothing and
   * swallows nothing — an unknown pid is simply `false`.
   */
  release(pid: unknown): boolean {
    if (typeof pid !== 'number') return false
    const had = this.entries.delete(pid)
    if (had) this.releasedCount++
    return had
  }

  /**
   * pid -> process start, epoch ms. The `OccupancyProbes.cosSpawnedPids` shape.
   *
   * Returns a fresh Map every call: the occupancy detector holds it for the
   * duration of a scan, and a live view could change under it mid-scan.
   *
   * Never throws. The caller wraps it anyway (`threadOccupancy` turns a
   * throwing probe into `probe_failed`), and that wrapping is the reason this
   * must not rely on it: `probe_failed` is a scan-wide verdict, so one bad
   * clock read here would suppress the Claude registry evidence too. Returning
   * an empty ledger keeps the rest of the scan intact and still denies every
   * self-ownership claim.
   */
  snapshot(): ReadonlyMap<number, number> {
    try {
      this.prune(this.clock())
      const out = new Map<number, number>()
      for (const [pid, entry] of this.entries) out.set(pid, entry.startMs)
      return out
    } catch {
      this.snapshotFailures++
      return new Map<number, number>()
    }
  }

  /** Diagnostics only. Never feed this back into an attach decision. */
  stats(): SpawnLedgerStats {
    let tracked = this.entries.size
    try {
      this.prune(this.clock())
      tracked = this.entries.size
    } catch {
      this.snapshotFailures++
    }
    return {
      tracked,
      recorded: this.recordedCount,
      released: this.releasedCount,
      rejected: this.rejectedCount,
      lastRejection: this.lastRejection,
      evictedExpired: this.evictedExpired,
      evictedCapacity: this.evictedCapacity,
      snapshotFailures: this.snapshotFailures,
    }
  }

  /** Drop every claim. Used by tests and by a deliberate "we own nothing" reset. */
  clear(): void {
    this.entries.clear()
  }

  private reject(outcome: SpawnRecordOutcome): SpawnRecordOutcome {
    this.rejectedCount++
    this.lastRejection = outcome
    return outcome
  }

  private prune(now: number): void {
    for (const [pid, entry] of this.entries) {
      const age = now - entry.recordedAt
      // A NEGATIVE age means the clock moved backwards, so the entry's age is
      // unknowable. Unknowable resolves to expired, like every other unknown
      // in this file — the alternative is an entry that outlives its bound by
      // however far the clock jumped.
      if (age >= this.ttlMs || age < 0) {
        this.entries.delete(pid)
        this.evictedExpired++
      }
    }
  }

  private evictToCapacity(): void {
    while (this.entries.size >= this.maxEntries) {
      let oldestPid: number | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [pid, entry] of this.entries) {
        if (entry.recordedAt < oldestAt) {
          oldestAt = entry.recordedAt
          oldestPid = pid
        }
      }
      if (oldestPid === null) return
      this.entries.delete(oldestPid)
      this.evictedCapacity++
    }
  }
}

/** Process-wide ledger. One server, one set of children. */
export const cosSpawnLedger = new CosSpawnLedger()

/** Record a provider child COS just spawned. See `CosSpawnLedger.record`. */
export function recordCosSpawn(pid: unknown, startMs: unknown): SpawnRecordOutcome {
  return cosSpawnLedger.record(pid, startMs)
}

/** Release a provider child that has exited. */
export function releaseCosSpawn(pid: unknown): boolean {
  return cosSpawnLedger.release(pid)
}

/**
 * The `OccupancyProbes.cosSpawnedPids` implementation. Named to match the probe
 * field so wiring is `{ cosSpawnedPids }` with nothing in between to get wrong.
 */
export function cosSpawnedPids(): ReadonlyMap<number, number> {
  return cosSpawnLedger.snapshot()
}
