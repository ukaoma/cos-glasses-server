// The live chunk's quiet gate and ASR front end (6.72.0). Kept apart from the
// decoders so the live route imports only audio code.

import { enhanceAudio } from './audio-enhance.js'
import { isSileroAvailable, measureSpeechSeconds } from './vad-silero.js'
import type { FrontEndId, QuietGateId } from './stt-settings.js'

/** Under this many seconds of Silero speech a chunk is quiet (bake-off canary 5). */
export const QUIET_SPEECH_SEC = 0.5
export const QUIET_RMS = 150

export interface QuietDecision {
  isQuiet: boolean
  rms: number
  /** Silero speech seconds; null when the gate fell back to RMS. */
  speechSec: number | null
  gate: 'silero' | 'rms' | 'rms_fallback'
}

export function chunkRms(wav: Buffer): number {
  const pcm = wav.subarray(44)
  const n = Math.floor(pcm.length / 2)
  let sumSq = 0
  for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2); sumSq += s * s }
  return Math.sqrt(sumSq / Math.max(1, n))
}

/**
 * Quiet means "do not prompt, do not enhance, drop silence echoes". RMS 150
 * fired on 1% of G2 chunks while Silero found no speech in 9.3%, so 6.72.0
 * gates on Silero speech seconds (the in-process sherpa Silero, about 17 ms a
 * 6 s chunk). Silero unavailable or the clip too short: the old RMS gate.
 */
export function decideQuiet(wav: Buffer, gate: QuietGateId, vad: { available: () => boolean; speechSeconds: (wav: Buffer) => number | null } = { available: () => isSileroAvailable(), speechSeconds: w => measureSpeechSeconds(w) }): QuietDecision {
  const rms = chunkRms(wav)
  if (gate === 'silero' && vad.available()) {
    const speechSec = vad.speechSeconds(wav)
    if (speechSec !== null && Number.isFinite(speechSec)) {
      return { isQuiet: speechSec < QUIET_SPEECH_SEC, rms, speechSec, gate: 'silero' }
    }
    return { isQuiet: rms < QUIET_RMS, rms, speechSec: null, gate: 'rms_fallback' }
  }
  return { isQuiet: rms < QUIET_RMS, rms, speechSec: null, gate: 'rms' }
}

/** ASR input for a live chunk or an HQ window. Playback audio is never touched here. */
export function asrFrontEnd(audio: Buffer, frontEnd: FrontEndId): Promise<Buffer> {
  return frontEnd === 'full' ? enhanceAudio(audio) : enhanceAudio(audio, { profile: 'light' })
}

