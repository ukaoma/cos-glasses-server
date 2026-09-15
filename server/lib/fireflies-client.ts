// Fireflies GraphQL client for the meeting importer (6.47.0).
//
// This is the ONLY code in this release that talks to a vendor. Everything it
// can be told by that vendor is reduced to one small taxonomy before it reaches
// a caller, and the upstream body is never echoed: a vendor error message can
// carry an account name, a meeting title, or the key itself, and every surface
// that renders importer state (COS Control, the lens, a log line) is a place it
// would then leak to.
//
// HOW IT STOPS, the question every new network caller in this repo must answer:
//   - a daily budget ledger, capped by the user's declared plan, stopping two
//     calls short of the cap so a user-initiated key check always has room;
//   - a 50-call-per-minute pace, below the vendor's published 60;
//   - bounded 5xx retries (3, at 5s/15s/30s) and no retry at all on the
//     interactive key check, which a person is waiting on;
//   - key checks throttled to one per 10 minutes unless a person asked for it.
//
// PAGE SIZE IS ADAPTIVE, and that is a correctness property rather than a
// performance one: a list page carries every sentence of every meeting in it
// (a canary page of 50 measured 2.07 MB in 3.6 s), so one unusually long
// meeting can push a page past the response cap or the timeout forever. The
// descent 50 then 10 then 1 isolates that meeting, records it as a retryable
// skip, and lets the cursor move past it. Without it a single bad transcript
// stalls every later import.
//
// NOTHING HERE TOUCHES THE FILESYSTEM except the budget ledger, and nothing
// here knows what an import record looks like. Parsing the vendor's shape into
// a record is `normalizeFirefliesTranscript`; writing one is the library.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { localDay } from './local-day.js'
import { securePrivateDirectory } from './secure-user-config.js'

export const FIREFLIES_ENDPOINT = 'https://api.fireflies.ai/graphql'

/** Descent order for a list page. Each step is tried at the same cursor. */
export const FIREFLIES_PAGE_SIZES = [50, 10, 1] as const
/** One call span. The cursor advances by this much per successful listPage(). */
export const FIREFLIES_PAGE_SPAN = FIREFLIES_PAGE_SIZES[0]
export const FIREFLIES_PAGE_TIMEOUT_MS = 30_000
/** A person is waiting on the key check, so it gets a shorter leash and no retries. */
export const FIREFLIES_KEY_CHECK_TIMEOUT_MS = 15_000
export const FIREFLIES_MAX_RESPONSE_BYTES = 20 * 1024 * 1024
/** The vendor publishes 60/min. Staying under it is cheaper than handling 429s. */
export const FIREFLIES_CALLS_PER_MINUTE = 50
export const FIREFLIES_RATE_WINDOW_MS = 60_000
export const FIREFLIES_SERVER_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const
/** Calls held back from the daily cap for user-initiated key checks. */
export const FIREFLIES_DAILY_CAP_RESERVE = 2
export const FIREFLIES_KEY_CHECK_THROTTLE_MS = 10 * 60_000
export const FIREFLIES_PLAN_CAPS = { free: 50, pro: 500, business: null } as const

/**
 * Accepted vendor id shape. Measured against 463 ids in this Mac's own pipeline
 * state on 2026-09-14: every one is a 26-character uppercase ULID. Older ids in
 * the wild are shorter alphanumerics, so the class is deliberately wider than
 * the measurement and narrower than "any string" - an id outside it would reach
 * a filename and a hash, and is worth an alarm rather than a silent import.
 */
export const FIREFLIES_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export type FirefliesPlan = keyof typeof FIREFLIES_PLAN_CAPS

export type FirefliesFailureState =
  | 'invalid_key'
  | 'rate_limited'
  | 'vendor_down'
  | 'unreachable'
  | 'vendor_error'
  | 'cap_exhausted'

export interface FirefliesFailure {
  state: FirefliesFailureState
  httpStatus?: number
  retryAfterSeconds?: number
  /** A sanitized vendor error code. Never a vendor message. */
  code?: string
}

export interface FirefliesRequest {
  key: string
  body: string
  timeoutMs: number
  maxBytes: number
}

export type FirefliesTransportOutcome =
  | { kind: 'http'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }

export type FirefliesTransport = (request: FirefliesRequest) => Promise<FirefliesTransportOutcome>

export interface FirefliesSentence {
  speakerName: string
  speakerId: string | null
  text: string
  startTime: number
  endTime: number
}

export interface FirefliesTranscriptRecord {
  id: string
  title: string
  dateMs: number
  /** null means the vendor gave no duration and the sentences implied none. */
  durationSeconds: number | null
  durationSource: 'vendor' | 'sentence_span' | 'unknown'
  organizerEmail: string | null
  participants: string[]
  sentences: FirefliesSentence[]
  /** The vendor's summary. Absent on plans or meetings that have none, which
   *  is a normal state and never a reason to refuse a meeting: the transcript
   *  is the record, and the summary is something extra on top of it. */
  overview: string | null
  /** ONE string with newlines in it, not a list. Split at the render. */
  actionItems: string | null
  keywords: string[]
}

export type FirefliesSkipReason =
  | 'missing_id'
  | 'id_shape_changed'
  | 'missing_date'
  | 'date_string'
  | 'malformed_sentences'
  | 'still_processing'

export type FirefliesNormalizeResult =
  | { ok: true; record: FirefliesTranscriptRecord }
  | { ok: false; reason: FirefliesSkipReason }

export interface FirefliesKeyCheck {
  state: 'ok' | 'not_configured' | FirefliesFailureState
  httpStatus?: number
  retryAfterSeconds?: number
  code?: string
  checkedAt: string
  /** True when the throttle served a remembered answer instead of calling out. */
  cached: boolean
}

export interface FirefliesPageResult {
  transcripts: unknown[]
  /** Where the caller should resume. Always advances past what was consumed. */
  nextSkip: number
  endOfList: boolean
  /** Single transcripts that exceed the response cap even alone. */
  oversized: Array<{ skip: number; id: string | null }>
  failure?: FirefliesFailure
  calls: number
  /** Page sizes actually requested, oldest first. Diagnostics and tests. */
  pageSizes: number[]
}

interface BudgetFile {
  version: 1
  day: string
  calls: number
  plan: FirefliesPlan
  updatedAt: string
}

/**
 * Daily call ledger. Written atomically at 0600 because it is the only thing
 * standing between a looping importer and a user's monthly vendor quota.
 */
export class FirefliesBudget {
  private readonly path: string
  private readonly now: () => number
  private state: BudgetFile

  constructor(options: { path: string; now?: () => number }) {
    this.path = options.path
    this.now = options.now ?? (() => Date.now())
    this.state = this.load()
  }

  private load(): BudgetFile {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      // Missing or unreadable both mean "no spend recorded here". A ledger we
      // cannot read must not be treated as permission to spend without one, so
      // the fresh ledger is written back on the first consume.
      return { version: 1, day: localDay(this.now()), calls: 0, plan: 'free', updatedAt: new Date(this.now()).toISOString() }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BudgetFile>
      const plan: FirefliesPlan = parsed.plan === 'pro' || parsed.plan === 'business' ? parsed.plan : 'free'
      return {
        version: 1,
        day: typeof parsed.day === 'string' ? parsed.day : localDay(this.now()),
        calls: typeof parsed.calls === 'number' && Number.isFinite(parsed.calls) ? Math.max(0, Math.trunc(parsed.calls)) : 0,
        plan,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(this.now()).toISOString(),
      }
    } catch {
      return { version: 1, day: localDay(this.now()), calls: 0, plan: 'free', updatedAt: new Date(this.now()).toISOString() }
    }
  }

  private rollDay(): void {
    const day = localDay(this.now())
    if (this.state.day !== day) {
      this.state = { ...this.state, day, calls: 0 }
    }
  }

  private persist(): void {
    this.state.updatedAt = new Date(this.now()).toISOString()
    securePrivateDirectory(dirname(this.path))
    durableAtomicWriteFileSync(this.path, JSON.stringify(this.state), { mode: 0o600 })
  }

  plan(): FirefliesPlan {
    return this.state.plan
  }

  setPlan(plan: FirefliesPlan): void {
    this.rollDay()
    this.state.plan = plan
    this.persist()
  }

  /** Daily cap for the declared plan. null means the plan has no daily cap. */
  cap(): number | null {
    return FIREFLIES_PLAN_CAPS[this.state.plan]
  }

  snapshot(): { day: string; calls: number; plan: FirefliesPlan; cap: number | null; remaining: number | null } {
    this.rollDay()
    const cap = this.cap()
    const limit = cap == null ? null : Math.max(0, cap - FIREFLIES_DAILY_CAP_RESERVE)
    return {
      day: this.state.day,
      calls: this.state.calls,
      plan: this.state.plan,
      cap,
      remaining: limit == null ? null : Math.max(0, limit - this.state.calls),
    }
  }

  /**
   * Claim one call. `reserved` spends into the two-call reserve, and is only
   * for a check a person started: it is what keeps "Check key" working on a day
   * an import already spent the budget.
   */
  tryConsume(options: { reserved?: boolean } = {}): boolean {
    this.rollDay()
    const cap = this.cap()
    if (cap != null) {
      const limit = options.reserved ? cap : Math.max(0, cap - FIREFLIES_DAILY_CAP_RESERVE)
      if (this.state.calls >= limit) return false
    }
    this.state.calls += 1
    this.persist()
    return true
  }
}

const LIST_FIELDS = 'id title date duration organizer_email participants'
const SENTENCE_FIELDS = 'sentences { speaker_name speaker_id text start_time end_time }'
/**
 * Canary-verified on 2026-09-14 with one live call: the field resolves with no
 * GraphQL error, `overview` and `action_items` come back as STRINGS (600-900
 * and 200-900 characters in the sample) and `keywords` as a list.
 *
 * Asked for only alongside sentences. The id-only probe exists to name a
 * transcript too large to fetch, so adding fields to it would work against the
 * one thing it is for.
 */
const SUMMARY_FIELDS = 'summary { overview action_items keywords }'
const DETAIL_FIELDS = `${LIST_FIELDS} ${SENTENCE_FIELDS} ${SUMMARY_FIELDS}`

export function firefliesListQuery(limit: number, skip: number, withSentences: boolean): string {
  const fields = withSentences ? `${LIST_FIELDS} ${SENTENCE_FIELDS} ${SUMMARY_FIELDS}` : LIST_FIELDS
  return JSON.stringify({
    query: `query CosImportList($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { ${fields} } }`,
    variables: { limit, skip },
  })
}

/** One transcript by id. Same fields as a list page carries for each row. */
export function firefliesTranscriptQuery(id: string): string {
  return JSON.stringify({
    query: `query CosImportDetail($id: String!) { transcript(id: $id) { ${DETAIL_FIELDS} } }`,
    variables: { id },
  })
}

export function firefliesKeyCheckQuery(): string {
  return JSON.stringify({ query: 'query CosKeyCheck { user { user_id } }' })
}

/** A vendor code is an identifier, never prose. Anything else is dropped. */
function sanitizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) ? trimmed : undefined
}

function graphqlErrorCodes(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return []
  const errors = (parsed as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []
  const codes: string[] = []
  for (const entry of errors) {
    if (!entry || typeof entry !== 'object') continue
    const direct = sanitizeCode((entry as { code?: unknown }).code)
    if (direct) codes.push(direct)
    const extensions = (entry as { extensions?: unknown }).extensions
    if (extensions && typeof extensions === 'object') {
      const nested = sanitizeCode((extensions as { code?: unknown }).code)
      if (nested) codes.push(nested)
    }
  }
  return codes
}

export function parseRetryAfterSeconds(headers: Record<string, string>, now: number): number | undefined {
  const header = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) return value
    }
    return undefined
  }
  const retryAfter = header('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter.trim())
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1_000))
  }
  const reset = header('x-ratelimit-reset-api')
  if (reset) {
    const value = Number(reset.trim())
    if (Number.isFinite(value) && value >= 0) {
      // The header is documented nowhere we can verify, so read it both ways:
      // a large value is an absolute instant, a small one is a delay.
      if (value > 1e12) return Math.max(0, Math.ceil((value - now) / 1_000))
      if (value > 1e9) return Math.max(0, Math.ceil(value - now / 1_000))
      return Math.ceil(value)
    }
  }
  return undefined
}

type ClassifiedResponse =
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'retry'; failure: FirefliesFailure }
  | { kind: 'failure'; failure: FirefliesFailure }

/**
 * The body is parsed BEFORE the status is interpreted. The vendor answers an
 * invalid key with HTTP 500 and a GraphQL `auth_failed`, so a status-first
 * reading reports a vendor outage and retries three times against a key that
 * will never work.
 */
export function classifyFirefliesResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
  now: number,
): ClassifiedResponse {
  let parsed: unknown
  let parseFailed = false
  try {
    parsed = JSON.parse(body)
  } catch {
    parseFailed = true
  }

  const codes = graphqlErrorCodes(parsed)
  if (codes.includes('auth_failed')) {
    return { kind: 'failure', failure: { state: 'invalid_key', httpStatus: status } }
  }
  if (status === 401 || status === 403) {
    return { kind: 'failure', failure: { state: 'invalid_key', httpStatus: status } }
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(headers, now)
    return {
      kind: 'failure',
      failure: { state: 'rate_limited', httpStatus: status, ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}) },
    }
  }
  if (status >= 500) {
    return { kind: 'retry', failure: { state: 'vendor_down', httpStatus: status } }
  }
  if (codes.length > 0) {
    return { kind: 'failure', failure: { state: 'vendor_error', httpStatus: status, code: codes[0] } }
  }
  if (status < 200 || status >= 300) {
    return { kind: 'failure', failure: { state: 'vendor_error', httpStatus: status, code: `http_${status}` } }
  }
  if (parseFailed || !parsed || typeof parsed !== 'object') {
    return { kind: 'failure', failure: { state: 'vendor_error', httpStatus: status, code: 'invalid_json' } }
  }
  const data = (parsed as { data?: unknown }).data
  if (!data || typeof data !== 'object') {
    return { kind: 'failure', failure: { state: 'vendor_error', httpStatus: status, code: 'invalid_payload' } }
  }
  return { kind: 'data', data: data as Record<string, unknown> }
}

function sentenceOf(raw: unknown): FirefliesSentence | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const startTime = Number(item.start_time)
  const endTime = Number(item.end_time)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  if (typeof item.text !== 'string') return null
  return {
    speakerName: typeof item.speaker_name === 'string' ? item.speaker_name : '',
    speakerId: typeof item.speaker_id === 'string' ? item.speaker_id : null,
    text: item.text,
    startTime,
    endTime,
  }
}

/**
 * Vendor shape to record, or the reason it cannot become one.
 *
 * Every refusal here is a COUNTED skip rather than a thrown error: one bad
 * transcript must never stop a backfill, and the reason is what tells a person
 * whether to wait (still_processing) or to look (id_shape_changed).
 */
export function normalizeFirefliesTranscript(raw: unknown): FirefliesNormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'missing_id' }
  const item = raw as Record<string, unknown>

  if (typeof item.id !== 'string' || item.id.trim().length === 0) return { ok: false, reason: 'missing_id' }
  const id = item.id.trim()
  if (!FIREFLIES_ID_PATTERN.test(id)) return { ok: false, reason: 'id_shape_changed' }

  if (typeof item.date === 'string') return { ok: false, reason: 'date_string' }
  const dateMs = typeof item.date === 'number' ? item.date : Number.NaN
  if (!Number.isFinite(dateMs)) return { ok: false, reason: 'missing_date' }

  const rawSentences = item.sentences
  if (rawSentences != null && !Array.isArray(rawSentences)) return { ok: false, reason: 'malformed_sentences' }
  const sentences: FirefliesSentence[] = []
  if (Array.isArray(rawSentences)) {
    for (const entry of rawSentences) {
      const sentence = sentenceOf(entry)
      if (!sentence) return { ok: false, reason: 'malformed_sentences' }
      sentences.push(sentence)
    }
  }
  // No sentences yet is the vendor still transcribing. The caller retries it on
  // a backoff and gives up only after the retry budget, because a meeting that
  // never produced speech would otherwise be retried forever.
  if (sentences.length === 0) return { ok: false, reason: 'still_processing' }

  const vendorDuration = typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
    ? Math.round(item.duration * 60)
    : null
  let durationSeconds = vendorDuration
  let durationSource: FirefliesTranscriptRecord['durationSource'] = vendorDuration == null ? 'unknown' : 'vendor'
  if (durationSeconds == null) {
    const starts = sentences.map(sentence => sentence.startTime)
    const ends = sentences.map(sentence => sentence.endTime)
    const span = Math.round(Math.max(...ends) - Math.min(...starts))
    if (span > 0) {
      durationSeconds = span
      durationSource = 'sentence_span'
    }
  }

  const participants = Array.isArray(item.participants)
    ? item.participants.filter((value): value is string => typeof value === 'string')
    : []

  // A missing or null summary is ABSENT, never an error. The field is not on
  // every plan and not on every meeting, and refusing a transcript over it
  // would throw away the thing we actually came for.
  const summary = item.summary && typeof item.summary === 'object' && !Array.isArray(item.summary)
    ? item.summary as Record<string, unknown>
    : null

  return {
    ok: true,
    record: {
      id,
      title: typeof item.title === 'string' ? item.title : '',
      dateMs,
      durationSeconds,
      durationSource,
      organizerEmail: typeof item.organizer_email === 'string' ? item.organizer_email : null,
      participants,
      sentences,
      overview: nonEmptyString(summary?.overview),
      actionItems: nonEmptyString(summary?.action_items),
      keywords: Array.isArray(summary?.keywords)
        ? (summary.keywords as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
    },
  }
}

/** A string the vendor actually filled in, or null. Whitespace is not content. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export interface FirefliesClientOptions {
  transport: FirefliesTransport
  /** Resolved at call time so a key change takes effect without a restart. */
  key: () => string | null
  budget: FirefliesBudget
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface PageAccumulator {
  transcripts: unknown[]
  oversized: Array<{ skip: number; id: string | null }>
  nextSkip: number
  endOfList: boolean
  calls: number
  pageSizes: number[]
  failure?: FirefliesFailure
  stop: boolean
}

type ListAttempt =
  | { kind: 'items'; items: unknown[] }
  | { kind: 'shrink'; reason: 'timeout' | 'too_large' | 'network_error' }
  | { kind: 'failure'; failure: FirefliesFailure }

export class FirefliesClient {
  private readonly transport: FirefliesTransport
  private readonly resolveKey: () => string | null
  private readonly budget: FirefliesBudget
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly callTimes: number[] = []
  private lastCheck: (FirefliesKeyCheck & { fingerprint: string }) | null = null

  constructor(options: FirefliesClientOptions) {
    this.transport = options.transport
    this.resolveKey = options.key
    this.budget = options.budget
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Stable, non-reversible identity for "the key changed". Never rendered. */
  static fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16)
  }

  private async pace(): Promise<void> {
    const cutoff = this.now() - FIREFLIES_RATE_WINDOW_MS
    while (this.callTimes.length > 0 && this.callTimes[0] <= cutoff) this.callTimes.shift()
    if (this.callTimes.length >= FIREFLIES_CALLS_PER_MINUTE) {
      const wait = this.callTimes[0] + FIREFLIES_RATE_WINDOW_MS - this.now()
      if (wait > 0) await this.sleep(wait)
      const after = this.now() - FIREFLIES_RATE_WINDOW_MS
      while (this.callTimes.length > 0 && this.callTimes[0] <= after) this.callTimes.shift()
    }
    this.callTimes.push(this.now())
  }

  private async send(
    key: string,
    body: string,
    options: { timeoutMs: number; reserved?: boolean; retryServerErrors: boolean },
    accounting: { calls: number },
  ): Promise<ClassifiedResponse | { kind: 'transport'; reason: 'timeout' | 'too_large' | 'network_error' } | { kind: 'failure'; failure: FirefliesFailure }> {
    for (let attempt = 0; ; attempt++) {
      if (!this.budget.tryConsume({ reserved: options.reserved })) {
        return { kind: 'failure', failure: { state: 'cap_exhausted' } }
      }
      await this.pace()
      accounting.calls += 1
      const outcome = await this.transport({
        key,
        body,
        timeoutMs: options.timeoutMs,
        maxBytes: FIREFLIES_MAX_RESPONSE_BYTES,
      })
      if (outcome.kind !== 'http') return { kind: 'transport', reason: outcome.kind === 'too_large' ? 'too_large' : outcome.kind }
      const classified = classifyFirefliesResponse(outcome.status, outcome.headers, outcome.body, this.now())
      if (classified.kind !== 'retry') return classified
      if (!options.retryServerErrors || attempt >= FIREFLIES_SERVER_RETRY_DELAYS_MS.length) {
        return { kind: 'failure', failure: classified.failure }
      }
      await this.sleep(FIREFLIES_SERVER_RETRY_DELAYS_MS[attempt])
    }
  }

  /**
   * Is this key usable? Throttled unless a person asked, so a status poll on
   * four surfaces cannot spend the budget on the same answer.
   */
  async checkKey(options: { userInitiated?: boolean } = {}): Promise<FirefliesKeyCheck> {
    const key = this.resolveKey()
    if (!key) {
      this.lastCheck = null
      return { state: 'not_configured', checkedAt: new Date(this.now()).toISOString(), cached: false }
    }
    const fingerprint = FirefliesClient.fingerprint(key)
    const userInitiated = options.userInitiated === true
    if (!userInitiated && this.lastCheck && this.lastCheck.fingerprint === fingerprint) {
      const age = this.now() - Date.parse(this.lastCheck.checkedAt)
      if (Number.isFinite(age) && age < FIREFLIES_KEY_CHECK_THROTTLE_MS) {
        const { fingerprint: _omit, ...cached } = this.lastCheck
        return { ...cached, cached: true }
      }
    }

    const accounting = { calls: 0 }
    const result = await this.send(
      key,
      firefliesKeyCheckQuery(),
      { timeoutMs: FIREFLIES_KEY_CHECK_TIMEOUT_MS, reserved: userInitiated, retryServerErrors: false },
      accounting,
    )
    const checkedAt = new Date(this.now()).toISOString()
    let check: FirefliesKeyCheck
    if (result.kind === 'transport') {
      check = { state: 'unreachable', checkedAt, cached: false }
    } else if (result.kind === 'failure') {
      check = { state: result.failure.state, ...failureFields(result.failure), checkedAt, cached: false }
    } else if (result.kind === 'data') {
      const user = (result.data as { user?: unknown }).user
      check = user && typeof user === 'object'
        ? { state: 'ok', checkedAt, cached: false }
        : { state: 'vendor_error', code: 'invalid_payload', checkedAt, cached: false }
    } else {
      check = { state: result.failure.state, ...failureFields(result.failure), checkedAt, cached: false }
    }
    this.lastCheck = { ...check, fingerprint }
    return check
  }

  /** The remembered answer, for a status read that must not spend a call. */
  cachedKeyCheck(): FirefliesKeyCheck | null {
    if (!this.lastCheck) return null
    const key = this.resolveKey()
    if (!key || FirefliesClient.fingerprint(key) !== this.lastCheck.fingerprint) return null
    const { fingerprint: _omit, ...cached } = this.lastCheck
    return { ...cached, cached: true }
  }

  /** Forget the remembered check. Called when the stored key changes. */
  forgetKeyCheck(): void {
    this.lastCheck = null
  }

  private async requestList(
    key: string,
    skip: number,
    limit: number,
    withSentences: boolean,
    out: PageAccumulator,
  ): Promise<ListAttempt> {
    out.pageSizes.push(limit)
    const accounting = { calls: 0 }
    const result = await this.send(
      key,
      firefliesListQuery(limit, skip, withSentences),
      { timeoutMs: FIREFLIES_PAGE_TIMEOUT_MS, retryServerErrors: true },
      accounting,
    )
    out.calls += accounting.calls
    if (result.kind === 'transport') return { kind: 'shrink', reason: result.reason }
    if (result.kind === 'failure') return { kind: 'failure', failure: result.failure }
    if (result.kind === 'retry') return { kind: 'failure', failure: result.failure }
    const transcripts = (result.data as { transcripts?: unknown }).transcripts
    if (!Array.isArray(transcripts)) {
      return { kind: 'failure', failure: { state: 'vendor_error', code: 'invalid_payload' } }
    }
    return { kind: 'items', items: transcripts }
  }

  /** Learn the id of a transcript too large to fetch, so it can be named in a skip. */
  private async identifyOversized(key: string, skip: number, out: PageAccumulator): Promise<string | null> {
    const attempt = await this.requestList(key, skip, 1, false, out)
    if (attempt.kind !== 'items' || attempt.items.length === 0) return null
    const first = attempt.items[0]
    if (!first || typeof first !== 'object') return null
    const id = (first as { id?: unknown }).id
    return typeof id === 'string' && FIREFLIES_ID_PATTERN.test(id) ? id : null
  }

  private async fetchRange(key: string, start: number, count: number, level: number, out: PageAccumulator): Promise<void> {
    const size = FIREFLIES_PAGE_SIZES[level]
    let offset = 0
    while (offset < count && !out.stop) {
      const chunk = Math.min(size, count - offset)
      const at = start + offset
      const attempt = await this.requestList(key, at, chunk, true, out)

      if (attempt.kind === 'items') {
        out.transcripts.push(...attempt.items)
        if (attempt.items.length < chunk) {
          out.nextSkip = at + attempt.items.length
          out.endOfList = true
          out.stop = true
          return
        }
        out.nextSkip = at + chunk
        offset += chunk
        continue
      }

      if (attempt.kind === 'failure') {
        out.failure = attempt.failure
        out.stop = true
        return
      }

      if (level + 1 < FIREFLIES_PAGE_SIZES.length) {
        await this.fetchRange(key, at, chunk, level + 1, out)
        if (out.stop) return
        offset += chunk
        continue
      }

      // Smallest page. A body over the cap is one unusually large transcript,
      // which becomes a retryable skip so the cursor can move past it. A
      // timeout or transport error at this size is the network, not the data.
      if (attempt.reason === 'too_large') {
        const id = await this.identifyOversized(key, at, out)
        if (out.stop) return
        out.oversized.push({ skip: at, id })
        out.nextSkip = at + 1
        offset += 1
        continue
      }
      out.failure = { state: 'unreachable' }
      out.stop = true
      return
    }
  }

  /**
   * One transcript by id, with its sentences and summary.
   *
   * The list is how the importer reads the vendor, so this is for the cases a
   * page cannot serve: re-reading a single meeting whose content changed, and
   * WS3 re-deriving one record without walking a window.
   */
  async getTranscript(id: string): Promise<{ transcript?: unknown; failure?: FirefliesFailure; calls: number }> {
    const key = this.resolveKey()
    if (!key) return { failure: { state: 'invalid_key' }, calls: 0 }
    if (!FIREFLIES_ID_PATTERN.test(id)) {
      return { failure: { state: 'vendor_error', code: 'id_shape_changed' }, calls: 0 }
    }
    const accounting = { calls: 0 }
    const result = await this.send(
      key,
      firefliesTranscriptQuery(id),
      { timeoutMs: FIREFLIES_PAGE_TIMEOUT_MS, retryServerErrors: true },
      accounting,
    )
    if (result.kind === 'transport') {
      return { failure: { state: result.reason === 'too_large' ? 'vendor_error' : 'unreachable', ...(result.reason === 'too_large' ? { code: 'response_too_large' } : {}) }, calls: accounting.calls }
    }
    if (result.kind !== 'data') return { failure: result.failure, calls: accounting.calls }
    const transcript = (result.data as { transcript?: unknown }).transcript
    // A vendor that answers "no such transcript" with a null is not an error
    // state: the caller asked about something that is not there any more.
    return { transcript: transcript ?? undefined, calls: accounting.calls }
  }

  /**
   * One span of the vendor's newest-first list, with sentences.
   *
   * The span is FIREFLIES_PAGE_SPAN wide however many calls it takes, so the
   * caller's cursor arithmetic does not have to know about the descent.
   */
  async listPage(options: { skip: number }): Promise<FirefliesPageResult> {
    const key = this.resolveKey()
    const out: PageAccumulator = {
      transcripts: [],
      oversized: [],
      nextSkip: options.skip,
      endOfList: false,
      calls: 0,
      pageSizes: [],
      stop: false,
    }
    if (!key) {
      return { ...stripAccumulator(out), failure: { state: 'invalid_key' } }
    }
    await this.fetchRange(key, options.skip, FIREFLIES_PAGE_SPAN, 0, out)
    return stripAccumulator(out)
  }
}

function failureFields(failure: FirefliesFailure): Partial<FirefliesKeyCheck> {
  return {
    ...(failure.httpStatus != null ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.retryAfterSeconds != null ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    ...(failure.code ? { code: failure.code } : {}),
  }
}

function stripAccumulator(out: PageAccumulator): FirefliesPageResult {
  return {
    transcripts: out.transcripts,
    nextSkip: out.nextSkip,
    endOfList: out.endOfList,
    oversized: out.oversized,
    ...(out.failure ? { failure: out.failure } : {}),
    calls: out.calls,
    pageSizes: out.pageSizes,
  }
}

/**
 * The real transport. Reads the body with a byte ceiling rather than trusting
 * Content-Length, because a page that lies about its size is exactly the case
 * the ceiling exists for.
 */
export function createFetchTransport(fetchImpl: typeof globalThis.fetch = globalThis.fetch): FirefliesTransport {
  return async ({ key, body, timeoutMs, maxBytes }) => {
    try {
      const response = await fetchImpl(FIREFLIES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => { headers[name] = value })
      const reader = response.body?.getReader()
      if (!reader) {
        const text = await response.text()
        if (Buffer.byteLength(text) > maxBytes) return { kind: 'too_large' }
        return { kind: 'http', status: response.status, headers, body: text }
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return { kind: 'too_large' }
        }
        chunks.push(value)
      }
      return { kind: 'http', status: response.status, headers, body: Buffer.concat(chunks).toString('utf8') }
    } catch (error) {
      const name = (error as { name?: string })?.name
      return { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' }
    }
  }
}
