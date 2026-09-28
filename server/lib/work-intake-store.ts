/**
 * Work intake: meeting-derived Work that is not yet on the board, and cards a producer already made.
 *
 * A producer (COS `work_intake.py`, Jev-scored) upserts items; the user resolves them in Control.
 * Suggested meeting links (0.60 to 0.85, or higher for a task already linked to several meetings), other people's
 * asks, and review items (his own, from an older meeting or not clear enough to card)
 * live here, never in tasks.md: task metadata accepts only workflowPhase/workIdentity/meetingRefs, and an
 * older validator would mark a whole task line invalid if a suggestion were stored on it.
 *
 * One process owns the journal (instance lock). A bad record is quarantined on its own instead of taking
 * the store down. A user's decision is sticky while it is retained (60 days): a later producer upsert never reopens
 * it, and the producer's own ledger never re-sends a decided item.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { isSafeDomainName } from './domains.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'

export class WorkIntakeError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}
export type IntakeKind = 'link' | 'ask'
export type IntakeStatus = 'suggested' | 'review' | 'ask' | 'accepted' | 'dismissed'
export interface IntakeMeeting { domain: string; month: string; filename: string; recordId: string; title: string }
export interface IntakeTask { domain: string; id: string; workIdentity: string; text: string }
export interface IntakePull { kind: 'session'; id: string; title: string; p: number }
export interface IntakeResolution { action: 'accept' | 'dismiss'; by: 'producer' | 'user'; at: string; taskId?: string }
/** Why an item of Miles's landed in Review instead of becoming a card. */
export type IntakeReason = 'unclear_task' | 'owner_uncertain' | 'outside_window'
const REASONS: ReadonlySet<string> = new Set<IntakeReason>(['unclear_task', 'owner_uncertain', 'outside_window'])
export interface WorkIntakeItem {
  id: string; kind: IntakeKind; status: IntakeStatus; meeting: IntakeMeeting; confidence: number; model: string
  producedAt: string; updatedAt: string
  task?: IntakeTask; relation?: 'originated' | 'advanced'
  text?: string; owner?: string | null; ownerIsMiles?: boolean; pull?: IntakePull | null; reason?: IntakeReason
  resolution?: IntakeResolution
}

export const INTAKE_LIMITS = { items: 5_000, batch: 200, text: 600, title: 300, owner: 80, model: 64, retainResolvedDays: 60 } as const
const OPEN: ReadonlySet<IntakeStatus> = new Set(['suggested', 'review', 'ask'])
const ID = /^wi_[a-f0-9]{32}$/
const TASK_ID = /^[a-f0-9]{12}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const clean = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v) ? v.replace(/\s+/g, ' ').trim() : null
const iso = (v: unknown): string | null => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null

function meetingOf(raw: unknown): IntakeMeeting {
  const m = raw as Partial<IntakeMeeting> | null
  const domain = clean(m?.domain, 64), month = clean(m?.month, 7), filename = clean(m?.filename, 255)
  const recordId = clean(m?.recordId, 512), title = clean(m?.title, INTAKE_LIMITS.title)
  if (!domain || !isSafeDomainName(domain) || !month || !MONTH.test(month) || !filename || !/^[^/\\]+\.md$/.test(filename) || !recordId || !title) {
    throw new WorkIntakeError('invalid_intake_meeting', 400)
  }
  return { domain, month, filename, recordId, title }
}

/** Validate one producer or journal record. Unknown fields are dropped, never trusted. */
export function parseIntakeItem(raw: unknown, now = new Date().toISOString()): WorkIntakeItem {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new WorkIntakeError('invalid_intake_item', 400)
  const id = typeof r.id === 'string' && ID.test(r.id) ? r.id : null
  const kind = r.kind === 'link' || r.kind === 'ask' ? r.kind : null
  const status = typeof r.status === 'string' && ['suggested', 'review', 'ask', 'accepted', 'dismissed'].includes(r.status) ? r.status as IntakeStatus : null
  const confidence = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null
  const model = clean(r.model, INTAKE_LIMITS.model)
  if (!id || !kind || !status || confidence === null || !model) throw new WorkIntakeError('invalid_intake_item', 400)
  const allowed: readonly IntakeStatus[] = kind === 'link' ? ['suggested', 'accepted', 'dismissed'] : ['review', 'ask', 'accepted', 'dismissed']
  if (!allowed.includes(status)) throw new WorkIntakeError('invalid_intake_status', 400)
  const item: WorkIntakeItem = { id, kind, status, meeting: meetingOf(r.meeting), confidence, model,
    producedAt: iso(r.producedAt) ?? now, updatedAt: iso(r.updatedAt) ?? now }
  if (kind === 'link') {
    const t = r.task as Partial<IntakeTask> | null
    const domain = clean(t?.domain, 64), tid = clean(t?.id, 12), identity = clean(t?.workIdentity, 12), text = clean(t?.text, INTAKE_LIMITS.text)
    if (!domain || !isSafeDomainName(domain) || !tid || !TASK_ID.test(tid) || !identity || !TASK_ID.test(identity) || !text) {
      throw new WorkIntakeError('invalid_intake_task', 400)
    }
    item.task = { domain, id: tid, workIdentity: identity, text }
    item.relation = r.relation === 'originated' ? 'originated' : 'advanced'
  } else {
    const text = clean(r.text, INTAKE_LIMITS.text)
    if (!text) throw new WorkIntakeError('invalid_intake_text', 400)
    item.text = text
    item.owner = r.owner === null || r.owner === undefined ? null : clean(r.owner, INTAKE_LIMITS.owner)
    item.ownerIsMiles = r.ownerIsMiles === true
    // Advisory, like `reason`: a malformed pull is dropped and the ask itself still arrives.
    const p = r.pull as Partial<IntakePull> | null | undefined
    const pid = clean(p?.id, 200), title = clean(p?.title, 120)
    item.pull = p && p.kind === 'session' && pid && title && typeof p.p === 'number' && p.p >= 0 && p.p <= 1 ? { kind: 'session', id: pid, title, p: p.p } : null
    // Optional and advisory: an unknown reason from a newer producer is dropped, never a reason to refuse the item.
    if (typeof r.reason === 'string' && REASONS.has(r.reason)) item.reason = r.reason as IntakeReason
  }
  const res = r.resolution as Partial<IntakeResolution> | undefined
  if (res !== undefined) {
    if ((res.action !== 'accept' && res.action !== 'dismiss') || (res.by !== 'producer' && res.by !== 'user')) throw new WorkIntakeError('invalid_intake_resolution', 400)
    const taskId = res.taskId === undefined ? undefined : clean(res.taskId, 12)
    if (taskId !== undefined && (!taskId || !TASK_ID.test(taskId))) throw new WorkIntakeError('invalid_intake_resolution', 400)
    item.resolution = { action: res.action, by: res.by, at: iso(res.at) ?? now, ...(taskId ? { taskId } : {}) }
  }
  if ((item.status === 'accepted' || item.status === 'dismissed') !== (item.resolution !== undefined)) throw new WorkIntakeError('invalid_intake_resolution', 400)
  return item
}

export interface IntakeRejection { id: string | null; code: string }
export interface UpsertResult { inserted: number; updated: number; sticky: number; rejected: IntakeRejection[] }

export class WorkIntakeStore {
  private rows: WorkIntakeItem[] = []
  private quarantined: unknown[] = []
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  private readonly busy = new Set<string>()
  constructor(root: string, private readonly now: () => Date = () => new Date()) {
    const dir = resolve(root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new WorkIntakeError('intake_store_unsafe', 503)
    this.path = join(dir, 'intake.json')
    try { this.lock = acquireServerInstanceLock({ lockDir: join(dir, 'writer.lock') }) }
    catch { throw new WorkIntakeError('intake_store_locked', 503) }
    if (!existsSync(this.path)) return
    try {
      const file = lstatSync(this.path)
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 32_000_000) throw new Error('unsafe')
      const journal = JSON.parse(readFileSync(this.path, 'utf8'))
      if (journal?.version !== 1 || !Array.isArray(journal.items)) throw new Error('version')
      const seen = new Set<string>()
      for (const raw of journal.items) {
        try {
          const item = parseIntakeItem(raw)
          if (seen.has(item.id)) throw new Error('duplicate')
          seen.add(item.id); this.rows.push(item)
        } catch { this.quarantined.push(raw) }  // one bad record never takes the store down
      }
      if (Array.isArray(journal.quarantined)) this.quarantined.push(...journal.quarantined.slice(0, 500))
      if (this.quarantined.length) console.warn(`[work-intake] ${this.quarantined.length} unreadable journal record(s) set aside in ${this.path}`)
    } catch { this.close(); throw new WorkIntakeError('intake_store_recovery_required', 503) }
  }
  list(): WorkIntakeItem[] { return structuredClone(this.rows) }
  open(): WorkIntakeItem[] { return this.list().filter(r => OPEN.has(r.status)) }
  get(id: string): WorkIntakeItem | undefined { return this.list().find(r => r.id === id) }
  quarantineCount(): number { return this.quarantined.length }

  /**
   * Validate per item: one bad item is answered in `rejected` and never blocks the rest of the batch, so a
   * producer queue cannot wedge on a single record. Only a malformed batch as a whole is refused outright.
   */
  upsert(raws: unknown[]): UpsertResult {
    if (!Array.isArray(raws) || raws.length > INTAKE_LIMITS.batch) throw new WorkIntakeError('invalid_intake_batch', 400)
    const at = this.now().toISOString()
    const items: WorkIntakeItem[] = [], result: UpsertResult = { inserted: 0, updated: 0, sticky: 0, rejected: [] }
    for (const raw of raws) {
      const rawId = (raw as { id?: unknown } | null)?.id
      const id = typeof rawId === 'string' && ID.test(rawId) ? rawId : null
      try {
        const item = parseIntakeItem(raw, at)
        if (item.resolution?.by === 'user') throw new WorkIntakeError('producer_cannot_record_user_decisions', 400)
        items.push(item)
      } catch (e) {
        result.rejected.push({ id, code: e instanceof WorkIntakeError ? e.code : 'invalid_intake_item' })
      }
    }
    if (!items.length) return result
    const next = this.list()
    for (const item of items) {
      const index = next.findIndex(r => r.id === item.id)
      if (index < 0) { next.unshift({ ...item, updatedAt: at }); result.inserted++; continue }
      const prior = next[index]
      if (prior.resolution?.by === 'user' || (prior.status === 'accepted' && item.status !== 'accepted')) { result.sticky++; continue }
      next[index] = { ...item, producedAt: prior.producedAt, updatedAt: at }
      result.updated++
    }
    this.write(next)
    return result
  }

  /** Serialize resolution per item: a double click gets 409 instead of a second link or card. */
  async resolve(id: string, fn: (item: WorkIntakeItem) => Promise<{ taskId?: string; action: 'accept' | 'dismiss' }>): Promise<WorkIntakeItem> {
    if (!ID.test(id)) throw new WorkIntakeError('invalid_intake_id', 400)
    if (this.busy.has(id)) throw new WorkIntakeError('intake_busy', 409)
    const current = this.get(id)
    if (!current) throw new WorkIntakeError('intake_not_found', 404)
    if (!OPEN.has(current.status)) return current  // repeat accept or dismiss: already decided, idempotent
    this.busy.add(id)
    try {
      const outcome = await fn(current)
      const at = this.now().toISOString()
      const next = this.list(), index = next.findIndex(r => r.id === id)
      if (index < 0) throw new WorkIntakeError('intake_not_found', 404)
      next[index] = { ...next[index], status: outcome.action === 'accept' ? 'accepted' : 'dismissed', updatedAt: at,
        resolution: { action: outcome.action, by: 'user', at, ...(outcome.taskId ? { taskId: outcome.taskId } : {}) } }
      this.write(next)
      return structuredClone(next[index])
    } finally { this.busy.delete(id) }
  }

  private write(rows: WorkIntakeItem[]): void {
    if (this.closed) throw new WorkIntakeError('intake_store_closed', 503)
    const cutoff = this.now().getTime() - INTAKE_LIMITS.retainResolvedDays * 86_400_000
    const kept = rows.filter(r => OPEN.has(r.status) || Date.parse(r.updatedAt) >= cutoff)
    if (kept.length > INTAKE_LIMITS.items) throw new WorkIntakeError('intake_store_full', 503)
    durableAtomicWriteFileSync(this.path, JSON.stringify({ version: 1, items: kept, quarantined: this.quarantined }) + '\n')
    this.rows = kept
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.lock.release()
  }
}

/** Optional: a locked or unreadable journal must never keep the base API from starting. */
export function createOptionalWorkIntakeStore(create: () => WorkIntakeStore): WorkIntakeStore | null {
  try { return create() }
  catch (error) {
    console.error('[work-intake] store unavailable; base API remains available:', error instanceof WorkIntakeError ? error.code : error)
    return null
  }
}
