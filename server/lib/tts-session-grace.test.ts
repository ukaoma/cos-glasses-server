import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LATER_CHUNK_CHARS,
  MAX_LOCAL_TTS_CHARS,
  SESSION_IDLE_MS,
  SESSION_MAX_LIFETIME_MS,
  createSession,
  initialGraceMs,
  peekSession,
  worstCaseSpeechMs,
} from './tts-cache.js'

/**
 * A session that has never been read must survive until someone can reasonably
 * read it. That is a different requirement from the idle window, and conflating
 * the two is what stopped playback at segment 5 of 9 on 2026-08-23.
 *
 * MEASURED ON DEVICE, 6,781 chars at 1.25x, bm_george. All 9 segments are minted
 * at /prepare, but the client only touches segment k when segment k-1 STARTS
 * playing:
 *
 *   seg 4  first touched t+101s   played
 *   seg 5  first touched t+147s   FAILED   <- first touch past the 120s deadline
 *   seg 6  first touched t+215s   FAILED
 *   seg 7  never reached          FAILED
 *
 * Segment 5 was already deleted when the client first asked for it. The 404
 * reached the audio element as NotSupportedError, which is why three earlier
 * fixes -- a char cap, a wider idle window, a render gate -- all left playback
 * stopping at exactly segment 5.
 */

const SESSION = {
  hash: 'h1', text: 'hello', voice: 'am_echo', format: 'mp3',
  preferOpenAI: false, forceLocal: true,
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a never-read session survives until it can be reached', () => {
  it('reproduces the device timeline: every segment is readable when its turn comes', () => {
    // Exactly the run above. Grace derived from the whole reply, as /prepare does.
    const grace = initialGraceMs(6_781)
    const uuids = Array.from({ length: 9 }, () => createSession({ ...SESSION }, { graceMs: grace }))

    // First-touch offsets from the device log, in ms.
    const firstTouch = [0, 0, 12_000, 58_000, 101_000, 147_000, 215_000, 283_000, 351_000]
    let clock = 0
    firstTouch.forEach((at, k) => {
      vi.advanceTimersByTime(at - clock)
      clock = at
      expect(peekSession(uuids[k]), `segment ${k} dead at its first touch (t+${at / 1000}s)`)
        .not.toBeNull()
    })
  })

  it('is the specific case that failed: a first touch past the idle window', () => {
    const grace = initialGraceMs(6_781)
    const graced = createSession({ ...SESSION }, { graceMs: grace })
    const flat = createSession({ ...SESSION })          // no grace: the old behaviour

    // Segment 8's first touch, t+351s on the device. Segment 5 (t+147s) is no
    // longer a discriminating case: SESSION_IDLE_MS was re-derived from the slow
    // voice and now covers it on its own. Segment 8 still needs the grace, and
    // picking a case the idle window already covers would have made this test
    // pass for the wrong reason.
    const seg8FirstTouchMs = 351_000
    expect(seg8FirstTouchMs, 'pick a case the idle window does NOT cover')
      .toBeGreaterThan(SESSION_IDLE_MS)

    vi.advanceTimersByTime(seg8FirstTouchMs)
    expect(peekSession(graced), 'with grace, the late segment is alive').not.toBeNull()
    expect(peekSession(flat), 'without it, this is the 404 that broke playback').toBeNull()
  })

  it('derives the grace from the reply, not from a chosen number', () => {
    // 6,781 chars at the slowest voice (10 chars/sec) and slowest rate (0.5x),
    // plus one idle window of margin. COMPUTED, not restated: my first version
    // of this line hardcoded a rounded 1_356_000 and was 200ms wrong, which is
    // the same "test asserts its own copy of the number" trap the qa checks name.
    // Margin is ONE SEGMENT, not one idle window: the last segment is first
    // touched when the second-to-last starts playing, so the window must reach
    // one segment past the end of the reply. Computed from the shared constants
    // rather than from initialGraceMs, so this can actually disagree with it.
    const expected =
      worstCaseSpeechMs(6_781) + worstCaseSpeechMs(LATER_CHUNK_CHARS)
    expect(initialGraceMs(6_781)).toBe(expected)
    // Longer reply, longer grace. A flat constant cannot do this.
    expect(initialGraceMs(40_000)).toBeGreaterThan(initialGraceMs(6_781))
    // Never shorter than the idle window it replaces.
    expect(initialGraceMs(1)).toBeGreaterThanOrEqual(SESSION_IDLE_MS)
  })
})

describe('the grace does not weaken what it replaces', () => {
  // REWRITTEN. This test previously asserted that a read COLLAPSES the grace to
  // the idle window -- and that was the defect, not the contract. `warmNext(i)`
  // reads segment i+1 at the START of segment i and does not touch it again
  // until segment i finishes, one whole segment later. Collapsing on that first
  // read meant the warm SPENT the grace: at 0.5x a 900-char segment is 170s of
  // wall time against a 120s window, and the reply lost segment 1 while holding
  // a 1,476s grace. A read may only ever EXTEND a deadline.
  it('a read never shortens a deadline it cannot beat', () => {
    const grace = initialGraceMs(40_000)
    const uuid = createSession({ ...SESSION }, { graceMs: grace })
    vi.advanceTimersByTime(60_000)
    expect(peekSession(uuid)).not.toBeNull()            // the warm's first read

    // The warm must not have cost the session its grace: a segment that takes
    // longer than the idle window to play still finds it alive.
    vi.advanceTimersByTime(SESSION_IDLE_MS + 60_000)
    expect(peekSession(uuid), 'the warm spent the grace').not.toBeNull()
  })

  it('slides normally once the grace is spent, and buys nothing back', () => {
    // A short reply's grace IS the idle window, so this is the ordinary case.
    const uuid = createSession({ ...SESSION }, { graceMs: SESSION_IDLE_MS })
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1_000)
    expect(peekSession(uuid)).not.toBeNull()            // slides
    vi.advanceTimersByTime(SESSION_IDLE_MS + 1_000)
    expect(peekSession(uuid), 'silence must still kill it').toBeNull()
  })

  it('reading a long-grace session does not extend it past its grace', () => {
    const grace = initialGraceMs(40_000)
    const uuid = createSession({ ...SESSION }, { graceMs: grace })
    // Poll it relentlessly for the whole grace. Reading may not buy a second.
    for (let t = 0; t < grace - 1_000; t += 30_000) {
      vi.advanceTimersByTime(30_000)
      peekSession(uuid)
    }
    // Now go just past the ORIGINAL grace with one final quiet stretch.
    vi.advanceTimersByTime(SESSION_IDLE_MS + 2_000)
    expect(peekSession(uuid), 'polling must not extend a capability').toBeNull()
  })

  it('can never outlive the hard ceiling, however large the grace', () => {
    const absurd = SESSION_MAX_LIFETIME_MS * 10
    const uuid = createSession({ ...SESSION }, { graceMs: absurd })
    vi.advanceTimersByTime(SESSION_MAX_LIFETIME_MS + 1_000)
    expect(peekSession(uuid), 'the ceiling is not negotiable').toBeNull()
  })

  it('still expires an unread session eventually', () => {
    const uuid = createSession({ ...SESSION }, { graceMs: initialGraceMs(6_781) })
    vi.advanceTimersByTime(initialGraceMs(6_781) + 1_000)
    expect(peekSession(uuid)).toBeNull()
    // The advance above is computed from the function under test, so it passes
    // for ANY return value -- including 24 hours. Bound it against something the
    // function does not control. (Same shape as the one already fixed in
    // tts-policy.test.ts; this sibling was missed.)
    expect(initialGraceMs(6_781), 'a 6.8k reply must not mint an hours-long capability')
      .toBeLessThan(SESSION_MAX_LIFETIME_MS)
    expect(initialGraceMs(6_781)).toBeLessThan(45 * 60_000)
  })

  // THE INVARIANT THAT WAS MISSING. The ceiling must cover the largest grace the
  // system can legally issue, or it silently truncates it -- which is what made
  // a maximal reply's last segments die at segment 31 of 46.
  it('the ceiling covers the largest grace that can be issued', () => {
    expect(initialGraceMs(MAX_LOCAL_TTS_CHARS)).toBeLessThanOrEqual(SESSION_MAX_LIFETIME_MS)
  })
})
