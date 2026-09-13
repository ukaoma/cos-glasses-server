import { describe, expect, it } from 'vitest'
import {
  guardPromptTail, splitSentences, TAIL_LOW_CONFIDENCE, TAIL_SILENCE_MIN_SEC, type SpeechWindows,
} from './prompt-tail-guard.js'
import type { WhisperWord } from './whisper-local.js'

/** Decoder words for a text, one per whitespace token, laid out at `secondsPerWord`. */
function wordsFor(text: string, opts: { startSec?: number; secondsPerWord?: number; probability?: number; tailFrom?: number; tailProbability?: number; tailStartSec?: number } = {}): WhisperWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  const per = opts.secondsPerWord ?? 0.3
  let t = opts.startSec ?? 0
  return tokens.map((word, i) => {
    const inTail = opts.tailFrom !== undefined && i >= opts.tailFrom
    if (inTail && i === opts.tailFrom && opts.tailStartSec !== undefined) t = opts.tailStartSec
    const w = { word, start: t, end: t + per, probability: inTail ? (opts.tailProbability ?? opts.probability ?? 0.9) : (opts.probability ?? 0.9) }
    t += per
    return w
  })
}
const speech = (lastSpeechEndSec: number | null, available = true): SpeechWindows => ({ available, lastSpeechEndSec, speechRatio: lastSpeechEndSec ? 0.6 : 0 })

const CHRIS = "I have a lot of contacts. Text built into a folder that I'm using with this GotCOS structure. How do I get that tied into this so that when I use the app Ask COS feature. It references all of the previous contacts that I have within that folder. I'm going to go to the bathroom."
const CHRIS_KEPT = "I have a lot of contacts. Text built into a folder that I'm using with this GotCOS structure. How do I get that tied into this so that when I use the app Ask COS feature. It references all of the previous contacts that I have within that folder."

describe('splitSentences', () => {
  it('keeps punctuation and treats an unterminated tail as its own sentence', () => {
    expect(splitSentences('One. Two! Three? four')).toEqual(['One.', 'Two!', 'Three?', 'four'])
    expect(splitSentences('')).toEqual([])
  })
})

describe('the invented trailing sentence (6.45.4)', () => {
  it("drops Chris's bathroom sentence on the lexicon alone, whatever the decoder thought of it", () => {
    const result = guardPromptTail({ text: CHRIS, words: wordsFor(CHRIS, { probability: 0.95 }), speech: speech(null, false) })
    expect(result.text).toBe(CHRIS_KEPT)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({ reason: 'lexicon', text: "I'm going to go to the bathroom." })
  })

  it('drops a novel sentence only when it sits past the last speech window AND the decoder was unsure', () => {
    const text = 'Book the room for Tuesday at ten. The cat sat on the mat.'
    const tailFrom = 7 // "The cat sat on the mat." is the last six words
    const past = wordsFor(text, { tailFrom, tailStartSec: 8.0, tailProbability: 0.3 })
    const dropped = guardPromptTail({ text, words: past, speech: speech(6.5) })
    expect(dropped.text).toBe('Book the room for Tuesday at ten.')
    expect(dropped.dropped[0]).toMatchObject({ reason: 'low_confidence_after_speech', startSec: 8.0 })

    // Same words, but the decoder was confident: kept.
    const confident = wordsFor(text, { tailFrom, tailStartSec: 8.0, tailProbability: 0.9 })
    expect(guardPromptTail({ text, words: confident, speech: speech(6.5) }).text).toBe(text)

    // Same words, unsure, but the sentence overlaps speech (starts before end + 1 s): kept.
    const overlapping = wordsFor(text, { tailFrom, tailStartSec: 6.5 + TAIL_SILENCE_MIN_SEC - 0.1, tailProbability: 0.3 })
    expect(guardPromptTail({ text, words: overlapping, speech: speech(6.5) }).text).toBe(text)
  })

  it('never drops a non-lexicon sentence when VAD is unavailable or the decoder gave no words', () => {
    const text = 'Book the room for Tuesday at ten. The cat sat on the mat.'
    expect(guardPromptTail({ text, words: wordsFor(text, { tailFrom: 7, tailStartSec: 8, tailProbability: 0.1 }), speech: speech(null, false) }).text).toBe(text)
    expect(guardPromptTail({ text, words: undefined, speech: speech(6.5) }).text).toBe(text)
  })

  it('a chunk with no speech window and an unsure decode is invention end to end; a confident one stays', () => {
    const text = 'Thank you.'
    const unsure = guardPromptTail({ text: 'The weather is nice today.', words: wordsFor('The weather is nice today.', { probability: 0.2 }), speech: { available: true, lastSpeechEndSec: null, speechRatio: 0 } })
    expect(unsure.text).toBe('')
    expect(unsure.dropped[0].reason).toBe('no_speech_low_confidence')
    const confident = guardPromptTail({ text: 'Send it.', words: wordsFor('Send it.', { probability: 0.9 }), speech: { available: true, lastSpeechEndSec: null, speechRatio: 0 } })
    expect(confident.text).toBe('Send it.')
    expect(text.length).toBeGreaterThan(0)
  })

  it('drops at most two trailing sentences and never eats the body', () => {
    const text = 'Real one. Real two. Thanks for watching. See you next time. The end.'
    const result = guardPromptTail({ text, words: wordsFor(text), speech: speech(2.0) })
    expect(result.dropped).toHaveLength(2)
    expect(result.text).toBe('Real one. Real two. Thanks for watching.')
  })

  it('leaves a real closing phrase alone', () => {
    const text = 'Draft the reply and send it to Gina. Thanks, that is all for now.'
    const result = guardPromptTail({ text, words: wordsFor(text, { probability: 0.85 }), speech: speech(5.0) })
    expect(result.text).toBe(text)
    expect(result.dropped).toEqual([])
    expect(TAIL_LOW_CONFIDENCE).toBeLessThan(0.85)
  })
})

describe('the prompt-draft decode runs the guard (6.45.4)', () => {
  it('guards every chunk decode before the transcript is sanitized, and an empty guarded text is no speech', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../routes/prompt-drafts.ts', import.meta.url), 'utf8')
    const job = src.slice(src.indexOf('const result = await transcribeAudioBuffer(audio, { mode, policy })'), src.indexOf('await markPromptDraftChunkTranscript(draftId, chunkIndex, record, purpose)'))
    expect(job).toContain('guardPromptTail({ text: result.text, words: result.words, speech: speechWindowsFromWav(audio) })')
    expect(job).toContain("throw new NoSpeechDetectedError(result.text)")
    expect(job).toContain('sanitizeTranscript(draftId, guarded.text)')
    const audio = readFileSync(new URL('./transcribe-audio.ts', import.meta.url), 'utf8')
    expect((audio.match(/words = result\.words/g) ?? []).length).toBe(3)
  })
})

