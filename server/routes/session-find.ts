/**
 * POST /api/agent-sessions/find (Control 0.5.362): which of this Mac's agent sessions the person means, by meaning.
 * Auth comes from the parent /api mount. See lib/session-find.ts for what leaves the Mac, the cost controls and the gates.
 *
 * Body `{ query, consentedProvider, stage }`, exactly those keys. `query` is a string; the words are redacted and cut at 200
 * code points before use. `consentedProvider` is `"jev"`, `"subq"` or `null`: the provider the person agreed to send to.
 * `stage` is `"first"` (the newest 254 sessions) or `"full"` (the next 254 too, unless the first already settles it).
 *
 * A search that cannot run answers HTTP 200 with `available: false`, a `reason` and a `message`, so Control keeps its word
 * search and says one line about why. A malformed body is 400. A walk that fails (the session store, the keyed-sessions file) is
 * also a 200 with `reason: failed`, so Control keeps its word search. 503 `session_find_unavailable` is left for an unexpected
 * error outside the finder's own handling: try later.
 * An older server answers 404, which Control reads as "no meaning search here".
 *
 * A closed connection stops the walk and any stage that has not started. A model request already sent is not aborted (it is
 * billed either way). The query and the sessions never reach a log line.
 */
import { Router, type Response } from 'express'
import { isAbortError } from '../lib/session-find-collect.js'
import { SESSION_FIND_LIMITS, SessionFinder, unavailableAnswer, type SessionFindAnswer } from '../lib/session-find.js'

export interface SessionFindRouteDependencies {
  finder: Pick<SessionFinder, 'find'>
}

const BODY_KEYS = new Set(['query', 'consentedProvider', 'stage'])
/** One log line per degrade reason per 10 minutes: Control falls back quietly, so the server says why. */
export const SESSION_FIND_LOG_EVERY_MS = 10 * 60_000

export function createSessionFindRouter(overrides: Partial<SessionFindRouteDependencies> = {}): Router {
  let finder: Pick<SessionFinder, 'find'> | null = overrides.finder ?? null
  const router = Router()
  router.use('/agent-sessions/find', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

  router.post('/agent-sessions/find', async (req, res: Response) => {
    const body = req.body
    const bad = () => res.status(400).json({ error: { code: 'invalid_find_request',
      message: 'Send a query, the provider you consented to (jev, subq or null) and a stage of first or full.' } })
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) return bad()
    if (typeof body.query !== 'string' || body.query.length > SESSION_FIND_LIMITS.queryRawMax) return bad()
    if (body.consentedProvider !== null && body.consentedProvider !== undefined && body.consentedProvider !== 'jev' && body.consentedProvider !== 'subq') return bad()
    if (body.stage !== 'first' && body.stage !== 'full') return bad()

    const controller = new AbortController()
    // `close` also fires when a response has finished normally; only a connection that closed before the answer counts.
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    let answer: SessionFindAnswer
    try {
      finder ??= new SessionFinder()
      answer = await finder.find({ query: body.query, consentedProvider: body.consentedProvider ?? null, stage: body.stage }, controller.signal)
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return
      console.error('[session-find] search failed')
      return res.status(503).json({ error: { code: 'session_find_unavailable', message: 'Meaning search could not read your sessions. Try again shortly.' } })
    }
    if (controller.signal.aborted) return
    return res.json(answer)
  })
  return router
}

export { unavailableAnswer }
