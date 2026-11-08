// What the 3144 signer listener serves (6.99.31, plan section 4.8, review B2 and W2). Only with
// COS_WEB_KEY_AUTHORITY on: index.ts builds this handler and the 3144 listener only then
// (lib/listener-startup.ts listenerPlan), so with the flag off none of it exists.
//
// THE ORIGIN HOLDS THE KEY AND NOTHING ELSE. The big Control Web app (transcripts, previews, the
// memories frame) stays on 3143. On 3144:
//   - the page and its three scripts and one stylesheet (server/web-signer/), served ONLY from bytes
//     that matched their pack-time manifest (lib/web-control-integrity.ts, a second instance over
//     web-signer/). No manifest, a changed file, an extra file: a plain error page, nothing signs.
//   - a short allowlist of /api routes the page calls (key status, nonce, enrollment, revoke, the
//     handoff claim, and the one turn route plus its status read). Everything else is 404 here, so
//     no transcript, meeting or memory route answers on this origin.
//   - an API request that names any other Origin is refused, and a write must name this one, so
//     no other page (3143 included) can drive this origin's API with the phone's cookie.
//   - every response: a strict CSP with no inline script or style and frame-ancestors 'none',
//     X-Frame-Options DENY, COOP and CORP same-origin, no referrer, no caching.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebControlIntegrity } from './web-control-integrity.js'
import type { IntegrityReport } from './web-key-authority.js'

export const WEB_SIGNER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "worker-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')

export const WEB_SIGNER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': WEB_SIGNER_CSP,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=()',
})

/** The only /api routes the signer origin answers. Method plus exact path shape. */
export const WEB_SIGNER_API_ALLOWLIST: ReadonlyArray<{ method: 'GET' | 'POST'; path: RegExp }> = Object.freeze([
  { method: 'GET', path: /^\/api\/web-key\/status$/ },
  { method: 'GET', path: /^\/api\/web-key\/keys$/ },
  { method: 'POST', path: /^\/api\/web-key\/nonce$/ },
  { method: 'POST', path: /^\/api\/web-key\/enroll\/start$/ },
  { method: 'POST', path: /^\/api\/web-key\/enroll\/prove$/ },
  { method: 'GET', path: /^\/api\/web-key\/enroll\/status$/ },
  { method: 'POST', path: /^\/api\/web-key\/revoke$/ },
  { method: 'POST', path: /^\/api\/web-key\/handoff\/claim$/ },
  { method: 'POST', path: /^\/api\/agent-sessions\/bindings\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/turns$/ },
  { method: 'GET', path: /^\/api\/agent-sessions\/bindings\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/turns\/[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/ },
])

export function signerApiAllowed(method: string | undefined, pathname: string): boolean {
  const m = String(method ?? 'GET').toUpperCase()
  return WEB_SIGNER_API_ALLOWLIST.some(r => r.method === m && r.path.test(pathname))
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export const SIGNER_PAUSED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>COS approval paused</title></head><body><h1>COS approval is paused</h1><p>The approval page on this Mac does not match the one that shipped with this version, so it is not being served. Nothing was signed.</p><p>Open COS Control on the Mac to repair or reinstall the server.</p></body></html>'

/**
 * The integrity the authority reads (review W1), Phase 3: the signer page holds the key, so a turn is
 * vouched only while BOTH the Control Web tree and the signer tree match their manifests. Null while
 * Control Web integrity is off (`integrity_off`, as before). The shape is the contract's, unchanged.
 */
export function combinedIntegrityReport(webControl: Pick<WebControlIntegrity, 'state' | 'manifestSha256'> | null, signer: Pick<WebControlIntegrity, 'state'> | null): IntegrityReport | null {
  if (!webControl) return null
  const signerOk = signer !== null && signer.state.ok === true
  return { enabled: true, lastCheckOk: webControl.state.ok === true && signerOk, checkedAt: webControl.state.checkedAt || null, manifestSha256: webControl.manifestSha256 }
}

export interface WebKeySignerDeps {
  /** The integrity check over server/web-signer/. Null: nothing is served (the page is never read from disk unchecked). */
  integrity: WebControlIntegrity | null
  /** The main app, for the allowlisted /api routes. */
  api: (req: IncomingMessage, res: ServerResponse) => void
  /** `https://<MagicDNS name>:3144` (lib/web-key-origin.ts), or null when unknown. */
  origin: () => string | null
  /** How often the signer's files are re-checked. 0: never on a timer (tests call integrity.check()). */
  recheckMs?: number
}

function applyHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(WEB_SIGNER_HEADERS)) res.setHeader(k, v)
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head = false): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  res.setHeader('Content-Length', String(buf.length))
  res.end(head ? undefined : buf)
}

function json(res: ServerResponse, status: number, value: Record<string, unknown>): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

export function createWebKeySignerHandler(deps: WebKeySignerDeps): ((req: IncomingMessage, res: ServerResponse) => void) & { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  const every = deps.recheckMs ?? 60_000
  if (deps.integrity && every > 0) {
    const integrity = deps.integrity
    timer = setInterval(() => { try { integrity.check() } catch { /* the next tick retries */ } }, every)
    timer.unref?.()
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    applyHeaders(res)
    let pathname: string
    try { pathname = new URL(req.url ?? '/', 'https://signer.invalid').pathname } catch { json(res, 400, { ok: false, error: 'invalid_request' }); return }
    const method = String(req.method ?? 'GET').toUpperCase()

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const expected = deps.origin()
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      // Another origin's page never drives this one. A write must name this origin outright.
      if (origin !== undefined && origin !== expected) { json(res, 403, { ok: false, error: 'origin_refused' }); return }
      if (method !== 'GET' && method !== 'HEAD' && (expected === null || origin !== expected)) { json(res, 403, { ok: false, error: 'origin_refused' }); return }
      if (!signerApiAllowed(method === 'HEAD' ? 'GET' : method, pathname)) { json(res, 404, { ok: false, error: 'not_found' }); return }
      deps.api(req, res)
      return
    }

    if (method !== 'GET' && method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(res, 405, { ok: false, error: 'method_not_allowed' }); return }
    const head = method === 'HEAD'
    const snapshot = deps.integrity ? deps.integrity.snapshot() : null
    if (!snapshot) { send(res, 503, 'text/html; charset=utf-8', SIGNER_PAUSED_PAGE, head); return }
    const file = pathname === '/' ? '/index.html' : pathname
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    const body = TYPES[ext] ? snapshot.get(file) : undefined
    if (!body) { send(res, 404, 'text/plain; charset=utf-8', 'Not found', head); return }
    send(res, 200, TYPES[ext], body, head)
  }
  return Object.assign(handler, { stop: () => { if (timer) clearInterval(timer); timer = null } })
}
