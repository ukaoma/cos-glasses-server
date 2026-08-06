import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const G2_RESULT_PREFIX = 'COS_G2_RESULT='

export interface G2EnrichmentOutcome {
  status: 'claimed' | 'retained' | 'enriched' | 'already-enriched' | 'blended'
  path: string
  title: string
}

export interface G2EnrichmentAttempt {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

export interface G2EnrichmentRunResult {
  ok: boolean
  attempts: number
  outcome?: G2EnrichmentOutcome
  error?: string
}

export interface G2EnrichmentOptions {
  pythonBin: string
  syncScript: string
  scriptsDir: string
  meetingFile: string
  env: NodeJS.ProcessEnv
  retryDelaysMs?: readonly number[]
  timeoutMs?: number
  killGraceMs?: number
  onAttempt?: (message: string) => void
  claimOnly?: boolean
  importLocal?: boolean
}

export interface G2EnrichmentDependencies {
  runAttempt?: (options: G2EnrichmentOptions) => Promise<G2EnrichmentAttempt>
  sleep?: (ms: number) => Promise<void>
  fileExists?: (path: string) => boolean
}

const MAX_CAPTURE_CHARS = 64 * 1024

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS)
}

export function parseG2EnrichmentOutcome(stdout: string): G2EnrichmentOutcome | null {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (!line.startsWith(G2_RESULT_PREFIX)) continue
    try {
      const parsed = JSON.parse(line.slice(G2_RESULT_PREFIX.length)) as Partial<G2EnrichmentOutcome>
      if (
        (parsed.status === 'claimed' || parsed.status === 'retained' || parsed.status === 'enriched' || parsed.status === 'already-enriched' || parsed.status === 'blended')
        && typeof parsed.path === 'string'
        && parsed.path.length > 0
        && typeof parsed.title === 'string'
        && parsed.title.length > 0
      ) {
        return parsed as G2EnrichmentOutcome
      }
    } catch {
      return null
    }
  }
  return null
}

export function buildExactG2SyncArgs(
  syncScript: string,
  meetingFile: string,
  claimOnly = false,
  importLocal = false,
): string[] {
  return [
    syncScript,
    '--g2-only',
    importLocal ? '--g2-import-file' : '--g2-file', meetingFile,
    ...(claimOnly ? ['--g2-claim-only'] : []),
    '--quiet',
  ]
}

function signalChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal)
      return true
    }
  } catch { /* fall back to the direct child */ }
  return child.kill(signal)
}

export async function spawnG2SyncAttempt(options: G2EnrichmentOptions): Promise<G2EnrichmentAttempt> {
  return await new Promise(resolve => {
    const child = spawn(
      options.pythonBin,
      buildExactG2SyncArgs(
        options.syncScript,
        options.meetingFile,
        options.claimOnly,
        options.importLocal,
      ),
      {
        cwd: options.scriptsDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env,
        detached: process.platform !== 'win32',
      },
    )

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (attempt: G2EnrichmentAttempt): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve(attempt)
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk) })
    child.on('error', error => finish({ code: null, stdout, stderr, error: error.message }))
    child.on('close', code => finish(timedOut
      ? { code, stdout, stderr, error: `exact G2 sync timed out after ${options.timeoutMs ?? 600_000}ms` }
      : { code, stdout, stderr }))

    timeout = setTimeout(() => {
      timedOut = true
      signalChildTree(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        signalChildTree(child, 'SIGKILL')
      }, Math.max(25, options.killGraceMs ?? 2_000))
    }, options.timeoutMs ?? 600_000)
  })
}

function attemptError(attempt: G2EnrichmentAttempt): string {
  if (attempt.error) return attempt.error
  const detail = attempt.stderr.trim() || attempt.stdout.trim()
  if (attempt.code !== 0) return `exit ${attempt.code}${detail ? `: ${detail.slice(-500)}` : ''}`
  return `exit 0 without verified ${G2_RESULT_PREFIX} outcome${detail ? `: ${detail.slice(-500)}` : ''}`
}

/**
 * Run one exact-file enrichment job with bounded retries. This executes in the
 * Mac server process, not the Even Hub WebView, so it cannot touch SDK timers
 * or the proven meeting-capture path.
 */
export async function runG2EnrichmentWithRetry(
  options: G2EnrichmentOptions,
  dependencies: G2EnrichmentDependencies = {},
): Promise<G2EnrichmentRunResult> {
  const retryDelaysMs = options.retryDelaysMs?.length
    ? [...options.retryDelaysMs]
    : [0, 15_000, 60_000]
  const runAttempt = dependencies.runAttempt ?? spawnG2SyncAttempt
  const sleep = dependencies.sleep ?? (async (ms: number) => await new Promise<void>(resolve => setTimeout(resolve, ms)))
  const fileExists = dependencies.fileExists ?? existsSync
  let lastError = 'exact G2 sync did not run'

  for (let index = 0; index < retryDelaysMs.length; index++) {
    const delayMs = Math.max(0, retryDelaysMs[index] ?? 0)
    if (delayMs > 0) {
      options.onAttempt?.(`retry ${index + 1}/${retryDelaysMs.length} in ${Math.round(delayMs / 1000)}s`)
      await sleep(delayMs)
    }

    options.onAttempt?.(`attempt ${index + 1}/${retryDelaysMs.length}`)
    const attempt = await runAttempt(options)
    const outcome = attempt.code === 0 ? parseG2EnrichmentOutcome(attempt.stdout) : null
    if (outcome && isAbsolute(outcome.path) && fileExists(outcome.path)) {
      return { ok: true, attempts: index + 1, outcome }
    }
    lastError = outcome
      ? `verified sentinel points to missing or non-absolute path: ${outcome.path}`
      : attemptError(attempt)
    options.onAttempt?.(`attempt ${index + 1} failed: ${lastError.slice(0, 500)}`)
  }

  return { ok: false, attempts: retryDelaysMs.length, error: lastError }
}
