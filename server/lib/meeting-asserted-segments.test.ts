// How much of this meeting carries a name the panel will actually show.
//
// `attributed` is a boolean that only goes false at 100% unidentified, so a
// meeting where 295 of 299 chunks matched nobody reports `true` and renders as
// though it were normally attributed. Measured Ext share across 14 retained
// sessions ran 24% to 100%, all of it collapsing onto that one boolean.
//
// The trap this file exists to pin: the obvious derivation — count chunks whose
// LABEL names a person — is not the number the panel displays. A voice under
// the assertion floor keeps its label but renders as "Unidentified voice".
// Measured on session 0i1xv3: 287 label-bearing segments vs 177 asserted, a
// 29-point gap. A header built on labels would claim high identification above
// a list of rows saying the opposite.

import { describe, expect, it } from 'vitest'
import { reviewMeetingSpeakers, type ReviewChunk } from './meeting-speaker-review.js'

/** Chunks with an explicit similarity, because Ext carries 0 in production
 *  (`speaker-embeddings.ts` returns `{ speaker: 'Ext', similarity: 0 }`) and a
 *  fixture that stamps 0.8 on everything cannot reproduce that. */
function chunks(seq: string[], similarity = 0.8): ReviewChunk[] {
  return seq.map((s, i) => ({
    speaker: s,
    text: `${s} said something specific about Jewel360 revenue in segment ${i}`,
    elapsed: i * 7000,
    similarity: s === 'Ext' || s === 'Unknown' ? 0 : similarity,
  }))
}

describe('assertedSegments', () => {
  it('counts every segment when all voices clear the floor', () => {
    const review = reviewMeetingSpeakers(chunks(Array(12).fill('Gina Torres')), { owner: 'MU' })
    expect(review.voices[0].nameAsserted).toBe(true)
    expect(review.assertedSegments).toBe(12)
    expect(review.assertedSegments).toBe(review.segments)
  })

  it('counts nothing when the whole meeting is Ext', () => {
    const review = reviewMeetingSpeakers(chunks(Array(20).fill('Ext')), { owner: 'MU' })
    expect(review.attributed).toBe(false)
    expect(review.segments).toBe(20)
    expect(review.assertedSegments).toBe(0)
  })

  // THE BLOCKER CASE. This voice keeps a person-shaped label the whole way
  // through, so a label-based count scores it. The panel does not.
  it('EXCLUDES a named voice that failed the floor', () => {
    // 2 segments at 0.58: under ASSERT_MIN_SEGMENTS (3) and ASSERT_MIN_SIMILARITY (0.65).
    const seq = [...Array(10).fill('Gina Torres'), 'Navaz Sharif', 'Navaz Sharif']
    const review = reviewMeetingSpeakers(
      seq.map((s, i) => ({
        speaker: s,
        text: `${s} covered the Jewel360 migration numbers in segment ${i}`,
        elapsed: i * 7000,
        similarity: s === 'Navaz Sharif' ? 0.58 : 0.8,
      })),
      { owner: 'MU' },
    )
    const navaz = review.voices.find(v => v.label === 'Navaz Sharif')!
    expect(navaz.nameAsserted).toBe(false)
    expect(navaz.segments).toBe(2)
    // 12 segments, 12 carry a person-shaped label, but only 10 are asserted.
    expect(review.segments).toBe(12)
    expect(review.assertedSegments).toBe(10)
  })

  it('counts a voice a human confirmed, even though it failed the floor', () => {
    const seq = [...Array(10).fill('Gina Torres'), 'Queen Ukaoma', 'Queen Ukaoma']
    const cs = seq.map((s, i) => ({
      speaker: s,
      text: `${s} covered the Jewel360 migration numbers in segment ${i}`,
      elapsed: i * 7000,
      similarity: s === 'Queen Ukaoma' ? 0.56 : 0.8,
    }))
    const before = reviewMeetingSpeakers(cs, { owner: 'MU' })
    expect(before.assertedSegments).toBe(10)

    const after = reviewMeetingSpeakers(cs, { owner: 'MU', confirmed: new Set(['Queen Ukaoma']) })
    expect(after.voices.find(v => v.label === 'Queen Ukaoma')!.nameAsserted).toBe(true)
    expect(after.assertedSegments).toBe(12)
  })

  it('counts the wearer, who is exempt from the floor', () => {
    // MU sits permanently on the 0.65 boundary; the owner branch asserts anyway.
    const review = reviewMeetingSpeakers(chunks(Array(8).fill('MU'), 0.6), { owner: 'MU' })
    expect(review.voices[0].nameAsserted).toBe(true)
    expect(review.assertedSegments).toBe(8)
  })

  it('excludes every unattributed label shape', () => {
    // Speaker N and '' are in UNATTRIBUTED; 'Unidentified 3' matches the
    // prefix-aware branch of isUnattributed.
    const seq = [...Array(6).fill('Gina Torres'), 'Speaker 1', 'Unknown', 'Unidentified 3', 'Ext']
    const review = reviewMeetingSpeakers(chunks(seq), { owner: 'MU' })
    expect(review.assertedSegments).toBe(6)
  })

  it('never exceeds segments, and matches the sum of asserted voice rows', () => {
    const seq = [...Array(9).fill('Gina Torres'), 'Ext', 'Ext', 'Speaker 2', '']
    const review = reviewMeetingSpeakers(chunks(seq), { owner: 'MU' })
    const fromRows = review.voices
      .filter(v => v.nameAsserted)
      .reduce((n, v) => n + v.segments, 0)
    expect(review.assertedSegments).toBe(fromRows)
    expect(review.assertedSegments).toBeLessThanOrEqual(review.segments)
  })

  it('is 0 on an empty or malformed sidecar rather than NaN', () => {
    expect(reviewMeetingSpeakers([]).assertedSegments).toBe(0)
    const junk = reviewMeetingSpeakers([{}, { speaker: 'A' }, { text: 'hi' }] as ReviewChunk[])
    // A speaker-less chunk counts in `segments` but belongs to no voice row, so
    // the ratio's denominator is deliberately the larger number.
    expect(junk.segments).toBe(3)
    expect(junk.assertedSegments).toBe(0)
  })
})
