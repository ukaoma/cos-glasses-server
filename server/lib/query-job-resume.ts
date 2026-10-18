// 6.78.0 restart truth (plan v3.1 P2, the Pi Durable resume planner made real).
//
// WHAT A RESTART CUT OFF, TOLD FROM THE JOB'S OWN RECORD. When a restart ends an Ask (a crash
// then boot, or a graceful shutdown), the store builds one `interruption` record from the
// job's trail before it writes the terminal row: the step that was running, the side-effect
// steps that already finished, and whether that list may be missing steps. Pure and in
// memory, so the graceful path stays far inside its 8-second shutdown budget.
//
// NOTHING IS INFERRED AS SAFE. The trail can be absent (tool activity off), bounded (200
// entries, 32,000 characters), or hold a step whose outcome has no call id to match. Each of
// those sets `incomplete`, and a call-less outcome finishes nothing. A step's outcome is only
// ever the row that names its call.
//
// STEER ROWS ARE NOT STEPS. Only `tool` and `status` entries are read; anything else in the
// list (prose, and a steer or any kind a later build adds) is skipped.
//
// REPLAY SAFETY IS DECLARED, NEVER INFERRED (the prototype's rule). `planRestartResume` never
// auto-resumes in 6.78.0: dispatch auto-resume is deferred (V3 N11), so a declared read-only
// dispatch is handed to a person like every other job.
//
// Imports types only, so the Pi Durable canaries can load it without reaching a live module.
import {
  DISPATCH_ALLOWED_TOOLS,
  QUERY_JOB_INTERRUPTION_LIMITS,
  QUERY_JOB_LIMITS,
  QUERY_JOB_RESTART_MESSAGE,
  interruptionLine,
  type QueryJobActivityMode,
  type QueryJobInterruption,
  type QueryJobRequest,
  type QueryJobRestartCause,
  type QueryJobSnapshot,
} from './query-job-types.js'

export interface RestartStep {
  verb: string
  target: string
  call?: string
  finished: boolean
  ok?: boolean
}

/** Steps that change nothing outside the run. They are never listed as already done. */
const SIDE_EFFECT_FREE_VERBS: ReadonlySet<string> = new Set(['read', 'search'])

const GERUND: Readonly<Record<string, string>> = {
  read: 'reading', edit: 'editing', write: 'writing', bash: 'running', search: 'searching', task: 'running', other: 'using',
}
const PAST: Readonly<Record<string, string>> = {
  read: 'read', edit: 'edited', write: 'wrote', bash: 'ran', search: 'searched', task: 'ran', other: 'used',
}

type TrailLike = {
  kind?: unknown
  verb?: unknown
  target?: unknown
  call?: unknown
  detail?: unknown
  trailSeq?: unknown
  tool_outcome?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Tool steps in trail order. A `status` row finishes the newest unfinished step whose call it
 * names; an outcome with no call, or one that matches no step, finishes nothing and marks the
 * list ambiguous, as does a step that carries no call id. `openDetail` is Claude Code's own
 * step line (`status.detail`) when it came after the last step, the best words for "cut off
 * during".
 */
export function trailSteps(trail: readonly unknown[] | undefined): { steps: RestartStep[]; ambiguous: boolean; openDetail: string } {
  const steps: RestartStep[] = []
  let ambiguous = false
  let openDetail = ''
  for (const raw of trail ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as TrailLike
    if (entry.kind === 'tool') {
      const verb = text(entry.verb), target = text(entry.target)
      if (!verb || !target) continue
      const call = text(entry.call)
      steps.push({ verb, target, ...(call ? { call } : {}), finished: false })
      if (!call) ambiguous = true
      openDetail = ''
    } else if (entry.kind === 'status') {
      const outcome = entry.tool_outcome && typeof entry.tool_outcome === 'object'
        ? entry.tool_outcome as { call?: unknown; ok?: unknown } : null
      if (outcome) {
        const call = text(outcome.call)
        const step = call ? [...steps].reverse().find(s => s.call === call && !s.finished) : undefined
        if (step) {
          step.finished = true
          step.ok = outcome.ok !== false
        } else {
          ambiguous = true
        }
      } else if (text(entry.detail)) {
        openDetail = text(entry.detail)
      }
    }
    // prose, steer and any later kind: not a step.
  }
  return { steps, ambiguous, openDetail }
}

function describeOpen(step: RestartStep): string {
  return `${GERUND[step.verb] ?? 'using'} ${step.target}`
}

function describeDone(step: RestartStep): string {
  return `${PAST[step.verb] ?? 'used'} ${step.target}${step.ok === false ? ' (failed)' : ''}`
}

/** "Running npm test." reads as "running npm test" after "Cut off during". */
function lowerLead(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, '')
  return trimmed ? trimmed[0]!.toLowerCase() + trimmed.slice(1) : ''
}

export interface InterruptionInput {
  /** The job as the store holds it when the restart ends it: `trail`, ownership and status. */
  job: Pick<QueryJobSnapshot, 'trail' | 'providerOwnershipConfirmedAt'>
  activityToolMode: QueryJobActivityMode
  cause: QueryJobRestartCause
  at: string
}

/** The interruption record for a job a restart ended (see QueryJobInterruption). */
export function buildInterruption(input: InterruptionInput): QueryJobInterruption {
  const limits = QUERY_JOB_INTERRUPTION_LIMITS
  const trail = input.job.trail
  const { steps, ambiguous, openDetail } = trailSteps(trail)
  const unfinished = steps.filter(step => !step.finished)
  const open = unfinished.at(-1)
  const lastStep = steps.at(-1)
  // Claude Code's own line describes the newest step only while that step is still open.
  const openWords = open && open === lastStep && openDetail ? lowerLead(openDetail) : open ? describeOpen(open) : ''
  const cutOffDuring = interruptionLine(openWords, limits.cutOffDuringChars) || null

  const done: string[] = []
  for (const step of steps) {
    if (!step.finished || SIDE_EFFECT_FREE_VERBS.has(step.verb)) continue
    const line = interruptionLine(describeDone(step), limits.alreadyDoneEntryChars)
    if (line && !done.includes(line)) done.push(line)
  }
  const alreadyDone = done.slice(-limits.alreadyDoneMax)

  const trailCapped = (trail?.length ?? 0) >= QUERY_JOB_LIMITS.trailEntries
    || (typeof (trail?.[0] as TrailLike | undefined)?.trailSeq === 'number' && Number((trail![0] as TrailLike).trailSeq) > 1)
  const providerStarted = Boolean(input.job.providerOwnershipConfirmedAt)
  // A parked job's starts crashed the server: nothing on record can say what they did.
  const incomplete = input.cause === 'crash_loop_parked'
    || input.activityToolMode === 'off'
    || trailCapped
    || ambiguous
    || unfinished.length > 1
    || done.length > alreadyDone.length
    || (providerStarted && !(trail?.length))

  return {
    cause: input.cause,
    at: input.at,
    cutOffDuring,
    alreadyDone,
    incomplete,
    resumable: input.cause !== 'crash_loop_parked',
  }
}

/** One sentence group for a person: what happened, the step cut off, what was already done. */
export function restartNoticeText(interruption: QueryJobInterruption): string {
  return [
    interruption.cause === 'crash_loop_parked'
      ? 'Stopped after repeated server crashes.'
      : 'The server restarted mid-answer.',
    interruption.cutOffDuring ? `Cut off during: ${interruption.cutOffDuring}.` : '',
    interruption.alreadyDone.length ? `Already done: ${interruption.alreadyDone.join('; ')}.` : '',
    interruption.incomplete ? 'Earlier steps may be missing from this list.' : '',
  ].filter(Boolean).join(' ')
}

/** The restart cause of a terminal job, or null. Reads 6.78.0 causes and the 6.77.0 messages. */
export function restartCauseOf(job: Pick<QueryJobSnapshot, 'status' | 'error' | 'interruption'>): QueryJobRestartCause | null {
  if (job.status !== 'interrupted') return null
  if (job.interruption) return job.interruption.cause
  const error = job.error
  if (!error) return null
  if (error.cause === 'server_restarted' || error.cause === 'server_shutdown' || error.cause === 'crash_loop_parked') return error.cause
  if (error.code !== 'interrupted') return null
  // Journals written before 6.78.0: the boot path's message, and the raw graceful reason.
  if (/^Server restarted\./.test(error.message)) return 'server_restarted'
  if (error.message === 'server_shutdown') return 'server_shutdown'
  return null
}

/** Was this job cut off by a server restart (not cancelled, failed or stopped by a person)? */
export function interruptedByRestart(job: Pick<QueryJobSnapshot, 'status' | 'error' | 'interruption'>): boolean {
  const cause = restartCauseOf(job)
  return cause === 'server_restarted' || cause === 'server_shutdown'
}

export const MAX_AUTO_RESUMES_PER_LINEAGE = 0

export interface ResumePlan {
  action: 'auto_resume' | 'ask_user' | 'wait' | 'none'
  reason: string
  steps: RestartStep[]
  notice: string
  listMayBeIncomplete: boolean
}

/**
 * What to do with a job a restart ended. `wait` while a provider child from before the
 * restart may still own the session (the 21-minute orphan fence), `ask_user` otherwise: the
 * person picks Resume or Retry with the notice in front of them. Never `auto_resume` in
 * 6.78.0 (dispatch auto-resume is deferred, V3 N11). Jobs that ended any other way: `none`.
 */
export function planRestartResume(
  job: QueryJobSnapshot,
  request: Pick<QueryJobRequest, 'activityToolMode' | 'dispatch'>,
  opts: { now: number; autoResumesSoFar: number },
): ResumePlan {
  const cause = restartCauseOf(job)
  if (!cause) return { action: 'none', reason: 'not_a_restart', steps: [], notice: '', listMayBeIncomplete: false }
  const steps = trailSteps(job.trail).steps
  const interruption = job.interruption ?? buildInterruption({
    job,
    activityToolMode: request.activityToolMode,
    cause,
    at: job.completedAt ?? job.updatedAt,
  })
  const notice = restartNoticeText(interruption)
  const listMayBeIncomplete = interruption.incomplete
  if (cause === 'crash_loop_parked') {
    return { action: 'ask_user', reason: 'crash_loop_parked', steps, notice, listMayBeIncomplete }
  }
  const fence = job.orphanFenceUntil ? Date.parse(job.orphanFenceUntil) : Number.NaN
  if (Number.isFinite(fence) && fence > opts.now) return { action: 'wait', reason: 'orphan_fence', steps, notice, listMayBeIncomplete }
  const tools = request.dispatch?.restricted === true ? request.dispatch.tools : []
  const declaredReadOnly = tools.length > 0 && tools.every(t => (DISPATCH_ALLOWED_TOOLS as readonly string[]).includes(t))
  return {
    action: 'ask_user',
    reason: declaredReadOnly ? 'auto_resume_deferred' : 'not_declared_replay_safe',
    steps, notice, listMayBeIncomplete,
  }
}

/** The error a restart writes (both paths), with its cause set at construction. */
export function restartError(cause: Exclude<QueryJobRestartCause, 'crash_loop_parked'>): { code: 'interrupted'; cause: string; message: string; retryable: true } {
  return { code: 'interrupted', cause, message: QUERY_JOB_RESTART_MESSAGE, retryable: true }
}
