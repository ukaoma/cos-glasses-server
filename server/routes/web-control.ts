import express, { Router, type Request, type Response } from 'express'
import { hostname, networkInterfaces } from 'node:os'
import { isAllowedNetworkOrigin, isLoopbackSocket, normalizeRemoteIp, normalizeTailscaleDnsName, reachableIpv4Addresses } from '../lib/network-policy.js'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { getTailscaleNudger } from '../lib/tailscale-nudge.js'
import {
  formatClearWebSessionCookie,
  formatSetWebSessionCookie,
  isWebSessionAuthorized,
  mintWebSessionCookieValue,
  verifyLoginTokenOrHandoff,
  WEB_SESSION_TTL_MS,
  WebHandoffStore,
  WebLoginLimiter,
  WebDeviceCodeStore,
} from '../lib/web-session-auth.js'
import { acquireMaintenanceWork, MaintenanceLifecycleError, maintenanceErrorPayload } from '../lib/maintenance-lifecycle.js'
import { getOwnerName } from '../lib/profile.js'
import { readSwitch } from '../lib/env-switch.js'
import {
  dispatchMemoriesWebOp,
  isMemoryWebOpReadOnly,
  MUTATING_MEMORY_WEB_OPS,
  READ_ONLY_MEMORY_WEB_OPS,
} from '../lib/web-memories-bridge.js'
import { listLiveTranscriptSessions, readLiveTranscriptSession } from '../lib/web-live-chunks.js'
import { getWebUsageSummary } from '../lib/web-usage-bridge.js'

export { isMemoryWebOpReadOnly, MUTATING_MEMORY_WEB_OPS, READ_ONLY_MEMORY_WEB_OPS }

export interface WebControlRouterDeps {
  apiToken: () => string
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

export function webControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_CONTROL_ENABLED, true)
}

/**
 * CSP for `/control/*`. The shell (index.html, app.js, theme.js) has no inline script, so it
 * gets `script-src 'self'`: an injected `<img onerror>` in rendered session or meeting text
 * cannot run. The hosted Memories page is the native bundle as shipped and still uses inline
 * `onclick` handlers, so only `/control/memories/*` keeps `'unsafe-inline'`.
 * `frame-ancestors 'self'` stops another site framing the signed-in page.
 */
export function webControlCsp(requestPath: string): string {
  const inlineScripts = requestPath.startsWith('/memories/')
  return [
    "default-src 'self'",
    inlineScripts ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
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

export function createWebControlRouter(deps: WebControlRouterDeps): Router {
  const router = Router()
  const handoffStore = deps.handoffStore ?? new WebHandoffStore()
  const loginLimiter = deps.loginLimiter ?? new WebLoginLimiter()
  const deviceCodes = deps.deviceCodeStore ?? new WebDeviceCodeStore()
  const smallJson = express.json({ limit: '64kb' })

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
    // Mac's name or its owner's.
    if (!cookieOk && !headerOk) return res.json({ authenticated: false, mode: 'none' })
    res.json({
      authenticated: true,
      mode: headerOk ? 'header' : 'cookie',
      serverName: hostname().replace(/\.local$/i, ''),
      ownerName: getOwnerName(),
    })
  })

  router.post('/web-session/login', smallJson, (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const ip = normalizeRemoteIp(req.socket?.remoteAddress ?? '')
    const retryAfterS = loginLimiter.blockedFor(ip)
    if (retryAfterS > 0) {
      res.setHeader('Retry-After', String(retryAfterS))
      return res.status(429).json({
        ok: false,
        error: 'too_many_attempts',
        message: `Too many wrong tokens from this device. Try again in ${Math.ceil(retryAfterS / 60)} min.`,
      })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as { token?: unknown; handoff?: unknown; code?: unknown }
      : {}
    const token = deps.apiToken()
    if (!verifyLoginTokenOrHandoff(body, token, handoffStore, deviceCodes)) {
      loginLimiter.fail(ip)
      return res.status(401).json({
        ok: false,
        error: 'invalid_credentials',
        message: 'That code or token did not match, or it has expired.',
      })
    }
    loginLimiter.succeed(ip)
    const minted = mintWebSessionCookieValue(token, Date.now(), WEB_SESSION_TTL_MS)
    res.setHeader('Set-Cookie', formatSetWebSessionCookie(minted.value, WEB_SESSION_TTL_MS / 1000, req.secure))
    return res.json({
      ok: true,
      expiresAt: new Date(minted.expiresAtMs).toISOString(),
      serverName: hostname().replace(/\.local$/i, ''),
      ownerName: getOwnerName(),
    })
  })

  router.post('/web-session/logout', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    res.setHeader('Set-Cookie', formatClearWebSessionCookie(req.secure))
    res.json({ ok: true })
  })

  // A signed-in browser (or the Mac app) asks for a short code to type on another device.
  // Behind the gate: a cookie caller also needs X-COS-Web and its own Origin (CSRF).
  router.post('/web-session/device-code', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const minted = deviceCodes.mint()
    res.json({ ok: true, code: minted.display, expiresAt: minted.expiresAt })
  })

  router.post('/web-session/handoff', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    if (!isLoopbackSocket(req)) {
      return res.status(403).json({ error: 'not_loopback', message: 'Web handoff tickets are minted only on this Mac.' })
    }
    const pubPort = deps.publicPort?.() ?? deps.port()
    const { ticket, expiresAt } = handoffStore.mint()
    return res.json({
      ok: true,
      ticket,
      expiresAt,
      url: `http://127.0.0.1:${pubPort}/control?handoff=${encodeURIComponent(ticket)}`,
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
      const out = await dispatchMemoriesWebOp(op, args, loopbackFetch, deps.serverVersion?.())
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
