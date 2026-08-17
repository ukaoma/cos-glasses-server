// GET /api/agent-sessions/:provider/:sessionId/stream
//
// Server-sent events for ONE agent session. Each `data:` line is one JSON object:
//
//   {"seq":1,"at":1786890000000,"kind":"tool","verb":"read","target":"x.ts","detail":""}
//   {"seq":2,"at":1786890001000,"kind":"prose","text":"..."}
//   {"seq":3,"at":1786890002000,"kind":"status","state":"working"}
//   {"seq":4,"at":1786890003000,"kind":"heartbeat"}
//
// `seq` is monotonic PER CONNECTION from 1, so a client detects loss from a gap. There
// are no named SSE events and no comment keepalives: one shape, so a client needs one
// handler and can never miss a keepalive it was not parsing.
//
// ---------------------------------------------------------------------------
// A DEAD STREAM MUST DEGRADE TO THE POLL, NEVER TO A FROZEN SCREEN
// ---------------------------------------------------------------------------
// Everything here is arranged so failure is DETECTABLE rather than silent:
//
//   - A `status` is written before anything else, so the live view is never empty.
//   - A `heartbeat` every 15s, inside the contract's 20s ceiling. Quiet past that is
//     a dead stream, and the client resumes its 5s/15s/60s tiers.
//   - Every refusal happens BEFORE the SSE headers, as ordinary JSON with a status
//     code, so the client sees a failed request rather than an open socket that never
//     speaks.
//   - A write that throws tears the connection down rather than being swallowed.
//
// This route NEVER writes the lens. It hands events to the client, which owns every
// paint. A second writer to the renderer is how `enqueue` deadlocked and blanked the
// HUD, and no server route is going to reintroduce that.
//
// ---------------------------------------------------------------------------
// THE FLAG DECISION: this is NOT behind `COS_THREAD_ATTACH_ENABLED`
// ---------------------------------------------------------------------------
// That flag gates WRITING into somebody's live conversation, and with it off the two
// write routes are not registered at all. This route writes nothing. It streams
// records from a transcript that `GET /api/agent-sessions/:provider/:sessionId`
// already returns in full, to the same authenticated caller, through the same token.
// Reusing the write flag would mean a desktop session -- Case B, which involves no
// attaching whatsoever -- could not stream unless the user had first enabled the
// ability to write into their threads. That is a worse posture, not a safer one: it
// pushes people toward turning the write flag on to get a read feature.
//
// Phase 1 remains gated exactly as before, and not by anything here: a Continue turn
// can only exist when `COS_THREAD_ATTACH_ENABLED=1`, so with the flag off this route
// carries desktop rows and nothing else.
//
// `COS_SESSION_STREAM_ENABLED=0` is a separate kill switch for the streaming surface
// alone. Absent means ON. That is safe here specifically because nothing writes this
// key -- no COS Control toggle, no installer, no plist generator -- so key-absence can
// never be mistaken for a user's explicit opt-out. Off answers 503 and the client
// polls, which is the same code path as a server too old to have this route at all.

import { Router, type Response } from 'express'
import { stat } from 'node:fs/promises'
import {
  agentSessionRoots,
  findAgentSessionFile,
  isSafeSessionId,
  type AgentProvider,
} from '../lib/agent-session-store.js'
import { ACTIVE_RECENTLY_WINDOW_MS } from '../lib/thread-occupancy.js'
import {
  isAttachedTurnActive,
  sessionStreamKey,
  subscribeSessionStream,
  type PublishedSessionEvent,
} from '../lib/session-stream-bus.js'
import {
  acquireTranscriptWatcher,
  transcriptWatcherDegraded,
  readTranscriptSeedLines,
} from '../lib/session-transcript-watcher.js'
import { draftsFromLine } from '../lib/session-stream-events.js'
import type { SessionStreamState } from '../lib/session-stream-events.js'

export const agentSessionStreamRouter = Router()

/** Inside the contract's 20s ceiling with room for one lost write. */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Events held between subscribing and the headers going out. Bounded; see below. */
export const PREHEADER_BUFFER_MAX = 200

export function sessionStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_SESSION_STREAM_ENABLED !== '0'
}

function asProvider(value: string): AgentProvider | null {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value
  return null
}

/**
 * The state to open with.
 *
 * `working` when a COS turn is writing right now, or when the transcript was touched
 * inside the same 30s window the session list already uses to call a thread active.
 * Otherwise `idle`. Never `done`: this route cannot observe the end of a turn it did
 * not start, and claiming one would be an invention.
 */
export async function openingState(
  key: string,
  path: string | null,
  nowMs: number,
): Promise<SessionStreamState> {
  if (isAttachedTurnActive(key)) return 'working'
  if (path === null) return 'idle'
  try {
    const st = await stat(path)
    return nowMs - st.mtimeMs <= ACTIVE_RECENTLY_WINDOW_MS ? 'working' : 'idle'
  } catch {
    return 'idle'
  }
}

/**
 * Seeded events written on connect.
 *
 * EXACTLY THE LIVE WINDOW. `SESSION_TRAIL_LIVE_LINES` on the client is 7, measured
 * against the 220px body; seeding more would scroll the newest events out of the view
 * the seed exists to fill, and seeding fewer would leave the screen half empty.
 */
export const SEED_EVENTS = 7

agentSessionStreamRouter.get('/agent-sessions/:provider/:sessionId/stream', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')

  const provider = asProvider(String(req.params.provider ?? '').toLowerCase())
  const sessionId = String(req.params.sessionId ?? '')
  if (!provider) {
    res.status(400).json({ error: 'provider must be claude, codex, or cursor', reason: 'bad_provider' })
    return
  }
  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: 'invalid session id', reason: 'bad_session_id' })
    return
  }
  if (!sessionStreamEnabled()) {
    res.status(503).json({ error: 'session streaming is disabled', reason: 'stream_disabled' })
    return
  }

  const key = sessionStreamKey(provider, sessionId)

  // Resolved BEFORE the headers so a missing transcript is a 404 the client can act on
  // rather than an open socket that turns out to carry nothing. Null is not fatal for
  // Phase 1: a Continue turn streams from stdout whether or not the file is locatable.
  let path: string | null = null
  try {
    path = await findAgentSessionFile(provider, sessionId, agentSessionRoots())
  } catch {
    path = null
  }
  if (path === null && !isAttachedTurnActive(key)) {
    res.status(404).json({ error: 'Session not found', reason: 'session_not_found' })
    return
  }

  // Capacity is checked before the headers for the same reason. A refused subscribe is
  // a 503 the client falls back from, not a stream that silently receives nothing.
  //
  // Subscribing happens HERE, two awaits before the headers, so a turn that starts in
  // that window is not lost. Until the headers go out the events are buffered, bounded
  // by `PREHEADER_BUFFER_MAX` -- an unbounded buffer in front of a socket that may
  // never open is a leak, and the poll fallback covers anything dropped.
  const pending: PublishedSessionEvent[] = []
  let deliver = (event: PublishedSessionEvent): void => {
    pending.push(event)
    if (pending.length > PREHEADER_BUFFER_MAX) pending.shift()
  }
  const unsubscribe = subscribeSessionStream(key, event => { deliver(event) })
  if (unsubscribe === null) {
    res.status(503).json({ error: 'too many live streams', reason: 'stream_capacity' })
    return
  }

  // Where the tail joins: the file's CURRENT size. A subscriber wants what happens
  // next, and the history it already has came from the polled detail payload. Starting
  // at zero would replay an 81 MB transcript into a pair of glasses.
  let startOffset = 0
  try {
    if (path !== null) startOffset = (await stat(path)).size
  } catch {
    startOffset = 0
  }

  const state = await openingState(key, path, Date.now())

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 3000\n\n')

  // Declared before `teardown` reads them. Both are assigned below; a `const` here
  // would put them in the temporal dead zone for a teardown triggered by the very
  // first write, and that ReferenceError would leak the subscription it exists to
  // release.
  let releaseWatcher: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  let seq = 0
  let closed = false

  const teardown = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== null) clearInterval(heartbeat)
    unsubscribe()
    releaseWatcher?.()
    try { res.end() } catch { /* already gone */ }
  }

  const write = (event: PublishedSessionEvent): void => {
    if (closed) return
    try {
      res.write(`data: ${JSON.stringify({ seq: ++seq, ...event })}\n\n`)
    } catch {
      // A failed write means the socket is gone. Close rather than swallow, so the
      // watcher and the subscription are released instead of leaking behind a dead
      // client that will never send `close`.
      teardown()
    }
  }

  heartbeat = setInterval(() => {
    // The tail gave up on a record too large to stream (see session-transcript-watcher).
    // END the response rather than heartbeat over a dead tail: the client's fallback to
    // its own poll is already written and tested, and a socket that stays "live" while
    // producing nothing is worse than no socket at all.
    if (transcriptWatcherDegraded(key)) {
      teardown()
      return
    }
    write({ kind: 'heartbeat', at: Date.now() })
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof (heartbeat as any).unref === 'function') (heartbeat as any).unref()

  // The contract's "emit a status immediately" -- written before any queued event so
  // the client's first frame is always a state, never a bare tool line.
  write({ kind: 'status', state, at: Date.now() })
  // THE SEED. The last few steps of what already happened, before anything live.
  //
  // Without it, opening a session that is already working shows an empty page that
  // fills one line at a time, which is what Miles reported from hardware. The screen
  // should look like a monitor you just walked up to, not one that was switched on.
  //
  // BOUNDED TO WHAT THE LENS CAN SHOW. `SEED_EVENTS` is the live window, so the seed
  // fills the screen once and no more: a hundred replayed events would push the live
  // ones off the top of the very view they are meant to prime.
  //
  // ORDERED BEFORE `deliver = write`, so a live record landing during the read is
  // queued in `pending` and written AFTER the seed rather than being overtaken by it.
  //
  // NEVER FATAL. A session whose history cannot be read still streams; it just starts
  // empty, exactly as it did before this existed.
  if (path !== null && startOffset > 0) {
    try {
      const lines = await readTranscriptSeedLines(path, startOffset)
      const drafts = lines.flatMap(line => draftsFromLine(provider, line))
      // Status drafts are dropped from the seed: they describe the state at some past
      // moment and the opening status above is the CURRENT one. Replaying an old
      // `done` after it would tell the client the live session had finished.
      const steps = drafts.filter(d => d.kind === 'tool' || d.kind === 'prose' || d.kind === 'prompt')
      for (const draft of steps.slice(-SEED_EVENTS)) {
        // NOT tagged as seeded. A replayed step is a step that really happened, and a
        // second rendering style for it would be a distinction without a use. The one
        // consequence is that the client's "N ago" clock starts at open rather than at
        // the record's real time; it self-corrects on the first live event.
        write({ ...draft, at: Date.now() })
      }
    } catch {
      /* a seed is a nicety; the live tail is the contract */
    }
  }
  if (closed) return

  // Then anything published while the headers were being prepared, in order, before
  // the listener starts writing straight through. All three steps are synchronous, so
  // no event can interleave and arrive out of order.
  for (const event of pending.splice(0)) write(event)
  deliver = write

  releaseWatcher = path === null
    ? null
    : acquireTranscriptWatcher({ key, path, provider, offset: startOffset })
  // The socket may already have died during the writes above. Acquiring a watcher for
  // a closed connection would leave it polling with nobody listening.
  if (closed) {
    releaseWatcher?.()
    releaseWatcher = null
    return
  }

  req.on('close', teardown)
  res.on('error', teardown)
})
