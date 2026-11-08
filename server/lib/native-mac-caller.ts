// 7.0.4 W1: is this request COS Control's own helper on this Mac, rather than a browser?
//
// WHY. S1 redaction turns paths in a session's words into base names before they leave the Mac. COS Control
// (0.5.378 and 0.5.379, unchanged) recognises that a Work prompt it sent has ARRIVED by comparing the first 60
// letters and digits of its own, unredacted prompt with the user turns of `GET /api/agent-sessions/:p/:id?turns=N`
// (WorkProgress.promptArrival, through the helper's `session-recent-replies`). A prompt that opens with a path then
// never matched: no replies shown, Continue refused, a Cursor note stuck at queued.
//
// WHO. The helper calls `http://127.0.0.1:<port>` with the X-COS-Token header, from URLSession: no Origin, no
// Referer, no Sec-Fetch-* metadata, and a CFNetwork user agent. A browser always sends fetch metadata
// (Chrome 76, Firefox 90, Safari 16.4 and later) and a `Mozilla/` user agent; Control Web signs in with a cookie,
// not the header; a phone is never on loopback; a `tailscale serve` hop arrives on loopback but carries proxy
// headers (isLoopbackSocket refuses it). Any other local process holding the token can already read the files.
import type { Request, Response } from 'express'
import { API_AUTH_BY_LOCAL } from './api-auth.js'
import { isLoopbackSocket } from './network-policy.js'

const BROWSER_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'] as const

/** True only for a header-token request on this Mac's loopback, not proxied, carrying nothing a browser sends. */
export function isNativeMacCaller(req: Pick<Request, 'headers' | 'socket'>, res: Pick<Response, 'locals'>): boolean {
  if (res.locals?.[API_AUTH_BY_LOCAL] !== 'token') return false
  if (!isLoopbackSocket(req)) return false
  const headers = req.headers ?? {}
  for (const name of BROWSER_HEADERS) if (headers[name] !== undefined) return false
  const agent = headers['user-agent']
  if (typeof agent === 'string' && /\bMozilla\//.test(agent)) return false
  return true
}
