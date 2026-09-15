import { describe, expect, it } from 'vitest'
import {
  ALIGN_MAX_MAD_MS,
  ALIGN_MIN_ANCHORS,
  ALIGN_WINDOW_MIN_ANCHORS,
  ALIGN_WINDOW_MS,
  alignRecording,
  offsetAt,
  sentenceStartAnchors,
  windowOffsets,
} from './align.js'
import { g2TimedWords } from './evidence.js'
import { firefliesMeeting, g2Capture, phrase } from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 15, 0, 0)

/** `count` same-shaped sentences, and a capture of them with the given per-sentence offsets. */
function pair(count: number, phraseOffsetsMs?: number[]) {
  const phrases = Array.from({ length: count }, (_, i) => phrase(`p${i}`, 6, 60 + i * 60, 12))
  const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: 1800, phrases })
  const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: 1_800_000, phrases, offsetMs: 0, phraseOffsetsMs })
  return { meeting, capture, words: g2TimedWords(capture).words }
}

describe('alignment anchors', () => {
  it('needs eight sentence starts, and refuses at seven', () => {
    const eight = pair(ALIGN_MIN_ANCHORS)
    const seven = pair(ALIGN_MIN_ANCHORS - 1)
    const aligned = alignRecording(eight.words, eight.meeting.sentences, 0)
    const refused = alignRecording(seven.words, seven.meeting.sentences, 0)
    expect(aligned.anchors).toBe(8)
    expect(aligned.aligned).toBe(true)
    expect(refused.anchors).toBe(7)
    expect(refused.aligned).toBe(false)
    expect(refused.madMs).toBeNull()
  })

  it('aligns at a spread of exactly 3.5 s and refuses at 3.51 s', () => {
    // Literal milliseconds, not ALIGN_MAX_MAD_MS: a test written against the threshold
    // moves with it and would pass at any value.
    const spreads = (deviationMs: number) => [0, 0, 0, 0, deviationMs * 2, deviationMs * 2, deviationMs * 2, deviationMs * 2]
    const atLimit = pair(8, spreads(3500))
    const past = pair(8, spreads(3510))
    const atLimitResult = alignRecording(atLimit.words, atLimit.meeting.sentences, 3500)
    const pastResult = alignRecording(past.words, past.meeting.sentences, 3500)
    expect(atLimitResult.madMs).toBe(3500)
    expect(atLimitResult.aligned).toBe(true)
    expect(pastResult.madMs).toBe(3510)
    expect(pastResult.aligned).toBe(false)
    expect(ALIGN_MAX_MAD_MS).toBe(3500)
  })

  it('ignores anchors outside the band around the coarse offset', () => {
    const { words, meeting } = pair(ALIGN_MIN_ANCHORS)
    const far = sentenceStartAnchors(words, meeting.sentences, 10 * 60 * 1000)
    expect(far).toHaveLength(0)
  })
})

describe('per-window offsets', () => {
  it('measures each window on its own anchors', () => {
    // 120 s as a literal: anchors either side of the two-minute line must land in
    // different windows.
    const anchors = [
      ...Array.from({ length: 3 }, (_, i) => ({ g2Ms: 1000 + i, offsetMs: 100 })),
      ...Array.from({ length: 3 }, (_, i) => ({ g2Ms: 121_000 + i, offsetMs: 900 })),
    ]
    const windows = windowOffsets(anchors)
    expect(windows.get(0)).toBe(100)
    expect(windows.get(1)).toBe(900)
    expect(ALIGN_WINDOW_MS).toBe(120_000)
  })

  it('lets a window with too few anchors inherit its neighbour', () => {
    const anchors = [
      ...Array.from({ length: ALIGN_WINDOW_MIN_ANCHORS }, (_, i) => ({ g2Ms: 1000 + i, offsetMs: 100 })),
      // One lonely anchor in the next window: not enough to measure with.
      { g2Ms: ALIGN_WINDOW_MS + 1000, offsetMs: 50_000 },
    ]
    const windows = windowOffsets(anchors)
    expect(windows.get(1)).toBe(100)
    expect(windows.size).toBe(2)
  })

  it('falls back to the whole-meeting offset where no window measured', () => {
    const alignment = {
      aligned: true,
      anchors: 8,
      madMs: 0,
      offsetMs: 250,
      samples: [],
      windows: new Map<number, number>(),
    }
    expect(offsetAt(alignment, 5 * ALIGN_WINDOW_MS)).toBe(250)
  })
})
