import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dirname } from 'node:path'
import {
  hasProxyForwardedHeaders,
  isAllowedNetworkIp,
  isAllowedNetworkOrigin,
  isLoopbackAddress,
  isTailscaleIpv4,
  isTailscaleIpv6,
  normalizeRemoteIp,
  type AllowedOriginOptions,
} from './network-policy.js'
import { readSwitch } from './env-switch.js'
import { timingSafeTokenEqual } from './token-auth.js'
import { CROCKFORD_ALPHABET, PAIRING_CODE_ATTEMPT_LIMIT, PAIRING_CODE_LENGTH } from './glasses-pairing.js'

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

function signSession(apiToken: string, expUnixSec: number, epoch: number): string {
  return createHmac('sha256', `cos_web_session_v2:${apiToken}`)
    .update(`${expUnixSec}:${epoch}`)
    .digest('hex')
}

// ── Revocation (review W1) ───────────────────────────────────────────────────
// The cookie signs a session EPOCH kept on the Mac. "Sign out every browser" bumps it, so
// every copy of every cookie stops working at once, without rotating the pairing token
// (which would also unpair the glasses). The file holds only a number.
let epochFile: string | null = null
let epochCache: number | null = null

/** Where the epoch lives. index.ts sets it to dataPath('web-session.json'); tests pass a temp file. */
export function setWebSessionEpochFile(path: string | null): void {
  epochFile = path
  epochCache = null
}

/**
 * The epoch NEVER moves backwards (review W5). A missing file (first run, or deleted) and an
 * unreadable or corrupt one both start a new epoch from the clock in whole seconds, which is
 * above any count of earlier "Sign out every browser" bumps, so no cookie from before can come
 * back to life. The cost is one more sign-in after such an event, never a revival.
 */
export function currentWebSessionEpoch(): number {
  if (epochCache !== null) return epochCache
  if (!epochFile) {
    epochCache = 0
    return 0
  }
  let value: number | null = null
  try {
    const parsed = JSON.parse(readFileSync(epochFile, 'utf8')) as { epoch?: unknown }
    if (typeof parsed.epoch === 'number' && Number.isSafeInteger(parsed.epoch) && parsed.epoch >= 0) value = parsed.epoch
  } catch {
    value = null
  }
  if (value === null) {
    value = Math.floor(Date.now() / 1000)
    try { writeEpoch(value) } catch { /* still forward in memory; the next read tries again */ }
  }
  epochCache = value
  return value
}

// The server's durable writer: fsync of the bytes, rename, then fsync of the directory, through
// a guarded (O_NOFOLLOW) exclusive temp file.
function writeEpoch(value: number): void {
  if (!epochFile) return
  mkdirSync(dirname(epochFile), { recursive: true })
  durableAtomicWriteFileSync(epochFile, JSON.stringify({ epoch: value }) + '\n', { mode: 0o600 })
}

/** Invalidates every browser session. Returns the new epoch. Written atomically and fsynced. */
export function bumpWebSessionEpoch(): number {
  const next = currentWebSessionEpoch() + 1
  writeEpoch(next)
  epochCache = next
  return next
}

export function mintWebSessionCookieValue(apiToken: string, nowMs = Date.now(), ttlMs = WEB_SESSION_TTL_MS, epoch = currentWebSessionEpoch()): {
  value: string
  expiresAtMs: number
} {
  const expiresAtMs = nowMs + ttlMs
  const expUnixSec = Math.floor(expiresAtMs / 1000)
  const sig = signSession(apiToken, expUnixSec, epoch)
  return { value: `${expUnixSec}.${epoch}.${sig}`, expiresAtMs }
}

export function verifyWebSessionCookieValue(
  cookieValue: string | undefined,
  apiToken: string,
  nowMs = Date.now(),
  epoch = currentWebSessionEpoch(),
): boolean {
  if (typeof cookieValue !== 'string' || !apiToken) return false
  const parts = cookieValue.split('.')
  if (parts.length !== 3) return false
  const [expPart, epochPart, sigPart] = parts
  if (!/^\d{1,15}$/.test(expPart) || !/^\d{1,12}$/.test(epochPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return false
  const expUnixSec = Number(expPart)
  if (!Number.isSafeInteger(expUnixSec) || expUnixSec * 1000 <= nowMs) return false
  // The signature covers the CURRENT epoch, so a cookie from before "Sign out every browser"
  // (or one whose epoch digits were edited) fails here; epochPart is only shape-checked.
  const expected = signSession(apiToken, expUnixSec, epoch)
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

// ── Which sockets may use the browser surface (review W2) ────────────────────
/**
 * COS Control Web is for this Mac and its tailnet: loopback, Tailscale IPv4 (100.64/10) and
 * Tailscale IPv6 (fd7a:115c:a1e0::/48). Home Wi-Fi and other LAN addresses are refused
 * unless COS_WEB_CONTROL_LAN=1, because there the page and its sign-in travel as plain HTTP
 * and anyone on the network can watch. The glasses' X-Cos-Token path is unaffected.
 */
export function isWebControlSocketAllowed(
  remoteAddress: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
  headers?: Record<string, unknown> | null,
): boolean {
  // Review W4: behind `tailscale serve`, Funnel or any local proxy every caller arrives on
  // loopback. Such a request carries forwarding headers, and is never treated as this Mac or
  // the tailnet (the same rule isLoopbackSocket applies to the Mac-only routes).
  if (hasProxyForwardedHeaders(headers)) return false
  const addr = normalizeRemoteIp(remoteAddress ?? '')
  if (!addr) return false
  if (isLoopbackAddress(addr) || isTailscaleIpv4(addr) || isTailscaleIpv6(addr)) return true
  return readSwitch(env.COS_WEB_CONTROL_LAN, false) && isAllowedNetworkIp(addr)
}

export interface WebSessionAuthRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | undefined } | null
}

export interface WebSessionVerifyOptions extends AllowedOriginOptions {
  nowMs?: number
  env?: NodeJS.ProcessEnv
}

/** The origin a browser stamped, as `host[:port]`, lowercased; null when it is not a URL. */
function originHostPort(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Verify whether `req` carries a valid `cos_web_session` cookie AND satisfies the CSRF and
 * origin rules on writes.
 *
 * - Any method: the socket must be loopback or a Tailscale peer (or LAN, opted in), the cookie
 *   signature valid, unexpired and of the current session epoch.
 * - GET/HEAD/OPTIONS: if an `Origin` header is present it must pass `isAllowedNetworkOrigin`.
 * - POST/PUT/PATCH/DELETE: `X-COS-Web: 1`, plus an `Origin` (or `Referer`) that passes the
 *   allowlist AND names the very host and port the browser connected to (the `Host` header).
 *   The allowlist alone admits any LAN or tailnet address on 3141/3143 (review W3); equality
 *   with Host is what makes it "this server". A DNS-rebinding page matches Host but fails the
 *   allowlist; another machine's page passes the allowlist but fails Host.
 */
export function isWebSessionAuthorized(
  req: WebSessionAuthRequest,
  apiToken: string,
  options: WebSessionVerifyOptions = {},
): boolean {
  if (!isWebControlSocketAllowed(req.socket?.remoteAddress, options.env, req.headers)) return false
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
  if (!isAllowedNetworkOrigin(candidateOrigin, options)) return false
  const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : ''
  return host !== '' && originHostPort(candidateOrigin) === host
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

/** Why a browser sign-in failed. Logged and shown to the person; never carries the value. */
export type WebLoginFailure = 'wrong_token' | 'wrong_code' | 'glasses_code' | 'handoff_expired' | 'missing'

export type WebLoginResult =
  | { ok: true; kind: 'token' | 'handoff' | 'code' }
  | { ok: false; reason: WebLoginFailure; length: number }

// What a phone paste drags along with a token: spaces and line breaks (a copy out of a
// terminal or a note), zero-width and no-break characters, and the quotes around a value
// copied out of an .env line. None of them can be part of a pairing token.
const PASTE_INVISIBLES = /[\s\u200B-\u200D\u2060\uFEFF\u00A0]/g
const PASTE_WRAPPING_QUOTES = /^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D]+$/g

/** The token as pasted, with paste debris removed (see PASTE_INVISIBLES). */
export function normalizePastedToken(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.replace(PASTE_INVISIBLES, '').replace(PASTE_WRAPPING_QUOTES, '')
}

/**
 * Check one sign-in and say why it failed. Exactly one credential is tried, in this order:
 * token, handoff ticket, code. `isGlassesCode` answers whether a code that is NOT a web code
 * is the live glasses pairing code; it must be read only (never consume or count an attempt),
 * because that code belongs to the glasses app and the person typed it here by mistake.
 */
export function classifyWebLogin(
  input: { token?: unknown; handoff?: unknown; code?: unknown },
  apiToken: string,
  handoffStore?: WebHandoffStore,
  codeStore?: WebDeviceCodeStore,
  isGlassesCode?: (code: string) => boolean,
): WebLoginResult {
  const raw = typeof input.token === 'string' ? input.token.trim() : ''
  const token = normalizePastedToken(input.token)
  if (token.length > 0 || raw.length > 0) {
    // The value as typed first (a provisioned token is never second-guessed), then the
    // paste-cleaned one. Still one sign-in attempt either way.
    if (raw.length > 0 && timingSafeTokenEqual(raw, apiToken)) return { ok: true, kind: 'token' }
    if (token.length > 0 && token !== raw && timingSafeTokenEqual(token, apiToken)) return { ok: true, kind: 'token' }
    return { ok: false, reason: 'wrong_token', length: token.length || raw.length }
  }
  if (handoffStore && typeof input.handoff === 'string' && input.handoff.trim().length > 0) {
    const ticket = input.handoff.trim()
    return handoffStore.consume(ticket)
      ? { ok: true, kind: 'handoff' }
      : { ok: false, reason: 'handoff_expired', length: ticket.length }
  }
  if (codeStore && typeof input.code === 'string' && input.code.trim().length > 0) {
    if (codeStore.consume(input.code)) return { ok: true, kind: 'code' }
    const code = normalizeDeviceCode(input.code)
    let glasses = false
    if (code && isGlassesCode) {
      try { glasses = isGlassesCode(code) === true } catch { glasses = false }
    }
    return { ok: false, reason: glasses ? 'glasses_code' : 'wrong_code', length: code?.length ?? input.code.trim().length }
  }
  return { ok: false, reason: 'missing', length: 0 }
}

/**
 * How many times web sign-in may ask "is this the glasses code?" about one live glasses code,
 * across every device (review W1). The glasses claim route allows PAIRING_CODE_ATTEMPT_LIMIT
 * guesses per code, but the web limiter counts per IP, so without this cap many tailnet
 * addresses would each get their own answers about the same code. Past the budget a typed code
 * reads as a plain wrong code, which says nothing. Pairing state is never touched: the key is
 * read from it, the count lives here, and a newly shown glasses code starts a fresh budget.
 */
export class WebGlassesCodeProbeBudget {
  private key: string | null = null
  private count = 0
  constructor(private readonly limit = PAIRING_CODE_ATTEMPT_LIMIT) {}

  /** `key` names the live glasses code (null when none is showing); `isLive` is the read-only check. */
  check(key: string | null, isLive: () => boolean): boolean {
    if (key === null) return false
    if (key !== this.key) {
      this.key = key
      this.count = 0
    }
    this.count += 1
    if (this.count > this.limit) return false
    return isLive()
  }
}

export function verifyLoginTokenOrHandoff(
  input: { token?: unknown; handoff?: unknown; code?: unknown },
  apiToken: string,
  handoffStore?: WebHandoffStore,
  codeStore?: WebDeviceCodeStore,
): boolean {
  return classifyWebLogin(input, apiToken, handoffStore, codeStore).ok
}

export const WEB_DEVICE_CODE_TTL_MS = 5 * 60_000
export const WEB_DEVICE_CODE_MAX_ACTIVE = 4
const DEVICE_CODE_ALPHABET = CROCKFORD_ALPHABET
const DEVICE_CODE_LENGTH = PAIRING_CODE_LENGTH

/**
 * Normalise what a person typed: Crockford base32 reads O as 0 and I/L as 1, and ignores
 * case, spaces and dashes, so "k7p3-qx9m" and "K7P3QX9M" are the same code.
 */
export function normalizeDeviceCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (clean.length !== DEVICE_CODE_LENGTH) return null
  for (const ch of clean) if (!DEVICE_CODE_ALPHABET.includes(ch)) return null
  return clean
}

/**
 * Short sign-in codes for another device (the phone), minted by a browser or app that is
 * already signed in. Same shape as glasses pairing: 8 Crockford characters (40 bits), five
 * minutes, single use, at most four live at once. Guessing is also capped per IP by the
 * route's sign-in limiter, so a code cannot be found inside its lifetime.
 */
export class WebDeviceCodeStore {
  private readonly codes = new Map<string, number>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  private sweep(at: number): void {
    for (const [code, exp] of this.codes) if (at >= exp) this.codes.delete(code)
  }

  mint(ttlMs = WEB_DEVICE_CODE_TTL_MS): { code: string; display: string; expiresAt: string } {
    const at = this.now()
    this.sweep(at)
    while (this.codes.size >= WEB_DEVICE_CODE_MAX_ACTIVE) {
      const oldest = this.codes.keys().next().value
      if (oldest === undefined) break
      this.codes.delete(oldest)
    }
    let code = ''
    do {
      code = ''
      const bytes = randomBytes(DEVICE_CODE_LENGTH)
      for (const b of bytes) code += DEVICE_CODE_ALPHABET[b & 31]
    } while (this.codes.has(code))
    this.codes.set(code, at + ttlMs)
    return { code, display: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(at + ttlMs).toISOString() }
  }

  consume(input: unknown): boolean {
    const at = this.now()
    this.sweep(at)
    const code = normalizeDeviceCode(input)
    if (!code) return false
    // The sweep above has already dropped every expired code, so presence means still valid.
    if (!this.codes.has(code)) return false
    this.codes.delete(code)
    return true
  }
}

export const WEB_LOGIN_MAX_FAILURES = 8
export const WEB_LOGIN_WINDOW_MS = 10 * 60_000

/**
 * Failed browser sign-ins per socket IP. After WEB_LOGIN_MAX_FAILURES wrong tokens inside
 * WEB_LOGIN_WINDOW_MS the IP is refused (429) until the window that began with its first
 * failure ends. A success clears the IP. Bounded: at most 512 tracked IPs, oldest evicted.
 */
export class WebLoginLimiter {
  private readonly failures = new Map<string, { count: number; firstAt: number; last?: WebLoginFailure }>()
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

  fail(ip: string, reason?: WebLoginFailure): void {
    const at = this.now()
    const rec = this.failures.get(ip)
    if (!rec || at - rec.firstAt >= this.windowMs) {
      this.failures.delete(ip)
      this.failures.set(ip, { count: 1, firstAt: at, last: reason })
      while (this.failures.size > 512) {
        const oldest = this.failures.keys().next().value
        if (oldest === undefined) break
        this.failures.delete(oldest)
      }
      return
    }
    rec.count += 1
    if (reason) rec.last = reason
  }

  /** The kind of this IP's most recent failure inside its window, for the lockout message. */
  lastFailure(ip: string): WebLoginFailure | null {
    return this.failures.get(ip)?.last ?? null
  }

  succeed(ip: string): void {
    this.failures.delete(ip)
  }
}
