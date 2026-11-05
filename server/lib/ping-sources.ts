/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 5): what COS may ping about, read from signals that already exist.
 *
 * Every function here is pure: a snapshot in, candidates out. They run no script and call no model; the words come
 * from fixed templates filled with the source's own titles and counts (canary 9). Each candidate carries the
 * exactly-once key the plan names, so a source read twice, or again after a restart, yields the same key.
 *
 * | Source     | Read                                   | Key                                    |
 * | prep       | the next calendar event                | prep:<event hash>:<local day>          |
 * | followups  | open Work intake items, by meeting     | followups:<meeting record id hash>     |
 * | stale      | a thread whose is_stale is true        | stale:<thread id>:<ISO week>           |
 * | signal     | a red Signal row                       | signal:<Signal.id>                     |
 * | checkin    | the clock, Monday from 9:00            | checkin:<ISO week>                     |
 * | agent      | a linked session's turn ended (pushed) | agent:<session id>:<turn end>          |
 *
 * Reminders and resolutions come from the drop store (reminder-scheduler.ts, drop-resolution.ts), not from here.
 */
import { createHash } from 'node:crypto'
import { localClock } from './morning-brief-schedule.js'
import { clockLabel } from './drop-when.js'
import { PING_RANK, type PingSource } from './ping-budget.js'

export interface PingLink { kind: 'card' | 'session' | 'handoff' | 'thread' | 'memory' | 'meeting' | 'file' | 'reminder' | 'ask'; id: string; label: string; domain?: string }
export interface PingCandidate {
  source: PingSource
  /** Exactly-once key (plan section 4). */
  key: string
  title?: string
  line: string
  links: PingLink[]
  actions: Array<{ id: string; label: string }>
  /** Epoch ms the source saw it. */
  createdAt: number
  /** Epoch ms after which it is no longer worth posting (prep: the meeting start). */
  expiresAt?: number
  /** Counts toward "waiting on you" until answered, done or dismissed (plan section 12). */
  needsReply?: boolean
  /**
   * The notification identifier the banner uses. A reminder uses `reminder-<drop id>`, the same id Control gives its
   * local backup notification, so a server fire replaces Control's instead of doubling it (plan section 7).
   */
  notifyId?: string
  /** The drop a follow-up answers (it threads under that drop in the chat); a ping without one is its own thread. */
  threadId?: string
}

export const PING_TEXT = { title: 120, line: 400, digestLines: 5 } as const
/** Prep pings go out 15 minutes before a meeting (plan section 5). */
export const PREP_LEAD_MS = 15 * 60_000
/** A thread is pinged about as stale at most once a week (the key carries the ISO week). */
export const CHECKIN = { weekday: 1, minutes: 9 * 60, line: "What's one thing this week you don't want to forget? I'll remind you." } as const

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const CONTROL = /[\x00-\x1f\x7f]+/g
/** One line of a source's own words, cleaned and capped: never a model's. */
export function clip(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const t = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}
const ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/

/** ISO 8601 week key, "2026-W45", for the local day. */
export function isoWeek(nowMs: number, timezone: string): string {
  const [y, m, d] = localClock(nowMs, timezone).day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Prep: the next meeting, inside 15 minutes of its start. Expires at the start. */
export function prepCandidates(next: { title?: unknown; time?: unknown } | null | undefined, nowMs: number, timezone: string): PingCandidate[] {
  if (!next) return []
  const start = typeof next.time === 'string' ? Date.parse(next.time) : NaN
  const title = clip(next.title, PING_TEXT.title)
  if (!Number.isFinite(start) || !title) return []
  if (start <= nowMs || start - nowMs > PREP_LEAD_MS) return []
  const day = localClock(start, timezone).day
  return [{
    source: 'prep', key: `prep:${hash(`${title}\n${next.time}`)}:${day}`,
    title, line: `${title} at ${clockLabel(localClock(start, timezone).minutes)}. Prep me?`,
    links: [], actions: [{ id: 'prep', label: 'Prep me' }, { id: 'dismiss', label: 'Not now' }],
    createdAt: nowMs, expiresAt: start,
  }]
}

export interface IntakeRow { id: string; status: string; meeting: { recordId: string; title: string; domain: string } }
/** Follow-ups ready: open intake items grouped by meeting, one ping per meeting. */
export function followupCandidates(open: readonly IntakeRow[] | null | undefined, nowMs: number): PingCandidate[] {
  if (!open?.length) return []
  const byMeeting = new Map<string, IntakeRow[]>()
  for (const row of open) {
    if (!row?.meeting?.recordId) continue
    byMeeting.set(row.meeting.recordId, [...(byMeeting.get(row.meeting.recordId) ?? []), row])
  }
  return [...byMeeting.entries()].map(([recordId, rows]) => {
    const title = clip(rows[0].meeting.title, PING_TEXT.title) || 'a meeting'
    const n = rows.length
    return {
      source: 'followups' as const, key: `followups:${hash(recordId)}`,
      title, line: `${n} follow-up${n === 1 ? '' : 's'} from ${title}.`,
      links: [{ kind: 'meeting' as const, id: `m_${hash(recordId)}`, label: title, domain: rows[0].meeting.domain }],
      actions: [{ id: 'review', label: 'Review' }, { id: 'dismiss', label: 'Dismiss' }],
      createdAt: nowMs, needsReply: true,
    }
  })
}

export interface ThreadRow { id?: unknown; name?: unknown; is_stale?: unknown; is_resolved?: unknown; last_seen?: unknown }
/** Stale: a thread the tracker marks stale and not resolved. At most weekly per thread (the key has the week). */
export function staleCandidates(threads: readonly ThreadRow[] | null | undefined, nowMs: number, timezone: string): PingCandidate[] {
  if (!threads?.length) return []
  const week = isoWeek(nowMs, timezone)
  const out: PingCandidate[] = []
  for (const t of threads) {
    if (t?.is_stale !== true || t.is_resolved === true || typeof t.id !== 'string' || !ID_SAFE.test(t.id)) continue
    const name = clip(t.name, PING_TEXT.title)
    if (!name) continue
    const last = typeof t.last_seen === 'string' ? Date.parse(t.last_seen) : NaN
    const days = Number.isFinite(last) ? Math.max(1, Math.floor((nowMs - last) / 86_400_000)) : null
    out.push({
      source: 'stale', key: `stale:${t.id}:${week}`, title: name,
      line: days ? `${name} quiet for ${days} days.` : `${name} has gone quiet.`,
      links: [{ kind: 'thread', id: t.id, label: name }], actions: [{ id: 'open', label: 'Open' }],
      createdAt: nowMs,
    })
  }
  return out
}

export interface SignalRow { id?: unknown; severity?: unknown; title?: unknown; context?: unknown }
/** Red signals, by their own title and the cache's existing context.explanation. One ping per Signal.id. */
export function signalCandidates(signals: readonly SignalRow[] | null | undefined, nowMs: number): PingCandidate[] {
  if (!signals?.length) return []
  const out: PingCandidate[] = []
  for (const s of signals) {
    if (s?.severity !== 'red' || typeof s.id !== 'string' || !ID_SAFE.test(s.id)) continue
    const title = clip(s.title, PING_TEXT.title)
    if (!title) continue
    const ctx = s.context && typeof s.context === 'object' ? (s.context as { explanation?: unknown }).explanation : undefined
    const why = clip(ctx, PING_TEXT.line - title.length - 2)
    out.push({
      source: 'stale', key: `signal:${s.id}`, title,
      line: why ? `${title}. ${why}` : `${title}.`, links: [], actions: [{ id: 'dismiss', label: 'Dismiss' }],
      createdAt: nowMs,
    })
  }
  return out
}

/** The weekly check-in, Monday from 9:00 local, once per ISO week. His reply becomes a reminder. */
export function checkinCandidates(nowMs: number, timezone: string): PingCandidate[] {
  const c = localClock(nowMs, timezone)
  if (c.weekday !== CHECKIN.weekday || c.minutes < CHECKIN.minutes) return []
  return [{
    source: 'checkin', key: `checkin:${isoWeek(nowMs, timezone)}`, line: CHECKIN.line,
    links: [], actions: [{ id: 'reply', label: 'Reply' }, { id: 'dismiss', label: 'Skip this week' }],
    createdAt: nowMs, needsReply: true,
  }]
}

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', grok: 'Grok' }
/** Agent finished: a session linked to a drop or a Work handoff ended its turn. Pushed by the caller, never polled. */
export function agentCandidate(ev: { provider?: unknown; sessionId?: unknown; turnEndedAt?: unknown; label?: unknown; failed?: unknown }): PingCandidate | null {
  if (typeof ev.sessionId !== 'string' || !ID_SAFE.test(ev.sessionId) || typeof ev.turnEndedAt !== 'number' || !Number.isFinite(ev.turnEndedAt)) return null
  const who = PROVIDER_NAME[typeof ev.provider === 'string' ? ev.provider : ''] ?? 'Your agent'
  const label = clip(ev.label, PING_TEXT.title) || 'its task'
  return {
    source: 'agent', key: `agent:${ev.sessionId}:${Math.floor(ev.turnEndedAt)}`, title: label,
    line: ev.failed === true ? `${who} stopped on ${label}. It needs a look.` : `${who} finished ${label}.`,
    links: [{ kind: 'session', id: ev.sessionId, label }], actions: [{ id: 'open_result', label: 'Open result' }],
    createdAt: ev.turnEndedAt, needsReply: ev.failed === true,
  }
}

/** The one "While you were off" item that carries what quiet hours held (plan section 5). */
export function digestCandidate(held: readonly PingCandidate[], nowMs: number, timezone: string): PingCandidate | null {
  if (!held.length) return null
  const lines = held.slice(0, PING_TEXT.digestLines).map(h => `- ${h.line}`)
  if (held.length > PING_TEXT.digestLines) lines.push(`- and ${held.length - PING_TEXT.digestLines} more`)
  const best = [...held].sort((a, b) => PING_RANK[a.source] - PING_RANK[b.source])[0]
  const links = held.flatMap(h => h.links).slice(0, 12)
  return {
    source: best.source, key: `offhours:${localClock(nowMs, timezone).day}`,
    title: held.length === 1 ? 'While you were off' : `While you were off: ${held.length} updates`,
    line: lines.join('\n'), links, actions: [{ id: 'open', label: 'Open' }],
    createdAt: nowMs, needsReply: held.some(h => h.needsReply),
  }
}
