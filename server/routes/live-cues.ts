// Live Cues routes. Authenticated by the global /api X-Cos-Token middleware
// (index.ts:148) like every other /api route — no route-local auth needed.
//
// POST /live-cues/start { sessionId }  -> { armed, sessionId, pipelinesUsed }
// POST /live-cues/stop  { sessionId }  -> { nudgesGenerated, nudges }
// GET  /live-cues/status               -> engine snapshot + capability

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import {
  armLiveCues,
  disarmLiveCues,
  getLiveCuesStatus,
  LiveCuesArmError,
} from '../lib/live-cues-engine.js'
import { liveCuesCapability } from '../lib/live-cues-capability.js'
import { LiveCuesV2ArmError, liveCuesV2, liveCuesV2Enabled } from '../lib/live-cues-v2.js'

const SESSION_ID = /^[A-Za-z0-9:_-]{3,96}$/
const CUE_ID = /^[A-Za-z0-9-]{8,64}$/
function bodySessionId(body: unknown): string {
  const raw = (body as { sessionId?: unknown })?.sessionId
  return typeof raw === 'string' ? raw.trim() : ''
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
  if (liveCuesV2Enabled()) return res.json(liveCuesV2().end(sessionId))
  return res.json(disarmLiveCues(sessionId))
})

liveCuesRouter.get('/live-cues/status', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : ''
  // v2 with a sessionId answers the per-meeting shape; without one the v1 shape is unchanged (plus v2 capability).
  if (sessionId && liveCuesV2Enabled()) {
    if (!SESSION_ID.test(sessionId)) return res.status(400).json({ error: 'invalid sessionId', reason: 'invalid_session_id' })
    return res.json(liveCuesV2().status(sessionId))
  }
  res.json({
    capability: liveCuesCapability(),
    sessions: getLiveCuesStatus(),
    v2: liveCuesV2().capability(),
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

// POST /live-cues/feedback { sessionId, cueId, vote: 'up'|'down', reason? } -> { ok, knownCue }
liveCuesRouter.post('/live-cues/feedback', (req, res) => {
  const body = (req.body ?? {}) as { cueId?: unknown; vote?: unknown; reason?: unknown }
  const sessionId = bodySessionId(req.body)
  const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : ''
  if (!SESSION_ID.test(sessionId) || !CUE_ID.test(cueId) || (body.vote !== 'up' && body.vote !== 'down')
      || (body.reason !== undefined && typeof body.reason !== 'string')) {
    return res.status(400).json({ error: 'sessionId, cueId and vote (up|down) required', reason: 'invalid_request' })
  }
  if (!liveCuesV2Enabled()) return res.status(404).json({ error: 'live cues v2 is off', reason: 'v2_disabled' })
  return res.json(liveCuesV2().recordFeedback({ sessionId, cueId, vote: body.vote, reason: body.reason as string | undefined }))
})
