// Is any child COS spawned for a fenced turn STILL RUNNING?
//
// WHAT THIS IS NOT. It is not a safety verdict and it must never be presented as
// one. Two plans for an automatic fence resolver were designed and both rejected
// (thread-fence-store.ts:40), and the reasoning still holds: the dominant fence
// shape is `timeout`, where the child had a ~21 minute budget to run tool calls
// before SIGKILL, and nothing observable afterwards distinguishes "the turn landed"
// from "it did not". This module answers a narrower question that IS mechanically
// knowable, and leaves delivery to the person.
//
// WHY THE NARROW QUESTION IS WORTH ANSWERING. A still-running child is the one way
// releasing a fence is unsafe for a reason a machine can see: admit a new turn while
// an old child is still writing and two writers interleave in one transcript.
// Everything else about a fence is judgement.
//
// PID ALONE IS NOT AN IDENTITY. `spawns` records a MEASURED start for each pid
// precisely because the OS recycles pids; a live pid whose start time does not match
// is a different process and says nothing about ours. FenceRecord's own comment says
// so, and this module is where that warning is enforced rather than repeated.
//
// EMPTY IS NOT ABSENCE. An empty or missing `spawns` list means no child was ever
// RECORDED, which is not the same as no child having run -- FenceRecord says no
// resolver may read it as "nothing landed". It resolves to `unknown`, never to
// `none_running`.
//
// FAIL CLOSED. Anything unmeasurable resolves toward `unknown`. The caller is a
// human deciding whether to release; an over-confident `none_running` is worse than
// admitting the probe could not see.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Recorded spawn: a pid and the start COS measured when it created the child. */
export interface RecordedSpawn {
  pid: number
  startMs: number
}

export type FenceLivenessState =
  /** Every recorded child is provably gone. */
  | 'none_running'
  /** At least one recorded child is alive AND is identity-matched to ours. */
  | 'running'
  /** Nothing was recorded, or at least one probe could not answer. */
  | 'unknown'

export interface FenceLiveness {
  state: FenceLivenessState
  /** Spawns examined. Zero means nothing was recorded. */
  recorded: number
  /** Alive and identity-matched: the reason a release is mechanically unsafe. */
  running: number
  /** Alive but started too far from the recorded time -- a RECYCLED pid, not ours.
   *  Counted, never treated as ours, and never treated as evidence about our child. */
  recycled: number
  /** Probes that threw or returned something unusable. */
  unverifiable: number
}

export interface FenceLivenessDeps {
  /** Epoch ms at which `pid` started, or null ONLY when it is provably not running.
   *  MAY THROW; a throwing probe is not an answer and resolves to `unknown`. */
  pidStartMs: (pid: number) => number | null
}

/**
 * Clock skew between COS's own `Date.now()` at spawn time and the start `ps`
 * reports, which has one-second resolution. Two seconds is comfortably wider than
 * that rounding and far narrower than any realistic pid-recycling window.
 */
export const START_MATCH_TOLERANCE_MS = 2_000

export function fenceLiveness(
  spawns: ReadonlyArray<RecordedSpawn> | undefined | null,
  deps: FenceLivenessDeps,
  toleranceMs: number = START_MATCH_TOLERANCE_MS,
): FenceLiveness {
  const rows = Array.isArray(spawns) ? spawns : []
  const out: FenceLiveness = {
    state: 'unknown', recorded: rows.length, running: 0, recycled: 0, unverifiable: 0,
  }

  // Nothing recorded. NOT 'none_running' -- see the header.
  if (rows.length === 0) return out

  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0
      || !Number.isFinite(row.startMs)) {
      out.unverifiable += 1
      continue
    }
    let started: number | null
    try {
      started = deps.pidStartMs(row.pid)
    } catch {
      out.unverifiable += 1
      continue
    }
    if (started === null) continue          // gone: the ordinary, good case
    if (!Number.isFinite(started)) { out.unverifiable += 1; continue }
    if (Math.abs(started - row.startMs) <= toleranceMs) out.running += 1
    else out.recycled += 1                  // someone else's process wearing our pid
  }

  // A live child outranks an unreadable probe: it is the one thing we are sure of.
  if (out.running > 0) out.state = 'running'
  else if (out.unverifiable > 0) out.state = 'unknown'
  else out.state = 'none_running'
  return out
}

/** Real probe. `ps -o lstart=` is the only start-time keyword macOS ps offers --
 *  `etimes` is not a valid keyword here, which is why this parses a date rather
 *  than reading elapsed seconds. */
export function makePidStartProbe(
  run: (pid: number) => string | null,
): (pid: number) => number | null {
  return (pid: number) => {
    const raw = run(pid)
    if (raw === null) return null
    const text = raw.trim()
    // A clean exit that printed nothing is not "not running" (only the runner's null is):
    // throw, so it is counted unverifiable.
    if (!text) throw new Error('empty process start from ps')
    const parsed = Date.parse(text)
    // Unparseable is NOT "not running" -- throw so the caller counts it
    // unverifiable rather than silently reading a live child as gone.
    if (!Number.isFinite(parsed)) throw new Error(`unparseable process start: ${text}`)
    return parsed
  }
}

/** What this module reads off the error `execFileSync` throws. */
export interface ExecFailureLike {
  status?: unknown
  signal?: unknown
  killed?: unknown
  code?: unknown
  error?: unknown
  stdout?: unknown
  stderr?: unknown
}

/** The slice of `execFileSync` the probe calls. Injectable so a test can throw every error
 *  shape Node produces without spawning anything. */
export type PsExec = (file: string, args: readonly string[], options: { encoding: 'utf8'; timeout: number }) => string

/** How long one `ps` may take before Node kills it (the kill is NOT an answer). */
export const PS_PROBE_TIMEOUT_MS = 2_000

const PS_BIN = existsSync('/bin/ps') ? '/bin/ps' : 'ps'

const emptyOutput = (value: unknown): boolean =>
  (typeof value === 'string' && value.trim() === '') || (Buffer.isBuffer(value) && value.length === 0)

/**
 * 6.53.3 /qa BLOCKER: is this `execFileSync` failure `ps -p` saying "no such process"?
 *
 * THE ONE ANSWER THAT MEANS GONE. `ps -p <pid>` for a pid that is not running exits 1 on its
 * own and prints nothing on either stream (measured, macOS 26 and node 24: `{status: 1,
 * signal: null, stdout: '', stderr: ''}` with no `code` and no `error`). Everything else is
 * ps failing to answer, and says nothing about the child: a kill at the timeout (`ETIMEDOUT`,
 * SIGTERM), a fork that failed (`EAGAIN`), no binary (`ENOENT`), a signal, output on stdout or
 * a complaint on stderr, any other status. Until 6.53.3's QA every one of those read as gone,
 * and gone is `none_running`, which releases a cancel fence (`releaseSettledCancelFences`) on a
 * child that may still be writing.
 */
export function psSaysNoSuchProcess(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const e = error as ExecFailureLike
  return e.status === 1
    && (e.signal === null || e.signal === undefined)
    && e.killed !== true
    && (e.code === null || e.code === undefined)
    && (e.error === null || e.error === undefined)
    && emptyOutput(e.stdout)
    && emptyOutput(e.stderr)
}

/**
 * The production runner: `ps -p <pid> -o lstart=`'s stdout, or null ONLY when ps said the
 * process does not exist (`psSaysNoSuchProcess`). Any other failure THROWS, which
 * `fenceLiveness` counts unverifiable, so the fence stays.
 */
export function psLstartRunner(exec: PsExec = execFileSync as unknown as PsExec): (pid: number) => string | null {
  return (pid: number) => {
    try {
      return exec(PS_BIN, ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: PS_PROBE_TIMEOUT_MS })
    } catch (error) {
      if (psSaysNoSuchProcess(error)) return null
      const e = (error ?? {}) as ExecFailureLike
      throw new Error(`ps could not answer for pid ${pid} (status=${String(e.status ?? null)} signal=${String(e.signal ?? null)} code=${String(e.code ?? 'none')})`)
    }
  }
}

/** The probe the fence routes use in production. */
export function defaultPidStartProbe(exec?: PsExec): (pid: number) => number | null {
  return makePidStartProbe(psLstartRunner(exec))
}
