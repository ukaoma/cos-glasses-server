/**
 * Spawning one COS pipeline command and reading its single result line (6.47.0, WS4).
 *
 * GENERALIZED FROM `g2-enrichment-runner.ts`, which stays exactly as it is. That runner
 * bakes in one command (`--g2-file`), one prefix (`COS_G2_RESULT=`), one retry ladder and
 * one outcome shape. The merge apply needs a different command, a different prefix, a much
 * tighter wall and a retry decision made by the caller from the EXIT CODE, so the shape is
 * lifted here rather than bent there.
 *
 * NO SERVER-SIDE LOCK AROUND THE SPAWN (v3 blocker 1). The child takes the pipeline's own
 * lock with zero retries and exits 3 within a second when another pipeline process holds
 * it. A server-side lock around a child that also locks is how a 75 s spawn becomes a
 * deadlock that outlives COS Control's 90 s drain timeout.
 *
 * STREAMED STDOUT. A long apply prints progress, and a caller that only sees the output
 * after the child exits cannot say what step it died in. Lines are handed over as they
 * arrive; only a bounded tail is kept for diagnostics.
 *
 * EXPLICIT ENVIRONMENT. The caller passes the whole env. The server runs from a
 * LaunchAgent whose PATH does not include Homebrew, and `PYTHON_BIN` resolving its own
 * helpers depends on it, so `pipelinePath()` is the one helper here that reaches into
 * `process.env`.
 */

import { spawn } from 'node:child_process'

/** The apply wall. Under COS Control's 90 s drain limit, with room for the kill grace. */
export const PIPELINE_DEFAULT_TIMEOUT_MS = 75_000

/** SIGTERM, then this long, then SIGKILL. */
export const PIPELINE_DEFAULT_KILL_GRACE_MS = 2_000

/** Diagnostics tail kept per stream. */
export const PIPELINE_MAX_CAPTURE_CHARS = 64 * 1024

export interface PipelineSpawnOptions {
  pythonBin: string
  /** Absolute path to the script, passed as the first argument. */
  script: string
  args: readonly string[]
  cwd: string
  /** The complete child environment. Nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv
  /** Lines starting with this are collected as result lines. */
  resultPrefix: string
  timeoutMs?: number
  killGraceMs?: number
  /** Every complete stdout line, as it arrives. */
  onLine?: (line: string) => void
  maxCaptureChars?: number
}

export interface PipelineAttempt {
  /** Null when the child never ran, or was killed by a signal. */
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** Bounded tail. */
  stdout: string
  stderr: string
  /** Every stdout line that started with `resultPrefix`, in order, prefix removed. */
  resultLines: string[]
  /** Set when the child could not be spawned at all. */
  spawnError?: string
  elapsedMs: number
}

export interface PipelineRunnerDependencies {
  /** Injected by tests so the result-line and exit-code contract can be exercised
   *  without a Python interpreter. */
  run?: (options: PipelineSpawnOptions) => Promise<PipelineAttempt>
}

/**
 * PATH for a pipeline child.
 *
 * A Finder- or launchd-started server does NOT inherit a login shell's PATH, and the COS
 * venv's python resolves `git`, `node` and its own helpers through it. Prepending rather
 * than replacing keeps a developer's own PATH intact.
 */
export function pipelinePath(basePath: string | undefined = process.env.PATH): string {
  const base = basePath ?? ''
  return base.split(':').includes('/opt/homebrew/bin') ? base : `/opt/homebrew/bin:${base}`
}

function appendBounded(current: string, chunk: string, max: number): string {
  const next = current + chunk
  return next.length <= max ? next : next.slice(-max)
}

/**
 * Kill the child's whole process group where the platform has one.
 *
 * sync_meetings.py spawns its own children. Signalling only the direct child leaves those
 * running and holding the pipeline lock, which is the failure the timeout exists to end.
 */
function signalChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal)
      return
    }
  } catch {
    // The group is gone, or was never created. Fall through to the direct child.
  }
  try { child.kill(signal) } catch { /* already dead */ }
}

/** Spawn one pipeline command and resolve with what it printed and how it ended. */
export async function runPipelineCommand(options: PipelineSpawnOptions): Promise<PipelineAttempt> {
  const startedAt = Date.now()
  const maxCapture = options.maxCaptureChars ?? PIPELINE_MAX_CAPTURE_CHARS
  const timeoutMs = options.timeoutMs ?? PIPELINE_DEFAULT_TIMEOUT_MS
  const killGraceMs = Math.max(25, options.killGraceMs ?? PIPELINE_DEFAULT_KILL_GRACE_MS)

  return await new Promise<PipelineAttempt>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(options.pythonBin, [options.script, ...options.args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        resultLines: [],
        spawnError: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let pending = ''
    const resultLines: string[] = []
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const takeLine = (line: string): void => {
      if (line.startsWith(options.resultPrefix)) resultLines.push(line.slice(options.resultPrefix.length))
      options.onLine?.(line)
    }

    const finish = (attempt: Omit<PipelineAttempt, 'elapsedMs'>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      // A final line with no trailing newline is still a line.
      if (pending.trim() !== '') takeLine(pending.trim())
      pending = ''
      resolve({ ...attempt, resultLines, elapsedMs: Date.now() - startedAt })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = appendBounded(stdout, text, maxCapture)
      pending += text
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line !== '') takeLine(line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString(), maxCapture) })

    child.on('error', error => finish({
      code: null,
      signal: null,
      timedOut,
      stdout,
      stderr,
      resultLines,
      spawnError: error.message,
    }))
    child.on('close', (code, signal) => finish({ code, signal, timedOut, stdout, stderr, resultLines }))

    timer = setTimeout(() => {
      timedOut = true
      signalChildTree(child, 'SIGTERM')
      killTimer = setTimeout(() => signalChildTree(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
  })
}

export type ResultLineFailure = 'missing' | 'malformed' | 'duplicated'

export type ResultLineOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ResultLineFailure }

/**
 * Read the one result line a pipeline command is contracted to print.
 *
 * THREE DISTINCT FAILURES, not one. A command that printed nothing died before its report;
 * a command that printed two reported twice and neither can be trusted as the outcome; a
 * command that printed something unparseable has changed its contract. All three are
 * `result_unreadable` to the caller, but they are different bugs and the reason says which.
 */
export function parseResultLine<T>(
  resultLines: readonly string[],
  validate: (value: unknown) => value is T,
): ResultLineOutcome<T> {
  if (resultLines.length === 0) return { ok: false, reason: 'missing' }
  if (resultLines.length > 1) return { ok: false, reason: 'duplicated' }
  let parsed: unknown
  try {
    parsed = JSON.parse(resultLines[0])
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!validate(parsed)) return { ok: false, reason: 'malformed' }
  return { ok: true, value: parsed }
}
