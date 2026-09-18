// POST /api/client-instance/claim — the referee between copies of the COS Glasses app (6.50.3).
// See lib/client-instance-claim.ts for the why. Behind the global API token like every /api
// route except health and diag. Body: { id, bootAt, version, check? }. Answer: { verdict, owner }.
//
// `check: true` answers without taking: a copy that already yielded asks whether the owner
// is still there, and must not steal the ring by asking (after a phone lock both copies'
// timers were frozen, so the owner only LOOKS quiet; the older copy's first tick would
// otherwise take it).

import { Router } from 'express'
import { arbitrateClientInstance, parseClientInstanceClaim, type ClientInstanceOwner } from '../lib/client-instance-claim.js'

export function createClientInstanceRouter(now: () => number = Date.now): Router {
  const router = Router()
  let owner: ClientInstanceOwner | null = null
  router.post('/client-instance/claim', (req, res) => {
    const claim = parseClientInstanceClaim(req.body)
    if (!claim) return void res.status(400).json({ error: 'invalid_claim' })
    const previous = owner
    const result = arbitrateClientInstance(owner, claim, now())
    if (req.body?.check === true) {
      const shown = previous ?? result.owner
      return void res.json({ verdict: result.verdict, owner: { id: shown.id, bootAt: shown.bootAt, version: shown.version, seenAt: shown.seenAt }, check: true })
    }
    owner = result.owner
    if (result.took && previous && previous.id !== claim.id) {
      console.log(`[client-instance] ${new Date(now()).toISOString()} ${claim.id} (${claim.version}) took the ring from ${previous.id}`)
    }
    res.json({
      verdict: result.verdict,
      owner: { id: owner.id, bootAt: owner.bootAt, version: owner.version, seenAt: owner.seenAt },
    })
  })
  return router
}
