// GET /api/display-stream — SSE endpoint for glasses display sync
// Any connected glasses client receives real-time query responses
// regardless of which interface submitted the query

import { Router, type Response } from 'express'
import {
  emitDisplay,
  getDisplayWatermark,
  onDisplay,
  replayDisplayEvents,
  type PublishedDisplayEvent,
} from '../lib/display-bus.js'

export const displayRouter = Router()

function writeEvent(res: Response, event: PublishedDisplayEvent): void {
  const data = JSON.stringify({
    ...event.data,
    _cosDisplayCursor: {
      bootId: event.bootId,
      eventId: event.eventId,
      publishedAt: event.publishedAt,
    },
  })
  res.write(`id: ${event.bootId}:${event.eventId}\nevent: ${event.type}\ndata: ${data}\n\n`)
}

displayRouter.get('/display-stream', (req, res) => {
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

  const headerCursor = String(req.headers['last-event-id'] ?? '')
  const [headerBootId, headerEventId] = headerCursor.includes(':')
    ? headerCursor.split(':', 2)
    : ['', headerCursor]
  const cursorBootId = String(req.query.bootId ?? headerBootId ?? '') || null
  const cursorEventId = Number(req.query.eventId ?? headerEventId ?? 0)
  const replay = replayDisplayEvents(cursorBootId, Number.isFinite(cursorEventId) ? cursorEventId : 0)

  // Ready is a transport handshake, not proof that replay was consumed. It
  // must precede application events so build 188 can finish admission first.
  const watermark = getDisplayWatermark()
  res.write(`event: ready\ndata: ${JSON.stringify(watermark)}\n\n`)
  if (replay.gap) {
    res.write(`event: replay_gap\ndata: ${JSON.stringify({
      reason: replay.reason,
      requested: { bootId: cursorBootId, eventId: cursorEventId },
      watermark,
      oldestEventId: replay.oldestEventId,
    })}\n\n`)
  } else {
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
    try { writeEvent(res, event) } catch { /* client gone */ }
  })

  req.on('close', () => {
    clearInterval(ping)
    unsub()
  })
})

// POST /api/display-session — broadcast session restore to glasses (cross-surface sync)
displayRouter.post('/display-session', (req, res) => {
  emitDisplay({ type: 'session_restore', data: req.body })
  res.json({ ok: true })
})
