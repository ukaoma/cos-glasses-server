// GET /api/display-stream — SSE endpoint for glasses display sync
// Any connected glasses client receives real-time query responses
// regardless of which interface submitted the query

import { Router, type Request, type Response } from 'express'
import {
  emitDisplay,
  getDisplayWatermark,
  onDisplay,
  replayDisplayEvents,
  type DisplayEvent,
  type PublishedDisplayEvent,
} from '../lib/display-bus.js'
import { type DisplayTicketVerdict, explainDisplayTicket } from '../lib/display-ticket.js'
import { timingSafeTokenEqual } from '../lib/token-auth.js'

export const displayRouter = Router()

/**
 * What a TICKETLESS subscriber may receive, as a per-type PROJECTION.
 *
 * ALLOWLIST, NEVER A DENYLIST. A new member of the DisplayEvent union is withheld
 * by default, so adding an event type can never silently widen the unauthenticated
 * surface.
 *
 * A projection, not a pass-through, because an allowlisted TYPE can still carry
 * content in its payload — which is exactly the bug the first cut of this shipped.
 * The projection is the contract: whatever the emitter grows later, only the fields
 * named here can ever leave.
 *
 * The other ten members of the union all carry user content: `transcript_chunk` and
 * `prompt_transcript` carry meeting speech with speaker labels, `chunk`/`done` carry
 * answer text, `session_restore` carries conversation state, `coaching_nudge` carries
 * derived guidance, `start` carries session metadata, `tool_status` carries a message,
 * `error` carries error text, and `recording_start` is covered by its own note below.
 *
 * NOT ROUTED THROUGH HERE: `keepalive` is an SSE comment (`: keepalive`), not an
 * event. `ready` and `replay_gap` are written directly by the handler below — both
 * are transport metadata with no user content, and `replay_gap` is deliberately
 * ticketless-visible (see the handler).
 */
const TICKETLESS_PROJECTIONS: {
  readonly [K in DisplayEvent['type']]?: (data: Record<string, unknown>) => Record<string, unknown>
} = {
  /**
   * `recording_stop` is a lifecycle marker: the lens uses it to clear a stale
   * "recording" indicator that would otherwise persist forever.
   *
   * BUT THE PRODUCTION PAYLOAD IS NOT BARE. Both emitters (routes/meeting.ts, the
   * durable save path and the orphan-recovery path) send
   * `{ sessionId, filename, durationMin, domain }`, and `filename` is built by
   * meeting-store.ts `filenameStem()` from the transcript-derived meeting TITLE —
   * `2026-08-31_Q3_Budget_Cuts_Layoffs_1a2b3c4d.md`. Passing the event through whole
   * broadcast the meeting title, its duration and its business domain to every
   * unauthenticated listener on the LAN, which is precisely what a ticket exists to
   * withhold.
   *
   * Only `sessionId` survives. It is the id the CLIENT supplied when it started the
   * capture (meeting-store `normalizeSessionId` constrains it to
   * `[A-Za-z0-9:_-]{3,96}` and the server never derives it from the transcript), so
   * it is the one field the subscriber already holds and the one the lens needs to
   * match the marker to its own indicator.
   */
  // `durationMin` rides along because the lens renders `Meeting saved — ${n}m`
  // straight from this frame (glasses-entry.ts). Projecting it away left a valid
  // JSON payload — so the client's catch never fired — and painted
  // "Meeting saved — undefinedm". A duration is a scalar with no transcript in it;
  // `filename` stays stripped precisely because it embeds the meeting TITLE.
  recording_stop: data => ({ sessionId: data.sessionId, durationMin: data.durationMin }),

  /**
   * `recording_start` is NOT here, as a DECISION rather than an omission.
   *
   * Three reasons, in order of weight:
   *  1. The failure modes are asymmetric. A missing `stop` leaves the lens asserting
   *     something FALSE — a recording indicator burning with no recording behind it.
   *     A missing `start` leaves it showing nothing, which is exactly what the
   *     ticketless contract promises anyway. Only the wrong state needs repairing.
   *  2. `start` is a live presence signal. "A meeting is beginning on this machine,
   *     right now" is occupancy intelligence for any listener on the network; `stop`
   *     is the erasure of a signal already shown.
   *  3. Nothing in this server emits it. `grep -rn "type: 'recording_start'" server`
   *     returns no emitter as of 6.42.0 — it exists in the union for client-side
   *     use — so allowlisting it would advertise a path that never runs.
   *
   * If a server-side emitter is ever added, revisit this WITH a projection; do not
   * simply add the key.
   */
}

/**
 * The event a ticketless subscriber may receive, or null when it may receive none.
 * Never returns the input event unchanged — the projection is always applied.
 */
function projectForTicketless(event: PublishedDisplayEvent): PublishedDisplayEvent | null {
  // hasOwn, not a bare index: the map is an object literal and inherits
  // Object.prototype, so a type of "constructor" would resolve to `Object` — a
  // truthy identity function — and pass the event through whole. Unreachable via
  // the typed union today; the allowlist must not depend on that staying true.
  const project = Object.hasOwn(TICKETLESS_PROJECTIONS, event.type)
    ? TICKETLESS_PROJECTIONS[event.type]
    : undefined
  if (!project) return null
  return { ...event, data: project(event.data) }
}

function writeEvent(res: Response, event: PublishedDisplayEvent): void {
  const data = JSON.stringify({
    ...event.data,
    // NESTED, and it must stay nested. Every shipped client reads
    // `parsed._cosDisplayCursor` and RETURNS EARLY when it is absent
    // (Main.ts, identically in 6.8.353 and 6.8.441), so flattening these three
    // fields to the top level silently freezes the client cursor at its
    // connect-time watermark: `rememberCursor` never fires, and every reconnect
    // then re-replays and re-processes everything since the connect (duplicate
    // `done` renders), or trips a spurious buffer_overflow replay_gap past 200
    // events. 6.42.0 briefly shipped the flattened shape in development; it was
    // caught pre-release. A test that only asserts `"eventId":1` cannot see the
    // difference, because that substring is present in BOTH shapes.
    _cosDisplayCursor: {
      bootId: event.bootId,
      eventId: event.eventId,
      publishedAt: event.publishedAt,
    },
  })
  // SSE `id:` is the reconnect cursor EventSource echoes back as Last-Event-ID.
  // Namespaced by bootId so a restarted server cannot look like a resumable gap.
  res.write(`id: ${event.bootId}:${event.eventId}\nevent: ${event.type}\ndata: ${data}\n\n`)
}

/**
 * Ticketless-connect accounting, summarized rather than logged per connect.
 *
 * The server sends `retry: 3000`, so ONE client that cannot mint reconnects every
 * three seconds — 1,200 lines an hour into the launchd log, forever, from a single
 * stale install. The counter is the point (adoption is measured, not guessed); the
 * per-line volume is not.
 */
const TICKETLESS_LOG_INTERVAL_MS = 60_000
let ticketlessConnects = 0
let ticketlessRejectedTickets = 0
let ticketlessLoggedAt = 0
// Per-reason so the log can tell "a client needs to re-mint" (expired — expected
// after every native EventSource retry on a stale URL) from "someone is holding
// a ticket this token never signed" (bad-signature — a rotation, or a probe).
const ticketlessByReason: Record<Exclude<DisplayTicketVerdict, 'ok'> | 'none', number> = {
  none: 0, malformed: 0, expired: 0, 'bad-signature': 0,
}

function noteTicketlessConnect(reason: Exclude<DisplayTicketVerdict, 'ok'> | 'none'): void {
  ticketlessConnects++
  if (reason !== 'none') ticketlessRejectedTickets++
  ticketlessByReason[reason]++
  const now = Date.now()
  if (ticketlessLoggedAt !== 0 && now - ticketlessLoggedAt < TICKETLESS_LOG_INTERVAL_MS) return
  ticketlessLoggedAt = now
  const { expired, 'bad-signature': bad, malformed, none } = ticketlessByReason
  console.warn(
    `[display-bus] ${ticketlessConnects} ticketless subscriber(s)`
    + ` (${ticketlessRejectedTickets} with a rejected ticket:`
    + ` ${expired} expired, ${bad} bad-signature, ${malformed} malformed; ${none} bare)`
    + ` — content withheld, lifecycle only`,
  )
  ticketlessConnects = 0
  ticketlessRejectedTickets = 0
  for (const k of Object.keys(ticketlessByReason) as Array<keyof typeof ticketlessByReason>) ticketlessByReason[k] = 0
}

export function __resetDisplayStreamLogForTests(): void {
  ticketlessConnects = 0
  ticketlessRejectedTickets = 0
  ticketlessLoggedAt = 0
  for (const k of Object.keys(ticketlessByReason) as Array<keyof typeof ticketlessByReason>) ticketlessByReason[k] = 0
}

/**
 * A valid `X-Cos-Token` header is equivalent authorization to a ticket.
 *
 * The ticket exists only because EventSource cannot set headers. Every fetch-based
 * consumer can — including the client's own `probeConnectionTarget`, COS Control, and
 * curl — so requiring those to mint first would suppress content for callers that are
 * already fully authenticated, and would permanently pollute the ticketless adoption
 * counter with connections that were never the problem.
 */
function headerAuthorized(req: Request): boolean {
  return timingSafeTokenEqual(req.headers['x-cos-token'], process.env.COS_API_TOKEN ?? '')
}

/**
 * Shared handler for both registrations.
 *
 * `authorized` decides CONTENT, never admission. A ticketless subscriber still gets
 * 200, `ready`, the keepalive, lifecycle markers, and replay-gap notices, so every
 * already-installed client keeps a live transport, keeps `displayBusConnected` true,
 * and keeps syncing offline meetings. It simply never receives transcripts or answers.
 */
function serveDisplayStream(req: Request, res: Response, authorized: boolean): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',  // Even Hub WebView loads from file:// — needs explicit CORS
  })
  res.flushHeaders()

  // Tell EventSource to retry quickly on disconnect (3s instead of browser default ~5-10s)
  res.write('retry: 3000\n\n')

  // DO NOT move this inside an `if (authorized)`. It looks unused on the ticketless
  // path and is not: a ticketless subscriber never receives buffered events, but it
  // MUST still be told when its cursor is unresumable (see replay_gap below), and
  // that verdict is a function of the cursor. Hiding the cursor behind the
  // authorization check would silently delete ticketless gap reporting.
  const headerCursor = String(req.headers['last-event-id'] ?? '')
  const [headerBootId, headerEventId] = headerCursor.includes(':')
    ? headerCursor.split(':', 2)
    : ['', headerCursor]
  const cursorBootId = String(req.query.bootId ?? headerBootId ?? '') || null
  const cursorEventId = Number(req.query.eventId ?? headerEventId ?? 0)

  // Ready is a transport handshake, not proof that replay was consumed. It
  // must precede application events so build 188 can finish admission first.
  //
  // `contentAuthorized` is what makes a degraded stream DETECTABLE. Without it the
  // two handshakes are byte-identical, so a client whose ticket expired sets
  // `displayBusConnected = true`, sees a healthy socket, and never re-mints — the
  // stream stays silent forever with nothing anywhere reporting a fault. Old clients
  // JSON.parse this frame and read only bootId/eventId, so the extra key is inert
  // for them.
  const watermark = getDisplayWatermark()
  res.write(`event: ready\ndata: ${JSON.stringify({ ...watermark, contentAuthorized: authorized })}\n\n`)

  // Gap detection is needed for every subscriber; MATERIALISING the up-to-200
  // event buffer is only needed for one we will actually write it to. A stale
  // ticketless install retrying every 3s was filtering the whole buffer each
  // time and discarding it — and so was every authorized `probe=1` connect,
  // whose write is skipped below. The term here must match that `else if`.
  const materialize = authorized && req.query.probe !== '1'
  const replay = replayDisplayEvents(
    cursorBootId, Number.isFinite(cursorEventId) ? cursorEventId : 0, { materialize },
  )
  if (replay.gap) {
    // Ticketless-VISIBLE on purpose. The payload is transport metadata only —
    // reason, the cursor the client itself sent, the watermark already in `ready`,
    // and a buffer boundary — so it discloses nothing. Withholding it silently
    // breaks the client's replay-reconciliation branch after a server restart: the
    // client would sit on a dead cursor waiting for a resume that cannot come.
    res.write(`event: replay_gap\ndata: ${JSON.stringify({
      reason: replay.reason,
      requested: { bootId: cursorBootId, eventId: cursorEventId },
      watermark,
      oldestEventId: replay.oldestEventId,
    })}\n\n`)
  } else if (authorized && req.query.probe !== '1') {
    // The replay buffer holds up to REPLAY_BUFFER_SIZE past events, so serving it
    // to a ticketless subscriber would be a retroactive transcript dump — a larger
    // disclosure than the live subscription. Skipped entirely rather than filtered,
    // so no future event type can leak through a per-item test here.
    //
    // `probe=1` is the client's connection probe: it opens this stream ONLY to read
    // the `ready` watermark and then aborts. It sends the token, so it is
    // authorized — and was being handed the full buffer on every reconnect and
    // throwing it away (1,164 "Replayed 200" lines in one day's log). A probe is
    // never a consumer; it gets the handshake and nothing else.
    for (const event of replay.events) writeEvent(res, event)
    if (replay.events.length > 0) {
      console.log(`[display-bus] Replayed ${replay.events.length} publish-owned events after ${cursorEventId}`)
    }
  }

  // Keepalive ping every 15s — more aggressive to survive meshnet/proxy timeouts
  const ping = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { /* client gone */ }
  }, 15_000)

  const unsub = onDisplay((event) => {
    // The projection runs INSIDE the try, not above it. This is a synchronous
    // EventEmitter listener, so anything that throws here propagates back out
    // through `bus.emit()` into whoever called `emitDisplay` — and one of those
    // callers is the meeting-save path. A malformed event must never be able to
    // reach a recording. 6.41.0 guarded the whole listener body; keep that.
    try {
      const outgoing = authorized ? event : projectForTicketless(event)
      if (!outgoing) return
      writeEvent(res, outgoing)
    } catch { /* client gone, or an event this subscriber simply cannot render */ }
  })

  req.on('close', () => {
    clearInterval(ping)
    unsub()
  })
}

// Ticketless path. Stays public so installed clients keep a live transport; content
// is withheld above unless the caller sent a valid token header.
displayRouter.get('/display-stream', (req, res) => {
  const authorized = headerAuthorized(req)
  if (!authorized) noteTicketlessConnect('none')
  serveDisplayStream(req, res, authorized)
})

// Ticketed path. `api-auth` admits it on SHAPE alone; the signature is verified
// here, where the API token lives. A bad or expired ticket is not rejected — it
// degrades to exactly the ticketless stream, so a client whose ticket expired
// mid-reconnect keeps its transport instead of entering a retry loop. It learns it
// is degraded from `contentAuthorized:false` in the `ready` frame, and re-mints.
displayRouter.get('/display-stream/:ticket', (req, res) => {
  const apiToken = process.env.COS_API_TOKEN ?? ''
  const verdict = explainDisplayTicket(apiToken, req.params.ticket)
  const authorized = verdict === 'ok' || headerAuthorized(req)
  if (!authorized) noteTicketlessConnect(verdict)
  serveDisplayStream(req, res, authorized)
})

// POST /api/display-session — broadcast session restore to glasses (cross-surface sync)
displayRouter.post('/display-session', (req, res) => {
  emitDisplay({ type: 'session_restore', data: req.body })
  res.json({ ok: true })
})
