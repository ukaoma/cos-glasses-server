// Live Cues routes. Authenticated by the global /api X-Cos-Token middleware
// (index.ts:148) like every other /api route — no route-local auth needed.
//
// POST /live-cues/start { sessionId }  -> { armed, sessionId, pipelinesUsed }
// POST /live-cues/stop  { sessionId }  -> { nudgesGenerated, nudges }
// GET  /live-cues/status               -> engine snapshot + capability
// GET  /live-cues/v2/settings           -> { enabled, source: env|setting|default, capability }       (6.76.2)
// POST /live-cues/v2/settings { enabled } -> same shape; 409 { error: 'env_forced' } when env forces v2 on
// POST /live-cues/feedback { sessionId, cueId, verdict, note? } -> { ok, cueId, verdict, vote }                 (6.79.0)
// GET  /live-cues/history?days=7&sessionId=a,b&unrated=1&limit=200 -> { v: 1, cues, counts, truncated, skipped, maxCuesPerMeeting, meetings? } (6.79.0)

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import {
  armLiveCues,
  disarmLiveCues,
  getLiveCuesStatus,
  LiveCuesArmError,
} from '../lib/live-cues-engine.js'
import { liveCuesCapability } from '../lib/live-cues-capability.js'
import { LIVE_CUES_V2_LIMITS, LiveCuesV2ArmError, liveCuesV2, liveCuesV2Advertised, liveCuesV2Enabled, liveCuesV2MeetingCounters, liveCuesV2SettingsView, peekLiveCuesV2, setLiveCuesV2Enabled } from '../lib/live-cues-v2.js'
import { LIVE_CUE_VERDICTS_PROTOCOL, LIVE_CUE_VERDICT_LIMITS, VerdictsUnreadableError, isCueVerdict, liveCueVerdicts } from '../lib/live-cue-verdicts.js'

const SESSION_ID = /^[A-Za-z0-9:_-]{3,96}$/
const CUE_ID = /^[A-Za-z0-9-]{8,64}$/
function bodySessionId(body: unknown): string {
  const raw = (body as { sessionId?: unknown })?.sessionId
  return typeof raw === 'string' ? raw.trim() : ''
}
/** v2 owns this meeting: v2 is on, or it armed the meeting before v2 was switched off at runtime. */
function v2Owns(sessionId: string): boolean {
  return liveCuesV2Enabled() || (peekLiveCuesV2()?.knows(sessionId) ?? false)
}

export const liveCuesRouter = Router()

liveCuesRouter.post('/live-cues/start', async (req, res) => {
  const sessionId = typeof (req.body as { sessionId?: unknown })?.sessionId === 'string'
    ? String((req.body as { sessionId: string }).sessionId).trim()
    : ''
  // A start with no sessionId is refused, never silently armed on a global
  // counter — the per-meeting cap is only real when it is session-scoped.
  if (!sessionId || !SESSION_ID.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId required', reason: 'missing_session_id' })
  }
  try {
    if (liveCuesV2Enabled()) return res.json(liveCuesV2().arm(sessionId))
    const result = await armLiveCues(sessionId)
    return res.json(result)
  } catch (error) {
    if (error instanceof LiveCuesV2ArmError) {
      return res.status(error.status).json({ error: error.message, reason: error.code, protocol: 2 })
    }
    if (error instanceof LiveCuesArmError) {
      return res.status(error.status).json({ error: error.message, reason: error.code })
    }
    return res.status(500).json({ error: errMsg(error) })
  }
})

liveCuesRouter.post('/live-cues/stop', (req, res) => {
  const sessionId = typeof (req.body as { sessionId?: unknown })?.sessionId === 'string'
    ? String((req.body as { sessionId: string }).sessionId).trim()
    : ''
  if (!sessionId || (liveCuesV2Enabled() && !SESSION_ID.test(sessionId))) {
    return res.status(400).json({ error: 'sessionId required', reason: 'missing_session_id' })
  }
  // Shape matches the existing client stop handler: it reads nudgesGenerated
  // for its log line and hydrates meetingNudgeHistory from nudges when SSE
  // missed events (the 200-event replay buffer is flooded by transcript_chunk).
  if (v2Owns(sessionId)) return res.json(liveCuesV2().end(sessionId))
  return res.json(disarmLiveCues(sessionId))
})

liveCuesRouter.get('/live-cues/status', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : ''
  // v2 with a sessionId answers the per-meeting shape; without one the v1 shape is unchanged (plus v2 capability).
  if (sessionId && v2Owns(sessionId)) {
    if (!SESSION_ID.test(sessionId)) return res.status(400).json({ error: 'invalid sessionId', reason: 'invalid_session_id' })
    return res.json(liveCuesV2().status(sessionId))
  }
  res.json({
    capability: liveCuesCapability(),
    sessions: getLiveCuesStatus(),
    ...(liveCuesV2Advertised() ? { v2: liveCuesV2Advertised() } : {}),
    // 6.79.0: always, so Control can rate past cues with v2 switched off.
    verdicts: { protocol: LIVE_CUE_VERDICTS_PROTOCOL },
  })
})

// POST /live-cues/pause { sessionId, paused, seq? } -> { ok, paused, applied, pauseSeq }  (v2 only; the phone keeps its own local pause)
liveCuesRouter.post('/live-cues/pause', (req, res) => {
  const sessionId = bodySessionId(req.body)
  const paused = (req.body as { paused?: unknown })?.paused
  const seq = (req.body as { seq?: unknown })?.seq
  if (!SESSION_ID.test(sessionId) || typeof paused !== 'boolean' || (seq !== undefined && !(typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0))) {
    return res.status(400).json({ error: 'sessionId and boolean paused required', reason: 'invalid_request' })
  }
  if (!liveCuesV2Enabled()) return res.status(404).json({ error: 'live cues v2 is off', reason: 'v2_disabled' })
  return res.json(liveCuesV2().setPaused(sessionId, paused, seq as number | undefined))
})

// POST /live-cues/feedback { sessionId, cueId, vote: 'up'|'down', reason? } -> { ok, knownCue }   (the lens; unchanged)
// POST /live-cues/feedback { sessionId, cueId, verdict, note? } -> { ok, cueId, verdict, vote }    (COS Control, 6.79.0)
liveCuesRouter.post('/live-cues/feedback', (req, res) => {
  const body = (req.body ?? {}) as { cueId?: unknown; vote?: unknown; reason?: unknown; verdict?: unknown; note?: unknown }
  const sessionId = bodySessionId(req.body)
  const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : ''
  if (body.verdict !== undefined) {
    // Exactly one of vote and verdict: a body carrying both is ambiguous, so neither is applied.
    if (body.vote !== undefined || !SESSION_ID.test(sessionId) || !CUE_ID.test(cueId)
        || !(isCueVerdict(body.verdict) || body.verdict === 'clear') || (body.note !== undefined && typeof body.note !== 'string')) {
      return res.status(400).json({ error: 'sessionId, cueId and verdict (useful|late|repeat|wrong|obvious|clear) required, without vote', reason: 'invalid_request' })
    }
    // Before the v2 gate: last week's cues are rated from the log. peek, never liveCuesV2(): a v2-off server must not build
    // the engine (it constructs the Jev and SubQ clients) just to answer a rating.
    try {
      const result = liveCueVerdicts().rate({ sessionId, cueId, verdict: body.verdict, note: body.note as string | undefined }, liveCueOwner(cueId))
      if (!result.ok && result.error === 'unknown_cue') return res.status(404).json({ error: 'unknown cue', reason: result.error })
      if (!result.ok) return res.status(409).json({ error: 'this cue belongs to another meeting', reason: result.error })
      return res.json(result.response)
    } catch (error) {
      if (error instanceof VerdictsUnreadableError) return res.status(503).json({ error: 'the verdicts file is unreadable', reason: error.code })
      return res.status(500).json({ error: 'verdict_write_failed' })
    }
  }
  if (!SESSION_ID.test(sessionId) || !CUE_ID.test(cueId) || (body.vote !== 'up' && body.vote !== 'down')
      || (body.reason !== undefined && typeof body.reason !== 'string')) {
    return res.status(400).json({ error: 'sessionId, cueId and vote (up|down) required', reason: 'invalid_request' })
  }
  if (!liveCuesV2Enabled()) return res.status(404).json({ error: 'live cues v2 is off', reason: 'v2_disabled' })
  const result = liveCuesV2().recordFeedback({ sessionId, cueId, vote: body.vote, reason: body.reason as string | undefined })
  // Kept beside any verdict, never over it, for a cue known under this meeting. Best effort: the lens answer is the same.
  try { liveCueVerdicts().vote(sessionId, cueId, body.vote, liveCueOwner(cueId)) } catch (error) { console.warn(`[live-cues] lens vote not stored: ${errMsg(error)}`) }
  return res.json(result)
})

/** The meeting the running engine holds this cue for, if an engine exists. Never creates one. */
function liveCueOwner(cueId: string): string | null {
  return peekLiveCuesV2()?.findCue(cueId)?.sessionId ?? null
}

// GET /live-cues/history?days=7&sessionId=a,b&unrated=1&limit=200 (6.79.0). Oldest first, the newest `limit` rows; counts
// cover the window after the sessionId filter. Not gated on the v2 switch, and no maintenance lease (a 15 s poll must
// never hold up an update drain). `meetings` (only with sessionId) are the durable counters, so Control never derives them.
function intParam(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}
/** Absent or empty: no filter ([]). Else up to 5 comma-separated ids (a saved meeting can hold several captures). */
function sessionIdsParam(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (typeof raw !== 'string') return null
  if (!raw.trim()) return []
  const ids = [...new Set(raw.split(',').map(x => x.trim()))]
  return ids.length <= LIVE_CUE_VERDICT_LIMITS.maxSessionIds && ids.every(id => SESSION_ID.test(id)) ? ids : null
}
liveCuesRouter.get('/live-cues/history', (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const L = LIVE_CUE_VERDICT_LIMITS
  const days = intParam(req.query.days, L.defaultDays, 1, L.maxDays)
  const limit = intParam(req.query.limit, L.defaultLimit, 1, L.maxLimit)
  const sessionIds = sessionIdsParam(req.query.sessionId)
  const unrated = req.query.unrated
  if (days === null || limit === null || sessionIds === null || (unrated !== undefined && unrated !== '1' && unrated !== '0')) {
    return res.status(400).json({ error: 'days 1..30, limit 1..1000, unrated 0|1 and up to 5 valid sessionIds', reason: 'invalid_request' })
  }
  try {
    const verdicts = liveCueVerdicts()
    const history = verdicts.history({ days, limit, unrated: unrated === '1', ...(sessionIds.length ? { sessionIds } : {}) })
    const C = LIVE_CUES_V2_LIMITS
    const meetings = sessionIds.length ? Object.fromEntries(sessionIds.map(id => {
      // The engine's counters expire 24 h after a meeting; past that the log's count stands in and writerCalls is unknown.
      const counters = liveCuesV2MeetingCounters(id)
      return [id, { cues: counters?.cues ?? verdicts.loggedCues(id), cap: C.maxCuesPerMeeting, writerCalls: counters?.writerCalls ?? null, writerCap: C.maxWriterCallsPerMeeting }]
    })) : undefined
    return res.json({ ...history, maxCuesPerMeeting: C.maxCuesPerMeeting, ...(meetings ? { meetings } : {}) })
  } catch (error) {
    if (error instanceof VerdictsUnreadableError) return res.status(503).json({ error: 'the verdicts file is unreadable', reason: error.code })
    return res.status(500).json({ error: 'history_unavailable' })
  }
})

// COS Control's live cues v2 toggle (6.76.2). Token-authenticated like every /api route. The setting lives in this server's
// data dir (live-cues-v2-settings.json, atomic write) and applies without a restart: /api/health and /api/models advertise
// liveCuesV2 only while it is on. capability.memory and capability.decisionProvider say where notes and the gate come from.
liveCuesRouter.get('/live-cues/v2/settings', (_req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try { return res.json(liveCuesV2SettingsView()) } catch { return res.status(503).json({ error: 'settings_unavailable' }) }
})

liveCuesRouter.post('/live-cues/v2/settings', (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const body = req.body as { enabled?: unknown } | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'invalid_request' })
  }
  try {
    const result = setLiveCuesV2Enabled(body.enabled)
    if (!result.ok) return res.status(409).json({ error: result.error })
    return res.json(result.view)
  } catch {
    return res.status(500).json({ error: 'settings_write_failed' })
  }
})
