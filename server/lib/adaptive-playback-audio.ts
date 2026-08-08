// Adaptive cleanup for RETAINED meeting-audio playback only.
//
// This module deliberately does not sit on the live capture, preview, canonical
// transcription, speaker-attribution, save, HQ, or sync paths. A reviewer asks
// to hear a retained raw chunk; on first play we derive a bounded cleaned WAV,
// cache it beside the raw evidence, and serve that copy. Raw is never rewritten.
// Any unsupported input, missing ffmpeg, timeout, or invalid output falls back
// to the exact raw path the route would have served before this feature existed.

import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { invalidateMeetingAudioStats } from './meeting-audio-archive.js'

const FILTER_VERSION = 1
const FFMPEG_TIMEOUT_MS = 30_000
// Capture chunks are seconds long (~200 KB). Four MiB still tolerates a wildly
// oversized chunk while bounding synchronous profiling on the server event loop.
const MAX_INPUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 4_096

export type AdaptivePlaybackProfile =
  | 'hot_clipped'
  | 'hot'
  | 'quiet'
  | 'wind_noisy'
  | 'clean_indoor'

export interface AudioSignalProfile {
  profile: AdaptivePlaybackProfile
  sampleRate: number
  channels: number
  samples: number
  peakDbfs: number
  rmsDbfs: number
  clippedSampleRatio: number
  lowFrequencyEnergyRatio: number
}

export interface AdaptivePlaybackResult {
  path: string
  mode: 'raw' | 'adaptive'
  profile: AdaptivePlaybackProfile | null
  reason?: string
}

const FILTERS: Record<AdaptivePlaybackProfile, string> = {
  hot_clipped: 'adeclip,highpass=f=100,afftdn=nt=w,volume=-8dB,alimiter=limit=0.794,loudnorm=I=-17:LRA=9:TP=-2',
  hot: 'highpass=f=80,volume=-6dB,alimiter=limit=0.794,loudnorm=I=-17:LRA=9:TP=-2',
  quiet: 'highpass=f=80,afftdn=nt=w,volume=6dB,alimiter=limit=0.891',
  wind_noisy: 'highpass=f=140,afftdn=nt=w,loudnorm=I=-18:LRA=9:TP=-2',
  clean_indoor: 'highpass=f=80,alimiter=limit=0.891',
}

type Pcm16 = {
  sampleRate: number
  channels: number
  dataOffset: number
  dataBytes: number
}

function pcm16Wav(buffer: Buffer): Pcm16 | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataBytes = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) return null
    if (id === 'fmt ' && size >= 16) {
      audioFormat = buffer.readUInt16LE(start)
      channels = buffer.readUInt16LE(start + 2)
      sampleRate = buffer.readUInt32LE(start + 4)
      bitsPerSample = buffer.readUInt16LE(start + 14)
    } else if (id === 'data') {
      dataOffset = start
      dataBytes = size
    }
    offset = end + (size % 2)
  }
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate < 8_000 || sampleRate > 96_000) return null
  if (dataOffset < 0 || dataBytes < 2 || dataOffset + dataBytes > buffer.length || dataBytes % 2 !== 0) return null
  return { sampleRate, channels, dataOffset, dataBytes }
}

function dbfs(value: number): number {
  if (!(value > 0)) return -120
  return Math.round(20 * Math.log10(Math.min(1, value)) * 10) / 10
}

/** Pure, deterministic profiler. It never shells out and never mutates audio. */
export function analyzePlaybackWav(buffer: Buffer): AudioSignalProfile | null {
  const wav = pcm16Wav(buffer)
  if (!wav) return null
  const count = wav.dataBytes / 2
  let peak = 0
  let energy = 0
  let lowEnergy = 0
  let clipped = 0
  let low = 0
  // One-pole 120 Hz low-pass. This is only a conservative wind/noise proxy;
  // it selects a stronger high-pass profile and never changes canonical text.
  const alpha = 1 - Math.exp((-2 * Math.PI * 120) / wav.sampleRate)
  for (let i = 0; i < count; i++) {
    const raw = wav.dataOffset + i * 2
    const sample = buffer.readInt16LE(raw) / 32768
    const magnitude = Math.abs(sample)
    peak = Math.max(peak, magnitude)
    energy += sample * sample
    low += alpha * (sample - low)
    lowEnergy += low * low
    if (Math.abs(buffer.readInt16LE(raw)) >= 32_760) clipped++
  }
  const rms = Math.sqrt(energy / count)
  const clippedSampleRatio = clipped / count
  const lowFrequencyEnergyRatio = energy > 0 ? Math.min(1, lowEnergy / energy) : 0
  const rmsDbfs = dbfs(rms)
  const peakDbfs = dbfs(peak)
  let profile: AdaptivePlaybackProfile
  if (clippedSampleRatio >= 0.0005 || rmsDbfs >= -12 || peakDbfs >= -0.3) profile = 'hot_clipped'
  else if (lowFrequencyEnergyRatio >= 0.38 && rmsDbfs > -35) profile = 'wind_noisy'
  else if (rmsDbfs >= -18) profile = 'hot'
  else if (rmsDbfs <= -32) profile = 'quiet'
  else profile = 'clean_indoor'
  return {
    profile,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    samples: count,
    peakDbfs,
    rmsDbfs,
    clippedSampleRatio: Math.round(clippedSampleRatio * 1_000_000) / 1_000_000,
    lowFrequencyEnergyRatio: Math.round(lowFrequencyEnergyRatio * 1_000) / 1_000,
  }
}

export function adaptivePlaybackEnabled(): boolean {
  // Private canary: explicit opt-in, explicit 0 rollback through COS Control.
  return process.env.COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK === '1'
}

function outputPathFor(rawPath: string): string | null {
  const rawName = basename(rawPath)
  const match = /^chunk_(\d+)\.wav$/.exec(rawName)
  if (!match) return null
  const dir = dirname(rawPath)
  const output = resolve(dir, `playback_v${FILTER_VERSION}_${match[1]}.wav`)
  return output.startsWith(resolve(dir) + '/') ? output : null
}

function cachedOutput(rawPath: string, outputPath: string): boolean {
  try {
    const raw = statSync(rawPath)
    const output = statSync(outputPath)
    return output.isFile()
      && output.size > 44
      && output.mtimeMs >= raw.mtimeMs
      && analyzePlaybackWav(readFileSync(outputPath)) !== null
  } catch {
    return false
  }
}

async function runFfmpeg(inputPath: string, outputPath: string, filter: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-af', filter,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      '-y',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let settled = false
    let stderr = ''
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      error ? rejectPromise(error) : resolvePromise()
    }
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_BYTES)
    })
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      finish(new Error(`ffmpeg timeout (${FFMPEG_TIMEOUT_MS / 1000}s)`))
    }, FFMPEG_TIMEOUT_MS)
    proc.on('error', error => finish(error))
    proc.on('close', code => {
      if (code !== 0) finish(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-300)}`))
      else finish()
    })
  })
}

const inFlight = new Map<string, Promise<AdaptivePlaybackResult>>()
const counters = {
  generated: 0,
  cacheHits: 0,
  fallbacks: 0,
  profiles: {} as Record<AdaptivePlaybackProfile, number>,
}

async function prepare(rawPath: string): Promise<AdaptivePlaybackResult> {
  if (!adaptivePlaybackEnabled()) return { path: rawPath, mode: 'raw', profile: null, reason: 'disabled' }
  const outputPath = outputPathFor(rawPath)
  if (!outputPath) {
    counters.fallbacks++
    return { path: rawPath, mode: 'raw', profile: null, reason: 'unsupported_source' }
  }
  let input: Buffer
  try {
    const stat = statSync(rawPath)
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('input is not a bounded regular file')
    input = readFileSync(rawPath)
  } catch (error: unknown) {
    counters.fallbacks++
    return { path: rawPath, mode: 'raw', profile: null, reason: error instanceof Error ? error.message : String(error) }
  }
  const signal = analyzePlaybackWav(input)
  if (!signal) {
    counters.fallbacks++
    return { path: rawPath, mode: 'raw', profile: null, reason: 'unsupported_wav' }
  }
  counters.profiles[signal.profile] = (counters.profiles[signal.profile] ?? 0) + 1
  if (cachedOutput(rawPath, outputPath)) {
    counters.cacheHits++
    return { path: outputPath, mode: 'adaptive', profile: signal.profile }
  }

  const tempPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp.wav`)
  try {
    await runFfmpeg(rawPath, tempPath, FILTERS[signal.profile])
    if (!existsSync(tempPath) || !analyzePlaybackWav(readFileSync(tempPath))) {
      throw new Error('ffmpeg produced an invalid PCM WAV')
    }
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, outputPath)
    counters.generated++
    invalidateMeetingAudioStats()
    return { path: outputPath, mode: 'adaptive', profile: signal.profile }
  } catch (error: unknown) {
    counters.fallbacks++
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[adaptive-playback] cleanup failed (${signal.profile}); serving raw: ${reason}`)
    return { path: rawPath, mode: 'raw', profile: signal.profile, reason }
  } finally {
    try { unlinkSync(tempPath) } catch { /* already renamed or never created */ }
  }
}

/** Single-flight per raw chunk so simultaneous Play requests run ffmpeg once. */
export async function adaptivePlaybackAudio(rawPath: string): Promise<AdaptivePlaybackResult> {
  const current = inFlight.get(rawPath)
  if (current) return current
  const pending = prepare(rawPath).finally(() => inFlight.delete(rawPath))
  inFlight.set(rawPath, pending)
  return pending
}

export function adaptivePlaybackStatus(): {
  supported: true
  enabled: boolean
  mode: 'retained_replay_only'
  rawPreserved: true
  liveRecordingProtected: true
  generatedThisBoot: number
  cacheHitsThisBoot: number
  fallbacksThisBoot: number
  inFlight: number
  profilesThisBoot: Partial<Record<AdaptivePlaybackProfile, number>>
} {
  return {
    supported: true,
    enabled: adaptivePlaybackEnabled(),
    mode: 'retained_replay_only',
    rawPreserved: true,
    liveRecordingProtected: true,
    generatedThisBoot: counters.generated,
    cacheHitsThisBoot: counters.cacheHits,
    fallbacksThisBoot: counters.fallbacks,
    inFlight: inFlight.size,
    profilesThisBoot: { ...counters.profiles },
  }
}
