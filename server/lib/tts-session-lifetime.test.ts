import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_IDLE_MS,
  SESSION_MAX_LIFETIME_MS,
  createSession,
  peekSession,
  reapExpiredSessions,
} from './tts-cache.js'

/**
 * The session UUID is the auth for an UNAUTHENTICATED play route, and it is also
 * what keeps long audio playable. Those two pull in opposite directions, so both
 * halves are pinned here.
 *
 * WHAT WAS BROKEN. The deadline was a fixed 60s from creation, which silently
 * capped PLAYBACK at 60 seconds. iOS WKWebView re-requests `audio.src` every few
 * seconds to refill its decode buffer; once the session expired, those refills
 * 404'd and the audio stopped mid-sentence. Measured: 250 characters is 14
 * seconds of speech, 4,000 characters is 211 -- so any reply over roughly 1,100
 * characters outlived its own session.
 *
 * v5.9.4 made reads non-destructive for exactly this reason and stopped one step
 * short, noting the TTL was deliberately unchanged. That note is why this file
 * spells out the security half rather than only the playback half: a purely
 * sliding window can be held open forever by polling, so the hard ceiling is not
 * optional and must never be extendable by reading.
 */

const SESSION = {
  hash: 'h1',
  text: 'hello',
  voice: 'am_echo',
  format: 'mp3',
  preferOpenAI: false,
  forceLocal: true,
}

describe('TTS session lifetime', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('survives a playback longer than the idle window when it is being read', () => {
    const uuid = createSession({ ...SESSION })
    // 211 seconds of audio: the real duration of a 4,000-character reply. Read
    // every 10s, the way an iOS Range refill does.
    for (let elapsed = 0; elapsed < 211_000; elapsed += 10_000) {
      vi.advanceTimersByTime(10_000)
      expect(peekSession(uuid), `refill at ${elapsed + 10_000}ms`).not.toBeNull()
    }
  })

  // Derived from SESSION_IDLE_MS, not written against it. The first version of
  // this test hardcoded 59s/61s around a 60s window and broke the moment the
  // window was widened -- which is the good failure, but it should never have
  // needed a human to retune two magic numbers.
  it('still expires once reads stop', () => {
    const uuid = createSession({ ...SESSION })
    vi.advanceTimersByTime(30_000)
    expect(peekSession(uuid)).not.toBeNull()              // refreshes the deadline
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1_000)
    expect(peekSession(uuid)).not.toBeNull()              // inside the refreshed window
    vi.advanceTimersByTime(SESSION_IDLE_MS + 1_000)
    expect(peekSession(uuid)).toBeNull()                  // idle out
  })

  // THE SECURITY HALF. Reading must not be able to hold a session open forever.
  it('dies at the absolute ceiling no matter how often it is read', () => {
    const uuid = createSession({ ...SESSION })
    let alive = 0
    // Poll every 30s for 100 minutes -- always inside the idle window.
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(30_000)
      if (peekSession(uuid)) alive += 1
    }
    // 90 minutes of reads succeed, then the hard ceiling ends it regardless.
    expect(alive).toBeGreaterThan(170)
    expect(alive).toBeLessThan(200)
    expect(peekSession(uuid)).toBeNull()
  })

  it('never pushes the idle deadline past the hard ceiling', () => {
    const uuid = createSession({ ...SESSION })
    // Held warm by reads to just before the ceiling. (An earlier version of this
    // test jumped straight to 29m59s with no reads and failed -- correctly: the
    // session had idled out at 60s. The idle rule and the ceiling rule are
    // separate, and this one is about the ceiling.)
    for (let i = 0; i < 179; i++) {
      vi.advanceTimersByTime(30_000)
      expect(peekSession(uuid), `read at ${(i + 1) * 30}s`).not.toBeNull()
    }
    // ~89m30s in and still alive. A read here must not buy a full idle minute
    // past the 90m ceiling.
    vi.advanceTimersByTime(45_000)
    expect(peekSession(uuid)).toBeNull()
  })

  it('the reaper honours the hard ceiling too', () => {
    const uuid = createSession({ ...SESSION })
    // Kept warm by reads right up to the ceiling...
    for (let i = 0; i < 178; i++) {
      vi.advanceTimersByTime(30_000)
      peekSession(uuid)
    }
    vi.advanceTimersByTime(2 * 60_000)
    reapExpiredSessions()
    expect(peekSession(uuid)).toBeNull()
  })
})

describe('the ceiling covers the longest reply it can be asked to serve', () => {
  // Every segment is minted at prepare, so the ceiling must outlast the WHOLE
  // reply at the SLOWEST playback speed. 30 minutes did not: a 40,000-char reply
  // is 35.1 minutes at 1x and 70.2 at 0.5x, so its last segments would have
  // expired mid-playback -- the same class of bug as the 60s deadline.
  it('outlasts MAX_LOCAL_TTS_CHARS at the minimum playback speed', () => {
    const MAX_LOCAL_TTS_CHARS = 40_000   // server/routes/tts.ts
    const SPEECH_CHARS_PER_SEC = 19      // measured
    const MIN_PLAYBACK_RATE = 0.5        // voice-output.ts clamp
    const worstCaseMs = (MAX_LOCAL_TTS_CHARS / SPEECH_CHARS_PER_SEC / MIN_PLAYBACK_RATE) * 1000
    // Reads the real constant. A literal here would keep passing after someone
    // lowered the ceiling -- the exact shape that let the 60s deadline ship.
    expect(SESSION_MAX_LIFETIME_MS).toBeGreaterThan(worstCaseMs)
  })

  // The IDLE window has its own coverage duty, and it is NOT the same one. Every
  // segment is minted at prepare, but the client only TOUCHES segment i+1 when
  // segment i starts playing -- so the idle window must outlast ONE segment at the
  // slowest speed. 60s covered 1x and 1.25x but not the shipped 0.75x option.
  it('outlasts one full segment at the minimum playback speed', () => {
    const LATER_CHUNK_CHARS = 900        // server/routes/tts.ts
    const SPEECH_CHARS_PER_SEC = 19
    const MIN_PLAYBACK_RATE = 0.5
    const oneSegmentMs = (LATER_CHUNK_CHARS / SPEECH_CHARS_PER_SEC / MIN_PLAYBACK_RATE) * 1000
    expect(SESSION_IDLE_MS).toBeGreaterThan(oneSegmentMs)
  })
})
