import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_MIN_SHARE,
  ATTRIBUTE_MIN_SIMILARITY,
  attributeSentences,
  isGenericLabel,
  namesAgree,
} from './attribute.js'
import { alignRecording } from './align.js'
import { type G2RecordingInput, g2TimedWords, labelIntervals } from './evidence.js'
import { UNATTRIBUTED } from '../meeting-speaker-review.js'
import { type CaptureLabel, firefliesMeeting, g2Capture, phrase } from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 15, 0, 0)
const G2_NAME = 'Nadia Okonkwo'

/**
 * Ten sentences (enough to align) whose speaker label the test chooses, with G2 chunk
 * labels laid over them.
 */
function scene(options: { ffLabel: string; labels: CaptureLabel[] }) {
  const phrases = Array.from({ length: 10 }, (_, i) => ({ ...phrase(`p${i}`, 6, 100 + i * 10, 10), speaker: options.ffLabel }))
  const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: 1800, phrases })
  // A chunk owns the time until the NEXT chunk, and the last one owns six seconds. Without
  // a closing label the chunk under test would cover six seconds of a thirty-minute
  // capture, and every sentence would come back unattributed for the wrong reason.
  const labels = [...options.labels, { speaker: 'Closing Speaker', startS: 1000, similarity: 0.9 }]
  const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: 1_800_000, phrases, offsetMs: 0, labels })
  return { meeting, capture }
}

function attribute(meeting: ReturnType<typeof scene>['meeting'], capture: G2RecordingInput, mode?: 'relabel' | 'capture_only') {
  const alignment = alignRecording(g2TimedWords(capture).words, meeting.sentences, 0)
  expect(alignment.aligned).toBe(true)
  return attributeSentences(meeting.sentences, [{ sessionId: capture.sessionId, alignment, labels: labelIntervals(capture) }], mode)
}

describe('generic labels', () => {
  it('covers every label the server treats as unattributed', () => {
    for (const label of UNATTRIBUTED) expect(isGenericLabel(label)).toBe(true)
    expect(isGenericLabel('Unidentified 3')).toBe(true)
    expect(isGenericLabel('Speaker 12')).toBe(true)
    expect(isGenericLabel(G2_NAME)).toBe(false)
  })

  it('names a sentence whose Fireflies label asserts no identity', () => {
    const { meeting, capture } = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.9 }] })
    const result = attribute(meeting, capture)
    expect(result.labels.every(label => label.outcome === 'replaced_generic')).toBe(true)
    expect(result.labels[0].resolvedLabel).toBe(G2_NAME)
    expect(result.verification).toEqual([{ name: G2_NAME, medianSimilarity: 0.9, sentences: 10, humanConfirmed: false }])
  })

  it('never lets a generic G2 label win, however confident the voiceprint', () => {
    const { meeting, capture } = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: 'Speaker 2', startS: 0, similarity: 0.99 }] })
    const result = attribute(meeting, capture)
    expect(result.labels[0].outcome).toBe('kept')
    expect(result.labels[0].keptReason).toBe('generic_g2')
    expect(result.labels[0].resolvedLabel).toBe('Speaker 1')
  })
})

describe('the voice-match floor', () => {
  it('names at 0.55 and keeps the Fireflies label at 0.54', () => {
    const at = (similarity: number) => {
      const { meeting, capture } = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity }] })
      return attribute(meeting, capture).labels[0]
    }
    expect(at(0.55).outcome).toBe('replaced_generic')
    expect(at(0.54).outcome).toBe('kept')
    expect(at(0.54).keptReason).toBe('low_similarity')
    expect(ATTRIBUTE_MIN_SIMILARITY).toBe(0.55)
  })

  it('accepts a name a person confirmed, whatever the similarity says', () => {
    const confirmed = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.2, humanConfirmed: true }] })
    const guessed = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.2 }] })
    const confirmedResult = attribute(confirmed.meeting, confirmed.capture)
    expect(confirmedResult.labels[0].outcome).toBe('replaced_generic')
    expect(confirmedResult.labels[0].humanConfirmed).toBe(true)
    expect(attribute(guessed.meeting, guessed.capture).labels[0].outcome).toBe('kept')
  })
})

describe('the share gate', () => {
  /**
   * Straight against the label intervals, with an offset of zero.
   *
   * Going through `alignRecording` would move the window by the anchor bias — a sentence's
   * start time is compared with its first trigram's MIDDLE word — which is real engine
   * behaviour but would stop this test from measuring the share boundary it is named for.
   */
  function splitAt(splitS: number) {
    const sentences = [{ text: 'one two three', speaker_name: 'Speaker 1', start_time: 100, end_time: 110 }]
    const alignment = { aligned: true, anchors: 8, madMs: 0, offsetMs: 0, samples: [], windows: new Map<number, number>() }
    const labels = [
      { startMs: 100_000, endMs: splitS * 1000, speaker: G2_NAME, similarity: 0.9, humanConfirmed: false },
      { startMs: splitS * 1000, endMs: 110_000, speaker: 'Marcus Bell', similarity: 0.9, humanConfirmed: false },
    ]
    return attributeSentences(sentences, [{ sessionId: 's1', alignment, labels }]).labels[0]
  }

  it('names at exactly 0.60 of the sentence and keeps the label at 0.59', () => {
    const atLimit = splitAt(106)
    const below = splitAt(105.9)
    expect(atLimit.share).toBeCloseTo(ATTRIBUTE_MIN_SHARE, 10)
    expect(atLimit.outcome).toBe('replaced_generic')
    expect(below.share).toBeCloseTo(0.59, 10)
    expect(below.outcome).toBe('kept')
    expect(below.keptReason).toBe('low_share')
  })
})

describe('when both sides have a name', () => {
  it('records agreement on a shared name token', () => {
    expect(namesAgree('Nadia Okonkwo', 'nadia.okonkwo')).toBe(true)
    expect(namesAgree('Nadia Okonkwo', 'Marcus Bell')).toBe(false)
    const { meeting, capture } = scene({ ffLabel: 'Nadia O', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.9 }] })
    const result = attribute(meeting, capture)
    expect(result.labels[0].outcome).toBe('agree')
    expect(result.labels[0].resolvedLabel).toBe('Nadia O')
  })

  it('does not call two people the same on a one-letter token', () => {
    // "Marcus O" and "Nadia O" share only "o". A name token has to be three characters
    // before it may stand for a person.
    const { meeting, capture } = scene({ ffLabel: 'Marcus O', labels: [{ speaker: 'Nadia O', startS: 0, similarity: 0.95 }] })
    const result = attribute(meeting, capture)
    expect(namesAgree('Nadia O', 'Marcus O')).toBe(false)
    expect(result.labels[0].outcome).toBe('conflict')
    expect(result.labels[0].resolvedLabel).toBe('Marcus O')
  })

  it('keeps the Fireflies label on a conflict and records it', () => {
    const { meeting, capture } = scene({ ffLabel: 'Marcus Bell', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.95 }] })
    const result = attribute(meeting, capture)
    expect(result.labels[0].outcome).toBe('conflict')
    expect(result.labels[0].resolvedLabel).toBe('Marcus Bell')
    expect(result.labels[0].g2Label).toBe(G2_NAME)
    expect(result.conflicts).toHaveLength(10)
  })
})

describe('modes and unaligned captures', () => {
  it('relabels nothing in capture_only mode', () => {
    const { meeting, capture } = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.99 }] })
    const result = attribute(meeting, capture, 'capture_only')
    expect(result.labels.every(label => label.resolvedLabel === 'Speaker 1')).toBe(true)
    expect(result.labels.every(label => label.keptReason === 'capture_only')).toBe(true)
    expect(result.verification).toEqual([])
  })

  it('relabels nothing from a capture that did not align', () => {
    const { meeting, capture } = scene({ ffLabel: 'Speaker 1', labels: [{ speaker: G2_NAME, startS: 0, similarity: 0.99 }] })
    const unaligned = { aligned: false, anchors: 2, madMs: null, offsetMs: null, samples: [], windows: new Map<number, number>() }
    const result = attributeSentences(meeting.sentences, [{ sessionId: capture.sessionId, alignment: unaligned, labels: labelIntervals(capture) }])
    expect(result.labels.every(label => label.outcome === 'kept' && label.keptReason === 'no_g2_audio')).toBe(true)
  })
})
