/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 7): firing the reminders he set.
 *
 * - The time lives on the drop: `remind: { at, tz, firedAt, ackAt, snoozes }`.
 * - A 30-second tick (the morning-brief scheduler pattern). After sleep or a server restart the first tick fires
 *   everything overdue, once each, and says how late it is when that is over 10 minutes.
 * - `firedAt` is written under the drop store's writer lock BEFORE delivery, so a crash after the write can lose a
 *   banner but never repeat one, and two ticks can never both fire it.
 * - The banner uses the notification id `reminder-<drop id>`. Control mirrors each pending reminder as a local
 *   calendar-trigger notification with the same id, so it fires with the server down and a later server fire
 *   replaces it instead of doubling it.
 * - Actions: Done, Snooze 1 hour, Tomorrow 9. A snooze sets a new `at`, which is a new exactly-once key.
 *
 * A reminder he set fires at any hour (the one quiet-hours exception, per CLAUDE.md). No model, no script.
 */
import type { DropRecord } from './drop-store.js'
import { parseWhen, snoozeTargets, type WhenResult } from './drop-when.js'
import { clip, PING_TEXT, type PingCandidate } from './ping-sources.js'

export const REMINDER_TICK_MS = 30_000
/** Over this late, the reminder says how late it is (plan section 7). */
export const REMINDER_LATE_MS = 10 * 60_000
export const REMINDER_ACTIONS = [
  { id: 'reminder_done', label: 'Done' },
  { id: 'snooze_1h', label: 'Snooze 1 hour' },
  { id: 'snooze_tomorrow', label: 'Tomorrow 9' },
] as const
export type ReminderAction = typeof REMINDER_ACTIONS[number]['id']

/** The two store calls the scheduler needs; DropStore has both. */
export interface ReminderStore {
  select(match: (row: Readonly<DropRecord>) => boolean): DropRecord[]
  update(id: string, fn: (current: DropRecord) => DropRecord): DropRecord
}

/** The notification id Control's local backup uses for the same reminder. */
export const reminderNotifyId = (dropId: string) => `reminder-${dropId}`

/** What the drop asked to be reminded about: its words without "remind me" and the time. */
export function reminderAbout(drop: Pick<DropRecord, 'text' | 'createdAt' | 'remind'>): string {
  const tz = drop.remind?.tz || 'UTC'
  const about = parseWhen(drop.text, Date.parse(drop.createdAt) || 0, tz).about
  return clip(about || drop.text, PING_TEXT.title) || 'your reminder'
}

/** "2 hours", "35 minutes", "1 day": how late a fire is. */
export function lateWords(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

const pending = (r: Readonly<DropRecord>) => r.state !== 'undone' && r.dest === 'reminder' && !!r.remind?.at && !r.remind.firedAt && !r.remind.ackAt

/** Every reminder still to fire, soonest first: what Control mirrors as local notifications. */
export function pendingReminders(store: Pick<ReminderStore, 'select'>): Array<{ id: string; at: string; title: string; notifyId: string }> {
  return store.select(pending)
    .map(r => ({ id: r.id, at: r.remind!.at!, title: `Reminder: ${reminderAbout(r)}`, notifyId: reminderNotifyId(r.id) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

export interface FireResult { fired: number; late: number }

/**
 * Fire every reminder whose time has come. `deliver` receives the candidates only after each `firedAt` is on disk.
 * A store write that fails (store closed, disk full) skips that reminder this tick; it is tried again next tick.
 */
export function fireDueReminders(store: ReminderStore, nowMs: number, deliver: (c: PingCandidate[]) => void): FireResult {
  const due = store.select(r => pending(r) && Date.parse(r.remind!.at!) <= nowMs)
  const out: PingCandidate[] = []
  let late = 0
  for (const drop of due) {
    const at = drop.remind!.at!
    let written: DropRecord
    try {
      written = store.update(drop.id, cur => {
        // Re-checked under the writer lock: another tick, an ack or an undo may have landed since the select.
        if (!pending(cur) || cur.remind!.at !== at) throw new Error('reminder_moved')
        return { ...cur, remind: { ...cur.remind!, firedAt: new Date(nowMs).toISOString() } }
      })
    } catch { continue }
    const lateMs = nowMs - Date.parse(at)
    const about = reminderAbout(written)
    const isLate = lateMs > REMINDER_LATE_MS
    if (isLate) late++
    out.push({
      source: 'reminder', key: `reminder:${drop.id}:${at}`, title: 'Reminder',
      line: isLate ? `Reminder (${lateWords(lateMs)} late): ${about}` : `Reminder: ${about}`,
      links: [{ kind: 'reminder', id: drop.id, label: about }],
      actions: REMINDER_ACTIONS.map(a => ({ ...a })),
      createdAt: nowMs, notifyId: reminderNotifyId(drop.id),
    })
  }
  if (out.length) deliver(out)
  return { fired: out.length, late }
}

/**
 * Done, Snooze 1 hour or Tomorrow 9, on a reminder that has fired (or a pending one: Done also cancels it).
 * Returns the updated drop, or null when it is not a live reminder.
 */
export function applyReminderAction(store: ReminderStore, dropId: string, action: ReminderAction, nowMs: number): DropRecord | null {
  const [row] = store.select(r => r.id === dropId)
  if (!row || row.state === 'undone' || row.dest !== 'reminder' || !row.remind || row.remind.ackAt) return null
  const iso = (ms: number) => new Date(ms).toISOString()
  const targets = snoozeTargets(nowMs, row.remind.tz || 'UTC')
  try {
    return store.update(dropId, cur => {
      if (!cur.remind || cur.remind.ackAt) throw new Error('reminder_gone')
      if (action === 'reminder_done') return { ...cur, remind: { ...cur.remind, ackAt: iso(nowMs) } }
      const at = action === 'snooze_1h' ? targets.hour : targets.tomorrow9
      return { ...cur, remind: { ...cur.remind, at: iso(at), firedAt: null, snoozes: cur.remind.snoozes + 1 } }
    })
  } catch { return null }
}

/** The reminder time read from a drop's words at filing, or why it could not be read (COS then asks once). */
export function reminderTimeFor(text: string, nowMs: number, timezone: string): WhenResult {
  return parseWhen(text, nowMs, timezone)
}

/** The 30-second tick. `start` is idempotent; the timer never holds the process open. */
export function createReminderScheduler(deps: { store: ReminderStore; deliver: (c: PingCandidate[]) => void; now?: () => number; intervalMs?: number }) {
  const now = deps.now ?? (() => Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  const tick = (): FireResult => {
    if (running) return { fired: 0, late: 0 }
    running = true
    try {
      const r = fireDueReminders(deps.store, now(), deps.deliver)
      if (r.fired) console.log(`[reminders] fired=${r.fired} late=${r.late}`)
      return r
    } catch { return { fired: 0, late: 0 } } finally { running = false }
  }
  return {
    tick,
    start() { if (timer) return; tick(); timer = setInterval(tick, deps.intervalMs ?? REMINDER_TICK_MS); timer.unref?.() },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
}
