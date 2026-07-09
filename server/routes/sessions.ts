// Session endpoints — recent list, full history, existence check, client-format messages, context breaks, end
import { Router } from 'express'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getRecentSessions, getHistory, sessionExists, addContextBreak, endSession, getSessionRaw, getActiveSessions } from '../lib/conversation.js'
import { buildSessionLogEntry, writeSessionLog } from '../lib/session-log.js'
import { getArchiveDayMessages } from '../lib/archive.js'
import { localDay } from '../lib/local-day.js'
import { clearCodexEngineSession } from '../lib/codex-engine-sessions.js'

export const sessionsRouter = Router()

sessionsRouter.get('/sessions/recent', (_req, res) => {
  const sessions = getRecentSessions(24 * 60 * 60_000)
  res.json({ sessions })
})

// HEAD /api/sessions/:id — lightweight existence check for restore validation
sessionsRouter.head('/sessions/:id', (req, res) => {
  res.status(sessionExists(req.params.id) ? 200 : 404).end()
})

// GET /api/sessions/:id/history — full exchange list for session resume
sessionsRouter.get('/sessions/:id/history', (req, res) => {
  const exchanges = getHistory(req.params.id)
  if (exchanges.length === 0) {
    res.status(404).json({ error: 'Session not found or empty' })
    return
  }
  res.json({ exchanges })
})

// POST /api/sessions/:id/context-break — insert a context break (prompt history gate)
sessionsRouter.post('/sessions/:id/context-break', (req, res) => {
  const ok = addContextBreak(req.params.id)
  if (!ok) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  res.json({ ok: true })
})

// GET /api/sessions/:id/messages — client-compatible format (paired Q&A)
sessionsRouter.get('/sessions/:id/messages', (req, res) => {
  const exchanges = getHistory(req.params.id)
  if (exchanges.length === 0) {
    res.status(404).json({ error: 'Session not found or empty' })
    return
  }

  // Pair user+assistant exchanges into client message format
  const messages: Array<{ query: string; text: string; timestamp: number }> = []
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i]
    if (ex.role === 'user') {
      const next = exchanges[i + 1]
      if (next && next.role === 'assistant') {
        messages.push({ query: ex.content, text: next.content, timestamp: next.timestamp })
        i++ // skip the assistant exchange
      }
    }
  }

  res.json({ messages })
})

// POST /api/sessions/:id/end — Explicitly end a session (archive + log + notify)
// Called by client on "new session", "clear session", or app backgrounding.
// Prevents data loss — session gets logged to .glasses_sessions.jsonl immediately
// instead of waiting for the 2hr TTL expiry.
// POST /api/sessions/lookup — batch resolve timestamps to session IDs
// Used to retroactively stamp messages that predate the sessionId feature
sessionsRouter.post('/sessions/lookup', (req, res) => {
  const { timestamps } = req.body as { timestamps: number[] }
  if (!timestamps || !Array.isArray(timestamps)) {
    res.status(400).json({ error: 'timestamps[] required' })
    return
  }

  // Build time ranges from BOTH JSONL history AND live server sessions
  const logPath = join(process.env.COS_SCRIPTS_DIR || '', '.glasses_sessions.jsonl')
  const sessionRanges: Array<{ sid: string; start: number; end: number }> = []

  // 1. Live server sessions (always current — no snapshot lag)
  const recentSessions = getRecentSessions(24 * 60 * 60_000)
  for (const rs of recentSessions) {
    const raw = getSessionRaw(rs.id)
    if (raw) {
      sessionRanges.push({ sid: raw.id, start: raw.createdAt, end: Date.now() }) // extends to NOW
    }
  }

  // 2. JSONL history (ended sessions + snapshots)
  try {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    for (const line of lines) {
      const d = JSON.parse(line)
      if (d.session_id && d.created_at) {
        const start = new Date(d.created_at).getTime()
        const end = d.ended_at ? new Date(d.ended_at).getTime() : start + 7200_000
        // Live sessions take priority. For JSONL, keep the widest (latest) time range per session.
        const existing = sessionRanges.find(s => s.sid === d.session_id)
        if (!existing) {
          sessionRanges.push({ sid: d.session_id, start, end })
        } else if (end > existing.end && !getSessionRaw(d.session_id)) {
          // Widen the JSONL range (but don't overwrite live sessions which extend to NOW)
          existing.end = end
        }
      }
    }
  } catch { /* no log file */ }

  // Match each timestamp to a session (live sessions checked first, then JSONL)
  const results: Record<number, string | null> = {}
  for (const ts of timestamps) {
    let match: string | null = null
    for (const s of sessionRanges) {
      if (ts >= s.start && ts <= s.end) {
        match = s.sid
        break
      }
    }
    results[ts] = match
  }

  res.json({ results, sessionsScanned: sessionRanges.length })
})

sessionsRouter.post('/sessions/:id/end', async (req, res) => {
  try {
    const result = await endSession(req.params.id)
    if (!result) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    // When logged === false the archive write failed — we keep the session
    // in the Map for the next mirror to retry, but signal 503 so the client
    // knows NOT to wipe local messages (they're still the user's only copy).
    if (!result.logged && result.exchangeCount > 0) {
      res.status(503).json({
        ok: false,
        error: 'Archive write failed — session retained for retry',
        exchange_count: result.exchangeCount,
        duration_minutes: result.durationMin,
      })
      return
    }
    clearCodexEngineSession(req.params.id)
    res.json({
      ok: true,
      logged: result.logged,
      exchange_count: result.exchangeCount,
      duration_minutes: result.durationMin,
    })
  } catch (err) {
    console.error('[sessions] /end unexpected error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/sessions/:id/snapshot — write live session to .glasses_sessions.jsonl WITHOUT ending it
// Enables M3 Ultra TUI to read current glasses conversation while session is still active
sessionsRouter.post('/sessions/:id/snapshot', (req, res) => {
  const session = getSessionRaw(req.params.id)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const entry = buildSessionLogEntry({
    id: session.id,
    exchanges: session.exchanges,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    modelPreference: session.modelPreference,
    endReason: 'explicit_end', // marker — will be overwritten when session actually ends
    slug: `[LIVE] ${(session.exchanges.find(e => e.role === 'user')?.content ?? '').slice(0, 50)}`,
  })

  const logged = writeSessionLog(entry)
  res.json({
    ok: true,
    logged,
    session_id: session.id,
    message_count: entry.total_message_count,
    messages_logged: entry.messages.length,
  })
})

// GET /api/sessions/today/live-chats — live session chat summaries for today (not yet archived).
// Date compare is LOCAL time so users chatting in CDT/PST late evening still see their
// session under "today" instead of "tomorrow UTC".
// Each summary includes `sessionId` so the client can drill down via
// `/api/sessions/:id/messages` — index=-1 is a sentinel and is NOT a valid archive chat index.
sessionsRouter.get('/sessions/today/live-chats', (_req, res) => {
  const todayDate = localDay()
  const liveSessions = getActiveSessions()
  const chats: Array<{ index: number; summary: string; exchangeCount: number; startedAt: number; isLive: boolean; sessionId: string }> = []

  for (const session of liveSessions) {
    const sessionDay = localDay(session.lastActivity)
    if (sessionDay !== todayDate) continue
    if (session.exchanges.length === 0) continue

    const firstQuery = session.exchanges.find(e => e.role === 'user')?.content ?? ''
    const summary = firstQuery.length > 57 ? firstQuery.slice(0, 54) + '...' : firstQuery || 'Live session'

    chats.push({
      index: -1,
      summary: `[LIVE] ${summary}`,
      exchangeCount: session.exchanges.length,
      startedAt: session.createdAt,
      isLive: true,
      sessionId: session.id,
    })
  }

  res.json({ chats })
})

// GET /api/sessions/today/all-messages — merged view of today's archived + live session messages.
// Dedup key is `sessionId|timestamp` (was bare timestamp, which collided on NTP skew or
// same-ms adds). `sessionId` is always known for live exchanges; archive messages fall
// back to the archived chat's sessionId via getArchiveDayMessages.
sessionsRouter.get('/sessions/today/all-messages', (_req, res) => {
  const todayDate = localDay()

  const archivedMessages = getArchiveDayMessages(todayDate).map(m => ({
    ...m,
    source: 'archive' as const,
  }))

  const liveMessages: Array<{ query: string; text: string; timestamp: number; chatIndex: number; sessionId: string; source: 'live' }> = []
  const liveSessions = getActiveSessions()
  for (const session of liveSessions) {
    const sessionDay = localDay(session.lastActivity)
    if (sessionDay !== todayDate) continue
    for (let i = 0; i < session.exchanges.length; i++) {
      const ex = session.exchanges[i]
      if (ex.role === 'user') {
        const next = session.exchanges[i + 1]
        if (next && next.role === 'assistant') {
          liveMessages.push({
            query: ex.content,
            text: next.content,
            timestamp: next.timestamp,
            chatIndex: -1,
            sessionId: session.id,
            source: 'live',
          })
          i++
        }
      }
    }
  }

  // Merge, dedup by (sessionId, timestamp), sort chronologically.
  const seen = new Set<string>()
  const keyOf = (m: { sessionId?: string; timestamp: number }) => `${m.sessionId ?? ''}|${m.timestamp}`
  const merged = [...archivedMessages, ...liveMessages]
    .filter(m => {
      const k = keyOf(m as any)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.timestamp - b.timestamp)

  res.json({ messages: merged, date: todayDate })
})
