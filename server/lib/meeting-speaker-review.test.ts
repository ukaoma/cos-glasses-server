// Per-meeting speaker review, exercised by execution.
//
// The fixtures encode the measurements taken off the live store on 2026-08-05,
// so the thresholds are calibrated against real behaviour rather than guessed:
//
//   MU + Chris Krubeck (known two people) : flip 0.069, mean run 30.0
//   Luke H + Luke Henry                   : flip 0.361, mean run 2.79
//
// A change that lets the control pair read as "unreliable" is a false positive
// on the most common case in the store, and a change that lets the thrashing
// pair read as "confident" defeats the point of the panel. Both directions are
// asserted.
import { describe, expect, it } from 'vitest'
import {
  ASSERT_MIN_SEGMENTS,
  ASSERT_MIN_SIMILARITY,
  CONFIDENT_SIMILARITY,
  THRASH_FLIP_RATE,
  THRASH_MEAN_RUN,
  pairFlipRate,
  phraseScore,
  reviewMeetingSpeakers,
  selectPhrases,
  speakerRuns,
  speakerTimeline,
  type ReviewChunk,
} from './meeting-speaker-review.js'

/** Turn-taking: `runLen` consecutive segments each, alternating. */
function turnTaking(a: string, b: string, turns: number, runLen: number): string[] {
  const seq: string[] = []
  for (let t = 0; t < turns; t++) {
    const who = t % 2 === 0 ? a : b
    for (let i = 0; i < runLen; i++) seq.push(who)
  }
  return seq
}

function chunks(seq: string[], text = (i: number, s: string) => `${s} said something specific about Jewel360 in segment ${i}`): ReviewChunk[] {
  return seq.map((s, i) => ({ speaker: s, text: text(i, s), elapsed: i * 7000, similarity: 0.8 }))
}

describe('run lengths', () => {
  it('counts consecutive runs, not totals', () => {
    expect(speakerRuns(['a','a','a','b','a','a'], 'a')).toEqual([3, 2])
  })
  it('handles a speaker at both ends and one absent', () => {
    expect(speakerRuns(['a','b','a'], 'a')).toEqual([1, 1])
    expect(speakerRuns(['b','b'], 'a')).toEqual([])
  })
})

describe('the pair flip rate separates conversation from label thrash', () => {
  it('reads a real two-person conversation as low-flip, long-run', () => {
    // The MU + Chris Krubeck control: ~30-segment runs.
    const p = pairFlipRate(turnTaking('MU', 'Chris Krubeck', 8, 30), 'MU', 'Chris Krubeck')!
    expect(p.flipRate).toBeLessThan(THRASH_FLIP_RATE)
    expect(p.meanRun).toBeGreaterThan(THRASH_MEAN_RUN)
  })

  it('reads a split identity as high-flip, short-run', () => {
    // Luke H + Luke Henry: ~3-segment runs.
    const p = pairFlipRate(turnTaking('Luke H', 'Luke Henry', 24, 3), 'Luke H', 'Luke Henry')!
    expect(p.flipRate).toBeGreaterThan(THRASH_FLIP_RATE)
    expect(p.meanRun).toBeLessThan(THRASH_MEAN_RUN)
  })

  it('IGNORES a third speaker, so an interjection cannot fake a thrash', () => {
    // Without pair-restriction, X interrupting every other segment would make
    // A and B look like they were swapping constantly.
    const seq: string[] = []
    for (let t = 0; t < 6; t++) {
      for (let i = 0; i < 12; i++) seq.push(t % 2 === 0 ? 'A' : 'B')
      seq.push('X')
    }
    const p = pairFlipRate(seq, 'A', 'B')!
    expect(p.meanRun).toBeGreaterThan(THRASH_MEAN_RUN)
    expect(p.flipRate).toBeLessThan(THRASH_FLIP_RATE)
  })

  it('declines to characterise too little data instead of guessing', () => {
    expect(pairFlipRate(['A','B','A'], 'A', 'B')).toBeNull()
    expect(pairFlipRate(turnTaking('A','B',8,30), 'A', 'Nobody')).toBeNull()
  })
})

describe('phrase scoring favours what a human can recognise', () => {
  it('rejects filler and one-liners outright', () => {
    for (const t of ['Yeah', 'okay', 'Mm-hmm', 'Got it', 'right', 'Sure thing here']) {
      expect(phraseScore(t), t).toBe(0)
    }
  })

  it('scores a specific line above a longer bland one', () => {
    const bland = 'i think that is probably going to be the case for most of the things we looked at today'
    const specific = 'follow up with both Andrews on inbound and outbound music targeting for Jewel360'
    expect(phraseScore(specific)).toBeGreaterThan(phraseScore(bland))
  })

  it('rewards figures — they anchor a memory', () => {
    const withNum = 'we should cap the MVF trial at fifty leads and hold 50 per month'
    const without = 'we should cap the MVF trial at a modest number and hold that per month'
    expect(phraseScore(withNum)).toBeGreaterThan(phraseScore(without))
  })
})

describe('phrase selection spreads across the meeting', () => {
  it('does not return three lines from the same minute', () => {
    // All five candidates score similarly; the first three are seconds apart.
    const cs: ReviewChunk[] = [
      { speaker: 'A', elapsed: 10_000, text: 'Jewel360 pipeline is the thing I keep coming back to here' },
      { speaker: 'A', elapsed: 14_000, text: 'Jewel360 pipeline is the thing I keep coming back to again' },
      { speaker: 'A', elapsed: 18_000, text: 'Jewel360 pipeline is the thing I keep coming back to once more' },
      { speaker: 'A', elapsed: 600_000, text: 'Bottle POS surcharging needs a decision before the Graham review' },
      { speaker: 'A', elapsed: 1_180_000, text: 'MarktPOS demos converted at 36 percent across eight quarters' },
    ]
    const picked = selectPhrases(cs, 'A', 3, 1_200_000)
    const times = picked.map(p => p.atMs)
    expect(picked).toHaveLength(3)
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(400_000)
    // Returned in chronological order so they read as a timeline.
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('still returns something on a short burst where the gap rule excludes everything', () => {
    const cs: ReviewChunk[] = Array.from({ length: 4 }, (_, i) => ({
      speaker: 'A', elapsed: i * 1000, text: `Bottle POS surcharging conversion review number ${i} with Graham`,
    }))
    expect(selectPhrases(cs, 'A', 3, 4000).length).toBeGreaterThan(0)
  })

  it('returns nothing when the speaker only ever said filler', () => {
    expect(selectPhrases([{ speaker: 'A', elapsed: 1000, text: 'yeah' }], 'A', 3, 1000)).toEqual([])
  })

  it('carries the timestamp and similarity with each line', () => {
    const cs: ReviewChunk[] = [{ speaker: 'A', elapsed: 42_000, similarity: 0.77,
      text: 'Stand up the same DQ and lead-activity monitoring view for XBU next week' }]
    expect(selectPhrases(cs, 'A', 3, 100_000)[0]).toEqual({
      text: 'Stand up the same DQ and lead-activity monitoring view for XBU next week',
      atMs: 42_000, similarity: 0.77,
    })
  })
})

describe('the whole review', () => {
  it('marks a genuine two-person meeting confident, with no thrash', () => {
    const review = reviewMeetingSpeakers(chunks(turnTaking('MU', 'Chris Krubeck', 8, 30)), { owner: 'MU' })
    expect(review.attributed).toBe(true)
    expect(review.voices).toHaveLength(2)
    for (const v of review.voices) {
      expect(v.thrashesWith).toEqual([])
      expect(v.reliability).toBe('confident')
      expect(v.meanRun).toBeGreaterThan(THRASH_MEAN_RUN)
    }
    expect(review.voices.find(v => v.label === 'MU')!.isOwner).toBe(true)
  })

  it('marks BOTH halves of a split identity unreliable and names the partner', () => {
    const review = reviewMeetingSpeakers(chunks(turnTaking('Luke H', 'Luke Henry', 24, 3)), { owner: 'MU' })
    for (const v of review.voices) {
      expect(v.reliability).toBe('unreliable')
      expect(v.thrashesWith.map(t => t.speaker)).toEqual([
        v.label === 'Luke H' ? 'Luke Henry' : 'Luke H',
      ])
      expect(v.thrashesWith[0].meanRun).toBeLessThan(THRASH_MEAN_RUN)
    }
  })

  it('unreliable OUTRANKS a high similarity score', () => {
    // The Krubeck case exactly: confident-looking numbers, unusable attribution.
    const cs = chunks(turnTaking('Luke H', 'Luke Henry', 24, 3)).map(c => ({ ...c, similarity: 0.95 }))
    const review = reviewMeetingSpeakers(cs, { owner: 'MU' })
    expect(review.voices[0].meanSimilarity).toBeGreaterThan(CONFIDENT_SIMILARITY)
    expect(review.voices[0].reliability).toBe('unreliable')
  })

  it('calls a low-confidence but stable voice weak, not unreliable', () => {
    const cs = chunks(turnTaking('MU', 'Voice 2', 8, 30)).map(c => ({ ...c, similarity: 0.58 }))
    const review = reviewMeetingSpeakers(cs, { owner: 'MU' })
    expect(review.voices.every(v => v.reliability === 'weak')).toBe(true)
  })

  it('reports a recovered meeting as unattributed rather than empty', () => {
    // Every segment Unknown — the state the panel most needs to handle.
    const cs = chunks(Array(52).fill('Unknown'))
    const review = reviewMeetingSpeakers(cs, { owner: 'MU' })
    expect(review.attributed).toBe(false)
    expect(review.segments).toBe(52)
    expect(review.voices).toHaveLength(1)
    expect(review.voices[0].reliability).toBe('unattributed')
    // Phrases still come through — they are the only way in on this meeting.
    expect(review.voices[0].phrases.length).toBeGreaterThan(0)
  })

  it('never reports Unknown or Ext as thrashing with anyone', () => {
    const seq = turnTaking('Unknown', 'MU', 24, 3)
    const review = reviewMeetingSpeakers(chunks(seq), { owner: 'MU' })
    expect(review.voices.find(v => v.label === 'Unknown')!.thrashesWith).toEqual([])
  })

  it('orders voices by how much they spoke', () => {
    const seq = [...Array(60).fill('A'), ...Array(20).fill('B'), ...Array(5).fill('C')]
    const review = reviewMeetingSpeakers(chunks(seq), { owner: 'A' })
    expect(review.voices.map(v => v.label)).toEqual(['A', 'B', 'C'])
  })

  it('survives an empty or malformed sidecar', () => {
    expect(reviewMeetingSpeakers([]).voices).toEqual([])
    const junk = reviewMeetingSpeakers([{}, { speaker: 'A' }, { text: 'hi' }] as ReviewChunk[])
    expect(junk.segments).toBe(3)
  })
})

describe('a name must be EARNED before it is presented as a name', () => {
  // Fixtures are the actual rows from Miles's 2026-08-06 Ditto meeting, where
  // he confirmed the low-confidence voices were not in the room at all. Before
  // this floor each of them arrived in the panel wearing a full name.
  function voiceOf(label: string, segments: number, similarity: number, others: string[] = []) {
    const seq: string[] = []
    for (let i = 0; i < segments; i++) seq.push(label)
    // Pad with a long-running speaker so the meeting is realistic and the
    // target's own run structure is not the thing under test.
    for (let i = 0; i < 200; i++) seq.push(others[i % Math.max(others.length, 1)] ?? 'MU')
    const cs: ReviewChunk[] = seq.map((sp, i) => ({
      speaker: sp,
      text: `${sp} raised the HubSpot module builder question in segment ${i}`,
      elapsed: i * 7000,
      similarity: sp === label ? similarity : 0.82,
    }))
    const review = reviewMeetingSpeakers(cs, { owner: 'MU' })
    return review.voices.find(v => v.label === label)!
  }

  it('refuses a 1-segment match at 0.60 — Richard Jenkins in the real meeting', () => {
    const v = voiceOf('Richard Jenkins', 1, 0.60)
    expect(v.nameAsserted).toBe(false)
    expect(v.assertionBlockers.join(' ')).toContain('1 segment')
    expect(v.assertionBlockers.join(' ')).toContain('0.60')
  })

  it('refuses a 1-segment match at 0.55 — Luke Henry, the split-identity label', () => {
    expect(voiceOf('Luke Henry', 1, 0.55).nameAsserted).toBe(false)
  })

  it('refuses a 3-segment match at 0.58 — Navaz Sharif, over the segment floor but under similarity', () => {
    // Segment count alone is not enough: this row CLEARS the segment floor and
    // must still be refused on similarity.
    const v = voiceOf('Navaz Sharif', ASSERT_MIN_SEGMENTS, 0.58)
    expect(v.segments).toBe(ASSERT_MIN_SEGMENTS)
    expect(v.nameAsserted).toBe(false)
    expect(v.assertionBlockers.some(b => b.includes('similarity'))).toBe(true)
    expect(v.assertionBlockers.some(b => b.includes('segment'))).toBe(false)
  })

  it('refuses a high-similarity match that is only 2 segments long', () => {
    // The inverse: strong score, not enough evidence.
    const v = voiceOf('Ryan Hopkins', 2, 0.91)
    expect(v.nameAsserted).toBe(false)
    expect(v.assertionBlockers.some(b => b.includes('segment'))).toBe(true)
    expect(v.assertionBlockers.some(b => b.includes('similarity'))).toBe(false)
  })

  it('asserts a name that clears BOTH floors', () => {
    const v = voiceOf('Cristian Teichner', 32, 0.72)
    expect(v.nameAsserted).toBe(true)
    expect(v.assertionBlockers).toEqual([])
  })

  it('refuses a name that thrashes, however strong its score', () => {
    // Already surfaced as `unreliable`; the panel says a name here is a guess,
    // so it must not also be presented AS a name.
    const seq = turnTaking('Luke H', 'Luke Henry', 60, 2)
    const review = reviewMeetingSpeakers(chunks(seq), { owner: 'MU' })
    for (const v of review.voices) {
      expect(v.reliability).toBe('unreliable')
      expect(v.nameAsserted).toBe(false)
      expect(v.assertionBlockers.some(b => b.includes('swaps with'))).toBe(true)
    }
  })

  it('never asserts an unattributed row, and says why', () => {
    const review = reviewMeetingSpeakers(chunks(turnTaking('Ext', 'MU', 40, 30)), { owner: 'MU' })
    const ext = review.voices.find(v => v.label === 'Ext')!
    expect(ext.nameAsserted).toBe(false)
    expect(ext.assertionBlockers).toEqual(['no name was ever assigned to this voice'])
  })

  it('holds the owner to the same floor', () => {
    // The owner gets no exemption: an owner row that thrashes or scores badly is
    // exactly as unearned as anyone else's, and MU read `unreliable` on the real
    // Ditto meeting.
    const v = voiceOf('MU', 2, 0.58, ['Bradley Haveman'])
    expect(v.isOwner).toBe(true)
    expect(v.nameAsserted).toBe(false)
  })

  it('keeps the label available as a candidate rather than discarding it', () => {
    // The reviewer still needs to see WHO the system guessed — that is often the
    // clue that identifies the voice. The floor governs presentation, not data.
    const v = voiceOf('Navaz Sharif', 1, 0.58)
    expect(v.label).toBe('Navaz Sharif')
    expect(v.meanSimilarity).toBeCloseTo(0.58, 2)
  })

  it('ties the floor to the confident-similarity threshold rather than a second magic number', () => {
    expect(ASSERT_MIN_SIMILARITY).toBe(CONFIDENT_SIMILARITY)
  })
})

describe('the timeline that makes a ribbon a timeline', () => {
  const cs = (rows: Array<[string, number]>): ReviewChunk[] =>
    rows.map(([speaker, elapsed], i) => ({ speaker, elapsed, text: `segment ${i}`, similarity: 0.8 }))

  it('collapses consecutive segments by the same speaker into one span', () => {
    const t = speakerTimeline(cs([['MU', 0], ['MU', 6000], ['MU', 12000], ['Chris', 18000]]), 24000)
    expect(t).toHaveLength(2)
    expect(t[0]).toEqual({ speaker: 'MU', startMs: 0, endMs: 18000, segments: 3 })
    expect(t[1]).toEqual({ speaker: 'Chris', startMs: 18000, endMs: 24000, segments: 1 })
  })

  it('preserves ORDER, including a speaker who returns later', () => {
    // The property the old ribbon could not express: one voice occupying two
    // separate stretches of the meeting.
    const t = speakerTimeline(cs([['MU', 0], ['Chris', 5000], ['MU', 9000]]), 12000)
    expect(t.map(s => s.speaker)).toEqual(['MU', 'Chris', 'MU'])
    expect(t[2].startMs).toBe(9000)
  })

  it('makes every span contiguous with the next, so hover has no dead gaps', () => {
    const t = speakerTimeline(cs([['A', 0], ['B', 7000], ['C', 15000]]), 20000)
    for (let i = 0; i < t.length - 1; i++) expect(t[i].endMs).toBe(t[i + 1].startMs)
    expect(t[t.length - 1].endMs).toBe(20000)
  })

  it('treats elapsed as a START offset, not an end', () => {
    // meeting.ts assigns `elapsed` then increments, so the first chunk's elapsed
    // is where it BEGINS. Reading it as an end shifts the whole ribbon by one
    // segment and every hover reports the previous speaker.
    const t = speakerTimeline(cs([['MU', 8044], ['Chris', 15024]]), 30000)
    expect(t[0].startMs).toBe(8044)
    expect(t[0].endMs).toBe(15024)
  })

  it('never produces a negative or inverted span from a backwards elapsed', () => {
    // Real sidecars can carry non-monotonic values; an inverted span renders as
    // an invisible or backwards block.
    const t = speakerTimeline(cs([['A', 10000], ['B', 3000], ['C', 20000]]), 25000)
    for (const s of t) expect(s.endMs).toBeGreaterThanOrEqual(s.startMs)
    expect(t.map(s => s.startMs)).toEqual([10000, 10000, 20000])
  })

  it('carries the cursor forward when elapsed is missing entirely', () => {
    const rows: ReviewChunk[] = [
      { speaker: 'A', elapsed: 5000, text: 'x', similarity: 0.8 },
      { speaker: 'B', text: 'y', similarity: 0.8 },
      { speaker: 'C', elapsed: 9000, text: 'z', similarity: 0.8 },
    ]
    const t = speakerTimeline(rows, 12000)
    expect(t.map(s => s.startMs)).toEqual([5000, 5000, 9000])
    for (const s of t) expect(Number.isFinite(s.startMs)).toBe(true)
  })

  it('handles an empty meeting without inventing a span', () => {
    expect(speakerTimeline([], 0)).toEqual([])
  })

  it('never ends the last span before it starts, even with a bad durationMs', () => {
    const t = speakerTimeline(cs([['A', 30000]]), 1000)   // duration shorter than the chunk
    expect(t[0].endMs).toBeGreaterThanOrEqual(t[0].startMs)
  })

  it('is returned by the full review, with segments summing to the chunk count', () => {
    const review = reviewMeetingSpeakers(chunks(turnTaking('MU', 'Chris Krubeck', 8, 30)), { owner: 'MU' })
    expect(review.timeline.length).toBe(8)
    expect(review.timeline.reduce((n, s) => n + s.segments, 0)).toBe(review.segments)
  })

  it('keeps unattributed stretches in the timeline rather than dropping them', () => {
    // A gap where nobody was identified is real information — the ribbon must
    // show it, not close over it.
    const t = speakerTimeline(cs([['MU', 0], ['Ext', 6000], ['MU', 12000]]), 18000)
    expect(t.map(s => s.speaker)).toEqual(['MU', 'Ext', 'MU'])
  })
})
