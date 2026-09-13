// 6.45.4 — the trailing sentence Whisper invents after a person stops talking.
//
// Chris, a beta tester, 2026-09-12, dictating alone in his truck: the prompt ended
// "...that I have within that folder. I'm going to go to the bathroom." He never
// said the last sentence. Dictated prompts commit through the high-quality decoder
// with VAD deliberately off (VAD was measured dropping the first words of a
// prompt), so the seconds of cabin noise after he stopped reach the decoder with
// the vocabulary prompt attached, and Whisper does what it does on non-speech
// audio: it invents a plausible sentence. Earlier it echoed "COS glasses".
//
// Miles's constraint: never cut the real end of a prompt. So this never trims
// audio and never touches a sentence that overlaps a speech window. It drops a
// trailing sentence only when
//   (a) it matches the junk lexicon ("Thanks for watching", "I need to go to the
//       bathroom", caption credits), or
//   (b) it starts a full second after the last VAD speech window ended AND the
//       decoder's own mean token probability for it is low.
// With VAD unavailable, (b) is off: nothing is dropped on a guess. At most two
// trailing sentences ever go, and every drop is logged with the text.
import { isSileroAvailable, trimSilence } from './vad-silero.js'
import { isFullHallucination } from './hallucination-filter.js'
import type { WhisperWord } from './whisper-local.js'

export const TAIL_SILENCE_MIN_SEC = 1.0
export const TAIL_LOW_CONFIDENCE = 0.45
export const TAIL_MAX_DROPS = 2
const SAMPLE_RATE = 16_000

/** Phrases that are junk wherever they land at the end of a dictated prompt. */
export const TAIL_HALLUCINATION_PHRASES: RegExp[] = [
  /\b(?:i(?:'m| am)|i need to|i(?:'ve| have) got to|i gotta|gotta|going to|gonna) (?:go(?: to)?|use) the (?:bathroom|restroom|toilet|washroom)\b/i,
  /\bthanks? for (?:watching|listening)\b/i,
  /\bthank you for (?:watching|listening)\b/i,
  /\bsee you (?:next time|in the next(?: one| video)?|later)\b/i,
  /\bsubtitles? by\b/i,
  /\b(?:please )?(?:like and subscribe|subscribe to (?:my|the) channel)\b/i,
  /\bdon'?t forget to subscribe\b/i,
  /\btranscript by rev\.com\b/i,
  /\bthe end\.?$/i,
]

export interface SpeechWindows {
  /** False when the VAD model is not loaded: then windows say nothing. */
  available: boolean
  /** End of the last speech window in seconds, or null when none was found. */
  lastSpeechEndSec: number | null
  speechRatio: number
}

export interface TailGuardInput {
  text: string
  words?: WhisperWord[]
  speech: SpeechWindows
}

export type TailDropReason = 'lexicon' | 'low_confidence_after_speech' | 'no_speech_low_confidence'

export interface TailGuardResult {
  text: string
  dropped: Array<{ text: string; reason: TailDropReason; startSec: number | null; meanProbability: number | null }>
  lastSpeechEndSec: number | null
}

/** Speech windows from the retained WAV, without altering the audio. */
export function speechWindowsFromWav(wav: Buffer): SpeechWindows {
  if (!isSileroAvailable()) return { available: false, lastSpeechEndSec: null, speechRatio: 0 }
  const result = trimSilence(wav)
  let lastEnd: number | null = null
  for (const segment of result.segments) {
    const end = (segment.startSample + segment.sampleCount) / SAMPLE_RATE
    if (lastEnd === null || end > lastEnd) lastEnd = end
  }
  return { available: true, lastSpeechEndSec: lastEnd, speechRatio: result.speechRatio }
}

/** Sentences with their punctuation, in order; a text without terminal punctuation is one sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  const re = /[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g
  for (const m of text.matchAll(re)) {
    const piece = m[0].trim()
    if (piece) out.push(piece)
  }
  return out
}

function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter(Boolean).length
}

/** The last `count` decoder words: their first start and mean probability. */
function tailWordStats(words: WhisperWord[] | undefined, count: number): { startSec: number | null; meanProbability: number | null } {
  if (!words || words.length === 0 || count <= 0) return { startSec: null, meanProbability: null }
  const tail = words.slice(Math.max(0, words.length - count))
  const probs = tail.map(w => w.probability).filter(p => Number.isFinite(p))
  return {
    startSec: tail[0]?.start ?? null,
    meanProbability: probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : null,
  }
}

export function matchesTailLexicon(sentence: string): boolean {
  return TAIL_HALLUCINATION_PHRASES.some(re => re.test(sentence)) || isFullHallucination(sentence)
}

export function guardPromptTail(input: TailGuardInput): TailGuardResult {
  const sentences = splitSentences(input.text)
  const dropped: TailGuardResult['dropped'] = []
  const speech = input.speech
  let words = input.words ? [...input.words] : undefined

  // A chunk the VAD heard no speech in, that the decoder was unsure about,
  // is invention end to end. A confident decode on a quiet speaker stays.
  if (speech.available && speech.lastSpeechEndSec === null && sentences.length > 0) {
    const all = tailWordStats(words, words?.length ?? 0)
    if (all.meanProbability !== null && all.meanProbability < TAIL_LOW_CONFIDENCE) {
      return {
        text: '',
        dropped: [{ text: input.text.trim(), reason: 'no_speech_low_confidence', startSec: all.startSec, meanProbability: all.meanProbability }],
        lastSpeechEndSec: null,
      }
    }
  }

  while (sentences.length > 0 && dropped.length < TAIL_MAX_DROPS) {
    const last = sentences[sentences.length - 1]
    const count = wordCount(last)
    const stats = tailWordStats(words, count)
    let reason: TailDropReason | null = null
    if (matchesTailLexicon(last)) {
      reason = 'lexicon'
    } else if (
      speech.available
      && speech.lastSpeechEndSec !== null
      && stats.startSec !== null
      && stats.startSec >= speech.lastSpeechEndSec + TAIL_SILENCE_MIN_SEC
      && stats.meanProbability !== null
      && stats.meanProbability < TAIL_LOW_CONFIDENCE
    ) {
      reason = 'low_confidence_after_speech'
    }
    if (!reason) break
    dropped.push({ text: last, reason, startSec: stats.startSec, meanProbability: stats.meanProbability })
    sentences.pop()
    if (words) words = words.slice(0, Math.max(0, words.length - count))
  }

  return { text: sentences.join(' ').trim(), dropped, lastSpeechEndSec: speech.lastSpeechEndSec }
}
