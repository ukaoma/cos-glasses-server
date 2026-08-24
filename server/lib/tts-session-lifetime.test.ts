import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, peekSession, reapExpiredSessions } from './tts-cache.js'

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

  it('still expires once reads stop', () => {
    const uuid = createSession({ ...SESSION })
    vi.advanceTimersByTime(30_000)
    expect(peekSession(uuid)).not.toBeNull()   // refreshes the idle deadline
    vi.advanceTimersByTime(59_000)
    expect(peekSession(uuid)).not.toBeNull()   // inside the refreshed window
    vi.advanceTimersByTime(61_000)
    expect(peekSession(uuid)).toBeNull()       // idle out
  })

  // THE SECURITY HALF. Reading must not be able to hold a session open forever.
  it('dies at the absolute ceiling no matter how often it is read', () => {
    const uuid = createSession({ ...SESSION })
    let alive = 0
    // Poll every 30s for 40 minutes -- always inside the idle window.
    for (let i = 0; i < 80; i++) {
      vi.advanceTimersByTime(30_000)
      if (peekSession(uuid)) alive += 1
    }
    // 30 minutes of reads succeed, then the hard ceiling ends it regardless.
    expect(alive).toBeGreaterThan(50)
    expect(alive).toBeLessThan(80)
    expect(peekSession(uuid)).toBeNull()
  })

  it('never pushes the idle deadline past the hard ceiling', () => {
    const uuid = createSession({ ...SESSION })
    // Held warm by reads to just before the ceiling. (An earlier version of this
    // test jumped straight to 29m59s with no reads and failed -- correctly: the
    // session had idled out at 60s. The idle rule and the ceiling rule are
    // separate, and this one is about the ceiling.)
    for (let i = 0; i < 59; i++) {
      vi.advanceTimersByTime(30_000)
      expect(peekSession(uuid), `read at ${(i + 1) * 30}s`).not.toBeNull()
    }
    // ~29m30s in and still alive. A read here must not buy a full idle minute
    // past the 30m ceiling.
    vi.advanceTimersByTime(45_000)
    expect(peekSession(uuid)).toBeNull()
  })

  it('the reaper honours the hard ceiling too', () => {
    const uuid = createSession({ ...SESSION })
    // Kept warm by reads right up to the ceiling...
    for (let i = 0; i < 58; i++) {
      vi.advanceTimersByTime(30_000)
      peekSession(uuid)
    }
    vi.advanceTimersByTime(2 * 60_000)
    reapExpiredSessions()
    expect(peekSession(uuid)).toBeNull()
  })
})
