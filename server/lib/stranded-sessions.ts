// A recording whose phone went away must still become a meeting.
//
// THE DEFECT THIS FIXES. When the companion quits, the bridge drops, or the G2
// disconnects mid-meeting, the server keeps the session in memory and keeps its
// ACK'd chunks on disk. Nothing then converts them into a meeting. At the 4-hour
// retention cutoff the session was closed as 'expired' and its audio moved to
// quarantine — preserved for 72 more hours, but still not a meeting, and visible
// only to whoever thought to look. Two sessions sat stranded for 184 and 24
// minutes on 2026-08-09 holding the restart lock while /api/meeting/orphans
// reported nothing at all, because that endpoint lists only QUARANTINED dirs and
// a stranded session is not quarantined for four hours.
//
// WHY THE OBVIOUS FIX IS WRONG. "Close idle sessions sooner" loses data. The
// companion buffers capture to IndexedDB while iOS suspends the WebView and
// drains on foreground (local-first-meeting-uploader.ts keeps a retry queue), and
// it restores `restoredSessionId` across a relaunch — so a phone that has been
// silent for 25 minutes can still deliver its tail into the SAME session id. Once
// the session is closed, `isSessionDeleted` answers 410 Gone and that tail is
// gone, leaving a truncated meeting AND a second orphan. So staleness must never
// close a session early. It may only make the state visible and durable.
//
// QUIET IS NOT FAILURE. `lastActivityAt` is bumped in exactly one place —
// `processStreamChunk` — so it is a pure chunk-ARRIVAL signal and a zombie
// client's heartbeats cannot mask a dead session. The inverse also has to hold:
// a phone that reports it is recording right now is alive even with no chunk
// arriving, because its uploads may merely be blocked. That is why a fresh
// heartbeat suppresses the stale verdict, and why a BACKGROUNDED phone is not
// treated as dead — buffering while suspended is designed behavior, not a fault.

import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from './local-first-meetings-contract.js'

/**
 * No ACK'd chunk for this long and the session is worth telling the user about.
 *
 * MUST equal `RECORDING_SESSION_STALE_MS` in routes/transcribe-stream.ts, which
 * already defines staleness for the maintenance drain gate and for aborting batch
 * work while a recording is live. A second, different threshold is exactly the bug
 * this release fixes: the session counter said "2 recordings active" while
 * /api/meeting/orphans said nothing, because two subsystems disagreed about what
 * counts as a real recording. One definition, or the disagreement comes back.
 * `stranded-sessions.test.ts` imports both and fails if they drift.
 *
 * It lives here rather than being imported from the route because lib must not
 * depend on routes; the test is what keeps them married.
 *
 * Chunk cadence is roughly 10s, so 30 minutes is ~180 missed chunks: decisively
 * not a hiccup. It is deliberately NOT a close — see the header. Nothing is
 * destroyed at this threshold; a draft is written and the session stays open so a
 * late drain still lands.
 */
export const STRANDED_STALE_MS = 30 * 60_000

/**
 * The session is finished and becomes a meeting.
 *
 * Identical to the cutoff that already closed sessions as 'expired', so this
 * changes the DISPOSITION (save instead of quarantine) and not the timing. Do not
 * shorten it without re-reading the drain discussion above.
 */
export const STRANDED_PROMOTE_MS = LOCAL_FIRST_MEETING_IDLE_RETENTION_MS

/** A heartbeat older than this proves nothing about the phone's state now. */
export const LIVENESS_GRACE_MS = 3 * 60_000

/**
 * Pipeline states that mean audio is being captured this moment.
 *
 * Sourced from the companion's audio pipeline, whose recording state is
 * `recording_continuous` for a meeting; `recording` covers the dictation path.
 */
const CAPTURING_AUDIO_STATES = new Set(['recording_continuous', 'recording'])

export type StrandedVerdict = 'live' | 'stale' | 'promote'

export interface SessionHeartbeat {
  /** ms since epoch when the heartbeat arrived. */
  at: number
  audioState?: string | null
  visibilityState?: string | null
}

export interface SessionActivity {
  /** ms since epoch of the last ACK'd chunk. NOT bumped by heartbeats. */
  lastActivityAt: number
  /** Most recent heartbeat for this session, when one has ever arrived. */
  heartbeat?: SessionHeartbeat | null
}

/** How long this session has been without an ACK'd chunk. Never negative. */
export function strandedForMs(activity: SessionActivity, now: number): number {
  return Math.max(0, now - activity.lastActivityAt)
}

/**
 * Is the phone capturing audio right now?
 *
 * Deliberately does NOT require `visibilityState === 'visible'`. A backgrounded
 * companion buffering to IndexedDB is the single most common legitimate reason
 * for quiet, and demanding visibility here would reap exactly the sessions the
 * drain path exists to rescue.
 */
export function capturingNow(heartbeat: SessionHeartbeat | null | undefined, now: number): boolean {
  if (!heartbeat) return false
  if (!Number.isFinite(heartbeat.at)) return false
  if (now - heartbeat.at > LIVENESS_GRACE_MS) return false
  // A heartbeat from the future is a clock artifact, not evidence of capture.
  if (heartbeat.at - now > LIVENESS_GRACE_MS) return false
  return CAPTURING_AUDIO_STATES.has((heartbeat.audioState ?? '').trim())
}

/**
 * What should the sweeper do with this session?
 *
 * `promote` is unconditional at the retention cutoff, matching the close it
 * replaces — a session that has been silent for four hours becomes a meeting even
 * if something is still heartbeating, because that is already the behavior today
 * and weakening it would strand audio for longer than the old code did.
 */
export function classifyStrandedSession(activity: SessionActivity, now: number): StrandedVerdict {
  const idleFor = strandedForMs(activity, now)
  if (idleFor >= STRANDED_PROMOTE_MS) return 'promote'
  if (capturingNow(activity.heartbeat, now)) return 'live'
  if (idleFor >= STRANDED_STALE_MS) return 'stale'
  return 'live'
}
