// Glasses pairing routes (6.67.0). Contract: docs/pairing-contract.md.
//
// Mounted under /api AFTER requireApiToken and BEFORE the mutation-lease catch-all and
// the global 10 MB JSON parser:
// - POST /pairing/claim and GET /pairing/claim/:nonce are public (exact matches in
//   isPublicApiRequest); everything else here needs the token AND a loopback socket.
// - The routes write no files, so they never take the mutation lease. During a drain or
//   shutdown they answer 503 `draining` instead.
// - Each route parses its own body with a 1 KB cap.
//
// Every address decision reads `req.socket.remoteAddress`, never `req.ip` or
// X-Forwarded-For. Codes, nonces, tokens and QR text are never logged (lib/pairing.ts
// logs the IP, the result and a 2-character hash of the code).

import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { isLoopbackSocket } from '../lib/network-policy.js'
import {
  PAIRING_NONCE_PATTERN,
  PAIRING_REASON_MESSAGE,
  PAIRING_REASON_STATUS,
  PairingError,
  type PairingReason,
  type PairingState,
} from '../lib/pairing.js'

export interface PairingRouterOptions {
  /** Read per request so a restart created after mount is honoured in tests. */
  state: () => PairingState
  /** True while the server is shutting down or the maintenance gate is closed. */
  isDraining: () => boolean
}

function sendReason(res: Response, reason: PairingReason, retryAfterSeconds?: number): void {
  if (retryAfterSeconds != null) res.setHeader('Retry-After', String(retryAfterSeconds))
  res.status(PAIRING_REASON_STATUS[reason]).json({ reason, message: PAIRING_REASON_MESSAGE[reason] })
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PairingError) return sendReason(res, error.reason, error.retryAfterSeconds)
  console.error('[pairing] internal error:', error instanceof Error ? error.message : 'unknown')
  res.status(500).json({ reason: 'internal', message: 'Pairing failed on the Mac. Try again.' })
}

function socketIp(req: Request): string {
  return req.socket?.remoteAddress ?? ''
}

export function createPairingRouter(options: PairingRouterOptions): Router {
  const router = Router()
  const smallJson = express.json({ limit: '1kb' })

  const notDraining: RequestHandler = (_req, res, next) => {
    if (options.isDraining()) return sendReason(res, 'draining', 30)
    next()
  }
  const loopbackOnly: RequestHandler = (req, res, next) => {
    if (!isLoopbackSocket(req)) return sendReason(res, 'not_loopback')
    next()
  }
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}

  router.post('/pairing/code', notDraining, loopbackOnly, smallJson, (req, res) => {
    const input = body(req)
    if (input.allowLan !== undefined && typeof input.allowLan !== 'boolean') return sendReason(res, 'bad_request')
    try {
      res.json(options.state().mint({ allowLan: input.allowLan === true }))
    } catch (error) { sendError(res, error) }
  })

  router.post('/pairing/claim', notDraining, smallJson, (req, res) => {
    const input = body(req)
    try {
      options.state().claim({ code: input.code, nonce: input.nonce }, socketIp(req))
      res.status(202).json({ pending: true })
    } catch (error) { sendError(res, error) }
  })

  router.get('/pairing/claim/:nonce', notDraining, (req, res) => {
    const nonce = req.params.nonce
    if (typeof nonce !== 'string' || !PAIRING_NONCE_PATTERN.test(nonce)) return sendReason(res, 'bad_request')
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(options.state().poll(nonce, socketIp(req)))
    } catch (error) { sendError(res, error) }
  })

  router.get('/pairing/status', notDraining, loopbackOnly, (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(options.state().status())
    } catch (error) { sendError(res, error) }
  })

  router.post('/pairing/decision', notDraining, loopbackOnly, smallJson, (req, res) => {
    const input = body(req)
    try {
      options.state().decide(input.nonce, input.allow)
      res.json({ ok: true })
    } catch (error) { sendError(res, error) }
  })

  // A body over 1 KB or one that is not JSON answers in the contract's shape, not
  // Express's HTML error page. Scoped to this router's own parsers.
  const parseError: ErrorRequestHandler = (error, req, res, next) => {
    if (!req.path.startsWith('/pairing/')) return next(error)
    if (res.headersSent) return next(error)
    sendReason(res, 'bad_request')
  }
  router.use(parseError)

  return router
}
