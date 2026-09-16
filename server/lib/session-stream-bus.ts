// Per-session pub/sub for the live session stream.
//
// WHY THIS IS NOT `display-bus.ts`, given the instruction to reuse the SSE machinery.
// The SSE machinery being reused is the TRANSPORT: `text/event-stream`, the header
// block, `retry:`, the close-on-`req.close` teardown. That pattern is copied from
// `routes/display.ts` verbatim and no second transport is introduced.
//
// The display BUS is a different object with two properties that are wrong here, and
// both would be regressions rather than style disagreements:
//
//   1. It is a GLOBAL BROADCAST. Every `/display-stream` subscriber, which is to say
//      every connected pair of glasses, receives every event published to it. Session
//      events belong to one session detail view; broadcasting them would put another
//      thread's tool trail on the lens, and the plan is explicit that the stream must
//      never write the lens directly.
//   2. It has a 200-EVENT SHARED REPLAY BUFFER. A tool-heavy turn emits hundreds of
//      events in seconds. Pushing those through `emitDisplay` would evict the real
//      display events a reconnecting client replays from, and that client would then
//      be told `buffer_overflow` — a silent loss of query results caused entirely by
//      a feature that only wanted to show a file being read.
//
// So: same transport, own keyspace. This module is deliberately small.
//
// A BOUNDED REPLAY RING PER STREAMED SESSION (6.48.1), and why the earlier "no ring"
// decision moved. `seq` stays per connection, so a shipped client still sees its gaps;
// a new client ALSO reads `cursor`, monotonic per session for this server's life, and
// reconnects with `?after=<cursor>` to be handed what it missed instead of a fresh
// seed. The ring holds the last RING_MAX published events, keeps the ACTIVE TURN whole
// (from its newest `prompt` draft onward, up to RING_HARD_MAX) and is dropped with the
// session's last subscriber plus a linger, so memory is bounded by streamed sessions,
// not by sessions ever opened. Even Terminal 0.10.4 ships the same shape (500-event
// ring, replay on reconnect, the active turn always retained).

import type { SessionStreamDraft } from './session-stream-events.js'

/** A draft with the publish instant stamped. `seq` stays per connection; `cursor` is per session within `epoch`. */
export type PublishedSessionEvent = SessionStreamDraft & { at: number; cursor?: number; epoch?: number }

/**
 * Cursors are meaningful only within one server life: a client holding a cursor from
 * before a restart would otherwise be handed the wrong events from a fresh ring with no
 * gap to notice (QA, 2026-09-15). Every event carries the epoch, and the SSE `id:` line
 * is `<epoch>.<cursor>`; the route refuses to replay across epochs.
 */
export const RING_EPOCH = Date.now()

/** Events the ring keeps per session. */
export const RING_MAX = 500
/** The active turn is never cut short of this. */
export const RING_HARD_MAX = 2_000
/** A session's ring outlives its last subscriber this long, so a reconnect finds the gap. */
export const RING_LINGER_MS = 5 * 60_000

interface Ring {
  events: Array<PublishedSessionEvent & { cursor: number }>
  nextCursor: number
  /** Index into `events` of the newest prompt draft, or -1. */
  turnStart: number
  emptySince: number | null
}

const rings = new Map<string, Ring>()

function ringFor(key: string): Ring {
  let ring = rings.get(key)
  if (!ring) {
    ring = { events: [], nextCursor: 1, turnStart: -1, emptySince: null }
    rings.set(key, ring)
  }
  return ring
}

function remember(key: string, event: PublishedSessionEvent): PublishedSessionEvent & { cursor: number } {
  const ring = ringFor(key)
  const stamped = { ...event, cursor: ring.nextCursor++, epoch: RING_EPOCH }
  ring.events.push(stamped)
  if (stamped.kind === 'prompt') ring.turnStart = ring.events.length - 1
  // Trim the oldest, but never into the active turn until the hard cap.
  while (ring.events.length > RING_MAX) {
    if (ring.turnStart === 0 && ring.events.length <= RING_HARD_MAX) break
    ring.events.shift()
    if (ring.turnStart >= 0) ring.turnStart--
  }
  return stamped
}

/** Events published to this session after `afterCursor`, oldest first. Empty for an unknown session. */
export function replaySessionStream(key: string, afterCursor: number): Array<PublishedSessionEvent & { cursor: number }> {
  const ring = rings.get(key)
  if (!ring) return []
  const after = Number.isFinite(afterCursor) ? afterCursor : 0
  return ring.events.filter(e => e.cursor > after)
}

/** The ring's oldest and newest cursors, so a client can tell a replay from a reseed. */
export function ringBounds(key: string): { oldest: number; newest: number } | null {
  const ring = rings.get(key)
  if (!ring || ring.events.length === 0) return null
  return { oldest: ring.events[0].cursor, newest: ring.events[ring.events.length - 1].cursor }
}

/** Drop rings whose session has had no subscriber for the linger. Called by the route on release. */
export function sweepSessionRings(nowMs = Date.now()): number {
  let dropped = 0
  for (const [key, ring] of rings) {
    if (ring.emptySince !== null && nowMs - ring.emptySince > RING_LINGER_MS) { rings.delete(key); dropped++ }
  }
  return dropped
}

export type SessionStreamListener = (event: PublishedSessionEvent) => void

/**
 * Concurrent subscribers to ONE session.
 *
 * Small on purpose. The realistic count is one pair of glasses plus, briefly, a
 * reconnecting duplicate of it. A ceiling means a client stuck in a reconnect loop
 * costs a bounded number of file watchers rather than an unbounded one.
 */
export const MAX_SUBSCRIBERS_PER_SESSION = 8

/** Sessions streamed at once. Each carries at most one poller. */
export const MAX_STREAMED_SESSIONS = 16

const listeners = new Map<string, Set<SessionStreamListener>>()

/**
 * Sessions with a COS-spawned turn writing to them right now.
 *
 * A counter, not a boolean: it is set and cleared by the turn's own lifecycle and a
 * counter cannot be left stuck true by an unbalanced pair the way a boolean can, since
 * an extra clear floors at zero instead of silently disabling the gate.
 */
const attachedTurns = new Map<string, number>()

export function sessionStreamKey(provider: string, sessionId: string): string {
  return `${String(provider).trim().toLowerCase()}:${String(sessionId).trim().toLowerCase()}`
}

export function subscriberCount(key: string): number {
  return listeners.get(key)?.size ?? 0
}

export function streamedSessionCount(): number {
  return listeners.size
}

/** Null when a ceiling is reached; the caller answers 503 and the client polls. */
export function subscribeSessionStream(key: string, listener: SessionStreamListener): (() => void) | null {
  const existing = listeners.get(key)
  if (existing && existing.size >= MAX_SUBSCRIBERS_PER_SESSION) return null
  if (!existing && listeners.size >= MAX_STREAMED_SESSIONS) return null

  const set = existing ?? new Set<SessionStreamListener>()
  set.add(listener)
  listeners.set(key, set)
  ringFor(key).emptySince = null

  let released = false
  return () => {
    // Idempotent. A double release from a close handler that fires twice must not
    // delete a key another subscriber still holds.
    if (released) return
    released = true
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(key)
      const ring = rings.get(key)
      if (ring) ring.emptySince = Date.now()
      sweepSessionRings()
    }
  }
}

/**
 * Fan out one draft.
 *
 * A throwing listener is isolated: one dead socket must not stop the others from being
 * written, and must not propagate back into the provider stdout handler that called
 * this. Iterating a COPY additionally means a listener that unsubscribes itself while
 * being notified cannot corrupt the iteration.
 */
export function publishSessionStream(key: string, draft: SessionStreamDraft, at: number = Date.now()): number {
  const set = listeners.get(key)
  if (!set || set.size === 0) return 0
  // Remembered BEFORE fan-out, so a listener that reads the ring sees this event too.
  const event: PublishedSessionEvent = remember(key, { ...draft, at })
  let delivered = 0
  for (const listener of [...set]) {
    try {
      listener(event)
      delivered++
    } catch {
      /* a broken subscriber costs itself, never the publisher or its peers */
    }
  }
  return delivered
}

/**
 * Mark a COS-spawned turn as the live writer for this session.
 *
 * THE DUPLICATE-SUPPRESSION GATE. A Continue turn appears TWICE: once as the stdout
 * this server tees in Phase 1, and again as the transcript records the provider writes
 * to the very file Phase 2 is tailing. Without a gate the reader sees every tool call
 * and every reply twice.
 *
 * stdout wins while it exists, because it is live rather than post-hoc. The watcher
 * keeps advancing its offset through the suppressed region, so when the turn ends the
 * cursor is already past those records and nothing is replayed.
 */
export function beginAttachedTurn(key: string): () => void {
  attachedTurns.set(key, (attachedTurns.get(key) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const next = (attachedTurns.get(key) ?? 0) - 1
    if (next > 0) attachedTurns.set(key, next)
    else attachedTurns.delete(key)
  }
}

export function isAttachedTurnActive(key: string): boolean {
  return (attachedTurns.get(key) ?? 0) > 0
}

export function __resetSessionStreamBusForTests(): void {
  listeners.clear()
  attachedTurns.clear()
  rings.clear()
}
