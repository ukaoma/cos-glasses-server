// Speaker merge shadow mode (6.95.0). Token-protected by the /api middleware. READ ONLY.
//
//   GET /api/speaker-shadow/proposals   the logged proposal records, newest first
//        ?limit=1..100 (default 10)  ?sessionId=mac_<uuid>
//   GET /api/speaker-shadow/status      the switch, queue, daily cap, breaker and last error
//
// There is no POST: shadow mode only logs. Nothing on these routes changes a meeting,
// a label, a name or a profile. A 404 means a server older than 6.95.0.

import { Router } from 'express'
import { getSpeakerShadowRunner, readSpeakerShadowRecords } from '../lib/speaker-shadow.js'
import { speakerShadowRoot } from '../lib/speaker-shadow-models.js'

export interface SpeakerShadowRouterDeps {
  root?: () => string
  snapshot?: () => ReturnType<ReturnType<typeof getSpeakerShadowRunner>['snapshot']>
}

const SESSION_ID = /^mac_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createSpeakerShadowRouter(deps: SpeakerShadowRouterDeps = {}): Router {
  const router = Router()
  const root = deps.root ?? speakerShadowRoot
  const snapshot = deps.snapshot ?? (() => getSpeakerShadowRunner().snapshot({ detail: true }))

  router.get('/speaker-shadow/proposals', async (req, res) => {
    const rawLimit = Number(req.query.limit ?? 10)
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) { res.status(400).json({ error: 'limit must be an integer from 1 to 100' }); return }
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    if (sessionId !== undefined && !SESSION_ID.test(sessionId)) { res.status(400).json({ error: 'sessionId must be a mac_<uuid> session id' }); return }
    try {
      const records = await readSpeakerShadowRecords(root(), { limit: rawLimit, sessionId })
      res.json({ logOnly: true, shadow: snapshot(), count: records.length, records })
    } catch (error) {
      res.status(500).json({ error: `could not read the shadow log: ${error instanceof Error ? error.message : String(error)}` })
    }
  })

  router.get('/speaker-shadow/status', (_req, res) => {
    res.json({ logOnly: true, ...snapshot() })
  })

  return router
}
