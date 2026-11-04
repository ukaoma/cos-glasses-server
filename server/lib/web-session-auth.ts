import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isAllowedNetworkOrigin, type AllowedOriginOptions } from './network-policy.js'
import { timingSafeTokenEqual } from './token-auth.js'

export const WEB_SESSION_COOKIE_NAME = 'cos_web_session'
export const WEB_CSRF_HEADER = 'x-cos-web'
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60_000
export const WEB_HANDOFF_TTL_MS = 2 * 60_000
export const WEB_HANDOFF_MAX_ACTIVE = 16

const HANDOFF_TICKET_PATTERN = /^[A-Za-z0-9_-]{24,64}$/

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    if (key) out[key] = val
  }
  return out
}

function signSessionExpiry(apiToken: string, expUnixSec: number): string {
  return createHmac('sha256', `cos_web_session_v1:${apiToken}`)
    .update(String(expUnixSec))
    .digest('hex')
}

export function mintWebSessionCookieValue(apiToken: string, nowMs = Date.now(), ttlMs = WEB_SESSION_TTL_MS): {
  value: string
  expiresAtMs: number
} {
  const expiresAtMs = nowMs + ttlMs
  const expUnixSec = Math.floor(expiresAtMs / 1000)
  const sig = signSessionExpiry(apiToken, expUnixSec)
  return { value: `${expUnixSec}.${sig}`, expiresAtMs }
}

export function verifyWebSessionCookieValue(
  cookieValue: string | undefined,
  apiToken: string,
  nowMs = Date.now(),
): boolean {
  if (typeof cookieValue !== 'string' || !apiToken) return false
  const dot = cookieValue.indexOf('.')
  if (dot <= 0) return false
  const expPart = cookieValue.slice(0, dot)
  const sigPart = cookieValue.slice(dot + 1)
  if (!/^\d{1,15}$/.test(expPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return false
  const expUnixSec = Number(expPart)
  if (!Number.isSafeInteger(expUnixSec) || expUnixSec * 1000 <= nowMs) return false
  const expected = signSessionExpiry(apiToken, expUnixSec)
  const left = Buffer.from(sigPart, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function formatSetWebSessionCookie(value: string, maxAgeSec: number, secure = false): string {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function formatClearWebSessionCookie(secure = false): string {
  return formatSetWebSessionCookie('', 0, secure)
}

export interface WebSessionAuthRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

export interface WebSessionVerifyOptions extends AllowedOriginOptions {
  nowMs?: number
}

/**
 * Verify whether `req` carries a valid `cos_web_session` cookie AND satisfies
 * CSRF + Origin + Port bounds on mutating methods.
 *
 * - GET/HEAD/OPTIONS: valid cookie signature + not expired. If an `Origin` header is
 *   present, it must also match `isAllowedNetworkOrigin` (including `allowedPorts`).
 * - POST/PUT/PATCH/DELETE: valid cookie + `X-COS-Web: 1` header + an explicit `Origin`
 *   (or `Referer`) matching `isAllowedNetworkOrigin` (including `allowedPorts`).
 *   This blocks cross-origin requests, HTML form CSRF, and same-host cross-port servers.
 */
export function isWebSessionAuthorized(
  req: WebSessionAuthRequest,
  apiToken: string,
  options: WebSessionVerifyOptions = {},
): boolean {
  const headers = req.headers ?? {}
  const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : undefined
  const cookies = parseCookies(cookieHeader)
  const rawCookie = cookies[WEB_SESSION_COOKIE_NAME]
  if (!verifyWebSessionCookieValue(rawCookie, apiToken, options.nowMs ?? Date.now())) {
    return false
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const originHeader = typeof headers.origin === 'string' ? headers.origin : undefined
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    if (originHeader && originHeader !== 'null') {
      return isAllowedNetworkOrigin(originHeader, options)
    }
    return true
  }

  const csrfVal = headers[WEB_CSRF_HEADER]
  const csrfOk = csrfVal === '1' || (Array.isArray(csrfVal) && csrfVal[0] === '1')
  if (!csrfOk) return false

  const candidateOrigin = originHeader && originHeader !== 'null'
    ? originHeader
    : (typeof headers.referer === 'string' ? headers.referer : '')
  if (!candidateOrigin) return false
  return isAllowedNetworkOrigin(candidateOrigin, options)
}

interface HandoffRecord {
  ticket: string
  expiresAtMs: number
}

/**
 * Short-lived, single-use loopback handoff tickets so native `COS Control.app` can
 * open the user's browser directly into an authenticated session without putting
 * the standing `COS_API_TOKEN` in a URL or touching `PairingState`.
 */
export class WebHandoffStore {
  private readonly tickets = new Map<string, HandoffRecord>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  private sweep(at: number): void {
    for (const [k, rec] of this.tickets) {
      if (at >= rec.expiresAtMs) this.tickets.delete(k)
    }
  }

  mint(ttlMs = WEB_HANDOFF_TTL_MS): { ticket: string; expiresAt: string } {
    const at = this.now()
    this.sweep(at)
    while (this.tickets.size >= WEB_HANDOFF_MAX_ACTIVE) {
      const oldest = this.tickets.keys().next().value
      if (!oldest) break
      this.tickets.delete(oldest)
    }
    const ticket = randomBytes(24).toString('base64url')
    const expiresAtMs = at + ttlMs
    this.tickets.set(ticket, { ticket, expiresAtMs })
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consume(ticket: unknown): boolean {
    const at = this.now()
    this.sweep(at)
    if (typeof ticket !== 'string' || !HANDOFF_TICKET_PATTERN.test(ticket)) return false
    const existing = this.tickets.get(ticket)
    if (!existing) return false
    this.tickets.delete(ticket)
    return at < existing.expiresAtMs
  }
}

export function verifyLoginTokenOrHandoff(
  input: { token?: unknown; handoff?: unknown },
  apiToken: string,
  handoffStore?: WebHandoffStore,
): boolean {
  if (typeof input.token === 'string' && input.token.trim().length > 0) {
    return timingSafeTokenEqual(input.token.trim(), apiToken)
  }
  if (handoffStore && typeof input.handoff === 'string') {
    return handoffStore.consume(input.handoff.trim())
  }
  return false
}

export const WEB_LOGIN_MAX_FAILURES = 8
export const WEB_LOGIN_WINDOW_MS = 10 * 60_000

/**
 * Failed browser sign-ins per socket IP. After WEB_LOGIN_MAX_FAILURES wrong tokens inside
 * WEB_LOGIN_WINDOW_MS the IP is refused (429) until the window that began with its first
 * failure ends. A success clears the IP. Bounded: at most 512 tracked IPs, oldest evicted.
 */
export class WebLoginLimiter {
  private readonly failures = new Map<string, { count: number; firstAt: number }>()
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxFailures = WEB_LOGIN_MAX_FAILURES,
    private readonly windowMs = WEB_LOGIN_WINDOW_MS,
  ) {}

  /** Seconds until this IP may try again; 0 when it may try now. */
  blockedFor(ip: string): number {
    const rec = this.failures.get(ip)
    if (!rec) return 0
    const left = rec.firstAt + this.windowMs - this.now()
    if (left <= 0) { this.failures.delete(ip); return 0 }
    return rec.count >= this.maxFailures ? Math.ceil(left / 1000) : 0
  }

  fail(ip: string): void {
    const at = this.now()
    const rec = this.failures.get(ip)
    if (!rec || at - rec.firstAt >= this.windowMs) {
      this.failures.delete(ip)
      this.failures.set(ip, { count: 1, firstAt: at })
      while (this.failures.size > 512) {
        const oldest = this.failures.keys().next().value
        if (oldest === undefined) break
        this.failures.delete(oldest)
      }
      return
    }
    rec.count += 1
  }

  succeed(ip: string): void {
    this.failures.delete(ip)
  }
}
