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

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import {
  ANSWERING_CLIENTS,
  CLIENT_LIVE_WINDOW_MS,
  QUESTIONS_POLL_INTERVAL_MS,
  SESSION_QUESTIONS_PROTOCOL_VERSION,
  type BrokerAdmission,
  type HookReplyChannel,
  type PermissionBroker,
} from '../lib/permission-broker.js'
import { noteQuestionsPoll } from '../lib/client-liveness.js'

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
  /** The pairing token (X-Cos-Token). A poll counts as a live client only with it. */
  apiToken: () => string
  /** Where a counted poll is recorded; `noteQuestionsPoll` in production. */
  notePoll?: (at: number) => void
  now?: () => number
}

export function createSessionQuestionsRouter(deps: SessionQuestionsRouterDeps): Router {
  const router = Router()
  const notePoll = deps.notePoll ?? noteQuestionsPoll
  const now = deps.now ?? Date.now
  router.get('/session-questions', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    let expected = ''
    try { expected = deps.apiToken() } catch { expected = '' }
    // A hook token, or nothing: refused, and never a live client.
    if (!timingSafeTokenEqual(req.headers['x-cos-token'], expected)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Only a client that says it can answer (and shows the cards) counts as live.
    const client = typeof req.query.client === 'string' ? req.query.client : ''
    if (ANSWERING_CLIENTS.has(client)) notePoll(now())
    const health = deps.broker.health()
    // Listed first: a deadline the timer has not caught yet is settled by the listing.
    const items = deps.broker.list()
    res.json({
      enabled: health.enabled,
      mode: health.mode,
      protocolVersion: SESSION_QUESTIONS_PROTOCOL_VERSION,
      pollIntervalMs: QUESTIONS_POLL_INTERVAL_MS,
      liveWindowMs: CLIENT_LIVE_WINDOW_MS,
      pending: deps.broker.pendingCount(),
      stats: deps.broker.stats(),
      items,
    })
  })
  router.post('/session-questions/:id/answer', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const result = deps.broker.answer(String(req.params.id ?? ''), req.body)
    res.status(result.status).json(result.body)
  })
  return router
}
