import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_BIN_MS,
  G2_BATCH_RELATIVE_MARGIN_S,
  G2_CHUNK_SPREAD_MAX_MS,
  G2_CHUNK_TAIL_MS,
  contentEvidence,
  contentEvidenceFromTrigrams,
  firefliesTimedWords,
  g2TimedWords,
  labelIntervals,
  median,
  normalizeWords,
  offsetBin,
  pythonFloorDiv,
  speechGaps,
  uniqueTrigrams,
} from './evidence.js'
import { firefliesMeeting, g2Capture, phrase, tokensForAnchors } from './__fixtures__/synthetic.js'

describe('normalizing', () => {
  it('lowercases, drops apostrophes and splits on everything else', () => {
    expect(normalizeWords("We'll review Q3 -- then stop.")).toEqual(['well', 'review', 'q3', 'then', 'stop'])
    expect(normalizeWords(undefined)).toEqual([])
  })
})

describe('unique trigrams', () => {
  it('keeps a phrase said once and drops one said twice', () => {
    const words = ['a', 'b', 'c', 'd', 'a', 'b', 'c'].map((token, i) => ({ token, timeMs: i * 1000 }))
    const unique = uniqueTrigrams(words)
    expect([...unique.keys()]).toEqual(['b\u0000c\u0000d', 'c\u0000d\u0000a', 'd\u0000a\u0000b'])
  })

  it('times a trigram at its middle word', () => {
    const words = ['a', 'b', 'c'].map((token, i) => ({ token, timeMs: i * 1000 }))
    expect(uniqueTrigrams(words).get('a\u0000b\u0000c')).toBe(1000)
  })
})

describe('binning', () => {
  it('floors the way Python floors', () => {
    expect(pythonFloorDiv(-1, 10_000)).toBe(-1)
    expect(pythonFloorDiv(0, 10_000)).toBe(0)
    expect(pythonFloorDiv(10_000, 10_000)).toBe(1)
    expect(pythonFloorDiv(-10_000, 10_000)).toBe(-1)
    // Literals, not the constant: a test written against EVIDENCE_BIN_MS moves with it and
    // pins nothing.
    expect(offsetBin(19_999)).toBe(1)
    expect(offsetBin(20_000)).toBe(2)
    expect(EVIDENCE_BIN_MS).toBe(10_000)
  })

  it('corrects a quotient that lands a hair under an integer, as CPython does', () => {
    // Found by comparing this algorithm with and without its correction against Python's
    // `//` over random pairs. Plain Math.floor((x - fmod) / y) answers 133193952230 here.
    expect(pythonFloorDiv(3.078450670676808e17, 2311254.091571415)).toBe(133193952231)
    expect(pythonFloorDiv(5.325757728208141e17, -1992003.901630179)).toBe(-267356792015)
  })
})

describe('content evidence', () => {
  it('counts one anchor per token past the second', () => {
    const spoken = phrase('token', 40, 60)
    const meeting = firefliesMeeting({ id: 'f', startMs: 0, durationS: 600, phrases: [spoken] })
    const capture = g2Capture({ sessionId: 's', startMs: 0, durationMs: 600_000, phrases: [spoken], offsetMs: 0 })
    const evidence = contentEvidence(g2TimedWords(capture).words, meeting.sentences)
    expect(spoken.tokens).toHaveLength(tokensForAnchors(40))
    expect(evidence.k).toBe(40)
    expect(evidence.offsetMs).toBe(0)
  })

  it('breaks a tie between two equally dense bins on the first one seen', () => {
    // Two bins of two anchors each; only the later bin has a neighbour, so whichever bin
    // wins is visible in K. Insertion order is the G2 trigram order, so the first wins.
    const g2 = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 0]])
    const fireflies = new Map([
      ['a', 1_000], ['b', 2_000],
      ['c', 50_000], ['d', 51_000],
      ['e', 61_000],
    ])
    expect(contentEvidenceFromTrigrams(g2, fireflies).offsetMs).toBe(0)
    expect(contentEvidenceFromTrigrams(g2, fireflies).k).toBe(2)
  })

  it('adds the neighbouring bins to the densest one', () => {
    const g2 = new Map([['x', 0], ['y', 0], ['z', 0], ['w', 0]])
    const fireflies = new Map([
      ['x', EVIDENCE_BIN_MS * 1.5],
      ['y', EVIDENCE_BIN_MS * 1.6],
      ['z', EVIDENCE_BIN_MS * 0.5],
      ['w', EVIDENCE_BIN_MS * 2.5],
    ])
    expect(contentEvidence([], []).k).toBe(0)
    const combined = contentEvidenceFromTrigrams(g2, fireflies)
    expect(combined.k).toBe(4)
    expect(combined.offsetMs).toBe(EVIDENCE_BIN_MS)
  })

  it('counts only the anchors inside the band, and reports what it threw out', () => {
    // Two anchors where the clocks say the meeting is, and three stacked in one bin a long
    // way off — the shape of boilerplate shared with a different meeting.
    const g2 = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 0]])
    const fireflies = new Map([
      ['a', 100_000], ['b', 102_000],
      ['c', 900_000], ['d', 902_000], ['e', 904_000],
    ])
    const band = { centreMs: 100_000, halfWidthMs: 300_000 }

    // Without the band the contaminating bin wins outright, K and all.
    const unbanded = contentEvidenceFromTrigrams(g2, fireflies)
    expect([unbanded.k, unbanded.offsetMs, unbanded.outsideBand]).toEqual([3, 900_000, 0])

    const banded = contentEvidenceFromTrigrams(g2, fireflies, EVIDENCE_BIN_MS, band)
    expect([banded.k, banded.offsetMs, banded.outsideBand]).toEqual([2, 100_000, 3])
  })

  it('keeps an anchor exactly on the band edge and drops the next millisecond', () => {
    const g2 = new Map([['edge', 0], ['past', 0]])
    const band = { centreMs: 0, halfWidthMs: 300_000 }
    expect(contentEvidenceFromTrigrams(g2, new Map([['edge', 300_000]]), EVIDENCE_BIN_MS, band).outsideBand).toBe(0)
    expect(contentEvidenceFromTrigrams(g2, new Map([['past', 300_001]]), EVIDENCE_BIN_MS, band).outsideBand).toBe(1)
  })

  it('finds nothing in common between two different conversations', () => {
    const mine = phrase('mine', 40, 60)
    const theirs = phrase('theirs', 40, 60)
    const meeting = firefliesMeeting({ id: 'f', startMs: 0, durationS: 600, phrases: [theirs] })
    const capture = g2Capture({ sessionId: 's', startMs: 0, durationMs: 600_000, phrases: [mine], offsetMs: 0 })
    expect(contentEvidence(g2TimedWords(capture).words, meeting.sentences).k).toBe(0)
  })
})

describe('G2 word times', () => {
  it('reads batch words as relative to their segment', () => {
    const capture = g2Capture({ sessionId: 's', startMs: 0, durationMs: 600_000, phrases: [phrase('w', 5, 60)], offsetMs: 0 })
    const { mode, words } = g2TimedWords(capture)
    expect(mode).toBe('batch_relative')
    expect(words).toHaveLength(tokensForAnchors(5))
  })

  it('reads them as absolute when they sit past their segment', () => {
    const capture = {
      sessionId: 's',
      startMs: 0,
      durationMs: 600_000,
      batchSegments: [{ startElapsed: 0, endElapsed: 1000, words: [{ word: 'alpha', start: 600 }, { word: 'beta', start: 620 }] }],
    }
    expect(g2TimedWords(capture).mode).toBe('batch_absolute')
  })

  it('takes the segment\'s own length plus five seconds as the dividing line', () => {
    // A one-second segment: a word at 6.0 s is still called relative, at 6.001 s absolute.
    const at = (start: number) => g2TimedWords({
      sessionId: 's',
      startMs: 0,
      durationMs: 1000,
      batchSegments: [{ startElapsed: 0, endElapsed: 1000, words: [{ word: 'a', start }] }],
    }).mode
    expect(at(6)).toBe('batch_relative')
    expect(at(6.001)).toBe('batch_absolute')
    expect(G2_BATCH_RELATIVE_MARGIN_S).toBe(5)
  })

  it('falls back to spreading chunk text when no batch pass ran', () => {
    const capture = {
      sessionId: 's',
      startMs: 0,
      durationMs: 600_000,
      chunks: [
        { text: 'alpha beta', speaker: 'A', elapsed: 0 },
        { text: 'gamma delta', speaker: 'A', elapsed: 4000 },
      ],
    }
    const { mode, words } = g2TimedWords(capture)
    expect(mode).toBe('chunks')
    expect(words.map(word => word.token)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(words[0].timeMs).toBe(1000)
    // The last chunk has no successor, so it spreads over the nominal six-second tail.
    expect(words[2].timeMs).toBe(5500)
    expect(G2_CHUNK_TAIL_MS).toBe(6_000)
  })

  it('never spreads one chunk further than twelve seconds', () => {
    const capture = {
      sessionId: 's',
      startMs: 0,
      durationMs: 600_000,
      chunks: [{ text: 'alpha beta', speaker: 'A', elapsed: 0 }, { text: 'gamma', speaker: 'A', elapsed: 600_000 }],
    }
    expect(g2TimedWords(capture).words[1].timeMs).toBe(9_000)
    expect(G2_CHUNK_SPREAD_MAX_MS).toBe(12_000)
  })
})

describe('Fireflies word times', () => {
  it('spreads a sentence\'s words inside its own start and end', () => {
    const words = firefliesTimedWords([{ text: 'alpha beta', start_time: 10, end_time: 12 }])
    expect(words.map(word => word.timeMs)).toEqual([10_500, 11_500])
  })
})

describe('silences', () => {
  it('reports a gap between consecutive sentences and ignores a shorter one', () => {
    const sentences = [
      { text: 'a', start_time: 0, end_time: 10 },
      { text: 'b', start_time: 100, end_time: 110 },
      { text: 'c', start_time: 120, end_time: 130 },
    ]
    expect(speechGaps(sentences, 90)).toEqual([{ startS: 10, endS: 100 }])
    expect(speechGaps(sentences, 5)).toEqual([{ startS: 10, endS: 100 }, { startS: 110, endS: 120 }])
  })
})

describe('label intervals', () => {
  it('runs each label to the next one and the last to the tail', () => {
    const capture = {
      sessionId: 's',
      startMs: 0,
      durationMs: 600_000,
      chunks: [
        { text: 'x', speaker: 'A', elapsed: 0, similarity: 0.8 },
        { text: 'y', speaker: 'B', elapsed: 5000, similarity: 0.6, speakerCorrectionBatchId: 'b1' },
      ],
    }
    expect(labelIntervals(capture)).toEqual([
      { startMs: 0, endMs: 5000, speaker: 'A', similarity: 0.8, humanConfirmed: false },
      { startMs: 5000, endMs: 11_000, speaker: 'B', similarity: 0.6, humanConfirmed: true },
    ])
  })
})

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
  })
})
