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
// NO REPLAY BUFFER HERE EITHER, and that is a decision rather than an omission. A
// reconnecting client resumes LIVE and its 5s/15s/60s poll is what fills the gap it
// missed; the contract gives it `seq` precisely so it can SEE the gap. Retaining a
// per-session ring would add memory that grows with the number of sessions ever
// opened, to duplicate a fallback that already exists and already works.

import type { SessionStreamDraft } from './session-stream-events.js'

/** A draft with the publish instant stamped. `seq` stays per connection. */
export type PublishedSessionEvent = SessionStreamDraft & { at: number }

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

  let released = false
  return () => {
    // Idempotent. A double release from a close handler that fires twice must not
    // delete a key another subscriber still holds.
    if (released) return
    released = true
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
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
  const event: PublishedSessionEvent = { ...draft, at }
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
}
