// The real filesystem and process probes behind the thread-occupancy detector.
//
// `OccupancyProbes` in thread-occupancy.ts had zero implementations, so the
// detector could not actually run against this machine. This file is the only
// place that touches the disk or spawns a process on its behalf.
//
// EVERY FUNCTION HERE RESOLVES DOUBT TOWARD "OCCUPIED". The detector's contract
// is that a null, a false, or a throw is treated as a reason to refuse — so the
// mistake this file must not make is converting an error into a benign-looking
// value. `readDir` returning [] on EACCES would read as "the registry is empty",
// which is the exact fail-open that shipped once already. It throws instead.
//
// FOUR THINGS MEASURED ON THIS MACHINE 2026-08-15, not assumed:
//
//  1. `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>` prints `Sun Aug 16 02:03:05 2026`
//     — the SAME string, to the second, that Claude Code writes into
//     `~/.claude/sessions/<pid>.json` as `procStart`. Verified against live pid
//     7872. That is why this file forces TZ rather than parsing localized output:
//     `ps` without TZ printed `Sat Aug 15 21:03:05 2026` for that same process,
//     and comparing THAT against the registry is the false PID-reuse bug the
//     detector's own header documents.
//  2. `ps -o etimes=` does not exist on macOS ("keyword not found"), so the
//     obvious non-localized alternative is unavailable here. Elapsed-seconds
//     arithmetic would also carry up to 2000ms of truncation error against a
//     1500ms tolerance, i.e. it would reject valid matches.
//  3. `lsof -t` has THREE distinct exit-1 shapes and they mean different things:
//       - file exists, nobody holds it -> exit 1, empty stdout, EMPTY stderr
//       - file absent                  -> exit 1, empty stdout, "status error ... No such file"
//       - parent dir unreadable        -> exit 1, empty stdout, "status error ... Permission denied"
//     The first two are "no holders". The third is a failed probe and MUST throw.
//     They are separated by an independent `lstat`, not by matching lsof's English.
//  4. `statSync` on a mode-000 directory still reports isDirectory() true, so
//     `dirExists` says the detector applies and `readDir` then throws EACCES.
//     That is the intended chain: detector_unavailable is for "no such install",
//     probe_failed is for "the mechanism exists and broke".

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { NATIVE_THREAD_ID_RE } from './native-thread-id.js'
import { parseProcStartUtcMs, type OccupancyDirs, type OccupancyProbes } from './thread-occupancy.js'

// Re-exported rather than reimplemented. `claudeSessionsDir` already encodes the
// COS_CLAUDE_SESSIONS_DIR -> CLAUDE_CONFIG_DIR -> ~/.claude precedence AND is the
// only test seam for a non-mockable `homedir()`. A second copy would drift the
// first time someone adds an override, and the two consumers would then disagree
// about which directory "empty" was observed in.
export { claudeSessionsDir } from '../routes/claude-sessions.js'
import { claudeSessionsDir } from '../routes/claude-sessions.js'

/**
 * `<CODEX_HOME|~/.codex>/thread-writer-locks`.
 *
 * CODEX_HOME is Codex's own variable, so it is both the real override and the
 * test seam; no COS-specific alias is invented here. An empty string is falsy
 * and correctly falls through to the default rather than resolving to cwd.
 */
export function codexLocksDir(): string {
  const home = process.env.CODEX_HOME
  return join(home ? resolve(home) : join(homedir(), '.codex'), 'thread-writer-locks')
}

export function realOccupancyDirs(): OccupancyDirs {
  return { claudeSessionsDir: claudeSessionsDir(), codexLocksDir: codexLocksDir() }
}

/** Absolute first, bare name as the fallback: a launchd/Finder-spawned server has no login PATH. */
const PS_BIN = existsSync('/bin/ps') ? '/bin/ps' : 'ps'
const LSOF_BIN = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'

/** Both probes sit in the interactive attach path. lsof can block for seconds on a stale mount. */
const PROBE_TIMEOUT_MS = 2_000
const PROBE_MAX_BUFFER = 1 << 20

/** A registry record is a few hundred bytes. Anything larger is not one. */
const MAX_RECORD_BYTES = 256 * 1024

/**
 * A process cannot have started after now. Only slack for the sub-second
 * truncation `ps` applies plus scheduling delay between the two readings.
 */
const FUTURE_START_SLACK_MS = 5_000

/** Sanity floor. A parse that lands before this is a misread, not a process. */
const EARLIEST_PLAUSIBLE_START_MS = Date.UTC(2000, 0, 1)

/** `process.kill` treats 0 as "this process group" and -1 as "broadcast". */
function isProbablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

type Presence = 'present' | 'absent' | 'unknown'

/**
 * Does this path exist, and if not, do we actually KNOW that?
 *
 * `existsSync` collapses "definitely not there" and "cannot see it" into the
 * same false, which is what makes it unsafe for interpreting an lsof failure:
 * a lock inside a directory we cannot traverse would read as absent.
 */
function presence(path: string): Presence {
  try {
    lstatSync(path)
    return 'present'
  } catch (error: any) {
    return error?.code === 'ENOENT' ? 'absent' : 'unknown'
  }
}

/**
 * Force a stable, non-localized rendering of the child's time and messages.
 *
 * TZ is the load-bearing one — see note 1 in the header. LC_ALL beats LC_TIME and
 * LANG, so the month abbreviation is always English. The rest of the environment
 * is inherited on purpose: stripping it (`env -i`) is a documented way to break
 * macOS subprocesses and then misread the breakage as the probe's answer.
 */
function probeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' }
}

export interface ProbeOutcome {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  /** True when the hard timeout fired. Never a normal result. */
  killed: boolean
  spawnError: string | null
}

function runProbe(bin: string, args: string[]): ProbeOutcome {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: PROBE_MAX_BUFFER,
      env: probeEnv(),
      // Explicit, so a child's stderr is captured for diagnosis instead of being
      // inherited onto the server's console.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout), stderr: '', status: 0, killed: false, spawnError: null }
  } catch (error: any) {
    // execFileSync sets `status: null` (DEFINED, not undefined) for ENOENT and
    // EACCES, so an `!== undefined` test is true for every error shape and
    // `spawnError` could never be non-null. Measured: missing binary -> code
    // ENOENT, status null, signal null; timeout -> signal 'SIGKILL'; exit 1 ->
    // status 1. Fail-closed was intact either way (both paths throw), but a
    // missing `lsof` reported as "lsof failed (status=null)" instead of naming
    // ENOENT, which is the difference between a five-minute and an hour-long
    // diagnosis.
    const spawned = typeof error?.status === 'number' || typeof error?.signal === 'string'
    return {
      ok: false,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
      status: typeof error?.status === 'number' ? error.status : null,
      killed: Boolean(error?.killed) || Boolean(error?.signal),
      // ENOENT/EACCES on the binary itself: the mechanism is missing, which is a
      // different failure from the mechanism running and reporting nothing.
      spawnError: spawned ? null : String(error?.code ?? error?.message ?? 'spawn failed'),
    }
  }
}

/**
 * Actual process start, epoch ms, or null when it cannot be established.
 *
 * Null is doubt, never "recently". The two callers both take the safe branch on
 * null: the Claude scan records `unverifiable_process_start`, and the self-owned
 * check refuses to credit the spawn ledger.
 */
export function processStartMs(pid: number): number | null {
  // Redundant with `ps`'s own argument checking on macOS ("Invalid process id:
  // -1", "process id too large"), kept so a nonsense pid never reaches a
  // subprocess argument at all. Named in knownGaps: no test distinguishes it,
  // because `ps` refuses the same inputs one layer down.
  if (!isProbablePid(pid)) return null
  const out = runProbe(PS_BIN, ['-o', 'lstart=', '-p', String(pid)])
  // A dead pid exits 1 with no output; a timeout or a missing `ps` also lands
  // here. All of them are "cannot determine", which is exactly what null means.
  if (!out.ok) return null
  return interpretPsLstart(out.stdout, Date.now())
}

/**
 * Turn `ps -o lstart=` output into epoch ms, or null.
 *
 * Separated from the spawn for the same reason as `interpretLockHolders`: the
 * readings that must be REFUSED — two lines, a start in the future, a pre-2000
 * epoch — cannot be produced by asking the real `ps` about a real process, so
 * inline they would be guards no test could ever reach.
 */
export function interpretPsLstart(stdout: string, now: number): number | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  // Exactly one process was requested. Two lines means the output is not what
  // this parser thinks it is, and guessing which line is right is how a wrong
  // start time becomes a forged identity.
  if (lines.length !== 1) return null

  const ms = parseProcStartUtcMs(lines[0])
  if (ms === null) return null
  // Catches a `ps` that ignored TZ in a positive-offset zone: the reading would
  // land hours in the future, which no real process start can be.
  if (ms > now + FUTURE_START_SLACK_MS) return null
  if (ms < EARLIEST_PLAUSIBLE_START_MS) return null
  return ms
}

/**
 * signal-0 liveness, matching `realProbes.isAlive` in routes/claude-sessions.ts.
 *
 * DELIBERATE, FLAGGED DIVERGENCE IN MEANING, NOT IN CODE. EPERM from `kill(pid,0)`
 * means the process EXISTS and belongs to another user. The presence list treats
 * that as "not ours, do not show it", which is right for a presence list. For a
 * safety gate the honest reading is the opposite: something is alive there.
 *
 * This matches the route anyway, because for THIS registry the two readings
 * coincide. `~/.claude/sessions` is mode 0700 in our own home, so every record in
 * it was written by a process running as us; a pid in it that we cannot signal is
 * a pid that has been RECYCLED by a foreign process, meaning the recorded Claude
 * process is dead and the record is stale. Returning false is then correct.
 *
 * The gap is real when that premise breaks: if COS_CLAUDE_SESSIONS_DIR is pointed
 * at another user's registry that we can somehow read, a live foreign owner
 * returns EPERM, is scored dead, contributes no doubt, and the thread can come
 * back attachable. Distinguishing it needs a third state the boolean cannot
 * carry, so it is named in knownGaps rather than papered over here.
 */
export function isAlive(pid: number): boolean {
  if (!isProbablePid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Existence only. Follows symlinks on purpose: a dangling link is not evidence of a live socket. */
export function fileExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** True only for a real directory. Unreadable, missing, or a plain file are all false. */
export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Entry names. THROWS on an unreadable directory — never [].
 *
 * An empty array here is indistinguishable from an empty registry, and the
 * detector's one attachable verdict requires exactly that observation. EACCES
 * must not be able to manufacture it.
 */
export function readDir(path: string): string[] {
  return readdirSync(path)
}

/**
 * File contents, or null when genuinely unreadable. The caller treats null as doubt.
 *
 * O_NOFOLLOW rather than lstat-then-read: routes/claude-sessions.ts uses lstat +
 * isFile, which is correct but leaves a window where the entry is swapped for a
 * symlink between the check and the read. Refusing to follow at open() time
 * closes it, and a symlinked `<pid>.json` — which could otherwise point at any
 * file on disk and be parsed as a session record — surfaces as ELOOP -> null ->
 * registry_unreadable.
 */
export function readFile(path: string): string | null {
  let fd: number | null = null
  try {
    // Belt: the lstat check works everywhere. Braces: O_NOFOLLOW closes the race
    // between the two, and is skipped rather than silently zeroed on a platform
    // that does not define it (`x | undefined` is `x`, which would drop the guard
    // without any error).
    if (lstatSync(path).isSymbolicLink()) return null
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    // O_NONBLOCK is load-bearing, not defensive tidiness. `openSync` on a FIFO
    // with no writer BLOCKS FOREVER, and it is a synchronous syscall on Node's
    // single thread — so one `mkfifo sessions/4242.json` wedges the ENTIRE
    // glasses server (health, meeting save, transcribe-stream, all of it), not
    // just this request. Express `requestTimeout` cannot interrupt a blocked
    // syscall, and the `isFile()` guard below runs AFTER the open, so it cannot
    // prevent this by itself. Verified 2026-08-15: without the flag the open
    // never returns (killed at 6s); with it the open completes in 0ms and
    // `isFile()` is false, so the FIFO is rejected by the guard that was always
    // meant to reject it. Reachable via COS_CLAUDE_SESSIONS_DIR / CLAUDE_CONFIG_DIR
    // pointing at any writable directory.
    const nonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlock)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    if (stat.size > MAX_RECORD_BYTES) return null
    return readFileSync(fd, 'utf-8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already gone */ }
    }
  }
}

/**
 * PIDs holding an open descriptor on a Codex writer lock.
 *
 * `[]` means the probe RAN and found nobody. Anything it could not establish
 * throws, so `threadOccupancy` reports probe_failed instead of attachable.
 *
 * The basename guard is defense in depth. `threadOccupancy` validates the thread
 * id before `codexLockPath` builds this path, but this function is the last stop
 * before a caller-influenced string reaches a process argument, and the repo's
 * other id validator (`SAFE_ID_RE`) permits `/` and `.`. If that validation is
 * ever dropped upstream, this refuses rather than probing an arbitrary path.
 */
export function lockHolders(path: string): number[] {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('lockHolders: refusing an unusable path')
  }
  const name = basename(path)
  if (!name.endsWith('.lock') || !NATIVE_THREAD_ID_RE.test(name.slice(0, -'.lock'.length))) {
    throw new Error('lockHolders: refusing a path that is not a <native-thread-id>.lock')
  }

  // `--` terminates option parsing so a path can never be read as a flag; `-w`
  // suppresses mount-point warnings that would otherwise make a successful probe
  // look like the failure case below.
  return interpretLockHolders(runProbe(LSOF_BIN, ['-w', '-t', '--', path]), path)
}

/**
 * Turn one lsof run into holders, or throw.
 *
 * Split out because the branches that matter most are the ones a real filesystem
 * will not produce on demand — a timeout, a missing `lsof`, garbage on stdout.
 * Leaving them untested is how "any failure means nobody is holding it" survives
 * a green suite, so they are exercised directly with synthesized outcomes while
 * the happy and permission-denied paths are still covered end to end.
 */
export function interpretLockHolders(out: ProbeOutcome, path: string): number[] {
  if (!out.ok) {
    if (out.spawnError !== null) {
      throw new Error(`lockHolders: lsof unavailable (${out.spawnError})`)
    }
    if (out.killed) {
      throw new Error('lockHolders: lsof timed out')
    }
    // Measured: exit 1 + empty stdout is lsof's "no matches". With EMPTY stderr
    // that is a clean no-holders result on a file that exists.
    if (out.status === 1 && out.stdout.trim() === '') {
      if (out.stderr.trim() === '') return []
      // Non-empty stderr is a "status error". Decide what it meant from our own
      // lstat, not from lsof's wording: absent means nobody can be holding it,
      // and anything else (Permission denied, unreadable mount) is a failed probe.
      if (presence(path) === 'absent') return []
      throw new Error(`lockHolders: lsof could not inspect the lock (${out.stderr.trim().slice(0, 160)})`)
    }
    throw new Error(`lockHolders: lsof failed (status=${out.status}) ${out.stderr.trim().slice(0, 160)}`)
  }

  const pids = new Set<number>()
  for (const token of out.stdout.split(/\s+/)) {
    if (token.length === 0) continue
    // Unrecognised output is not "no holders". Refuse the whole reading.
    if (!/^\d+$/.test(token)) {
      throw new Error('lockHolders: unrecognised lsof output')
    }
    const pid = Number(token)
    if (!isProbablePid(pid)) {
      throw new Error('lockHolders: lsof reported an implausible pid')
    }
    pids.add(pid)
  }
  return [...pids]
}

/** Supplies the pid -> process-start map that is the only route to a self-owned verdict. */
export type SpawnLedgerAccessor = () => ReadonlyMap<number, number>

/**
 * Copy the ledger into a Map we know the shape of.
 *
 * Self-ownership is the ONLY input that can turn a live owner into attachable, so
 * the accessor is treated as untrusted. A Map-LIKE object whose `get` returns a
 * matching start for every pid would grant self-ownership over an arbitrary
 * desktop process; `instanceof Map` is what makes that unrepresentable. Throwing
 * (rather than substituting an empty map) keeps "the ledger is broken" distinct
 * from "the ledger says none of these are ours" — the detector reports the first
 * as probe_failed.
 */
function sanitizeLedger(raw: unknown): ReadonlyMap<number, number> {
  if (!(raw instanceof Map)) {
    throw new Error('cosSpawnedPids: spawn ledger did not return a Map')
  }
  const clean = new Map<number, number>()
  for (const [pid, startedAt] of raw) {
    if (!isProbablePid(pid)) continue
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) continue
    clean.set(pid, startedAt)
  }
  return clean
}

/**
 * The production probe set.
 *
 * The spawn ledger is injected rather than imported so this stays testable and so
 * the detector cannot accidentally be wired to a ledger that does not exist yet.
 */
export function realOccupancyProbes(ledger: SpawnLedgerAccessor): OccupancyProbes {
  return {
    isAlive,
    processStartMs,
    fileExists,
    dirExists,
    readDir,
    readFile,
    lockHolders,
    cosSpawnedPids: () => sanitizeLedger(ledger()),
  }
}
