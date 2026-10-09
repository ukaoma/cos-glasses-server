import type { RequestHandler } from 'express'
import { timingSafeTokenEqual } from './token-auth.js'
import { PAIRING_NONCE_BODY } from './glasses-pairing.js'

// Recovery/setup clients need these availability surfaces before they have a
// usable token. Keep private provider state and every mutation route out.
const PUBLIC_API_PATHS = new Set([
  '/health',
  '/display-stream',
  '/diag/client',
  '/diag/health',
])

// Native HTML audio requests cannot attach X-Cos-Token. The UUID minted by
// authenticated POST /tts/prepare is therefore a short-lived bearer
// capability. Keep this exception exact: GET/HEAD only, one canonical v4 UUID
// path segment, and no query-token fallback. (A path segment reaches access and
// proxy logs exactly as a query string does — the TTL is what bounds a leaked
// URL; the point of refusing a query form is that it is trivially added back by
// accident and routinely forwarded.)
const TTS_PLAYBACK_CAPABILITY_PATH = /^\/tts\/play\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// EventSource has the identical constraint, so the display stream reuses the same
// shape: `/display-stream/<expUnixSeconds>.<hex hmac>`, GET/HEAD only, path segment,
// no query-token fallback (same reasoning as above — this is not log hygiene). Admission here is SHAPE ONLY — the signature is verified
// in the route, which is the only place that holds the API token.
//
// `/display-stream` itself STAYS PUBLIC, deliberately. Removing it would make a
// ticketless connect fall through to the token check and 401, and neither EventSource
// in the client can send a header — every installed build would enter a permanent
// reconnect loop and, because `displayBusConnected` would never turn true, would also
// stop syncing already-recorded offline meetings. Confidentiality is enforced by
// withholding CONTENT in the route, not by rejecting the connection. The route also
// accepts a valid X-Cos-Token header as equivalent authorization, for the fetch-based
// callers that can send one; the ticket exists only for the ones that cannot.
const DISPLAY_STREAM_CAPABILITY_PATH = /^\/display-stream\/\d{1,15}\.[0-9a-f]{64}$/

// 6.67.0 glasses pairing (docs/pairing-contract.md). Exactly two public doors, each
// matched on METHOD and path, never through the method-agnostic set above:
// - POST /pairing/claim: a phone with no token yet presents the short-lived code.
// - GET /pairing/claim/<nonce>: the same phone polls for the decision. The route binds
//   the poll to the claim's socket IP, and the token is released only after Allow.
// Minting, status and decisions stay behind the token AND a loopback socket.
const PAIRING_POLL_PATH = new RegExp(`^/pairing/claim/${PAIRING_NONCE_BODY}$`)

export function isPublicApiRequest(method: string, path: string): boolean {
  if (PUBLIC_API_PATHS.has(path)) return true
  if (method === 'POST' && path === '/pairing/claim') return true
  if (method === 'GET' && PAIRING_POLL_PATH.test(path)) return true
  if (method !== 'GET' && method !== 'HEAD') return false
  return TTS_PLAYBACK_CAPABILITY_PATH.test(path)
    || DISPLAY_STREAM_CAPABILITY_PATH.test(path)
}

export interface RequireApiTokenOptions {
  /**
   * Called once per request that passed the token check (never for a public path).
   * Pairing uses it to stamp `firstAuthAfterClaimAt`. A throw here is swallowed: an
   * observer must never turn an authenticated request into a failure.
   */
  onAuthenticated?: (req: Parameters<RequestHandler>[0]) => void
}

/** Global /api authentication boundary. Mount before all body parsers. */
export function requireApiToken(apiToken: string, options: RequireApiTokenOptions = {}): RequestHandler {
  return (req, res, next) => {
    if (isPublicApiRequest(req.method, req.path)) return next()
    if (!timingSafeTokenEqual(req.headers['x-cos-token'], apiToken)) {
      return res.status(401).json({
        error: 'unauthorized',
        // Stable on purpose: clients key off this value, not the message.
        reason: 'pairing_token_rejected',
        // Older COS Glasses builds, which cannot scan, show this message word for word.
        message: 'Paste the pairing token from COS Control, or scan its code with COS Glasses 6.10.621 or newer.',
      })
    }
    if (options.onAuthenticated) {
      try { options.onAuthenticated(req) } catch { /* observer only */ }
    }
    next()
  }
}
