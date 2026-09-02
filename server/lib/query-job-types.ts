import { createHash } from 'node:crypto'
import {
  parseMediaAttachmentRefs,
  parseMediaIdList,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'

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

export type QueryJobActivityMode = 'off' | 'status' | 'preview'
export type QueryJobActivityKind = 'status' | 'input' | 'output' | 'gap'

export interface QueryJobPromptReference {
  query: string
  response: string
}

/**
 * Who STARTED a job, when it was not the person holding the phone or the
 * glasses. A label, nothing more: the server never infers anything from its
 * absence (Miles, 2026-09-02). `routine` is the scheduler (`morning-brief`),
 * `task` is a dispatch of a captured task (the id is the task's 12-hex id).
 * Human prompts typed on the phone carry no origin; the phone stamps `g2`
 * locally for prompts spoken on the glasses and never sends it here.
 */
export interface QueryJobOrigin {
  kind: 'routine' | 'task'
  id: string
}

/** One alphabet for both kinds: `morning-brief` and a 12-hex task id both fit.
 * Up to 64 chars — COS Control bounds `originId` to the same length. */
export const QUERY_JOB_ORIGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface ParseQueryJobRequestOptions {
  /** Admission: a present-but-malformed origin OBJECT is a bug in the caller
   * (only the server's own scheduler and dispatcher send one) and throws.
   * Hydration leaves this off: a record written by another build must still
   * hydrate, with the unknown origin dropped and counted. A bare STRING origin
   * is dropped on both paths — it is the phone's local `'g2'` shape, never an
   * error. */
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
}

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
}

export interface QueryJobActivity {
  eventSeq: number
  at: string
  kind: QueryJobActivityKind
  text: string
  repeatCount?: number
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
  activity: QueryJobActivity[]
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
  evictedHydratedJobs: number
  /** Requests whose `origin` was present but not one this build recognises
   * (a bare string, or an object of a later build's kind) and was dropped. */
  originDropped: number
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
    if ((kind === 'routine' || kind === 'task') && typeof id === 'string' && QUERY_JOB_ORIGIN_ID_RE.test(id)) {
      origin = { kind, id }
    } else if (options.strictOrigin) {
      throw new QueryJobValidationError('invalid_origin')
    }
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
    attachmentIds,
    attachmentRefs,
    activityToolMode,
    ...(origin ? { origin } : {}),
  }
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
 * returns the first. Server-started jobs mint one identity per run, so this
 * never bites them; for phone prompts the excluded keys are never sent.
 *
 * Pick contract: an absent key is OMITTED. It is never materialised as
 * null/''/0/[] — `JSON.stringify` drops undefined but keeps null, so a `?? null`
 * pick would re-hash every stored request and silently drop the journal.
 */
export const FINGERPRINT_KEYS = [
  'clientJobId', 'generation', 'query', 'sessionId', 'model', 'effort',
  'cursorExecutionMode', 'messageEra', 'globalMsgNum', 'reference', 'handoffCode',
  'handoffLatest', 'clientQueueItemId', 'attachmentIds', 'attachmentRefs',
  'activityToolMode',
] as const satisfies readonly (keyof QueryJobRequest)[]

function pickFingerprintKeys(request: QueryJobRequest): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of FINGERPRINT_KEYS) {
    const value = request[key]
    if (value !== undefined) picked[key] = value
  }
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
    code,
    message: safe.text,
    ...(candidate.retryable === true ? { retryable: true } : {}),
    ...(typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)
      ? { retryAfterMs: Math.max(0, Math.ceil(candidate.retryAfterMs)) } : {}),
  }
}

export function parsePositiveInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed : undefined
}
