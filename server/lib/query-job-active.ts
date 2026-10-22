/**
 * 6.84.1: the in-flight query jobs, as COS Control's Activity home lists them in its Running
 * panel (GET /api/query-jobs/active, docs/active-query-jobs.md).
 *
 * Read-only and in memory. The store hands each non-terminal hydrated job to
 * `projectActiveQueryJob` and nothing else leaves it: never the prompt body, the reference
 * turn, the partial answer, tool activity or the trail. The title is the prompt's first
 * non-blank line, redacted with the store's own credential and path patterns, flattened to
 * one line and cut to ACTIVE_QUERY_JOB_TITLE_MAX characters.
 */
import {
  flattenDisplayText,
  redactQueryJobText,
  type QueryJobProviderLinkage,
  type QueryJobRequest,
  type QueryJobSnapshot,
  type QueryJobStatus,
} from './query-job-types.js'

export const ACTIVE_QUERY_JOBS_PROTOCOL = 1 as const
/** Longest title, in characters (grapheme clusters where the runtime can count them), ellipsis included. */
export const ACTIVE_QUERY_JOB_TITLE_MAX = 80
/** Most items one answer carries. `count` is always the full number. */
export const ACTIVE_QUERY_JOBS_LIST_MAX = 50
/** Only this much of a prompt (up to 48,000 characters) is ever read to find its first line. */
const TITLE_SCAN_CHARS = 1_000
const ELLIPSIS = '…'

/**
 * Who asked, as far as the job record can tell:
 * - `person`: typed on the phone or spoken on the glasses. The phone app sends both the same
 *   way (no `origin`, with a message number), so the server cannot tell the two apart.
 * - `routine`: a scheduled routine (the morning brief and the routines scheduler).
 * - `task`: a dispatch of a captured task.
 * - `other`: anything else with no message number (COS Control Work sessions, meeting reviews).
 */
export type ActiveQueryJobOrigin = 'person' | 'routine' | 'task' | 'other'

/** Coarse state for a list row. `status` carries the job model's own value. */
export type ActiveQueryJobState = 'queued' | 'running' | 'finishing'

export type ActiveQueryJobStatus = Exclude<QueryJobStatus, 'completed' | 'failed' | 'canceled' | 'interrupted'>

export interface ActiveQueryJob {
  jobId: string
  generation: number
  origin: ActiveQueryJobOrigin
  /** The routine slug or task id, only for `routine` and `task`. */
  originId?: string
  state: ActiveQueryJobState
  status: ActiveQueryJobStatus
  acceptedAt: string
  startedAt?: string
  /** Milliseconds since the job was accepted (the person's wait), never negative. */
  elapsedMs: number
  provider?: QueryJobProviderLinkage['provider']
  /** The model asked for (a slot such as `opus`, or `profile:<id>`). */
  model?: string
  /** The model the provider reported, once it started. */
  resolvedModel?: string
  /** The message number the phone minted for this question. */
  messageNo?: number
  title: string
}

export interface ActiveQueryJobsList {
  items: ActiveQueryJob[]
  /** Non-terminal jobs whose record is not held in memory (listed only in `count`). */
  unlisted: number
}

export function activeQueryJobState(status: ActiveQueryJobStatus): ActiveQueryJobState {
  if (status === 'accepted') return 'queued'
  if (status === 'answer_ready') return 'finishing'
  return 'running'
}

export function activeQueryJobOrigin(request: Readonly<Pick<QueryJobRequest, 'origin' | 'globalMsgNum'>>): { origin: ActiveQueryJobOrigin; originId?: string } {
  if (request.origin?.kind === 'routine') return { origin: 'routine', originId: request.origin.id }
  if (request.origin?.kind === 'task') return { origin: 'task', originId: request.origin.id }
  if (typeof request.globalMsgNum === 'number' && request.globalMsgNum > 0) return { origin: 'person' }
  return { origin: 'other' }
}

const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

function characters(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), part => part.segment) : Array.from(text)
}

/** At most `max` characters, the last one an ellipsis when cut, back to a word break in the second half. */
export function truncateActiveTitle(text: string, max = ACTIVE_QUERY_JOB_TITLE_MAX): string {
  const chars = characters(text)
  if (chars.length <= max) return text
  const cut = chars.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  const kept = (space >= (max - 1) / 2 ? cut.slice(0, space) : cut).join('').trimEnd()
  return `${kept}${ELLIPSIS}`
}

/** The prompt's first non-blank line as plain text: redacted, one line, at most 80 characters. */
export function activeQueryJobTitle(query: string): string {
  if (typeof query !== 'string' || !query) return ''
  const head = query.slice(0, TITLE_SCAN_CHARS)
  const line = head.split(/\r\n|[\n\r\u2028\u2029]/).find(candidate => candidate.trim().length > 0) ?? ''
  if (!line) return ''
  return truncateActiveTitle(flattenDisplayText(redactQueryJobText(line)))
}

/** One row. The caller passes only non-terminal jobs (QueryJobStore.listInFlight checks the status). */
export function projectActiveQueryJob(request: Readonly<QueryJobRequest>, snapshot: Readonly<QueryJobSnapshot>, nowMs: number): ActiveQueryJob {
  const status = snapshot.status as ActiveQueryJobStatus
  const acceptedMs = Date.parse(snapshot.acceptedAt)
  const elapsedMs = Number.isFinite(acceptedMs) ? Math.max(0, Math.round(nowMs - acceptedMs)) : 0
  const model = snapshot.requestedModel ?? request.model
  // A COS Control Work session carries the task's display name; it reads better than a prompt line.
  const named = request.sessionName ? truncateActiveTitle(flattenDisplayText(redactQueryJobText(request.sessionName))) : ''
  return {
    jobId: snapshot.jobId,
    generation: snapshot.generation,
    ...activeQueryJobOrigin(request),
    state: activeQueryJobState(status),
    status,
    acceptedAt: snapshot.acceptedAt,
    ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
    elapsedMs,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(model ? { model } : {}),
    ...(snapshot.resolvedModel ? { resolvedModel: snapshot.resolvedModel } : {}),
    ...(typeof snapshot.globalMsgNum === 'number' ? { messageNo: snapshot.globalMsgNum } : {}),
    title: named || activeQueryJobTitle(request.query),
  }
}

/** Oldest first; a stable order for a list that refreshes every minute. */
export function compareActiveQueryJobs(a: ActiveQueryJob, b: ActiveQueryJob): number {
  return a.acceptedAt.localeCompare(b.acceptedAt) || a.jobId.localeCompare(b.jobId)
}
