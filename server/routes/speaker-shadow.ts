// Speaker merge shadow mode (6.95.0). Token-protected by the /api middleware. READ ONLY.
//
//   GET /api/speaker-shadow/proposals   the logged proposal records, newest first
//        ?limit=1..100 (default 10)  ?sessionId=mac_<uuid>
//   GET /api/speaker-shadow/status      the switch, queue, daily cap, breaker, last error and
//                                       setup readiness (models, CLI, sandbox)
//   GET  /api/speaker-shadow/settings   { enabled, source }  source: env | setting | default
//   POST /api/speaker-shadow/settings   {"enabled": true|false}: this Mac's saved switch (no
//                                       restart); 409 env_forced when COS_SPEAKER_SHADOW pins it
//
// The settings POST is the only write, and it writes only <data>/speaker-shadow/settings.json.
// Nothing on these routes changes a meeting, a label, a name or a profile. A 404 means a
// server older than 6.95.0.

import { Router } from 'express'
import { getSpeakerShadowRunner, readSpeakerShadowRecords, resolveSpeakerShadowSwitch, speakerShadowEnvSwitch, writeSpeakerShadowSetting } from '../lib/speaker-shadow.js'
import { speakerShadowRoot } from '../lib/speaker-shadow-models.js'

export interface SpeakerShadowRouterDeps {
  root?: () => string
  env?: NodeJS.ProcessEnv
  snapshot?: () => ReturnType<ReturnType<typeof getSpeakerShadowRunner>['snapshot']>
  /** Called after the setting turns shadow mode on (the runner picks up anything still queued). */
  onEnabled?: () => void
}

const SESSION_ID = /^mac_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createSpeakerShadowRouter(deps: SpeakerShadowRouterDeps = {}): Router {
  const router = Router()
  const root = deps.root ?? speakerShadowRoot
  const snapshot = deps.snapshot ?? (() => getSpeakerShadowRunner().snapshot({ detail: true }))
  const env = deps.env ?? process.env
  const onEnabled = deps.onEnabled ?? (() => getSpeakerShadowRunner().resume())

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

  router.get('/speaker-shadow/settings', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json(resolveSpeakerShadowSwitch(env, root()))
  })

  router.post('/speaker-shadow/settings', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const body = req.body as { enabled?: unknown } | undefined
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean' || Object.keys(body).some(k => k !== 'enabled')) {
      res.status(400).json({ error: 'invalid_request', expected: '{"enabled": true|false}' })
      return
    }
    const pinned = speakerShadowEnvSwitch(env)
    if (pinned !== null && pinned !== body.enabled) { res.status(409).json({ error: 'env_forced', ...resolveSpeakerShadowSwitch(env, root()) }); return }
    try {
      writeSpeakerShadowSetting(body.enabled, root())
    } catch {
      res.status(500).json({ error: 'settings_write_failed' })
      return
    }
    const view = resolveSpeakerShadowSwitch(env, root())
    if (view.enabled) { try { onEnabled() } catch { /* the next finished meeting starts it */ } }
    res.json(view)
  })

  return router
}
