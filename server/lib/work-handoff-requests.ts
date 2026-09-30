/**
 * Work handoff requests (6.59.0): the glasses ask, COS Control does it.
 *
 * The glasses cannot send a tracked Work handoff themselves: the handoff journal, its one-active-handoff fence and
 * the COS-WORK tracker are Control's, on the Mac. So the glasses leave a request here, and Control claims it, runs
 * its own `submit()` with every guard, and reports the result. This server never runs a provider for a request and
 * never asks Jev.
 *
 * Time bounds a request so a tap can never fire later: a pending request expires 10 minutes after it was made and can
 * never be claimed after that; a claimed request with no result 10 minutes after the claim reads as refused ("COS
 * Control did not report back"). Both are derived from the stored times on every read and written on the next write,
 * so a GET never writes.
 *
 * One process owns the journal (instance lock), writes are durable and atomic, and a bad record is quarantined on
 * its own, as in work-intake-store.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { isSafeDomainName } from './domains.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'
import { normalizeModelPreference } from '../../shared/model-preference.js'

export class WorkHandoffRequestError extends Error {
  constructor(readonly code: string, readonly status = 409, message?: string) { super(message ?? code) }
}
export type HandoffRequestMode = 'continueSession' | 'fork' | 'newSession'
export type HandoffDestinationSource = 'saved' | 'jev' | 'user'
export type HandoffRequestState = 'pending' | 'claimed' | 'sent' | 'refused' | 'expired'
export interface HandoffRequestInput {
  clientRequestId: string; domain: string; workIdentity: string; expectedRevision: string
  mode: HandoffRequestMode; sessionId?: string; model?: string; note?: string; destinationSource: HandoffDestinationSource
}
export interface HandoffRequestRecord extends HandoffRequestInput {
  state: HandoffRequestState; createdAt: string; claimedAt?: string; resultAt?: string; receiptId?: string; reason?: string
  /** SHA-256 of the request as submitted, for idempotency. Never returned. */
  fingerprint: string
}
export interface HandoffResult { state: 'sent' | 'refused'; receiptId?: string; reason?: string }

export const HANDOFF_REQUEST_LIMITS = {
  pendingMs: 10 * 60_000, claimMs: 10 * 60_000, dailyCap: 40, note: 2_000, reason: 500, body: 16_384,
  retainDays: 7, records: 2_000,
} as const
export const CLAIM_TIMEOUT_REASON = 'COS Control did not report back'
const MODES: readonly string[] = ['continueSession', 'fork', 'newSession']
const SOURCES: readonly string[] = ['saved', 'jev', 'user']
const STORED_STATES: readonly string[] = ['pending', 'claimed', 'sent', 'refused', 'expired']
const INPUT_KEYS = ['clientRequestId', 'domain', 'workIdentity', 'expectedRevision', 'mode', 'sessionId', 'model', 'note', 'destinationSource']
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SESSION_ID = /^(claude|codex|cursor|ollama):[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/
const RECEIPT_ID = /^[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** Refused in a note: every control character except newline and tab, and a lone surrogate. */
const NOTE_REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const invalid = (message: string) => new WorkHandoffRequestError('invalid_handoff_request', 400, message)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Absent, null and the empty string all mean "not given" for an optional string. */
const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

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
  const { domain, workIdentity, expectedRevision, mode, destinationSource } = body
  if (typeof domain !== 'string' || !isSafeDomainName(domain)) throw invalid('Select an exact domain.')
  if (typeof workIdentity !== 'string' || !/^[a-f0-9]{12}$/.test(workIdentity)) throw invalid('Select an exact task.')
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw invalid('Refresh the task before starting work.')
  if (typeof mode !== 'string' || !MODES.includes(mode)) throw invalid('mode must be continueSession, fork or newSession.')
  if (typeof destinationSource !== 'string' || !SOURCES.includes(destinationSource)) throw invalid('destinationSource must be saved, jev or user.')
  let sessionId: string | undefined
  if (given(body.sessionId)) {
    if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) throw invalid('sessionId must be "provider:native".')
    sessionId = body.sessionId
  }
  let model: string | undefined
  if (given(body.model)) {
    model = normalizeModelPreference(body.model)
    if (!model) throw invalid('Choose a model slot this server knows.')
  }
  let note: string | undefined
  if (given(body.note)) {
    if (typeof body.note !== 'string') throw invalid('note must be text.')
    if (NOTE_REFUSED.test(body.note)) throw invalid('The note has a control character. Only newlines and tabs are allowed.')
    const trimmed = body.note.trim()
    if ([...trimmed].length > HANDOFF_REQUEST_LIMITS.note) throw invalid('The note is over 2,000 characters.')
    if (trimmed) note = trimmed
  }
  if (mode === 'newSession') {
    if (sessionId) throw invalid('A New session has no source session.')
  } else {
    if (!sessionId) throw invalid('Continue and Fork need sessionId ("provider:native").')
    if (mode === 'continueSession' && model) throw invalid('Continue sends to the session as it is; it takes no model.')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([clientRequestId, domain, workIdentity, expectedRevision, mode,
    sessionId ?? null, model ?? null, note ?? null, destinationSource])).digest('hex')
  const resolvedModel = mode === 'newSession' ? model ?? defaultModel : model
  const input: HandoffRequestInput = { clientRequestId, domain, workIdentity, expectedRevision, mode: mode as HandoffRequestMode,
    ...(sessionId ? { sessionId } : {}), ...(resolvedModel ? { model: resolvedModel } : {}), ...(note ? { note } : {}),
    destinationSource: destinationSource as HandoffDestinationSource }
  return { input, fingerprint }
}

/** Control's report. A reason is cleaned (control characters as spaces) and cut to 500 characters. */
export function parseHandoffResult(body: unknown): HandoffResult {
  if (!object(body) || Object.keys(body).some(key => !['state', 'receiptId', 'reason'].includes(key))) throw invalid('Send { state, receiptId?, reason? }.')
  if (body.state !== 'sent' && body.state !== 'refused') throw invalid('state must be sent or refused.')
  const result: HandoffResult = { state: body.state }
  if (given(body.receiptId)) {
    if (typeof body.receiptId !== 'string' || !RECEIPT_ID.test(body.receiptId)) throw invalid('receiptId must be a receipt id.')
    result.receiptId = body.receiptId
  }
  if (given(body.reason)) {
    if (typeof body.reason !== 'string') throw invalid('reason must be text.')
    const flat = body.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (flat) result.reason = [...flat].slice(0, HANDOFF_REQUEST_LIMITS.reason).join('')
  }
  return result
}

/** What the glasses poll: the state and times, never the note. */
export function handoffStatusView(r: HandoffRequestRecord) {
  return {
    clientRequestId: r.clientRequestId, state: r.state,
    ...(r.receiptId ? { receiptId: r.receiptId } : {}), ...(r.reason ? { reason: r.reason } : {}),
    createdAt: r.createdAt, expiresAt: new Date(Date.parse(r.createdAt) + HANDOFF_REQUEST_LIMITS.pendingMs).toISOString(),
    ...(r.claimedAt ? { claimedAt: r.claimedAt } : {}), ...(r.resultAt ? { resultAt: r.resultAt } : {}),
  }
}
/** What Control reads: the whole request. The fingerprint stays inside. */
export function handoffFullView(r: HandoffRequestRecord) {
  const { fingerprint: _fingerprint, ...rest } = r
  return { ...rest, ...handoffStatusView(r) }
}

function parseStored(raw: unknown): HandoffRequestRecord {
  if (!object(raw)) throw new Error('record')
  const { input } = parseHandoffRequest(Object.fromEntries(INPUT_KEYS.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])), 'sonnet')
  const { state, createdAt, claimedAt, resultAt, receiptId, reason, fingerprint } = raw
  if (typeof state !== 'string' || !STORED_STATES.includes(state) || typeof createdAt !== 'string' || !ISO.test(createdAt)
    || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
    || (claimedAt !== undefined && (typeof claimedAt !== 'string' || !ISO.test(claimedAt)))
    || (resultAt !== undefined && (typeof resultAt !== 'string' || !ISO.test(resultAt)))
    || (receiptId !== undefined && (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)))
    || (reason !== undefined && (typeof reason !== 'string' || [...reason].length > HANDOFF_REQUEST_LIMITS.reason))
    || (state === 'claimed' && claimedAt === undefined)
    || (input.mode === 'newSession' && !input.model)) throw new Error('record')
  return { ...input, state: state as HandoffRequestState, createdAt, fingerprint,
    ...(claimedAt ? { claimedAt } : {}), ...(resultAt ? { resultAt } : {}), ...(receiptId ? { receiptId } : {}), ...(reason ? { reason } : {}) }
}

export class WorkHandoffRequestStore {
  private rows: HandoffRequestRecord[] = []
  private quarantined: unknown[] = []
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  constructor(root: string, private readonly now: () => Date = () => new Date(),
    private readonly writeFile: (path: string, data: string) => void = durableAtomicWriteFileSync) {
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
      const seen = new Set<string>()
      for (const raw of journal.requests) {
        try {
          const record = parseStored(raw)
          if (seen.has(record.clientRequestId)) throw new Error('duplicate')
          seen.add(record.clientRequestId); this.rows.push(record)
        } catch { this.quarantined.push(raw) }  // one bad record never takes the inbox down
      }
      if (Array.isArray(journal.quarantined)) this.quarantined.push(...journal.quarantined.slice(0, 500))
      if (this.quarantined.length) console.warn(`[work-handoff-requests] ${this.quarantined.length} unreadable record(s) set aside in ${this.path}`)
    } catch { this.close(); throw new WorkHandoffRequestError('handoff_store_recovery_required', 503) }
  }

  /** The state a stored request is in now. Time alone never needs a write. */
  private effective(r: HandoffRequestRecord, nowMs: number): HandoffRequestRecord {
    if (r.state === 'pending' && nowMs >= Date.parse(r.createdAt) + HANDOFF_REQUEST_LIMITS.pendingMs) return { ...r, state: 'expired' }
    if (r.state === 'claimed' && nowMs >= Date.parse(r.claimedAt!) + HANDOFF_REQUEST_LIMITS.claimMs) {
      return { ...r, state: 'refused', reason: CLAIM_TIMEOUT_REASON, resultAt: new Date(Date.parse(r.claimedAt!) + HANDOFF_REQUEST_LIMITS.claimMs).toISOString() }
    }
    return { ...r }
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

  /** The stored request when this is a retry of it; a different request under the same id is a conflict. */
  replay(id: string, fingerprint: string): HandoffRequestRecord | undefined {
    const existing = this.get(id)
    if (existing && existing.fingerprint !== fingerprint) throw new WorkHandoffRequestError('request_id_conflict', 409, 'This request id was already used for a different request.')
    return existing
  }

  /**
   * Record a request. Synchronous from the replay check to the write, so two requests for one item cannot both pass
   * the one-per-item check. `boardRevision` is the task's workRevision read from the board just before.
   */
  create(input: HandoffRequestInput, fingerprint: string, boardRevision: string | undefined): { request: HandoffRequestRecord; created: boolean } {
    const existing = this.replay(input.clientRequestId, fingerprint)
    if (existing) return { request: existing, created: false }
    if (boardRevision !== input.expectedRevision) throw new WorkHandoffRequestError('revision_changed', 409, 'The task changed. Refresh it before starting work.')
    const nowMs = this.now().getTime(), rows = this.current()
    if (rows.some(r => r.domain === input.domain && r.workIdentity === input.workIdentity && (r.state === 'pending' || r.state === 'claimed'))) {
      throw new WorkHandoffRequestError('request_pending', 409, 'This task already has a request waiting for COS Control.')
    }
    const day = new Date(nowMs).toISOString().slice(0, 10)
    if (rows.filter(r => r.createdAt.slice(0, 10) === day).length >= HANDOFF_REQUEST_LIMITS.dailyCap) {
      throw new WorkHandoffRequestError('daily_cap', 429, 'The daily limit of 40 handoff requests is reached.')
    }
    const record: HandoffRequestRecord = { ...input, state: 'pending', createdAt: new Date(nowMs).toISOString(), fingerprint }
    this.write([...rows, record], nowMs)
    return { request: { ...record }, created: true }
  }

  /** Control takes one pending request. Exactly one claim wins; an expired request can never be claimed. */
  claim(id: string): HandoffRequestRecord {
    const nowMs = this.now().getTime(), rows = this.current(), index = rows.findIndex(r => r.clientRequestId === id)
    if (index < 0) throw new WorkHandoffRequestError('request_not_found', 404, 'No such handoff request.')
    const request = rows[index]
    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')
    if (request.state !== 'pending') throw new WorkHandoffRequestError('already_claimed', 409, `This request is already ${request.state}.`)
    rows[index] = { ...request, state: 'claimed', claimedAt: new Date(nowMs).toISOString() }
    this.write(rows, nowMs)
    return { ...rows[index] }
  }

  /** Control's result, only for a request it claimed. The same result again is answered as it was. */
  report(id: string, result: HandoffResult): HandoffRequestRecord {
    const nowMs = this.now().getTime(), rows = this.current(), index = rows.findIndex(r => r.clientRequestId === id)
    if (index < 0) throw new WorkHandoffRequestError('request_not_found', 404, 'No such handoff request.')
    const request = rows[index]
    if (request.state === result.state && request.resultAt && request.receiptId === result.receiptId && request.reason === result.reason) return request
    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')
    if (request.state !== 'claimed') throw new WorkHandoffRequestError('request_not_claimed', 409, `A result is taken only for a claimed request; this one is ${request.state}.`)
    rows[index] = { ...request, state: result.state, resultAt: new Date(nowMs).toISOString(),
      ...(result.receiptId ? { receiptId: result.receiptId } : {}), ...(result.reason ? { reason: result.reason } : {}) }
    this.write(rows, nowMs)
    return { ...rows[index] }
  }

  /** Every write stores the states as they are now, and drops requests older than a week (all long finished). */
  private write(rows: HandoffRequestRecord[], nowMs: number): void {
    if (this.closed) throw new WorkHandoffRequestError('handoff_store_closed', 503)
    const cutoff = nowMs - HANDOFF_REQUEST_LIMITS.retainDays * 86_400_000
    const kept = rows.filter(r => Date.parse(r.createdAt) >= cutoff)
    if (kept.length > HANDOFF_REQUEST_LIMITS.records) throw new WorkHandoffRequestError('handoff_store_full', 503)
    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined: this.quarantined }) + '\n')
    this.rows = kept
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.lock.release()
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
