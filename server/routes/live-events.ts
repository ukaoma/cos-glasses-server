// GET /api/events (7.0.1 live state). The contract is docs/live-events-contract.md; the hub is lib/live-events.ts.
//
// ONE stream per open Control Web page. It tells the page when the server's own session state changes (a session
// opens, works, waits, idles or ends; a reply lands; a question opens or closes; the queue moves), so the pet, the
// session rows, Today's counts and the running clocks stop drifting between polls.
//
// TRANSPORT, copied from the per-session stream that already works through Tailscale Serve and the https listener
// (agent-session-stream.ts): the same four headers, `flushHeaders()`, `retry:` first, one JSON object per `data:`
// line with no named events and no comment keepalives, a heartbeat every 15 s, and every refusal BEFORE the headers
// as ordinary JSON so a client sees a failed request, never a socket that never speaks.
//
// AUTH is the global /api gate (token header or the Control Web cookie), exactly as for `/stream`. Nothing here
// re-checks it, so nothing here can drift from it.
//
// SWITCH: COS_WEB_LIVE_EVENTS. Absent means on. `0` registers no route at all (404), which is also what a client
// sees from a server older than 7.0.1, so both take the same polling path.

import { Router, type Request, type Response } from 'express'
import { readSwitch } from '../lib/env-switch.js'
import {
  LIVE_ENDED_LINGER_MS,
  LiveEventsHub,
  parseLiveCursor,
  type LiveFrame,
  type LiveProvider,
  type LiveQuestionReading,
  type LiveQueueReading,
  type LiveSessionReading,
  type LiveSources,
  type LiveState,
} from '../lib/live-events.js'
import { claudeSessionsDir, claudeSessionsEnabled, readClaudePeerRecords, registryFacts } from './claude-sessions.js'
import type { ClaudePeerRecord } from '../lib/claude-session-registry.js'
import { deriveForRow, sessionHooksEnabled, sessionSignalStore, signalFor } from '../lib/session-hooks-runtime.js'
import type { SessionSignal } from '../lib/session-signal-store.js'
import { isAttachedTurnActive, sessionStreamKey } from '../lib/session-stream-bus.js'
import { runningHintFor } from './agent-sessions.js'
import { queuedThreadKeys, readQueue } from '../lib/thread-turn-queue-store.js'
import type { PermissionBroker } from '../lib/permission-broker.js'

/** Inside a 30 s client deadline with room for one lost write; the same cadence as `/stream`. */
export const LIVE_EVENTS_HEARTBEAT_MS = 15_000
/** Open streams per server. A phone, a laptop and a few tabs each hold one; 16 is room plus a ceiling. */
export const LIVE_EVENTS_MAX_STREAMS = 16
/** Unsent bytes past this close the stream: a slow client is dropped, never buffered without limit. */
export const LIVE_EVENTS_MAX_BUFFER_BYTES = 256 * 1024
/** A hook-only session with no event for this long (and no open turn or wait) is not open. The deriver's open-turn ceiling. */
export const LIVE_SIGNAL_OPEN_WINDOW_MS = 30 * 60_000

/** Absent means on; `0` (or false/off) means no route. Read at server start. */
export function liveEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_LIVE_EVENTS, true)
}

function newestOf(...values: Array<number | null | undefined>): number | null {
  let out: number | null = null
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0 && (out === null || v > out)) out = v
  return out
}

/**
 * One session's reading, from the same derivation the list and the per-session stream use (deriveForRow, then
 * runningHintFor), so `working` here is the list's `running_active` and the pet never disagrees with the rows.
 *
 * Exported for tests. Pure apart from the deriver's own reads of the signal store (remember: false, so it never
 * touches the row readers' two-scan memory).
 */
export function readingFor(provider: LiveProvider, sessionId: string, peer: ClaudePeerRecord | undefined, signal: SessionSignal | undefined, now: number): LiveSessionReading {
  const id = sessionId.toLowerCase()
  const derived = deriveForRow({
    sessionId: id,
    registry: peer ? registryFacts(peer) : undefined,
    now,
    remember: false,
    attachedTurn: isAttachedTurnActive(sessionStreamKey(provider, id)),
  })
  const hookClock = signal ? newestOf(signal.lastEventAt, signal.lastThought?.at) : null
  let state: LiveState
  let source: 'hook' | 'registry' = derived?.state_source === 'hook' ? 'hook' : 'registry'
  if (!derived) {
    // Hooks off: the registry's own status is all there is.
    source = 'registry'
    state = peer?.status === 'busy' ? 'working' : peer?.status === 'waiting' ? 'waiting' : 'idle'
  } else if (derived.agent_state === 'ended') {
    state = 'ended'
  } else {
    const hint = runningHintFor(provider, derived, derived.state_source === 'hook' ? hookClock : null, now, null)
    if (hint?.active) state = 'working'
    // A registry `busy` with no hooks: the list reads its transcript clock here; the registry's word is the closest
    // thing this stream has without a file read, and a busy tab writes its transcript continuously.
    else if (!hint && derived.agent_state === 'running' && derived.state_source !== 'hook') state = 'working'
    else if (derived.agent_state === 'waiting') state = 'waiting'
    else state = 'idle'
  }
  const registryTurn = peer && (peer.status === 'busy' || peer.status === 'waiting') ? peer.statusUpdatedAt : null
  return {
    provider,
    sessionId: id,
    state,
    startedAt: newestOf(peer?.startedAt) ?? newestOf(signal?.firstSeenAt),
    turnStartedAt: signal?.turnOpen && signal.turnStartedAt ? signal.turnStartedAt : registryTurn,
    updatedAt: newestOf(hookClock, peer?.statusUpdatedAt),
    source,
    failed: derived?.agent_state === 'failed',
  }
}

/**
 * Which sessions are open, from the two things the server holds without walking transcripts: the Claude registry
 * (alive records) and the hook signal store. Exported for tests with injected inputs.
 */
export function liveReadings(input: { peers: ClaudePeerRecord[] | null; signals: SessionSignal[]; now: number; signalFor: (id: string) => SessionSignal | undefined; reading?: typeof readingFor }): LiveSessionReading[] {
  const reading = input.reading ?? readingFor
  const out: LiveSessionReading[] = []
  const included = new Set<string>()
  const registryKnown = input.peers !== null
  for (const peer of input.peers ?? []) {
    if (!peer.alive) continue
    const id = peer.sessionId.toLowerCase()
    const key = `claude:${id}`
    if (included.has(key)) continue
    included.add(key)
    out.push(reading('claude', id, peer, input.signalFor(id), input.now))
  }
  for (const signal of input.signals) {
    if (signal.keepWarm) continue
    const provider: LiveProvider = signal.provider === 'codex' || signal.provider === 'cursor' ? signal.provider : 'claude'
    const id = signal.sessionId.toLowerCase()
    const key = `${provider}:${id}`
    if (included.has(key)) continue
    const endedRecently = !!signal.ended && input.now - signal.ended.at <= LIVE_ENDED_LINGER_MS
    const open = !signal.ended && (signal.turnOpen || !!signal.waiting || input.now - signal.lastEventAt <= LIVE_SIGNAL_OPEN_WINDOW_MS)
    // A Claude tab is open while its registry record is alive. With the registry readable and no alive record, a
    // hook record that never said SessionEnd is a tab that died (or a COS child that finished): not open.
    if (provider === 'claude' && registryKnown && !endedRecently) continue
    if (!open && !endedRecently) continue
    included.add(key)
    const r = reading(provider, id, undefined, signal, input.now)
    out.push(endedRecently && r.state !== 'ended' ? { ...r, state: 'ended', turnStartedAt: null } : r)
  }
  return out
}

/** The server's own sources. `broker` is read lazily so the route can mount before the broker exists. */
export function realLiveSources(deps: { broker: () => PermissionBroker | null }): LiveSources {
  return {
    async sessions(now) {
      let peers: ClaudePeerRecord[] | null = null
      let degraded = false
      if (claudeSessionsEnabled()) {
        try { peers = await readClaudePeerRecords(claudeSessionsDir()) } catch { peers = null; degraded = true }
      }
      const signals = sessionHooksEnabled() ? sessionSignalStore.snapshot() : []
      return { sessions: liveReadings({ peers, signals, now, signalFor }), degraded }
    },
    questions() {
      const broker = deps.broker()
      if (!broker) return []
      return broker.list().map((q): LiveQuestionReading => ({ provider: q.provider, sessionId: q.sessionId, kind: q.kind === 'approval' ? 'approval' : 'question' }))
    },
    queue(now) {
      const rows: LiveQueueReading[] = []
      for (const { provider, threadId } of queuedThreadKeys()) {
        if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor') continue
        const count = readQueue(provider, threadId, now).filter(t => t.status === 'waiting').length
        if (count > 0) rows.push({ provider, sessionId: threadId, count })
      }
      return rows
    },
    subscribe(listener) {
      if (!sessionHooksEnabled()) return () => {}
      return sessionSignalStore.subscribe((signal, env, child) => {
        listener({ sessionId: signal.sessionId, turnEnded: !child && (env.event === 'Stop' || env.event === 'StopFailure') })
      })
    },
  }
}

export interface LiveEventsRouterDeps {
  hub: LiveEventsHub
  enabled?: boolean
  maxStreams?: number
  heartbeatMs?: number
  maxBufferBytes?: number
}

/** The stream frame on the wire: `id:` only on frames the ring remembers, then one `data:` line. */
export function frameText(frame: LiveFrame): string {
  const remembered = frame.kind === 'session' || frame.kind === 'session.removed' || frame.kind === 'questions' || frame.kind === 'queue'
  return `${remembered ? `id: ${frame.epoch}.${frame.seq}\n` : ''}data: ${JSON.stringify(frame)}\n\n`
}

export function createLiveEventsRouter(deps: LiveEventsRouterDeps): Router {
  const router = Router()
  if (deps.enabled === false) return router
  router.get('/events', liveEventsHandler(deps))
  return router
}

/** The handler, exported so the backpressure and heartbeat guards can be driven with a fake response. */
export function liveEventsHandler(deps: LiveEventsRouterDeps): (req: Request, res: Response) => Promise<void> {
  const maxStreams = deps.maxStreams ?? LIVE_EVENTS_MAX_STREAMS
  const heartbeatMs = deps.heartbeatMs ?? LIVE_EVENTS_HEARTBEAT_MS
  const maxBuffer = deps.maxBufferBytes ?? LIVE_EVENTS_MAX_BUFFER_BYTES
  let open = 0

  return async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    if (open >= maxStreams) {
      res.status(503).json({ error: 'too many live streams', reason: 'live_events_capacity' })
      return
    }
    open++
    let closed = false
    let detach: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    // Frames that arrive while the snapshot is being prepared, written after it in order. Bounded like the buffer.
    const pending: LiveFrame[] = []
    let deliver: (frame: LiveFrame) => void = frame => {
      pending.push(frame)
      if (pending.length > 512) pending.shift()
    }

    const teardown = (): void => {
      if (closed) return
      closed = true
      open--
      if (heartbeat !== null) clearInterval(heartbeat)
      detach?.()
      try { res.end() } catch { /* already gone */ }
    }
    const write = (frame: LiveFrame): void => {
      if (closed) return
      try {
        res.write(frameText(frame))
        // BACKPRESSURE: a client that is not reading is dropped. It reconnects with its last id and resumes or
        // snapshots; holding its frames in memory without limit is how one stuck phone grows the server.
        if (res.writableLength > maxBuffer) teardown()
      } catch {
        teardown()
      }
    }

    req.on('close', teardown)
    res.on('error', teardown)

    try {
      detach = await deps.hub.attach(frame => deliver(frame))
    } catch {
      if (!closed) { closed = true; open--; res.status(503).json({ error: 'live events unavailable', reason: 'live_events_unavailable' }) }
      return
    }
    if (closed) { detach(); return }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    res.write('retry: 3000\n\n')

    // The query wins over the header: a manual reconnect sets `?after=`, the browser's own reconnect sends the header.
    const cursor = parseLiveCursor(typeof req.query.after === 'string' ? req.query.after : undefined) ?? parseLiveCursor(req.get('last-event-id'))
    const replay = deps.hub.replayAfter(cursor)
    if (replay === null) {
      write(deps.hub.snapshotFrame())
      // Anything queued while attaching is already in the snapshot when its seq is not newer.
      const snapSeq = deps.hub.newestSeq
      for (const frame of pending.splice(0)) if (frame.seq > snapSeq) write(frame)
    } else {
      for (const frame of replay) write(frame)
      const last = replay.length ? replay[replay.length - 1]!.seq : cursor!.seq
      for (const frame of pending.splice(0)) if (frame.seq > last) write(frame)
      write(deps.hub.resumeFrame(replay.length))
    }
    deliver = write

    heartbeat = setInterval(() => write(deps.hub.heartbeatFrame()), heartbeatMs)
    ;(heartbeat as { unref?: () => void }).unref?.()
  }
}
