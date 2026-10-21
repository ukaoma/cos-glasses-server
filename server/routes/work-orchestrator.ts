/**
 * 6.83.0 Work orchestrator routes (docs/work-orchestrator.md). Read and plan inputs only: nothing here sends to a
 * session, changes a link or a receipt, or calls a model.
 *
 *   POST /api/work/orchestrator/input  {workID, meetingWorkIDs?, snapshot?}
 *        Stores Control's snapshot when one is sent (Phase A: Control pushes, the server keeps the copy), then answers
 *        the card's planner rows, what was left out and why, and the usage snapshot.
 *   GET  /api/work/orchestrator/usage[?refresh=1]
 *        The usage snapshot per provider, read on demand: Claude and Codex are re-read when their reading is older than
 *        10 minutes (`refresh=1`: 2 minutes). No timer reads usage unless COS_WORK_USAGE_POLL=1.
 */
import { Router } from 'express'
import { parseSnapshot, type ControlSnapshot } from '../lib/work-orchestrator/snapshot.js'
import type { OrchestratorInput } from '../lib/work-orchestrator/input.js'
import type { UsageMonitor, UsageView } from '../lib/work-orchestrator/usage.js'
import { orchestratorInputFor, orchestratorSnapshots, orchestratorUsage } from '../lib/work-orchestrator/runtime.js'

const WORK_ID = /^task:[a-z_]+:[a-f0-9]{12}$/
const MEETING_ID = /^meeting:[^\u0000-\u001f]{1,250}$/
export const ORCHESTRATOR_BODY_BYTES = 4_000_000

export interface WorkOrchestratorDeps {
  putSnapshot: (s: ControlSnapshot) => void
  input: (workID: string, meetingWorkIDs: string[]) => Promise<OrchestratorInput>
  usage: (refresh: boolean) => Promise<UsageView[]>
  now: () => number
}

/** GET /usage reads on demand: a reading older than 10 minutes is re-read (`refresh=1`: 2 minutes). */
export const readUsage = (refresh: boolean, monitor: UsageMonitor = orchestratorUsage()): Promise<UsageView[]> => monitor.onDemand(refresh)

const DEFAULTS: WorkOrchestratorDeps = {
  putSnapshot: s => orchestratorSnapshots().put(s),
  input: orchestratorInputFor,
  usage: refresh => readUsage(refresh),
  now: () => Date.now(),
}

export function createWorkOrchestratorRouter(given: Partial<WorkOrchestratorDeps> = {}) {
  const deps = { ...DEFAULTS, ...given }
  const router = Router()
  router.use('/work/orchestrator', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  router.post('/work/orchestrator/input', async (req, res) => {
    const body = req.body
    const meetings: unknown = body?.meetingWorkIDs ?? []
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['workID', 'meetingWorkIDs', 'snapshot'].includes(k))
      || typeof body.workID !== 'string' || !WORK_ID.test(body.workID)
      || !Array.isArray(meetings) || meetings.length > 20 || !meetings.every(m => typeof m === 'string' && MEETING_ID.test(m))) {
      return res.status(400).json({ error: 'invalid_orchestrator_input' })
    }
    if ('snapshot' in body) {
      if (Buffer.byteLength(JSON.stringify(body.snapshot)) > ORCHESTRATOR_BODY_BYTES) return res.status(413).json({ error: 'snapshot_too_large' })
      let snapshot: ControlSnapshot
      try { snapshot = parseSnapshot(body.snapshot, deps.now()) } catch (e) { return res.status(400).json({ error: 'invalid_snapshot', reason: (e as Error).message }) }
      deps.putSnapshot(snapshot)
    }
    try {
      const input = await deps.input(body.workID, meetings as string[])
      console.log(`[work-orchestrator] input work=${body.workID} rows=${input.rows.length} discovered=${input.discovered} leftOut=${input.leftOut.length} snapshotAge=${input.snapshotAgeSec ?? '-'}s liveAge=${input.liveListAgeSec ?? '-'}s scan=${input.logScanComplete ? 'complete' : 'partial'}`)
      return res.json(input)
    } catch (e) {
      console.warn(`[work-orchestrator] input failed for ${body.workID}: ${(e as Error).message}`)
      return res.status(503).json({ error: 'orchestrator_input_unavailable' })
    }
  })
  router.get('/work/orchestrator/usage', async (req, res) => {
    try { return res.json({ protocolVersion: 1, now: new Date(deps.now()).toISOString(), usage: await deps.usage(req.query.refresh === '1') }) }
    catch { return res.status(503).json({ error: 'usage_unavailable' }) }
  })
  return router
}
