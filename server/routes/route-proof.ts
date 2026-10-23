// 6.88.0 LAN first: the pre-token identity proof (docs/lan-first.md).
//
// GET /api/route-proof?nonce=<22-64 base64url chars> is PUBLIC (an exact GET door in
// api-auth.ts), because it exists to prove which Mac answers at an address BEFORE the phone
// sends its token there. Rules, each with its reason:
// - The nonce is validated strictly (charset and length) and never echoed or logged.
// - The message is fixed: "cos-route-proof:v1:" + nonce + ":" + serverInstanceId. The caller
//   picks only the nonce, so this is never a general HMAC oracle, and the prefix keeps it
//   apart from the display-stream ticket, the only other HMAC keyed by the token.
// - The response carries the instance id (already on public /api/health as
//   server_instance_id) and the HMAC. Never the token, never an address, never a version.
// - Served only while lib/lan-first.ts `routeProofAvailable` holds: switch on, instance id
//   minted, token at least 32 characters (a proof would let a stranger test guesses of a
//   short token offline).
// - Rate limited per socket address (never req.ip or X-Forwarded-For) plus a global ceiling.
// - Writes nothing, so it takes no lease and is served during a drain.

import { Router, type Request, type Response } from 'express'
import {
  ROUTE_PROOF_PROTOCOL,
  RouteProofRateLimiter,
  computeRouteProof,
  isValidRouteProofNonce,
  lanFirstEnabled,
  routeProofTokenUsable,
} from '../lib/lan-first.js'

export type RouteProofReason = 'bad_nonce' | 'rate_limited' | 'not_ready' | 'disabled' | 'method_not_allowed'

export const ROUTE_PROOF_REASON_STATUS: Record<RouteProofReason, number> = {
  bad_nonce: 400,
  disabled: 404,
  method_not_allowed: 405,
  rate_limited: 429,
  not_ready: 503,
}

export interface RouteProofRouterOptions {
  /** Read per request, so a token change is honoured without a remount. */
  token: () => string
  serverInstanceId: () => string | null
  env?: () => NodeJS.ProcessEnv
  limiter?: RouteProofRateLimiter
}

function send(res: Response, reason: RouteProofReason, retryAfterSeconds?: number): void {
  if (retryAfterSeconds != null) res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('Cache-Control', 'no-store')
  res.status(ROUTE_PROOF_REASON_STATUS[reason]).json({ v: ROUTE_PROOF_PROTOCOL, reason })
}

export function createRouteProofRouter(options: RouteProofRouterOptions): Router {
  const router = Router()
  const limiter = options.limiter ?? new RouteProofRateLimiter()
  const env = options.env ?? (() => process.env)

  router.all('/route-proof', (req: Request, res: Response) => {
    // The public door in api-auth.ts is GET only, so any other method has already been
    // refused without a token. With a token it is still refused here: one shape, one verb.
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return send(res, 'method_not_allowed')
    }
    if (!lanFirstEnabled(env())) return send(res, 'disabled')
    // Counted before the nonce check, so malformed requests spend the same budget.
    const admission = limiter.admit(req.socket?.remoteAddress)
    if (!admission.ok) return send(res, 'rate_limited', admission.retryAfterSeconds)
    const nonce = req.query.nonce
    if (!isValidRouteProofNonce(nonce)) return send(res, 'bad_nonce')
    let token = ''
    try { token = options.token() } catch { token = '' }
    const serverInstanceId = options.serverInstanceId()
    if (!serverInstanceId || !routeProofTokenUsable(token)) return send(res, 'not_ready', 30)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      v: ROUTE_PROOF_PROTOCOL,
      serverInstanceId,
      proof: computeRouteProof(token, nonce, serverInstanceId),
    })
  })

  return router
}
