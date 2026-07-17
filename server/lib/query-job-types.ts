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

/** Immutable, persistence-safe request. Provider-only objects (paths, image
 * bytes, AbortControllers, handoff runtime state) deliberately do not fit. */
export interface QueryJobRequest {
  clientJobId: string
  generation: number
  query: string
  sessionId: string
  model?: string
  effort?: string
  messageEra?: string
  globalMsgNum?: number
  reference?: QueryJobPromptReference
  handoffCode?: string
  handoffLatest?: boolean
  clientQueueItemId?: string
  attachmentIds: string[]
  attachmentRefs: MediaAttachmentRef[]
  activityToolMode: QueryJobActivityMode
}

export interface QueryJobProviderLinkage {
  provider?: 'claude' | 'codex'
  resolvedModel?: string
  cliSessionId?: string
  claudeRunId?: string
  codexRunId?: string
  codexThreadId?: string
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
export function parseQueryJobRequest(raw: unknown): QueryJobRequest {
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
    ...(messageEra ? { messageEra } : {}),
    ...(globalMsgNum ? { globalMsgNum } : {}),
    ...(reference ? { reference } : {}),
    ...(handoffCode ? { handoffCode } : {}),
    ...(input.handoffLatest === true ? { handoffLatest: true } : {}),
    ...(clientQueueItemId ? { clientQueueItemId } : {}),
    attachmentIds,
    attachmentRefs,
    activityToolMode,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
}

export function requestFingerprint(request: QueryJobRequest): string {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex')
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
