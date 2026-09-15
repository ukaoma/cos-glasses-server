import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AUTO_DOMINANCE,
  AUTO_MIN_ANCHORS,
  CANDIDATE_PAD_S,
  PAIRING_CLOCK_BAND_S,
  SUGGEST_MIN_ANCHORS,
  groupAutoMerges,
  offsetPlacesCaptureInside,
  scoreRecording,
  tierFor,
} from './pairing.js'
import {
  firefliesMeeting,
  g2Capture,
  matchingPair,
  phrase,
  shiftPhrase,
  subPhrase,
  tokensForAnchors,
} from './__fixtures__/synthetic.js'

const START = Date.UTC(2026, 7, 20, 15, 0, 0)
const HALF_HOUR_S = 1800

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

describe('tier boundaries', () => {
  it('needs 30 shared phrases to merge without asking, and suggests at 29', () => {
    const at30 = matchingPair({ k: AUTO_MIN_ANCHORS })
    const at29 = matchingPair({ k: AUTO_MIN_ANCHORS - 1 })
    const scored30 = scoreRecording(at30.capture, [at30.meeting])
    const scored29 = scoreRecording(at29.capture, [at29.meeting])
    expect(scored30.k1).toBe(30)
    expect(scored29.k1).toBe(29)
    expect(scored30.tier).toBe('auto_merge')
    expect(scored29.tier).toBe('suggest')
  })

  it('offers nothing below 10 shared phrases', () => {
    const at10 = matchingPair({ k: SUGGEST_MIN_ANCHORS })
    const at9 = matchingPair({ k: SUGGEST_MIN_ANCHORS - 1 })
    expect(scoreRecording(at10.capture, [at10.meeting]).tier).toBe('suggest')
    expect(scoreRecording(at9.capture, [at9.meeting]).tier).toBe('none')
  })

  it('merges at exactly 3x the next meeting and suggests just below it', () => {
    // The rival starts ten minutes after the capture and its shared run sits ten minutes
    // into the capture, so the offset it implies MATCHES its clock. A rival whose clocks
    // disagree is thrown out by the band and cannot be the thing dominance is measured
    // against.
    const build = (k1: number) => {
      const main = phrase('alpha', k1, 60)
      const sharedLater = phrase('shared', 30, 660)
      const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [main, sharedLater], offsetMs: 0 })
      const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: HALF_HOUR_S, phrases: [main] })
      const rival = firefliesMeeting({
        id: 'f2',
        startMs: START + 600_000,
        durationS: HALF_HOUR_S,
        phrases: [shiftPhrase(sharedLater, -600)],
      })
      return scoreRecording(capture, [meeting, rival])
    }
    const dominant = build(AUTO_MIN_ANCHORS * AUTO_DOMINANCE)
    const shortOfIt = build(AUTO_MIN_ANCHORS * AUTO_DOMINANCE - 1)
    expect([dominant.k1, dominant.k2]).toEqual([90, 30])
    expect([shortOfIt.k1, shortOfIt.k2]).toEqual([89, 30])
    expect(dominant.tier).toBe('auto_merge')
    expect(shortOfIt.tier).toBe('suggest')
  })

  it('reads the tiers straight from the two counts', () => {
    expect(tierFor(30, 10)).toBe('auto_merge')
    expect(tierFor(30, 11)).toBe('suggest')
    expect(tierFor(29, 0)).toBe('suggest')
    expect(tierFor(9, 0)).toBe('none')
  })
})

describe('the offset must place the capture inside the recording', () => {
  const LONG_S = 9000

  it('accepts a capture the recording is long enough to hold', () => {
    const spoken = phrase('zeta', 40, 60)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: LONG_S * 1000, phrases: [spoken], offsetMs: 0 })
    const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: LONG_S, phrases: [spoken] })
    const scored = scoreRecording(capture, [meeting])
    expect(scored.tier).toBe('auto_merge')
    expect(scored.rejections.filter(r => r.reason === 'offset_outside_interval')).toHaveLength(0)
  })

  it('rejects a two-and-a-half-hour capture placed inside a half-hour recording', () => {
    // The clocks agree, so the band is happy; the arithmetic still says this capture runs
    // two hours past anything the meeting recorded.
    const spoken = phrase('zeta', 40, 60)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: LONG_S * 1000, phrases: [spoken], offsetMs: 0 })
    const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: HALF_HOUR_S, phrases: [spoken] })
    const scored = scoreRecording(capture, [meeting])
    expect(scored.rejections.map(r => r.reason)).toContain('offset_outside_interval')
    expect(scored.candidates).toHaveLength(0)
    expect(scored.tier).toBe('none')
  })

  it('refuses a placement before the recording began', () => {
    // Tested on the predicate itself: the clock band (900 s) is tighter than this pad
    // (3600 s), so no realistic capture reaches scoreRecording with an offset this early.
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [phrase('zeta', 40, 60)], offsetMs: 0 })
    const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: HALF_HOUR_S, phrases: [phrase('zeta', 40, 60)] })
    expect(offsetPlacesCaptureInside(-(CANDIDATE_PAD_S - 1) * 1000, capture, meeting)).toBe(true)
    expect(offsetPlacesCaptureInside(-(CANDIDATE_PAD_S + 1) * 1000, capture, meeting)).toBe(false)
  })
})

describe('duplicate recordings of one meeting', () => {
  /**
   * The thin recording shares MORE phrases with the capture than the full one, so a primary
   * chosen by anchors rather than by transcript length would pick the thin transcript and
   * bury the fuller one in an alternate section.
   */
  function twoBots() {
    const main = phrase('alpha', 90, 60)
    const partial = subPhrase(main, tokensForAnchors(70), 60)
    const filler = phrase('extra', 5, 600)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [main], offsetMs: 0 })
    const thin = firefliesMeeting({ id: 'f-thin', startMs: START, durationS: HALF_HOUR_S, phrases: [main] })
    const full = firefliesMeeting({ id: 'f-full', startMs: START + 60_000, durationS: HALF_HOUR_S, phrases: [partial, filler] })
    return { capture, thin, full }
  }

  it('collapses them, keeps both, and leads with the fuller transcript', () => {
    const { capture, thin, full } = twoBots()
    const scored = scoreRecording(capture, [thin, full])
    expect(scored.tier).toBe('auto_merge')
    expect(scored.primaryFirefliesId).toBe('f-full')
    expect(scored.duplicateFirefliesIds).toEqual(['f-thin'])
    expect(scored.candidates.map(c => c.firefliesId).sort()).toEqual(['f-full', 'f-thin'])
  })

  it('would have refused without the collapse, because each is the other\'s rival', () => {
    // Ten minutes earlier and the same words ten minutes later into its own recording: too
    // far apart to be one meeting recorded twice, close enough that its clock agrees.
    const main = phrase('alpha', 90, 60)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [main], offsetMs: 0 })
    const thin = firefliesMeeting({ id: 'f-thin', startMs: START, durationS: HALF_HOUR_S, phrases: [main] })
    const apart = firefliesMeeting({ id: 'f-apart', startMs: START - 600_000, durationS: HALF_HOUR_S, phrases: [shiftPhrase(main, 600)] })
    const scored = scoreRecording(capture, [thin, apart])
    expect(scored.duplicateFirefliesIds).toEqual([])
    expect([scored.k1, scored.k2]).toEqual([90, 90])
    expect(scored.tier).toBe('suggest')
  })
})

describe('grouping captures of one meeting', () => {
  function meetingWithCaptures(count: number) {
    const parts = Array.from({ length: count }, (_, i) => phrase(`part${i}`, 60, 60 + i * 600))
    const meeting = firefliesMeeting({ id: 'f1', startMs: START, durationS: 3600, phrases: parts })
    // Deliberately out of start order, to prove the group sorts them.
    const captures = parts
      // offsetMs matches each capture's start: its words are stored at times relative to
      // its OWN clock, which is what the clock band checks.
      .map((part, i) => g2Capture({
        sessionId: `s${i}`,
        startMs: START + i * 600_000,
        durationMs: 600_000,
        phrases: [part],
        offsetMs: i * 600_000,
      }))
      .reverse()
    return { meeting, captures }
  }

  it.each([2, 3])('makes one merged record from %i captures', count => {
    const { meeting, captures } = meetingWithCaptures(count)
    const results = captures.map(capture => scoreRecording(capture, [meeting]))
    expect(results.every(r => r.tier === 'auto_merge')).toBe(true)
    const groups = groupAutoMerges(results, captures)
    expect(groups).toHaveLength(1)
    expect(groups[0].primaryFirefliesId).toBe('f1')
    expect(groups[0].sessionIds).toEqual(Array.from({ length: count }, (_, i) => `s${i}`))
  })
})

describe('contamination', () => {
  /**
   * The case the clock band exists for. Fireflies recorded the meeting NEXT DOOR but not
   * this one, so the neighbour is the only candidate: K2 is 0 and dominance is satisfied by
   * default. Content alone would merge the capture into the wrong meeting on 40 phrases of
   * shared agenda. The phrases imply an offset of -180 s while the clocks say -1800 s, and
   * 1,620 s is far outside the band, so none of them count.
   */
  it('refuses the neighbouring meeting when only its clock-implausible boilerplate is shared', () => {
    const ownWords = phrase('own', 200, 60)
    const boilerplate = phrase('agenda', 40, 300)
    const capture = g2Capture({
      sessionId: 's1',
      startMs: START,
      durationMs: HALF_HOUR_S * 1000,
      phrases: [ownWords, boilerplate],
      offsetMs: 0,
    })
    // Fireflies recorded only the meeting AFTER this one, which reuses the same agenda.
    const nextMeeting = firefliesMeeting({
      id: 'f-next',
      startMs: START + HALF_HOUR_S * 1000,
      durationS: HALF_HOUR_S,
      phrases: [subPhrase(boilerplate, tokensForAnchors(40), 120)],
    })
    const scored = scoreRecording(capture, [nextMeeting])
    expect(scored.tier).toBe('none')
    expect(scored.k1).toBe(0)
    expect(scored.candidates[0].anchorsOutsideClockBand).toBe(40)
  })

  it('still merges the same capture into its own meeting, whose clock agrees', () => {
    const ownWords = phrase('own', 200, 60)
    const boilerplate = phrase('agenda', 40, 300)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [ownWords, boilerplate], offsetMs: 0 })
    const mine = firefliesMeeting({ id: 'f-mine', startMs: START, durationS: HALF_HOUR_S, phrases: [ownWords, boilerplate] })
    const nextMeeting = firefliesMeeting({ id: 'f-next', startMs: START + HALF_HOUR_S * 1000, durationS: HALF_HOUR_S, phrases: [subPhrase(boilerplate, tokensForAnchors(40), 120)] })
    const scored = scoreRecording(capture, [mine, nextMeeting])
    expect(scored.tier).toBe('auto_merge')
    expect(scored.primaryFirefliesId).toBe('f-mine')
    expect(scored.k2).toBe(0)
    expect(PAIRING_CLOCK_BAND_S).toBe(900)
  })

  it('picks the capture\'s own meeting when both are recorded', () => {
    const ownWords = phrase('own', 200, 60)
    const boilerplate = phrase('agenda', 40, 300)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: HALF_HOUR_S * 1000, phrases: [ownWords, boilerplate], offsetMs: 0 })
    const mine = firefliesMeeting({ id: 'f-mine', startMs: START, durationS: HALF_HOUR_S, phrases: [ownWords, boilerplate] })
    const nextMeeting = firefliesMeeting({ id: 'f-next', startMs: START + HALF_HOUR_S * 1000, durationS: HALF_HOUR_S, phrases: [subPhrase(boilerplate, tokensForAnchors(40), 120)] })
    const scored = scoreRecording(capture, [mine, nextMeeting])
    expect(scored.tier).toBe('auto_merge')
    expect(scored.primaryFirefliesId).toBe('f-mine')
  })

  it('refuses a 28 minute capture that shares only five minutes of a 90 minute call', () => {
    const sideConversation = phrase('side', 300, 60)
    const shared = phrase('overlap', 25, 900)
    const capture = g2Capture({
      sessionId: 's1',
      startMs: START,
      durationMs: 28 * 60 * 1000,
      phrases: [sideConversation, shared],
      offsetMs: 0,
    })
    const groupCall = firefliesMeeting({
      id: 'f-call',
      startMs: START,
      durationS: 90 * 60,
      phrases: [phrase('call', 400, 1200), subPhrase(shared, tokensForAnchors(25), 900)],
    })
    const scored = scoreRecording(capture, [groupCall])
    expect(scored.k1).toBe(25)
    expect(scored.tier).toBe('suggest')
  })

  it('does not reach last week\'s run of the same recurring meeting', () => {
    const agenda = phrase('standup', 150, 60)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: 900_000, phrases: [agenda], offsetMs: 0 })
    const lastWeek = firefliesMeeting({ id: 'f-lastweek', startMs: START - 7 * 24 * 3_600_000, durationS: 900, phrases: [agenda] })
    const scored = scoreRecording(capture, [lastWeek])
    expect(scored.tier).toBe('none')
    expect(scored.rejections).toEqual([{ firefliesId: 'f-lastweek', reason: 'outside_padded_interval' }])
  })

  it('keeps the recurring meeting\'s own run ahead of a templated neighbour on the same day', () => {
    const agenda = phrase('standup', 150, 60)
    const capture = g2Capture({ sessionId: 's1', startMs: START, durationMs: 900_000, phrases: [agenda], offsetMs: 0 })
    const today = firefliesMeeting({ id: 'f-today', startMs: START, durationS: 900, phrases: [agenda] })
    const templatedNeighbour = firefliesMeeting({
      id: 'f-neighbour',
      startMs: START + 3_000_000,
      durationS: 900,
      phrases: [subPhrase(agenda, tokensForAnchors(40), 60)],
    })
    const scored = scoreRecording(capture, [today, templatedNeighbour])
    // The neighbour's forty agenda phrases imply an offset 50 minutes from its clock, so
    // they count for nothing and it is not even a rival.
    expect([scored.k1, scored.k2]).toEqual([150, 0])
    expect(scored.tier).toBe('auto_merge')
    expect(scored.primaryFirefliesId).toBe('f-today')
  })
})

describe('sources are immutable', () => {
  it('leaves every input byte for byte as it was', () => {
    const { capture, meeting } = matchingPair({ k: 90 })
    const before = [sha(capture), sha(meeting)]
    scoreRecording(capture, [meeting])
    expect([sha(capture), sha(meeting)]).toEqual(before)
  })
})

describe('candidate refusals are recorded', () => {
  it('names why a meeting with no duration was not scored', () => {
    const { capture, meeting } = matchingPair({ k: 90 })
    const undated = { ...meeting, id: 'f-nodur', durationS: 0 }
    const scored = scoreRecording(capture, [meeting, undated])
    expect(scored.rejections).toEqual([{ firefliesId: 'f-nodur', reason: 'duration_unknown' }])
  })
})
