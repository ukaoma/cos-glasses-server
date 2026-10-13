// Dictation speech-to-text (6.73.0): prompts and dictation follow the STT
// settings. The contract and the evidence behind every rule here:
// docs/dictation-stt-contract.md.
//
//   live preview (peek) and Fast mode  -> the Preview model
//   final text (Fast mode off)         -> the HQ model
//
// Only the Parakeet branch is new. Every Whisper path is the 6.72.0 code,
// unchanged, and it is also the fallback: a Parakeet decode that is cold,
// failed, busy or behind an open breaker leaves the request on Whisper with a
// reason code, so the user never sees a blank or an error because of it.
// The engine is chosen once when a decode starts and never changes during it.
// Second opinion and resolver never run here. No LLM is ever called.

import { transcribeParakeet, ParakeetError } from './parakeet.js'
import { asrFrontEnd } from './stt-live.js'
import {
  currentSttCapabilities, ensurePreviewWarm, noteParakeetDictationHit, noteParakeetDictationMiss,
  PARAKEET_PREVIEW_TIMEOUT_MS, PREVIEW_PARAKEET_MODEL,
} from './stt-runtime.js'
import {
  dictationPlan, readSttSettings, type DictationPlan, type DictationSlot, type FrontEndId,
} from './stt-settings.js'

/** The plan for a dictation decode starting now. A Parakeet selection that is
 *  not warm yet starts a warm-up (never awaited) and decodes this one on Whisper. */
export function currentDictationPlan(slot: DictationSlot): DictationPlan {
  let plan: DictationPlan
  try {
    const settings = readSttSettings()
    plan = dictationPlan(slot, settings, currentSttCapabilities())
    if (plan.reason === 'parakeet_warming' || plan.reason === 'parakeet_warm_failed') ensurePreviewWarm()
  } catch (error) {
    console.warn(`[stt] dictation settings unreadable, using Whisper: ${error instanceof Error ? error.message : error}`)
    plan = { slot, engine: 'whisper', reason: null, frontEnd: 'highpass', key: slot === 'final' ? 'final:large-v3' : `${slot}:turbo` }
  }
  return plan
}

/** Parakeet reads 16 kHz mono PCM16 WAV. The browser recorder posts WebM, which stays on Whisper. */
export function isPcm16kMonoWav(audio: Buffer): boolean {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return false
  let offset = 12
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      return body + 16 <= audio.length
        && audio.readUInt16LE(body) === 1 && audio.readUInt16LE(body + 2) === 1
        && audio.readUInt32LE(body + 4) === 16_000 && audio.readUInt16LE(body + 14) === 16
    }
    offset = body + size + (size % 2)
  }
  return false
}

/** A warm Parakeet decodes 6 s in about 0.3 s. The budget is generous so a busy
 *  Neural Engine is not a miss, and bounded so a hang falls to Whisper quickly. */
export function parakeetDictationTimeoutMs(audio: Buffer): number {
  const seconds = Math.max(0, (audio.length - 44) / 32_000)
  return Math.min(15_000, Math.round(2_000 + 150 * seconds))
}

export type DictationLane = 'preview' | 'interactive'

export interface DictationParakeetDeps {
  parakeet: (audio: Buffer, lane: DictationLane, timeoutMs: number) => Promise<{ text: string }>
  frontEnd: (audio: Buffer, frontEnd: FrontEndId) => Promise<Buffer>
  hit: () => void
  miss: () => void
}

export const defaultDictationParakeetDeps: DictationParakeetDeps = {
  parakeet: (audio, lane, timeoutMs) => transcribeParakeet(audio, { model: PREVIEW_PARAKEET_MODEL, lane, timeoutMs }),
  frontEnd: (audio, fe) => asrFrontEnd(audio, fe),
  hit: () => noteParakeetDictationHit(),
  miss: () => noteParakeetDictationMiss(),
}

export type DictationParakeetOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'parakeet_busy' | 'parakeet_failed' | 'audio_not_pcm_wav' }

/** Applies the front end only on the Parakeet branch (see the contract). */
export const DICTATION_PARAKEET_FRONT_END = true

/**
 * One Parakeet decode for a dictation request. Never throws: any failure is an
 * outcome the caller turns into its 6.72.0 Whisper decode of the same audio.
 * Raw text only; the caller runs the same corrections and filters as Whisper text.
 */
export async function runParakeetDictation(
  audio: Buffer,
  plan: DictationPlan,
  lane: DictationLane,
  deps: DictationParakeetDeps = defaultDictationParakeetDeps,
): Promise<DictationParakeetOutcome> {
  if (plan.engine !== 'parakeet-ultra') return { ok: false, reason: 'parakeet_failed' }
  if (!isPcm16kMonoWav(audio)) return { ok: false, reason: 'audio_not_pcm_wav' }
  const timeoutMs = lane === 'preview' ? PARAKEET_PREVIEW_TIMEOUT_MS : parakeetDictationTimeoutMs(audio)
  let input = audio
  if (DICTATION_PARAKEET_FRONT_END) {
    // A front-end failure is not a Parakeet miss: decode the raw audio instead.
    try { input = await deps.frontEnd(audio, plan.frontEnd) } catch { input = audio }
  }
  try {
    const result = await deps.parakeet(input, lane, timeoutMs)
    deps.hit()
    return { ok: true, text: result.text }
  } catch (error) {
    const busy = error instanceof ParakeetError ? error.reason === 'busy' : (error as { reason?: string })?.reason === 'busy'
    if (!busy) deps.miss()
    console.warn(`[stt] Parakeet dictation ${plan.slot} ${busy ? 'busy' : 'missed'}; Whisper decodes it: ${error instanceof Error ? error.message : error}`)
    return { ok: false, reason: busy ? 'parakeet_busy' : 'parakeet_failed' }
  }
}
