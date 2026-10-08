// GET /api/g2-turns/:turnId — read-only provenance for one turn this server delivered or queued
// into an agent session (G2 authority Tier 1, see lib/g2-turn-provenance.ts). Behind the global
// X-Cos-Token gate like every /api route. 400 on a malformed id, 404 `{ found: false }` when no
// record names it. Answers what was recorded, and vouches (`verifiedOrigin: true`) only for a
// record this process wrote and still holds.

import { Router } from 'express'
import { describeG2Turn, G2_TURN_ID_RE, type G2TurnProvenance } from '../lib/g2-turn-provenance.js'

export function createG2TurnsRouter(deps: { provenance: G2TurnProvenance; now?: () => number }): Router {
  const router = Router()
  const now = deps.now ?? Date.now
  router.get('/g2-turns/:turnId', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
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
  return router
}
