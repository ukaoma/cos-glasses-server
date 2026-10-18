import { providerFailureCode } from './provider-failure-text.js'
import { createHash } from 'node:crypto'
import {
  parseMediaAttachmentRefs,
  parseMediaIdList,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import type { JobTrailDraft } from './job-trail.js'

export const QUERY_JOB_SCHEMA_VERSION = 1 as const
export const QUERY_JOB_PROTOCOL_VERSION = 1 as const

export const QUERY_JOB_LIMITS = Object.freeze({
  promptChars: 48_000,
  referenceQueryChars: 48_000,
  referenceResponseChars: 128_000,
  partialChars: 128_000,
  terminalResponseChars: 128_000,
  errorChars: 2_000,
  activityChars: 2_000,
  activityEntries: 64,
  /** `snapshot.trail` keeps the newest 200 entries (6.52.0)... */
  trailEntries: 200,
  /** ...and at most this many characters of text across them, whichever bound
   * bites first, so a replay-gap snapshot stays small on a phone. Each field is
   * capped on its own too (see `sanitizeJobTrailDraft`). */
  trailChars: 32_000,
  replayEvents: 256,
  retainedDays: 7,
  hydratedJobs: 500,
})

export type QueryJobStatus =
  | 'accepted'
  | 'starting'
  | 'running'
  | 'answer_ready'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type QueryJobTerminalStatus = Extract<
  QueryJobStatus,
  'completed' | 'failed' | 'canceled' | 'interrupted'
>

export type QueryJobEventType =
  | QueryJobStatus
  | 'chunk'
  | 'tool_status'
  | 'activity_line'
  | 'acknowledged'
  // 6.52.0: one readable step of a Messages run (see lib/job-trail.ts), a JOURNAL row
  // type only: it is never a job event, never takes an eventSeq or a replay-ring slot,
  // and reaches only a subscriber that asked for the trail. Its data is one draft plus
  // `trailSeq`, a dense 1..n per job.
  | 'trail'
  // 6.78.0 (Messages steer): a steer's state, or the answer checkpoint of a steered run. A
  // JOURNAL row type only, like `trail`: never a job event, never an eventSeq or a ring slot,
  // never `updatedAt`. Builds before 6.78.0 skip it as malformed.
  | 'steer'

export type QueryJobActivityMode = 'off' | 'status' | 'preview'
export type QueryJobActivityKind = 'status' | 'input' | 'output' | 'gap'

export interface QueryJobPromptReference {
  query: string
  response: string
}

/**
 * Who STARTED a job, when it was not the person holding the phone or the
 * glasses. A label, nothing more: the server never infers anything from its
 * absence (the user, 2026-09-02). `routine` is the scheduler (`morning-brief`),
 * `task` is a dispatch of a captured task (the id is the task's 12-hex id).
 * Human prompts typed on the phone carry no origin. The phone stamps `g2`
 * locally for prompts spoken on the glasses, as a bare string; if that string
 * ever reaches this route it is dropped and counted, never rejected.
 */
export interface QueryJobOrigin {
  kind: 'routine' | 'task'
  id: string
}

/** One alphabet for both kinds: `morning-brief` and a 12-hex task id both fit.
 * Up to 64 chars is this server's own bound (a routine slug, a 12-hex task id
 * and a bare sha256 all fit); COS Control 0.5.185 mirrors it in its allowlist. */
export const QUERY_JOB_ORIGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface ParseQueryJobRequestOptions {
  /** Admission (the public job route reaches the parser with this on): a KNOWN
   * kind whose id fails the alphabet is a bug in the server's own scheduler or
   * dispatcher, and throws. An UNKNOWN kind never throws on any path — it is a
   * label this build cannot render, dropped and counted, so a newer client is
   * never refused. Hydration leaves this off: a record written by another
   * build must still hydrate. A bare STRING origin is dropped on both paths —
   * it is the phone's local `'g2'` shape, never an error. */
  strictOrigin?: boolean
}

/** Immutable, persistence-safe request. Provider-only objects (paths, image
 * bytes, AbortControllers, handoff runtime state) deliberately do not fit. */
export interface QueryJobRequest {
  clientJobId: string
  generation: number
  query: string
  sessionId: string
  model?: string
  effort?: string
  /** Cursor ask|agent. Omitted means ask on the server (old clients). */
  cursorExecutionMode?: string
  messageEra?: string
  globalMsgNum?: number
  reference?: QueryJobPromptReference
  handoffCode?: string
  handoffLatest?: boolean
  clientQueueItemId?: string
  attachmentIds: string[]
  attachmentRefs: MediaAttachmentRef[]
  activityToolMode: QueryJobActivityMode
  /** Present only on server-started jobs. NOT part of the request fingerprint
   * (see `FINGERPRINT_KEYS`), so a rollback to a build that drops it still
   * hydrates the journal. */
  origin?: QueryJobOrigin
  /** Read-only dispatch constraint. Excluded from the fingerprint. */
  dispatch?: { restricted: true; tools: readonly string[] }
  /**
   * 6.58.2: the display name a NEW Claude session gets (`claude --name`), so a session COS
   * Control starts for a Work item shows under that item's name in the Claude app instead of
   * "General coding session". Sanitized by sanitizeSessionName. Excluded from the fingerprint:
   * it names the session, it does not change what is asked.
   */
  sessionName?: string
  /**
   * 6.78.0: the client can steer this run (it read `durableQueryJobs.steer`). Only `true` is
   * kept. Excluded from the fingerprint: it says how the answer may be guided, not what is
   * asked, and a build that does not know it must still hydrate the job.
   */
  steerable?: true
}

/** 6.58.2: longest session name kept (the Claude sidebar shows about 40 characters). */
export const QUERY_JOB_SESSION_NAME_MAX = 100

/**
 * 6.58.2: a display name, or undefined. Control characters, zero-width spaces and direction
 * marks and overrides become spaces (the joiners U+200C and U+200D stay: scripts and emoji need
 * them), runs of whitespace collapse, and a name longer than QUERY_JOB_SESSION_NAME_MAX
 * characters (grapheme clusters, as Swift counts them) is cut there, back to its last space when
 * that space is in the second half. The cut never splits a character. Never throws: a bad name
 * is no name. COS Control applies the same rules before it sends the name.
 */
export function sanitizeSessionName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const flat = flattenDisplayText(raw)
  if (!flat) return undefined
  const chars = graphemes(flat)
  if (chars.length <= QUERY_JOB_SESSION_NAME_MAX) return flat
  const cut = chars.slice(0, QUERY_JOB_SESSION_NAME_MAX)
  const space = cut.lastIndexOf(' ')
  return (space >= QUERY_JOB_SESSION_NAME_MAX / 2 ? cut.slice(0, space) : cut).join('').trim()
}

/**
 * 6.59.0: the character rules of sanitizeSessionName, shared with Work evidence (work-activity.ts). Control
 * characters, zero-width spaces, direction marks and overrides and the byte-order mark become spaces; the joiners
 * U+200C and U+200D stay; runs of whitespace (U+2028 and U+2029 included) collapse to one space. No length limit.
 */
export function flattenDisplayText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
}

const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

/** Grapheme clusters when the runtime can segment them, else code points (never half a pair). */
function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), part => part.segment) : Array.from(text)
}

export const DISPATCH_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const

export interface QueryJobProviderLinkage {
  provider?: 'claude' | 'codex' | 'cursor' | 'ollama'
  resolvedModel?: string
  cliSessionId?: string
  claudeRunId?: string
  codexRunId?: string
  codexThreadId?: string
  cursorRunId?: string
  ollamaRunId?: string
}

/** Path/id-free aggregate from output-image finalization. Values are bounded
 * before journal persistence so terminal replay cannot smuggle arbitrary
 * provider metadata. */
export interface QueryJobOutputImageStats {
  published: number
  attached: number
  rejected: number
}

export interface QueryJobError {
  code: string
  message: string
  retryable?: boolean
  retryAfterMs?: number
  /** 6.78.0: why the server ended the job, from QUERY_JOB_ERROR_CAUSES only. Additive: a
   * client that does not read it sees the 6.77.0 error. */
  cause?: string
}

/** 6.78.0: the only `error.cause` values a journaled error keeps. An allowlist, so no
 * provider error (an Error's own `cause` included) can start carrying one. */
export const QUERY_JOB_ERROR_CAUSES: ReadonlySet<string> = new Set(['server_restarted', 'server_shutdown', 'crash_loop_parked'])

/** 6.78.0: why a restart ended a job: a crash then boot, a graceful shutdown, or crash-loop parking. */
export const QUERY_JOB_RESTART_CAUSES = ['server_restarted', 'server_shutdown', 'crash_loop_parked'] as const
export type QueryJobRestartCause = typeof QUERY_JOB_RESTART_CAUSES[number]

/**
 * 6.78.0: the message of a job either restart path cut off. The WHOLE message fits the lens's
 * 32-column footer lead (P7 S8: the 34-character first copy was cut mid-word by companion
 * 6.10.644). The hold menu offers Retry or Resume from `interruption.resumable`.
 */
export const QUERY_JOB_RESTART_MESSAGE = 'Server restarted. Tap to retry.'

/** 6.78.0: the bounds of `snapshot.interruption` (contract interrupted-job.json `limits`). */
export const QUERY_JOB_INTERRUPTION_LIMITS = Object.freeze({
  alreadyDoneMax: 5,
  alreadyDoneEntryChars: 60,
  cutOffDuringChars: 60,
})

/**
 * 6.78.0: what a restart cut off, built once from the job's own trail when the job ends
 * (lib/query-job-resume.ts `buildInterruption`) and journaled with the terminal record.
 *
 *   cutOffDuring  the step that was running, or null when none was (or none is known)
 *   alreadyDone   side-effect steps that finished (reads and searches are not listed), the
 *                 newest QUERY_JOB_INTERRUPTION_LIMITS.alreadyDoneMax of them
 *   incomplete    the list may be missing steps: tool activity was off, the trail hit its
 *                 bound, a step had no outcome to match, older steps were dropped from the
 *                 list, or the provider started and left no trail at all
 *   resumable     the app may offer Resume (false for a crash-loop-parked job)
 *
 * Additive: absent on every job a restart did not end, and with COS_RESTART_NOTICE=0.
 */
export interface QueryJobInterruption {
  cause: QueryJobRestartCause
  at: string
  cutOffDuring: string | null
  alreadyDone: string[]
  incomplete: boolean
  resumable: boolean
}

const RESTART_CAUSES: ReadonlySet<string> = new Set(QUERY_JOB_RESTART_CAUSES)

/** One line of the interruption record: redacted like activity, one line, at most `max` characters. */
export function interruptionLine(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.replace(CONTROL_RE, '').trim()) return ''
  const text = sanitizeQueryJobActivity(value).text.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

/** The only shape a journaled interruption may have, from anything. Undefined when it is not one. */
export function parseQueryJobInterruption(raw: unknown): QueryJobInterruption | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.cause !== 'string' || !RESTART_CAUSES.has(r.cause)) return undefined
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return undefined
  if (typeof r.incomplete !== 'boolean' || typeof r.resumable !== 'boolean' || !Array.isArray(r.alreadyDone)) return undefined
  const limits = QUERY_JOB_INTERRUPTION_LIMITS
  const cutOffDuring = typeof r.cutOffDuring === 'string' ? interruptionLine(r.cutOffDuring, limits.cutOffDuringChars) || null : null
  const alreadyDone = r.alreadyDone
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => interruptionLine(entry, limits.alreadyDoneEntryChars))
    .filter(Boolean)
    .slice(-limits.alreadyDoneMax)
  return {
    cause: r.cause as QueryJobRestartCause,
    at: r.at,
    cutOffDuring,
    alreadyDone,
    incomplete: r.incomplete,
    resumable: r.resumable,
  }
}

/** 6.78.0 Messages steer: the bounds (contract messages-steer.json `limits`). */
export const QUERY_JOB_STEER_LIMITS = Object.freeze({
  steerChars: 4_000,
  /** Steers a client may send to one job. Carried steers (from an earlier generation) do not count. */
  steersPerJob: 8,
})

/**
 * 6.78.0: a steer's state (contract messages-steer.json `states`).
 *
 *   accepted     journaled; written to the CLI, or waiting for the first line
 *   delivered    the CLI replayed it: it has it
 *   folded       a result covered it: the answer includes it
 *   included     composed into the first prompt (sent before the start, or carried from an
 *                interrupted or failed generation)
 *   too_late     the run could not take it any more (answering, ended, or near a deadline)
 *   unsupported  this run cannot be steered (Codex, Cursor, Ollama, a dispatch, an old client)
 *   not_applied  NEVER journaled: read for an accepted or delivered steer of an ended job
 */
export const QUERY_JOB_STEER_STATES = ['accepted', 'delivered', 'folded', 'included', 'too_late', 'unsupported', 'not_applied'] as const
export type QueryJobSteerState = typeof QUERY_JOB_STEER_STATES[number]
export type QueryJobJournaledSteerState = Exclude<QueryJobSteerState, 'not_applied'>
const JOURNALED_STEER_STATES: ReadonlySet<string> = new Set(QUERY_JOB_STEER_STATES.filter(state => state !== 'not_applied'))

export interface QueryJobSteer {
  steerId: string
  state: QueryJobSteerState
  /** When the current state was journaled. */
  at: string
  text: string
  /** The generation it was first sent to, when it was carried into this one. */
  carriedFrom?: number
}

/** A steer state only moves forward: accepted, then delivered, then a final state. */
export function steerStateRank(state: string): number {
  return state === 'accepted' ? 1 : state === 'delivered' ? 2 : 3
}

/** The state a client reads: an accepted or delivered steer of an ended job did not apply. */
export function steerReadState(state: QueryJobSteerState, jobStatus: QueryJobStatus): QueryJobSteerState {
  return isTerminalQueryJobStatus(jobStatus) && (state === 'accepted' || state === 'delivered') ? 'not_applied' : state
}

/**
 * What the client does with a steer that will not reach this run. `queue_follow_up`: send it as
 * the next Ask. Null: nothing (it applied, it may have applied, it is carried by Retry or
 * Resume, or the run was canceled).
 *
 * Decided from the JOURNALED state, never the read one (P7 S1). A steer the CLI replayed
 * (`delivered`) reached the run: a deadline, inactivity, a restart or a second-turn error can
 * still complete the job from its checkpoint, and the read state is then `not_applied`, but
 * the guidance may already be in the answer or in Claude's session. Sending it again as an Ask
 * would apply it twice, which the plan forbids, so a delivered steer never falls back.
 */
export function steerFallback(journaled: QueryJobSteerState, jobStatus: QueryJobStatus): 'queue_follow_up' | null {
  if (journaled === 'too_late' || journaled === 'unsupported') return 'queue_follow_up'
  if (journaled === 'delivered') return null
  if (steerReadState(journaled, jobStatus) === 'not_applied' && jobStatus === 'completed') return 'queue_follow_up'
  return null
}

/** One `steer` journal row: a state, or a steered run's answer checkpoint. */
export type QueryJobSteerRow =
  | { kind: 'state'; steerId: string; state: QueryJobJournaledSteerState; textSha256: string; text?: string; carriedFrom?: number }
  | { kind: 'checkpoint'; text: string; truncated: boolean }

/** The only shapes a `steer` row may have. Null means malformed. */
export function parseQueryJobSteerRow(raw: unknown): QueryJobSteerRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.checkpoint && typeof r.checkpoint === 'object') {
    const c = r.checkpoint as Record<string, unknown>
    if (typeof c.text !== 'string' || c.text.length > QUERY_JOB_LIMITS.partialChars) return null
    return { kind: 'checkpoint', text: c.text, truncated: c.truncated === true }
  }
  if (typeof r.steerId !== 'string' || !CLIENT_JOB_ID_RE.test(r.steerId)) return null
  if (typeof r.state !== 'string' || !JOURNALED_STEER_STATES.has(r.state)) return null
  if (typeof r.textSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.textSha256)) return null
  if (r.text !== undefined && (typeof r.text !== 'string' || r.text.length > QUERY_JOB_STEER_LIMITS.steerChars)) return null
  const carriedFrom = r.carriedFrom === undefined ? undefined : Number(r.carriedFrom)
  if (carriedFrom !== undefined && (!Number.isSafeInteger(carriedFrom) || carriedFrom < 1)) return null
  return {
    kind: 'state', steerId: r.steerId, state: r.state as QueryJobJournaledSteerState, textSha256: r.textSha256,
    ...(typeof r.text === 'string' ? { text: r.text } : {}),
    ...(carriedFrom !== undefined ? { carriedFrom } : {}),
  }
}

/** Steer text as the journal and the CLI get it: control characters out, trimmed, bounded. */
export function parseSteerText(raw: unknown): string {
  if (typeof raw !== 'string') throw new QueryJobValidationError('invalid_steer_text')
  const text = raw.replace(CONTROL_RE, '').trim()
  if (!text) throw new QueryJobValidationError('invalid_steer_text')
  if (text.length > QUERY_JOB_STEER_LIMITS.steerChars) throw new QueryJobValidationError('steer_text_too_large')
  return text
}

/** A steer id is a client-minted UUID v4, lowercased. */
export function parseSteerId(raw: unknown): string {
  if (typeof raw !== 'string' || !CLIENT_JOB_ID_RE.test(raw.toLowerCase())) throw new QueryJobValidationError('invalid_steer_id')
  return raw.toLowerCase()
}

export function steerTextSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface QueryJobActivity {
  eventSeq: number
  at: string
  kind: QueryJobActivityKind
  text: string
  repeatCount?: number
}

/** One entry of `snapshot.trail`: the journaled draft, its dense `trailSeq` (the trail's
 * own cursor, never the job eventSeq) and when it was written. */
export type QueryJobTrailEntry = JobTrailDraft & {
  trailSeq: number
  at: string
}

export interface QueryJobSnapshot extends QueryJobProviderLinkage {
  schemaVersion: typeof QUERY_JOB_SCHEMA_VERSION
  jobId: string
  clientJobId: string
  generation: number
  turnId: string
  requestFingerprint: string
  status: QueryJobStatus
  eventSeq: number
  oldestEventSeq: number
  sessionId: string
  requestedModel?: string
  effort?: string
  cursorExecutionMode?: string
  messageEra?: string
  globalMsgNum?: number
  handoffCode?: string
  attachments: MediaAttachmentRef[]
  partialText: string
  partialTruncated: boolean
  response?: string
  responseTruncated?: boolean
  outputImageStats?: QueryJobOutputImageStats
  error?: QueryJobError
  /** 6.78.0: what a restart cut off (see QueryJobInterruption). Only on a job a restart ended. */
  interruption?: QueryJobInterruption
  /**
   * 6.78.0: the steers sent to this job, in arrival order, with the state JOURNALED (a reader
   * computes `not_applied`, see steerReadState). ABSENT on a job with no steer, and stripped
   * from every snapshot sent to a client that did not ask with `?steer=1`.
   */
  steers?: QueryJobSteer[]
  activity: QueryJobActivity[]
  /** The readable trail (6.52.0), bounded by `QUERY_JOB_LIMITS.trailEntries` and
   * `trailChars`, rebuilt from the journal on restart. ABSENT, never `[]`, on a job
   * with no trail rows, and stripped from every snapshot sent to a client that did not
   * ask for the trail (`?trail=1`), so such a client sees exactly the 6.51.0 shape. */
  trail?: QueryJobTrailEntry[]
  acceptedAt: string
  startedAt?: string
  answerReadyAt?: string
  /** Fsynced only after the provider child exists and before prompt bytes are
   * written. Run ids alone can be allocated before a child owns the session. */
  providerOwnershipConfirmedAt?: string
  updatedAt: string
  completedAt?: string
  acknowledgedAt?: string
  orphanFenceUntil?: string
  retentionUntil: string
}

export interface QueryJobEvent {
  type: QueryJobEventType
  eventSeq: number
  jobId: string
  clientJobId: string
  generation: number
  status: QueryJobStatus
  at: string
  data: Record<string, unknown>
}

export interface QueryJobReplay {
  events: QueryJobEvent[]
  gap: boolean
  reason?: 'cursor_ahead' | 'buffer_overflow'
  oldestEventSeq: number
  latestEventSeq: number
  snapshot: QueryJobSnapshot
}

export interface QueryJobStoreHealth {
  state: 'new' | 'ready' | 'degraded'
  bootId: string
  hydratedJobs: number
  retainedIdentities: number
  subscribers: number
  malformedRows: number
  journalFailures: number
  interruptedOnBoot: number
  /** Never-started jobs a prior boot left `accepted` that this boot runs (6.61.3).
   * Optional only because the vendored 6.51.0 rollback fixture types its health
   * against this interface and must stay byte-identical; this build always sets it. */
  requeuedOnBoot?: number
  evictedHydratedJobs: number
  /** Requests whose `origin` was present but not one this build recognises
   * (a bare string, or an object of a later build's kind) and was dropped. */
  originDropped: number
  /** Public-route admissions that had `dispatch` or `origin.kind==='task'` stripped. */
  originStripped: number
  /** Journal `accepted` records whose stored fingerprint no longer matches the
   * running build's `requestFingerprint` — each one is a job that did NOT
   * hydrate. Zero is the only healthy value. */
  fingerprintMismatches: number
  lastErrorCode: string | null
  lastSuccessfulWriteAt: string | null
  rootFingerprint: string
  counts: Record<QueryJobStatus, number>
}

const CLIENT_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isClientJobId(value: string): boolean {
  return CLIENT_JOB_ID_RE.test(value.toLowerCase())
}
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/gi,
]
const PATH_PATTERNS: RegExp[] = [
  /\/(?:Users|home|private|var|tmp|Volumes)\/[A-Za-z0-9_.@%+~/-]+/g,
  /(?:[A-Za-z]:\\|\\\\)[^\s"']+/g,
  /~\/[A-Za-z0-9_.@%+~/-]+/g,
]

export class QueryJobValidationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'QueryJobValidationError'
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new QueryJobValidationError(`invalid_${field}`)
  const cleaned = value.replace(CONTROL_RE, '').trim()
  if (!cleaned || cleaned.length > max) throw new QueryJobValidationError(`invalid_${field}`)
  return cleaned
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  return requiredString(value, field, max)
}

function boundedContent(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new QueryJobValidationError(`invalid_${field}`)
  if (value.length > max) throw new QueryJobValidationError(`${field}_too_large`)
  const cleaned = value.replace(CONTROL_RE, '')
  if (!allowEmpty && !cleaned.trim()) throw new QueryJobValidationError(`invalid_${field}`)
  return cleaned
}

/** Parse untrusted admission input into the only request shape allowed in the
 * private journal. Unknown keys are dropped before fingerprinting. */
export function parseQueryJobRequest(raw: unknown, options: ParseQueryJobRequestOptions = {}): QueryJobRequest {
  if (!raw || typeof raw !== 'object') throw new QueryJobValidationError('invalid_request')
  const input = raw as Record<string, unknown>
  const clientJobId = requiredString(input.clientJobId, 'client_job_id', 36).toLowerCase()
  if (!CLIENT_JOB_ID_RE.test(clientJobId)) throw new QueryJobValidationError('invalid_client_job_id')

  const generation = Number(input.generation)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new QueryJobValidationError('invalid_generation')
  }

  const query = boundedContent(input.query, 'query', QUERY_JOB_LIMITS.promptChars, true)
  const sessionId = requiredString(input.sessionId, 'session_id', 128)
  if (!SAFE_ID_RE.test(sessionId)) throw new QueryJobValidationError('invalid_session_id')

  const model = optionalString(input.model, 'model', 64)
  const effort = optionalString(input.effort, 'effort', 32)
  const cursorExecutionModeRaw = optionalString(input.cursorExecutionMode, 'cursor_execution_mode', 16)
  const cursorExecutionMode = cursorExecutionModeRaw === 'agent' || cursorExecutionModeRaw === 'ask'
    ? cursorExecutionModeRaw
    : undefined
  const messageEra = optionalString(input.messageEra, 'message_era', 80)
  const handoffCode = optionalString(input.handoffCode, 'handoff_code', 128)
  const clientQueueItemId = optionalString(input.clientQueueItemId, 'client_queue_item_id', 120)
  const sessionName = sanitizeSessionName(input.sessionName)
  const globalMsgNum = input.globalMsgNum == null ? undefined : Number(input.globalMsgNum)
  if (globalMsgNum != null && (!Number.isSafeInteger(globalMsgNum) || globalMsgNum < 1)) {
    throw new QueryJobValidationError('invalid_global_msg_num')
  }

  let reference: QueryJobPromptReference | undefined
  if (input.reference != null) {
    if (!input.reference || typeof input.reference !== 'object') {
      throw new QueryJobValidationError('invalid_reference')
    }
    const ref = input.reference as Record<string, unknown>
    reference = {
      query: boundedContent(ref.query, 'reference_query', QUERY_JOB_LIMITS.referenceQueryChars),
      response: boundedContent(ref.response, 'reference_response', QUERY_JOB_LIMITS.referenceResponseChars),
    }
  }

  const activityToolMode: QueryJobActivityMode = input.activityToolMode === 'off'
    || input.activityToolMode === 'preview'
    ? input.activityToolMode
    : 'status'

  // `== null` covers both absent and JSON null, the way `reference` and
  // `globalMsgNum` are read above. A non-object (the phone's local `'g2'`
  // string) is silently absent on every path; the store counts the drop.
  let origin: QueryJobOrigin | undefined
  if (input.origin != null && typeof input.origin === 'object') {
    const candidate = input.origin as Record<string, unknown>
    const kind = candidate.kind
    const id = candidate.id
    if (kind === 'routine' || kind === 'task') {
      if (typeof id === 'string' && QUERY_JOB_ORIGIN_ID_RE.test(id)) {
        origin = { kind, id }
      } else if (options.strictOrigin) {
        // A kind this build knows with an id it cannot accept is a bug in the
        // caller that stamped it (the scheduler, the dispatcher): loud.
        throw new QueryJobValidationError('invalid_origin')
      }
    }
    // A kind this build does NOT know is a label it cannot render, never a
    // reason to refuse the job: the public job route reaches this parser with
    // strictOrigin, so an unknown kind must degrade to unlabeled (and be
    // counted by the store), or a newer client would have every prompt 400'd.
  }

  const dispatch = parseDispatch(input.dispatch)
  if (options.strictOrigin && origin?.kind === 'task' && !dispatch) {
    throw new QueryJobValidationError('invalid_dispatch')
  }

  const attachmentIds = parseMediaIdList(input.attachmentIds)
  const attachmentRefs = parseMediaAttachmentRefs(input.attachmentRefs ?? input.attachments)
  if (!query.trim() && attachmentIds.length === 0 && attachmentRefs.length === 0) {
    throw new QueryJobValidationError('query_or_attachment_required')
  }

  return {
    clientJobId,
    generation,
    query,
    sessionId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(cursorExecutionMode ? { cursorExecutionMode } : {}),
    ...(messageEra ? { messageEra } : {}),
    ...(globalMsgNum ? { globalMsgNum } : {}),
    ...(reference ? { reference } : {}),
    ...(handoffCode ? { handoffCode } : {}),
    ...(input.handoffLatest === true ? { handoffLatest: true } : {}),
    ...(clientQueueItemId ? { clientQueueItemId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(input.steerable === true ? { steerable: true as const } : {}),
    attachmentIds,
    attachmentRefs,
    activityToolMode,
    ...(origin ? { origin } : {}),
    ...(dispatch ? { dispatch } : {}),
  }
}

function parseDispatch(raw: unknown): QueryJobRequest['dispatch'] | undefined {
  if (raw == null) return undefined
  if (!raw || typeof raw !== 'object') throw new QueryJobValidationError('invalid_dispatch')
  const rec = raw as Record<string, unknown>
  if (rec.restricted !== true || !Array.isArray(rec.tools) || rec.tools.length === 0) {
    throw new QueryJobValidationError('invalid_dispatch')
  }
  const tools = rec.tools.map(String)
  if (tools.some(tool => !(DISPATCH_ALLOWED_TOOLS as readonly string[]).includes(tool))) {
    throw new QueryJobValidationError('invalid_dispatch')
  }
  return { restricted: true, tools }
}

/** True when the raw admission/journal input carried an `origin` the parser
 * did not keep — a bare string, or an object shape this build does not know.
 * The store counts these; the parser stays pure. */
export function originWasDropped(raw: unknown, request: QueryJobRequest): boolean {
  if (!raw || typeof raw !== 'object') return false
  const rawOrigin = (raw as Record<string, unknown>).origin
  return rawOrigin != null && request.origin == null
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
}

/**
 * The request keys that make up a job's IDENTITY — frozen at the sixteen keys
 * `QueryJobRequest` had before `origin` existed. Provenance and enforcement
 * keys (`origin`, and any later `trustMode`/`toolAllowlist`) are deliberately
 * outside it: a build that does not know a key must still hydrate the journal
 * a newer build wrote, and a rollback must never discard a week of jobs.
 *
 * Consequence, stated: two submissions for the same (clientJobId, generation)
 * that differ only in those excluded keys are the SAME job, and the second
 * returns the first. The scheduled brief reuses one identity per DAY across
 * its three attempts, and its excluded keys never differ between attempts; a
 * genuine resubmit differs in `globalMsgNum`, which IS in the fingerprint, so
 * it conflicts rather than silently adopting. Phone prompts never send an
 * excluded key.
 *
 * Pick contract: an absent key stays absent. The parser never materialises an
 * optional as null/''/0/[] (every optional is a conditional spread in its
 * return literal), and `JSON.stringify` drops an undefined value, so the pick
 * needs no guard of its own. A `?? null` pick WOULD re-hash every stored
 * request and silently drop the journal; the test pins that property.
 */
export const FINGERPRINT_KEYS = [
  'clientJobId', 'generation', 'query', 'sessionId', 'model', 'effort',
  'cursorExecutionMode', 'messageEra', 'globalMsgNum', 'reference', 'handoffCode',
  'handoffLatest', 'clientQueueItemId', 'attachmentIds', 'attachmentRefs',
  'activityToolMode',
] as const satisfies readonly (keyof QueryJobRequest)[]

/** The request keys deliberately OUTSIDE the identity. Every key of
 * `QueryJobRequest` must appear in exactly one of the two lists: adding a key
 * without naming it here or above fails to compile, so the author picks a side. */
export const FINGERPRINT_EXCLUDED = ['origin', 'dispatch', 'sessionName', 'steerable'] as const satisfies readonly (keyof QueryJobRequest)[]
type FingerprintUncovered = Exclude<keyof QueryJobRequest, typeof FINGERPRINT_KEYS[number] | typeof FINGERPRINT_EXCLUDED[number]>
export const FINGERPRINT_KEYS_COVER_REQUEST: FingerprintUncovered extends never ? true : never = true

function pickFingerprintKeys(request: QueryJobRequest): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of FINGERPRINT_KEYS) picked[key] = request[key]
  return picked
}

export function requestFingerprint(request: QueryJobRequest): string {
  return createHash('sha256').update(JSON.stringify(canonical(pickFingerprintKeys(request)))).digest('hex')
}

export function isTerminalQueryJobStatus(status: QueryJobStatus): status is QueryJobTerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'canceled' || status === 'interrupted'
}

export function boundedText(value: unknown, max: number): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value.replace(CONTROL_RE, '') : String(value ?? '')
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true }
}

export function parseQueryJobOutputImageStats(raw: unknown): QueryJobOutputImageStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const counts = [value.published, value.attached, value.rejected]
  if (!counts.every(count => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000)) {
    return undefined
  }
  const [published, attached, rejected] = counts as number[]
  if (attached > published || rejected > published || attached + rejected > published) return undefined
  return { published, attached, rejected }
}

/** The store's own credential and local-path patterns, applied to free text with
 * nothing else changed: no whitespace collapsing, no bound, newlines kept. The trail
 * sanitizer (lib/job-trail.ts) runs this after `redactSecretText`, so a trail field
 * passes BOTH redaction layers before it reaches the journal. */
export function redactQueryJobText(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  let text = value
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, '[path]')
  return text
}

/** Second-line redaction even for bridge-produced "safe" activity. This is
 * intentionally conservative: replay never needs a credential or local path. */
export function sanitizeQueryJobActivity(value: unknown): { text: string; truncated: boolean } {
  let text = typeof value === 'string' ? value : String(value ?? '')
  text = text.replace(CONTROL_RE, ' ')
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, '[path]')
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return boundedText(text || 'Processing...', QUERY_JOB_LIMITS.activityChars)
}

export function normalizeQueryJobError(error: unknown, fallbackCode = 'query_job_failed'): QueryJobError {
  const candidate = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const rawCode = typeof candidate.code === 'string' ? candidate.code : fallbackCode
  const code = /^[a-z0-9_.-]{1,80}$/i.test(rawCode) ? rawCode : fallbackCode
  const rawMessage = error instanceof Error ? error.message
    : typeof candidate.message === 'string' ? candidate.message
      : typeof error === 'string' ? error : fallbackCode
  const safe = sanitizeQueryJobActivity(rawMessage)
  return {
    code: providerFailureCode(code, typeof rawMessage === 'string' ? rawMessage : ''),
    message: safe.text,
    ...(candidate.retryable === true ? { retryable: true } : {}),
    ...(typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)
      ? { retryAfterMs: Math.max(0, Math.ceil(candidate.retryAfterMs)) } : {}),
    ...(typeof candidate.cause === 'string' && QUERY_JOB_ERROR_CAUSES.has(candidate.cause) ? { cause: candidate.cause } : {}),
  }
}

export function parsePositiveInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed : undefined
}
