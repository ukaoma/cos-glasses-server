// Last-known companion state per recording session.
//
// The stranded-session sweeper needs POSITIVE evidence that a phone is still
// capturing before it declares a quiet session stale. That evidence already
// arrives on POST /api/diag/client as a heartbeat carrying `audioState` and
// `visibilityState`, but it was only ever appended to client-diagnostics.jsonl —
// a file the sweeper would have to parse on every 60s tick. This keeps the newest
// heartbeat per session in memory instead.
//
// DELIBERATELY LOSSY, and safe to be. `clientLog` is fire-and-forget with a 3s
// abort and a silent catch: 63% of heartbeats were measured missing during one
// 2026-07-27 session. So an ABSENT heartbeat proves nothing and must never by
// itself mark a session dead — the sweeper's staleness signal is chunk arrival,
// and a heartbeat can only ever VETO a stale verdict, never cause one.

import type { SessionHeartbeat } from './stranded-sessions.js'

/**
 * Bounded so a burst of zombie clients cannot grow this without limit. Well above
 * any real fleet: a session is one phone, and the sweeper deletes entries as
 * sessions close.
 */
const MAX_TRACKED_SESSIONS = 64

const heartbeats = new Map<string, SessionHeartbeat>()

/** Record the newest heartbeat for a session. Older timestamps are ignored. */
export function recordSessionHeartbeat(
  sessionId: string,
  heartbeat: SessionHeartbeat,
): void {
  if (!sessionId) return
  if (!Number.isFinite(heartbeat.at)) return
  const existing = heartbeats.get(sessionId)
  if (existing && existing.at > heartbeat.at) return
  heartbeats.set(sessionId, heartbeat)
  if (heartbeats.size <= MAX_TRACKED_SESSIONS) return
  // Evict oldest-first so the entries that matter (recent, therefore capable of
  // vetoing a stale verdict) are the ones retained.
  const ordered = [...heartbeats.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [id] of ordered.slice(0, heartbeats.size - MAX_TRACKED_SESSIONS)) {
    heartbeats.delete(id)
  }
}

export function getSessionHeartbeat(sessionId: string): SessionHeartbeat | null {
  return heartbeats.get(sessionId) ?? null
}

/** Called when a session reaches any terminal state. */
export function forgetSessionHeartbeat(sessionId: string): void {
  heartbeats.delete(sessionId)
}

/** Test seam only. */
export function resetSessionHeartbeats(): void {
  heartbeats.clear()
}

export function trackedHeartbeatCount(): number {
  return heartbeats.size
}
