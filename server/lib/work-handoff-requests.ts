/**
 * Work handoff requests (6.59.0): the glasses ask, COS Control does it.
 *
 * The glasses cannot send a tracked Work handoff themselves: the handoff journal, its one-active-handoff fence and
 * the COS-WORK tracker are Control's, on the Mac. So the glasses leave a request here, and Control claims it, runs
 * its own `submit()` with every guard, and reports the result. This server never runs a provider for a request and
 * never asks Jev.
 *
 * Time bounds a request so a tap can never fire later: a pending request expires 10 minutes after it was made and can
 * never be claimed after that; a claimed request carries `claimExpiresAt` (claim plus 10 minutes), after which Control
 * must not send it, and with no result by then it reads `unconfirmed` (Control may have sent it) and still takes
 * exactly one late result. Both follow from the stored times on every read and are written on the next write, so a
 * GET never writes.
 *
 * One process owns the journal (instance lock), writes are durable and atomic, and a bad record is quarantined on
 * its own, as in work-intake-store.ts.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { isSafeDomainName } from './domains.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'
import { parseWorkSessionId, modelProvider, UUID_V4, FORK_PROVIDERS } from './work-activity.js'
import { normalizeModelPreference } from '../../shared/model-preference.js'

export class WorkHandoffRequestError extends Error {
  /** `extra` goes into the error body next to the code (the daily cap's `resetsAt`). */
  constructor(readonly code: string, readonly status = 409, message?: string, readonly extra: Record<string, string> = {}) { super(message ?? code) }
}
export type HandoffRequestMode = 'continueSession' | 'fork' | 'newSession'
export type HandoffDestinationSource = 'saved' | 'jev' | 'user'
export type HandoffRequestState = 'pending' | 'claimed' | 'sent' | 'refused' | 'unresolved' | 'unconfirmed' | 'expired'
/** Start work, Reply by voice (needs input or blocked), Not done yet (a reported done). */
export type HandoffIntent = 'start' | 'reply' | 'notDone'
export interface HandoffRequestInput {
  clientRequestId: string; domain: string; workIdentity: string; expectedTaskRevision: string; intent: HandoffIntent
  mode: HandoffRequestMode; sessionId?: string; model?: string; note?: string
  /** A hint for Control's copy; Control never trusts it. */
  destinationSource: HandoffDestinationSource
  /** Reply and Not done yet: the item's newest receipt, which Control sends back to its session. */
  replyTo?: string
}
export interface HandoffRequestRecord extends HandoffRequestInput {
  state: HandoffRequestState; createdAt: string; claimedAt?: string; resultAt?: string; receiptId?: string; reason?: string
  /** SHA-256 of the request as submitted, for idempotency. Never returned. */
  fingerprint: string
  /** Returned by the claim only; the result must carry it. */
  claimToken?: string
}
export type HandoffResultState = 'sent' | 'refused' | 'unresolved'
export interface HandoffResult { state: HandoffResultState; receiptId?: string; reason?: string; claimToken: string }

export const HANDOFF_REQUEST_LIMITS = {
  pendingMs: 10 * 60_000, claimMs: 10 * 60_000, dailyCap: 40, note: 2_000, reason: 500, body: 16_384,
  retainDays: 7, consumerMs: 120_000, skewMs: 5 * 60_000, quarantined: 500,
} as const
const MODES: readonly string[] = ['continueSession', 'fork', 'newSession']
const SOURCES: readonly string[] = ['saved', 'jev', 'user']
const STORED_STATES: readonly string[] = ['pending', 'claimed', 'sent', 'refused', 'unresolved', 'unconfirmed', 'expired']
const RESULT_STATES: readonly string[] = ['sent', 'refused', 'unresolved']
const INTENTS: readonly string[] = ['start', 'reply', 'notDone']
const INPUT_KEYS = ['clientRequestId', 'domain', 'workIdentity', 'expectedTaskRevision', 'intent', 'mode', 'sessionId', 'model', 'note', 'destinationSource', 'replyTo']
const RECEIPT_ID = /^[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/**
 * Refused in a note: every control character except newline and tab; U+2028 and U+2029; invisible format characters
 * (direction marks and overrides, zero-width space, soft hyphen, byte-order mark and the rest of Unicode's Cf) except
 * the joiners U+200C and U+200D that scripts and emoji need; and a lone surrogate.
 */
const NOTE_REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|(?![\u200c\u200d])\p{Cf}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
/**
 * A note must never carry a COS-WORK status line: an agent quoting it back could move the card. Control reads a line
 * after dropping emphasis and code marks (WorkProgress.reports), so the note is checked the same way: `*`, `_`,
 * backticks and the joiners a note may carry are taken out first, so COS**-WORK and its like are refused too.
 */
const STATUS_LINE = /COS-WORK/i
const carriesStatusLine = (note: string) => STATUS_LINE.test(note.replace(/[*_`\u200c\u200d]/g, ''))
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const countGraphemes = (value: string): number => { let n = 0; for (const _ of graphemes.segment(value)) n++; return n }

const invalid = (message: string) => new WorkHandoffRequestError('invalid_handoff_request', 400, message)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Absent, null and the empty string all mean "not given" for an optional string. */
const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''
const iso = (ms: number) => new Date(ms).toISOString()
/**
 * The Mac's local calendar: the daily cap resets at local midnight. `timeZone` is for tests (an IANA name); left out,
 * it is the system's zone.
 */
function localCalendar(timeZone?: string): { day: (ms: number) => string; nextMidnight: (ms: number) => number } {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const day = (ms: number) => format.format(new Date(ms))
  // The first instant of the next local day, to the millisecond, whatever the zone's offset does that night.
  const nextMidnight = (ms: number) => {
    const today = day(ms)
    let low = ms, high = ms + 36 * 3_600_000
    while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (day(mid) === today) low = mid; else high = mid }
    return high
  }
  return { day, nextMidnight }
}
const log = (message: string) => console.warn(`[work-handoff-requests] ${message}`)

/** A request id as stored and looked up: a UUIDv4 in lowercase, or null. */
export function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.toLowerCase()
  return UUID_V4.test(id) ? id : null
}

/**
 * Validate one glasses request. Anything malformed is 400 invalid_handoff_request. A newSession without a model takes
 * `defaultModel` (the server's configured default), and the stored request names it.
 */
export function parseHandoffRequest(body: unknown, defaultModel: string): { input: HandoffRequestInput; fingerprint: string } {
  if (!object(body)) throw invalid('Send one handoff request.')
  if (Object.keys(body).some(key => !INPUT_KEYS.includes(key))) throw invalid('Unknown field in the handoff request.')
  if (Buffer.byteLength(JSON.stringify(body)) > HANDOFF_REQUEST_LIMITS.body) throw invalid('The handoff request is too large.')
  const clientRequestId = normalizeRequestId(body.clientRequestId)
  if (!clientRequestId) throw invalid('clientRequestId must be a UUID v4.')
  const { domain, workIdentity, expectedTaskRevision, intent, mode, destinationSource } = body
  if (typeof domain !== 'string' || !isSafeDomainName(domain)) throw invalid('Select an exact domain.')
  if (typeof workIdentity !== 'string' || !/^[a-f0-9]{12}$/.test(workIdentity)) throw invalid('Select an exact task.')
  if (typeof expectedTaskRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedTaskRevision)) throw invalid('Refresh the task before starting work.')
  if (typeof intent !== 'string' || !INTENTS.includes(intent)) throw invalid('intent must be start, reply or notDone.')
  if (typeof mode !== 'string' || !MODES.includes(mode)) throw invalid('mode must be continueSession, fork or newSession.')
  if (typeof destinationSource !== 'string' || !SOURCES.includes(destinationSource)) throw invalid('destinationSource must be saved, jev or user.')
  let sessionId: string | undefined
  let provider: string | undefined
  if (given(body.sessionId)) {
    const session = parseWorkSessionId(body.sessionId)
    if (!session) throw invalid('sessionId must be exactly "provider:native": claude, codex or cursor and a full session id.')
    sessionId = body.sessionId as string; provider = session.provider
  }
  let model: string | undefined
  if (given(body.model)) {
    model = normalizeModelPreference(body.model)
    if (!model) throw invalid('Choose a model slot this server knows.')
  }
  let note: string | undefined
  if (given(body.note)) {
    if (typeof body.note !== 'string') throw invalid('note must be text.')
    if (NOTE_REFUSED.test(body.note)) throw invalid('The note has a control or invisible character. Only newlines and tabs are allowed.')
    if (carriesStatusLine(body.note)) throw invalid('A note cannot carry a COS-WORK status line.')
    const trimmed = body.note.trim()
    if ([...trimmed].length > HANDOFF_REQUEST_LIMITS.note) throw invalid('The note is over 2,000 characters.')
    if (trimmed) note = trimmed
  }
  let replyTo: string | undefined
  if (given(body.replyTo)) {
    if (typeof body.replyTo !== 'string' || !RECEIPT_ID.test(body.replyTo)) throw invalid('replyTo must be a receipt id.')
    replyTo = body.replyTo
  }
  if (mode === 'newSession') {
    if (sessionId) throw invalid('A New session has no source session.')
  } else {
    if (!sessionId || !provider) throw invalid('Continue and Fork need sessionId ("provider:native").')
    if (mode === 'continueSession') {
      if (model) throw invalid('Continue sends to the session as it is; it takes no model.')
    } else {
      if (!FORK_PROVIDERS.has(provider)) throw invalid('Fork works with Claude and Codex sessions only.')
      // A model on a Fork means a Fork to the other platform.
      if (model && (!FORK_PROVIDERS.has(modelProvider(model as never)) || modelProvider(model as never) === provider)) {
        throw invalid('A Fork model belongs to the other platform (Claude or Codex).')
      }
    }
  }
  if ((intent === 'reply' || intent === 'notDone') !== !!replyTo) throw invalid('Reply and Not done yet name replyTo; Start does not.')
  if (replyTo && (mode !== 'continueSession' || !note)) throw invalid('A reply continues its session with a note.')
  const fingerprint = createHash('sha256').update(JSON.stringify([clientRequestId, domain, workIdentity, expectedTaskRevision, intent, mode,
    sessionId ?? null, model ?? null, note ?? null, destinationSource, replyTo ?? null])).digest('hex')
  const resolvedModel = mode === 'newSession' ? model ?? defaultModel : model
  const input: HandoffRequestInput = { clientRequestId, domain, workIdentity, expectedTaskRevision, intent: intent as HandoffIntent, mode: mode as HandoffRequestMode,
    ...(sessionId ? { sessionId } : {}), ...(resolvedModel ? { model: resolvedModel } : {}), ...(note ? { note } : {}),
    destinationSource: destinationSource as HandoffDestinationSource, ...(replyTo ? { replyTo } : {}) }
  return { input, fingerprint }
}

/**
 * Control's report: `sent` names its receipt, `refused` says why (and names a receipt when there is one), `unresolved`
 * names the receipt whose delivery Control could not confirm. A reason is cleaned (control characters as spaces) and
 * kept to 500 characters.
 */
export function parseHandoffResult(body: unknown): HandoffResult {
  if (!object(body) || Object.keys(body).some(key => !['state', 'receiptId', 'reason', 'claimToken'].includes(key))) throw invalid('Send { state, receiptId?, reason?, claimToken }.')
  if (typeof body.state !== 'string' || !RESULT_STATES.includes(body.state)) throw invalid('state must be sent, refused or unresolved.')
  if (typeof body.claimToken !== 'string' || !CLAIM_TOKEN.test(body.claimToken)) throw invalid('A result carries the claimToken its claim returned.')
  const result: HandoffResult = { state: body.state as HandoffResultState, claimToken: body.claimToken }
  if (given(body.receiptId)) {
    if (typeof body.receiptId !== 'string' || !RECEIPT_ID.test(body.receiptId)) throw invalid('receiptId must be a receipt id.')
    result.receiptId = body.receiptId
  }
  if (given(body.reason)) {
    if (typeof body.reason !== 'string') throw invalid('reason must be text.')
    const flat = body.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    // Cut in whole characters; the loader (parseStored) counts the same way, or a long reason would not survive a restart.
    if (flat) result.reason = Array.from(graphemes.segment(flat), part => part.segment).slice(0, HANDOFF_REQUEST_LIMITS.reason).join('')
  }
  if ((result.state === 'sent' || result.state === 'unresolved') && !result.receiptId) throw invalid(`A ${result.state} result names its receipt.`)
  if (result.state === 'refused' && !result.reason) throw invalid('A refused result says why.')
  return result
}

const CLAIM_TOKEN = /^[a-f0-9]{32}$/
const claimExpiry = (r: HandoffRequestRecord) => r.claimedAt ? { claimExpiresAt: iso(Date.parse(r.claimedAt) + HANDOFF_REQUEST_LIMITS.claimMs) } : {}
/** What the glasses poll: the state and times, never the note. */
export function handoffStatusView(r: HandoffRequestRecord) {
  return {
    clientRequestId: r.clientRequestId, state: r.state,
    ...(r.receiptId ? { receiptId: r.receiptId } : {}), ...(r.reason ? { reason: r.reason } : {}),
    createdAt: r.createdAt, expiresAt: iso(Date.parse(r.createdAt) + HANDOFF_REQUEST_LIMITS.pendingMs),
    ...(r.claimedAt ? { claimedAt: r.claimedAt } : {}), ...claimExpiry(r), ...(r.resultAt ? { resultAt: r.resultAt } : {}),
  }
}
/** What Control reads: the whole request, with the deadline it must send by. The fingerprint stays inside. */
export function handoffFullView(r: HandoffRequestRecord) {
  const { fingerprint: _fingerprint, claimToken: _claimToken, ...rest } = r
  return { ...rest, ...handoffStatusView(r) }
}

function parseStored(raw: unknown): HandoffRequestRecord {
  if (!object(raw)) throw new Error('record')
  // A stored New session always names its model; one without is damaged, never loaded as the default.
  if (raw.mode === 'newSession' && !given(raw.model)) throw new Error('record')
  const { input } = parseHandoffRequest(Object.fromEntries(INPUT_KEYS.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])), 'sonnet')
  const { state, createdAt, claimedAt, resultAt, receiptId, reason, fingerprint, claimToken } = raw
  if (typeof state !== 'string' || !STORED_STATES.includes(state) || typeof createdAt !== 'string' || !ISO.test(createdAt)
    || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
    || (claimedAt !== undefined && (typeof claimedAt !== 'string' || !ISO.test(claimedAt)))
    || (resultAt !== undefined && (typeof resultAt !== 'string' || !ISO.test(resultAt)))
    || (receiptId !== undefined && (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)))
    || (reason !== undefined && (typeof reason !== 'string' || countGraphemes(reason) > HANDOFF_REQUEST_LIMITS.reason))
    || (claimToken !== undefined && (typeof claimToken !== 'string' || !CLAIM_TOKEN.test(claimToken)))
    || ((state === 'claimed' || state === 'unconfirmed') && (claimedAt === undefined || claimToken === undefined))) throw new Error('record')
  return { ...input, state: state as HandoffRequestState, createdAt, fingerprint, ...(claimToken ? { claimToken } : {}),
    ...(claimedAt ? { claimedAt } : {}), ...(resultAt ? { resultAt } : {}), ...(receiptId ? { receiptId } : {}), ...(reason ? { reason } : {}) }
}

/** A record the inbox could not read, kept aside with when it was set aside so it ages out on the 7-day schedule. */
interface QuarantinedRecord { at: string; record: unknown }

export class WorkHandoffRequestStore {
  private rows: HandoffRequestRecord[] = []
  private quarantined: QuarantinedRecord[] = []
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  /** When COS Control last listed pending requests. Memory only: after a restart the inbox waits for its next poll. */
  private consumerAt: number | null = null
  /** Time-made transitions already logged (once each per process). */
  private readonly noticed = new Set<string>()
  private readonly calendar: ReturnType<typeof localCalendar>
  constructor(root: string, private readonly now: () => Date = () => new Date(),
    private readonly writeFile: (path: string, data: string) => void = durableAtomicWriteFileSync, options: { timeZone?: string } = {}) {
    this.calendar = localCalendar(options.timeZone)
    const dir = resolve(root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new WorkHandoffRequestError('handoff_store_unsafe', 503)
    this.path = join(dir, 'requests.json')
    try { this.lock = acquireServerInstanceLock({ lockDir: join(dir, 'writer.lock') }) }
    catch { throw new WorkHandoffRequestError('handoff_store_locked', 503) }
    if (!existsSync(this.path)) return
    try {
      const file = lstatSync(this.path)
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 8_000_000) throw new Error('unsafe')
      const journal = JSON.parse(readFileSync(this.path, 'utf8'))
      if (journal?.version !== 1 || !Array.isArray(journal.requests)) throw new Error('version')
      const loadedAt = iso(this.now().getTime()), seen = new Set<string>()
      for (const raw of journal.requests) {
        try {
          const record = parseStored(raw)
          if (seen.has(record.clientRequestId)) throw new Error('duplicate')
          seen.add(record.clientRequestId); this.rows.push(record)
        } catch { this.quarantined.push({ at: loadedAt, record: raw }) }  // one bad record never takes the inbox down
      }
      for (const entry of Array.isArray(journal.quarantined) ? journal.quarantined.slice(0, HANDOFF_REQUEST_LIMITS.quarantined) : []) {
        this.quarantined.push(object(entry) && typeof entry.at === 'string' && ISO.test(entry.at) && 'record' in entry ? { at: entry.at, record: entry.record } : { at: loadedAt, record: entry })
      }
      if (this.quarantined.length) log(`${this.quarantined.length} unreadable record(s) set aside in ${this.path}`)
    } catch { this.close(); throw new WorkHandoffRequestError('handoff_store_recovery_required', 503) }
  }

  /**
   * The state a stored request is in now. Time alone never needs a write. A time more than 5 minutes ahead of the
   * clock (a clock that jumped) ends the wait at once: a pending request is expired and can never be claimed; a
   * claimed one is unconfirmed, never expired, because COS Control may have sent it and must still be able to say so.
   */
  private effective(r: HandoffRequestRecord, nowMs: number): HandoffRequestRecord {
    const created = Date.parse(r.createdAt), claimed = r.claimedAt ? Date.parse(r.claimedAt) : undefined
    const ahead = (at: number | undefined) => at !== undefined && at > nowMs + HANDOFF_REQUEST_LIMITS.skewMs
    let state = r.state, why = ''
    if (state === 'pending' && ahead(created)) { state = 'expired'; why = 'it was made more than 5 minutes ahead of this clock' }
    else if (state === 'pending' && nowMs >= created + HANDOFF_REQUEST_LIMITS.pendingMs) { state = 'expired'; why = 'COS Control did not claim it in time' }
    else if (state === 'claimed' && (ahead(created) || ahead(claimed))) { state = 'unconfirmed'; why = 'its claim is more than 5 minutes ahead of this clock' }
    else if (state === 'claimed' && nowMs >= claimed! + HANDOFF_REQUEST_LIMITS.claimMs) { state = 'unconfirmed'; why = 'COS Control claimed it and did not report back' }
    if (state !== r.state && !this.noticed.has(r.clientRequestId + state)) {
      this.noticed.add(r.clientRequestId + state)
      log(`${r.clientRequestId} ${state}: ${why}`)
    }
    return { ...r, state }
  }
  private current(): HandoffRequestRecord[] {
    const nowMs = this.now().getTime()
    return this.rows.map(r => this.effective(r, nowMs))
  }
  get(id: string): HandoffRequestRecord | undefined { return this.current().find(r => r.clientRequestId === id) }
  /** Oldest first, so Control works through them in the order they were asked. */
  list(state?: HandoffRequestState): HandoffRequestRecord[] {
    return this.current().filter(r => !state || r.state === state).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  quarantineCount(): number { return this.quarantined.length }
  /** COS Control listed pending requests: it is consuming the inbox. */
  noteConsumer(): void { this.consumerAt = this.now().getTime() }
  consumerSeenAt(): number | null { return this.consumerAt }

  /** The stored request when this is a retry of it; a different request under the same id is a conflict. */
  replay(id: string, fingerprint: string): HandoffRequestRecord | undefined {
    const existing = this.get(id)
    if (existing && existing.fingerprint !== fingerprint) throw new WorkHandoffRequestError('request_id_conflict', 409, 'This request id was already used for a different request.')
    return existing
  }

  /**
   * Record a request. Synchronous from the replay check to the write, so two requests for one item cannot both pass
   * the one-per-item check. `taskRevision` is the task's own revision (Control's taskSnapshot) read from the board
   * just before.
   */
  create(input: HandoffRequestInput, fingerprint: string, taskRevision: string | undefined): { request: HandoffRequestRecord; created: boolean } {
    const existing = this.replay(input.clientRequestId, fingerprint)
    if (existing) return { request: existing, created: false }
    if (taskRevision !== input.expectedTaskRevision) throw new WorkHandoffRequestError('revision_changed', 409, 'This task changed. Refresh it before starting work.')
    const nowMs = this.now().getTime(), rows = this.current()
    if (rows.some(r => r.domain === input.domain && r.workIdentity === input.workIdentity && (r.state === 'pending' || r.state === 'claimed'))) {
      throw new WorkHandoffRequestError('request_pending', 409, 'This task already has a request waiting for COS Control.')
    }
    const today = this.calendar.day(nowMs)
    if (rows.filter(r => this.calendar.day(Date.parse(r.createdAt)) === today).length >= HANDOFF_REQUEST_LIMITS.dailyCap) {
      // `resetsAt` is the Mac's next local midnight; the glasses format it. The words carry no time.
      throw new WorkHandoffRequestError('daily_cap', 429, 'The daily limit of 40 handoff requests is reached. Try again after the daily reset.', { resetsAt: iso(this.calendar.nextMidnight(nowMs)) })
    }
    const record: HandoffRequestRecord = { ...input, state: 'pending', createdAt: iso(nowMs), fingerprint }
    this.write([...rows, record], nowMs)
    return { request: { ...record }, created: true }
  }

  /**
   * Control takes one pending request and gets a claim token. Exactly one claim wins; the same token claims again
   * idempotently while the claim holds; an expired request can never be claimed.
   */
  claim(id: string, claimToken?: string): HandoffRequestRecord {
    const nowMs = this.now().getTime(), rows = this.current(), index = rows.findIndex(r => r.clientRequestId === id)
    if (index < 0) throw new WorkHandoffRequestError('request_not_found', 404, 'No such handoff request.')
    const request = rows[index]
    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')
    if (request.state === 'claimed' && claimToken !== undefined && claimToken === request.claimToken) return request
    if (request.state !== 'pending') throw new WorkHandoffRequestError('already_claimed', 409, `This request is already ${request.state}.`)
    rows[index] = { ...request, state: 'claimed', claimedAt: iso(nowMs), claimToken: randomBytes(16).toString('hex') }
    this.write(rows, nowMs)
    return { ...rows[index] }
  }

  /**
   * Control's result, under its claim token: for a claimed request, or once for one that went unconfirmed (Control may
   * have sent it after all). The same result again is answered as it was.
   */
  report(id: string, result: HandoffResult): HandoffRequestRecord {
    const nowMs = this.now().getTime(), rows = this.current(), index = rows.findIndex(r => r.clientRequestId === id)
    if (index < 0) throw new WorkHandoffRequestError('request_not_found', 404, 'No such handoff request.')
    const request = rows[index]
    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')
    if (!request.claimToken) throw new WorkHandoffRequestError('request_not_claimed', 409, 'A result is taken only for a claimed request; this one was never claimed.')
    if (request.claimToken !== result.claimToken) throw new WorkHandoffRequestError('claim_token_mismatch', 409, 'This result does not carry the token of the claim.')
    if (request.state === result.state && request.resultAt && request.receiptId === result.receiptId && request.reason === result.reason) return request
    if (request.state !== 'claimed' && request.state !== 'unconfirmed') {
      throw new WorkHandoffRequestError('request_not_claimed', 409, `A result is taken only for a claimed request; this one is ${request.state}.`)
    }
    const { receiptId: _receiptId, reason: _reason, ...base } = request
    rows[index] = { ...base, state: result.state, resultAt: iso(nowMs),
      ...(result.receiptId ? { receiptId: result.receiptId } : {}), ...(result.reason ? { reason: result.reason } : {}) }
    this.write(rows, nowMs)
    return { ...rows[index] }
  }

  /**
   * Every write stores the states as they are now, and drops requests (and set-aside records) older than a week. At
   * 40 requests a day that is at most a few hundred records, so there is no separate size cap.
   */
  private write(rows: HandoffRequestRecord[], nowMs: number): void {
    if (this.closed) throw new WorkHandoffRequestError('handoff_store_closed', 503)
    const cutoff = nowMs - HANDOFF_REQUEST_LIMITS.retainDays * 86_400_000
    const kept = rows.filter(r => Date.parse(r.createdAt) >= cutoff)
    const quarantined = this.quarantined.filter(q => Date.parse(q.at) >= cutoff)
    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined }) + '\n')
    this.rows = kept
    this.quarantined = quarantined
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.lock.release()
  }
}

/**
 * What the glasses are told (capabilities on the Work activity routes): `requests` is 1 only while COS Control is
 * taking requests, meaning it listed pending ones in the last 120 s; `requestsInbox` is 1 when the inbox opened.
 */
export function handoffRequestCapabilities(store: WorkHandoffRequestStore | null, nowMs: number): { requests: 0 | 1; requestsInbox: 0 | 1; requestsConsumerSeenAt: string | null } {
  const seen = store?.consumerSeenAt() ?? null
  return {
    requests: store && seen !== null && nowMs - seen <= HANDOFF_REQUEST_LIMITS.consumerMs ? 1 : 0,
    requestsInbox: store ? 1 : 0,
    requestsConsumerSeenAt: seen === null ? null : iso(seen),
  }
}

/** Optional: a locked or unreadable inbox must never keep the base API from starting. */
export function createOptionalWorkHandoffRequestStore(create: () => WorkHandoffRequestStore): WorkHandoffRequestStore | null {
  try { return create() }
  catch (error) {
    console.error('[work-handoff-requests] store unavailable; base API remains available:', error instanceof WorkHandoffRequestError ? error.code : error)
    return null
  }
}
