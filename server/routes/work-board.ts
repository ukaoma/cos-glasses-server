import { Router } from 'express'
import { readWorkJournal, projectWorkActivity, projectOpenWork, savedDestinationFor, controlSnapshotRevision,
  type WorkActivityCapabilities, type WorkActivityResult } from '../lib/work-activity.js'
import { listBoard, workBoardCapabilities, setTaskWorkStage, linkTaskMeeting, TaskRunError, TaskBridgeError,
  WORK_STAGES, type WorkStage, type WorkMeetingRef, type TaskBoardRow } from '../lib/task-store.js'
import { createWorkBoardReader, WORK_BOARD_READ_LIMITS, WorkBoardTimeoutError, type WorkBoardReader } from '../lib/work-board-reader.js'
import type { MeetingDescriptor } from '../lib/work-review-store.js'
import { isSafeDomainName } from '../lib/domains.js'
import { resolveSavedMeetingDetail } from './meetings.js'
import type { MeetingDetail } from '../lib/meeting-store.js'

export interface WorkBoardDependencies {
  /** The native journal reader. It takes no request-derived argument: there is no request-supplied path. */
  journal: () => ReturnType<typeof readWorkJournal>
  list: typeof listBoard
  capabilities: typeof workBoardCapabilities
  stage: typeof setTaskWorkStage
  link: typeof linkTaskMeeting
  resolveMeeting: (descriptor: MeetingDescriptor) => MeetingDetail | Promise<MeetingDetail>
  /** 6.59.0: the handoff request inbox as the glasses should see it (lib/work-handoff-requests.ts handoffRequestCapabilities). */
  requests: () => Pick<WorkActivityCapabilities, 'requests' | 'requestsInbox' | 'requestsConsumerSeenAt'>
  /** 6.59.0: the bounded, shared board read (5 s). Defaults to one over `list`. */
  readBoard?: WorkBoardReader<TaskBoardRow>
  now: () => number
}
const defaults: WorkBoardDependencies = { journal: () => readWorkJournal(), list: listBoard, capabilities: workBoardCapabilities,
  stage: setTaskWorkStage, link: linkTaskMeeting, resolveMeeting: resolveSavedMeetingDetail,
  requests: () => ({ requests: 0, requestsInbox: 0, requestsConsumerSeenAt: null }), now: () => Date.now() }
/** How old a board read the activity and open-work glances accept (the reader shares one read between them). */
export const WORK_GLANCE_BOARD_AGE_MS = 10_000

/** Auth is supplied by the parent /api mount. No provider execution occurs here. */
export function createWorkBoardRouter(overrides: Partial<WorkBoardDependencies> = {}): Router {
  const deps = { ...defaults, ...overrides }, router = Router()
  const board = deps.readBoard ?? createWorkBoardReader(() => deps.list())
  router.use('/work-board', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  const fail = (res: import('express').Response, e: unknown) => {
    const status = e instanceof TaskRunError ? e.status : e instanceof TaskBridgeError ? (e.code === 'task_not_found' ? 404 : 409) : 503
    return res.status(status).json({ error: { code: e instanceof TaskRunError || e instanceof TaskBridgeError ? e.code : 'work_board_unavailable', message: e instanceof TaskRunError || e instanceof TaskBridgeError ? e.message : 'Work board is unavailable. Refresh before trying again.' } })
  }
  const activityCapabilities = (): WorkActivityCapabilities => ({ progress: 1, ...deps.requests() })
  /** The board within its bound, or null: the glances answer without it rather than keep the glasses waiting. */
  const glanceBoard = async (where: string, timeoutMs?: number): Promise<TaskBoardRow[] | null> => {
    try { return await board.read(WORK_GLANCE_BOARD_AGE_MS, timeoutMs) }
    catch (e) {
      const cause = e instanceof WorkBoardTimeoutError ? 'work_board_timeout' : e instanceof TaskRunError || e instanceof TaskBridgeError ? e.code : 'work_board_unavailable'
      console.warn(`[work-board] ${where}: answered without the board (${cause})`)
      return null
    }
  }
  router.get('/work-board/activity', async (req, res) => {
    const { domain, workIdentity } = req.query
    if (Object.keys(req.query).some(key => !['domain', 'workIdentity'].includes(key))
      || typeof domain !== 'string' || !isSafeDomainName(domain)
      || typeof workIdentity !== 'string' || !/^[a-f0-9]{12}$/.test(workIdentity)) {
      return res.status(400).json({ error: { code: 'invalid_work_identity', message: 'Select an exact task and domain.' } })
    }
    const capabilities = activityCapabilities(), journal = deps.journal()
    // The task's revision and saved destination need its board row. Past the 5 s bound (or with no board) the activity
    // still answers, without them.
    // S4's budget is 3 s: the progress answers on time with or without the board.
    const row = (await glanceBoard('activity', WORK_BOARD_READ_LIMITS.savedDestinationMs))?.find(r => r.domain === domain && (r.workIdentity || r.id) === workIdentity)
    const taskRevision = row ? { taskRevision: controlSnapshotRevision(row) } : {}
    if (!journal.available) return res.json({ version: 1, available: false, reason: journal.reason, capabilities, activities: [], ...taskRevision } satisfies WorkActivityResult)
    const result: WorkActivityResult = { version: 1, available: true, capabilities, activities: projectWorkActivity(journal, domain, workIdentity), ...taskRevision }
    const destination = row ? savedDestinationFor(journal, row) : undefined
    if (destination) result.savedDestination = destination
    return res.json(result)
  })
  // S2: every open handoff across the board, needs input first. Read-only: no provider call, no Jev.
  router.get('/work-board/activity/open', async (req, res) => {
    if (Object.keys(req.query).length) return res.status(400).json({ error: { code: 'invalid_open_activity_request', message: 'This list takes no parameters.' } })
    const capabilities = activityCapabilities(), journal = deps.journal()
    if (!journal.available) return res.json({ version: 1, available: false, reason: journal.reason, capabilities, items: [], total: 0, truncated: false })
    const rows = await glanceBoard('open work')
    if (!rows) return res.json({ version: 1, available: false, reason: 'Work board is unavailable. Refresh before trying again.', capabilities, items: [], total: 0, truncated: false })
    return res.json({ version: 1, available: true, capabilities, ...projectOpenWork(journal, rows, deps.now()) })
  })
  router.get('/work-board', async (_req, res) => {
    try {
      const readStartedAt = deps.now()
      const [raw, capabilities] = await Promise.all([deps.list(), deps.capabilities()])
      board.prime(raw, readStartedAt)
      // 6.59.0: taskRevision is this task's own revision (COS Control's taskSnapshot), what a handoff request names.
      const tasks = raw.map(row => ({ ...row, workStage: row.checked ? 'complete' : row.workStage ?? (row.stage === 'active' ? 'draft' : row.stage === 'review' ? 'qa' : 'planned'), workIdentity: row.workIdentity || row.id, meetingRefs: row.meetingRefs ?? [], taskRevision: controlSnapshotRevision(row) }))
      res.json({ tasks, capabilities, complete: true })
    }
    catch (e) { fail(res, e) }
  })
  for (const action of ['stage', 'meeting'] as const) router.post('/work-board/' + action, async (req, res) => {
    try {
      const body = req.body
      const keys = ['domain', 'id', 'expectedText', 'expectedRevision', action === 'stage' ? 'workStage' : 'meeting']
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))
        || Buffer.byteLength(JSON.stringify(body)) > 16_384 || !['domain','id','expectedText','expectedRevision'].every(k => typeof body[k] === 'string')
        || !isSafeDomainName(body.domain) || !/^[a-f0-9]{12}$/.test(body.id)
        || !body.expectedText || body.expectedText.length > 8000 || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
        throw new TaskRunError(400, 'invalid_work_update', 'Refresh and select an exact task before changing Work')
      }
      const capability = await deps.capabilities()
      if (capability.version !== 1 || !capability.writable) throw new TaskRunError(409, 'work_board_read_only', 'The canonical task bridge needs a compatible update')
      if (action === 'stage') {
        if (!WORK_STAGES.includes(body.workStage as WorkStage)) throw new TaskRunError(422, 'invalid_work_stage', 'Choose a valid Work stage')
        await deps.stage(body.domain, body.id, body.workStage, body.expectedText, body.expectedRevision)
      } else {
        const input = body.meeting
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || typeof input.domain !== 'string' || !isSafeDomainName(input.domain)
          || typeof input.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)
          || typeof input.filename !== 'string' || input.filename.length > 255 || !/^[^/\\\x00-\x1f\x7f]+\.md$/.test(input.filename)
          || typeof input.recordId !== 'string' || !input.recordId || input.recordId.length > 512 || /[\x00-\x1f\x7f]/.test(input.recordId)) throw new TaskRunError(400, 'invalid_meeting', 'Select a saved meeting')
        const descriptor: MeetingDescriptor = { domain: input.domain, month: input.month, filename: input.filename, recordId: input.recordId }
        if (!descriptor.recordId) throw new TaskRunError(400, 'meeting_identity_required', 'Refresh and select the exact saved meeting')
        const resolved = await deps.resolveMeeting(descriptor)
        if (resolved.recordId !== descriptor.recordId) throw new TaskRunError(409, 'meeting_identity_changed', 'The selected meeting changed; refresh before linking')
        const meeting: WorkMeetingRef = { ...descriptor, recordId: resolved.recordId, title: resolved.title.replace(/\s+/g, ' ').trim().slice(0, 300) }
        await deps.link(body.domain, body.id, body.expectedText, body.expectedRevision, meeting)
      }
      res.json({ ok: true })
    } catch (e) { fail(res, e) }
  })
  return router
}
