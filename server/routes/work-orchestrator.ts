/**
 * 6.83.0 Work orchestrator routes (docs/work-orchestrator.md). Read and plan inputs only: nothing here sends to a
 * session, changes a link or a receipt, or calls a model.
 *
 *   POST /api/work/orchestrator/input  {workID, meetingWorkIDs?, snapshot?}
 *        Stores Control's snapshot when one is sent (Phase A: Control pushes, the server keeps the copy), then answers
 *        the card's planner rows, what was left out and why, and the usage snapshot.
 *   POST /api/work/orchestrator/snapshot {workID, revision, serverInstanceId, snapshot}
 *        Bound to this server and a current canonical card revision. Stores validated Control evidence only;
 *        no discovery, usage refresh, model, link/receipt write or dispatch.
 *   GET  /api/work/orchestrator/usage[?refresh=1]
 *        The usage snapshot per provider, read on demand: Claude and Codex are re-read when their reading is older than
 *        10 minutes (`refresh=1`: 2 minutes). No timer reads usage unless COS_WORK_USAGE_POLL=1.
 *   GET  /api/usage/plan[?refresh=1]
 *        7.0.41: the plan ruler on the Usage view (plan-pane.ts), from the same reader and the same rule: opening the
 *        view re-reads a reading older than 10 minutes, Refresh one older than 2. The breaker and the 10-minute hold
 *        after a "no limits" answer apply. Nothing reads on a timer.
 *        7.0.54: two Claude rows, "Claude CLI" (the probe, or the terminal status line's reading when newer) and
 *        "Claude Desktop" (the reading below), from local files only (usage-feed.ts).
 *   POST /api/usage/feed/claude-desktop {plan: {status, plan, windows: [{label, percentUsed, resetsAt}]}, ...}
 *        7.0.54: a desktop session records the Claude Desktop app's own usage tool reply. Checked and written
 *        atomically; only the plan name and its windows are kept. 400 {error: 'invalid_reading', reason} otherwise.
 *        The API token only (403 for a Control Web cookie); bodies over 16 KB get 413.
 */
import { Router } from 'express'
import { parseSnapshotReport, type ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'
import type { OrchestratorInput } from '../lib/work-orchestrator/input.js'
import { USAGE_PROVIDERS, type UsageMonitor, type UsageView } from '../lib/work-orchestrator/usage.js'
import { planPane, type PlanFeeds, type PlanPane } from '../lib/work-orchestrator/plan-pane.js'
import { desktopReadingFromTool, FeedError, MAX_FEED_BYTES, readFeed, writeDesktopFeed, type FeedReading } from '../lib/work-orchestrator/usage-feed.js'
import { API_AUTH_BY_LOCAL } from '../lib/api-auth.js'
import { orchestratorInputFor, orchestratorSnapshots, orchestratorUsage } from '../lib/work-orchestrator/runtime.js'
import { listBoard, type TaskBoardRow } from '../lib/task-store.js'
import { createWorkBoardReader } from '../lib/work-board-reader.js'
import { getServerInstanceId } from '../lib/server-instance-id.js'
import { maintenanceAdmissionsOpen, acquireMaintenanceWork } from '../lib/maintenance-lifecycle.js'
import { AskWorkPlanError, resolveAskWorkTask } from '../lib/ask-work-plan.js'

const WORK_ID = /^task:[a-z_]+:[a-f0-9]{12}$/
const MEETING_ID = /^meeting:[^\u0000-\u001f]{1,250}$/
export const ORCHESTRATOR_BODY_BYTES = 4_000_000

export interface WorkOrchestratorDeps {
  putSnapshot: (s: ControlSnapshot) => void
  input: (workID: string, meetingWorkIDs: string[]) => Promise<OrchestratorInput>
  usage: (refresh: boolean) => Promise<UsageView[]>
  plan: (refresh: boolean) => Promise<PlanPane>
  now: () => number
  board: () => Promise<TaskBoardRow[]>
  serverInstanceId: () => string | null
  admissions: () => boolean
  lease: () => { release(): void }
  writeDesktopFeed: (reading: FeedReading) => void
}

/** GET /usage reads on demand: a reading older than 10 minutes is re-read (`refresh=1`: 2 minutes). */
export const readUsage = (refresh: boolean, monitor: UsageMonitor = orchestratorUsage()): Promise<UsageView[]> => monitor.onDemand(refresh)
/** GET /usage/plan: the same on-demand read, then the ruler's lines (plan-pane.ts). */
export const readPlan = async (refresh: boolean, monitor: UsageMonitor = orchestratorUsage(), now: () => number = Date.now,
  feeds: () => PlanFeeds = () => ({ cli: readFeed('cli'), desktop: readFeed('desktop') })): Promise<PlanPane> => {
  await monitor.onDemand(refresh, true) // the plan ruler: the one route that reads Cursor (Usage open and Refresh)
  // 7.0.54: the passive Claude readings (local files, no network): the CLI's status line and the Desktop app's.
  return planPane(USAGE_PROVIDERS.map(p => monitor.entry(p)), now(), undefined, monitor.cursorPlanOn(), feeds())
}

const DEFAULTS: WorkOrchestratorDeps = {
  putSnapshot: s => orchestratorSnapshots().put(s),
  input: orchestratorInputFor,
  usage: refresh => readUsage(refresh),
  plan: refresh => readPlan(refresh),
  now: () => Date.now(),
  board: () => createWorkBoardReader(() => listBoard()).read(0),
  serverInstanceId: getServerInstanceId,
  admissions: maintenanceAdmissionsOpen,
  lease: () => acquireMaintenanceWork('api_mutation'),
  writeDesktopFeed: reading => writeDesktopFeed(reading),
}

export function createWorkOrchestratorRouter(given: Partial<WorkOrchestratorDeps> = {}) {
  const deps = { ...DEFAULTS, ...given }
  const router = Router()
  router.use('/work/orchestrator', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  router.post('/work/orchestrator/snapshot', async (req, res) => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['workID', 'revision', 'serverInstanceId', 'snapshot'].includes(k))
      || typeof body.workID !== 'string' || body.workID.length > 256 || !WORK_ID.test(body.workID)
      || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)
      || typeof body.serverInstanceId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.serverInstanceId)) {
      return res.status(400).json({ error: 'invalid_snapshot_binding' })
    }
    if (Buffer.byteLength(JSON.stringify(body)) > ORCHESTRATOR_BODY_BYTES) return res.status(413).json({ error: 'snapshot_too_large' })
    let snapshot: ControlSnapshot, droppedLiveRows: number
    try { ({ snapshot, droppedLiveRows } = parseSnapshotReport(body.snapshot, deps.now())) }
    catch { return res.status(400).json({ error: 'invalid_snapshot' }) }
    const binding = () => {
      const id = deps.serverInstanceId()
      if (!id) throw new AskWorkPlanError('server_instance_unavailable', 503)
      if (id !== body.serverInstanceId) throw new AskWorkPlanError('server_instance_changed', 409)
      if (!deps.admissions()) throw new AskWorkPlanError('maintenance', 503)
      return id
    }
    let lease: ReturnType<WorkOrchestratorDeps['lease']> | undefined
    try {
      binding()
      lease = deps.lease()
      let rows: TaskBoardRow[]
      try { rows = await deps.board() }
      catch { throw new AskWorkPlanError('work_board_unavailable', 503) }
      resolveAskWorkTask(body, rows)
      const serverInstanceId = binding()
      if (res.destroyed) return
      // This is the same paired-client evidence cache as /input, not execution authority. parseSnapshot
      // retains only its known fields; arbitrary automatic/forkable/capability fields never enter the cache.
      deps.putSnapshot(snapshot)
      if (droppedLiveRows) console.warn(`[work-orchestrator] snapshot work=${body.workID} droppedLiveRows=${droppedLiveRows}`)
      return res.json({ protocolVersion: 1, accepted: true, workID: body.workID, revision: body.revision, serverInstanceId,
        ...(droppedLiveRows ? { droppedLiveRows } : {}) })
    } catch (error) {
      if (res.destroyed) return
      const known = error instanceof AskWorkPlanError
      return res.status(known ? error.status : 503).json({ error: known ? error.code : 'snapshot_unavailable' })
    } finally { lease?.release() }
  })
  router.post('/work/orchestrator/input', async (req, res) => {
    const body = req.body
    const meetings: unknown = body?.meetingWorkIDs ?? []
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['workID', 'meetingWorkIDs', 'snapshot'].includes(k))
      || typeof body.workID !== 'string' || !WORK_ID.test(body.workID)
      || !Array.isArray(meetings) || meetings.length > 20 || !meetings.every(m => typeof m === 'string' && MEETING_ID.test(m))) {
      return res.status(400).json({ error: 'invalid_orchestrator_input' })
    }
    // 7.0.13: live rows the snapshot left out (a short or malformed session id, or text over a bound). Reported in the
    // answer and the log line only when a snapshot came with this request and something was left out.
    let droppedLiveRows = 0
    if ('snapshot' in body) {
      if (Buffer.byteLength(JSON.stringify(body.snapshot)) > ORCHESTRATOR_BODY_BYTES) return res.status(413).json({ error: 'snapshot_too_large' })
      let snapshot: ControlSnapshot
      try { ({ snapshot, droppedLiveRows } = parseSnapshotReport(body.snapshot, deps.now())) } catch (e) { return res.status(400).json({ error: 'invalid_snapshot', reason: (e as Error).message }) }
      deps.putSnapshot(snapshot)
    }
    try {
      const input = await deps.input(body.workID, meetings as string[])
      console.log(`[work-orchestrator] input work=${body.workID} rows=${input.rows.length} discovered=${input.discovered} leftOut=${input.leftOut.length} snapshotAge=${input.snapshotAgeSec ?? '-'}s liveAge=${input.liveListAgeSec ?? '-'}s scan=${input.logScanComplete ? 'complete' : 'partial'}${droppedLiveRows ? ` droppedLiveRows=${droppedLiveRows}` : ''}`)
      return res.json(droppedLiveRows ? { ...input, droppedLiveRows } : input)
    } catch (e) {
      console.warn(`[work-orchestrator] input failed for ${body.workID}: ${(e as Error).message}`)
      return res.status(503).json({ error: 'orchestrator_input_unavailable' })
    }
  })
  router.get('/work/orchestrator/usage', async (req, res) => {
    try { return res.json({ protocolVersion: 1, now: new Date(deps.now()).toISOString(), usage: await deps.usage(req.query.refresh === '1') }) }
    catch { return res.status(503).json({ error: 'usage_unavailable' }) }
  })
  // 7.0.54 (Miles 2026-11-17): a desktop session posts the Claude Desktop app's own usage tool reply here (its plan and
  // weekly windows). Behind the API token like every /api route. Checked field by field and written atomically; the
  // reply's session context and anything else are dropped. No timer posts it.
  router.post('/usage/feed/claude-desktop', (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    // Q1 07:38: the token only. A signed-in Control Web cookie passes the /api gate too, and a browser tab must not write
    // this reading (the same rule as session-hooks.ts and native-mac-caller.ts).
    if (res.locals?.[API_AUTH_BY_LOCAL] !== 'token') return res.status(403).json({ error: 'token_required' })
    // The real reply is about 500 bytes; the global JSON parser allows 10 MB, so the route sets its own cap.
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > MAX_FEED_BYTES) return res.status(413).json({ error: 'reading_too_large' })
    try {
      const reading = desktopReadingFromTool(req.body, deps.now())
      deps.writeDesktopFeed(reading)
      return res.json({ ok: true, at: reading.at, plan: reading.plan, windows: reading.windows.length })
    } catch (error) {
      if (error instanceof FeedError) return res.status(400).json({ error: 'invalid_reading', reason: error.code })
      return res.status(503).json({ error: 'usage_feed_unavailable' })
    }
  })
  router.get('/usage/plan', async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    try { return res.json(await deps.plan(req.query.refresh === '1')) }
    catch { return res.status(503).json({ error: 'usage_plan_unavailable' }) }
  })
  return router
}
