// GET /api/g2-turns/:turnId (and its 6.99.29 alias GET /api/turn-provenance/:turnId): read-only provenance for one turn this server delivered or queued
// into an agent session (G2 authority Tier 1, see lib/g2-turn-provenance.ts). Behind the global
// X-Cos-Token gate like every /api route. 400 on a malformed id, 404 `{ found: false }` when no
// record names it. Answers what was recorded, and vouches (`verifiedOrigin: true`) only for a
// glasses or phone record this process wrote and still holds, written within 24 hours. A web record
// is reported with `reason: web_cookie_derivable_from_token` and never vouched (6.99.29).

import { Router } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { describeG2Turn, G2_TURN_ID_RE, type G2TurnProvenance } from '../lib/g2-turn-provenance.js'

export function createG2TurnsRouter(deps: {
  provenance: G2TurnProvenance
  now?: () => number
  /**
   * 6.99.29: the pairing token. With it, only a request that presents X-Cos-Token is answered: the
   * /api gate also admits a COS Control Web browser by its cookie, and the verifier runs on this Mac
   * with the token. Absent: whatever the gate admitted (the 6.66 tests mount the gate alone).
   */
  apiToken?: () => string
}): Router {
  const router = Router()
  const now = deps.now ?? Date.now
  // 6.99.29: one handler, two paths. `/turn-provenance` names what it is now that web turns are
  // recorded too (reported, never vouched: lib/g2-turn-provenance.ts); `/g2-turns` stays for
  // verify_g2_turn.py and every caller of the 6.66 design.
  router.get(['/g2-turns/:turnId', '/turn-provenance/:turnId'], async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    if (deps.apiToken) {
      let expected = ''
      try { expected = deps.apiToken() } catch { expected = '' }
      if (!expected || !timingSafeTokenEqual(req.headers['x-cos-token'], expected)) return void res.status(401).json({ found: false, error: 'token_required' })
    }
    const turnId = String(req.params.turnId ?? '')
    if (!G2_TURN_ID_RE.test(turnId)) return void res.status(400).json({ found: false, error: 'invalid_turn_id' })
    try {
      const answer = await describeG2Turn(deps.provenance, turnId, now())
      if (!answer) return void res.status(404).json({ found: false, turnId })
      res.json(answer)
    } catch (error) {
      console.error(`[g2-turns] lookup failed: ${error instanceof Error ? error.message : error}`)
      res.status(500).json({ found: false, error: 'lookup_failed' })
    }
  })
  // 6.99.31 (plan §4.5): POST /api/g2-turns/:turnId/consume {session, provider}. One server-enforced
  // winner per web-key authorization (keys turn:<turnId> and web:<aud>:<authId>, one write), so two receiving sessions
  // cannot both act on one signed message. X-Cos-Token only. A token holder can pre-spend: that is
  // denial of service, not forgery. Not a route while COS_WEB_KEY_AUTHORITY is off.
  router.post('/g2-turns/:turnId/consume', async (req, res, next) => {
    const authority = deps.provenance.webKey
    if (!authority || !authority.enabled()) return next()
    res.set('Cache-Control', 'private, no-store')
    let expected = ''
    try { expected = deps.apiToken ? deps.apiToken() : '' } catch { expected = '' }
    if (!expected || !timingSafeTokenEqual(req.headers['x-cos-token'], expected)) return void res.status(401).json({ consumed: false, error: 'token_required' })
    const turnId = String(req.params.turnId ?? '')
    if (!G2_TURN_ID_RE.test(turnId)) return void res.status(400).json({ consumed: false, error: 'invalid_turn_id' })
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    try {
      const answer = await describeG2Turn(deps.provenance, turnId, now())
      if (!answer) return void res.status(404).json({ consumed: false, turnId, error: 'not_found' })
      if (answer.authority !== 'web-key' || answer.verifiedOrigin !== true || typeof answer.authId !== 'string') {
        return void res.status(409).json({ consumed: false, turnId, error: 'not_web_key_verified', reason: answer.reason ?? null })
      }
      const target = answer.target as { provider?: string; sessionId?: string } | undefined
      if (typeof b.session !== 'string' || typeof b.provider !== 'string' || target?.sessionId !== b.session || target?.provider !== b.provider) {
        return void res.status(409).json({ consumed: false, turnId, error: 'destination_mismatch' })
      }
      // Review B3: one namespace. The turn id and the web authorization are spent in ONE write.
      const keys = Array.isArray(answer.consumeKeys) ? (answer.consumeKeys as unknown[]).filter((k): k is string => typeof k === 'string') : []
      if (keys.length !== 2) return void res.status(409).json({ consumed: false, turnId, error: 'not_web_key_verified' })
      const spent = authority.nonces.spend(keys, b.session, b.provider)
      if (!spent.ok) return void res.status(spent.reason === 'already_consumed' ? 409 : 503).json({ consumed: false, turnId, error: spent.reason })
      res.json({ consumed: true, turnId, authId: answer.authId, keys })
    } catch (error) {
      console.error(`[g2-turns] consume failed: ${error instanceof Error ? error.message : error}`)
      res.status(500).json({ consumed: false, error: 'consume_failed' })
    }
  })
  return router
}
