// How long each voice actually spoke.
//
// Two measurements, because the sidecar does not always carry both. When the HQ
// batch pass has run it leaves per-word {start, end, speaker}, which is real
// VOICED time — silence is excluded by construction. Without it we fall back to
// wall-clock deltas between chunks, capped at the capture ceiling.
//
// THE TRAP THIS FILE PINS. Word intervals overlap, within a segment and across
// the overlapping batch windows. Measured over six real meetings, naively
// summing word durations totals 1.20x to 1.50x the meeting's own duration —
// impossible for voiced time. Union counts overlap once and lands at 0.75x to
// 0.97x. And uncapped chunk deltas credit every silence to whoever spoke last:
// on 2026-08-04 "Design Gaps" that turns 8.1 minutes of speech into 50.2.

import { describe, expect, it } from 'vitest'
import {
  CHUNK_CEILING_MS,
  creditedChunkMs,
  reviewMeetingSpeakers,
  speakerWordMs,
  unionMs,
  type ReviewChunk,
  type SpeakerWordSegment,
} from './meeting-speaker-review.js'

describe('unionMs', () => {
  it('counts overlap once', () => {
    expect(unionMs([[0, 10], [5, 15]])).toBe(15)
  })
  it('sums disjoint intervals', () => {
    expect(unionMs([[0, 10], [20, 30]])).toBe(20)
  })
  it('absorbs a fully contained interval', () => {
    expect(unionMs([[0, 100], [10, 20]])).toBe(100)
  })
  it('is order independent', () => {
    expect(unionMs([[20, 30], [0, 10], [5, 25]])).toBe(30)
  })
  it('is 0 on nothing', () => {
    expect(unionMs([])).toBe(0)
  })
})

describe('speakerWordMs', () => {
  it('applies the segment offset, because word times are segment-relative', () => {
    const segs: SpeakerWordSegment[] = [
      { startElapsed: 60_000, speakerWords: [{ start: 0, end: 2, speaker: 'Gina' }] },
    ]
    // 2 seconds of voice, regardless of sitting a minute into the meeting.
    expect(speakerWordMs(segs).get('Gina')).toBe(2000)
  })

  it('counts overlapping words ONCE (the 1.2x-1.5x over-count)', () => {
    const segs: SpeakerWordSegment[] = [{
      startElapsed: 0,
      speakerWords: [
        { start: 0, end: 6, speaker: 'Gina' },   // a bogus 6s "word"
        { start: 1, end: 2, speaker: 'Gina' },   // contained
        { start: 5, end: 8, speaker: 'Gina' },   // overlaps the tail
      ],
    }]
    // Naive sum = 6 + 1 + 3 = 10s. Union = 8s.
    expect(speakerWordMs(segs).get('Gina')).toBe(8000)
  })

  it('keeps speakers separate and lets them overlap each other', () => {
    const segs: SpeakerWordSegment[] = [{
      startElapsed: 0,
      speakerWords: [
        { start: 0, end: 4, speaker: 'Gina' },
        { start: 2, end: 6, speaker: 'Graham' },
      ],
    }]
    const m = speakerWordMs(segs)
    // Crosstalk is real: both spoke during 2-4s and both are credited.
    expect(m.get('Gina')).toBe(4000)
    expect(m.get('Graham')).toBe(4000)
  })

  it('discards malformed word times rather than producing negatives', () => {
    const segs: SpeakerWordSegment[] = [{
      startElapsed: 0,
      speakerWords: [
        { start: 5, end: 3, speaker: 'Gina' },              // backwards
        { start: 1, end: 1, speaker: 'Gina' },              // zero width
        { start: undefined, end: 3, speaker: 'Gina' },      // missing
        { start: 0, end: 2, speaker: 'Gina' },              // the only good one
      ],
    }]
    expect(speakerWordMs(segs).get('Gina')).toBe(2000)
  })

  it('is empty when the batch pass never ran', () => {
    expect(speakerWordMs([]).size).toBe(0)
    expect(speakerWordMs([{ startElapsed: 0 }]).size).toBe(0)
  })
})

describe('creditedChunkMs (the fallback)', () => {
  it('caps a long dead-air gap at the capture ceiling', () => {
    // 36.6s median gaps are real in intermittent captures. Uncapped, this chunk
    // would credit its speaker with 40 seconds of silence.
    const chunks = [{ elapsed: 6000 }, { elapsed: 46_000 }] as ReviewChunk[]
    expect(creditedChunkMs(chunks)).toEqual([6000, CHUNK_CEILING_MS])
  })

  it('never returns a negative for a backwards elapsed', () => {
    const chunks = [{ elapsed: 10_000 }, { elapsed: 4000 }] as ReviewChunk[]
    expect(creditedChunkMs(chunks).every(n => n >= 0)).toBe(true)
  })
})

/** Chunks that produce one asserted voice (>=3 segments, similarity >=0.65). */
function namedChunks(label: string, n: number, similarity = 0.8): ReviewChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    speaker: label,
    text: `${label} discussed the Jewel360 migration numbers in segment ${i}`,
    elapsed: (i + 1) * 6000,
    similarity,
  }))
}

describe('speaking time on the review', () => {
  it('prefers word timings and says so', () => {
    const chunks = namedChunks('Gina Torres', 4)
    const review = reviewMeetingSpeakers(chunks, {
      owner: 'MU',
      durationMs: 24_000,
      batchSegments: [{ startElapsed: 0, speakerWords: [{ start: 0, end: 9, speaker: 'Gina Torres' }] }],
    })
    expect(review.speakingTimeSource).toBe('words')
    // 9s of voice inside a 24s meeting — the silence is NOT credited.
    expect(review.voices[0].speakingMs).toBe(9000)
    expect(review.attributedSpeakingMs).toBe(9000)
    expect(review.notCapturedMs).toBe(15_000)
  })

  it('falls back to capped chunk deltas with no batch segments', () => {
    const review = reviewMeetingSpeakers(namedChunks('Gina Torres', 4), {
      owner: 'MU',
      durationMs: 24_000,
    })
    expect(review.speakingTimeSource).toBe('chunks')
    expect(review.voices[0].speakingMs).toBe(24_000)
  })

  // THE BLOCKER CASE. A per-segment floor would credit this voice; the panel
  // does not show its name, so the header must not count it either.
  it('splits by nameAsserted PER VOICE, so header and rows agree', () => {
    const chunks = [
      ...namedChunks('Gina Torres', 6),
      // 2 segments at 0.58: under both ASSERT_MIN_SEGMENTS and the similarity floor.
      { speaker: 'Navaz Sharif', text: 'a short weak interjection about pricing', elapsed: 42_000, similarity: 0.58 },
      { speaker: 'Navaz Sharif', text: 'another short weak one about the migration', elapsed: 48_000, similarity: 0.58 },
    ] as ReviewChunk[]
    const review = reviewMeetingSpeakers(chunks, {
      owner: 'MU',
      durationMs: 60_000,
      batchSegments: [{
        startElapsed: 0,
        speakerWords: [
          { start: 0, end: 30, speaker: 'Gina Torres' },
          { start: 30, end: 40, speaker: 'Navaz Sharif' },
        ],
      }],
    })
    expect(review.voices.find(v => v.label === 'Navaz Sharif')!.nameAsserted).toBe(false)
    expect(review.attributedSpeakingMs).toBe(30_000)
    expect(review.unattributedSpeakingMs).toBe(10_000)
  })

  it('counts the wearer, who is exempt from the floor', () => {
    const review = reviewMeetingSpeakers(namedChunks('MU', 3, 0.6), {
      owner: 'MU',
      durationMs: 18_000,
      batchSegments: [{ startElapsed: 0, speakerWords: [{ start: 0, end: 12, speaker: 'MU' }] }],
    })
    expect(review.voices[0].nameAsserted).toBe(true)
    expect(review.attributedSpeakingMs).toBe(12_000)
    expect(review.unattributedSpeakingMs).toBe(0)
  })

  // Speakers overlap, so per-speaker times legitimately exceed wall clock. This
  // is what broke the first version of the arithmetic: verified against a real
  // 5.2-minute capture whose per-speaker figures summed to 6.0 minutes.
  it('credits BOTH speakers for crosstalk, and voiced counts it once', () => {
    const chunks = [...namedChunks('Gina Torres', 3), ...namedChunks('Graham Reid', 3)] as ReviewChunk[]
    const review = reviewMeetingSpeakers(chunks, {
      owner: 'MU',
      durationMs: 60_000,
      batchSegments: [{ startElapsed: 0, speakerWords: [
        { start: 0, end: 30, speaker: 'Gina Torres' },
        { start: 20, end: 40, speaker: 'Graham Reid' },   // 10s of overlap
      ] }],
    })
    expect(review.voices.find(v => v.label === 'Gina Torres')!.speakingMs).toBe(30_000)
    expect(review.voices.find(v => v.label === 'Graham Reid')!.speakingMs).toBe(20_000)
    // Per-speaker sums to 50s; the meeting only had 40s of voice.
    expect(review.voicedMs).toBe(40_000)
    expect(review.attributedSpeakingMs).toBe(40_000)
    expect(review.notCapturedMs).toBe(20_000)
  })

  it('holds THE invariant: voiced + notCaptured = duration', () => {
    const chunks = [
      ...namedChunks('Gina Torres', 5),
      { speaker: 'Ext', text: 'someone unenrolled said a long enough thing here', elapsed: 36_000, similarity: 0 },
    ] as ReviewChunk[]
    for (const batch of [
      [{ startElapsed: 0, speakerWords: [
        { start: 0, end: 20, speaker: 'Gina Torres' },
        { start: 20, end: 26, speaker: 'Ext' },
      ] }],
      undefined,
    ]) {
      const r = reviewMeetingSpeakers(chunks, { owner: 'MU', durationMs: 60_000, batchSegments: batch })
      expect(r.voicedMs + r.notCapturedMs).toBe(r.durationMs)
    }
  })

  it('never reports negative notCaptured when voice exceeds the stated duration', () => {
    // A short/absent durationMs must not produce a negative residue.
    const review = reviewMeetingSpeakers(namedChunks('Gina Torres', 3), {
      owner: 'MU',
      durationMs: 1000,
      batchSegments: [{ startElapsed: 0, speakerWords: [{ start: 0, end: 60, speaker: 'Gina Torres' }] }],
    })
    expect(review.notCapturedMs).toBe(0)
  })

  it('is all zeros on an empty sidecar rather than NaN', () => {
    const r = reviewMeetingSpeakers([])
    expect(r.attributedSpeakingMs).toBe(0)
    expect(r.unattributedSpeakingMs).toBe(0)
    expect(r.notCapturedMs).toBe(0)
    expect(r.speakingTimeSource).toBe('chunks')
  })
})
