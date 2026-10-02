// One run of `fluidaudiocli nemotron3-diarize`: a WAV in, raw 10 ms speaker
// probabilities out.
//
// The probabilities, not the RTTM, are the output that matters. The canary found
// that the RTTM drops turns shorter than 0.2 s, so every consumer scores the raw
// [frames x 8] float32 matrix at 0.5, exactly as the canary did.
//
// No model call, no network: `--models` is always passed (see diarizer-backend.ts),
// and nothing here is an LLM. Transcription must never call `claude -p`.

import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { setPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEMOTRON_VARIANT } from './diarizer-backend.js'

export const NEMOTRON_CHANNELS = 8
export const NEMOTRON_FRAME_SEC = 0.01
/** Every temp directory this feature makes starts with this, so a sweep can find them. */
export const NEMOTRON_TMP_PREFIX = 'cos-nemotron-'

/**
 * The only variables the CLI is given (QA 6.61.0, Ghost Hunter N8). The server's
 * environment holds the API token, provider keys and the OpenAI key; a model
 * runner needs none of them. HOME is where CoreML keeps its compiled-model cache
 * and FluidAudio its models; TMPDIR is where CoreML compiles. Verified on
 * 2026-10-02: the real CLI runs warm from the local models with only these.
 */
export const NEMOTRON_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'] as const

export function nemotronChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of NEMOTRON_ENV_KEYS) if (typeof env[key] === 'string') out[key] = env[key]
  return out
}

// ── Children and temp directories in flight ───────────────────────────────────
// A server exit in the middle of a run must not leave the CLI running or a temp
// directory behind: the final pass's directory holds the whole meeting's audio.
const liveChildren = new Set<ChildProcess>()
const liveDirs = new Set<string>()

export function trackNemotronDir(dir: string): void { installExitHook(); liveDirs.add(dir) }
export function untrackNemotronDir(dir: string): void { liveDirs.delete(dir) }

/** Kill every CLI child and delete every temp directory in flight. Synchronous, so it works in an exit handler. */
export function killNemotronChildren(): { killed: number; removed: number } {
  let killed = 0
  for (const child of liveChildren) {
    try { if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); killed++ } } catch { /* already gone */ }
  }
  liveChildren.clear()
  let removed = 0
  for (const dir of liveDirs) {
    try { rmSync(dir, { recursive: true, force: true }); removed++ } catch { /* best effort */ }
  }
  liveDirs.clear()
  return { killed, removed }
}

let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // `exit` runs for process.exit (gracefulShutdown ends with it) and a normal end.
  process.once('exit', () => { killNemotronChildren() })
}

/**
 * Server start: remove what a previous process left behind. Temp directories
 * under this prefix older than minAgeMs, and CLI processes that were ours (their
 * arguments name one of these directories) and are now orphaned (parent 1).
 */
export function sweepStaleNemotron(options: { tmpRoot?: string; minAgeMs?: number; now?: number; killOrphans?: boolean } = {}): { dirs: number; processes: number } {
  const root = options.tmpRoot ?? tmpdir()
  const now = options.now ?? Date.now()
  const minAge = options.minAgeMs ?? 60_000
  let dirs = 0
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(NEMOTRON_TMP_PREFIX)) continue
      const path = join(root, name)
      try {
        const stat = statSync(path)
        if (!stat.isDirectory() || now - stat.mtimeMs < minAge) continue
        rmSync(path, { recursive: true, force: true })
        dirs++
      } catch { /* raced or unreadable */ }
    }
  } catch { /* no tmp root */ }
  let processes = 0
  if (options.killOrphans !== false) {
    try {
      const listing = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
      for (const line of listing.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        if (!match || match[2] !== '1') continue
        const command = match[3]
        if (!command.includes('nemotron3-diarize') || !command.includes(`/${NEMOTRON_TMP_PREFIX}`)) continue
        try { process.kill(Number(match[1]), 'SIGKILL'); processes++ } catch { /* gone */ }
      }
    } catch { /* ps unavailable: the directories are still swept */ }
  }
  return { dirs, processes }
}

export interface NemotronPreds {
  /** Number of 10 ms frames. */
  frames: number
  /** Row-major [frames x 8] probabilities, as the CLI's --dump-preds writes them. */
  probs: Float32Array
}

export interface NemotronRun extends NemotronPreds {
  /** "Model loaded in X s". Above a second or two means the Neural Engine compiled. */
  loadSec: number | null
  /** Audio seconds the CLI says it processed. */
  audioSec: number | null
  wallMs: number
}

export type NemotronRunFailure = 'timeout' | 'cli_failed' | 'bad_output' | 'spawn_failed'

export class NemotronRunError extends Error {
  constructor(readonly reason: NemotronRunFailure, message: string) {
    super(message)
    this.name = 'NemotronRunError'
  }
}

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface RunNemotronOptions {
  cli: string
  modelsDir: string
  wavPath: string
  timeoutMs: number
  /** `ane` keeps the GPU free for Whisper. Its probabilities matched `all` at the
   *  0.5 threshold frame for frame on real chunks (2026-10-02 probe). */
  computeUnits?: 'ane' | 'all'
  /** Lower CPU priority than the server, so Whisper keeps priority. */
  niceness?: number
  spawnImpl?: SpawnLike
  tmpRoot?: string
}

const STDOUT_CAP = 64 * 1024
const PROCESSED_LINE = /Processed ([0-9.]+)s in ([0-9.]+)s \(RTFx [0-9.]+x\), (\d+) x 10ms frames/
const LOADED_LINE = /Model loaded in ([0-9.]+)s/

export function nemotronArgs(wavPath: string, modelsDir: string, predsPath: string, computeUnits: 'ane' | 'all'): string[] {
  return [
    'nemotron3-diarize', wavPath,
    '--models', modelsDir,
    '--variant', NEMOTRON_VARIANT,
    '--compute-units', computeUnits,
    '--threshold', '0.5',
    '--dump-preds', predsPath,
  ]
}

/** Parse the CLI's stdout plus the preds file into a checked matrix. */
export function parseNemotronOutput(stdout: string, preds: Buffer): Omit<NemotronRun, 'wallMs'> {
  const processed = PROCESSED_LINE.exec(stdout)
  if (!processed) throw new NemotronRunError('bad_output', 'no "Processed ... frames" line')
  const frames = Number(processed[3])
  if (!Number.isInteger(frames) || frames < 0) throw new NemotronRunError('bad_output', 'frame count unreadable')
  const expected = frames * NEMOTRON_CHANNELS * 4
  if (preds.length !== expected) {
    throw new NemotronRunError('bad_output', `preds ${preds.length} bytes, expected ${frames}x${NEMOTRON_CHANNELS}x4 = ${expected}`)
  }
  // Copy into an aligned buffer: a Buffer slice may sit at an odd byte offset.
  const probs = new Float32Array(frames * NEMOTRON_CHANNELS)
  for (let i = 0; i < probs.length; i++) probs[i] = preds.readFloatLE(i * 4)
  const loaded = LOADED_LINE.exec(stdout)
  return {
    frames,
    probs,
    loadSec: loaded ? Number(loaded[1]) : null,
    audioSec: Number(processed[1]),
  }
}

export function runNemotronCli(options: RunNemotronOptions): Promise<NemotronRun> {
  const started = Date.now()
  const spawnImpl: SpawnLike = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike)
  let work: string
  try {
    work = mkdtempSync(join(options.tmpRoot ?? tmpdir(), NEMOTRON_TMP_PREFIX))
    try { chmodSync(work, 0o700) } catch { /* mkdtemp is already 0700 */ }
  } catch (error) {
    return Promise.reject(new NemotronRunError('spawn_failed', `temp dir: ${error instanceof Error ? error.message : String(error)}`))
  }
  installExitHook()
  trackNemotronDir(work)
  const predsPath = join(work, 'preds.f32')
  const cleanup = () => {
    untrackNemotronDir(work)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return new Promise<NemotronRun>((resolve, reject) => {
    let settled = false
    const finish = (error: NemotronRunError | null, value?: NemotronRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (error) reject(error)
      else resolve(value!)
    }
    let child: ChildProcess
    try {
      child = spawnImpl(options.cli, nemotronArgs(options.wavPath, options.modelsDir, predsPath, options.computeUnits ?? 'ane'), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: nemotronChildEnv(),
      })
    } catch (error) {
      cleanup()
      reject(new NemotronRunError('spawn_failed', error instanceof Error ? error.message : String(error)))
      return
    }
    liveChildren.add(child)
    child.once('exit', () => liveChildren.delete(child))
    child.once('close', () => liveChildren.delete(child))
    if (child.pid && options.niceness) {
      try { setPriority(child.pid, options.niceness) } catch { /* the run still works at normal priority */ }
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { if (stdout.length < STDOUT_CAP) stdout += data.toString() })
    child.stderr?.on('data', (data: Buffer) => { if (stderr.length < STDOUT_CAP) stderr += data.toString() })
    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: a CoreML compile does not stop for TERM, and a
      // budget that waits on it is no budget.
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(new NemotronRunError('timeout', `no result within ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    timer.unref?.()
    child.on('error', error => { liveChildren.delete(child); finish(new NemotronRunError('spawn_failed', error.message)) })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
        finish(new NemotronRunError('cli_failed', `exit ${code ?? signal}: ${tail}`))
        return
      }
      try {
        const parsed = parseNemotronOutput(stdout, readFileSync(predsPath))
        finish(null, { ...parsed, wallMs: Date.now() - started })
      } catch (error) {
        finish(error instanceof NemotronRunError ? error : new NemotronRunError('bad_output', error instanceof Error ? error.message : String(error)))
      }
    })
  })
}
