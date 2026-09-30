import { Router, type Request, type Response } from 'express'
import { listBoard, TaskBridgeError, TaskRunError, type TaskBoardRow } from '../lib/task-store.js'
import { WorkHandoffRequestError, WorkHandoffRequestStore, handoffFullView, handoffStatusView, normalizeRequestId,
  parseHandoffRequest, parseHandoffResult, type HandoffRequestInput, type HandoffRequestState } from '../lib/work-handoff-requests.js'
import { controlSnapshotRevision, readWorkJournal, sameSession, type WorkJournalRead } from '../lib/work-activity.js'
import { createWorkBoardReader, WorkBoardTimeoutError, type WorkBoardReader } from '../lib/work-board-reader.js'
import { DEFAULT_MODEL, normalizeModelPreference } from '../../shared/model-preference.js'

export interface WorkHandoffRequestsDependencies {
  store: WorkHandoffRequestStore | null
  list: typeof listBoard
  /** The bounded, shared board read (5 s). Defaults to one over `list`. */
  readBoard?: WorkBoardReader<TaskBoardRow>
  /** COS Control's handoff journal, read only to check a reply's receipt. */
  journal: () => WorkJournalRead
  /** The model a New session request without one takes: COS_G2_DEFAULT_MODEL, else the server default. */
  defaultModel: () => string
  /** Whether the caller is this Mac itself. Control's routes answer only loopback callers. */
  isLocal: (req: Request) => boolean
}
export const defaultHandoffModel = (): string => normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL) ?? DEFAULT_MODEL
/** How old a board read may be when a request is checked against it. */
export const HANDOFF_BOARD_AGE_MS = 2_000
const STATES: readonly string[] = ['pending', 'claimed', 'sent', 'refused', 'unresolved', 'unconfirmed', 'expired']

/** The Mac itself, as the maintenance routes decide it (routes/maintenance.ts). Phone and tailnet traffic is not. */
export function isLoopbackRequest(req: Pick<Request, 'socket'>): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * 6.59.0: the handoff request inbox. The glasses ask for Work to start (POST, GET by id, over the network); COS Control
 * on this Mac lists, claims and reports (loopback only). Auth is supplied by the parent /api mount. Writes take the
 * global api_mutation maintenance lease like every other short /api mutation, so they are refused while a drain is
 * open. Nothing here runs a provider or Jev.
 */
export function createWorkHandoffRequestsRouter(overrides: Partial<WorkHandoffRequestsDependencies> & Pick<WorkHandoffRequestsDependencies, 'store'>): Router {
  const deps: WorkHandoffRequestsDependencies = { list: listBoard, journal: () => readWorkJournal(), defaultModel: defaultHandoffModel,
    isLocal: isLoopbackRequest, ...overrides }
  const board = deps.readBoard ?? createWorkBoardReader(() => deps.list())
  const router = Router()
  router.use('/work-board/handoff-requests', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.store) return res.status(503).json({ error: { code: 'handoff_requests_unavailable', message: 'Work handoff requests are unavailable on this server.' } })
    next()
  })
  /** Refusals are answers. Control's refusals and every 5xx are logged with their code; a note never is. */
  const fail = (res: Response, e: unknown, where: string, id?: string) => {
    if (e instanceof WorkHandoffRequestError) {
      if (e.status >= 500 || where === 'claim' || where === 'result') console.warn(`[work-handoff-requests] ${where}${id ? ' ' + id : ''}: ${e.status} ${e.code}${e.extra.cause ? ` (${e.extra.cause})` : ''}`)
      if (e.extra.resetsAt) res.set('Retry-After', String(Math.max(1, Math.ceil((Date.parse(e.extra.resetsAt) - Date.now()) / 1000))))
      return res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } })
    }
    console.error(`[work-handoff-requests] ${where} failed:`, e instanceof Error ? e.message : e)
    return res.status(503).json({ error: { code: 'handoff_requests_unavailable', message: 'Work handoff requests are unavailable. Try again shortly.' } })
  }
  const requestId = (raw: unknown): string => {
    const id = normalizeRequestId(raw)
    if (!id) throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'The request id must be a UUID v4.')
    return id
  }
  const local = (req: Request) => {
    if (!deps.isLocal(req)) throw new WorkHandoffRequestError('local_only', 403, 'Only COS Control on this Mac can do this.')
  }

  /** A reply names the item's newest receipt, on the session it continues. */
  const checkReplyTarget = (input: HandoffRequestInput) => {
    const journal = deps.journal()
    if (!journal.available) throw new WorkHandoffRequestError('work_history_unavailable', 503, 'COS Control’s Work history cannot be read here.')
    const workId = `task:${input.domain}:${input.workIdentity}`
    const own = journal.receipts.filter(r => r.workID === workId)
    const target = own.find(r => r.id === input.replyTo)
    if (!target) throw new WorkHandoffRequestError('reply_target_invalid', 409, 'That handoff is not this task’s.')
    const newest = own.reduce((a, b) => (b.createdAt as number) > (a.createdAt as number)
      || (b.createdAt === a.createdAt && (b.id as string) > (a.id as string)) ? b : a)
    if (newest !== target) throw new WorkHandoffRequestError('reply_target_invalid', 409, 'This task has a newer handoff. Refresh before replying.')
    const session = typeof target.sessionID === 'string' && !(target.mode === 'fork' && target.sessionID === target.sourceSessionID) ? target.sessionID : null
    if (!session || !sameSession(session, input.sessionId!)) throw new WorkHandoffRequestError('reply_target_invalid', 409, 'A reply continues the session that handoff went to.')
  }

  // Glasses: ask for Work to start, reply, or say it is not done yet.
  router.post('/work-board/handoff-requests', async (req, res) => {
    let id: string | undefined
    try {
      const { input, fingerprint } = parseHandoffRequest(req.body, deps.defaultModel())
      id = input.clientRequestId
      // A retry is answered from the store, even when the board has since changed or is unreachable.
      const replay = deps.store!.replay(input.clientRequestId, fingerprint)
      if (replay) return res.status(200).json({ request: handoffFullView(replay) })
      let rows: TaskBoardRow[]
      try { rows = await board.read(HANDOFF_BOARD_AGE_MS) }
      catch (e) {
        const cause = e instanceof WorkBoardTimeoutError ? 'work_board_timeout' : e instanceof TaskRunError || e instanceof TaskBridgeError ? e.code : 'work_board_unavailable'
        throw new WorkHandoffRequestError('work_board_unavailable', 503, 'Work board is unavailable. Nothing was sent; try again shortly.', { cause })
      }
      const row = rows.find(r => r.domain === input.domain && (r.workIdentity || r.id) === input.workIdentity)
      if (!row) throw new WorkHandoffRequestError('task_not_found', 404, 'This task is not on the board any more.')
      if (row.checked) throw new WorkHandoffRequestError('task_complete', 409, 'This task is complete.')
      if (input.replyTo) checkReplyTarget(input)
      const { request, created } = deps.store!.create(input, fingerprint, controlSnapshotRevision(row))
      return res.status(created ? 201 : 200).json({ request: handoffFullView(request) })
    } catch (e) { return fail(res, e, 'create', id) }
  })

  // Control: the requests to act on (with note, mode, session and model), oldest first. Listing pending ones is what
  // tells the glasses COS Control is taking requests.
  router.get('/work-board/handoff-requests', (req, res) => {
    try {
      local(req)
      const { state } = req.query
      if (Object.keys(req.query).some(key => key !== 'state') || (state !== undefined && (typeof state !== 'string' || !STATES.includes(state)))) {
        throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'state must be one of the request states.')
      }
      if (state === 'pending') deps.store!.noteConsumer()
      return res.json({ version: 1, requests: deps.store!.list(state as HandoffRequestState | undefined).map(handoffFullView),
        quarantined: deps.store!.quarantineCount() })
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

  // Control: take one pending request. 200 claimed with its claimToken (the same token again is 200), 409 already
  // claimed, 410 expired.
  router.post('/work-board/handoff-requests/:clientRequestId/claim', (req, res) => {
    let id: string | undefined
    try {
      local(req)
      id = requestId(req.params.clientRequestId)
      const body = req.body
      const token = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).claimToken : undefined
      if (!(body === undefined || (body && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body).every(key => key === 'claimToken') && (token === undefined || typeof token === 'string')))) {
        throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'A claim takes no body, or { claimToken } to claim again.')
      }
      const request = deps.store!.claim(id, token as string | undefined)
      return res.json({ request: handoffFullView(request), claimToken: request.claimToken })
    } catch (e) { return fail(res, e, 'claim', id) }
  })

  // Control: what happened to a claimed request, under its claim token.
  router.post('/work-board/handoff-requests/:clientRequestId/result', (req, res) => {
    let id: string | undefined
    try {
      local(req)
      id = requestId(req.params.clientRequestId)
      return res.json({ request: handoffFullView(deps.store!.report(id, parseHandoffResult(req.body))) })
    } catch (e) { return fail(res, e, 'result', id) }
  })
  return router
}
