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

export const liveCuesRouter = Router()

liveCuesRouter.post('/live-cues/start', async (req, res) => {
  const sessionId = typeof (req.body as { sessionId?: unknown })?.sessionId === 'string'
    ? String((req.body as { sessionId: string }).sessionId).trim()
    : ''
  // A start with no sessionId is refused, never silently armed on a global
  // counter — the per-meeting cap is only real when it is session-scoped.
  if (!sessionId || !/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId required', reason: 'missing_session_id' })
  }
  try {
    const result = await armLiveCues(sessionId)
    return res.json(result)
  } catch (error) {
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
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required', reason: 'missing_session_id' })
  }
  // Shape matches the existing client stop handler: it reads nudgesGenerated
  // for its log line and hydrates meetingNudgeHistory from nudges when SSE
  // missed events (the 200-event replay buffer is flooded by transcript_chunk).
  return res.json(disarmLiveCues(sessionId))
})

liveCuesRouter.get('/live-cues/status', (_req, res) => {
  res.json({
    capability: liveCuesCapability(),
    sessions: getLiveCuesStatus(),
  })
})
