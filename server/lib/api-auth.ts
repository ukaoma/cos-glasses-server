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
// path segment, and no query-token fallback that could leak into URL logs.
const TTS_PLAYBACK_CAPABILITY_PATH = /^\/tts\/play\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isPublicApiRequest(method: string, path: string): boolean {
  if (PUBLIC_API_PATHS.has(path)) return true
  return (method === 'GET' || method === 'HEAD')
    && TTS_PLAYBACK_CAPABILITY_PATH.test(path)
}

/** Global /api authentication boundary. Mount before all body parsers. */
export function requireApiToken(apiToken: string): RequestHandler {
  return (req, res, next) => {
    if (isPublicApiRequest(req.method, req.path)) return next()
    if (!timingSafeTokenEqual(req.headers['x-cos-token'], apiToken)) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  }
}
