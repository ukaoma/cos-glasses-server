import express, { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { hostname, networkInterfaces } from 'node:os'
import {
  hasProxyForwardedHeaders,
  isAllowedNetworkIp,
  isAllowedNetworkOrigin,
  isLoopbackAddress,
  isLoopbackSocket,
  normalizeRemoteIp,
  normalizeTailscaleDnsName,
  reachableIpv4Addresses,
} from '../lib/network-policy.js'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { getTailscaleNudger } from '../lib/tailscale-nudge.js'
import {
  formatClearWebSessionCookie,
  formatSetWebSessionCookie,
  isWebSessionAuthorized,
  mintWebSessionCookieValue,
  classifyWebLogin,
  type WebLoginFailure,
  WebGlassesCodeProbeBudget,
  WEB_SESSION_TTL_MS,
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_MAX_LIFE_MS,
  readWebSessionCookie,
  webSessionCookieFrom,
  WebHandoffStore,
  WebLoginLimiter,
  WebDeviceCodeStore,
  bumpWebSessionEpoch,
  isWebControlSocketAllowed,
} from '../lib/web-session-auth.js'
import { acquireMaintenanceWork, MaintenanceLifecycleError, maintenanceErrorPayload } from '../lib/maintenance-lifecycle.js'
import { getOwnerName } from '../lib/profile.js'
import { readSwitch } from '../lib/env-switch.js'
import { managedServerVersion } from '../lib/managed-runtime.js'
import {
  dispatchMemoriesWebOp,
  isMemoryWebOpReadOnly,
  MUTATING_MEMORY_WEB_OPS,
  READ_ONLY_MEMORY_WEB_OPS,
} from '../lib/web-memories-bridge.js'
import { listLiveTranscriptSessions, readLiveTranscriptSession } from '../lib/web-live-chunks.js'
import { getWebUsageSummary } from '../lib/web-usage-bridge.js'
import { WEB_PET_POSES, controlSupportDir, petChunk, petPreview, planPose, readPetSources, webPetManifest, type WebPetPose } from '../lib/web-pet.js'
import { controlResourcesDir, galleryPets, galleryThumb, parsePetChoice, petChoiceKey, resolvePet, shippedPets, type PetChoice, type PetFetcher } from '../lib/web-pet-choice.js'
import { dataPath } from '../lib/data-dir.js'

export { isMemoryWebOpReadOnly, MUTATING_MEMORY_WEB_OPS, READ_ONLY_MEMORY_WEB_OPS }

export interface WebControlRouterDeps {
  apiToken: () => string
  /** Tests: where the pet's state map and strips live, the chunk cache, and a stand-in for sips. */
  petSupportDir?: () => string
  petCacheDir?: () => string
  petRun?: (cmd: string, args: string[]) => Promise<void>
  petResourcesDir?: () => string | null
  petFetch?: PetFetcher
  port: () => number
  publicPort?: () => number
  httpsPort?: () => number | null
  handoffStore?: WebHandoffStore
  loginLimiter?: WebLoginLimiter
  deviceCodeStore?: WebDeviceCodeStore
  serverVersion?: () => string
  selfDnsName?: () => string | null
  baseDataDir?: () => string | undefined
  queryTailscaleStatus?: () => Promise<{ backendState: string; selfIps: string[]; selfDnsName?: string | null; certDomains?: string[] } | null>
  /** Read-only: is this normalised code the live glasses pairing code? (PairingState.isLiveCode) */
  glassesCodeIsLive?: (code: string) => boolean
  /** Names the live glasses code (its expiry), or null when none is showing. Scopes the probe budget. */
  liveGlassesCodeKey?: () => string | null
  glassesProbeBudget?: WebGlassesCodeProbeBudget
  /** This Mac's Tailscale IPv4, for the phone link in a handoff. Defaults to the interfaces. */
  tailnetIpv4?: () => string | null
  /** Where sign-in failures are logged. Kind, length and socket IP only, never the value. */
  log?: (line: string) => void
  /** Caps POST /web-session/phone-link (5 a minute). Injected by tests. */
  phoneLinkLimiter?: WebPhoneLinkLimiter
}

/** What the sign-in page shows for each failure. Names the fix, never the value typed. */
export const WEB_LOGIN_FAILURE_MESSAGE: Record<WebLoginFailure, string> = {
  wrong_token: 'That token did not match. Copy the pairing token again and paste it within a minute, since the copy clears after 60 seconds. Or choose Open COS on your phone in COS Control and scan its QR.',
  wrong_code: 'That code did not match or has expired. A code lasts 5 minutes and works once. Get a new one.',
  glasses_code: 'That is the glasses pairing code. It only pairs the COS Glasses app. To sign in here, choose Open COS on your phone in COS Control, or paste the pairing token.',
  handoff_expired: 'That sign-in link expired or was already used. Get a new one from COS Control on your Mac, or Open COS on the web in the COS Glasses app.',
  missing: 'Enter a sign-in code or paste the pairing token.',
}

const WEB_LOGIN_LOCKOUT_CAUSE: Record<WebLoginFailure, string> = {
  wrong_token: 'The last try was a wrong token.',
  wrong_code: 'The last try was a wrong or expired code.',
  glasses_code: 'The last try was the glasses pairing code, which only works in the COS Glasses app.',
  handoff_expired: 'The last try was an expired sign-in link.',
  missing: 'The last try had no code or token.',
}

/** The 429 text: how long to wait, and what kept failing, so the next try is the right one. */
export function webLoginLockoutMessage(retryAfterS: number, last: WebLoginFailure | null): string {
  const wait = `Too many failed sign-ins from this device. Try again in ${Math.max(1, Math.ceil(retryAfterS / 60))} min.`
  return last ? `${wait} ${WEB_LOGIN_LOCKOUT_CAUSE[last]}` : wait
}

/** What the CORS gate needs from the Tailscale nudger (the real one, or a fake in tests). */
export interface SelfDnsSource {
  currentSelfDnsName(): string | null
  queryStatus(forceRefresh?: boolean): Promise<unknown>
}

/**
 * The global CORS origin check. A phone on the tailnet opens
 * `http://<mac>.<tailnet>.ts.net:3141/control` and every POST it sends (sign-in first) carries
 * that Origin. The nudger learns the Mac's own Self.DNSName only on its own tick, and never when
 * COS_TAILSCALE_NUDGE=0, so a `*.ts.net` origin it does not recognise yet triggers one status
 * read (single-flight, cached 15 s) before the verdict. Any other unknown origin is refused
 * without a read. Never a suffix match: only this Mac's exact name passes.
 */
export async function isAllowedCorsOrigin(origin: string, dns: SelfDnsSource): Promise<boolean> {
  if (isAllowedNetworkOrigin(origin, { selfDnsName: dns.currentSelfDnsName() })) return true
  let host = ''
  try { host = new URL(origin).hostname.toLowerCase().replace(/\.$/, '') } catch { return false }
  if (!host.endsWith('.ts.net')) return false
  try { await dns.queryStatus() } catch { return false }
  return isAllowedNetworkOrigin(origin, { selfDnsName: dns.currentSelfDnsName() })
}

/**
 * Open COS on the web, from the COS Glasses app (phone-link). The companion reads
 * `capabilities.webPhoneLink` on /api/health and shows its row only when this is present,
 * so an older server simply omits it.
 */
export const WEB_PHONE_LINK_CAPABILITY = 1
export const WEB_PHONE_LINK_MAX_PER_WINDOW = 5
export const WEB_PHONE_LINK_WINDOW_MS = 60_000

/**
 * At most 5 phone links a minute for the whole server. One person holds the pairing token,
 * so a per-IP split would only let a leaked token mint faster from more addresses.
 */
export class WebPhoneLinkLimiter {
  private readonly stamps: number[] = []
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly max = WEB_PHONE_LINK_MAX_PER_WINDOW,
    private readonly windowMs = WEB_PHONE_LINK_WINDOW_MS,
  ) {}

  /** Seconds until the next link may be minted; 0 means it was admitted and counted now. */
  take(): number {
    const at = this.now()
    while (this.stamps.length && at - this.stamps[0] >= this.windowMs) this.stamps.shift()
    if (this.stamps.length >= this.max) {
      return Math.max(1, Math.ceil((this.stamps[0] + this.windowMs - at) / 1000))
    }
    this.stamps.push(at)
    return 0
  }
}

/**
 * Who may ask for a phone link: this Mac, a Tailscale peer, or a home-network address,
 * the same places the glasses' token already reaches. Never a request carrying proxy
 * forwarding headers (`tailscale serve`, Funnel, a local proxy), whose real caller is unknown.
 */
export function isPhoneLinkSocketAllowed(
  remoteAddress: string | undefined | null,
  headers?: Record<string, unknown> | null,
): boolean {
  if (hasProxyForwardedHeaders(headers)) return false
  const addr = normalizeRemoteIp(remoteAddress ?? '')
  if (!addr) return false
  return isLoopbackAddress(addr) || isAllowedNetworkIp(addr)
}

export function webControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_CONTROL_ENABLED, true)
}

/**
 * CSP for `/control/*`. No page has inline script, so every path gets `script-src 'self'`: an injected
 * `<img onerror>` in rendered session or meeting text cannot run. 6.99.25: Memories is a native pane
 * (panes/memories.js); the hosted page and its `/control/memories/*` 'unsafe-inline' exception are gone.
 * `frame-ancestors 'self'` stops another site framing the signed-in page.
 */
export function webControlCsp(_requestPath: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

/**
 * The expiry (ISO) of the cos_web_session cookie on a request, read from the SAME value the verifier reads (Q1 S1:
 * `parseCookies` keeps the last of several; another app on this host name can plant an earlier one). Read only after
 * verification. Shapes: `<exp>.<epoch>.<sig>`, or a renewed `<exp>.<epoch>.<orig>.<sig>`.
 */
export function webSessionCookieExpiry(cookieHeader: unknown): string | null {
  const value = webSessionCookieFrom(cookieHeader)
  const exp = typeof value === 'string' ? /^(\d{1,15})\./.exec(value) : null
  const ms = exp ? Number(exp[1]) * 1000 : NaN
  return Number.isSafeInteger(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

export function createWebControlRouter(deps: WebControlRouterDeps): Router {
  const router = Router()
  const handoffStore = deps.handoffStore ?? new WebHandoffStore()
  const loginLimiter = deps.loginLimiter ?? new WebLoginLimiter()
  const deviceCodes = deps.deviceCodeStore ?? new WebDeviceCodeStore()
  const smallJson = express.json({ limit: '64kb' })
  const log = deps.log ?? ((line: string) => console.log(line))
  const glassesBudget = deps.glassesProbeBudget ?? new WebGlassesCodeProbeBudget()
  const phoneLinkLimiter = deps.phoneLinkLimiter ?? new WebPhoneLinkLimiter()
  const isLiveGlassesCode = deps.glassesCodeIsLive
  const glassesCheck = isLiveGlassesCode
    ? (code: string): boolean => glassesBudget.check(deps.liveGlassesCodeKey ? deps.liveGlassesCodeKey() : 'live', () => isLiveGlassesCode(code))
    : undefined

  const allowedPorts = (): number[] => {
    const ports = [deps.port()]
    const pub = deps.publicPort?.()
    if (typeof pub === 'number' && pub > 0 && !ports.includes(pub)) ports.push(pub)
    const hp = deps.httpsPort?.()
    if (typeof hp === 'number' && hp > 0) ports.push(hp)
    return ports
  }

  const selfDns = (): string | null => {
    if (deps.selfDnsName) return normalizeTailscaleDnsName(deps.selfDnsName())
    return getTailscaleNudger().currentSelfDnsName()
  }

  /** This Mac's tailnet name (when known) and Tailscale IPv4, for links a phone opens. */
  async function tailnetAddress(): Promise<{ name: string | null; ip: string | null }> {
    let name = selfDns()
    if (!name && deps.queryTailscaleStatus) {
      const status = await deps.queryTailscaleStatus().catch(() => null)
      name = normalizeTailscaleDnsName(status?.selfDnsName ?? null)
    }
    let ip: string | null = null
    try {
      ip = deps.tailnetIpv4
        ? deps.tailnetIpv4()
        : reachableIpv4Addresses(networkInterfaces()).find(a => a.kind === 'tailscale')?.address ?? null
    } catch {
      ip = null
    }
    return { name, ip }
  }

  async function loopbackFetch(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: Record<string, any> }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 25_000)
    timer.unref?.()
    try {
      const res = await fetch(`http://127.0.0.1:${deps.port()}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'X-COS-Token': deps.apiToken(),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      })
      let parsed: any = {}
      try { parsed = await res.json() } catch { parsed = {} }
      if (Array.isArray(parsed)) return { status: res.status, body: { items: parsed } }
      return { status: res.status, body: parsed && typeof parsed === 'object' ? parsed : {} }
    } finally {
      clearTimeout(timer)
    }
  }

  router.get('/web-session/status', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const token = deps.apiToken()
    const cookieOk = isWebSessionAuthorized(req, token, {
      selfDnsName: selfDns(),
      allowedPorts: allowedPorts(),
    })
    const headerOk = timingSafeTokenEqual(req.headers['x-cos-token'], token)
    // Public door: an unauthenticated caller learns only that it is signed out, never the
    // Mac's name or its owner's. `network: 'tailscale_only'` tells the sign-in page why a
    // home-Wi-Fi browser cannot sign in (review W2), so it can say "use Tailscale".
    if (!cookieOk && !headerOk) {
      return res.json(isWebControlSocketAllowed(req.socket?.remoteAddress, process.env, req.headers)
        ? { authenticated: false, mode: 'none' }
        : { authenticated: false, mode: 'none', network: 'tailscale_only' })
    }
    // W1 (audit 02 F2): a signed-in browser learns when ITS OWN cookie ends, so the page can say so before it does.
    // Only after the cookie verified (its signature covers the expiry), only for cookie mode, and nothing a caller without
    // that cookie can read. The 7-day lifetime itself is unchanged.
    const expiresAt = cookieOk && !headerOk ? webSessionCookieExpiry(req.headers.cookie) : null
    // Renewal (Miles 2026-11-09): the latest this sign-in can last while in use, 30 days from its first sign-in.
    const read = cookieOk && !headerOk ? readWebSessionCookie(webSessionCookieFrom(req.headers.cookie), token) : null
    const renewUntil = read ? new Date((read.origUnixSec + Math.floor(WEB_SESSION_MAX_LIFE_MS / 1000)) * 1000).toISOString() : null
    res.json({
      authenticated: true,
      mode: headerOk ? 'header' : 'cookie',
      serverName: hostname().replace(/\.local$/i, ''),
      ownerName: getOwnerName(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(renewUntil ? { renewUntil } : {}),
    })
  })

  router.post('/web-session/login', smallJson, (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    if (!isWebControlSocketAllowed(req.socket?.remoteAddress, process.env, req.headers)) {
      return res.status(403).json({
        ok: false,
        error: 'tailscale_only',
        message: 'Open COS Control Web over Tailscale. Home Wi-Fi is off unless COS_WEB_CONTROL_LAN=1 is set on the Mac.',
      })
    }
    const ip = normalizeRemoteIp(req.socket?.remoteAddress ?? '')
    const retryAfterS = loginLimiter.blockedFor(ip)
    if (retryAfterS > 0) {
      const last = loginLimiter.lastFailure(ip)
      res.setHeader('Retry-After', String(retryAfterS))
      return res.status(429).json({
        ok: false,
        error: 'too_many_attempts',
        ...(last ? { reason: last } : {}),
        message: webLoginLockoutMessage(retryAfterS, last),
      })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { token?: unknown; handoff?: unknown; code?: unknown }
      : {}
    const token = deps.apiToken()
    const result = classifyWebLogin(body, token, handoffStore, deviceCodes, glassesCheck)
    if (!result.ok) {
      // Every failure counts toward the per-IP limit, the glasses-code one included, so that check cannot be used to
      // probe codes faster than the limiter allows. Except a failed sign-in LINK (Miles 2026-11-09 20:00, "Yes, stop
      // counting stale links"): a ticket is 192 random bits, so guessing one is not a risk, and a person reopening an old
      // QR or link should not lock themselves out of typing a code. It still fails with the same message.
      if (result.reason !== 'handoff_expired') loginLimiter.fail(ip, result.reason)
      // S1 item 7: why a handoff link failed (expired, used, evicted, unknown). The log only; the message is unchanged.
      log(`[web-login] fail kind=${result.reason}${result.handoff ? ` sub=${result.handoff}` : ''} len=${result.length} ip=${ip}`)
      return res.status(401).json({
        ok: false,
        error: 'invalid_credentials',
        reason: result.reason,
        message: WEB_LOGIN_FAILURE_MESSAGE[result.reason],
      })
    }
    log(`[web-login] ok kind=${result.kind} ip=${ip}`)
    loginLimiter.succeed(ip)
    const minted = mintWebSessionCookieValue(token, Date.now(), WEB_SESSION_TTL_MS)
    res.setHeader('Set-Cookie', formatSetWebSessionCookie(minted.value, WEB_SESSION_TTL_MS / 1000, req.secure))
    return res.json({
      ok: true,
      expiresAt: new Date(minted.expiresAtMs).toISOString(),
      // Renewal (Miles 2026-11-09): while in use this sign-in renews up to 30 days from now (lib/web-session-auth.ts).
      renewUntil: new Date((Math.floor(minted.expiresAtMs / 1000) - Math.floor(WEB_SESSION_TTL_MS / 1000) + Math.floor(WEB_SESSION_MAX_LIFE_MS / 1000)) * 1000).toISOString(),
      serverName: hostname().replace(/\.local$/i, ''),
      ownerName: getOwnerName(),
    })
  })

  router.post('/web-session/logout', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    res.setHeader('Set-Cookie', formatClearWebSessionCookie(req.secure))
    res.json({ ok: true })
  })

  // Sign out every browser at once (review W1): bumps the session epoch, so every cookie ever
  // issued stops working, copies included. The pairing token, the glasses and the phone app
  // are untouched. Behind the gate, so a cookie caller also needs X-COS-Web and its own Origin.
  router.post('/web-session/revoke-all', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const epoch = bumpWebSessionEpoch()
    // Final review V7: a sign-in link or code made before the sign-out no longer signs a browser in after it.
    handoffStore.revokeAll()
    deviceCodes.revokeAll()
    res.setHeader('Set-Cookie', formatClearWebSessionCookie(req.secure))
    res.json({ ok: true, epoch })
  })

  // A signed-in browser (or the Mac app) asks for a short code to type on another device.
  // Behind the gate: a cookie caller also needs X-COS-Web and its own Origin (CSRF).
  router.post('/web-session/device-code', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const minted = deviceCodes.mint()
    res.json({ ok: true, code: minted.display, expiresAt: minted.expiresAt })
  })

  // COS Control mints a ticket here and shows `phoneUrl` as a QR: the phone camera opens Safari
  // on the tailnet address and the page signs in with the ticket (one use, 2 minutes). The
  // cookie belongs to the origin, so Control shows exactly one URL, the name when this Mac
  // knows it. `url` stays the loopback link the Mac's own browser opens.
  router.post('/web-session/handoff', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    if (!isLoopbackSocket(req)) {
      return res.status(403).json({ error: 'not_loopback', message: 'Web handoff tickets are minted only on this Mac.' })
    }
    const pubPort = deps.publicPort?.() ?? deps.port()
    const { name, ip } = await tailnetAddress()
    const { ticket, expiresAt } = handoffStore.mint()
    const controlPath = `/control?handoff=${encodeURIComponent(ticket)}`
    const nameUrl = name ? `http://${name}:${pubPort}${controlPath}` : null
    const ipUrl = ip ? `http://${ip}:${pubPort}${controlPath}` : null
    return res.json({
      ok: true,
      ticket,
      expiresAt,
      url: `http://127.0.0.1:${pubPort}${controlPath}`,
      phoneUrl: nameUrl ?? ipUrl,
      tailnet: { ipUrl, nameUrl },
    })
  })

  // Open COS on the web, from the COS Glasses app. The phone asks with its pairing token,
  // copies `url` and pastes it into Safari: the link signs in once, within 2 minutes, and the
  // page drops the ticket from the address bar (web-control/app.js boot). `code` is the
  // fallback when the clipboard refuses: typed at `codeAddress`, once, within 5 minutes.
  // The Even app keeps every link inside its own WebView, which is why this copies a link
  // rather than opening one. Never logs the ticket, the link or the code.
  router.post('/web-session/phone-link', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    // Only the glasses' header token. A browser signed in with the cookie already has COS
    // on the web, and must not be able to mint links that sign other browsers in.
    if (!timingSafeTokenEqual(req.headers['x-cos-token'], deps.apiToken())) {
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
        reason: 'pairing_token_required',
        message: 'Only the paired COS Glasses app can ask for a web link.',
      })
    }
    if (!isPhoneLinkSocketAllowed(req.socket?.remoteAddress, req.headers)) {
      return res.status(403).json({
        ok: false,
        error: 'network_refused',
        message: 'Ask for a web link from this Mac, over Tailscale or on your home network.',
      })
    }
    const ip = normalizeRemoteIp(req.socket?.remoteAddress ?? '')
    const retryAfterS = phoneLinkLimiter.take()
    if (retryAfterS > 0) {
      res.setHeader('Retry-After', String(retryAfterS))
      log(`[web-phone-link] refused kind=rate_limited ip=${ip}`)
      return res.status(429).json({
        ok: false,
        error: 'too_many_links',
        retryAfterS,
        message: `That is 5 links in a minute. Try again in ${retryAfterS} s.`,
      })
    }
    const pubPort = deps.publicPort?.() ?? deps.port()
    const { name, ip: tailIp } = await tailnetAddress()
    const host = name ?? tailIp
    if (!host) {
      log(`[web-phone-link] refused kind=no_tailnet ip=${ip}`)
      return res.status(503).json({
        ok: false,
        error: 'no_tailnet_address',
        message: 'Your Mac has no Tailscale address right now. Turn Tailscale on, on the Mac.',
      })
    }
    const { ticket, expiresAt } = handoffStore.mint()
    const code = deviceCodes.mint()
    const base = `http://${host}:${pubPort}/control`
    log(`[web-phone-link] minted via=${name ? 'name' : 'ip'} ip=${ip}`)
    return res.json({
      ok: true,
      url: `${base}?handoff=${encodeURIComponent(ticket)}`,
      expiresAt,
      code: code.display,
      codeAddress: base,
      codeExpiresAt: code.expiresAt,
    })
  })

  router.get('/tailscale/web-url', async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const queryFn = deps.queryTailscaleStatus ?? (() => getTailscaleNudger().queryStatus())
    const status = await queryFn().catch(() => null)
    const dns = normalizeTailscaleDnsName(status?.selfDnsName ?? selfDns())
    const addrs = reachableIpv4Addresses(networkInterfaces())
    const tailscaleIp = status?.selfIps?.[0] ?? addrs.find(a => a.kind === 'tailscale')?.address ?? null
    const lanIp = addrs.find(a => a.kind === 'lan')?.address ?? null
    const port = deps.publicPort?.() ?? deps.port()
    const httpsPort = deps.httpsPort?.() ?? null
    const nodeName = dns ? dns.split('.')[0] : hostname().replace(/\.local$/i, '')

    res.json({
      available: !!(dns || tailscaleIp),
      backendState: status?.backendState ?? (tailscaleIp ? 'Running' : 'Unknown'),
      nodeName,
      selfDnsName: dns,
      tailscaleIpv4: tailscaleIp,
      lanIpv4: lanIp,
      port,
      httpsPort,
      magicDnsUrl: dns ? `http://${dns}:${port}/control` : null,
      magicDnsHttpsUrl: dns && httpsPort ? `https://${dns}:${httpsPort}/control` : null,
      ipv4Url: tailscaleIp ? `http://${tailscaleIp}:${port}/control` : null,
      loopbackUrl: `http://127.0.0.1:${port}/control`,
    })
  })

  // Bridge 1: Memories & Knowledge Graph Web Bridge (POST /web-bridge/memories)
  const handleMemoriesBridge = async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { op?: unknown; args?: unknown }
      : {}
    const op = typeof body.op === 'string' ? body.op.trim() : ''
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? body.args as Record<string, unknown>
      : {}
    if (!op) return res.status(400).json({ ok: false, message: 'Missing op.', details: {} })

    const readOnly = isMemoryWebOpReadOnly(op, args)
    let lease: ReturnType<typeof acquireMaintenanceWork> | null = null
    if (!readOnly && op !== 'memory.guardrails.run') {
      if (!MUTATING_MEMORY_WEB_OPS.has(op) && op !== 'workspace.request') {
        return res.status(400).json({ ok: false, message: `This page cannot ask for ${op}.`, details: {} })
      }
      try {
        lease = acquireMaintenanceWork('api_mutation')
      } catch (error) {
        if (error instanceof MaintenanceLifecycleError) {
          return res.status(error.status).json({ ok: false, message: maintenanceErrorPayload(error).message || 'Server is updating.', details: {} })
        }
        return res.status(503).json({ ok: false, message: 'Server unavailable.', details: {} })
      }
    }
    try {
      const out = await dispatchMemoriesWebOp(op, args, loopbackFetch, deps.serverVersion?.() ?? managedServerVersion() ?? undefined)
      res.json(out)
    } catch (error) {
      res.json({ ok: false, message: error instanceof Error ? error.message : 'Bridge request failed', details: {} })
    } finally {
      lease?.release()
    }
  }
  router.post('/web-bridge/memories', handleMemoriesBridge)

  // Bridge 2: Live Meeting Transcript Chunks (`active-sessions/<id>.json`)
  router.get('/meetings/live-chunks', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const baseDir = deps.baseDataDir?.()
    const sessions = listLiveTranscriptSessions(baseDir)
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : ''
    if (!sessionId) {
      return res.json({ sessions })
    }
    const sinceRaw = typeof req.query.since === 'string' ? Number.parseInt(req.query.since, 10) : -1
    const since = Number.isInteger(sinceRaw) ? sinceRaw : -1
    const knownStamp = typeof req.query.stamp === 'string' && req.query.stamp ? req.query.stamp : null
    const revRaw = typeof req.query.speakerRevision === 'string' ? Number.parseInt(req.query.speakerRevision, 10) : null
    const knownSpeakerRevision = revRaw !== null && Number.isInteger(revRaw) && revRaw >= 0 ? revRaw : null
    try {
      const read = readLiveTranscriptSession({
        baseDataDir: baseDir,
        sessionId,
        since,
        knownStamp,
        knownSpeakerRevision,
      })
      return res.json({ sessions, read })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unreadable'
      const status = reason.startsWith('invalid_') ? 400 : 503
      return res.status(status).json({ error: 'live_transcript_unavailable', reason })
    }
  })

  // Bridge 3: Usage & COS Cost Summary (`/api/usage/summary`, `/api/usage/sessions`, `/api/usage/cos-cost`)
  router.get(['/usage/summary', '/usage/sessions', '/usage/cos-cost'], async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const summary = await getWebUsageSummary({ forceRefresh })
    res.json(summary)
  })

  // The session pet on Home (lib/web-pet.ts) and the pet picker (lib/web-pet-choice.ts). `?pet=` is the browser's
  // choice: mac (default), shipped:<id> or gallery:<id>. Everything here reads COS Control's files; nothing writes them.
  const petDir = (): string => deps.petSupportDir?.() ?? controlSupportDir()
  const petResources = (): string | null => (deps.petResourcesDir ? deps.petResourcesDir() : controlResourcesDir())
  const petCacheRoot = (): string => deps.petCacheDir?.() ?? dataPath('web-pet')
  const petCacheFor = (name: string): string => (name ? path.join(petCacheRoot(), name) : petCacheRoot())
  const petChoiceOf = (req: Request): PetChoice | null => parsePetChoice(req.query.pet ?? 'mac')
  const resolveFor = (choice: PetChoice) => resolvePet(choice, { supportDir: petDir(), resources: petResources() })
  const sendImage = async (res: Response, file: string, type: string, immutable: boolean): Promise<void> => {
    res.set('Cache-Control', immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    // Not sendFile: it refuses any path with a dot folder, and the cache lives under ~/.cos-glasses.
    res.type(type).send(await fs.promises.readFile(file))
  }
  const fileTag = (file: string): string => { try { const st = fs.statSync(file); return `${st.size}-${Math.round(st.mtimeMs)}` } catch { return '0' } }

  router.get('/web-pet', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const choice = petChoiceOf(req)
    if (!choice) return res.status(400).json({ error: 'pet_choice_invalid' })
    const key = petChoiceKey(choice)
    const found = resolveFor(choice)
    if (!found) return res.json({ available: false, pet: key, poses: {} })
    if (found.kind === 'strips') return res.json({ ...webPetManifest(found.dir, key), pet: key, kind: 'strips' })
    const tag = found.kind === 'still' ? fileTag(found.file) : found.preview
    return res.json({ available: true, pet: key, kind: 'still', poses: {}, still: `/api/web-pet/still?pet=${encodeURIComponent(key)}&v=${encodeURIComponent(crypto.createHash('sha256').update(tag).digest('hex').slice(0, 16))}` })
  })

  router.get('/web-pet/sheet/:pose/:chunk', async (req: Request, res: Response) => {
    const choice = petChoiceOf(req)
    const found = choice ? resolveFor(choice) : null
    if (!found || found.kind !== 'strips') return res.status(404).json({ error: 'pet_unavailable' })
    const pose = String(req.params.pose) as WebPetPose
    const src = (WEB_PET_POSES as readonly string[]).includes(pose) ? readPetSources(found.dir)[pose] : undefined
    if (!src) return res.status(404).json({ error: 'pet_pose_unavailable' })
    const plan = planPose(src)
    const index = Number(req.params.chunk)
    if (!Number.isInteger(index) || index < 0 || index >= plan.chunks) return res.status(404).json({ error: 'pet_chunk_unavailable' })
    try {
      const file = await petChunk(plan, index, { cacheDir: petCacheFor(found.cacheName), run: deps.petRun })
      await sendImage(res, file, 'png', req.query.v === plan.key)
    } catch (err) {
      log(`[web-pet] could not build ${pose} chunk ${index}: ${err instanceof Error ? err.message : String(err)}`)
      res.status(503).json({ error: 'pet_build_failed' })
    }
  })

  // A still pet: COS Control's single sprite, Cloud Puff, or a gallery picture (downloaded once, as the Mac does).
  router.get('/web-pet/still', async (req: Request, res: Response) => {
    const choice = petChoiceOf(req)
    const found = choice ? resolveFor(choice) : null
    if (!found || found.kind === 'strips') return res.status(404).json({ error: 'pet_unavailable' })
    try {
      const art = found.kind === 'still' ? found : await galleryThumb(found, petCacheFor('gallery'), deps.petFetch, petDir())
      await sendImage(res, art.file, art.type, typeof req.query.v === 'string' && req.query.v.length > 0)
    } catch (err) {
      log(`[web-pet] gallery picture failed for ${found.kind === 'gallery' ? found.id : 'still'}: ${err instanceof Error ? err.message : String(err)}`)
      res.status(502).json({ error: 'pet_picture_unavailable' })
    }
  })

  // The picker's small picture: an animated pet's first frame, or the still itself.
  router.get('/web-pet/preview', async (req: Request, res: Response) => {
    const choice = petChoiceOf(req)
    const found = choice ? resolveFor(choice) : null
    if (!found) return res.status(404).json({ error: 'pet_unavailable' })
    try {
      if (found.kind === 'strips') return await sendImage(res, await petPreview(found.dir, petCacheFor(found.cacheName || 'mac-preview'), { run: deps.petRun }), 'png', typeof req.query.v === 'string')
      const art = found.kind === 'still' ? found : await galleryThumb(found, petCacheFor('gallery'), deps.petFetch, petDir())
      await sendImage(res, art.file, art.type, typeof req.query.v === 'string')
    } catch (err) {
      log(`[web-pet] preview failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(502).json({ error: 'pet_picture_unavailable' })
    }
  })

  // What the picker lists: the Mac's pet, the characters COS Control ships, and its OpenPets gallery.
  router.get('/web-pet/catalog', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const preview = (key: string, tag: string) => `/api/web-pet/preview?pet=${encodeURIComponent(key)}&v=${encodeURIComponent(crypto.createHash('sha256').update(tag).digest('hex').slice(0, 16))}`
    const mac = resolveFor({ kind: 'mac' })
    const macTag = mac ? (mac.kind === 'still' ? fileTag(mac.file) : fileTag(path.join(petDir(), 'session-pet-states.json'))) : ''
    res.json({
      mac: { available: !!mac, preview: mac ? preview('mac', 'mac:' + macTag) : null },
      // The tag follows the art on disk, so a COS Control update with new art gets a new preview URL.
      shipped: shippedPets(petResources()).map((p) => {
        const r = resolveFor({ kind: 'shipped', id: p.id })
        const tag = r?.kind === 'strips' ? fileTag(path.join(r.dir, 'session-pet-states.json')) : r?.kind === 'still' ? fileTag(r.file) : ''
        return { ...p, pet: `shipped:${p.id}`, preview: preview(`shipped:${p.id}`, `shipped:${p.id}:${tag}`) }
      }),
      gallery: galleryPets(petDir()).map((p) => ({ id: p.id, name: p.name, description: p.description, category: p.category, pet: `gallery:${p.id}`, preview: preview(`gallery:${p.id}`, p.preview) })),
    })
  })

  // Today / Work "Your Move" compatibility route
  router.get('/work-board/your-move', async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const open = await loopbackFetch('/api/work-board/activity/open', { timeoutMs: 8_000 }).catch(() => null)
    if (!open || open.status !== 200) {
      return res.json({ available: false, total: 0, items: [] })
    }
    const rawItems = Array.isArray(open.body.items) ? open.body.items : []
    return res.json({
      available: open.body.available !== false,
      total: typeof open.body.total === 'number' ? open.body.total : rawItems.length,
      items: rawItems,
    })
  })

  return router
}
