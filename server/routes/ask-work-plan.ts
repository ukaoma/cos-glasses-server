/** Mounted under authenticated /api. Plan-only: never records a round, sends a handoff or writes a task. */
import { Router } from 'express'
import { ASK_WORK_PLAN_PROTOCOL, ASK_WORK_PLAN_BODY_BYTES, ASK_WORK_PLAN_DEADLINE_MS, ASK_WORK_PLAN_RULES,
  AskWorkPlanError, parseAskWorkPlanRequest, resolveAskWorkTask, askWorkMeetingIDs, prepareAskWorkPlan, askWorkProposalID } from '../lib/ask-work-plan.js'
import { listBoard, type TaskBoardRow } from '../lib/task-store.js'
import { createWorkBoardReader } from '../lib/work-board-reader.js'
import { orchestratorInputFor } from '../lib/work-orchestrator/runtime.js'
import { runMeetingAskModel } from '../lib/meeting-ask-runner.js'
import { maintenanceAdmissionsOpen, acquireMaintenanceWork } from '../lib/maintenance-lifecycle.js'
import { parseWorkChatAnswer, WORK_CHAT_SYSTEM, WORK_CHAT_ORCHESTRATOR_RULES, WORK_CHAT_PLANNERS, WORK_CHAT_EFFORTS,
  WORK_CHAT_DEFAULT_EFFORT, WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS, WORK_CHAT_THINKING_TOKENS,
  WORK_CHAT_DEADLINE_MS, WORK_CHAT_MAX_ASSIGNMENTS } from '../lib/work-chat.js'

export interface AskWorkPlanDeps {
  board: () => Promise<TaskBoardRow[]>
  input: typeof orchestratorInputFor
  run: typeof runMeetingAskModel
  admissions: () => boolean
  lease: () => { release(): void }
  now: () => number
}
const defaults: AskWorkPlanDeps = {
  // A new reader guarantees the post-plan revision check starts a new bounded board read.
  board: () => createWorkBoardReader(() => listBoard()).read(0), input: orchestratorInputFor, run: runMeetingAskModel,
  admissions: maintenanceAdmissionsOpen, lease: () => acquireMaintenanceWork('work_chat'), now: Date.now,
}

/** Stop waiting on bounded read dependencies on disconnect; those read-only dependencies may finish their own work. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AskWorkPlanError('ask_work_plan_canceled', 408))
    if (signal.aborted) { promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createAskWorkPlanRouter(given: Partial<AskWorkPlanDeps> = {}) {
  const deps = { ...defaults, ...given }, router = Router()
  let running = false
  router.use('/ask/work-plan', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  router.get('/ask/work-plan', (_req, res) => res.json({ protocolVersion: ASK_WORK_PLAN_PROTOCOL, planOnly: true,
    requiresExistingWork: true, dispatch: false, planner: 'sonnet', planners: WORK_CHAT_PLANNERS,
    effort: WORK_CHAT_DEFAULT_EFFORT, efforts: WORK_CHAT_EFFORTS, maxAssignments: WORK_CHAT_MAX_ASSIGNMENTS,
    maxQuestionChars: 2000, maxBodyBytes: ASK_WORK_PLAN_BODY_BYTES }))
  router.post('/ask/work-plan', async (req, res) => {
    const fail = (error: unknown) => {
      const known = error instanceof AskWorkPlanError
      if (!res.destroyed) res.status(known ? error.status : 503).json({ error: known ? error.code : 'ask_work_plan_unavailable',
        message: 'No assignment was dispatched. Refresh the task and retry the plan.' })
    }
    let request
    try { request = parseAskWorkPlanRequest(req.body) } catch (error) { fail(error); return }
    if (!deps.admissions()) { fail(new AskWorkPlanError('maintenance', 503)); return }
    if (running) { fail(new AskWorkPlanError('ask_work_plan_busy', 409)); return }
    running = true
    const controller = new AbortController(), abort = () => controller.abort()
    const timer = setTimeout(abort, ASK_WORK_PLAN_DEADLINE_MS)
    res.on('close', abort)
    let lease: ReturnType<AskWorkPlanDeps['lease']> | undefined
    try {
      lease = deps.lease()
      let rows: TaskBoardRow[]
      try { rows = await abortable(deps.board(), controller.signal) }
      catch { throw new AskWorkPlanError('work_board_unavailable', 503) }
      const task = resolveAskWorkTask(request, rows)
      let evidence
      try { evidence = await abortable(deps.input(request.workID, askWorkMeetingIDs(task)), controller.signal) }
      catch { throw new AskWorkPlanError('orchestrator_input_unavailable', 503) }
      const prepared = prepareAskWorkPlan(request, task, evidence, deps.now())
      if (controller.signal.aborted) throw new AskWorkPlanError('ask_work_plan_canceled', 408)
      if (!deps.admissions()) throw new AskWorkPlanError('maintenance', 503)
      const { planner = 'sonnet', effort = WORK_CHAT_DEFAULT_EFFORT, ...prompt } = prepared.input
      const output = await abortable(deps.run({ engine: 'claude', model: planner }, JSON.stringify(prompt),
        WORK_CHAT_SYSTEM + '\n\n' + WORK_CHAT_ORCHESTRATOR_RULES + '\n\n' + ASK_WORK_PLAN_RULES,
        controller.signal, undefined, { caller: 'ask_work_plan' }, { effort, maxOutputTokens: WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS,
          maxThinkingTokens: WORK_CHAT_THINKING_TOKENS[effort], deadlineMs: WORK_CHAT_DEADLINE_MS }), controller.signal)
      let answer
      try { answer = parseWorkChatAnswer(output.text, prepared.input) }
      catch { throw new AskWorkPlanError('invalid_plan_answer', 503) }
      // A model may take minutes; never return an apparently current proposal for a changed/finished task.
      try { rows = await abortable(deps.board(), controller.signal) }
      catch { throw new AskWorkPlanError('work_board_unavailable', 503) }
      const currentTask = resolveAskWorkTask(request, rows)
      try { evidence = await abortable(deps.input(request.workID, askWorkMeetingIDs(currentTask)), controller.signal) }
      catch { throw new AskWorkPlanError('orchestrator_input_unavailable', 503) }
      const current = prepareAskWorkPlan(request, currentTask, evidence, deps.now())
      // Revalidate every proposed target against current discovery, live state and plan headroom.
      try { answer = parseWorkChatAnswer(output.text, current.input) }
      catch { throw new AskWorkPlanError('plan_targets_changed', 409) }
      if (!res.destroyed) res.json({ protocolVersion: ASK_WORK_PLAN_PROTOCOL, planOnly: true, workID: request.workID,
        revision: request.revision, title: prepared.title, ...answer, evidence: prepared.evidence, revalidatedEvidence: current.evidence,
        proposalID: askWorkProposalID(prepared.input, answer), question: prepared.input.question, createdAt: new Date(deps.now()).toISOString(),
        model: output.model ?? `claude:${planner} (requested)`, effort })
    } catch (error) { fail(error) }
    finally { clearTimeout(timer); res.off('close', abort); lease?.release(); running = false }
  })
  return router
}
