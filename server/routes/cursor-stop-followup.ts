// POST /hooks/cursor/stop-followup -- the COS session hook asks, at a Cursor composer's
// Stop, whether a turn is queued for it (6.51.0). See `lib/cursor-stop-followup.ts`.
//
// NOT under /api, on purpose. The hook holds the per-install HOOK token
// (`~/.cos-glasses/hook-token`, 0600), never the pairing token the /api gate checks, and
// widening that gate for one caller would be the larger change. This route checks the
// hook token itself, in constant time, before it reads anything. It answers only `{}` or
// `{"followup_message": ...}` so the hook can print it verbatim, and it never answers
// with anything a Claude Stop could act on: a body that is not a Cursor Stop is `{}`.

import express, { Router, type Request, type Response } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { claimNextCursorTurn, cursorStopAcceptsFollowup, parseCursorStopEnvelope } from '../lib/cursor-stop-followup.js'
import { MAX_QUEUED_PER_THREAD, type QueuedThreadTurn } from '../lib/thread-turn-queue.js'

export interface CursorStopFollowupDeps {
  /** The per-install hook token, or null when none has been minted (then nothing is answered). */
  hookToken: () => string | null
  readQueue: (provider: string, threadId: string, now: number) => QueuedThreadTurn[]
  writeQueue: (provider: string, threadId: string, queue: QueuedThreadTurn[]) => void
  now: () => number
}

export const CURSOR_STOP_FOLLOWUP_PATH = '/hooks/cursor/stop-followup'

export function createCursorStopFollowupRouter(deps: CursorStopFollowupDeps): Router {
  const router = Router()
  // The hook posts its spool envelope, capped at 1 MiB by the script itself.
  router.post(CURSOR_STOP_FOLLOWUP_PATH, express.json({ limit: '2mb' }), (req: Request, res: Response) => {
    res.set('Cache-Control', 'private, no-store')
    let expected: string | null = null
    try { expected = deps.hookToken() } catch { expected = null }
    if (!expected || !timingSafeTokenEqual(req.headers['x-cos-hook-token'], expected)) {
      return res.status(401).json({})
    }
    const facts = parseCursorStopEnvelope(req.body)
    if (!facts || !cursorStopAcceptsFollowup(facts, MAX_QUEUED_PER_THREAD)) return res.json({})
    // The hook waits a few seconds and then moves on. A claim made after it hung up would
    // mark a turn delivered that Cursor never received (QA, 6.51.0: a Stop that lands
    // while the event loop is busy). Everything from here to the reply is synchronous, so
    // a socket that is open now is open when the reply is written.
    if (req.socket?.destroyed === true || res.writableEnded) {
      console.warn('[cursor-stop-followup] the hook hung up before the claim; nothing claimed')
      return undefined
    }
    let claimed: ReturnType<typeof claimNextCursorTurn> = null
    try {
      const now = deps.now()
      claimed = claimNextCursorTurn(deps.readQueue('cursor', facts.conversationId, now), now)
      if (!claimed) return res.json({})
      // Written BEFORE the text leaves: the row must never read `waiting` after the
      // composer has been handed it, or a later Stop would hand it over again.
      deps.writeQueue('cursor', facts.conversationId, claimed.queue)
    } catch (error) {
      console.error(`[cursor-stop-followup] claim failed: ${error instanceof Error ? error.message : error}`)
      return res.json({})
    }
    console.log(`[cursor-stop-followup] handed a queued turn to Cursor clientTurnId=${claimed.turn.clientTurnId} chars=${claimed.turn.prompt.length} loop=${facts.loopCount ?? 'null'} cursor=${facts.cursorVersion}`)
    return res.json({ followup_message: claimed.turn.prompt })
  })
  return router
}
