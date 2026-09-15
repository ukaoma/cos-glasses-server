import { describe, expect, it } from 'vitest'
import {
  LONG_RECORDING_S,
  MIN_PIECE_S,
  SPLIT_GAP_S,
  SPLIT_MIN_ANCHORS,
  SPLIT_MIN_INSIDE_RECORDINGS,
  contentSpanFor,
  mergeShortPieces,
  resolveOverlap,
  snapToGap,
  splitPlanFor,
} from './split.js'
import { firefliesMeeting, g2Capture, phrase, subPhrase, tokensForAnchors } from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 13, 0, 0)
const THREE_HOURS_S = 10_800

/** Three meetings recorded as one long file, with real silences between them. */
function morning(options: { durationS?: number; captures?: number } = {}) {
  const blocks = [phrase('first', 60, 60, 1800), phrase('second', 60, 2100, 1800), phrase('third', 60, 4200, 1800)]
  const meeting = firefliesMeeting({
    id: 'f-long',
    startMs: START,
    durationS: options.durationS ?? THREE_HOURS_S,
    phrases: blocks,
    title: 'Morning recording',
  })
  const captures = blocks.slice(0, options.captures ?? 3).map((block, i) => g2Capture({
    sessionId: `s${i}`,
    startMs: START + block.startS * 1000,
    durationMs: (block.endS - block.startS) * 1000,
    phrases: [block],
    offsetMs: 0,
  }))
  return { meeting, captures, blocks }
}

describe('content spans', () => {
  it('spans each capture and snaps the edges to the silences around it', () => {
    const { meeting, captures, blocks } = morning()
    const span = contentSpanFor(captures[1], meeting)
    expect(span).not.toBeNull()
    expect(span!.anchors).toBeGreaterThanOrEqual(60)
    // The block runs 2100 to 3900 s, inside silences of 300 s on each side.
    expect(span!.startS).toBeCloseTo(blocks[1].startS, 0)
    expect(span!.endS).toBeCloseTo(blocks[1].endS, 0)
  })

  it('needs thirty shared phrases to cut the recording, and refuses at twenty-nine', () => {
    const { meeting, blocks } = morning()
    const shared = (count: number) => g2Capture({
      sessionId: 'x',
      startMs: START,
      durationMs: 600_000,
      phrases: [subPhrase(blocks[0], tokensForAnchors(count), blocks[0].startS)],
      offsetMs: 0,
    })
    expect(contentSpanFor(shared(29), meeting)).toBeNull()
    expect(contentSpanFor(shared(30), meeting)).not.toBeNull()
    expect(SPLIT_MIN_ANCHORS).toBe(30)
  })

  it('refuses a capture that shares nothing with the recording', () => {
    const { meeting } = morning()
    const stranger = g2Capture({ sessionId: 'x', startMs: START, durationMs: 600_000, phrases: [phrase('elsewhere', 20, 60)], offsetMs: 0 })
    expect(contentSpanFor(stranger, meeting)).toBeNull()
  })
})

describe('when a recording is split', () => {
  it('refuses a recording under two hours', () => {
    const { meeting, captures } = morning({ durationS: 7199 })
    expect(splitPlanFor(meeting, captures).refusal).toBe('not_long_enough')
    expect(LONG_RECORDING_S).toBe(7200)
  })

  it('refuses when only one capture is inside it', () => {
    expect(SPLIT_MIN_INSIDE_RECORDINGS).toBe(2)
    const { meeting, captures } = morning({ captures: 1 })
    const plan = splitPlanFor(meeting, captures)
    expect(plan.split).toBe(false)
    expect(plan.refusal).toBe('too_few_inside')
  })

  it('pairs instead of splitting when one capture covers four fifths of the recording', () => {
    const block = phrase('whole', 200, 60, 9000)
    const tail = phrase('tail', 60, 9300, 300)
    const meeting = firefliesMeeting({ id: 'f-long', startMs: START, durationS: THREE_HOURS_S, phrases: [block, tail] })
    // 9180 s of a 10800 s recording: 0.85, over the 0.8 line but well under the whole.
    const wide = g2Capture({ sessionId: 's-wide', startMs: START, durationMs: 9_180_000, phrases: [block], offsetMs: 0 })
    const short = g2Capture({ sessionId: 's-short', startMs: START + 9_300_000, durationMs: 300_000, phrases: [tail], offsetMs: 0 })
    const plan = splitPlanFor(meeting, [wide, short])
    expect(plan.spans.find(span => span.sessionId === 's-wide')!.coverage).toBeCloseTo(0.85, 2)
    expect(plan.split).toBe(false)
    expect(plan.refusal).toBe('one_capture_covers_recording')
  })
})

describe('pieces', () => {
  it('covers every second of the recording exactly once', () => {
    const { meeting, captures } = morning()
    const plan = splitPlanFor(meeting, captures)
    expect(plan.split).toBe(true)
    expect(plan.pieces[0].startS).toBe(0)
    expect(plan.pieces[plan.pieces.length - 1].endS).toBe(meeting.durationS)
    for (let i = 0; i + 1 < plan.pieces.length; i++) {
      expect(plan.pieces[i + 1].startS).toBe(plan.pieces[i].endS)
    }
    expect(plan.pieces.filter(piece => piece.kind === 'matched').map(piece => piece.sessionIds)).toEqual([['s0'], ['s1'], ['s2']])
  })

  it('gives each capture its own piece and keeps the order', () => {
    const { meeting, captures } = morning()
    const plan = splitPlanFor(meeting, captures)
    const matched = plan.pieces.filter(piece => piece.kind === 'matched')
    expect(matched).toHaveLength(3)
    // The first piece starts at 0, not at 60: the minute of silence before the first
    // meeting is under the minimum and has no earlier neighbour, so it joins this one.
    expect(matched.map(piece => Math.round(piece.startS))).toEqual([0, 2100, 4200])
  })

  it('merges a piece under two minutes into the one before it', () => {
    const merged = mergeShortPieces([
      { index: 0, startS: 0, endS: 600, kind: 'matched', sessionIds: ['s0'] },
      { index: 1, startS: 600, endS: 600 + MIN_PIECE_S - 1, kind: 'unmatched', sessionIds: [] },
      { index: 2, startS: 600 + MIN_PIECE_S - 1, endS: 2000, kind: 'matched', sessionIds: ['s1'] },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ startS: 0, endS: 719, sessionIds: ['s0'] })
    expect(merged[1]).toMatchObject({ startS: 719, endS: 2000, sessionIds: ['s1'] })
  })

  it('keeps a piece of exactly two minutes', () => {
    const merged = mergeShortPieces([
      { index: 0, startS: 0, endS: 600, kind: 'matched', sessionIds: ['s0'] },
      { index: 1, startS: 600, endS: 600 + MIN_PIECE_S, kind: 'unmatched', sessionIds: [] },
      { index: 2, startS: 600 + MIN_PIECE_S, endS: 2000, kind: 'matched', sessionIds: ['s1'] },
    ])
    expect(merged).toHaveLength(3)
  })

  it('gives a leading short piece to the one after it, having no earlier neighbour', () => {
    const merged = mergeShortPieces([
      { index: 0, startS: 0, endS: 30, kind: 'unmatched', sessionIds: [] },
      { index: 1, startS: 30, endS: 2000, kind: 'matched', sessionIds: ['s1'] },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startS: 0, endS: 2000, sessionIds: ['s1'] })
  })
})

describe('overlaps', () => {
  it('cuts at a silence inside the contested stretch, not at its midpoint', () => {
    // The silence sits at 1100, the midpoint at 1200: the two answers must differ, or the
    // test cannot tell which rule ran.
    const gaps = [{ startS: 1100, endS: 1100 + SPLIT_GAP_S }]
    expect(resolveOverlap(1400, 1000, gaps)).toBe(1100)
  })

  it('cuts at the midpoint when the two meetings run straight into each other', () => {
    expect(resolveOverlap(1400, 1000, [])).toBe(1200)
    expect(resolveOverlap(1400, 1000, [{ startS: 5000, endS: 5200 }])).toBe(1200)
  })

  it('leaves the pieces touching, so no second belongs to both', () => {
    const blocks = [phrase('first', 80, 60, 1800), phrase('second', 80, 1500, 1800)]
    const meeting = firefliesMeeting({ id: 'f-long', startMs: START, durationS: THREE_HOURS_S, phrases: blocks })
    const captures = blocks.map((block, i) => g2Capture({
      sessionId: `s${i}`,
      startMs: START + block.startS * 1000,
      durationMs: (block.endS - block.startS) * 1000,
      phrases: [block],
      offsetMs: 0,
    }))
    const plan = splitPlanFor(meeting, captures)
    expect(plan.split).toBe(true)
    for (let i = 0; i + 1 < plan.pieces.length; i++) expect(plan.pieces[i + 1].startS).toBe(plan.pieces[i].endS)
  })
})

describe('snapping', () => {
  it('moves a start to where speech resumes and an end to where it stops', () => {
    const gaps = [{ startS: 1000, endS: 1100 }]
    expect(snapToGap(1080, gaps, 'start')).toBe(1100)
    expect(snapToGap(1020, gaps, 'end')).toBe(1000)
  })

  it('leaves an edge alone when no silence is near it', () => {
    expect(snapToGap(5000, [{ startS: 1000, endS: 1100 }], 'start')).toBe(5000)
  })
})
