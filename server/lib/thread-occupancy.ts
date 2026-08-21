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
  // A foreign holder that is DEMONSTRABLY generating right now, as opposed to
  // merely holding the thread open. Separate from `live_desktop_process` because
  // the two ask the user for different things: this one clears by itself in
  // seconds and is worth waiting out, the other needs a window closed. Only
  // reachable when a transcript clock is wired — see THE IDLE-HOLDER RELAXATION below.
  | 'native_thread_working'
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
  /**
   * This verdict is attachable DESPITE a foreign owner, because that owner was
   * measured idle. See THE IDLE-HOLDER RELAXATION below.
   *
   * It exists so the permissive outcome has to be DECLARED rather than inferred
   * from `attachable` alone. `projectAttachability` treats a foreign owner on an
   * attachable verdict as a contradiction and forces it back to refused; without
   * a positive marker, relaxing the gate would mean deleting that check, and the
   * check is what catches a future detector that flips `attachable` by accident.
   * With the marker, the only way to reach the permissive path is to say so.
   *
   * Absent (not false) on every other verdict, so `=== true` is the only test.
   */
  idleHolder?: true
}

/**
 * What a scan could not establish. Any non-null value forbids attaching, even
 * with zero owners — that is the whole point of the type.
 */
type Doubt = Exclude<
  OccupancyReason,
  'live_desktop_process' | 'native_thread_working' | 'unsupported_provider' | 'invalid_thread_id'
> | null

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
  /**
   * Transcript write time for this thread, epoch ms, or null when it cannot be
   * read. OPTIONAL, and its ABSENCE is the default.
   *
   * Absent means this install has no clock on the thread, which means every
   * foreign holder stays `live_desktop_process` — byte-for-byte the behaviour
   * that shipped before the idle-holder relaxation existed. That is why it is
   * optional rather than required: the strict gate is what you get by doing
   * nothing, and the relaxation is wired on purpose by `buildOccupancyProbes`
   * in `occupancy-probes.ts`, which attaches the clock only when thread attach
   * itself is on.
   *
   * Null is NOT idle. See `holderActivity` for why that distinction is the whole
   * safety property here.
   */
  transcriptMtimeMs?: (provider: OccupancyProvider, threadId: string) => number | null
  /**
   * Cursor Agent CLI session at `~/.cursor/chats/<hash>/<id>/`, or null when
   * that id is not exactly one continuable chats dir. Occupancy MUST NOT import
   * fs; this is the only Cursor evidence this detector is allowed to see.
   */
  cursorAgentSession?: (threadId: string, chatsDir: string) => {
    dir: string
    cwd: string
    hasConversation: boolean
  } | null
}

/**
 * How recently the transcript must have been written for a held thread to read
 * as WORKING rather than merely OPEN.
 *
 * WHY A SECOND SIGNAL EXISTS AT ALL. `owners` answers "a process holds this
 * thread", which is not the question the user is asking. He watched a session
 * finish on his Mac while the glasses still showed it active, because the window
 * was still open and the registry record therefore still existed. Occupancy has
 * no clock in it; the transcript does.
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
 *
 * LIVES HERE, not in `occupied-threads.ts`, since 6.32.0. The display hint and
 * the write gate must agree on what "recently" means, and the gate is the lower
 * module of the two. `occupied-threads.ts` re-exports it, so every existing
 * importer is unaffected.
 */
export const ACTIVE_RECENTLY_WINDOW_MS = 30_000

/**
 * Was this transcript written inside the window?
 *
 * NULL IS NOT "RECENT". An unresolvable path, an unreadable file, a stat that
 * threw — every one of them arrives here as null and answers false, so the row
 * falls back to OPEN. That is not a fail-open FOR A DISPLAY HINT: OPEN is still
 * a true statement about a thread with a live owner. It is the STRONGER claim,
 * "an agent is working in here", that has to be earned by an actual observation.
 *
 * A timestamp far in the FUTURE is refused for the same reason rather than
 * treated as maximally fresh. Skew of a few seconds is normal and lands inside
 * the window; a file dated next week is a clock this server cannot reason about,
 * and letting it manufacture a permanent "working" badge would rebuild the bug
 * from the other direction.
 *
 * DO NOT CALL THIS FROM A WRITE GATE. Its false has two meanings — "measured,
 * and stale" and "could not measure" — and a gate that treats the second as the
 * first is fail-open. `holderActivity` is the gate-side reading.
 */
export function isActiveRecently(mtimeMs: number | null | undefined, nowMs: number): boolean {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false
  if (!Number.isFinite(nowMs)) return false
  return Math.abs(nowMs - mtimeMs) <= ACTIVE_RECENTLY_WINDOW_MS
}

/**
 * What a foreign holder is doing, for a caller that must DECIDE rather than
 * render.
 *
 * THREE VALUES, AND THE THIRD IS THE POINT. `isActiveRecently` collapses "I
 * measured a stale file" and "I could not measure anything" into the same
 * `false`, which is correct for a badge — the weaker claim, OPEN, is true either
 * way — and catastrophic for a gate, where that same `false` would mean ALLOW
 * THE WRITE. Same reading, opposite polarity, so the gate gets its own function
 * instead of reusing the hint's boolean.
 *
 * Only `idle` is a positive observation of an idle holder: a real number, not in
 * the future, measured outside the window. Everything else is `unknown` and
 * refuses. This is the same "no owner found is not no owner" rule the rest of
 * this module runs on, applied to the clock instead of the registry.
 *
 * The window itself is NOT redefined here — `isActiveRecently` decides what
 * recent means, so the badge and the gate can never drift apart on it.
 */
export type HolderActivity = 'working' | 'idle' | 'unknown'

export function holderActivity(mtimeMs: number | null | undefined, nowMs: number): HolderActivity {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return 'unknown'
  if (!Number.isFinite(nowMs)) return 'unknown'
  // A future-dated transcript is a clock this server cannot reason about. The
  // hint may treat a few seconds of skew as freshness; the gate may not treat
  // ANY amount of it as idleness, because "stale" is the permissive answer here
  // and a wrong clock would hand it out forever.
  if (mtimeMs > nowMs + ACTIVE_RECENTLY_WINDOW_MS) return 'unknown'
  return isActiveRecently(mtimeMs, nowMs) ? 'working' : 'idle'
}

/**
 * Read the transcript clock for a thread, refusing to guess.
 *
 * A probe that is absent, throws, or answers null all land on `unknown`, which
 * refuses. There is no path from a failed reading to a permissive verdict.
 */
function readHolderActivity(
  provider: OccupancyProvider,
  threadId: string,
  probes: OccupancyProbes,
  nowMs: number,
): HolderActivity {
  if (typeof probes.transcriptMtimeMs !== 'function') return 'unknown'
  try {
    return holderActivity(probes.transcriptMtimeMs(provider, threadId), nowMs)
  } catch {
    return 'unknown'
  }
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
  /** `<COS_AGENT_SESSIONS_HOME|~>/.cursor/chats` */
  cursorChatsDir: string
}

// ===========================================================================
// THE IDLE-HOLDER RELAXATION (6.32.0)
// ===========================================================================
//
// This loosens a guard that was deliberate. Read this before touching it, and
// do not widen it further without repeating the experiment.
//
// WHAT CHANGED. A foreign owner used to be terminal on its own. It is now
// terminal only while that owner is DEMONSTRABLY WRITING. A holder measured
// idle — registry record alive, transcript stale — is continuable.
//
// WHY THE OLD RULE WAS WRONG. The registry records an OPEN WINDOW, not active
// generation. `~/.claude/sessions/<pid>.json` for a session that finished ten
// minutes ago is byte-identical to one mid-turn. Miles keeps Claude Code
// windows open, so Continue was refused for exactly the threads he cares about
// and allowed only for the ones he had abandoned. The gate was measuring the
// wrong thing, not measuring it too strictly.
//
// THE CANARY, run 2026-08-16 against a real interactive `claude` 2.1.229 held
// open in tmux (pid 48446, `kind: interactive`, `entrypoint: claude-desktop`,
// indistinguishable from a desktop window) in a scratch workspace. Turns were
// injected with the EXACT argv this server spawns. Raw findings:
//
//   1. DELIVERY WORKS. `claude -p --resume <id>` into an idle-held thread
//      exits 0 in ~5s and returns its result. Same session id, same file.
//   2. NO CORRUPTION. Across 6 injections and 6 desktop turns, including
//      three SDK writers landing within 45ms of each other on the same node,
//      the transcript stayed append-only: every prefix byte-identical before
//      and after (`cmp`), zero unparseable lines, zero dangling parentUuid.
//      Claude Code appends whole rows, so byte interleaving does not occur.
//   3. THE HOLDER IGNORES THE INJECTED TURN — this is the real finding. Its
//      in-memory view is stale and stays stale. Asked afterwards to list every
//      word it had been told to reply with, it answered "ALPHA": the injected
//      "BRAVO" was invisible to it.
//   4. NOTHING IS CLOBBERED, BUT THE THREAD FORKS. The holder's next turn
//      parented to the PRE-INJECTION tail, making the transcript a tree. Both
//      turns survive in full; they are on different branches, and from then on
//      each writer sees only its own. A later `--resume` read back
//      "ALPHA, BRAVO" and never saw the desktop's "CHARLIE".
//   5. THE WORKING CASE IS DIFFERENT AND STAYS BLOCKED. With the holder
//      generating, the transcript mtime was 6.2s old and `holderActivity`
//      returned `working`, so this relaxation does not fire there at all.
//
// SO THE ANSWER IS: no clobbering, no corruption, no data loss — but the two
// views diverge silently after the write, and neither side is told by THIS
// module. What makes that acceptable is the guard one layer up: `nativeHead`
// digests the transcript tail, and a desktop write CHANGES it (measured:
// nh1:faba1b35... -> nh1:ace93a1f...), so the next COS turn on that binding is
// refused with `native_thread_changed` and the user is offered refresh, continue
// anyway, or fork. Divergence is caught by the CONTENT watermark, which is the
// signal that can actually see it. Occupancy never could.
//
// WHAT THIS IS NOT A LICENCE FOR. Do not extend the same reasoning to the
// `doubt` reasons below: those mean the scan could not SEE, and an unreadable
// registry is not an idle holder. Do not relax the `working` branch on the
// grounds that "nothing got corrupted in the canary either" — case 5 was never
// run to completion precisely because it stays blocked. And do not reach for
// `isActiveRecently` here; its `false` means "stale OR unmeasurable", and only
// `holderActivity` separates those.
//
// TURNING IT OFF. Unwire `probes.transcriptMtimeMs`. Since 6.33.0 that happens
// by unsetting `COS_THREAD_ATTACH_ENABLED`, the one switch that also unregisters
// the write routes: the relaxation is what makes a silent fork possible, so it
// is the same decision as Continue itself and no longer has a flag of its own.
// Every foreign holder then reads `unknown` and refuses, which is the pre-6.32.0
// gate exactly, and with attach off there is no write route to reach anyway.

/**
 * The Phase 0 attach precondition.
 *
 * Returns attachable ONLY when a supported provider proved its detector exists,
 * read every candidate record, and found no owner it must respect. Every other
 * outcome names why. The whole function is wrapped: a throwing probe — including
 * the spawn ledger, which is the most safety-critical of them — is `probe_failed`,
 * never an exception escaping into a route.
 *
 * A foreign owner measured IDLE is the one exception, and it is marked
 * `idleHolder` on the way out. See THE IDLE-HOLDER RELAXATION above.
 */
export function threadOccupancy(
  provider: string,
  threadId: string,
  probes: OccupancyProbes,
  dirs: OccupancyDirs,
): Occupancy {
  if (provider === 'cursor') {
    if (!isValidNativeThreadId(threadId)) {
      return { attachable: false, owners: [], reason: 'invalid_thread_id' }
    }
    if (typeof probes.cursorAgentSession !== 'function' || typeof dirs.cursorChatsDir !== 'string') {
      return { attachable: false, owners: [], reason: 'probe_failed' }
    }
    let session: { dir: string; cwd: string; hasConversation: boolean } | null
    try {
      session = probes.cursorAgentSession(threadId, dirs.cursorChatsDir)
    } catch {
      return { attachable: false, owners: [], reason: 'probe_failed' }
    }
    if (!session || session.hasConversation !== true) {
      return { attachable: false, owners: [], reason: 'unsupported_provider' }
    }
    return { attachable: true, owners: [], reason: null }
  }
  if (provider !== 'claude' && provider !== 'codex') {
    // Anything unrecognised: an honest capability gap, not a failure.
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
    const activity = readHolderActivity(provider, threadId, probes, Date.now())
    if (activity !== 'idle') {
      return {
        attachable: false,
        owners: result.owners,
        reason: activity === 'working' ? 'native_thread_working' : 'live_desktop_process',
      }
    }
    // FALL THROUGH, deliberately. See THE IDLE-HOLDER RELAXATION below for why this is
    // safe and what it is NOT. Everything after this point still applies: a scan
    // that could not establish something still refuses on the next line.
  }
  if (result.doubt !== null) {
    return { attachable: false, owners: result.owners, reason: result.doubt }
  }
  if (foreign.length > 0) {
    return { attachable: true, owners: result.owners, reason: null, idleHolder: true }
  }
  return { attachable: true, owners: result.owners, reason: null }
}
