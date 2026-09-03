import { join } from 'node:path'
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import {
  TASK_CATCH_UP_LIMITS,
  ensurePrivateDir,
  loadMorningBriefConfig,
  morningBriefPaths,
  type MorningBriefConfig,
} from './morning-brief-config.js'
import { localClock, shiftDay, taskInstant } from './morning-brief-schedule.js'
import { callPython, pythonBridgeAvailable } from './python-bridge.js'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { taskDomainNames } from './domains.js'
import { isClientJobId } from './query-job-types.js'
import { DEFAULT_MODEL, isClaudeModel } from '../../shared/model-preference.js'

export const TASK_DISPATCH_LIMITS = Object.freeze({
  runsPerDay: 3,
  submitAttempts: 3,
  submitSpacingMs: 2 * 60_000,
  runSpacingMs: 10 * 60_000,
  perTick: 2,
  reconcilePerTick: 2,
  capPerDay: 20,
  retainedRuns: 200,
})
export const TASK_DISPATCH_WALL_MS = 25_000
export const TASK_LEASE_CEILING_MS = 2 * TASK_DISPATCH_WALL_MS
export const TASK_RECONCILE_WALL_MS = 40_000
export const TASK_BRIDGE_TIMEOUT_MS = 12_000
export const TASK_JOB_LOST_MS = 6 * 60 * 60_000
export const TASK_LOCK_RETRY = Object.freeze({ attempts: 3, spacingMs: 300 })
export const TASK_TODAY_PURGE_HORIZON_DAYS = 7
/** Domains come from the user's own config and their own `operations/` tree, not
 *  from a list baked into the build. The previous constant here was one user's
 *  four business units, which is why a second COS install could not name
 *  anything that worked. `taskDomainNames` unions configured domains with every
 *  directory holding a `tasks.md`. */
export function taskDomains(): string[] {
  return taskDomainNames(resolveCosOperationsDir())
}

export type TaskDomain = string
export type TaskRunStatus = 'dispatching' | 'running' | 'done' | 'superseded' | 'failed' | 'orphaned'
export const TASK_RUN_TERMINAL = new Set<TaskRunStatus>(['done', 'superseded', 'failed', 'orphaned'])
export type TaskColumn = 'done' | 'running' | 'today' | 'carried' | 'scheduled' | 'inbox'

export interface TaskStorePaths {
  runs: string
  cap: string
  capturesSeen: string
}

export interface TaskRun {
  id: string
  identity: string
  taskId: string
  ref: string
  domain: TaskDomain
  line: string
  scheduledFor?: string
  day: string
  attempt: number
  trigger: 'manual' | 'scheduled'
  firedAt: string
  clientJobId: string
  generation: 1
  sessionId: string
  messageEra?: string
  globalMsgNum?: number
  status: TaskRunStatus
  jobId?: string
  submitAttempts: number
  retryAfter?: number
  lastKnownStatus?: string
  completedAt?: string
  error?: { code: string; message: string }
  catchUp?: boolean
  model: string
  effort?: string
  cursorExecutionMode?: string
  activityToolMode: 'status'
}

export interface BridgeTaskRow {
  ref: string
  id: string
  domain: string
  description: string
  priority: string
  is_checked: boolean
  archived: boolean
  line_number: number
  source: string | null
  owner: string | null
  delegated: boolean
  needs_review: boolean
  thread: null
  run_at: string | null
  agent_state: 'running' | 'done' | 'failed' | null
  agent_no: number | null
  section: string
  section_day: string | null
}

export interface TaskFlags {
  due: boolean
  missed: boolean
  failed: boolean
  late: boolean
  carriedOver: boolean
}

export interface TaskBoardRow {
  id: string
  ref: string
  domain: string
  /** Capped to TASK_TITLE_MAX for a lens row. */
  title: string
  /** The whole description, for surfaces with room. */
  text: string
  source?: string
  owner?: string
  delegated?: boolean
  agentState?: 'running' | 'done' | 'failed'
  agentNo?: number
  checked: boolean
  column: TaskColumn
  priority: string
  runAt?: string
  section: string
  sectionDay?: string
  due: boolean
  missed: boolean
  failed: boolean
  late: boolean
  carriedOver: boolean
}

export class TaskBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TaskBridgeError'
  }
}

export class TaskRunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'TaskRunError'
  }
}

export function taskStorePaths(root?: string): TaskStorePaths {
  const base = root ?? dataPath('tasks')
  return {
    runs: join(base, 'runs.json'),
    cap: join(base, 'tasks-dispatch-cap.json'),
    capturesSeen: join(base, 'captures-seen.json'),
  }
}

export function tasksGate(): 'ready' | 'disabled' {
  return pythonBridgeAvailable() ? 'ready' : 'disabled'
}

export function taskDispatchModel(config: MorningBriefConfig): string {
  return config.model && isClaudeModel(config.model) ? config.model : DEFAULT_MODEL
}

function isTaskRunRecord(value: unknown): value is TaskRun {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return typeof rec.id === 'string' && typeof rec.taskId === 'string' && typeof rec.status === 'string'
}

export function loadTaskLedger(paths: TaskStorePaths): TaskRun[] {
  const loaded = loadJsonOrQuarantine<unknown>(paths.runs)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') return []
  const raw = loaded.data as { runs?: unknown }
  if (!Array.isArray(raw.runs)) return []
  return raw.runs.filter(isTaskRunRecord)
}

export function saveTaskLedger(paths: TaskStorePaths, runs: TaskRun[]): void {
  const kept: TaskRun[] = []
  const terminals: TaskRun[] = []
  for (const run of runs) {
    if (TASK_RUN_TERMINAL.has(run.status)) terminals.push(run)
    else kept.push(run)
  }
  terminals.sort((a, b) => a.firedAt.localeCompare(b.firedAt))
  const overflow = Math.max(0, terminals.length - TASK_DISPATCH_LIMITS.retainedRuns)
  const retained = [...kept, ...terminals.slice(overflow)]
  ensurePrivateDir(paths.runs)
  durableAtomicWriteFileSync(paths.runs, `${JSON.stringify({ v: 1, runs: retained }, null, 2)}\n`, { mode: 0o600 })
}

let serializeChain: Promise<unknown> = Promise.resolve()
let serializeDepth = 0

export function serializeTaskWork<T>(fn: () => Promise<T> | T): Promise<T> {
  if (serializeDepth > 0) {
    return Promise.reject(new Error('nested serializeTaskWork'))
  }
  const run = serializeChain.then(async () => {
    serializeDepth += 1
    try {
      return await fn()
    } finally {
      serializeDepth -= 1
    }
  })
  serializeChain = run.then(() => undefined, () => undefined)
  return run
}

export function parseRunAt(value: string | null | undefined): { day: string; minutes: number } | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return { day: match[1], minutes: Number(match[2]) * 60 + Number(match[3]) }
}

export function hasAgentMarker(row: Pick<BridgeTaskRow, 'agent_state'>): boolean {
  return row.agent_state === 'running' || row.agent_state === 'done' || row.agent_state === 'failed'
}

export function beyondCatchUp(
  runAt: { day: string; minutes: number } | null,
  nowMs: number,
  tz: string,
  taskCatchUpMinutes: number = TASK_CATCH_UP_LIMITS.defaultMinutes,
): boolean {
  if (!runAt) return false
  return nowMs - taskInstant(runAt.day, runAt.minutes, tz) > taskCatchUpMinutes * 60_000
}

export function isCatchUpDue(
  row: Pick<BridgeTaskRow, 'run_at' | 'agent_state'>,
  nowMs: number,
  tz: string,
  taskCatchUpMinutes: number = TASK_CATCH_UP_LIMITS.defaultMinutes,
): boolean {
  const runAt = parseRunAt(row.run_at)
  if (!runAt) return false
  const runAtInstant = taskInstant(runAt.day, runAt.minutes, tz)
  return runAtInstant <= nowMs && !beyondCatchUp(runAt, nowMs, tz, taskCatchUpMinutes) && !hasAgentMarker(row)
}

export function latestLedgerRow(runs: readonly TaskRun[], taskId: string, day: string): TaskRun | undefined {
  const inDay = runs.filter(run => run.taskId === taskId && run.day === day)
  const live = inDay.find(run => run.status === 'dispatching' || run.status === 'running')
  if (live) return live
  return [...inDay].sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]
}

export function column(
  row: BridgeTaskRow,
  ledgerRow: TaskRun | undefined,
  day: string,
  nowMs: number,
  tz: string,
  taskCatchUpMinutes: number = TASK_CATCH_UP_LIMITS.defaultMinutes,
): TaskColumn | null {
  if (row.archived) return null
  if (row.delegated) return null
  if (row.is_checked) return 'done'
  if (row.agent_state === 'done') return 'done'
  if (row.agent_state === 'running' || ledgerRow?.status === 'dispatching' || ledgerRow?.status === 'running') {
    return 'running'
  }
  const runAt = parseRunAt(row.run_at)
  if (runAt && runAt.day > day) return 'scheduled'
  const skipSection = hasAgentMarker(row) || beyondCatchUp(runAt, nowMs, tz, taskCatchUpMinutes)
  if (!skipSection && row.section === 'today' && row.section_day === day) return 'today'
  if (!skipSection && row.section === 'today' && row.section_day && row.section_day < day) return 'carried'
  if (!skipSection && row.section === 'today' && row.section_day && row.section_day > day) return 'carried'
  if (isCatchUpDue(row, nowMs, tz, taskCatchUpMinutes)) return 'today'
  return 'inbox'
}

export function flags(
  row: BridgeTaskRow,
  ledgerRow: TaskRun | undefined,
  day: string,
  nowMs: number,
  tz: string,
  taskCatchUpMinutes: number = TASK_CATCH_UP_LIMITS.defaultMinutes,
): TaskFlags {
  const runAt = parseRunAt(row.run_at)
  const liveInDay = ledgerRow?.day === day && (ledgerRow.status === 'dispatching' || ledgerRow.status === 'running')
  const missed = beyondCatchUp(runAt, nowMs, tz, taskCatchUpMinutes) && !hasAgentMarker(row) && !liveInDay
  const failed = row.agent_state === 'failed'
  const runAtInstant = runAt ? taskInstant(runAt.day, runAt.minutes, tz) : null
  const due = !!runAt && runAtInstant! <= nowMs && !hasAgentMarker(row) && !missed && !beyondCatchUp(runAt, nowMs, tz, taskCatchUpMinutes)
  return {
    due,
    missed,
    failed,
    late: ledgerRow?.catchUp === true,
    carriedOver: row.section === 'today' && !!row.section_day && row.section_day !== day,
  }
}

function briefContext(nowMs = Date.now()) {
  const { config } = loadMorningBriefConfig(morningBriefPaths(), new Date(nowMs))
  const clock = localClock(nowMs, config.timezone)
  return { config, clock, nowMs }
}

function asBridgeError(payload: unknown): TaskBridgeError | null {
  if (!payload || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const rec = error as { code?: unknown; message?: unknown }
  if (typeof rec.code !== 'string') return null
  return new TaskBridgeError(rec.code, typeof rec.message === 'string' ? rec.message : rec.code)
}

async function bridge(args: string[], input?: string): Promise<unknown> {
  const payload = await callPython(args, TASK_BRIDGE_TIMEOUT_MS, input)
  const error = asBridgeError(payload)
  if (error) throw error
  return payload
}

async function withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < TASK_LOCK_RETRY.attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (!(error instanceof TaskBridgeError) || error.code !== 'task_file_locked') throw error
      if (attempt + 1 < TASK_LOCK_RETRY.attempts) {
        await new Promise(resolve => setTimeout(resolve, TASK_LOCK_RETRY.spacingMs))
      }
    }
  }
  throw last
}

export async function loadDomainRows(domain: TaskDomain, day: string): Promise<BridgeTaskRow[]> {
  const payload = await bridge(['task-rows', domain, '--day', day])
  return Array.isArray(payload) ? payload as BridgeTaskRow[] : []
}

export async function loadAllRows(day: string): Promise<BridgeTaskRow[]> {
  const groups = await Promise.all(taskDomains().map(domain => loadDomainRows(domain, day)))
  return groups.flat()
}

/** Board and lens titles come from a raw tasks.md line, which carries markdown
 *  emphasis and is usually far longer than a row. Slicing the raw line cut words
 *  and left unbalanced `**` on 119 of 201 live rows, so a row read
 *  "**Provide data migration process docs by ind". Strip the markup first (which
 *  buys back the four characters the asterisks were spending), then cut on a word
 *  boundary. The cap is exported so tests pin the real value rather than a copy. */
export const TASK_TITLE_MAX = 44

export function taskTitle(line: string): string {
  const plain = line
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Underscore emphasis must be anchored: a bare `_` between word characters is
    // an identifier (cos_python, hermit_crabs), not markup, and stripping it
    // corrupts the row. Asterisks need no such care, so one catch-all below clears
    // them whether the pair is balanced or not — and after a slice, it often is not.
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= TASK_TITLE_MAX) return plain
  const cut = plain.slice(0, TASK_TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  // Only honour a word boundary that is not so early it throws the title away.
  const body = space > TASK_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut
  return `${body.replace(/[\s\u2014\u2013,;:.-]+$/, '')}\u2026`
}

export function projectRow(
  row: BridgeTaskRow,
  ledger: readonly TaskRun[],
  day: string,
  nowMs: number,
  tz: string,
  taskCatchUpMinutes: number,
): TaskBoardRow | null {
  const ledgerRow = latestLedgerRow(ledger, row.id, day)
  const col = column(row, ledgerRow, day, nowMs, tz, taskCatchUpMinutes)
  if (!col) return null
  const mark = flags(row, ledgerRow, day, nowMs, tz, taskCatchUpMinutes)
  const runAt = parseRunAt(row.run_at)
  return {
    id: row.id,
    ref: row.ref,
    domain: row.domain,
    title: taskTitle(row.description),
    // `title` stays capped for the lens; `text` is the whole line. The cap is a
    // G2 row budget and was being applied to every surface, so a Mac window
    // 1900px wide showed "Send James/John the call recording + recap…". Additive
    // on purpose: clients through 6.9.451 read `title` and must keep working.
    text: row.description,
    ...(row.source ? { source: row.source } : {}),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.delegated ? { delegated: true } : {}),
    ...(row.agent_state ? { agentState: row.agent_state } : {}),
    ...(row.agent_no != null ? { agentNo: row.agent_no } : {}),
    checked: row.is_checked,
    column: col,
    priority: row.priority,
    ...(runAt ? { runAt: new Date(taskInstant(runAt.day, runAt.minutes, tz)).toISOString() } : {}),
    section: row.section,
    ...(row.section_day ? { sectionDay: row.section_day } : {}),
    ...mark,
  }
}

export async function listBoard(columnFilter?: string, nowMs = Date.now()): Promise<TaskBoardRow[]> {
  if (!pythonBridgeAvailable()) {
    throw new TaskRunError(503, 'cos_pipeline_not_configured', 'COS pipeline is not configured.')
  }
  const { config, clock } = briefContext(nowMs)
  const [rows, ledger] = await Promise.all([
    loadAllRows(clock.day),
    Promise.resolve(loadTaskLedger(taskStorePaths())),
  ])
  return rows
    .map(row => projectRow(row, ledger, clock.day, nowMs, config.timezone, config.taskCatchUpMinutes))
    .filter((row): row is TaskBoardRow => !!row && (!columnFilter || row.column === columnFilter))
}

export function workBadgeCount(rows: readonly TaskBoardRow[]): number {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.column === 'today' || row.column === 'carried' || row.missed || row.failed) ids.add(row.id)
  }
  return ids.size
}

export async function captureTask(body: {
  domain: string
  text: string
  section: string
  runAt?: string
  captureId?: string
}, nowMs = Date.now()): Promise<{ ok: true; replayed?: boolean; fell_to_inbox?: boolean; section?: string }> {
  if (!pythonBridgeAvailable()) throw new TaskRunError(503, 'cos_pipeline_not_configured', 'COS pipeline is not configured.')
  if (!body.captureId) throw new TaskRunError(400, 'capture_id_required', 'captureId is required.')
  if (!isClientJobId(body.captureId)) throw new TaskRunError(422, 'invalid_capture_id', 'captureId must be a UUID v4.')
  if (!taskDomains().includes(body.domain)) {
    throw new TaskRunError(400, 'invalid_domain', `unknown domain: ${body.domain}`)
  }
  const paths = taskStorePaths()
  const seen = loadCapturesSeen(paths)
  if (seen.ids.includes(body.captureId)) return { ok: true, replayed: true }
  const { config, clock } = briefContext(nowMs)
  const args = ['task-capture', body.domain, '--section', body.section]
  if (body.runAt) args.push('--run-at', body.runAt)
  if (body.section.startsWith('today:')) {
    args.push('--purge-before', shiftDay(clock.day, -TASK_TODAY_PURGE_HORIZON_DAYS))
  }
  const payload = await withLockRetry(() => bridge(args, body.text)) as { ok?: boolean; fell_to_inbox?: boolean; section?: string }
  rememberCapture(paths, body.captureId, nowMs)
  return { ok: true, fell_to_inbox: payload.fell_to_inbox, section: payload.section }
}

export async function setTaskRunAt(domain: string, id: string, runAt: string | null, nowMs = Date.now()): Promise<void> {
  const { clock } = briefContext(nowMs)
  const row = await findTaskRow(domain, id, clock.day)
  if (!row) throw new TaskBridgeError('task_not_found', `no task ${id} in ${domain}`)
  if (row.agent_state === 'running' || liveLedgerFor(id, clock.day)) {
    throw new TaskRunError(409, 'task_running', 'A run is already in flight for this task.')
  }
  const args = ['task-set-run-at', domain, id, runAt ?? '--clear']
  await withLockRetry(() => bridge(args))
}

/** Rewrite a task's words. The bridge preserves its source block and schedule. */
export async function setTaskText(domain: string, id: string, text: string): Promise<void> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new TaskRunError(400, 'text_required', 'text is required')
  if (clean.length > 2000) throw new TaskRunError(422, 'text_too_long', 'text must be 2000 characters or fewer')
  await withLockRetry(() => bridge(['task-set-text', domain, id], clean))
}

export async function moveTask(domain: string, id: string, section: string, nowMs = Date.now()): Promise<void> {
  const { clock } = briefContext(nowMs)
  const args = ['task-move', domain, id, '--section', section]
  if (section.startsWith('today:')) {
    args.push('--purge-before', shiftDay(clock.day, -TASK_TODAY_PURGE_HORIZON_DAYS))
  }
  await withLockRetry(() => bridge(args))
}

export async function checkTask(opts: {
  domain: string
  id?: string
  text?: string
  checked: boolean
}): Promise<void> {
  const args = opts.id
    ? ['task-check', opts.domain, opts.id]
    : ['task-check', opts.domain, '--text', opts.text ?? '']
  if (!opts.checked) args.push('--uncheck')
  await withLockRetry(() => bridge(args))
}

interface CapturesSeen {
  ids: string[]
  at: Record<string, number>
}

function loadCapturesSeen(paths: TaskStorePaths): CapturesSeen {
  const loaded = loadJsonOrQuarantine<unknown>(paths.capturesSeen)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') return { ids: [], at: {} }
  const raw = loaded.data as CapturesSeen
  return { ids: Array.isArray(raw.ids) ? raw.ids : [], at: raw.at && typeof raw.at === 'object' ? raw.at : {} }
}

function rememberCapture(paths: TaskStorePaths, id: string, nowMs: number): void {
  const seen = loadCapturesSeen(paths)
  const cutoff = nowMs - 24 * 60 * 60_000
  const nextIds = [...seen.ids.filter(existing => (seen.at[existing] ?? 0) >= cutoff), id].slice(-500)
  const at: Record<string, number> = {}
  for (const existing of nextIds) at[existing] = existing === id ? nowMs : seen.at[existing] ?? nowMs
  ensurePrivateDir(paths.capturesSeen)
  durableAtomicWriteFileSync(paths.capturesSeen, `${JSON.stringify({ ids: nextIds, at }, null, 2)}\n`, { mode: 0o600 })
}

export function loadDispatchCap(paths = taskStorePaths()): number {
  const loaded = loadJsonOrQuarantine<unknown>(paths.cap)
  if (loaded.status !== 'ok' || !loaded.data || typeof loaded.data !== 'object') return TASK_DISPATCH_LIMITS.capPerDay
  const cap = Number((loaded.data as { capPerDay?: unknown }).capPerDay)
  return Number.isSafeInteger(cap) && cap >= 0 ? cap : TASK_DISPATCH_LIMITS.capPerDay
}

export function saveDispatchCap(capPerDay: number, paths = taskStorePaths()): void {
  if (!Number.isSafeInteger(capPerDay) || capPerDay < 0) {
    throw new TaskRunError(400, 'invalid_cap', 'capPerDay must be a non-negative integer.')
  }
  ensurePrivateDir(paths.cap)
  durableAtomicWriteFileSync(paths.cap, `${JSON.stringify({ capPerDay }, null, 2)}\n`, { mode: 0o600 })
}

export interface TaskRunView {
  id: string
  kind: 'task'
  trigger: TaskRun['trigger']
  status: string
  firedAt: string
  completedAt?: string
  globalMsgNum?: number
  title: string
  taskId: string
  jobId?: string
  clientJobId: string
  generation: 1
  messageEra?: string
  sessionId: string
  error?: { code: string; message: string }
  catchUp?: boolean
}

export function projectTaskRun(
  run: TaskRun,
  snapshot?: { status: string; completedAt?: string } | null,
): TaskRunView {
  const title = taskTitle(run.line)
  const base = {
    id: run.id,
    kind: 'task' as const,
    trigger: run.trigger,
    firedAt: run.firedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.globalMsgNum != null ? { globalMsgNum: run.globalMsgNum } : {}),
    title,
    taskId: run.taskId,
    ...(run.jobId ? { jobId: run.jobId } : {}),
    clientJobId: run.clientJobId,
    generation: 1 as const,
    ...(run.messageEra ? { messageEra: run.messageEra } : {}),
    sessionId: run.sessionId,
    ...(run.catchUp ? { catchUp: true } : {}),
  }
  switch (run.status) {
    case 'dispatching':
      return { ...base, status: 'submitting' }
    case 'running':
      return {
        ...base,
        status: snapshot?.status ?? 'running',
        ...(snapshot?.completedAt ? { completedAt: snapshot.completedAt } : {}),
      }
    case 'done':
      return { ...base, status: 'completed' }
    case 'superseded':
      return {
        ...base,
        status: 'canceled',
        error: { code: 'superseded', message: 'Rescheduled before it ran' },
      }
    case 'failed':
      return {
        ...base,
        status: 'failed',
        error: run.error ?? { code: 'failed', message: `Task ${run.status} on the Mac` },
      }
    case 'orphaned':
      return {
        ...base,
        status: 'canceled',
        error: { code: 'orphaned', message: run.error?.message ?? 'Task orphaned on the Mac' },
      }
  }
}

export function listTaskRuns(limit = 20, paths = taskStorePaths()): TaskRun[] {
  return loadTaskLedger(paths).sort((a, b) => b.firedAt.localeCompare(a.firedAt)).slice(0, limit)
}

export async function listProjectedTaskRuns(
  getSnapshot: (jobId: string) => Promise<{ status: string; completedAt?: string } | undefined>,
  limit = 20,
  paths = taskStorePaths(),
): Promise<TaskRunView[]> {
  const runs = listTaskRuns(limit, paths)
  return Promise.all(runs.map(async run => {
    const snapshot = run.status === 'running' && run.jobId
      ? await getSnapshot(run.jobId).catch(() => undefined)
      : undefined
    return projectTaskRun(run, snapshot)
  }))
}

export function composeTaskDigest(rows: readonly TaskBoardRow[]): string {
  const today = rows.filter(row => row.column === 'today' || row.column === 'carried').length
  const running = rows.filter(row => row.column === 'running').length
  const scheduled = rows.filter(row => row.column === 'scheduled').length
  const inbox = rows.filter(row => row.column === 'inbox').length
  const missed = rows.filter(row => row.missed).length
  const failed = rows.filter(row => row.failed).length
  const clamp = (n: number) => (n > 99 ? '99+' : String(n))
  const lines = [`TASKS Today ${clamp(today)} · Run ${clamp(running)} · Sched ${clamp(scheduled)} · Inbox ${clamp(inbox)}`]
  if (missed > 0 || failed > 0) lines.push(`Missed ${clamp(missed)} · Failed ${clamp(failed)}`)
  return lines.join('\n')
}

export function composeTaskDispatchPrompt(line: string, day: string, tz: string): string {
  return [
    `Scheduled task for ${day} (${tz}).`,
    '',
    'Do this work from what is already on this Mac. Read-only: do not send messages, edit files, or change calendar events.',
    '',
    `Task: ${line}`,
    '',
    'Reply with a short status the wearer can read on glasses.',
  ].join('\n')
}

export function liveTaskReservations(era: string, nowMs = Date.now(), paths = taskStorePaths()) {
  const floor = nowMs - 24 * 60 * 60_000
  const out: Array<{ globalMsgNum: number; messageEra: string; owner: string }> = []
  for (const run of loadTaskLedger(paths)) {
    if (typeof run.globalMsgNum !== 'number') continue
    if (era !== run.messageEra) continue
    const fired = Date.parse(run.firedAt)
    if (!Number.isFinite(fired) || fired < floor) continue
    out.push({ globalMsgNum: run.globalMsgNum, messageEra: run.messageEra ?? era, owner: `task:${run.taskId}` })
  }
  return out
}

export async function setTaskMarker(domain: string, id: string, marker: string | null): Promise<void> {
  const args = ['task-set-marker', domain, id, marker ?? '--clear']
  await withLockRetry(() => bridge(args))
}

export async function findTaskRow(domain: string, id: string, day: string): Promise<BridgeTaskRow | undefined> {
  const rows = await loadDomainRows(domain as TaskDomain, day)
  return rows.find(row => row.id === id)
}

export function liveLedgerFor(taskId: string, day: string, paths = taskStorePaths()): TaskRun | undefined {
  return loadTaskLedger(paths).find(run =>
    run.taskId === taskId && run.day === day && (run.status === 'dispatching' || run.status === 'running'),
  )
}
