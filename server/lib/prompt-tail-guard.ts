// The tail of a dictated prompt: keep what was said, drop what the decoder made up.
//
// Chris, 2026-09-12: a prompt closed with "I'm going to go to the bathroom" after
// he had stopped talking. The interactive path runs whisper without VAD on
// purpose (a short prompt must never be trimmed), and a decoder handed trailing
// silence plus a vocabulary prompt finishes the sentence it thinks it heard.
//
// Miles's constraint governs everything here: "as long as we don't end up
// cutting the final portion of a user's prompt. It's only going to be when we
// see things like 'Thanks for watching,' 'I need to go to the bathroom,' and
// random shit like that that we want to reject it."
//
// Two rules, each on the LAST sentence, at most `TAIL_MAX_DROPS` times:
//
//   (a) lexicon   the whole sentence is a known filler — anchored start to end,
//                 so "put the risks at the end" and "the webinar about thanks
//                 for watching screens" never match (QA 2026-09-12 found the
//                 unanchored form eating both). Applies with or without a VAD.
//   (b) evidence  the VAD MEASURED the audio, the sentence's tokens start at
//                 least `TAIL_SILENCE_MIN_SEC` after the last speech it heard,
//                 AND whisper's own mean token probability for the sentence is
//                 under `TAIL_LOW_CONFIDENCE`. Two independent signals must
//                 agree; either alone keeps the text.
//
// Rule (b) never empties a chunk in which the VAD heard any speech: if the only
// sentence left is low-confidence, it stays. A chunk empties only when every
// sentence was a filler, or the VAD measured the whole chunk as silence and the
// decoder was unsure of what it wrote there. A VAD that did not run (model
// absent, audio too short, internal error) reports UNKNOWN, never silence —
// `TrimResult.measured` is required, because every fallback shape is otherwise
// identical to real silence.
//
// Token alignment is by characters, not by whitespace words: whisper-cli emits
// one entry per TOKEN, and "bathroom." can be three of them.

import { isSileroAvailable, trimSilence } from './vad-silero.js'
import type { WhisperWord } from './whisper-local.js'

/** A sentence that starts this long after the last measured speech was decoded from silence. */
export const TAIL_SILENCE_MIN_SEC = 1.0
/** Below this mean token probability whisper is guessing. Calibrated on ten of
 *  Miles's real prompt chunks (2026-09-12, large-v3): trailing sentences scored
 *  0.72 to 1.00, one real sentence in a noisy room 0.43 — which is why this
 *  number never acts alone. */
export const TAIL_LOW_CONFIDENCE = 0.45
/** Never more than this many trailing sentences. */
export const TAIL_MAX_DROPS = 2
/** Only the last window of a long chunk is measured. The shared Silero instance
 *  is built with a 10 s buffer, and real prompt chunks are 2 to 7 s; a longer
 *  chunk's earlier speech is treated as unknown, which can only KEEP text. */
export const TAIL_WINDOW_SEC = 10

/**
 * Whole-sentence fillers. Each pattern is anchored at both ends so it matches a
 * sentence that IS the filler and nothing that merely contains its words.
 * "See you later" and "the end" are deliberately absent: both occur in real
 * dictation ("See you later." at the end of a message; "put the risks at the
 * end"), and whisper's inventions are the caption-credit shapes below.
 */
export const TAIL_FILLER_SENTENCES: readonly RegExp[] = [
  /^(?:thanks?|thank you)(?: (?:all|everyone|guys|so much|very much))? for (?:watching|listening)(?: .{0,30})?[.!]?$/i,
  /^(?:subtitles?|captions?|transcript(?:ion)?) (?:by|provided by|created by|from) .{1,60}$/i,
  /^(?:transcribed|translated) by .{1,60}$/i,
  /^(?:please )?(?:like(?:,)? (?:and )?)?(?:share(?:,)? (?:and )?)?subscribe(?: .{0,40})?[.!]?$/i,
  /^(?:don'?t|do not) forget to (?:like(?: and)? )?subscribe(?: .{0,40})?[.!]?$/i,
  /^(?:i(?:'ll| will)? )?see you(?: all| guys)? (?:next time|in the next (?:one|video|episode))[.!]?$/i,
  /^(?:i(?:'m| am) (?:going to|gonna) |i (?:need|have|got) to |i gotta |let me |gonna )?(?:go (?:to )?)?(?:the )?(?:bathroom|restroom|toilet)(?: (?:real quick|really quick|right quick|quick|now))?[.!]?$/i,
]

export interface SpeechWindows {
  /** True only when the VAD RAN over the audio (`TrimResult.measured`). */
  available: boolean
  /** Seconds from the start of the chunk to the end of the last speech the VAD
   *  heard. 0 when it measured the whole chunk and heard nothing; the window
   *  offset when only the tail was measured and it was silent; null when
   *  unavailable. */
  lastSpeechEndSec: number | null
  /** Share of the MEASURED audio that was speech. */
  speechRatio: number
  /** True when the whole chunk was measured, false when only its last
   *  `TAIL_WINDOW_SEC`. */
  whole: boolean
}

export const SPEECH_UNKNOWN: SpeechWindows = { available: false, lastSpeechEndSec: null, speechRatio: 0, whole: false }

const WAV_HEADER = 44
const VAD_SAMPLE_RATE = 16_000

/** The last `TAIL_WINDOW_SEC` of a 16 kHz mono 16-bit WAV, with a fresh header. */
function tailWindow(wav: Buffer): { wav: Buffer; offsetSec: number; whole: boolean } {
  if (wav.length <= WAV_HEADER) return { wav, offsetSec: 0, whole: true }
  const channels = wav.readUInt16LE(22)
  const rate = wav.readUInt32LE(24)
  const bits = wav.readUInt16LE(34)
  const blockAlign = Math.max(1, (channels * bits) / 8)
  if (rate !== VAD_SAMPLE_RATE || channels !== 1 || bits !== 16) return { wav, offsetSec: 0, whole: true }
  const bytesPerSec = rate * blockAlign
  const pcmBytes = wav.length - WAV_HEADER
  if (pcmBytes <= TAIL_WINDOW_SEC * bytesPerSec) return { wav, offsetSec: 0, whole: true }
  const tailBytes = Math.floor((TAIL_WINDOW_SEC * bytesPerSec) / blockAlign) * blockAlign
  const start = wav.length - tailBytes
  const out = Buffer.alloc(WAV_HEADER + tailBytes)
  wav.copy(out, 0, 0, WAV_HEADER)
  wav.copy(out, WAV_HEADER, start)
  out.writeUInt32LE(36 + tailBytes, 4)
  out.writeUInt32LE(tailBytes, 40)
  return { wav: out, offsetSec: (start - WAV_HEADER) / bytesPerSec, whole: false }
}

/** Where the VAD heard speech in (the tail of) this chunk. */
export function speechWindowsFromWav(wav: Buffer): SpeechWindows {
  if (!isSileroAvailable()) return SPEECH_UNKNOWN
  const window = tailWindow(wav)
  let result: ReturnType<typeof trimSilence>
  try {
    result = trimSilence(window.wav)
  } catch {
    return SPEECH_UNKNOWN
  }
  if (result.measured !== true) return SPEECH_UNKNOWN
  let lastEnd: number | null = null
  for (const seg of result.segments) {
    const end = (seg.startSample + seg.sampleCount) / VAD_SAMPLE_RATE + window.offsetSec
    if (lastEnd === null || end > lastEnd) lastEnd = end
  }
  return {
    available: true,
    lastSpeechEndSec: lastEnd ?? window.offsetSec,
    speechRatio: result.speechRatio,
    whole: window.whole,
  }
}

/** Sentence boundaries: a terminator followed by whitespace, except after an
 *  abbreviation or an initial. Decimals never split (no whitespace inside). */
export function splitSentences(text: string): string[] {
  const raw = text.trim().split(/(?<=[.!?])\s+(?=\S)/)
  const out: string[] = []
  for (const piece of raw) {
    const prev = out[out.length - 1]
    if (prev !== undefined && /(?:^|\s)(?:dr|mr|mrs|ms|jr|sr|st|vs|etc|e\.g|i\.e|a\.m|p\.m|no|[a-z])\.$/i.test(prev)) {
      out[out.length - 1] = `${prev} ${piece}`
    } else {
      out.push(piece)
    }
  }
  return out.filter(s => s.length > 0)
}

function normalizeSentence(sentence: string): string {
  return sentence.trim().replace(/^["'“”‘’(\[]+|["'“”‘’)\]]+$/g, '').replace(/\s+/g, ' ').trim()
}

/** Is this sentence, whole, a known filler? */
export function matchesTailLexicon(sentence: string): boolean {
  const s = normalizeSentence(sentence)
  return s.length > 0 && TAIL_FILLER_SENTENCES.some(re => re.test(s))
}

export interface TailTokenStats {
  startSec: number | null
  meanProbability: number | null
}

/**
 * The tokens that spell the last sentence, found by walking back from the end
 * until the accumulated non-space characters cover it. Returns nulls when the
 * tokens do not cover the text at all (alignment unknown): then rule (b) is
 * inert and the sentence stays.
 */
export function tailTokenStats(words: WhisperWord[] | undefined, sentence: string): TailTokenStats {
  const none = { startSec: null, meanProbability: null }
  if (!words || words.length === 0) return none
  const target = sentence.replace(/\s+/g, '').length
  if (target === 0) return none
  let acc = 0
  let i = words.length
  while (i > 0 && acc < target) {
    i--
    acc += String(words[i].word ?? '').replace(/\s+/g, '').length
  }
  if (acc < target) return none
  const slice = words.slice(i)
  let sum = 0
  let n = 0
  for (const w of slice) {
    if (typeof w.probability === 'number' && Number.isFinite(w.probability)) { sum += w.probability; n++ }
  }
  const start = typeof slice[0]?.start === 'number' && Number.isFinite(slice[0].start) ? slice[0].start : null
  return { startSec: start, meanProbability: n > 0 ? sum / n : null }
}

export type TailDropReason = 'lexicon' | 'low_confidence_after_speech'

export interface TailDrop {
  text: string
  reason: TailDropReason
  startSec: number | null
  meanProbability: number | null
}

export interface GuardedPromptTail {
  text: string
  dropped: TailDrop[]
  lastSpeechEndSec: number | null
}

export function guardPromptTail(input: { text: string; words?: WhisperWord[]; speech: SpeechWindows }): GuardedPromptTail {
  const sentences = splitSentences(input.text)
  const dropped: TailDrop[] = []
  const lastSpeechEnd = input.speech.available ? input.speech.lastSpeechEndSec : null
  while (sentences.length > 0 && dropped.length < TAIL_MAX_DROPS) {
    const last = sentences[sentences.length - 1]
    let reason: TailDropReason | null = null
    let stats: TailTokenStats = { startSec: null, meanProbability: null }
    if (matchesTailLexicon(last)) {
      reason = 'lexicon'
    } else if (lastSpeechEnd !== null) {
      stats = tailTokenStats(input.words, last)
      if (
        stats.startSec !== null && stats.meanProbability !== null
        && stats.startSec >= lastSpeechEnd + TAIL_SILENCE_MIN_SEC
        && stats.meanProbability < TAIL_LOW_CONFIDENCE
      ) {
        // The last sentence standing is kept unless the VAD measured the WHOLE
        // chunk and heard nothing in it: real speech somewhere means the
        // decoder's low confidence here is not enough to empty the prompt.
        const measuredSilentChunk = input.speech.whole && input.speech.speechRatio === 0
        if (sentences.length === 1 && !measuredSilentChunk) break
        reason = 'low_confidence_after_speech'
      }
    }
    if (!reason) break
    dropped.push({ text: last, reason, startSec: stats.startSec, meanProbability: stats.meanProbability })
    sentences.pop()
  }
  return { text: sentences.join(' '), dropped, lastSpeechEndSec: lastSpeechEnd }
}
