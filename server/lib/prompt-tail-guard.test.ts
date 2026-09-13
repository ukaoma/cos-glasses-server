// Executed, not read: every rule runs against text, tokens and speech windows.
import { describe, expect, it } from 'vitest'
import {
  SPEECH_UNKNOWN, TAIL_LOW_CONFIDENCE, TAIL_MAX_DROPS, TAIL_SILENCE_MIN_SEC,
  guardPromptTail, matchesTailLexicon, splitSentences, tailTokenStats, type SpeechWindows,
} from './prompt-tail-guard.js'
import type { WhisperWord } from './whisper-local.js'

/** whisper-cli tokens: one entry per TOKEN, so a word may be several pieces.
 *  `spec` is "piece@start:p" separated by spaces; a piece with a leading '+'
 *  continues the previous word (subword). */
function tokens(spec: string, endStep = 0.2): WhisperWord[] {
  return spec.split(/\s+/).filter(Boolean).map(item => {
    const m = /^(\+?)(.+?)@([\d.]+):([\d.]+)$/.exec(item)
    if (!m) throw new Error(`bad token spec ${item}`)
    const start = Number(m[3])
    return { word: m[2], start, end: start + endStep, probability: Number(m[4]) }
  })
}
const measured = (lastSpeechEndSec: number, speechRatio = 0.5, whole = true): SpeechWindows => ({ available: true, lastSpeechEndSec, speechRatio, whole })

describe('rule (a): whole-sentence fillers', () => {
  it("drops Chris's trailing bathroom line and keeps his prompt", () => {
    const r = guardPromptTail({ text: 'Pull up my contacts for the Austin trip. I\'m going to go to the bathroom.', speech: SPEECH_UNKNOWN })
    expect(r.text).toBe('Pull up my contacts for the Austin trip.')
    expect(r.dropped).toEqual([{ text: "I'm going to go to the bathroom.", reason: 'lexicon', startSec: null, meanProbability: null }])
  })

  it('drops the caption credits whisper invents, as whole sentences', () => {
    for (const filler of [
      'Thanks for watching!', 'Thank you for listening.', 'Thank you so much for watching.',
      'Subtitles by the Amara.org community', 'Transcribed by ESO, translated by —',
      'See you in the next video.', "I'll see you next time.",
      "Don't forget to like and subscribe.", 'Please subscribe to my channel.',
      'I need to go to the bathroom.', 'Gonna go to the restroom real quick.',
    ]) {
      expect(matchesTailLexicon(filler), filler).toBe(true)
    }
  })

  it('never matches a real sentence that merely contains the filler words (QA 2026-09-12)', () => {
    const real = [
      'Summarize the Bottle POS notes and put the risks at the end.',
      'Move the pricing table to the end.',
      'Reply to Niala and say I will see you next time we are both in Austin.',
      'Write the intro for the webinar about thanks for watching screens.',
      'Tell Silas I will send the model tonight. See you later.',
      'Remind me to book the flight. That is the end.',
      'Ask Graham for the demand gen plan. I will see you in the morning.',
      "Remind me I'm going to go to the bathroom before the call.",
      'Send the deck to Chris. Thanks.',
    ]
    for (const text of real) {
      const r = guardPromptTail({ text, speech: SPEECH_UNKNOWN })
      expect(r.text, text).toBe(text)
      expect(r.dropped).toEqual([])
    }
  })

  it('a one-sentence chunk that is only a filler empties, and that is the only way the lexicon empties a chunk', () => {
    expect(guardPromptTail({ text: 'Thanks for watching.', speech: SPEECH_UNKNOWN })).toMatchObject({ text: '', dropped: [{ reason: 'lexicon' }] })
  })
})

describe('rule (b): silence plus low confidence, on whisper TOKENS', () => {
  // "Send the deck to Chris." spoken 0.0–1.6 s; "I will grab the other fold er ."
  // — a NOVEL sentence no lexicon knows — decoded from silence starting 4.5 s,
  // split into subword tokens.
  const spoken = 'Send@0.0:0.9 the@0.3:0.9 deck@0.5:0.9 to@0.9:0.9 Chris@1.1:0.8 .@1.5:0.9'
  const invented = 'I@4.5:0.3 will@4.6:0.2 grab@4.8:0.2 the@5.0:0.2 other@5.1:0.2 +fold@5.2:0.2 +er@5.4:0.2 .@5.6:0.2'
  const text = 'Send the deck to Chris. I will grab the other folder.'

  it('aligns the last sentence by characters across subword tokens', () => {
    const stats = tailTokenStats(tokens(`${spoken} ${invented}`), 'I will grab the other folder.')
    expect(stats.startSec).toBeCloseTo(4.5, 5)
    expect(stats.meanProbability).toBeCloseTo((0.3 + 0.2 * 7) / 8, 5)
  })

  it('drops a low-confidence sentence that starts a second after the last speech', () => {
    const r = guardPromptTail({ text, words: tokens(`${spoken} ${invented}`), speech: measured(1.7) })
    expect(r.text).toBe('Send the deck to Chris.')
    expect(r.dropped[0]).toMatchObject({ reason: 'low_confidence_after_speech', startSec: 4.5 })
    expect(r.dropped[0].meanProbability!).toBeLessThan(TAIL_LOW_CONFIDENCE)
  })

  it('keeps the same sentence when the decoder was confident, or when it overlaps speech', () => {
    const confident = invented.replace(/:0\.[23]/g, ':0.85')
    expect(guardPromptTail({ text, words: tokens(`${spoken} ${confident}`), speech: measured(1.7) }).text).toBe(text)
    // last speech ended at 4.0 s: the sentence starts 0.5 s later, under TAIL_SILENCE_MIN_SEC
    expect(guardPromptTail({ text, words: tokens(`${spoken} ${invented}`), speech: measured(4.5 - TAIL_SILENCE_MIN_SEC + 0.5) }).text).toBe(text)
  })

  it('never empties a chunk in which the VAD heard speech, even if its only sentence is low-confidence', () => {
    const r = guardPromptTail({ text: 'I will grab the other folder.', words: tokens(invented), speech: measured(1.7, 0.3, true) })
    expect(r.text).toBe('I will grab the other folder.')
    expect(r.dropped).toEqual([])
  })

  it('empties a chunk only when the VAD measured the WHOLE chunk as silence and the decoder was unsure', () => {
    const silentChunk: SpeechWindows = { available: true, lastSpeechEndSec: 0, speechRatio: 0, whole: true }
    expect(guardPromptTail({ text: 'Thank you very much.', words: tokens('Thank@1.2:0.2 you@1.4:0.2 very@1.6:0.2 much@1.8:0.2 .@2.0:0.2'), speech: silentChunk }).text).toBe('')
    // measured silence but a CONFIDENT decode stays: one signal is not enough
    expect(guardPromptTail({ text: 'Thank you very much.', words: tokens('Thank@1.2:0.9 you@1.4:0.9 very@1.6:0.9 much@1.8:0.9 .@2.0:0.9'), speech: silentChunk }).text).toBe('Thank you very much.')
    // only the TAIL measured silent (long chunk): unknown earlier speech, never emptied
    const tailOnly: SpeechWindows = { available: true, lastSpeechEndSec: 2.0, speechRatio: 0, whole: false }
    expect(guardPromptTail({ text: 'Thank you very much.', words: tokens('Thank@3.2:0.2 you@3.4:0.2 very@3.6:0.2 much@3.8:0.2 .@4.0:0.2'), speech: tailOnly }).text).toBe('Thank you very much.')
  })

  it('is inert without a measured VAD or without tokens that cover the text', () => {
    expect(guardPromptTail({ text, words: tokens(`${spoken} ${invented}`), speech: SPEECH_UNKNOWN }).text).toBe(text)
    expect(guardPromptTail({ text, speech: measured(1.7) }).text).toBe(text)
    // tokens for a different, shorter text: alignment unknown -> kept
    expect(guardPromptTail({ text, words: tokens('Hi@4.5:0.1'), speech: measured(1.7) }).text).toBe(text)
  })

  it(`drops at most ${TAIL_MAX_DROPS} trailing sentences`, () => {
    const three = `${text} Bye now. See you.`
    const words = tokens(`${spoken} ${invented} Bye@6.0:0.2 now@6.2:0.2 .@6.3:0.2 See@6.5:0.2 you@6.7:0.2 .@6.8:0.2`)
    const r = guardPromptTail({ text: three, words, speech: measured(1.7) })
    expect(r.dropped).toHaveLength(TAIL_MAX_DROPS)
    expect(r.text).toBe('Send the deck to Chris. I will grab the other folder.')
  })
})

describe('splitSentences', () => {
  it('does not split decimals, abbreviations or initials', () => {
    expect(splitSentences('Set the budget to 1.5 million. Tell Dr. Smith at 9 a.m. tomorrow. J. Sokolic signs.'))
      .toEqual(['Set the budget to 1.5 million.', 'Tell Dr. Smith at 9 a.m. tomorrow.', 'J. Sokolic signs.'])
    expect(splitSentences('One! Two? Three.')).toEqual(['One!', 'Two?', 'Three.'])
  })
})
