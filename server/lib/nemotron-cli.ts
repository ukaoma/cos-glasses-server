// One run of `fluidaudiocli nemotron3-diarize`: a WAV in, raw 10 ms speaker
// probabilities out.
//
// The probabilities, not the RTTM, are the output that matters. The canary found
// that the RTTM drops turns shorter than 0.2 s, so every consumer scores the raw
// [frames x 8] float32 matrix at 0.5, exactly as the canary did.
//
// No model call, no network: `--models` is always passed (see diarizer-backend.ts),
// and nothing here is an LLM. Transcription must never call `claude -p`.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { setPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEMOTRON_VARIANT } from './diarizer-backend.js'

export const NEMOTRON_CHANNELS = 8
export const NEMOTRON_FRAME_SEC = 0.01

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
    work = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'cos-nemotron-'))
    try { chmodSync(work, 0o700) } catch { /* mkdtemp is already 0700 */ }
  } catch (error) {
    return Promise.reject(new NemotronRunError('spawn_failed', `temp dir: ${error instanceof Error ? error.message : String(error)}`))
  }
  const predsPath = join(work, 'preds.f32')
  const cleanup = () => { try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ } }

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
        env: process.env,
      })
    } catch (error) {
      cleanup()
      reject(new NemotronRunError('spawn_failed', error instanceof Error ? error.message : String(error)))
      return
    }
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
    child.on('error', error => finish(new NemotronRunError('spawn_failed', error.message)))
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
