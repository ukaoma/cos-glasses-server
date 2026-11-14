/**
 * 7.0.39 (persistent COS thread, candidate 3; docs/cos-thread.md "Timeline"): breadcrumbs beside the thread's chats.
 * Each is a time, a kind, one short line and a reference to its source; never a body. Kinds (Miles's pick, lead 08:29):
 *   notification      a ping or follow-up COS put in the pinned chat, and what he did with it (seen, replied, dismissed,
 *                     acted); ref: the feed item
 *   session_question  a session ended its turn asking him something, and his answer; ref: the session (via X1's
 *                     onTurnAskEvent in turn-end-ask.ts, used only when that export exists)
 *   meeting           a meeting recorded; ref: domain, month, file (the web's #/meetings/<domain>/<month>/<file>)
 *   message           a numbered Messages turn (not a thread chat): the line is the question's start, the number is
 *                     in the ref, and `surface` says where it was asked only when the server knows (lead 11:5x)
 * Not Work moves and not session activity.
 *
 * Storage: DATA_DIR/cos-thread/timeline.jsonl, append-only (O_APPEND, fsync, 0600, a torn last row skipped and never
 * joined), one crumb row per source (idempotent on its key) and one outcome row each time an outcome CHANGES. The words
 * live only in this file: nothing here logs a line, a question or an answer. timeline-state.json (atomic) remembers
 * which archive days and meeting days were swept, so a restart does not reread them.
 *
 * The sweeper (TimelineSweeper) reads the stores read only and bounded per pass: the inbox feed file, the live
 * conversations, at most ARCHIVE_DAYS_PER_SWEEP archive days and MEETING_DAYS_PER_SWEEP meeting days. It backfills what
 * the stores still hold and invents nothing. No model is called.
 */
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, writeSync, fsyncSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'

export const CRUMB_KINDS = ['notification', 'session_question', 'meeting', 'message'] as const
export type CrumbKind = typeof CRUMB_KINDS[number]
export type CrumbRef =
  | { type: 'notification'; id: string; threadId: string }
  | { type: 'session'; provider: string; id: string }
  | { type: 'meeting'; domain: string; month: string; filename: string }
  | { type: 'message'; no: number; era: string }
export const NOTIFICATION_OUTCOMES = ['seen', 'replied', 'dismissed', 'acted', 'closed'] as const
export const QUESTION_OUTCOMES = ['answered', 'moved_on', 'session_ended', 'aged_out'] as const
export type CrumbOutcome = typeof NOTIFICATION_OUTCOMES[number] | typeof QUESTION_OUTCOMES[number]
export const LINE_MAX = 160
export const ANSWER_MAX = 80
export const MESSAGE_START_CHARS = 60
export const ARCHIVE_DAYS_PER_SWEEP = 10
export const MEETING_DAYS_PER_SWEEP = 31
export const ARCHIVE_DAY_MAX_BYTES = 32 * 1024 * 1024

/** Where a message was asked, only when the server knows it (never guessed; absent otherwise). */
export const SURFACES = ['glasses', 'web', 'mac'] as const
export type Surface = typeof SURFACES[number]
interface CrumbRow { v: 1; row: 'crumb'; id: string; key: string; at: string; kind: CrumbKind; line: string; ref: CrumbRef; surface?: Surface }
interface OutcomeRow { v: 1; row: 'outcome'; of: string; at: string; outcome: CrumbOutcome; answer?: string | null; by?: string; reply?: { type: 'notification'; id: string } }
type TimelineRow = CrumbRow | OutcomeRow

/** One crumb as memory holds it, with its latest outcome. */
export interface Crumb {
  id: string; key: string; at: string; atMs: number; kind: CrumbKind; line: string; ref: CrumbRef; surface?: Surface
  outcome?: CrumbOutcome; answer?: string | null; by?: string; reply?: { type: 'notification'; id: string }
  /** The outcome sequence number of the latest outcome (0: none yet). */
  outcomeSeq: number
}
/** A crumb as the history route answers it (W1's shape: kind, time, line, ref, plus what he did). */
export interface CrumbEntry {
  id: string; at: string; kind: CrumbKind; line: string; ref: CrumbRef; surface?: Surface
  outcome?: CrumbOutcome; answer?: string | null; by?: string; reply?: { type: 'notification'; id: string }
}
export interface NewCrumb { key: string; at: string; kind: CrumbKind; line: string; ref: CrumbRef; surface?: Surface }
export interface OutcomeChange { outcome: CrumbOutcome; answer?: string | null; by?: string; reply?: { type: 'notification'; id: string } }

/** One line, whitespace folded, cut to `n` characters with an ellipsis. */
export function oneLine(s: unknown, n: number): string {
  const flat = String(typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + '…' : flat
}
const crumbId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 20)

function isRef(r: unknown): r is CrumbRef {
  if (!r || typeof r !== 'object') return false
  const x = r as Record<string, unknown>
  if (x.type === 'notification') return typeof x.id === 'string' && typeof x.threadId === 'string'
  if (x.type === 'session') return typeof x.provider === 'string' && typeof x.id === 'string'
  if (x.type === 'meeting') return typeof x.domain === 'string' && typeof x.month === 'string' && typeof x.filename === 'string'
  if (x.type === 'message') return Number.isSafeInteger(x.no) && typeof x.era === 'string'
  return false
}
function isTimelineRow(r: unknown): r is TimelineRow {
  if (!r || typeof r !== 'object') return false
  const x = r as Record<string, unknown>
  if (x.v !== 1 || typeof x.at !== 'string' || !Number.isFinite(Date.parse(x.at))) return false
  if (x.row === 'crumb') return typeof x.id === 'string' && typeof x.key === 'string' && (CRUMB_KINDS as readonly unknown[]).includes(x.kind)
    && typeof x.line === 'string' && isRef(x.ref) && (x.surface === undefined || (SURFACES as readonly unknown[]).includes(x.surface))
  if (x.row === 'outcome') return typeof x.of === 'string'
    && ((NOTIFICATION_OUTCOMES as readonly unknown[]).includes(x.outcome) || (QUESTION_OUTCOMES as readonly unknown[]).includes(x.outcome))
  return false
}

/** The append-only timeline file and its index (all in memory: a crumb is a few hundred bytes). */
export class TimelineStore {
  private readonly file: string
  private readonly byKey = new Map<string, Crumb>()
  private readonly byId = new Map<string, Crumb>()
  /** Append order: the `after` cursor's crumb part counts these. */
  readonly crumbs: Crumb[] = []
  /** How many outcome changes were applied (the `after` cursor's outcome part). */
  outcomeSeq = 0

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'timeline.jsonl')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    const stat = lstatSync(this.file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('timeline_unsafe')
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }  // a torn row is skipped
      if (isTimelineRow(row)) this.apply(row)
    }
  }

  private apply(row: TimelineRow): void {
    if (row.row === 'crumb') {
      if (this.byKey.has(row.key)) return
      const crumb: Crumb = { id: row.id, key: row.key, at: row.at, atMs: Date.parse(row.at), kind: row.kind, line: row.line, ref: row.ref, ...(row.surface ? { surface: row.surface } : {}), outcomeSeq: 0 }
      this.byKey.set(row.key, crumb); this.byId.set(row.id, crumb); this.crumbs.push(crumb)
      return
    }
    const crumb = this.byId.get(row.of)
    if (!crumb || sameOutcome(crumb, row)) return
    this.outcomeSeq += 1
    crumb.outcome = row.outcome
    crumb.outcomeSeq = this.outcomeSeq
    if (row.answer !== undefined) crumb.answer = row.answer; else delete crumb.answer
    if (row.by !== undefined) crumb.by = row.by; else delete crumb.by
    if (row.reply !== undefined) crumb.reply = row.reply; else delete crumb.reply
  }

  /** O_APPEND, fsync, 0600; a file not ending in a newline (a torn row) gets one first. */
  private appendRows(rows: TimelineRow[]): void {
    if (!rows.length) return
    const fd = openSync(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
    try {
      fchmodSync(fd, 0o600)
      const size = fstatSync(fd).size
      let lead = ''
      if (size > 0) {
        const last = Buffer.alloc(1)
        if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) lead = '\n'
      }
      writeSync(fd, lead + rows.map(r => JSON.stringify(r)).join('\n') + '\n')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    for (const row of rows) this.apply(row)
  }

  has(key: string): boolean { return this.byKey.has(key) }
  get(key: string): Crumb | undefined { return this.byKey.get(key) }

  /** New crumbs (those whose key is already here are skipped), in one append. */
  add(crumbs: NewCrumb[]): number {
    const seen = new Set<string>()
    const rows: CrumbRow[] = []
    for (const c of crumbs) {
      if (this.byKey.has(c.key) || seen.has(c.key) || !Number.isFinite(Date.parse(c.at))) continue
      seen.add(c.key)
      rows.push({ v: 1, row: 'crumb', id: crumbId(c.key), key: c.key, at: new Date(Date.parse(c.at)).toISOString(), kind: c.kind, line: oneLine(c.line, LINE_MAX), ref: c.ref,
        ...(c.surface && (SURFACES as readonly string[]).includes(c.surface) ? { surface: c.surface } : {}) })
    }
    this.appendRows(rows)
    return rows.length
  }

  /** Outcomes for crumbs by key; only a CHANGE is written. Unknown keys are skipped. */
  setOutcomes(changes: Array<{ key: string; at?: string } & OutcomeChange>): number {
    const rows: OutcomeRow[] = []
    const at = new Date(this.now()).toISOString()
    for (const c of changes) {
      const crumb = this.byKey.get(c.key)
      if (!crumb) continue
      const row: OutcomeRow = { v: 1, row: 'outcome', of: crumb.id, at: c.at ?? at, outcome: c.outcome,
        ...(c.answer !== undefined ? { answer: c.answer === null ? null : oneLine(c.answer, ANSWER_MAX) } : {}),
        ...(c.by !== undefined ? { by: c.by } : {}), ...(c.reply ? { reply: c.reply } : {}) }
      if (sameOutcome(crumb, row)) continue
      rows.push(row)
    }
    this.appendRows(rows)
    return rows.length
  }

  entry(c: Crumb): CrumbEntry {
    return { id: `b:${c.id}`, at: c.at, kind: c.kind, line: c.line, ref: c.ref, ...(c.surface ? { surface: c.surface } : {}),
      ...(c.outcome ? { outcome: c.outcome } : {}), ...(c.answer !== undefined ? { answer: c.answer } : {}),
      ...(c.by ? { by: c.by } : {}), ...(c.reply ? { reply: c.reply } : {}) }
  }
}

function sameOutcome(crumb: Crumb, row: OutcomeRow | (OutcomeChange & { outcome: CrumbOutcome })): boolean {
  return crumb.outcome === row.outcome && (crumb.answer ?? undefined) === (row.answer ?? undefined) && crumb.by === row.by
    && crumb.reply?.id === row.reply?.id
}

// ── sources ────────────────────────────────────────────

/** A feed item as the sweeper needs it (lib/drop-store.ts FeedItem, read only). */
export interface FeedItemLike { id: string; kind: string; threadId: string; createdAt: string; readAt: string | null; source: string; title?: string; line: string; state: 'live' | 'done'; needsReply?: boolean; links?: ReadonlyArray<{ kind: string }> }

/**
 * What he did with a notification COS sent, from the feed alone (drop-service.ts is the only writer of `done`):
 *   replied    something he sent later on the same thread (a drop of his own, or an answer to its question)
 *   acted      a reminder ping he pressed Done or a snooze on (reminderAction)
 *   dismissed  a ping that waited on him, closed without a reply (dismiss(); the only other way a ping is done)
 *   closed     a follow-up that is done: a newer one on its drop can retire it without him, so no claim is made
 *   seen       still live, and the chat was opened since it arrived
 *   (nothing)  still live and unread
 */
export function notificationOutcome(item: FeedItemLike, thread: readonly FeedItemLike[]): OutcomeChange | null {
  const t = Date.parse(item.createdAt)
  const reply = thread.find(o => o.id !== item.id && o.source !== 'cos' && Date.parse(o.createdAt) > t)
    ?? thread.find(o => o.id !== item.id && o.kind === 'answer' && Date.parse(o.createdAt) > t)
  if (reply) return { outcome: 'replied', reply: { type: 'notification', id: reply.id } }
  if (item.state === 'done') {
    if (item.kind !== 'ping') return { outcome: 'closed' }
    if (item.links?.some(l => l.kind === 'reminder')) return { outcome: 'acted' }
    return { outcome: item.needsReply === true ? 'dismissed' : 'closed' }
  }
  return item.readAt !== null ? { outcome: 'seen' } : null
}

/** The sources a sweep reads. Each is optional, so a test (or a server without one) leaves it out. */
export interface TimelineSources {
  /** The inbox feed, oldest first. */
  feed?: () => FeedItemLike[]
  /** Numbered turns of the live conversations (thread conversations already left out by getActiveSessions). */
  liveMessages?: () => Array<{ no: number; era: string; query: string; at: number; surface?: Surface }>
  /** Archive day dates, newest first, and one day's numbered turns (null: the day was skipped, too big or unreadable). */
  archiveDays?: () => string[]
  archiveDay?: (date: string) => Array<{ no: number; era: string; query: string; at: number }> | null
  /** Meeting day counts per month (a filename scan) and one day's meetings. */
  meetingMonths?: () => string[]
  meetingDayCounts?: (month: string) => Array<{ date: string; count: number }>
  meetingsOn?: (day: string) => Array<{ domain: string; month: string; filename: string; title: string; date: string; time?: string }>
}

interface SweepState { schema: 1; archiveDays: string[]; meetingDays: Record<string, number> }

/** The facts, not a sentence (lead 11:5x): the question's start. The number is in the ref; the page writes the words. */
export function messageLine(query: string): string {
  return oneLine(query, MESSAGE_START_CHARS)
}

/** Local date and HH:MM to an ISO time; the date alone reads as local noon. */
export function meetingAt(date: string, time?: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time && /^\d{1,2}:\d{2}$/.test(time) ? time.split(':').map(Number) : [12, 0]
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hh, mm).toISOString()
}

/**
 * One bounded pass over the sources. Today's archive day and today's meetings are always re-read; older days once
 * (remembered in timeline-state.json). Returns counts per kind of crumbs added and outcomes changed.
 */
export class TimelineSweeper {
  private readonly stateFile: string
  private state: SweepState

  constructor(private readonly store: TimelineStore, private readonly dir: string, private readonly sources: TimelineSources,
    private readonly today: () => string) {
    this.stateFile = join(dir, 'timeline-state.json')
    this.state = this.readState()
  }

  private readState(): SweepState {
    try {
      const stat = lstatSync(this.stateFile)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe')
      const v = JSON.parse(readFileSync(this.stateFile, 'utf8')) as SweepState
      if (v?.schema === 1 && Array.isArray(v.archiveDays) && v.meetingDays && typeof v.meetingDays === 'object') return v
    } catch { /* fresh */ }
    return { schema: 1, archiveDays: [], meetingDays: {} }
  }
  private writeState(): void {
    durableAtomicWriteFileSync(this.stateFile, JSON.stringify(this.state) + '\n', { mode: 0o600 })
  }

  sweep(): { notifications: number; outcomes: number; messages: number; meetings: number; pending: boolean } {
    const out = { notifications: 0, outcomes: 0, messages: 0, meetings: 0, pending: false }
    // Notifications COS sent, and what he did with each.
    const feed = this.sources.feed?.() ?? []
    const cos = feed.filter(i => i.source === 'cos' && (i.kind === 'ping' || i.kind === 'followup'))
    out.notifications = this.store.add(cos.map(i => ({ key: `fi:${i.id}`, at: i.createdAt, kind: 'notification' as const,
      line: oneLine(i.title || i.line, LINE_MAX), ref: { type: 'notification' as const, id: i.id, threadId: i.threadId } })))
    const byThread = new Map<string, FeedItemLike[]>()
    for (const i of feed) byThread.set(i.threadId, [...(byThread.get(i.threadId) ?? []), i])
    out.outcomes = this.store.setOutcomes(cos.flatMap(i => {
      const o = notificationOutcome(i, byThread.get(i.threadId) ?? [])
      return o ? [{ key: `fi:${i.id}`, ...o }] : []
    }))
    // Numbered Messages turns: the live conversations every pass, the archive a few days a pass.
    const messageCrumbs = (rows: Array<{ no: number; era: string; query: string; at: number; surface?: Surface }>) => rows
      .filter(r => Number.isSafeInteger(r.no) && r.no > 0 && Number.isFinite(r.at))
      .map(r => ({ key: `msg:${r.era}:${r.no}`, at: new Date(r.at).toISOString(), kind: 'message' as const, line: messageLine(r.query),
        ref: { type: 'message' as const, no: r.no, era: r.era }, ...(r.surface ? { surface: r.surface } : {}) }))
    out.messages += this.store.add(messageCrumbs(this.sources.liveMessages?.() ?? []))
    const today = this.today()
    if (this.sources.archiveDays && this.sources.archiveDay) {
      const done = new Set(this.state.archiveDays)
      // Today is never marked done, so it is read again every pass (more turns may land in it).
      const due = this.sources.archiveDays().filter(d => !done.has(d))
      for (const date of due.slice(0, ARCHIVE_DAYS_PER_SWEEP)) {
        const rows = this.sources.archiveDay(date)
        if (rows) out.messages += this.store.add(messageCrumbs(rows))
        if (date !== today) done.add(date)  // a skipped (too big) day is not retried every pass
      }
      out.pending ||= due.length > ARCHIVE_DAYS_PER_SWEEP
      this.state.archiveDays = [...done].sort()
    }
    // Meetings: a day is re-read only when its count changed (a filename scan, no file opened).
    if (this.sources.meetingMonths && this.sources.meetingDayCounts && this.sources.meetingsOn) {
      let budget = MEETING_DAYS_PER_SWEEP
      for (const month of this.sources.meetingMonths()) {
        for (const { date, count } of this.sources.meetingDayCounts(month)) {
          if (this.state.meetingDays[date] === count) continue
          if (budget-- <= 0) { out.pending = true; break }
          const meetings = this.sources.meetingsOn(date)
          out.meetings += this.store.add(meetings.map(m => ({ key: `mt:${m.domain}/${m.month}/${m.filename}`, at: meetingAt(m.date, m.time),
            kind: 'meeting' as const, line: oneLine(m.title || 'A meeting', LINE_MAX), ref: { type: 'meeting' as const, domain: m.domain, month: m.month, filename: m.filename } })))
          this.state.meetingDays[date] = count
        }
        if (budget < 0) break
      }
    }
    this.writeState()
    return out
  }
}

/** Session questions from X1's turn-end-ask callback (TurnAskEvent). Words only from the event; nothing logged. */
export interface TurnAskEventLike {
  type: 'asked' | 'settled'; askKey: string; sessionId: string; at: number; question: string | null; outcome?: string; by?: string; answer?: string | null
}
export function recordTurnAskEvent(store: TimelineStore, e: TurnAskEventLike, provider = 'claude'): void {
  if (!e || typeof e.askKey !== 'string' || typeof e.sessionId !== 'string' || !Number.isFinite(e.at)) return
  const key = `ask:${e.askKey}`
  if (e.type === 'asked' || !store.has(key)) {
    store.add([{ key, at: new Date(e.at).toISOString(), kind: 'session_question', line: oneLine(e.question || 'A session asked you a question', LINE_MAX),
      ref: { type: 'session', provider, id: e.sessionId } }])
  }
  if (e.type === 'settled' && (QUESTION_OUTCOMES as readonly unknown[]).includes(e.outcome)) {
    store.setOutcomes([{ key, at: new Date(e.at).toISOString(), outcome: e.outcome as CrumbOutcome,
      ...(e.answer !== undefined ? { answer: e.answer } : {}), ...(typeof e.by === 'string' ? { by: e.by } : {}) }])
  }
}

/** Day files under a directory, newest first (YYYY-MM-DD.json only). */
export function archiveDayDates(dir: string): string[] {
  try { return readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse() } catch { return [] }
}
/** One archive day's numbered user turns, read only; null when the file is missing, a link, too big or unreadable. */
export function readArchiveDayTurns(dir: string, date: string, maxBytes = ARCHIVE_DAY_MAX_BYTES): Array<{ no: number; era: string; query: string; at: number }> | null {
  const file = join(dir, `${date}.json`)
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const day = JSON.parse(readFileSync(file, 'utf8')) as { chats?: Array<{ exchanges?: Array<Record<string, unknown>> }> }
    const out: Array<{ no: number; era: string; query: string; at: number }> = []
    for (const chat of Array.isArray(day?.chats) ? day.chats : []) {
      for (const ex of Array.isArray(chat?.exchanges) ? chat.exchanges : []) {
        if (ex?.role !== 'user' || !Number.isSafeInteger(ex.globalMsgNum) || typeof ex.content !== 'string') continue
        out.push({ no: ex.globalMsgNum as number, era: typeof ex.messageEra === 'string' ? ex.messageEra : 'legacy', query: ex.content, at: Number(ex.timestamp) })
      }
    }
    return out
  } catch { return null }
}
