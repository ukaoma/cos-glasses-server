// 6.71.7: new-hook stamped interactive questions also arrive while the desk is
// active. The broker keeps their lens card hidden until the desk is idle and
// then latches it. Native desk answers/cancels settle the same request. Legacy
// hooks and approvals keep the gates below. GET polling is 3 s while pending.
//
// The permission broker's two doors (6.52.0). See `lib/permission-broker.ts` for the why.
//
// POST /api/permission-requests/ask -- the COS session hook, on a PermissionRequest at a
// desk idle for 90 s. THIS IS THE URL THE 6.51.0 SCRIPT ALREADY CALLS, so no Mac needs
// `--hooks install` again (QA round 1: a new URL meant a new script, and every Mac that did
// not reinstall would have shown Control's "hooks outdated" banner and kept the old door).
// The hook holds the per-install HOOK token (`~/.cos-glasses/hook-token`, 0600), never the
// pairing token the /api gate checks, so this one route is registered BEFORE that gate and
// before the global body parser, as a deliberate exemption for exactly this method and
// path: it checks the hook token itself, in constant time, BEFORE it reads a byte of the
// body, and only then parses up to 2 MB. Any other method on the path falls through to the
// /api gate like every other /api route. It answers only `{}` or a
// `{"hookSpecificOutput": ...}` the hook prints verbatim, and is mounted unconditionally
// (not behind COS_THREAD_ATTACH_ENABLED): the switch is `COS_PERMISSION_BROKER`, read per
// request. It holds no maintenance lease; the broker refuses to park during a drain itself.
//
// Mixed versions fail safe. Against a 6.51 server the same script gets 401 from the /api
// gate, prints nothing, and the native dialog shows, as it always did there.
//
// GET /api/session-questions and POST /api/session-questions/:id/answer -- the lens and the
// phone, behind the API token like every other /api route. Question and command text only
// ever travels here, never on the display bus. The GET is ALSO the broker's liveness
// signal (lib/client-liveness.ts), and only when it names the client: `?client=glasses` or
// `?client=phone`. Anything else (missing, `control`, a typo) is answered but never counts,
// so a surface that only shows a count can poll without making the Mac hold questions it
// cannot answer. It checks X-Cos-Token itself as well, in constant time, and a request
// without it is refused and never counted, whatever sits in front of this router.
// 6.99.12: COS Control Web reads the same list with its signed browser session (the
// `cos_web_session` cookie, verified by `webSessionAuthorized`, the check the /api gate runs).
// The hook token still opens nothing here. A browser poll counts as a live answering client
// only with `?client=web`, which the page sends only while it shows the cards (a visible tab);
// the same 30 s window as the phone. A cookie poll naming `glasses` or `phone`, or no client,
// never counts, and a token poll naming `web` never counts either.
// 6.99.26 (Miles 11/07, "Away rule, like phone"): a browser poll `?client=web&hold=1&presenceAgeMs=<int>`
// (the ms since a touch or a key while the page was in front) records COS Control Web's presence for the
// away hold ONLY (lib/client-liveness noteWebPresence): never a live client, so at the desk the Mac's own
// pop-up still comes at once (6.99.13). Without `hold=1` or a valid `presenceAgeMs` it records nothing. A
// token poll naming `web`, and a browser poll naming anything else, still record nothing. QA round 1: neither
// does a poll from the Mac itself (loopback, or one of its own addresses, with no proxy header): Control Web
// open on the Mac is the desk, never away.
// 6.60.0: a poll with `&hold=1&presenceAgeMs=<int>` (COS Glasses 6.9.563 and later) records
// wearer presence for the away hold instead of the 6.59.0 liveness; a `hold=1` poll without
// a valid `presenceAgeMs` makes no client live and enables no hold. The response adds
// `awayHoldMs`, `awayRecentClientMs`, `settled`, `waitingAtMac` and `serverStartedAt`.

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import {
  ANSWERING_CLIENTS,
  CLIENT_LIVE_WINDOW_MS,
  WEB_ANSWERING_CLIENT,
  SESSION_QUESTIONS_PROTOCOL_VERSION,
  type BrokerAdmission,
  type HookReplyChannel,
  type PermissionBroker,
} from '../lib/permission-broker.js'
import { noteQuestionsPoll, noteWebPresence, validPresenceAgeMs, type QuestionsPollFacts } from '../lib/client-liveness.js'
import { hasProxyForwardedHeaders, isLoopbackAddress, isTailscaleIpv4, isTailscaleIpv6, normalizeRemoteIp, reachableIpv4Addresses } from '../lib/network-policy.js'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'

export const PERMISSION_BROKER_HOOK_PATH = '/api/permission-requests/ask'
/** The hook posts its spool envelope, capped at 1 MiB by the script itself. */
export const PERMISSION_BROKER_BODY_LIMIT = '2mb'

export interface PermissionBrokerHookRouterDeps {
  /** The per-install hook token, or null when none has been minted (then nothing is answered). */
  hookToken: () => string | null
  broker: PermissionBroker
}

/**
 * The hook-token check, as middleware that runs BEFORE any body parser: a request without
 * the token is answered 401 without a byte of its body being read or parsed.
 */
export function requireHookToken(hookToken: () => string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.set('Cache-Control', 'private, no-store')
    let expected: string | null = null
    try { expected = hookToken() } catch { expected = null }
    if (!expected || !timingSafeTokenEqual(req.headers['x-cos-hook-token'], expected)) {
      res.status(401).json({})
      return
    }
    next()
  }
}

/** The held response, as the broker sees it. */
export function replyChannelFor(res: Response): HookReplyChannel {
  const writable = (): boolean => {
    if (res.headersSent || res.writableEnded || res.destroyed) return false
    const socket = res.socket
    return !!socket && !socket.destroyed && socket.writable !== false
  }
  return {
    writable,
    reply(body) {
      if (!writable()) return false
      try {
        res.status(200).json(body)
        return true
      } catch {
        return false
      }
    },
  }
}

export function createPermissionBrokerHookRouter(deps: PermissionBrokerHookRouterDeps): Router {
  const router = Router()
  router.post(
    PERMISSION_BROKER_HOOK_PATH,
    requireHookToken(deps.hookToken),
    express.json({ limit: PERMISSION_BROKER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      let admission: BrokerAdmission
      try {
        admission = await deps.broker.admit(req.body)
      } catch (error) {
        console.error(`[permission-broker] admit failed: ${error instanceof Error ? error.message : error}`)
        res.json({})
        return
      }
      if (!admission.ok) {
        res.json({})
        return
      }
      const channel = replyChannelFor(res)
      // The hook gave up during the desk read: nothing to hold.
      if (!channel.writable()) {
        deps.broker.noteFastPath('hook_gone_early')
        return
      }
      const id = deps.broker.park(admission.request, channel)
      // `res` close, not `req` close: since Node 16 the request emits `close` once its body
      // is read, which is not the hook leaving. A close after the reply is a no-op.
      res.on('close', () => { deps.broker.hookClosed(id) })
    },
  )
  // A body the parser refused (too large, not JSON): `{}` and nothing else, never a stack.
  router.use(PERMISSION_BROKER_HOOK_PATH, (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return }
    deps.broker.noteFastPath('malformed')
    const status = Number((error as { status?: unknown })?.status)
    res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 400).json({})
  })
  return router
}

export interface SessionQuestionsRouterDeps {
  broker: PermissionBroker
  /** The pairing token (X-Cos-Token). A poll counts as a live client only with it, or with the web session below. */
  apiToken: () => string
  /**
   * 6.99.12: whether this request carries a valid COS Control Web session (the cookie, its epoch, and the origin
   * rules: `isWebSessionAuthorized` in production). Absent: only the token opens the list, as before.
   */
  webSessionAuthorized?: (req: Request) => boolean
  /** Where a counted poll is recorded; `noteQuestionsPoll` in production. */
  notePoll?: (at: number, poll: QuestionsPollFacts) => void
  /** 6.99.26: where COS Control Web's presence is recorded; `noteWebPresence` in production. */
  noteWebPresence?: (at: number, presenceAgeMs: number) => void
  /** 6.99.26 (QA round 1): whether a request comes from this Mac itself; `requestFromThisMac` in production. */
  fromThisMac?: (req: Request) => boolean
  now?: () => number
  /** 6.60.0: when this server process started (ISO); defaults to the process's own start. */
  serverStartedAt?: string
}

/** 6.60.0: this process's start, so a client can tell a restart from "nothing waiting". */
export const SERVER_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()

/**
 * 6.60.0, the contract shared with COS Glasses 6.9.563: `hold=1` (this client shows held
 * questions) and `presenceAgeMs`, a whole number of ms within [0, 24 h] since the latest real
 * wearer evidence. Anything else is no presence: the poll then counts only as a 6.59.0 poll
 * (without `hold=1`) or as a `hold=1` poll with no presence.
 */
export function questionsPollFacts(query: Record<string, unknown>): QuestionsPollFacts {
  const hold = query.hold === '1'
  const raw = typeof query.presenceAgeMs === 'string' ? query.presenceAgeMs : ''
  const parsed = /^\d{1,8}$/.test(raw) ? Number(raw) : Number.NaN
  return { hold, presenceAgeMs: hold && validPresenceAgeMs(parsed) ? parsed : null }
}

/**
 * The Mac's own addresses: every external IPv4 (its tailnet address first) and its Tailscale IPv6 (fd7a:115c:a1e0::/48).
 * Safari on the Mac often reaches its own MagicDNS name over IPv6, so the IPv6 tailnet address is the Mac too.
 */
export function selfAddressesFromInterfaces(
  nets: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out = reachableIpv4Addresses(nets).map(a => a.address)
  for (const infos of Object.values(nets)) {
    for (const info of infos ?? []) {
      // Node 18.0-18.3 reported the family as a number.
      const v6 = String(info.family) === 'IPv6' || String(info.family) === '6'
      if (v6 && isTailscaleIpv6(info.address)) out.push(info.address.toLowerCase())
    }
  }
  return out
}

/** Headers `tailscale serve` adds to a hop it forwards (ipn/ipnlocal/serve.go). Anything else proxy-shaped is not Serve. */
const SERVE_HOP_HEADERS = new Set([
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-headers-info',
])

/**
 * W12 (QA week of 11/01-11/08): a `tailscale serve` hop from the Mac to itself. Control Web opened at the Mac's own
 * https://<mac>.ts.net is the desk, but Serve forwards it over loopback with proxy headers, so 6.99.26 stored its touch
 * as away and a web-only hold waited up to 10 minutes. It is the Mac only when ALL of these hold:
 *   - the socket is loopback: the local Serve proxy connected (a peer reaching 3141 directly has its own address);
 *   - no `Forwarded` or `X-Real-IP` (Serve never sets either);
 *   - exactly one `X-Forwarded-For` address, no list. Serve SETS that header to the hop's real source (Header.Set, and
 *     Go's ReverseProxy drops the incoming X-Forwarded-* before its Rewrite runs), so a remote device's spoofed value
 *     never survives; a proxy that appended instead would make a list, which is refused;
 *   - that address is loopback or one of the Mac's own TAILSCALE addresses (Serve listens on the tailnet only).
 */
export function serveHopFromThisMac(
  req: { socket?: { remoteAddress?: string | undefined } | null; headers?: Record<string, unknown> | null },
  selfAddresses: () => readonly string[],
): boolean {
  const headers = req.headers
  if (!headers || typeof headers !== 'object') return false
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  for (const name of ['forwarded', 'x-real-ip']) {
    const v = headers[name]
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return false
  }
  // Only Serve's own headers: an unknown proxy-shaped header means a hop this check does not understand.
  for (const name of Object.keys(headers)) {
    if (/^(x-forwarded-|tailscale-)/i.test(name) && !SERVE_HOP_HEADERS.has(name.toLowerCase())) return false
  }
  const xff = headers['x-forwarded-for']
  if (typeof xff !== 'string') return false
  // One address and nothing else: a list ("a, b"), a padded pair or a name is not an IP, so it is refused here.
  const ip = normalizeRemoteIp(xff.trim()).toLowerCase()
  if (isIP(ip) === 0) return false
  if (isLoopbackAddress(ip)) return true
  if (!isTailscaleIpv4(ip) && !isTailscaleIpv6(ip)) return false
  let own: readonly string[] = []
  try { own = selfAddresses() } catch { own = [] }
  return own.some(a => normalizeRemoteIp(String(a)).toLowerCase() === ip)
}

/**
 * 6.99.26 (QA round 1): a request from this Mac itself: its socket is loopback or one of the Mac's own addresses (its
 * tailnet address first), and no proxy header says it was forwarded for someone else (a `tailscale serve` hop arrives on
 * loopback for a remote peer). Control Web open on the Mac is the desk: its touch never makes the Mac away.
 * W12: a proxied request is the Mac only as a Serve hop from the Mac to itself (serveHopFromThisMac).
 */
export function requestFromThisMac(
  req: { socket?: { remoteAddress?: string | undefined } | null; headers?: Record<string, unknown> | null },
  selfAddresses: () => readonly string[] = () => selfAddressesFromInterfaces(),
): boolean {
  if (hasProxyForwardedHeaders(req.headers)) return serveHopFromThisMac(req, selfAddresses)
  const remote = req.socket?.remoteAddress
  if (isLoopbackAddress(remote)) return true
  const ip = normalizeRemoteIp(remote ?? '').toLowerCase()
  if (!ip) return false
  let own: readonly string[] = []
  try { own = selfAddresses() } catch { own = [] }
  return own.some(a => normalizeRemoteIp(String(a)).toLowerCase() === ip)
}

export function createSessionQuestionsRouter(deps: SessionQuestionsRouterDeps): Router {
  const router = Router()
  const notePoll = deps.notePoll ?? noteQuestionsPoll
  const noteWeb = deps.noteWebPresence ?? ((at: number, ageMs: number) => noteWebPresence(at, ageMs))
  const fromThisMac = deps.fromThisMac ?? ((req: Request) => requestFromThisMac(req))
  const now = deps.now ?? Date.now
  router.get('/session-questions', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    let expected = ''
    try { expected = deps.apiToken() } catch { expected = '' }
    const byToken = timingSafeTokenEqual(req.headers['x-cos-token'], expected)
    let byWebSession = false
    if (!byToken && deps.webSessionAuthorized) {
      try { byWebSession = deps.webSessionAuthorized(req) === true } catch { byWebSession = false }
    }
    // A hook token, or nothing: refused, and never a live client.
    if (!byToken && !byWebSession) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Only a client that says it can answer (and shows the cards) counts as live.
    const client = typeof req.query.client === 'string' ? req.query.client : ''
    if (byToken && ANSWERING_CLIENTS.has(client)) notePoll(now(), questionsPollFacts(req.query as Record<string, unknown>))
    // 6.99.13 (Miles, option B): a browser poll never counts as live, so an open web tab never holds a question
    // back from the Mac's own pop-up. The web still lists and answers what the glasses or phone are holding.
    // 6.99.26: its touch counts for the away hold only, like the phone's (Miles 11/07, "Away rule, like phone").
    if (byWebSession && client === WEB_ANSWERING_CLIENT) {
      const facts = questionsPollFacts(req.query as Record<string, unknown>)
      if (facts.presenceAgeMs !== null && facts.presenceAgeMs !== undefined && !fromThisMac(req)) noteWeb(now(), facts.presenceAgeMs)
    }
    const health = deps.broker.health()
    // Listed first: a deadline the timer has not caught yet is settled by the listing.
    const items = deps.broker.list()
    res.json({
      enabled: health.enabled,
      mode: health.mode,
      protocolVersion: SESSION_QUESTIONS_PROTOCOL_VERSION,
      pollIntervalMs: deps.broker.questionsPollIntervalMs(),
      liveWindowMs: CLIENT_LIVE_WINDOW_MS,
      pending: deps.broker.pendingCount(),
      stats: deps.broker.stats(),
      items,
      // 6.60.0, additive: the away hold now (0 when off) and the recent-client window it needs,
      // recently settled items (codes and times only, newest first), and how many of them the
      // Mac's own dialog still waits on.
      awayHoldMs: health.enabled ? deps.broker.awayHoldNowMs() : 0,
      awayRecentClientMs: health.enabled && deps.broker.awayHoldNowMs() > 0 ? deps.broker.awayRecentClientWindowMs() : 0,
      settled: deps.broker.settledList(),
      waitingAtMac: deps.broker.waitingAtMacCount(),
      serverStartedAt: deps.serverStartedAt ?? SERVER_STARTED_AT,
      // 6.60.0 (Ghost Hunter W1): a waiting entry settled at or before this time may have been
      // forgotten (the server started then, or dropped it while it still waited). Missing from
      // `settled` and settled after it: the session moved past it.
      waitingAtMacForgottenBefore: new Date(deps.broker.waitingAtMacForgottenBeforeMs()).toISOString(),
      // X1, additive and only while a full-hold switch or COS_WAITING_QUESTION_WORDS is on: every question a live
      // session waits on (held, at the Mac, or just answered), with its words while it waits, and what a web page must
      // send with an answer right now. With all of them off the response is 7.0.13's, key for key.
      ...(deps.broker.extendedQuestionsView() ? { waiting: deps.broker.waitingList(), webAnswer: deps.broker.webAnswerRules() } : {}),
    })
  })
  router.post('/session-questions/:id/answer', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    // 6.99.27: label the answer by its door (the /api gate already let it in): the token is the Even app, anything else
    // is COS Control Web's browser session.
    let expected = ''
    try { expected = deps.apiToken() } catch { expected = '' }
    const by = timingSafeTokenEqual(req.headers['x-cos-token'], expected) ? 'app' : 'web'
    const result = deps.broker.answer(String(req.params.id ?? ''), req.body, by)
    res.status(result.status).json(result.body)
  })
  // X1: the web door's confirm step for an approval (lib/permission-broker.ts `confirm`). The /api gate let the
  // request in; the door is labelled exactly as for an answer, and only the web door gets a confirm id.
  router.post('/session-questions/:id/confirm', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    let expected = ''
    try { expected = deps.apiToken() } catch { expected = '' }
    const by = timingSafeTokenEqual(req.headers['x-cos-token'], expected) ? 'app' : 'web'
    const result = deps.broker.confirm(String(req.params.id ?? ''), req.body, by)
    res.status(result.status).json(result.body)
  })
  return router
}
