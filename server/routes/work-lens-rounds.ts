/**
 * 6.83.0: lens plans in Work chat history, and "Send this plan" (docs/work-orchestrator.md, "Lens plans").
 *
 * Lens (over the network, token auth from the parent /api mount):
 *   POST /api/work/chat/lens-rounds                       record a plan the lens made (idempotent on clientRoundId)
 *   GET  /api/work/chat/lens-rounds/:roundId              the round's live state, never its prompts
 *   POST /api/work/chat/lens-rounds/:roundId/send         ask COS Control to send it (two-step confirm, or card Auto-send)
 *   POST /api/work/chat/lens-rounds/:roundId/stop         ask COS Control to Stop assignments
 * COS Control (this Mac only):
 *   GET  /api/work/chat/lens-inbox?since=<cursor>[&autoSend=1]   rounds not yet in history, send and stop requests
 *   POST /api/work/chat/lens-rounds/:roundId/history      { state: "in_history", autoSendCard? }
 *   POST /api/work/chat/lens-send/:sendRequestId/result   { assignments: [{ id, state, receiptId?, detail?, sessionID? }] }
 *
 * Nothing here sends to a session: COS Control performs every send through its own Send path and reports back.
 * Every route answers 503 `maintenance` while admissions are closed; writes hold the api_mutation lease themselves
 * (index.ts leaves these paths to this router so the error code is the contract's).
 */
import { Router, type Request, type Response } from 'express'
import { LensRoundError, LensRoundStore, LENS_ROUND_BODY_BYTES, ROUND_ID, SEND_ID, cardSessionsOf, parseLensRound, parseResultBody,
  parseSendBody, parseStopBody, roundView, defaultLensRoundStore } from '../lib/work-lens-rounds.js'
import type { ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'
import { orchestratorSnapshots } from '../lib/work-orchestrator/runtime.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
import { isLoopbackRequest } from './work-handoff-requests.js'
import { listBoard, type TaskBoardRow } from '../lib/task-store.js'
import { createWorkBoardReader, type WorkBoardReader } from '../lib/work-board-reader.js'

export interface WorkLensRoundsDeps {
  store: LensRoundStore
  /** COS Control's Work snapshot (links and receipts), for the card's sessions. */
  snapshot: () => ControlSnapshot | null
  /** Whether the workID is a card the server knows: in COS Control's snapshot or on the Work board. Throws when unknowable. */
  knownWork: (workID: string) => Promise<boolean>
  admissions: () => boolean
  lease: () => { release(): void }
  isLocal: (req: Request) => boolean
}

/** A card is known when COS Control's snapshot names it, or the Work board (a bounded read, 2 s old at most) lists it. */
export function knownWorkFrom(snapshot: () => ControlSnapshot | null, board: WorkBoardReader<TaskBoardRow>) {
  return async (workID: string): Promise<boolean> => {
    const s = snapshot()
    if (s && (s.links.some(l => l.workID === workID) || s.receipts.some(r => r.workID === workID))) return true
    const rows = await board.read(2_000)
    return rows.some(r => `task:${r.domain}:${r.workIdentity || r.id}` === workID)
  }
}

let defaultBoard: WorkBoardReader<TaskBoardRow> | null = null
const DEFAULTS = (): WorkLensRoundsDeps => ({
  store: defaultLensRoundStore(),
  snapshot: () => orchestratorSnapshots().get(),
  knownWork: knownWorkFrom(() => orchestratorSnapshots().get(), defaultBoard ??= createWorkBoardReader(() => listBoard())),
  admissions: maintenanceAdmissionsOpen,
  lease: () => acquireMaintenanceWork('api_mutation'),
  isLocal: isLoopbackRequest,
})

const MAINTENANCE = { error: 'maintenance', message: 'The server is updating. The plan is kept on the lens; try again shortly.' }

export function createWorkLensRoundsRouter(given: Partial<WorkLensRoundsDeps> = {}) {
  const deps: WorkLensRoundsDeps = { ...DEFAULTS(), ...given }
  const router = Router()
  router.use(['/work/chat/lens-rounds', '/work/chat/lens-inbox', '/work/chat/lens-send'], (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.admissions()) return res.status(503).json(MAINTENANCE)
    next()
  })
  const fail = (res: Response, e: unknown, where: string) => {
    if (e instanceof LensRoundError) {
      if (e.status >= 500 || where !== 'record') console.warn(`[work-lens-rounds] ${where}: ${e.status} ${e.code}`)
      return res.status(e.status).json({ error: e.code, message: e.message, ...e.extra })
    }
    console.error(`[work-lens-rounds] ${where} failed: ${e instanceof Error ? e.message : String(e)}`)
    return res.status(503).json({ error: 'lens_rounds_unavailable', message: 'Lens plans are unavailable. Try again shortly.' })
  }
  /** A write holds the api_mutation lease for its own (sub-millisecond) body; a closed gate is `maintenance`. */
  const write = <T>(res: Response, where: string, fn: () => Promise<T> | T) => {
    let lease: { release(): void }
    try { lease = deps.lease() } catch { return res.status(503).json(MAINTENANCE) }
    return Promise.resolve().then(fn).catch(e => fail(res, e, where)).finally(() => lease.release())
  }
  const local = (req: Request) => { if (!deps.isLocal(req)) throw new LensRoundError('local_only', 403, 'Only COS Control on this Mac can do this.') }
  const roundIdOf = (req: Request) => {
    const id = String(req.params.roundId ?? '')
    if (!ROUND_ID.test(id)) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
    return id
  }
  const connected = () => deps.store.controlStatus().connected

  router.post('/work/chat/lens-rounds', (req, res) => write(res, 'record', async () => {
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > LENS_ROUND_BODY_BYTES) {
      return res.status(413).json({ error: 'lens_round_too_large', message: 'This plan is too large to save.' })
    }
    const input = parseLensRound(req.body)
    // A repeat is answered from the store, even when the board has since changed or is unreachable.
    const replay = deps.store.replay(input.clientRoundId)
    if (!replay) {
      let known: boolean
      try { known = await deps.knownWork(input.workID) }
      catch { throw new LensRoundError('work_board_unavailable', 503, 'The Work board is unavailable. The plan is kept on the lens; try again shortly.') }
      if (!known) throw new LensRoundError('unknown_work', 404, 'This card is not on the Work board any more.')
    }
    const { round, created } = deps.store.record(input, cardSessionsOf(deps.snapshot(), input.workID))
    if (created) console.log(`[work-lens-rounds] recorded ${round.roundId} work=${round.workID} assignments=${round.assignments.length}`)
    return res.status(created ? 201 : 200).json({ roundId: round.roundId, workID: round.workID, state: roundView(round).state, control: { connected: connected() } })
  }))

  router.get('/work/chat/lens-rounds/:roundId', (req, res) => {
    try {
      const round = deps.store.find(roundIdOf(req))
      if (!round) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
      return res.json(roundView(round))
    } catch (e) { return fail(res, e, 'status') }
  })

  router.post('/work/chat/lens-rounds/:roundId/send', (req, res) => write(res, 'send', () => {
    const roundId = roundIdOf(req)
    const body = parseSendBody(req.body)
    const round = deps.store.find(roundId)
    if (!round) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
    const send = deps.store.requestSend(roundId, body, { cardSessions: cardSessionsOf(deps.snapshot(), round.workID), controlConnected: connected() })
    console.log(`[work-lens-rounds] send requested ${send.id} round=${roundId} assignments=${send.assignmentIds.join(',')} confirm=${send.confirm ?? 'auto-send'}`)
    return res.status(202).json({ sendRequestId: send.id, state: 'send_requested' })
  }))

  router.post('/work/chat/lens-rounds/:roundId/stop', (req, res) => write(res, 'stop', () => {
    const roundId = roundIdOf(req)
    const stop = deps.store.requestStop(roundId, parseStopBody(req.body), connected())
    console.log(`[work-lens-rounds] stop requested ${stop.id} round=${roundId} assignments=${stop.assignmentIds.join(',')}`)
    return res.status(202).json({ stopRequestId: stop.id, state: 'stop_requested' })
  }))

  // COS Control: polling this is what the capability reports as connected. Listing a send or a stop picks it up.
  router.get('/work/chat/lens-inbox', (req, res) => {
    try {
      local(req)
      const { since, autoSend } = req.query
      if (Object.keys(req.query).some(k => k !== 'since' && k !== 'autoSend')
        || (since !== undefined && !(typeof since === 'string' && /^\d{1,12}$/.test(since)))
        || (autoSend !== undefined && autoSend !== '0' && autoSend !== '1')) {
        throw new LensRoundError('invalid_lens_inbox', 400, 'since is a cursor and autoSend is 0 or 1.')
      }
      return res.json(deps.store.inbox(since === undefined ? 0 : Number(since), autoSend === '1'))
    } catch (e) { return fail(res, e, 'inbox') }
  })

  router.post('/work/chat/lens-rounds/:roundId/history', (req, res) => write(res, 'history', () => {
    local(req)
    const roundId = roundIdOf(req)
    const b = req.body
    if (!b || typeof b !== 'object' || Array.isArray(b) || b.state !== 'in_history' || (b.autoSendCard !== undefined && typeof b.autoSendCard !== 'boolean')) {
      throw new LensRoundError('invalid_lens_round', 400, 'History takes { state: "in_history" }.', { field: 'state' })
    }
    const round = deps.store.markInHistory(roundId, b.autoSendCard)
    return res.json(roundView(round))
  }))

  router.post('/work/chat/lens-send/:sendRequestId/result', (req, res) => write(res, 'result', () => {
    local(req)
    const id = String(req.params.sendRequestId ?? '')
    if (!SEND_ID.test(id)) throw new LensRoundError('unknown_send', 404, 'No such send request.')
    const round = deps.store.report(id, parseResultBody(req.body))
    const view = roundView(round)
    console.log(`[work-lens-rounds] result ${id} round=${round.roundId} state=${view.state} ${view.assignments.map(a => `${a.id}:${a.state}`).join(' ')}`)
    return res.json(view)
  }))
  return router
}
