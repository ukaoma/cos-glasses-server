import { createHash, randomUUID } from 'node:crypto'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  type MaintenanceWorkLease,
} from './maintenance-lifecycle.js'
import {
  loadMorningBriefConfig,
  morningBriefPaths,
  type MorningBriefConfig,
} from './morning-brief-config.js'
import { localClock, shiftDay } from './morning-brief-schedule.js'
import {
  QueryJobActiveGenerationError,
  QueryJobAnswerCommittingError,
  QueryJobGenerationOrderError,
  QueryJobIdentityConflictError,
  QueryJobNotFoundError,
  QueryJobPersistenceError,
  QueryJobProviderOrphanFenceError,
  type QueryJobAdmissionResult,
  type QueryJobMutationResult,
} from './query-job-store.js'
import { QueryJobCoordinatorError } from './query-job-coordinator.js'
import {
  DISPATCH_ALLOWED_TOOLS,
  isTerminalQueryJobStatus,
  type QueryJobRequest,
  type QueryJobSnapshot,
} from './query-job-types.js'
import {
  taskDomains,
  TASK_DISPATCH_LIMITS,
  TASK_DISPATCH_WALL_MS,
  TASK_JOB_LOST_MS,
  TASK_LEASE_CEILING_MS,
  TASK_RECONCILE_WALL_MS,
  TASK_TODAY_PURGE_HORIZON_DAYS,
  TaskRunError,
  composeTaskDispatchPrompt,
  findTaskRow,
  isCatchUpDue,
  liveLedgerFor,
  liveTaskReservations,
  loadAllRows,
  loadDispatchCap,
  loadDomainRows,
  loadTaskLedger,
  parseRunAt,
  saveTaskLedger,
  serializeTaskWork,
  setTaskMarker,
  taskDispatchModel,
  taskStorePaths,
  type BridgeTaskRow,
  type TaskDomain,
  type TaskRun,
  type TaskStorePaths,
} from './task-store.js'

export interface TaskDispatcherDeps {
  now?: () => number
  paths?: TaskStorePaths
  submit: (request: QueryJobRequest) => Promise<QueryJobAdmissionResult>
  findByClientGeneration: (clientJobId: string, generation: number) => Promise<QueryJobSnapshot | undefined>
  getSnapshot: (jobId: string) => Promise<QueryJobSnapshot>
  getExecution: (jobId: string) => Promise<{ request: QueryJobRequest }>
  cancel: (jobId: string, generation: number) => Promise<QueryJobMutationResult>
  complete: (jobId: string, input: { text: string }) => Promise<QueryJobMutationResult>
  createSession: () => string
  currentMessageEra: () => string
  currentMessageMax: () => number
  durableJobsEnabled: () => boolean
  admissionsOpen: () => boolean
  loadRows?: (day: string) => Promise<BridgeTaskRow[]>
  setMarker?: (domain: string, id: string, marker: string | null) => Promise<void>
  projectTerminal?: (job: QueryJobSnapshot, request: QueryJobRequest) => Promise<void>
  finishIfActive?: (jobId: string) => void
  acquireDispatchLease?: () => MaintenanceWorkLease
  config?: () => MorningBriefConfig
}

type RestrictedRequest = QueryJobRequest & { dispatch: NonNullable<QueryJobRequest['dispatch']> }

const submitLive = new Set<string>()
let reservedManual = 0
let backgroundSlots = 0
let reconcileCursor = 0
let lastTodayPurgeDay = ''
let bound: TaskDispatcherDeps | null = null

export function bindTaskDispatcher(deps: TaskDispatcherDeps): void {
  bound = deps
}

function requireBound(): TaskDispatcherDeps {
  if (!bound) throw new Error('task dispatcher not bound')
  return bound
}

export function taskClientJobId(taskId: string, day: string, attempt: number, tz: string): string {
  const digest = createHash('sha256').update(`task|${taskId}|${tz}|${day}|${attempt}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function submitKey(taskId: string, day: string, attempt: number): string {
  return `${taskId}|${day}|${attempt}`
}

function nowMs(deps: TaskDispatcherDeps): number {
  return (deps.now ?? Date.now)()
}

function pathsOf(deps: TaskDispatcherDeps): TaskStorePaths {
  return deps.paths ?? taskStorePaths()
}

function configOf(deps: TaskDispatcherDeps): MorningBriefConfig {
  return deps.config?.() ?? loadMorningBriefConfig(morningBriefPaths(), new Date(nowMs(deps))).config
}

function buildTaskRequest(run: TaskRun, tz: string): RestrictedRequest {
  return {
    clientJobId: run.clientJobId,
    generation: 1,
    query: composeTaskDispatchPrompt(run.line, run.day, tz),
    sessionId: run.sessionId,
    model: run.model,
    ...(run.effort ? { effort: run.effort } : {}),
    activityToolMode: 'status',
    attachmentIds: [],
    attachmentRefs: [],
    origin: { kind: 'task', id: run.taskId },
    dispatch: { restricted: true, tools: [...DISPATCH_ALLOWED_TOOLS] },
    ...(run.messageEra ? { messageEra: run.messageEra } : {}),
    ...(run.globalMsgNum != null ? { globalMsgNum: run.globalMsgNum } : {}),
  }
}

function classifySubmitError(error: unknown): 'identity_conflict' | 'adopt' | 'fence' | 'drain' | 'transient' {
  if (error instanceof QueryJobIdentityConflictError) return 'identity_conflict'
  if (error instanceof QueryJobActiveGenerationError || error instanceof QueryJobGenerationOrderError) return 'adopt'
  if (error instanceof QueryJobProviderOrphanFenceError) return 'fence'
  if (error instanceof MaintenanceLifecycleError) return 'drain'
  if (error instanceof QueryJobCoordinatorError && error.code === 'query_job_coordinator_shutting_down') return 'transient'
  return 'transient'
}

async function mintRun(
  deps: TaskDispatcherDeps,
  row: BridgeTaskRow,
  trigger: 'manual' | 'scheduled',
  catchUp: boolean,
): Promise<TaskRun> {
  const config = configOf(deps)
  const clock = localClock(nowMs(deps), config.timezone)
  return serializeTaskWork(() => {
    const paths = pathsOf(deps)
    const ledger = loadTaskLedger(paths)
    if (ledger.some(run => run.taskId === row.id && run.day === clock.day && (run.status === 'dispatching' || run.status === 'running'))) {
      throw new TaskRunError(409, 'task_running', 'A run is already in flight for this task.')
    }
    const attempt = 1 + ledger.filter(run => run.taskId === row.id && run.day === clock.day).length
    const model = taskDispatchModel(config)
    const run: TaskRun = {
      id: randomUUID(),
      identity: `${row.id}|${clock.day}|${attempt}`,
      taskId: row.id,
      ref: row.ref,
      domain: row.domain as TaskDomain,
      line: row.description,
      ...(row.run_at ? { scheduledFor: row.run_at } : {}),
      day: clock.day,
      attempt,
      trigger,
      firedAt: new Date(nowMs(deps)).toISOString(),
      clientJobId: taskClientJobId(row.id, clock.day, attempt, config.timezone),
      generation: 1,
      sessionId: deps.createSession(),
      messageEra: deps.currentMessageEra(),
      globalMsgNum: deps.currentMessageMax() + 1,
      status: 'dispatching',
      submitAttempts: 0,
      retryAfter: nowMs(deps) + TASK_DISPATCH_WALL_MS,
      ...(catchUp ? { catchUp: true } : {}),
      model,
      activityToolMode: 'status',
    }
    saveTaskLedger(paths, [...ledger, run])
    return run
  })
}

async function persistRun(deps: TaskDispatcherDeps, runId: string, patch: Partial<TaskRun>): Promise<TaskRun | undefined> {
  return serializeTaskWork(() => {
    const paths = pathsOf(deps)
    const ledger = loadTaskLedger(paths)
    const index = ledger.findIndex(run => run.id === runId)
    if (index < 0) return undefined
    const next = { ...ledger[index], ...patch }
    ledger[index] = next
    saveTaskLedger(paths, ledger)
    return next
  })
}

async function adoptOrSubmit(deps: TaskDispatcherDeps, run: TaskRun): Promise<TaskRun> {
  const config = configOf(deps)
  const key = submitKey(run.taskId, run.day, run.attempt)
  const found = await deps.findByClientGeneration(run.clientJobId, 1).catch(() => undefined)
  if (found && !isTerminalQueryJobStatus(found.status)) {
    const accepted = await persistRun(deps, run.id, {
      jobId: found.jobId,
      generation: 1,
      lastKnownStatus: found.status,
      status: 'running',
    })
    return accepted ?? { ...run, jobId: found.jobId, status: 'running', lastKnownStatus: found.status }
  }

  submitLive.add(key)
  try {
    const admission = await deps.submit(buildTaskRequest(run, config.timezone))
    const accepted = await persistRun(deps, run.id, {
      jobId: admission.job.jobId,
      generation: 1,
      lastKnownStatus: admission.job.status,
      status: 'running',
    })
    return accepted ?? { ...run, jobId: admission.job.jobId, status: 'running', lastKnownStatus: admission.job.status }
  } catch (error) {
    const kind = classifySubmitError(error)
    if (kind === 'identity_conflict') {
      const failed = await persistRun(deps, run.id, {
        status: 'failed',
        error: { code: 'identity_conflict', message: error instanceof Error ? error.message : 'identity conflict' },
        completedAt: new Date(nowMs(deps)).toISOString(),
      })
      throw new TaskRunError(503, 'identity_conflict', failed?.error?.message ?? 'identity conflict')
    }
    if (kind === 'adopt') {
      const existing = await deps.findByClientGeneration(run.clientJobId, 1).catch(() => undefined)
      if (existing && !isTerminalQueryJobStatus(existing.status)) {
        const accepted = await persistRun(deps, run.id, {
          jobId: existing.jobId,
          lastKnownStatus: existing.status,
          status: 'running',
        })
        return accepted ?? run
      }
    }
    const fenceMs = error instanceof QueryJobProviderOrphanFenceError ? error.retryAfterMs : TASK_DISPATCH_LIMITS.submitSpacingMs
    const consume = kind !== 'drain'
    await persistRun(deps, run.id, {
      status: 'dispatching',
      retryAfter: nowMs(deps) + fenceMs,
      ...(consume ? { submitAttempts: run.submitAttempts + 1 } : {}),
    })
    throw new TaskRunError(503, kind === 'drain' ? 'admissions_closed' : 'submit_failed', error instanceof Error ? error.message : 'submit failed')
  } finally {
    submitLive.delete(key)
  }
}

async function markRunning(deps: TaskDispatcherDeps, run: TaskRun): Promise<void> {
  const setMarker = deps.setMarker ?? setTaskMarker
  await setMarker(run.domain, run.taskId, 'running')
}

function pickEligible(
  rows: BridgeTaskRow[],
  ledger: TaskRun[],
  day: string,
  now: number,
  tz: string,
  catchUpMinutes: number,
  capPerDay: number,
): BridgeTaskRow[] {
  const todayRuns = ledger.filter(run => run.day === day)
  if (todayRuns.length >= capPerDay) return []
  return rows.filter(row => {
    if (row.archived || row.delegated || row.is_checked) return false
    if (!isCatchUpDue(row, now, tz, catchUpMinutes)) return false
    if (row.agent_state === 'running') return false
    const inDay = todayRuns.filter(run => run.taskId === row.id)
    if (inDay.some(run => run.status === 'dispatching' || run.status === 'running')) return false
    if (inDay.some(run => run.status === 'failed' && run.error?.code === 'submit_exhausted')) return false
    if (inDay.length >= TASK_DISPATCH_LIMITS.runsPerDay) return false
    const latest = [...inDay].sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]
    if (latest && now - Date.parse(latest.firedAt) < TASK_DISPATCH_LIMITS.runSpacingMs) return false
    return true
  })
}

function acquireSlots(kind: 'manual' | 'background'): void {
  if (kind === 'manual') {
    if (reservedManual >= 1) throw new TaskRunError(503, 'dispatch_slots_busy', 'Another manual run is already using the reserved slot.')
    reservedManual += 1
    return
  }
  if (backgroundSlots >= TASK_DISPATCH_LIMITS.perTick) {
    throw new TaskRunError(503, 'dispatch_slots_busy', 'Background dispatch slots are busy.')
  }
  backgroundSlots += 1
}

function releaseSlots(kind: 'manual' | 'background'): void {
  if (kind === 'manual') reservedManual = Math.max(0, reservedManual - 1)
  else backgroundSlots = Math.max(0, backgroundSlots - 1)
}

function withLease<T>(deps: TaskDispatcherDeps, work: (remaining: () => number) => Promise<T>): Promise<T> {
  let lease: MaintenanceWorkLease
  try {
    lease = deps.acquireDispatchLease?.() ?? acquireMaintenanceWork('task_dispatch')
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) {
      return Promise.reject(new TaskRunError(503, 'admissions_closed', 'The server is in maintenance. Try again in a moment.'))
    }
    throw error
  }
  const started = Date.now()
  const remaining = () => Math.max(0, TASK_DISPATCH_WALL_MS - (Date.now() - started))
  let released = false
  const release = () => {
    if (released) return
    released = true
    lease.release()
  }
  const timer = setTimeout(release, TASK_LEASE_CEILING_MS)
  return work(remaining).finally(() => {
    clearTimeout(timer)
    release()
  })
}

export async function runTaskNow(id: string, domain: string, injected?: TaskDispatcherDeps): Promise<{ runId: string }> {
  const deps = injected ?? requireBound()
  if (!deps.durableJobsEnabled()) {
    throw new TaskRunError(409, 'durable_jobs_off', 'Turn on Background jobs in COS Control to run a task.')
  }
  if (!deps.admissionsOpen()) {
    throw new TaskRunError(503, 'admissions_closed', 'The server is in maintenance. Try again in a moment.')
  }
  const config = configOf(deps)
  const clock = localClock(nowMs(deps), config.timezone)
  if (liveLedgerFor(id, clock.day, pathsOf(deps))) {
    throw new TaskRunError(409, 'task_running', 'A run is already in flight for this task.')
  }
  const row = deps.loadRows
    ? (await deps.loadRows(clock.day)).find(item => item.id === id && item.domain === domain)
    : await findTaskRow(domain, id, clock.day)
  if (!row) throw new TaskRunError(404, 'task_not_found', `no task ${id} in ${domain}`)
  if (row.agent_state === 'running') {
    throw new TaskRunError(409, 'task_running', 'A run is already in flight for this task.')
  }
  const runAt = parseRunAt(row.run_at)
  if (runAt && runAt.day > clock.day) {
    throw new TaskRunError(409, 'scheduled_future', 'Run now is not allowed on a future scheduled task.')
  }
  const todayRuns = loadTaskLedger(pathsOf(deps)).filter(run => run.taskId === id && run.day === clock.day)
  if (todayRuns.length >= TASK_DISPATCH_LIMITS.runsPerDay) {
    throw new TaskRunError(429, 'runs_exhausted', `Run now is limited to ${TASK_DISPATCH_LIMITS.runsPerDay} attempts a day.`)
  }
  try {
    acquireSlots('manual')
  } catch (error) {
    if (error instanceof TaskRunError && error.code === 'dispatch_slots_busy') {
      const live = liveLedgerFor(id, clock.day, pathsOf(deps))
      if (live) throw new TaskRunError(409, 'task_running', 'A run is already in flight for this task.')
    }
    throw error
  }
  try {
    return await withLease(deps, async () => {
      const minted = await mintRun(deps, row, 'manual', false)
      const running = await adoptOrSubmit(deps, minted)
      await markRunning(deps, running)
      return { runId: running.id }
    })
  } finally {
    releaseSlots('manual')
  }
}

export async function dispatchDueTasks(injected?: TaskDispatcherDeps): Promise<{ fired: number; reason?: string }> {
  const deps = injected ?? requireBound()
  if (!deps.durableJobsEnabled()) return { fired: 0, reason: 'durable_jobs_off' }
  if (!deps.admissionsOpen()) return { fired: 0, reason: 'admissions_closed' }
  const config = configOf(deps)
  const clock = localClock(nowMs(deps), config.timezone)
  const cap = loadDispatchCap(pathsOf(deps))
  if (cap === 0) return { fired: 0, reason: 'cap_off' }
  try {
    return await withLease(deps, async () => {
      const rows = await (deps.loadRows ?? loadAllRows)(clock.day)
      const ledger = loadTaskLedger(pathsOf(deps))
      const eligible = pickEligible(rows, ledger, clock.day, nowMs(deps), config.timezone, config.taskCatchUpMinutes, cap)
      let fired = 0
      for (const row of eligible) {
        if (fired >= TASK_DISPATCH_LIMITS.perTick) break
        if (backgroundSlots >= TASK_DISPATCH_LIMITS.perTick) break
        try {
          acquireSlots('background')
          const minted = await mintRun(deps, row, 'scheduled', true)
          const running = await adoptOrSubmit(deps, minted)
          await markRunning(deps, running)
          fired += 1
        } catch (error) {
          if (error instanceof TaskRunError && (error.code === 'task_running' || error.code === 'dispatch_slots_busy' || error.code === 'admissions_closed')) {
            break
          }
        } finally {
          releaseSlots('background')
        }
      }
      return { fired }
    })
  } catch (error) {
    if (error instanceof TaskRunError && error.code === 'admissions_closed') {
      return { fired: 0, reason: 'maintenance_drain_active' }
    }
    throw error
  }
}

async function saveRow(deps: TaskDispatcherDeps, next: TaskRun): Promise<void> {
  await serializeTaskWork(() => {
    const paths = pathsOf(deps)
    const ledger = loadTaskLedger(paths)
    const index = ledger.findIndex(run => run.id === next.id)
    if (index >= 0) ledger[index] = next
    else ledger.push(next)
    saveTaskLedger(paths, ledger)
  })
}

async function decideDispatchingAction(
  deps: TaskDispatcherDeps,
  run: TaskRun,
  day: string,
): Promise<'redrive' | 'done'> {
  return serializeTaskWork(() => {
    const paths = pathsOf(deps)
    const ledger = loadTaskLedger(paths)
    const current = ledger.find(item => item.id === run.id)
    if (!current || current.status !== 'dispatching') return 'done'
    if (current.day !== day) {
      const index = ledger.findIndex(item => item.id === run.id)
      ledger[index] = {
        ...current,
        status: 'failed',
        error: { code: 'expired', message: 'Dispatch expired' },
        completedAt: new Date(nowMs(deps)).toISOString(),
      }
      saveTaskLedger(paths, ledger)
      return 'done'
    }
    if (current.submitAttempts >= TASK_DISPATCH_LIMITS.submitAttempts && !current.jobId) {
      const index = ledger.findIndex(item => item.id === run.id)
      ledger[index] = {
        ...current,
        status: 'failed',
        error: { code: 'submit_exhausted', message: 'Submit exhausted' },
        completedAt: new Date(nowMs(deps)).toISOString(),
      }
      saveTaskLedger(paths, ledger)
      return 'done'
    }
    if (submitLive.has(submitKey(current.taskId, current.day, current.attempt))) return 'done'
    if (current.retryAfter && current.retryAfter > nowMs(deps)) return 'done'
    return 'redrive'
  })
}

async function reconcileOne(
  deps: TaskDispatcherDeps,
  run: TaskRun,
  rows: BridgeTaskRow[],
  day: string,
): Promise<void> {
  const setMarker = deps.setMarker ?? setTaskMarker
  const row = rows.find(item => item.id === run.taskId)

  if (run.status === 'running') {
    if (!row) {
      await saveRow(deps, { ...run, status: 'orphaned', error: { code: 'orphaned', message: 'Task row gone' }, completedAt: new Date(nowMs(deps)).toISOString() })
      return
    }
    if (row.agent_state !== 'running' && run.scheduledFor && row.run_at && row.run_at !== run.scheduledFor && run.jobId) {
      try {
        const result = await deps.cancel(run.jobId, run.generation)
        if (result.applied) {
          await saveRow(deps, { ...run, status: 'superseded', error: { code: 'superseded', message: 'Rescheduled before it ran' }, completedAt: new Date(nowMs(deps)).toISOString() })
          return
        }
        if (result.job.status === 'completed') {
          await saveRow(deps, { ...run, status: 'done', completedAt: result.job.completedAt ?? new Date(nowMs(deps)).toISOString() })
          return
        }
        if (result.job.status === 'failed' || result.job.status === 'canceled' || result.job.status === 'interrupted') {
          await saveRow(deps, {
            ...run,
            status: 'superseded',
            error: { code: result.job.status, message: result.job.error?.message ?? result.job.status },
            completedAt: new Date(nowMs(deps)).toISOString(),
          })
          return
        }
      } catch (error) {
        if (error instanceof QueryJobAnswerCommittingError && run.jobId) {
          const snapshot = await deps.getSnapshot(run.jobId).catch(() => undefined)
          const completed = await deps.complete(run.jobId, { text: snapshot?.response ?? snapshot?.partialText ?? '' })
          const execution = await deps.getExecution(run.jobId).catch(() => undefined)
          if (execution) await deps.projectTerminal?.(completed.job, execution.request)
          deps.finishIfActive?.(run.jobId)
          await saveRow(deps, { ...run, status: 'done', completedAt: completed.job.completedAt ?? new Date(nowMs(deps)).toISOString() })
          return
        }
        if (error instanceof QueryJobNotFoundError) {
          await saveRow(deps, { ...run, status: 'orphaned', error: { code: 'orphaned', message: 'Job not found' }, completedAt: new Date(nowMs(deps)).toISOString() })
          return
        }
        if (error instanceof QueryJobPersistenceError) return
      }
      return
    }
    if (row.agent_state !== 'running') {
      try {
        await setMarker(run.domain, run.taskId, 'running')
      } catch {
        /* next pass */
      }
      return
    }
    if (!run.jobId) {
      if (nowMs(deps) - Date.parse(run.firedAt) > TASK_JOB_LOST_MS) {
        await saveRow(deps, { ...run, status: 'failed', error: { code: 'job_lost', message: 'Job lost' }, completedAt: new Date(nowMs(deps)).toISOString() })
        await setMarker(run.domain, run.taskId, 'failed').catch(() => undefined)
      }
      return
    }
    const snapshot = await deps.getSnapshot(run.jobId).catch(() => undefined)
    if (!snapshot) {
      if (nowMs(deps) - Date.parse(run.firedAt) > TASK_JOB_LOST_MS) {
        await saveRow(deps, { ...run, status: 'failed', error: { code: 'job_lost', message: 'Job lost' }, completedAt: new Date(nowMs(deps)).toISOString() })
        await setMarker(run.domain, run.taskId, 'failed').catch(() => undefined)
      }
      return
    }
    if (snapshot.status === 'completed') {
      const n = snapshot.globalMsgNum ?? run.globalMsgNum
      await saveRow(deps, { ...run, status: 'done', lastKnownStatus: snapshot.status, completedAt: snapshot.completedAt ?? new Date(nowMs(deps)).toISOString() })
      await setMarker(run.domain, run.taskId, n != null ? `done:${n}` : 'failed').catch(() => undefined)
      return
    }
    if (snapshot.status === 'failed' || snapshot.status === 'canceled' || snapshot.status === 'interrupted') {
      const n = snapshot.globalMsgNum ?? run.globalMsgNum
      await saveRow(deps, {
        ...run,
        status: 'failed',
        lastKnownStatus: snapshot.status,
        error: { code: snapshot.error?.code ?? snapshot.status, message: snapshot.error?.message ?? snapshot.status },
        completedAt: snapshot.completedAt ?? new Date(nowMs(deps)).toISOString(),
      })
      await setMarker(run.domain, run.taskId, n != null ? `failed:${n}` : 'failed').catch(() => undefined)
    }
    return
  }

  if (run.status === 'dispatching') {
    const action = await decideDispatchingAction(deps, run, day)
    if (action !== 'redrive') return
    try {
      const running = await adoptOrSubmit(deps, run)
      if (running.status === 'running') await markRunning(deps, running)
    } catch {
      /* next pass */
    }
  }
}

export async function reconcileDispatch(injected?: TaskDispatcherDeps): Promise<{ fired: number; reason?: string }> {
  const deps = injected ?? requireBound()
  const config = configOf(deps)
  const clock = localClock(nowMs(deps), config.timezone)
  let lease: MaintenanceWorkLease | undefined
  try {
    lease = deps.acquireDispatchLease?.() ?? acquireMaintenanceWork('task_dispatch')
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) return { fired: 0, reason: 'maintenance_drain_active' }
    throw error
  }
  const timer = setTimeout(() => lease?.release(), TASK_LEASE_CEILING_MS)
  try {
    const groups = await Promise.all(taskDomains().map(domain => (deps.loadRows ? deps.loadRows(clock.day) : loadDomainRows(domain, clock.day))))
    const rows = groups.flat()
    const ledger = loadTaskLedger(pathsOf(deps))
    const live = ledger.filter(run => run.status === 'dispatching' || run.status === 'running')
    const deadline = Date.now() + TASK_RECONCILE_WALL_MS
    const start = live.length ? reconcileCursor % live.length : 0
    const ordered = live.length ? [...live.slice(start), ...live.slice(0, start)] : []
    let fired = 0
    for (const run of ordered.slice(0, TASK_DISPATCH_LIMITS.reconcilePerTick)) {
      if (Date.now() > deadline) break
      await reconcileOne(deps, run, rows, clock.day)
      fired += 1
    }
    reconcileCursor += TASK_DISPATCH_LIMITS.reconcilePerTick
    if (lastTodayPurgeDay !== clock.day) {
      lastTodayPurgeDay = clock.day
      void shiftDay(clock.day, -TASK_TODAY_PURGE_HORIZON_DAYS)
    }
    const markers = rows.filter(row => row.agent_state && !ledger.some(run => run.taskId === row.id))
    for (const row of markers.slice(0, 1)) {
      const setMarker = deps.setMarker ?? setTaskMarker
      await setMarker(row.domain, row.id, 'failed').catch(() => undefined)
    }
    return { fired }
  } finally {
    clearTimeout(timer)
    lease.release()
  }
}

export function reservationsForEra(era: string, injected?: TaskDispatcherDeps) {
  const deps = injected ?? bound
  return liveTaskReservations(era, deps ? nowMs(deps) : Date.now(), deps?.paths)
}

export function __resetTaskDispatcherForTests(): void {
  submitLive.clear()
  reservedManual = 0
  backgroundSlots = 0
  reconcileCursor = 0
  lastTodayPurgeDay = ''
  bound = null
}
