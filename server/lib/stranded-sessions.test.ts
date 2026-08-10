import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LIVENESS_GRACE_MS,
  STRANDED_PROMOTE_MS,
  STRANDED_STALE_MS,
  capturingNow,
  classifyStrandedSession,
  strandedForMs,
} from './stranded-sessions.js'
import {
  forgetSessionHeartbeat,
  getSessionHeartbeat,
  recordSessionHeartbeat,
  resetSessionHeartbeats,
  trackedHeartbeatCount,
} from './session-heartbeats.js'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from './local-first-meetings-contract.js'

// Fixed clock. Date.now() in a test would make the boundary cases flaky by
// exactly the amount that matters here.
const NOW = 1_786_320_000_000
const mins = (n: number) => n * 60_000

describe('the promote cutoff is the one that already existed', () => {
  it('matches the retention constant that used to close sessions as expired', () => {
    // This release changes the DISPOSITION at the cutoff (save, not quarantine),
    // not the timing. If these ever diverge, a session gets closed by the old
    // path before the new one can save it.
    expect(STRANDED_PROMOTE_MS).toBe(LOCAL_FIRST_MEETING_IDLE_RETENTION_MS)
    expect(STRANDED_PROMOTE_MS).toBe(mins(240))
  })

  it('tells the user long before it acts', () => {
    expect(STRANDED_STALE_MS).toBeLessThan(STRANDED_PROMOTE_MS)
    expect(STRANDED_STALE_MS).toBe(mins(30))
  })

  it('uses the SAME staleness definition as the maintenance gate', () => {
    // STRUCTURAL on purpose. Importing routes/transcribe-stream.js here would
    // EXECUTE it — boot recovery, a 60s setInterval, reads and writes against the
    // real data home — which hung this test for 11s before failing. The invariant
    // worth pinning is that the route DERIVES the constant instead of restating
    // it, and that is visible in the source.
    const route = readFileSync(
      new URL('../routes/transcribe-stream.ts', import.meta.url).pathname, 'utf8')
    expect(route, 'RECORDING_SESSION_STALE_MS must be derived from STRANDED_STALE_MS')
      .toMatch(/export const RECORDING_SESSION_STALE_MS = STRANDED_STALE_MS\b/)
    expect(route, 'the route must import the single definition')
      .toMatch(/STRANDED_STALE_MS[\s\S]{0,120}from '\.\.\/lib\/stranded-sessions\.js'/)
  })
})

describe('staleness is measured on chunk arrival', () => {
  it('is zero for a session receiving chunks now', () => {
    expect(strandedForMs({ lastActivityAt: NOW }, NOW)).toBe(0)
  })

  it('never goes negative when a clock skews backwards', () => {
    expect(strandedForMs({ lastActivityAt: NOW + mins(5) }, NOW)).toBe(0)
  })

  it('reports the real gap for the session that prompted this work', () => {
    // meeting_1786305380784_30mzjn: 526 chunks, last written 184 minutes before
    // it was found, still counted as an active recording, invisible to
    // /api/meeting/orphans.
    expect(strandedForMs({ lastActivityAt: NOW - mins(184) }, NOW)).toBe(mins(184))
  })
})

describe('a fresh heartbeat vetoes a stale verdict, and nothing else', () => {
  const capturing = { at: NOW, audioState: 'recording_continuous', visibilityState: 'visible' }

  it('counts a meeting pipeline as capturing', () => {
    expect(capturingNow(capturing, NOW)).toBe(true)
  })

  it('counts the dictation pipeline as capturing', () => {
    expect(capturingNow({ at: NOW, audioState: 'recording' }, NOW)).toBe(true)
  })

  it('counts a BACKGROUNDED phone as capturing', () => {
    // The single most common legitimate reason for quiet: iOS suspends the
    // WebView, capture buffers to IndexedDB, and the uploader drains on
    // foreground. Requiring visibility here would reap exactly the sessions the
    // drain path exists to rescue.
    expect(capturingNow({ ...capturing, visibilityState: 'hidden' }, NOW)).toBe(true)
  })

  it('does not count a phone that is not recording', () => {
    for (const audioState of ['idle', 'no-pipeline', 'stopped', '', null, undefined]) {
      expect(capturingNow({ at: NOW, audioState }, NOW), String(audioState)).toBe(false)
    }
  })

  it('does not count a heartbeat older than the grace window', () => {
    expect(capturingNow({ ...capturing, at: NOW - LIVENESS_GRACE_MS - 1 }, NOW)).toBe(false)
    expect(capturingNow({ ...capturing, at: NOW - LIVENESS_GRACE_MS }, NOW)).toBe(true)
  })

  it('does not count a heartbeat from the future', () => {
    // A clock artifact is not evidence of capture, and without this a skewed
    // phone could hold a dead session open indefinitely.
    expect(capturingNow({ ...capturing, at: NOW + LIVENESS_GRACE_MS + 1 }, NOW)).toBe(false)
  })

  it('treats an absent or malformed heartbeat as no evidence either way', () => {
    // clientLog is fire-and-forget and lossy (63% of heartbeats measured missing
    // in one session), so absence must never be read as death. It just fails to
    // veto; chunk arrival is what decides.
    expect(capturingNow(null, NOW)).toBe(false)
    expect(capturingNow(undefined, NOW)).toBe(false)
    expect(capturingNow({ at: Number.NaN, audioState: 'recording' }, NOW)).toBe(false)
  })
})

describe('classification', () => {
  it('leaves a session receiving chunks alone', () => {
    expect(classifyStrandedSession({ lastActivityAt: NOW - mins(1) }, NOW)).toBe('live')
    expect(classifyStrandedSession({ lastActivityAt: NOW - mins(29) }, NOW)).toBe('live')
  })

  it('marks a session stale exactly at the threshold', () => {
    expect(classifyStrandedSession({ lastActivityAt: NOW - STRANDED_STALE_MS }, NOW)).toBe('stale')
    expect(classifyStrandedSession({ lastActivityAt: NOW - STRANDED_STALE_MS + 1 }, NOW)).toBe('live')
  })

  it('keeps a quiet-but-recording session live instead of flagging it', () => {
    const activity = {
      lastActivityAt: NOW - mins(45),
      heartbeat: { at: NOW - mins(1), audioState: 'recording_continuous', visibilityState: 'hidden' },
    }
    expect(classifyStrandedSession(activity, NOW)).toBe('live')
  })

  it('flags a quiet session whose last heartbeat has gone cold', () => {
    const activity = {
      lastActivityAt: NOW - mins(45),
      heartbeat: { at: NOW - mins(30), audioState: 'recording_continuous' },
    }
    expect(classifyStrandedSession(activity, NOW)).toBe('stale')
  })

  it('promotes exactly at the retention cutoff', () => {
    expect(classifyStrandedSession({ lastActivityAt: NOW - STRANDED_PROMOTE_MS }, NOW)).toBe('promote')
    expect(classifyStrandedSession({ lastActivityAt: NOW - STRANDED_PROMOTE_MS + 1 }, NOW)).toBe('stale')
  })

  it('promotes at the cutoff even while something is still heartbeating', () => {
    // The path this replaces closed the session unconditionally at four hours.
    // Letting a heartbeat defer it would strand audio LONGER than the old code,
    // which is the opposite of the point.
    const activity = {
      lastActivityAt: NOW - STRANDED_PROMOTE_MS,
      heartbeat: { at: NOW, audioState: 'recording_continuous', visibilityState: 'visible' },
    }
    expect(classifyStrandedSession(activity, NOW)).toBe('promote')
  })

  it('walks the real 2026-08-09 session through every verdict', () => {
    const started = NOW - mins(184)
    expect(classifyStrandedSession({ lastActivityAt: started }, started + mins(5))).toBe('live')
    expect(classifyStrandedSession({ lastActivityAt: started }, started + mins(30))).toBe('stale')
    expect(classifyStrandedSession({ lastActivityAt: started }, started + mins(184))).toBe('stale')
    // It was found at 184 minutes. Left alone it would have hit the cutoff and,
    // before this change, been quarantined rather than saved.
    expect(classifyStrandedSession({ lastActivityAt: started }, started + mins(240))).toBe('promote')
  })
})

describe('the heartbeat store', () => {
  beforeEach(resetSessionHeartbeats)

  it('keeps the newest heartbeat and ignores a late-arriving older one', () => {
    recordSessionHeartbeat('s1', { at: NOW, audioState: 'recording_continuous' })
    recordSessionHeartbeat('s1', { at: NOW - mins(5), audioState: 'idle' })
    expect(getSessionHeartbeat('s1')).toMatchObject({ at: NOW, audioState: 'recording_continuous' })
  })

  it('overwrites when a newer heartbeat arrives', () => {
    recordSessionHeartbeat('s1', { at: NOW - mins(5), audioState: 'recording_continuous' })
    recordSessionHeartbeat('s1', { at: NOW, audioState: 'idle' })
    expect(getSessionHeartbeat('s1')).toMatchObject({ at: NOW, audioState: 'idle' })
  })

  it('rejects entries that cannot be aged', () => {
    recordSessionHeartbeat('s1', { at: Number.NaN, audioState: 'recording' })
    recordSessionHeartbeat('', { at: NOW, audioState: 'recording' })
    expect(trackedHeartbeatCount()).toBe(0)
  })

  it('evicts oldest-first so recent vetoes survive a zombie burst', () => {
    for (let i = 0; i < 200; i += 1) {
      recordSessionHeartbeat(`zombie-${i}`, { at: NOW - mins(200 - i), audioState: 'idle' })
    }
    recordSessionHeartbeat('real', { at: NOW, audioState: 'recording_continuous' })
    expect(trackedHeartbeatCount()).toBeLessThanOrEqual(64)
    expect(getSessionHeartbeat('real')).toMatchObject({ audioState: 'recording_continuous' })
    expect(getSessionHeartbeat('zombie-0')).toBeNull()
  })

  it('forgets a session on any terminal state', () => {
    recordSessionHeartbeat('s1', { at: NOW, audioState: 'recording' })
    forgetSessionHeartbeat('s1')
    expect(getSessionHeartbeat('s1')).toBeNull()
  })

  it('feeds the classifier end to end', () => {
    recordSessionHeartbeat('s1', { at: NOW - mins(1), audioState: 'recording_continuous' })
    const quiet = { lastActivityAt: NOW - mins(45), heartbeat: getSessionHeartbeat('s1') }
    expect(classifyStrandedSession(quiet, NOW)).toBe('live')
    forgetSessionHeartbeat('s1')
    const orphaned = { lastActivityAt: NOW - mins(45), heartbeat: getSessionHeartbeat('s1') }
    expect(classifyStrandedSession(orphaned, NOW)).toBe('stale')
  })
})
