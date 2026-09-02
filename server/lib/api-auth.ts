import type { RequestHandler } from 'express'
import { timingSafeTokenEqual } from './token-auth.js'

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

export function isPublicApiRequest(method: string, path: string): boolean {
  if (PUBLIC_API_PATHS.has(path)) return true
  if (method !== 'GET' && method !== 'HEAD') return false
  return TTS_PLAYBACK_CAPABILITY_PATH.test(path)
    || DISPLAY_STREAM_CAPABILITY_PATH.test(path)
}

/** Global /api authentication boundary. Mount before all body parsers. */
export function requireApiToken(apiToken: string): RequestHandler {
  return (req, res, next) => {
    if (isPublicApiRequest(req.method, req.path)) return next()
    if (!timingSafeTokenEqual(req.headers['x-cos-token'], apiToken)) {
      return res.status(401).json({
        error: 'unauthorized',
        reason: 'pairing_token_rejected',
        message: 'In COS Control choose Copy Pairing Token, then paste the complete value into COS Glasses.',
      })
    }
    next()
  }
}
