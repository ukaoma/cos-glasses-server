// POST /api/client-instance/claim — the referee between copies of the COS Glasses app (6.50.3).
// See lib/client-instance-claim.ts for the why. Behind the global API token like every /api
// route except health and diag. Body: { id, bootAt, version, check? }. Answer: { verdict, owner }.
//
// `check: true` answers without taking: a copy that already yielded asks whether the owner
// is still there, and must not steal the ring by asking (after a phone lock both copies'
// timers were frozen, so the owner only LOOKS quiet; the older copy's first tick would
// otherwise take it).
//
// 6.50.4: one owner PER DEVICE (the request's address), so an Even simulator on this Mac or
// a second phone on the same token cannot take the ring from the glasses (QA, 6.50.3); and
// no handover while a meeting chunk arrived in the last 30 s (`captureLive`).

import { Router } from 'express'
import {
  arbitrateClientInstance,
  parseClientInstanceClaim,
  CLIENT_INSTANCE_CAPTURE_LIVE_MS,
  type ClientInstanceOwner,
} from '../lib/client-instance-claim.js'

/** Owners kept at once; the least recently seen device is dropped past this. */
export const CLIENT_INSTANCE_MAX_DEVICES = 16

export interface ClientInstanceRouterDeps {
  now?: () => number
  /** Newest meeting-chunk arrival (ms since epoch), or 0 when none. */
  lastRecordingChunkAt?: () => number
}

/** `::ffff:100.64.1.2` and `100.64.1.2` are one device. */
export function deviceKey(address: string | undefined): string {
  const a = (address ?? '').trim()
  return a.startsWith('::ffff:') ? a.slice(7) : (a || 'unknown')
}

export function createClientInstanceRouter(deps: ClientInstanceRouterDeps | (() => number) = {}): Router {
  const opts: ClientInstanceRouterDeps = typeof deps === 'function' ? { now: deps } : deps
  const now = opts.now ?? Date.now
  const lastChunkAt = opts.lastRecordingChunkAt ?? (() => 0)
  const router = Router()
  const owners = new Map<string, ClientInstanceOwner>()
  router.post('/client-instance/claim', (req, res) => {
    const at = now()
    const claim = parseClientInstanceClaim(req.body, at)
    if (!claim) return void res.status(400).json({ error: 'invalid_claim' })
    const device = deviceKey(req.socket?.remoteAddress ?? req.ip)
    const previous = owners.get(device) ?? null
    const captureLive = at - lastChunkAt() < CLIENT_INSTANCE_CAPTURE_LIVE_MS
    const result = arbitrateClientInstance(previous, claim, at, captureLive)
    if (req.body?.check === true) {
      const shown = previous ?? result.owner
      return void res.json({ verdict: result.verdict, owner: { id: shown.id, bootAt: shown.bootAt, version: shown.version, seenAt: shown.seenAt }, check: true, captureLive })
    }
    owners.delete(device)
    owners.set(device, result.owner)
    while (owners.size > CLIENT_INSTANCE_MAX_DEVICES) owners.delete(owners.keys().next().value as string)
    const owner = result.owner
    if (result.took && previous && previous.id !== claim.id) {
      console.log(`[client-instance] ${new Date(at).toISOString()} ${claim.id} (${claim.version}) took the ring from ${previous.id} on ${device}`)
    }
    res.json({
      verdict: result.verdict,
      owner: { id: owner.id, bootAt: owner.bootAt, version: owner.version, seenAt: owner.seenAt },
      captureLive,
    })
  })
  return router
}
