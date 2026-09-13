// Silero VAD — trims silence from audio chunks before Whisper inference.
// Uses sherpa-onnx-node's built-in Silero VAD (same package as speaker embeddings).
// Graceful fallback: if model missing or init fails, returns audio unchanged.
//
// Architecture: client keeps RMS-based chunking (decides WHEN to flush).
// Server receives chunk, runs Silero VAD to extract speech segments,
// trims silence edges, sends only speech to Whisper.

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// sherpa-onnx-node is CJS — use createRequire for ESM compat
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const MODEL_PATH = resolve(__dirname, '..', 'models', 'silero_vad.onnx')

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2  // 16-bit PCM
const WAV_HEADER_SIZE = 44
// Minimum samples for Silero VAD to produce meaningful results (512 = one window)
const MIN_SAMPLES = 512

// Module-level state — single Vad instance reused via reset() (~11ms vs 45ms per-call)
let sherpaOnnx: any = null
let available = false
let vadInstance: any = null

export interface TrimResult {
  trimmedWav: Buffer
  speechRatio: number
  segments: Array<{ startSample: number; sampleCount: number }>
  /** True when the VAD ran over the audio and `segments` is its verdict. Absent
   *  on every fallback (model not loaded, audio too short, internal error), which
   *  otherwise look identical to measured silence. A reader deciding to drop
   *  text on "no speech" must require this. (6.45.4: prompt-tail-guard) */
  measured?: true
}

/** Initialize Silero VAD. Returns true if model loaded, false otherwise. */
export function initSileroVAD(): boolean {
  if (!existsSync(MODEL_PATH)) {
    console.log('[silero-vad] Model not found at', MODEL_PATH, '— VAD disabled, audio passes through untrimmed')
    return false
  }

  try {
    sherpaOnnx = require('sherpa-onnx-node')
    // Create the reusable Vad instance (kept alive for server lifetime)
    // bufferSizeInSeconds: 10 — chunks are max 6s, no need for 60s buffer
    vadInstance = new sherpaOnnx.Vad(
      {
        sileroVad: { model: MODEL_PATH, threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.25, windowSize: 512 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
      },
      10,  // bufferSizeInSeconds — chunks are max 6s
    )
    vadInstance.reset()  // verify it works
    available = true
    console.log('[silero-vad] Initialized: Silero VAD active (reused instance, bufferSize=10s)')
    return true
  } catch (err: any) {
    console.error('[silero-vad] Init failed:', err.message)
    available = false
    return false
  }
}

/** Check if Silero VAD is available */
export function isSileroAvailable(): boolean {
  return available
}

/**
 * Trim silence from a WAV buffer using Silero VAD.
 * Returns the trimmed WAV + speech ratio for logging.
 *
 * Graceful: if anything fails, returns original buffer unchanged.
 */
export function trimSilence(wavBuffer: Buffer): TrimResult {
  const fallback: TrimResult = { trimmedWav: wavBuffer, speechRatio: 0.0, segments: [] }

  if (!available || !vadInstance) return fallback

  try {
    // Parse WAV: extract raw PCM from after the 44-byte header
    if (wavBuffer.length <= WAV_HEADER_SIZE + MIN_SAMPLES * BYTES_PER_SAMPLE) {
      // Audio too short for VAD — return unchanged
      return fallback
    }

    // Safe Int16Array extraction — slice guarantees alignment
    const pcmBytes = wavBuffer.buffer.slice(
      wavBuffer.byteOffset + WAV_HEADER_SIZE,
      wavBuffer.byteOffset + wavBuffer.length,
    )
    const int16 = new Int16Array(pcmBytes)

    if (int16.length < MIN_SAMPLES) return fallback

    // Convert Int16 → Float32 (Silero expects [-1, 1] range)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }

    // Reuse module-level Vad instance — reset() clears state between calls
    // Benchmark: 11ms avg vs 45ms with per-call construction
    vadInstance.reset()
    vadInstance.acceptWaveform(float32)
    vadInstance.flush()

    // Collect speech segments
    const speechSegments: Array<{ startSample: number; samples: Float32Array }> = []
    let totalSpeechSamples = 0

    while (!vadInstance.isEmpty()) {
      const segment = vadInstance.front()
      speechSegments.push({ startSample: segment.start, samples: segment.samples })
      totalSpeechSamples += segment.samples.length
      vadInstance.pop()
    }

    const speechRatio = int16.length > 0 ? totalSpeechSamples / int16.length : 0.0

    if (speechSegments.length === 0 || totalSpeechSamples === 0) {
      // No speech detected — return original unchanged
      return { trimmedWav: wavBuffer, speechRatio: 0.0, segments: [], measured: true }
    }

    // Concatenate speech segments into a single Float32Array
    const speechFloat32 = new Float32Array(totalSpeechSamples)
    let offset = 0
    const segmentInfo: TrimResult['segments'] = []
    for (const seg of speechSegments) {
      speechFloat32.set(seg.samples, offset)
      segmentInfo.push({ startSample: seg.startSample, sampleCount: seg.samples.length })
      offset += seg.samples.length
    }

    // Convert Float32 back to Int16 PCM
    const speechInt16 = new Int16Array(totalSpeechSamples)
    for (let i = 0; i < totalSpeechSamples; i++) {
      // Clamp to [-1, 1] then scale to Int16 range
      const clamped = Math.max(-1, Math.min(1, speechFloat32[i]))
      speechInt16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767
    }

    const pcmLength = speechInt16.length * BYTES_PER_SAMPLE
    const trimmedWav = Buffer.alloc(WAV_HEADER_SIZE + pcmLength)

    // Write WAV header (same format as audio-pipeline.ts pcmToWav)
    trimmedWav.write('RIFF', 0)
    trimmedWav.writeUInt32LE(WAV_HEADER_SIZE - 8 + pcmLength, 4)
    trimmedWav.write('WAVE', 8)
    trimmedWav.write('fmt ', 12)
    trimmedWav.writeUInt32LE(16, 16)          // sub-chunk size
    trimmedWav.writeUInt16LE(1, 20)           // PCM format
    trimmedWav.writeUInt16LE(1, 22)           // mono
    trimmedWav.writeUInt32LE(SAMPLE_RATE, 24)
    trimmedWav.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)  // byte rate
    trimmedWav.writeUInt16LE(BYTES_PER_SAMPLE, 32)                // block align
    trimmedWav.writeUInt16LE(16, 34)          // bits per sample
    trimmedWav.write('data', 36)
    trimmedWav.writeUInt32LE(pcmLength, 40)

    // Copy PCM data after header
    Buffer.from(speechInt16.buffer).copy(trimmedWav, WAV_HEADER_SIZE)

    // Guard: if trimmed result is too small for Whisper, fall back to original
    if (trimmedWav.length < 100) {
      return { trimmedWav: wavBuffer, speechRatio, segments: segmentInfo, measured: true }
    }

    return { trimmedWav, speechRatio, segments: segmentInfo, measured: true }
  } catch (err: any) {
    console.error('[silero-vad] trimSilence error:', err.message)
    return fallback
  }
}
