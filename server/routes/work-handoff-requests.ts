import { Router, type Response } from 'express'
import { listBoard } from '../lib/task-store.js'
import { WorkHandoffRequestError, WorkHandoffRequestStore, handoffFullView, handoffStatusView, normalizeRequestId,
  parseHandoffRequest, parseHandoffResult, type HandoffRequestState } from '../lib/work-handoff-requests.js'
import { DEFAULT_MODEL, normalizeModelPreference } from '../../shared/model-preference.js'

export interface WorkHandoffRequestsDependencies {
  store: WorkHandoffRequestStore | null
  list: typeof listBoard
  /** The model a New session request without one takes: COS_G2_DEFAULT_MODEL, else the server default. */
  defaultModel: () => string
}
export const defaultHandoffModel = (): string => normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL) ?? DEFAULT_MODEL
const STATES: readonly string[] = ['pending', 'claimed', 'sent', 'refused', 'expired']

/**
 * 6.59.0: the handoff request inbox. The glasses ask for Work to start; COS Control claims the request and runs its
 * own send. Auth is supplied by the parent /api mount. Writes take the global api_mutation maintenance lease like
 * every other short /api mutation, so they are refused while a drain is open. Nothing here runs a provider or Jev.
 */
export function createWorkHandoffRequestsRouter(overrides: Partial<WorkHandoffRequestsDependencies> & Pick<WorkHandoffRequestsDependencies, 'store'>): Router {
  const deps: WorkHandoffRequestsDependencies = { list: listBoard, defaultModel: defaultHandoffModel, ...overrides }
  const router = Router()
  router.use('/work-board/handoff-requests', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.store) return res.status(503).json({ error: { code: 'handoff_requests_unavailable', message: 'Work handoff requests are unavailable on this server.' } })
    next()
  })
  const fail = (res: Response, e: unknown, where: string) => {
    if (e instanceof WorkHandoffRequestError) {
      if (e.status >= 500) console.error(`[work-handoff-requests] ${where}: ${e.code}`)
      return res.status(e.status).json({ error: { code: e.code, message: e.message } })
    }
    console.error(`[work-handoff-requests] ${where} failed:`, e instanceof Error ? e.message : e)
    return res.status(503).json({ error: { code: 'handoff_requests_unavailable', message: 'Work handoff requests are unavailable. Try again shortly.' } })
  }
  const requestId = (raw: unknown): string => {
    const id = normalizeRequestId(raw)
    if (!id) throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'The request id must be a UUID v4.')
    return id
  }
  const emptyBody = (body: unknown): boolean => body === undefined || (!!body && typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).length)

  // Glasses: ask for Work to start.
  router.post('/work-board/handoff-requests', async (req, res) => {
    try {
      const { input, fingerprint } = parseHandoffRequest(req.body, deps.defaultModel())
      // A retry is answered from the store, even when the board has since changed or is unreachable.
      const replay = deps.store!.replay(input.clientRequestId, fingerprint)
      if (replay) return res.status(200).json({ request: handoffFullView(replay) })
      let rows: Awaited<ReturnType<typeof listBoard>>
      try { rows = await deps.list() }
      catch { throw new WorkHandoffRequestError('work_board_unavailable', 503, 'Work board is unavailable. Refresh before trying again.') }
      const row = rows.find(r => r.domain === input.domain && (r.workIdentity || r.id) === input.workIdentity)
      if (!row) throw new WorkHandoffRequestError('task_not_found', 404, 'This task is not on the board any more.')
      const { request, created } = deps.store!.create(input, fingerprint, row.workRevision)
      return res.status(created ? 201 : 200).json({ request: handoffFullView(request) })
    } catch (e) { return fail(res, e, 'create') }
  })

  // Control: the requests to act on (with note, mode, session and model), oldest first.
  router.get('/work-board/handoff-requests', (req, res) => {
    try {
      const { state } = req.query
      if (Object.keys(req.query).some(key => key !== 'state') || (state !== undefined && (typeof state !== 'string' || !STATES.includes(state)))) {
        throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'state must be pending, claimed, sent, refused or expired.')
      }
      return res.json({ version: 1, requests: deps.store!.list(state as HandoffRequestState | undefined).map(handoffFullView) })
    } catch (e) { return fail(res, e, 'list') }
  })

  // Glasses: where one request is. State and times only, never the note.
  router.get('/work-board/handoff-requests/:clientRequestId', (req, res) => {
    try {
      const request = deps.store!.get(requestId(req.params.clientRequestId))
      if (!request) throw new WorkHandoffRequestError('request_not_found', 404, 'No such handoff request.')
      return res.json({ request: handoffStatusView(request) })
    } catch (e) { return fail(res, e, 'status') }
  })

  // Control: take one pending request. 200 claimed, 409 already claimed, 410 expired.
  router.post('/work-board/handoff-requests/:clientRequestId/claim', (req, res) => {
    try {
      const id = requestId(req.params.clientRequestId)
      if (!emptyBody(req.body)) throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'A claim takes no body.')
      return res.json({ request: handoffFullView(deps.store!.claim(id)) })
    } catch (e) { return fail(res, e, 'claim') }
  })

  // Control: what happened to a claimed request.
  router.post('/work-board/handoff-requests/:clientRequestId/result', (req, res) => {
    try {
      const id = requestId(req.params.clientRequestId)
      return res.json({ request: handoffFullView(deps.store!.report(id, parseHandoffResult(req.body))) })
    } catch (e) { return fail(res, e, 'result') }
  })
  return router
}
