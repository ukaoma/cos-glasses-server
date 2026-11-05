/**
 * Drop it P1 (plan PLAN_drop_it_2026-11-04 sections 1, 3 and 6): the two files behind the pinned COS chat.
 *
 * - `data/drops/drops.json`: every drop. Its words, kind, where it went (links), a status timeline, an undo window,
 *   and the first answer to its dropId so a repeated POST returns that answer.
 * - `data/inbox/feed.json`: the chat's messages, each pointing at a drop id. Persistent, no daily rollover, and
 *   separate from the Messages store (lib/conversation.ts): nothing here takes a global message number or an era,
 *   so a drop never adds a row to Messages and never moves the lens message counter (canary 11).
 *
 * Built like WorkIntakeStore: one writer lock per folder, a 0700 folder and 0600 files owned by this user, atomic
 * writes, and a bad row set aside on its own instead of taking the store down. Nothing here logs words: the only
 * console line is a count of quarantined rows.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { acquireServerInstanceLock, type ServerInstanceLock } from './server-instance-lock.js'

export class DropStoreError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}

export const DROP_SOURCES = ['mac', 'web', 'g2', 'telegram'] as const
export type DropSource = typeof DROP_SOURCES[number]
export const DROP_DESTS = ['new_card', 'existing_card', 'thread', 'memory', 'session', 'note', 'reminder', 'ask'] as const
export type DropDest = typeof DROP_DESTS[number]
export const DROP_KINDS = ['idea', 'task', 'note', 'memory', 'file', 'reminder', 'ask'] as const
export type DropKind = typeof DROP_KINDS[number]
/** routing: saved, not yet filed. asking: one question is open. held: a session follow-up waiting for Send. */
export const DROP_STATES = ['routing', 'filed', 'asking', 'held', 'asked', 'undone'] as const
export type DropState = typeof DROP_STATES[number]
export const LINK_KINDS = ['card', 'session', 'handoff', 'thread', 'memory', 'meeting', 'file', 'reminder', 'ask'] as const
export type LinkKind = typeof LINK_KINDS[number]

export interface DropLink {
  kind: LinkKind
  id: string
  label: string
  /** card: the Work domain; thread: the source id written into the thread (Undo needs it). */
  domain?: string
  sourceId?: string
  /** false when the destination answered with something that was already there: Undo then only unlinks it. */
  created?: boolean
}
export interface DropChoice { id: string; dest: DropDest; label: string; detail: string; target?: { id: string; domain?: string; label: string } }
export interface DropRoute { by: 'rule' | 'jev' | 'user' | 'fallback'; p?: number; reason?: string; tokens?: number; provider?: string }
export interface DropFileRef { store: string; key: string; fileID: string; sha256: string; displayName: string }
/**
 * 6.99.13: a file dropped with the words (COS Control Web). `id` is the media store's id: the bytes live there, pinned
 * to this drop (MediaStore.pinForDrop), and open through GET /api/media/:id/content. Undo removes them.
 */
export interface DropAttachment { id: string; name: string; mime: string; size: number }
export interface DropRemind { at: string | null; tz: string; firedAt: string | null; ackAt: string | null; snoozes: number }
export interface DropTimelineEntry { at: string; state: DropState; dest?: DropDest; note?: string }
export interface DropAsk { clientJobId: string; generation: number; answeredAt?: string }

export interface DropRecord {
  id: string
  text: string
  source: DropSource
  createdAt: string
  updatedAt: string
  state: DropState
  dest: DropDest | null
  kind: DropKind
  links: DropLink[]
  route: DropRoute | null
  choices?: DropChoice[]
  hold?: { sessionId: string; label: string; sentAt?: string }
  remind?: DropRemind
  file?: DropFileRef
  attachments?: DropAttachment[]
  ask?: DropAsk
  hint?: { sessionId: string }
  /** Undo and Move work until this instant (24 hours after filing). */
  undoUntil: string | null
  timeline: DropTimelineEntry[]
}

export const FEED_KINDS = ['drop', 'receipt', 'question', 'followup', 'ping', 'answer'] as const
export type FeedKind = typeof FEED_KINDS[number]
export interface FeedAction { id: string; label: string }
export interface FeedItem {
  id: string
  kind: FeedKind
  /** The drop id, or the ping's own id. */
  threadId: string
  createdAt: string
  readAt: string | null
  source: DropSource | 'cos'
  title?: string
  line: string
  links: DropLink[]
  actions: FeedAction[]
  /** live: its buttons work; done: answered or superseded (buttons gone). */
  state: 'live' | 'done'
  undoUntil?: string | null
  /** Exactly-once key: a second insert with the same key returns the first item. */
  key: string
  /**
   * 6.99.10 (plan section 12): this item waits on an answer from you (a ping or follow-up that needs a decision). It
   * counts toward `waiting` on GET /api/inbox/summary while it is live, and stops counting when it is answered, done or
   * dismissed. Kept only when it is a real boolean; an older row without it is valid and does not wait.
   */
  needsReply?: boolean
}

export const DROP_LIMITS = {
  text: 2_000, label: 200, line: 2_000, title: 200, links: 12, choices: 3, timeline: 40,
  drops: 20_000, feed: 20_000, fileBytes: 32_000_000, quarantineKept: 500,
  /** Files on one drop: the Ask's own cap (shared/media-attachment.ts MAX_ATTACHMENTS_PER_PROMPT). */
  attachments: 5, attachmentName: 255,
  /** Retention (plan section 6): drop records and links a year; undone drops and chat receipts 30 days. */
  keepDropDays: 365, keepUndoneDays: 30, keepReceiptDays: 30,
  undoMs: 24 * 60 * 60_000,
} as const

export const DROP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const FEED_ID = /^fi_[a-f0-9]{32}$/
/** A media store id (shared/media-attachment.ts MEDIA_ID_RE). */
export const ATTACHMENT_ID = /^m_[a-f0-9]{24}$/
const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

const str = (v: unknown, max: number, allowNewlines = false): string | null =>
  typeof v === 'string' && v.length <= max && (allowNewlines ? !CONTROL.test(v) : !/[\x00-\x1f\x7f]/.test(v)) ? v : null
const iso = (v: unknown): string | null => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null
const isoOrNull = (v: unknown): string | null | undefined => v === null ? null : iso(v) ?? undefined
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : null
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseLink(raw: unknown): DropLink {
  if (!record(raw)) throw new DropStoreError('invalid_link', 400)
  const kind = oneOf(LINK_KINDS, raw.kind), id = str(raw.id, 200), label = str(raw.label, DROP_LIMITS.label)
  if (!kind || !id || !LINK_ID.test(id) || label === null) throw new DropStoreError('invalid_link', 400)
  const link: DropLink = { kind, id, label }
  if (raw.domain !== undefined) { const d = str(raw.domain, 64); if (!d) throw new DropStoreError('invalid_link', 400); link.domain = d }
  if (raw.sourceId !== undefined) { const s = str(raw.sourceId, 200); if (!s || !LINK_ID.test(s)) throw new DropStoreError('invalid_link', 400); link.sourceId = s }
  if (raw.created !== undefined) { if (typeof raw.created !== 'boolean') throw new DropStoreError('invalid_link', 400); link.created = raw.created }
  return link
}

function parseChoice(raw: unknown): DropChoice {
  if (!record(raw)) throw new DropStoreError('invalid_choice', 400)
  const id = str(raw.id, 16), dest = oneOf(DROP_DESTS, raw.dest), label = str(raw.label, DROP_LIMITS.label), detail = str(raw.detail, DROP_LIMITS.line)
  if (!id || !/^[a-z0-9_]{1,16}$/.test(id) || !dest || label === null || detail === null) throw new DropStoreError('invalid_choice', 400)
  const choice: DropChoice = { id, dest, label, detail }
  if (raw.target !== undefined) {
    const t = raw.target
    if (!record(t)) throw new DropStoreError('invalid_choice', 400)
    const tid = str(t.id, 200), tlabel = str(t.label, DROP_LIMITS.label)
    if (!tid || !LINK_ID.test(tid) || tlabel === null) throw new DropStoreError('invalid_choice', 400)
    choice.target = { id: tid, label: tlabel, ...(typeof t.domain === 'string' && t.domain.length <= 64 ? { domain: t.domain } : {}) }
  }
  return choice
}

export function parseAttachment(raw: unknown): DropAttachment {
  if (!record(raw)) throw new DropStoreError('invalid_drop', 400)
  const id = typeof raw.id === 'string' && ATTACHMENT_ID.test(raw.id) ? raw.id : null
  const name = str(raw.name, DROP_LIMITS.attachmentName), mime = str(raw.mime, 100)
  if (!id || !name || !mime || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(mime) || !Number.isSafeInteger(raw.size) || (raw.size as number) < 0) throw new DropStoreError('invalid_drop', 400)
  return { id, name, mime, size: raw.size as number }
}

/** Validate one drop record from the journal. Unknown fields are dropped, never trusted. */
export function parseDropRecord(raw: unknown): DropRecord {
  if (!record(raw)) throw new DropStoreError('invalid_drop', 400)
  const id = typeof raw.id === 'string' && DROP_ID.test(raw.id) ? raw.id : null
  const text = str(raw.text, DROP_LIMITS.text, true)
  const source = oneOf(DROP_SOURCES, raw.source), state = oneOf(DROP_STATES, raw.state), kind = oneOf(DROP_KINDS, raw.kind)
  const createdAt = iso(raw.createdAt), updatedAt = iso(raw.updatedAt)
  const dest = raw.dest === null ? null : oneOf(DROP_DESTS, raw.dest)
  if (!id || !text || !text.trim() || !source || !state || !kind || !createdAt || !updatedAt || (raw.dest !== null && !dest)) throw new DropStoreError('invalid_drop', 400)
  if (!Array.isArray(raw.links) || raw.links.length > DROP_LIMITS.links || !Array.isArray(raw.timeline)) throw new DropStoreError('invalid_drop', 400)
  const undoUntil = raw.undoUntil === null ? null : iso(raw.undoUntil)
  if (raw.undoUntil !== null && !undoUntil) throw new DropStoreError('invalid_drop', 400)
  const drop: DropRecord = { id, text, source, createdAt, updatedAt, state, dest, kind, links: raw.links.map(parseLink),
    route: null, undoUntil, timeline: [] }
  if (record(raw.route)) {
    const by = oneOf(['rule', 'jev', 'user', 'fallback'] as const, raw.route.by)
    if (!by) throw new DropStoreError('invalid_drop', 400)
    drop.route = { by }
    if (typeof raw.route.p === 'number' && raw.route.p >= 0 && raw.route.p <= 1) drop.route.p = raw.route.p
    if (typeof raw.route.reason === 'string' && /^[a-z_]{1,64}$/.test(raw.route.reason)) drop.route.reason = raw.route.reason
    if (Number.isSafeInteger(raw.route.tokens) && (raw.route.tokens as number) >= 0) drop.route.tokens = raw.route.tokens as number
    if (raw.route.provider === 'jev' || raw.route.provider === 'subq') drop.route.provider = raw.route.provider
  }
  if (raw.choices !== undefined) {
    if (!Array.isArray(raw.choices) || raw.choices.length > DROP_LIMITS.choices) throw new DropStoreError('invalid_drop', 400)
    drop.choices = raw.choices.map(parseChoice)
  }
  if (raw.hold !== undefined) {
    const h = raw.hold
    const sessionId = record(h) ? str(h.sessionId, 200) : null, label = record(h) ? str(h.label, DROP_LIMITS.label) : null
    if (!sessionId || !LINK_ID.test(sessionId) || label === null) throw new DropStoreError('invalid_drop', 400)
    drop.hold = { sessionId, label, ...(record(h) && iso(h.sentAt) ? { sentAt: iso(h.sentAt)! } : {}) }
  }
  if (raw.remind !== undefined) {
    const r = raw.remind
    if (!record(r)) throw new DropStoreError('invalid_drop', 400)
    const at = isoOrNull(r.at), firedAt = isoOrNull(r.firedAt), ackAt = isoOrNull(r.ackAt), tz = str(r.tz, 64)
    if (at === undefined || firedAt === undefined || ackAt === undefined || !tz || !Number.isSafeInteger(r.snoozes) || (r.snoozes as number) < 0) throw new DropStoreError('invalid_drop', 400)
    drop.remind = { at, tz, firedAt, ackAt, snoozes: r.snoozes as number }
  }
  if (raw.file !== undefined) {
    const f = raw.file
    if (!record(f)) throw new DropStoreError('invalid_drop', 400)
    const store = str(f.store, 64), key = str(f.key, 512), fileID = str(f.fileID, 200), sha256 = str(f.sha256, 64), displayName = str(f.displayName, 255)
    if (!store || !key || !fileID || !sha256 || !/^[a-f0-9]{64}$/.test(sha256) || !displayName) throw new DropStoreError('invalid_drop', 400)
    drop.file = { store, key, fileID, sha256, displayName }
  }
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > DROP_LIMITS.attachments) throw new DropStoreError('invalid_drop', 400)
    drop.attachments = raw.attachments.map(parseAttachment)
  }
  if (raw.ask !== undefined) {
    const a = raw.ask
    if (!record(a) || typeof a.clientJobId !== 'string' || !DROP_ID.test(a.clientJobId.toLowerCase()) || !Number.isSafeInteger(a.generation) || (a.generation as number) < 1) throw new DropStoreError('invalid_drop', 400)
    drop.ask = { clientJobId: a.clientJobId.toLowerCase(), generation: a.generation as number, ...(iso(a.answeredAt) ? { answeredAt: iso(a.answeredAt)! } : {}) }
  }
  if (raw.hint !== undefined) {
    const sessionId = record(raw.hint) ? str(raw.hint.sessionId, 200) : null
    if (!sessionId || !LINK_ID.test(sessionId)) throw new DropStoreError('invalid_drop', 400)
    drop.hint = { sessionId }
  }
  for (const entry of raw.timeline.slice(-DROP_LIMITS.timeline)) {
    if (!record(entry)) throw new DropStoreError('invalid_drop', 400)
    const at = iso(entry.at), st = oneOf(DROP_STATES, entry.state)
    if (!at || !st) throw new DropStoreError('invalid_drop', 400)
    const row: DropTimelineEntry = { at, state: st }
    const d = oneOf(DROP_DESTS, entry.dest); if (d) row.dest = d
    if (typeof entry.note === 'string' && /^[a-z_]{1,64}$/.test(entry.note)) row.note = entry.note
    drop.timeline.push(row)
  }
  return drop
}

export function parseFeedItem(raw: unknown): FeedItem {
  if (!record(raw)) throw new DropStoreError('invalid_feed_item', 400)
  const id = typeof raw.id === 'string' && FEED_ID.test(raw.id) ? raw.id : null
  const kind = oneOf(FEED_KINDS, raw.kind), threadId = str(raw.threadId, 200), createdAt = iso(raw.createdAt)
  const readAt = isoOrNull(raw.readAt)
  const source = raw.source === 'cos' ? 'cos' as const : oneOf(DROP_SOURCES, raw.source)
  const line = str(raw.line, DROP_LIMITS.line, true), key = str(raw.key, 300)
  const state = raw.state === 'live' || raw.state === 'done' ? raw.state : null
  if (!id || !kind || !threadId || !LINK_ID.test(threadId) || !createdAt || readAt === undefined || !source || line === null || !key || !state) throw new DropStoreError('invalid_feed_item', 400)
  if (!Array.isArray(raw.links) || raw.links.length > DROP_LIMITS.links || !Array.isArray(raw.actions) || raw.actions.length > 6) throw new DropStoreError('invalid_feed_item', 400)
  const actions = raw.actions.map(a => {
    const aid = record(a) ? str(a.id, 40) : null, label = record(a) ? str(a.label, 80) : null
    if (!aid || !/^[a-z0-9_:-]{1,40}$/.test(aid) || !label) throw new DropStoreError('invalid_feed_item', 400)
    return { id: aid, label }
  })
  const item: FeedItem = { id, kind, threadId, createdAt, readAt, source, line, links: raw.links.map(parseLink), actions, state, key }
  if (raw.title !== undefined) { const t = str(raw.title, DROP_LIMITS.title, true); if (t === null) throw new DropStoreError('invalid_feed_item', 400); item.title = t }
  if (raw.undoUntil !== undefined) { const u = isoOrNull(raw.undoUntil); if (u === undefined) throw new DropStoreError('invalid_feed_item', 400); item.undoUntil = u }
  if (typeof raw.needsReply === 'boolean') item.needsReply = raw.needsReply
  return item
}

/** A 0700 folder owned by this user, then the writer lock, then the journal (or nothing yet). */
function openJournal(root: string, file: string, label: string): { path: string; lock: ServerInstanceLock; journal: Record<string, unknown> | null } {
  const dir = resolve(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new DropStoreError(`${label}_store_unsafe`, 503)
  const path = join(dir, file)
  let lock: ServerInstanceLock
  try { lock = acquireServerInstanceLock({ lockDir: join(dir, 'writer.lock') }) }
  catch { throw new DropStoreError(`${label}_store_locked`, 503) }
  if (!existsSync(path)) return { path, lock, journal: null }
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > DROP_LIMITS.fileBytes) throw new Error('unsafe')
    const journal = JSON.parse(readFileSync(path, 'utf8'))
    if (!record(journal) || journal.version !== 1) throw new Error('version')
    return { path, lock, journal }
  } catch {
    lock.release()
    throw new DropStoreError(`${label}_store_recovery_required`, 503)
  }
}

function readRows<T>(journal: Record<string, unknown> | null, key: string, parse: (raw: unknown) => T, id: (row: T) => string, label: string): { rows: T[]; quarantined: unknown[] } {
  const rows: T[] = [], quarantined: unknown[] = []
  if (!journal) return { rows, quarantined }
  const list = journal[key]
  if (!Array.isArray(list)) throw new DropStoreError(`${label}_store_recovery_required`, 503)
  const seen = new Set<string>()
  for (const raw of list) {
    try {
      const row = parse(raw)
      if (seen.has(id(row))) throw new Error('duplicate')
      seen.add(id(row)); rows.push(row)
    } catch { quarantined.push(raw) }  // one bad row never takes the store down
  }
  if (Array.isArray(journal.quarantined)) quarantined.push(...journal.quarantined)
  return { rows, quarantined: quarantined.slice(-DROP_LIMITS.quarantineKept) }
}

export class DropStore {
  private rows: DropRecord[] = []
  private quarantined: unknown[] = []
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  constructor(root: string, private readonly now: () => Date = () => new Date(), private readonly maxBytes: number = DROP_LIMITS.fileBytes) {
    const opened = openJournal(root, 'drops.json', 'drop')
    this.path = opened.path; this.lock = opened.lock
    try {
      const read = readRows(opened.journal, 'drops', parseDropRecord, r => r.id, 'drop')
      this.rows = read.rows; this.quarantined = read.quarantined
    } catch (e) { this.close(); throw e }
    if (this.quarantined.length) console.warn(`[drops] ${this.quarantined.length} unreadable drop record(s) set aside`)
  }
  list(): DropRecord[] { return structuredClone(this.rows) }
  get(id: string): DropRecord | undefined { const row = this.rows.find(r => r.id === id); return row ? structuredClone(row) : undefined }
  /** Copies of the matching rows only (a poll that needs a few rows does not copy them all). */
  select(match: (row: Readonly<DropRecord>) => boolean): DropRecord[] { return this.rows.filter(match).map(r => structuredClone(r)) }
  ids(): Set<string> { return new Set(this.rows.map(r => r.id)) }
  quarantineCount(): number { return this.quarantined.length }

  /** Insert a new drop. A repeated id returns the stored one unchanged (idempotent on the drop id). */
  insert(drop: DropRecord): { drop: DropRecord; inserted: boolean } {
    const existing = this.get(drop.id)
    if (existing) return { drop: existing, inserted: false }
    const parsed = parseDropRecord(drop)
    this.write([parsed, ...this.rows])
    return { drop: structuredClone(parsed), inserted: true }
  }

  /** Replace one drop with `fn(current)`. Validated before it is written. */
  update(id: string, fn: (current: DropRecord) => DropRecord): DropRecord {
    const index = this.rows.findIndex(r => r.id === id)
    if (index < 0) throw new DropStoreError('drop_not_found', 404)
    const next = parseDropRecord({ ...fn(structuredClone(this.rows[index])), updatedAt: this.now().toISOString() })
    if (next.id !== id) throw new DropStoreError('invalid_drop', 400)
    const rows = [...this.rows]; rows[index] = next
    this.write(rows)
    return structuredClone(next)
  }

  private write(rows: DropRecord[]): void {
    if (this.closed) throw new DropStoreError('drop_store_closed', 503)
    const now = this.now().getTime()
    const kept = rows.filter(r => {
      const age = now - Date.parse(r.updatedAt)
      return r.state === 'undone' ? age <= DROP_LIMITS.keepUndoneDays * 86_400_000 : age <= DROP_LIMITS.keepDropDays * 86_400_000
    })
    if (kept.length > DROP_LIMITS.drops) throw new DropStoreError('drop_store_full', 503)
    // Never write a file the reader would refuse (it reads at most maxBytes): undone rows go first, oldest first.
    let body = JSON.stringify({ version: 1, drops: kept, quarantined: this.quarantined }) + '\n'
    while (Buffer.byteLength(body) > this.maxBytes) {
      let oldest = -1
      kept.forEach((r, i) => { if (r.state === 'undone' && (oldest < 0 || r.updatedAt < kept[oldest].updatedAt)) oldest = i })
      if (oldest < 0) throw new DropStoreError('drop_store_full', 503)
      kept.splice(oldest, 1)
      body = JSON.stringify({ version: 1, drops: kept, quarantined: this.quarantined }) + '\n'
    }
    durableAtomicWriteFileSync(this.path, body)
    this.rows = kept
  }
  close(): void { if (this.closed) return; this.closed = true; this.lock.release() }
}

export class InboxFeedStore {
  private items: FeedItem[] = []
  private quarantined: unknown[] = []
  private versionNo = 0
  private readonly path: string
  private readonly lock: ServerInstanceLock
  private closed = false
  constructor(root: string, private readonly now: () => Date = () => new Date(), private readonly maxBytes: number = DROP_LIMITS.fileBytes) {
    const opened = openJournal(root, 'feed.json', 'inbox')
    this.path = opened.path; this.lock = opened.lock
    try {
      const read = readRows(opened.journal, 'items', parseFeedItem, i => i.id, 'inbox')
      this.items = read.rows; this.quarantined = read.quarantined
      const v = opened.journal?.feedVersion
      this.versionNo = Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : this.items.length
    } catch (e) { this.close(); throw e }
    if (this.quarantined.length) console.warn(`[inbox] ${this.quarantined.length} unreadable feed item(s) set aside`)
  }
  /** Oldest first, as a chat reads. */
  list(): FeedItem[] { return structuredClone(this.items) }
  version(): number { return this.versionNo }
  byKey(key: string): FeedItem | undefined { const item = this.items.find(i => i.key === key); return item ? structuredClone(item) : undefined }
  get(id: string): FeedItem | undefined { const item = this.items.find(i => i.id === id); return item ? structuredClone(item) : undefined }
  quarantineCount(): number { return this.quarantined.length }

  /**
   * Insert under the exactly-once key (plan section 4). The key is checked and the item written in one synchronous
   * step, so two callers can never both insert it. A repeat returns the first item.
   */
  insert(items: FeedItem[]): FeedItem[] {
    const out: FeedItem[] = [], add: FeedItem[] = []
    for (const raw of items) {
      const existing = this.items.find(i => i.key === raw.key) ?? add.find(i => i.key === raw.key)
      if (existing) { out.push(structuredClone(existing)); continue }
      const item = parseFeedItem(raw)
      add.push(item); out.push(structuredClone(item))
    }
    if (add.length) this.write([...this.items, ...add], add.length)
    return out
  }

  /** Remove the items `drop` answers true for (the drops store let their drop go). Writes only when one goes. */
  purge(drop: (item: Readonly<FeedItem>) => boolean): number {
    const kept = this.items.filter(i => !drop(i))
    const removed = this.items.length - kept.length
    if (removed) this.write(kept, 1)
    return removed
  }

  update(ids: ReadonlySet<string>, fn: (item: FeedItem) => FeedItem): FeedItem[] {
    let changed = 0
    const next = this.items.map(item => {
      if (!ids.has(item.id)) return item
      const updated = parseFeedItem(fn(structuredClone(item)))
      if (updated.id !== item.id || updated.key !== item.key) throw new DropStoreError('invalid_feed_item', 400)
      changed++
      return updated
    })
    if (changed) this.write(next, 1)
    return this.items.filter(i => ids.has(i.id)).map(i => structuredClone(i))
  }

  private write(items: FeedItem[], bump: number): void {
    if (this.closed) throw new DropStoreError('inbox_store_closed', 503)
    const now = this.now().getTime()
    const kept = items.filter(i => {
      const age = now - Date.parse(i.createdAt)
      return i.kind === 'drop' ? age <= DROP_LIMITS.keepDropDays * 86_400_000 : age <= DROP_LIMITS.keepReceiptDays * 86_400_000
    })
    if (kept.length > DROP_LIMITS.feed) throw new DropStoreError('inbox_store_full', 503)
    const version = this.versionNo + bump
    // Never write a file the reader would refuse: the oldest COS lines (receipts, answers, pings) go first.
    const serialize = () => JSON.stringify({ version: 1, feedVersion: version, items: kept, quarantined: this.quarantined }) + '\n'
    let body = serialize()
    while (Buffer.byteLength(body) > this.maxBytes) {
      const oldest = kept.findIndex(i => i.kind !== 'drop')
      if (oldest < 0) throw new DropStoreError('inbox_store_full', 503)
      kept.splice(oldest, 1)
      body = serialize()
    }
    durableAtomicWriteFileSync(this.path, body)
    this.items = kept; this.versionNo = version
  }
  close(): void { if (this.closed) return; this.closed = true; this.lock.release() }
}
