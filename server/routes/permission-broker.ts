// The permission broker's two doors (6.52.0). See `lib/permission-broker.ts` for the why.
//
// POST /hooks/permission-requests/ask -- the COS session hook, on a PermissionRequest at a
// desk idle for 90 s. NOT under /api, on purpose, like the 6.51.0 Cursor route: the hook
// holds the per-install HOOK token (`~/.cos-glasses/hook-token`, 0600), never the pairing
// token the /api gate checks. This route checks the hook token itself, in constant time,
// before it reads anything, and answers only `{}` or a `{"hookSpecificOutput": ...}` the
// hook prints verbatim. Mounted unconditionally (not behind COS_THREAD_ATTACH_ENABLED):
// the switch is `COS_PERMISSION_BROKER`, read per request.
//
// Mixed versions fail safe. A 6.51 script posts to `/api/permission-requests/ask`, which
// the /api gate answers 401; a 6.52 script against a 6.51 server gets 404. The script
// prints only a body that starts with `{"hookSpecificOutput"`, so both are the native
// dialog, which is what every such request got before this release.
//
// GET /api/session-questions and POST /api/session-questions/:id/answer -- the lens and the
// phone, behind the API token like every other /api route. Question and command text only
// ever travels here, never on the display bus. The GET is ALSO the broker's liveness
// signal (lib/client-liveness.ts): only a client that asks for questions can answer one.
// So it checks X-Cos-Token itself as well, in constant time, and a request without it is
// refused and never counted, whatever sits in front of this router.

import express, { Router, type Request, type Response } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import type { BrokerAdmission, HookReplyChannel, PermissionBroker } from '../lib/permission-broker.js'
import { noteQuestionsPoll } from '../lib/client-liveness.js'

export const PERMISSION_BROKER_HOOK_PATH = '/hooks/permission-requests/ask'

export interface PermissionBrokerHookRouterDeps {
  /** The per-install hook token, or null when none has been minted (then nothing is answered). */
  hookToken: () => string | null
  broker: PermissionBroker
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
  // The hook posts its spool envelope, capped at 1 MiB by the script itself.
  router.post(PERMISSION_BROKER_HOOK_PATH, express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    let expected: string | null = null
    try { expected = deps.hookToken() } catch { expected = null }
    if (!expected || !timingSafeTokenEqual(req.headers['x-cos-hook-token'], expected)) {
      res.status(401).json({})
      return
    }
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
    notePoll(now())
    const health = deps.broker.health()
    res.json({ enabled: health.enabled, mode: health.mode, items: deps.broker.list() })
  })
  router.post('/session-questions/:id/answer', (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    const result = deps.broker.answer(String(req.params.id ?? ''), req.body)
    res.status(result.status).json(result.body)
  })
  return router
}
