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
  CONFIDENT_SIMILARITY,
  THRASH_FLIP_RATE,
  THRASH_MEAN_RUN,
  pairFlipRate,
  phraseScore,
  reviewMeetingSpeakers,
  selectPhrases,
  speakerRuns,
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
