// GET /api/agent-sessions/:provider/:sessionId/stream
//
// Server-sent events for ONE agent session. Each `data:` line is one JSON object:
//
//   {"seq":1,"at":1786890000000,"kind":"tool","verb":"read","target":"x.ts","detail":"","cursor":41,"epoch":1789...}
//   {"seq":2,"at":1786890001000,"kind":"prose","text":"...","cursor":42,"epoch":1789...}
//   {"seq":3,"at":1786890002000,"kind":"status","state":"working","agent_state":"running",...}
//   {"seq":4,"at":1786890003000,"kind":"heartbeat"}
//
// `seq` is monotonic PER CONNECTION from 1, so a client detects loss from a gap. There
// are no named SSE events and no comment keepalives: one shape, so a client needs one
// handler and can never miss a keepalive it was not parsing.
//
// 6.48.1 adds, all ignorable by a client that reads `data:` lines and known fields:
//   - `cursor` and `epoch` on every event the per-session ring remembers, and an SSE
//     `id: <epoch>.<cursor>` line before it. `?after=<epoch>.<cursor>` (or the standard
//     `Last-Event-ID` header) replays what that ring holds after the cursor, from the
//     same server life only; anything else, and an empty replay, seeds as a fresh open.
//   - `?seed=turn` seeds from the current turn's prompt instead of the last 7 steps.
//   - the derived state fields on every `status` draft (`COS_SESSION_HOOK_SSE=0` omits
//     them), and a `status` line on every change of that state.
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
import { draftsFromLine, statusDraftWithDerived, type DerivedStatusFields } from '../lib/session-stream-events.js'
import type { SessionStreamState } from '../lib/session-stream-events.js'
import { RING_EPOCH, replaySessionStream, ringBounds } from '../lib/session-stream-bus.js'
import { claudeSessionsDir, readClaudePeerRecords, registryFacts } from './claude-sessions.js'
import type { RegistryFacts } from '../lib/session-state-derive.js'
import { deriveForRow, sessionHooksEnabled, sessionSignalStore } from '../lib/session-hooks-runtime.js'
import { derivedStatusFields } from '../lib/session-state-derive.js'

export const agentSessionStreamRouter = Router()

/** Inside the contract's 20s ceiling with room for one lost write. */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Events held between subscribing and the headers going out. Bounded; see below. */
export const PREHEADER_BUFFER_MAX = 200

export function sessionStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_SESSION_STREAM_ENABLED !== '0'
}

/**
 * 6.48.1: the derived session state rides every `status` draft as extra fields (see
 * `statusDraftWithDerived`). `COS_SESSION_HOOK_SSE=0` keeps the drafts exactly as 6.48.0
 * wrote them; the hooks themselves are unaffected. Absent means on.
 */
export function sessionHookSseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_SESSION_HOOK_SSE !== '0' && sessionHooksEnabled()
}

/**
 * The derived state for a Claude session the stream is showing, or nothing.
 *
 * SAME INPUTS AS THE ROWS (QA, 2026-09-15): the registry facts (so an Esc-interrupted
 * turn and a stray SessionEnd are read the way the list reads them) and whether a COS
 * turn is attached (which is `running`, whatever the tab's hooks last said). The
 * registry is read once per connection and again at most every REGISTRY_REFRESH_MS.
 */
export const REGISTRY_REFRESH_MS = 5_000

type RegistryReader = () => Promise<RegistryFacts | undefined>

function derivedForStream(provider: AgentProvider, sessionId: string, key: string, registry: RegistryFacts | undefined): DerivedStatusFields | undefined {
  if (provider !== 'claude' || !sessionHookSseEnabled()) return undefined
  try {
    const derived = deriveForRow({ sessionId, registry, remember: false, attachedTurn: isAttachedTurnActive(key) })
    return derived ? derivedStatusFields(derived) : undefined
  } catch {
    return undefined
  }
}

/** The registry record for a session, cached briefly; undefined when none names it. */
function registryReaderFor(sessionId: string): RegistryReader {
  const wanted = sessionId.toLowerCase()
  let cached: { at: number; facts: RegistryFacts | undefined } | null = null
  return async () => {
    if (cached && Date.now() - cached.at < REGISTRY_REFRESH_MS) return cached.facts
    let facts: RegistryFacts | undefined
    try {
      const record = (await readClaudePeerRecords(claudeSessionsDir())).find(p => p.sessionId === wanted || p.sessionId.startsWith(wanted))
      facts = record ? registryFacts(record) : undefined
    } catch {
      facts = undefined
    }
    cached = { at: Date.now(), facts }
    return facts
  }
}

/**
 * Whether a cursor can be replayed from a ring with these bounds: only when the ring
 * still holds the event right after it (an evicted cursor would replay the whole ring
 * with the gap unnoticed) and there IS one (a cursor at the newest has nothing to
 * replay, and an empty replay must seed, never open an empty screen).
 */
export function cursorReplayable(after: number | null, bounds: { oldest: number; newest: number } | null): boolean {
  if (after === null || bounds === null) return false
  return bounds.oldest <= after + 1 && after < bounds.newest
}

/** `?after=<epoch>.<cursor>` (the `id:` line's shape) or a bare cursor from this epoch; null when absent or unusable. */
export function parseAfterCursor(raw: unknown, epoch: number = RING_EPOCH): number | null {
  if (typeof raw !== 'string') return null
  const m = /^(?:(\d{1,16})\.)?(\d{1,12})$/.exec(raw.trim())
  if (!m) return null
  if (m[1] !== undefined && Number(m[1]) !== epoch) return null
  return Number(m[2])
}

/** A turn-anchored seed (`?seed=turn`): the newest prompt and EVERY step after it, bounded. */
export const TURN_SEED_MAX_STEPS = 500

function asProvider(value: string): AgentProvider | null {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value
  return null
}

/**
 * The TRANSPORT's opening state, before the derived state is stamped over it.
 *
 * `working` when a COS turn is writing right now, or when the transcript was touched
 * inside the same 30s window the session list already uses to call a thread active.
 * Otherwise `idle`. Never `done` from HERE: this function cannot observe the end of a
 * turn it did not start. Since 6.48.1 `write()` restates `state` from the deriver when
 * the hooks are on, and an engine that said SessionEnd (with no live registry record
 * behind the session) opens as `done`, which is the client's digest body and intended.
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

  // The registry facts the feed derives with: read in the same pre-header window as the
  // opening state (nothing awaits once the headers are out, so a close can never slip
  // between a write and the `close` listener), refreshed at most every REGISTRY_REFRESH_MS.
  const readRegistry = registryReaderFor(sessionId)
  let registry: RegistryFacts | undefined = await readRegistry()

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

  let releaseSignals: (() => void) | null = null

  const teardown = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== null) clearInterval(heartbeat)
    unsubscribe()
    releaseWatcher?.()
    releaseSignals?.()
    try { res.end() } catch { /* already gone */ }
  }

  let lastStamp = ''
  const stampOf = (d: DerivedStatusFields | undefined) => d ? `${d.agent_state}|${d.waiting_kind ?? ''}|${d.waiting_detail ?? ''}|${d.failure ?? ''}` : ''

  const write = (event: PublishedSessionEvent): void => {
    if (closed) return
    try {
      // ONE stamping point for the derived state: every status draft this connection
      // writes, opening or live, seeded or published, carries the same extra fields.
      let out: PublishedSessionEvent = event
      if (event.kind === 'status') {
        const derived = derivedForStream(provider, sessionId, key, registry)
        lastStamp = stampOf(derived)
        out = { ...event, ...statusDraftWithDerived(event, derived) }
      }
      const idLine = typeof out.cursor === 'number' ? `id: ${out.epoch ?? RING_EPOCH}.${out.cursor}\n` : ''
      res.write(`${idLine}data: ${JSON.stringify({ seq: ++seq, ...out })}\n\n`)
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
  // fills one line at a time, which is what the user reported from hardware. The screen
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
  // 6.48.1 RECONNECT: `?after=<cursor>` replays from the session's ring instead of
  // seeding, when the ring still reaches back that far. A ring that does not (server
  // restarted, linger expired) falls through to the seed, and the client sees a cursor
  // jump it treats as a reseed.
  // The standard SSE header is honoured as the fallback for `?after=`; the shipped lens
  // and Control both pass the query and read `data:` lines only.
  const after = parseAfterCursor(req.query.after) ?? parseAfterCursor(req.get('last-event-id'))
  const bounds = ringBounds(key)
  // Replayable only when the cursor is from THIS epoch, the ring reaches back to it, it
  // is not past the ring, and the ring actually holds something after it. A ring that
  // holds nothing after the cursor (the sole client was away, so nothing was published
  // while it was gone) seeds instead: an empty replay must never be an empty screen
  // (QA, 2026-09-15).
  const replay = after !== null && cursorReplayable(after, bounds) ? replaySessionStream(key, after) : []
  const replayable = replay.length > 0
  for (const event of replay) write(event)
  const seedMode = String(req.query.seed ?? '') === 'turn' ? 'turn' : 'window'

  if (!replayable && path !== null && startOffset > 0) {
    try {
      const lines = await readTranscriptSeedLines(path, startOffset)
      const drafts = lines.flatMap(line => draftsFromLine(provider, line))
      // Status drafts are dropped from the seed: they describe the state at some past
      // moment and the opening status above is the CURRENT one. Replaying an old
      // `done` after it would tell the client the live session had finished.
      // THE QUERY IS SEEDED SEPARATELY, AND ALWAYS.
      //
      // Taking "the last 7 events" and hoping the prompt is among them does not work,
      // and a live probe against a real session proved it: 8 seeded events, 6 tools and
      // one prose, and NO prompt -- because in a busy run the user's question is twenty
      // or thirty steps back and gets pushed out of the window by the very activity you
      // opened the page to watch. That is the exact case the query exists for.
      //
      // So the newest prompt in the whole read window is emitted FIRST, unconditionally,
      // and the step budget is spent entirely on steps. The client pins it rather than
      // listing it, so it costs nothing in the scrolling window.
      const lastPromptIndex = drafts.map(d => d.kind).lastIndexOf('prompt')
      const lastPrompt = lastPromptIndex >= 0 ? drafts[lastPromptIndex] : undefined
      if (lastPrompt) write({ ...lastPrompt, at: Date.now() })

      // 6.48.1 `?seed=turn`: the whole current turn, oldest first, so a client opening
      // mid-turn reads it top to bottom (Terminal V2's turn-anchored open). The default
      // stays the last SEED_EVENTS steps, which is what shipped lenses were built for.
      const steps = drafts.filter(d => d.kind === 'tool' || d.kind === 'prose')
      const turnSteps = lastPromptIndex >= 0 ? drafts.slice(lastPromptIndex + 1).filter(d => d.kind === 'tool' || d.kind === 'prose') : steps
      const seeded = seedMode === 'turn' ? turnSteps.slice(-TURN_SEED_MAX_STEPS) : steps.slice(-SEED_EVENTS)
      for (const draft of seeded) {
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

  // 6.48.1: every change to this session's hook signal is a live `status` draft, so the
  // client's state line moves on the engine's own events (prompt, permission prompt,
  // Stop, end) rather than on the transcript clock. Filtered to this session (the
  // client may have addressed it by the registry's 8-character form).
  if (provider === 'claude' && sessionHookSseEnabled() && !closed) {
    const wanted = sessionId.toLowerCase()
    // `lastStamp` is whatever the OPENING status actually wrote (set inside `write`), so a
    // change during the seed read is emitted as the first live line, not lost.
    releaseSignals = sessionSignalStore.subscribe(signal => {
      if (closed) return
      if (signal.sessionId !== wanted && !signal.sessionId.startsWith(wanted)) return
      // The registry may have moved with the hooks (an Esc flips it idle); refresh it
      // off the hot path and let the next event read the new facts.
      void readRegistry().then(facts => { registry = facts })
      const derived = derivedForStream(provider, sessionId, key, registry)
      if (!derived) return
      // Only a CHANGE of state is a line; tool events inside a running turn are narrated
      // by the transcript tail and must not each repaint the state.
      if (stampOf(derived) === lastStamp) return
      write({ kind: 'status', state: 'working', at: Date.now() })
    })
  }

  releaseWatcher = path === null
    ? null
    : acquireTranscriptWatcher({ key, path, provider, offset: startOffset })
  // The socket may already have died during the writes above. Acquiring a watcher for
  // a closed connection would leave it polling with nobody listening.
  if (closed) {
    releaseWatcher?.()
    releaseWatcher = null
    releaseSignals?.()
    releaseSignals = null
    return
  }

  req.on('close', teardown)
  res.on('error', teardown)
})
