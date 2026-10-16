// 6.74.0: the on-device dictation check COS Control's onboarding runs on its pinned
// 30 s sample. Each installed local engine decodes the same WAV once; the result is
// speed (real-time factor), peak memory where it can be measured, and the text.
// Control scores accuracy against its own reference transcript.
//
// One clip is a sanity check on this Mac, not a benchmark of the engine. Bounded:
// one run at a time, never while a recording is live, a timeout per engine and in all.
// No cloud and no LLM: Whisper is the local live worker, Parakeet the sandboxed CLI.

import { execFile } from 'node:child_process'
import { applyCorrections, getWhisperCommitCapability, transcribeLocal } from './whisper-local.js'
import { parakeetInstalled, parakeetWarmState, transcribeParakeet, warmParakeet, FIRST_LOAD_TIMEOUT_MS } from './parakeet.js'
import { isRecordingLive, PREVIEW_PARAKEET_MODEL } from './stt-runtime.js'
import { parakeetDictationTimeoutMs, isPcm16kMonoWav } from './dictation-stt.js'

export const BENCHMARK_ENGINES = ['whisper', 'parakeet-ultra'] as const
export type BenchmarkEngine = typeof BENCHMARK_ENGINES[number]
/** One engine (including a Parakeet cold start) gets this long. */
export const BENCHMARK_ENGINE_TIMEOUT_MS = 60_000
/** The whole run gets this long. */
export const BENCHMARK_TOTAL_TIMEOUT_MS = 150_000
export const BENCHMARK_MAX_BYTES = 3_840_044

export interface BenchmarkEngineResult {
  engine: BenchmarkEngine
  /** whisper: the live worker model (large-v3-turbo or large-v3); parakeet-ultra: the pinned model. */
  model: string
  ran: boolean
  skipped?: 'not_installed' | 'unavailable' | 'busy' | 'timeout' | 'total_timeout'
  error?: string
  /** Wall time of the decode (warm for Parakeet). */
  elapsedMs?: number
  /** elapsed seconds / audio seconds; below 1 is faster than real time. */
  rtf?: number
  /** Peak resident memory of the decoding process, when this server can sample it. */
  peakRssBytes: number | null
  /** Parakeet only: time to compile and warm the model first, when it was cold. */
  warmupMs?: number
  /** The engine's text after the COS dictionary corrections, before the hallucination filters. */
  text?: string
}

export interface BenchmarkResult { audioSeconds: number; results: BenchmarkEngineResult[] }

export class BenchmarkRefusedError extends Error {
  constructor(readonly status: number, readonly reason: 'benchmark_running' | 'recording_live' | 'audio_not_pcm_wav' | 'audio_too_large' | 'invalid_engine', message: string) {
    super(message)
    this.name = 'BenchmarkRefusedError'
  }
}

export interface BenchmarkDeps {
  recordingLive: () => boolean
  whisperPresent: () => boolean
  whisperModel: () => string
  whisper: (audio: Buffer, signal: AbortSignal) => Promise<{ text: string }>
  parakeetInstalled: () => boolean
  parakeetWarm: () => boolean
  /** Compile and warm Parakeet; resolves true when warm. */
  warmParakeet: () => Promise<boolean>
  parakeet: (audio: Buffer, timeoutMs: number, onSpawn: (pid: number) => void, signal: AbortSignal) => Promise<{ text: string }>
  /** Resident set size of a pid in bytes, or null. */
  rss: (pid: number) => Promise<number | null>
  now: () => number
  engineTimeoutMs: number
  totalTimeoutMs: number
}

function psRss(pid: number): Promise<number | null> {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1_000 }, (error, stdout) => {
      const kb = Number(String(stdout ?? '').trim())
      resolve(error || !Number.isFinite(kb) || kb <= 0 ? null : kb * 1024)
    })
  })
}

export const defaultBenchmarkDeps: BenchmarkDeps = {
  recordingLive: () => isRecordingLive(),
  whisperPresent: () => getWhisperCommitCapability().configured,
  whisperModel: () => getWhisperCommitCapability().effectiveModel,
  // The live worker, as Mac dictation runs it: the vocabulary prompt on, the breaker untouched.
  whisper: async audio => ({ text: (await transcribeLocal(audio, undefined, undefined, { affectsCircuit: false })).text }),
  parakeetInstalled: () => parakeetInstalled().installed,
  parakeetWarm: () => parakeetWarmState(PREVIEW_PARAKEET_MODEL).state === 'warm',
  warmParakeet: () => warmParakeet(PREVIEW_PARAKEET_MODEL),
  parakeet: async (audio, timeoutMs, onSpawn, signal) => {
    const r = await transcribeParakeet(audio, { model: PREVIEW_PARAKEET_MODEL, lane: 'interactive', timeoutMs, onSpawn, signal })
    return { text: applyCorrections(r.text) }
  },
  rss: psRss,
  now: () => performance.now(),
  engineTimeoutMs: BENCHMARK_ENGINE_TIMEOUT_MS,
  totalTimeoutMs: BENCHMARK_TOTAL_TIMEOUT_MS,
}

let running = false
export function benchmarkRunning(): boolean { return running }
export function __resetBenchmarkForTests(): void { running = false }

class Timeout extends Error { constructor(readonly which: 'timeout' | 'total_timeout') { super(which) } }

/** Resolve with the promise, or reject with Timeout after ms. Aborts ctl on timeout. */
function within<T>(promise: Promise<T>, ms: number, which: 'timeout' | 'total_timeout', ctl: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { ctl.abort(); reject(new Timeout(which)) }, Math.max(0, ms))
    timer.unref?.()
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

export function parseBenchmarkEngines(raw: unknown): BenchmarkEngine[] | null {
  if (raw === undefined || raw === '') return [...BENCHMARK_ENGINES]
  if (typeof raw !== 'string') return null
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (!list.length || list.some(e => !(BENCHMARK_ENGINES as readonly string[]).includes(e))) return null
  return [...new Set(list)] as BenchmarkEngine[]
}

export async function runDictationBenchmark(audio: Buffer, engines: BenchmarkEngine[] = [...BENCHMARK_ENGINES], deps: BenchmarkDeps = defaultBenchmarkDeps): Promise<BenchmarkResult> {
  if (audio.length > BENCHMARK_MAX_BYTES) throw new BenchmarkRefusedError(413, 'audio_too_large', 'The sample is longer than two minutes.')
  if (!isPcm16kMonoWav(audio)) throw new BenchmarkRefusedError(400, 'audio_not_pcm_wav', 'The sample must be 16 kHz mono 16-bit WAV.')
  if (running) throw new BenchmarkRefusedError(409, 'benchmark_running', 'A dictation check is already running.')
  if (deps.recordingLive()) throw new BenchmarkRefusedError(409, 'recording_live', 'A recording is live. Run the check after it is saved.')
  running = true
  try {
    const audioSeconds = Math.max(0, (audio.length - 44) / 32_000)
    const started = deps.now()
    const results: BenchmarkEngineResult[] = []
    for (const engine of engines) {
      const left = deps.totalTimeoutMs - (deps.now() - started)
      const model = engine === 'whisper' ? deps.whisperModel() : 'parakeet-ultra'
      if (left <= 0) { results.push({ engine, model, ran: false, skipped: 'total_timeout', peakRssBytes: null }); continue }
      // A recording that started during the run stops it: the live decoders come first.
      if (deps.recordingLive()) throw new BenchmarkRefusedError(409, 'recording_live', 'A recording started. Run the check after it is saved.')
      const budget = Math.min(deps.engineTimeoutMs, left)
      const which = budget < deps.engineTimeoutMs ? 'total_timeout' as const : 'timeout' as const
      results.push(engine === 'whisper' ? await runWhisper(audio, audioSeconds, model, budget, which, deps) : await runParakeet(audio, audioSeconds, budget, which, deps))
    }
    return { audioSeconds, results }
  } finally {
    running = false
  }
}

const rtfOf = (ms: number, seconds: number) => seconds > 0 ? Math.round((ms / 1000 / seconds) * 1000) / 1000 : 0

async function runWhisper(audio: Buffer, seconds: number, model: string, budget: number, which: 'timeout' | 'total_timeout', deps: BenchmarkDeps): Promise<BenchmarkEngineResult> {
  // The live worker is shared and always resident, so its peak is not this decode's.
  const base = { engine: 'whisper' as const, model, peakRssBytes: null }
  if (!deps.whisperPresent()) return { ...base, ran: false, skipped: 'not_installed' }
  const ctl = new AbortController()
  const t0 = deps.now()
  try {
    const r = await within(deps.whisper(audio, ctl.signal), budget, which, ctl)
    const elapsedMs = Math.round(deps.now() - t0)
    return { ...base, ran: true, elapsedMs, rtf: rtfOf(elapsedMs, seconds), text: r.text }
  } catch (error) {
    if (error instanceof Timeout) return { ...base, ran: false, skipped: error.which }
    return { ...base, ran: false, skipped: 'unavailable', error: error instanceof Error ? error.message.slice(0, 200) : String(error) }
  }
}

async function runParakeet(audio: Buffer, seconds: number, budget: number, which: 'timeout' | 'total_timeout', deps: BenchmarkDeps): Promise<BenchmarkEngineResult> {
  const base = { engine: 'parakeet-ultra' as const, model: 'parakeet-ultra', peakRssBytes: null as number | null }
  if (!deps.parakeetInstalled()) return { ...base, ran: false, skipped: 'not_installed' }
  const ctl = new AbortController()
  const t0 = deps.now()
  let warmupMs: number | undefined
  try {
    if (!deps.parakeetWarm()) {
      const ok = await within(deps.warmParakeet(), Math.min(budget, FIRST_LOAD_TIMEOUT_MS), which, ctl)
      warmupMs = Math.round(deps.now() - t0)
      if (!ok) return { ...base, ran: false, skipped: 'unavailable', warmupMs, error: 'Parakeet did not warm up on this Mac.' }
    }
    const left = budget - (deps.now() - t0)
    if (left <= 0) return { ...base, ran: false, skipped: which, ...(warmupMs !== undefined ? { warmupMs } : {}) }
    let peak: number | null = null
    let sampler: ReturnType<typeof setInterval> | null = null
    const sample = (pid: number) => { void deps.rss(pid).then(v => { if (v !== null && (peak === null || v > peak)) peak = v }) }
    const onSpawn = (pid: number) => { sample(pid); sampler = setInterval(() => sample(pid), 50); sampler.unref?.() }
    const t1 = deps.now()
    try {
      const r = await within(deps.parakeet(audio, Math.min(left, parakeetDictationTimeoutMs(audio) * 4), onSpawn, ctl.signal), left, which, ctl)
      const elapsedMs = Math.round(deps.now() - t1)
      return { ...base, ran: true, elapsedMs, rtf: rtfOf(elapsedMs, seconds), peakRssBytes: peak, ...(warmupMs !== undefined ? { warmupMs } : {}), text: r.text }
    } finally {
      if (sampler) clearInterval(sampler)
    }
  } catch (error) {
    if (error instanceof Timeout) return { ...base, ran: false, skipped: error.which, ...(warmupMs !== undefined ? { warmupMs } : {}) }
    const busy = (error as { reason?: string })?.reason === 'busy'
    return { ...base, ran: false, skipped: busy ? 'busy' : 'unavailable', ...(warmupMs !== undefined ? { warmupMs } : {}), error: error instanceof Error ? error.message.slice(0, 200) : String(error) }
  }
}
