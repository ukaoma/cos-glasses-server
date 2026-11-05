import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DropStore, type DropRecord } from './drop-store.js'
import { applyReminderAction, createReminderScheduler, fireDueReminders, lateWords, pendingReminders, reminderAbout, reminderNotifyId, REMINDER_LATE_MS, REMINDER_TICK_MS } from './reminder-scheduler.js'
import { PingEngine, type PingBanner, type PingState } from './ping-engine.js'
import type { PingCandidate } from './ping-sources.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function root(): string { const d = mkdtempSync(join(tmpdir(), 'cos-reminders-')); dirs.push(d); return join(d, 'drops') }

function reminderDrop(text: string, atMs: number | null, createdMs = local('2026-11-04', '09:00')): DropRecord {
  const id = randomUUID(), created = new Date(createdMs).toISOString()
  return {
    id, text, source: 'mac', createdAt: created, updatedAt: created, state: 'filed', dest: 'reminder', kind: 'reminder',
    links: [{ kind: 'reminder', id, label: 'Reminder' }], route: { by: 'rule' }, undoUntil: null, timeline: [{ at: created, state: 'filed', dest: 'reminder' }],
    remind: { at: atMs === null ? null : new Date(atMs).toISOString(), tz: TZ, firedAt: null, ackAt: null, snoozes: 0 },
  }
}

describe('reminder firing', () => {
  it('fires once at its time, never before, and never twice', () => {
    const store = new DropStore(root())
    const d = store.insert(reminderDrop('remind me at 10am to call Pete', local('2026-11-04', '10:00'))).drop
    const got: PingCandidate[] = []
    expect(fireDueReminders(store, local('2026-11-04', '09:59'), c => got.push(...c)).fired).toBe(0)
    expect(fireDueReminders(store, local('2026-11-04', '10:00'), c => got.push(...c)).fired).toBe(1)
    expect(fireDueReminders(store, local('2026-11-04', '10:00') + REMINDER_TICK_MS, c => got.push(...c)).fired).toBe(0)
    expect(got).toEqual([expect.objectContaining({
      source: 'reminder', key: `reminder:${d.id}:${d.remind!.at}`, line: 'Reminder: call Pete', notifyId: `reminder-${d.id}`,
      actions: [{ id: 'reminder_done', label: 'Done' }, { id: 'snooze_1h', label: 'Snooze 1 hour' }, { id: 'snooze_tomorrow', label: 'Tomorrow 9' }],
    })])
    expect(store.get(d.id)!.remind!.firedAt).toBe(new Date(local('2026-11-04', '10:00')).toISOString())
    store.close()
  })

  it('skips undone drops, acknowledged reminders and reminders with no time yet', () => {
    const store = new DropStore(root())
    const undone = { ...reminderDrop('remind me at 10am', local('2026-11-04', '10:00')), state: 'undone' as const }
    const acked = reminderDrop('remind me at 10am', local('2026-11-04', '10:00')); acked.remind!.ackAt = new Date(local('2026-11-04', '09:30')).toISOString()
    const noTime = reminderDrop('remind me to call mom', null)
    for (const d of [undone, acked, noTime]) store.insert(d)
    expect(fireDueReminders(store, local('2026-11-04', '11:00'), () => {}).fired).toBe(0)
    expect(pendingReminders(store)).toEqual([])
    store.close()
  })

  it('re-checks under the lock: a reminder acknowledged between the read and the write does not fire', () => {
    const store = new DropStore(root())
    const d = store.insert(reminderDrop('remind me at 10am', local('2026-11-04', '10:00'))).drop
    const racing = {
      select: store.select.bind(store),
      update: (id: string, fn: (c: DropRecord) => DropRecord) => {
        store.update(id, c => ({ ...c, remind: { ...c.remind!, ackAt: new Date().toISOString() } }))  // the ack lands first
        return store.update(id, fn)
      },
    }
    const got: PingCandidate[] = []
    expect(fireDueReminders(racing, local('2026-11-04', '10:01'), c => got.push(...c)).fired).toBe(0)
    expect(got).toEqual([])
    expect(store.get(d.id)!.remind!.firedAt).toBeNull()
    store.close()
  })

  it('says how late, past 10 minutes', () => {
    expect(REMINDER_LATE_MS).toBe(600_000)
    expect(lateWords(35 * 60_000)).toBe('35 minutes')
    expect(lateWords(3 * 3_600_000)).toBe('3 hours')
    expect(lateWords(3 * 86_400_000)).toBe('3 days')
    const store = new DropStore(root())
    store.insert(reminderDrop('remind me at 10am to call Pete', local('2026-11-04', '10:00')))
    const got: PingCandidate[] = []
    fireDueReminders(store, local('2026-11-04', '10:09'), c => got.push(...c))
    expect(got[0].line).toBe('Reminder: call Pete')
    store.close()
  })

  it('snooze sets a new time and a new key; Done stops it for good', () => {
    const store = new DropStore(root())
    const d = store.insert(reminderDrop('remind me at 10am to call Pete', local('2026-11-04', '10:00'))).drop
    const keys: string[] = []
    fireDueReminders(store, local('2026-11-04', '10:00'), c => keys.push(...c.map(x => x.key)))
    expect(applyReminderAction(store, d.id, 'snooze_1h', local('2026-11-04', '10:02'))!.remind).toMatchObject({ at: new Date(local('2026-11-04', '11:02')).toISOString(), firedAt: null, snoozes: 1 })
    fireDueReminders(store, local('2026-11-04', '11:02'), c => keys.push(...c.map(x => x.key)))
    expect(applyReminderAction(store, d.id, 'snooze_tomorrow', local('2026-11-04', '11:05'))!.remind!.at).toBe(new Date(local('2026-11-05', '09:00')).toISOString())
    expect(applyReminderAction(store, d.id, 'reminder_done', local('2026-11-04', '11:06'))!.remind!.ackAt).not.toBeNull()
    expect(fireDueReminders(store, local('2026-11-05', '09:00'), c => keys.push(...c.map(x => x.key))).fired).toBe(0)
    expect(new Set(keys).size).toBe(2)
    expect(applyReminderAction(store, d.id, 'snooze_1h', local('2026-11-05', '09:01'))).toBeNull()  // done is final
    store.close()
  })

  it('refuses actions on an undone drop and on a drop that is not a reminder', () => {
    const store = new DropStore(root())
    const undone = store.insert({ ...reminderDrop('remind me at 10am', local('2026-11-04', '10:00')), state: 'undone' }).drop
    const note = store.insert({ ...reminderDrop('just a note', local('2026-11-04', '10:00')), dest: 'note', kind: 'note' }).drop
    expect(applyReminderAction(store, undone.id, 'snooze_1h', local('2026-11-04', '10:05'))).toBeNull()
    expect(applyReminderAction(store, note.id, 'reminder_done', local('2026-11-04', '10:05'))).toBeNull()
    expect(store.get(undone.id)!.remind!.snoozes).toBe(0)
    expect(store.get(note.id)!.remind!.ackAt).toBeNull()
    store.close()
  })

  it('reads what it is about from the words, and lists pending reminders soonest first for the Mac mirror', () => {
    const store = new DropStore(root())
    const late = store.insert(reminderDrop('remind me Friday to send the deck', local('2026-11-06', '09:00'))).drop
    const soon = store.insert(reminderDrop('remind me Thursday to send Gina the JCK numbers', local('2026-11-05', '09:00'))).drop
    expect(reminderAbout(soon)).toBe('send Gina the JCK numbers')
    expect(pendingReminders(store)).toEqual([
      { id: soon.id, at: soon.remind!.at, title: 'Reminder: send Gina the JCK numbers', notifyId: reminderNotifyId(soon.id) },
      { id: late.id, at: late.remind!.at, title: 'Reminder: send the deck', notifyId: reminderNotifyId(late.id) },
    ])
    store.close()
  })
})

/**
 * Canary 8 (plan section 9): a 3-hour clock jump and a server-down fire. Fails if a reminder fires other than once,
 * is not marked late, or the banners double. Notifications are a map by identifier, as macOS keeps them: a second
 * notification with the same id replaces the first.
 */
describe('canary 8: reminder sleep and server-down', () => {
  function rig(storeRoot: string, nowRef: { now: number }, center: Map<string, PingBanner>, state: { s: PingState }, feedKeys: Set<string>) {
    const store = new DropStore(storeRoot, () => new Date(nowRef.now))
    const engine = new PingEngine({
      state: { read: () => structuredClone(state.s), write: s => { state.s = structuredClone(s) } },
      feed: { hasKey: k => feedKeys.has(k), post: c => { feedKeys.add(c.key); return `f_${feedKeys.size}` } },
      read: async () => ({}), banner: b => center.set(b.notifyId ?? `n_${center.size}`, b), now: () => nowRef.now, timezone: () => TZ,
    })
    const scheduler = createReminderScheduler({ store, deliver: c => engine.push(c), now: () => nowRef.now })
    return { store, scheduler }
  }

  it('a 3-hour jump (the Mac slept through it) fires once, marked late', () => {
    const nowRef = { now: local('2026-11-04', '09:59') }
    const center = new Map<string, PingBanner>(), state = { s: { ledger: [], held: [], consumed: [] } as PingState }, feed = new Set<string>()
    const r = root()
    const { store, scheduler } = rig(r, nowRef, center, state, feed)
    const d = store.insert(reminderDrop('remind me at 10am to call Pete', local('2026-11-04', '10:00'))).drop
    expect(scheduler.tick().fired).toBe(0)
    nowRef.now = local('2026-11-04', '13:00')  // woke up
    expect(scheduler.tick()).toEqual({ fired: 1, late: 1 })
    expect(scheduler.tick().fired).toBe(0)
    expect([...center.values()]).toEqual([expect.objectContaining({ notifyId: `reminder-${d.id}`, line: 'Reminder (3 hours late): call Pete', exempt: true })])
    store.close()
  })

  it('server down at fire time: Control fires locally, the server fires once on return, and the banner replaces it', () => {
    const nowRef = { now: local('2026-11-04', '09:00') }
    const center = new Map<string, PingBanner>(), state = { s: { ledger: [], held: [], consumed: [] } as PingState }, feed = new Set<string>()
    const r = root()
    let { store } = rig(r, nowRef, center, state, feed)
    const d = store.insert(reminderDrop('remind me at 10am to call Pete', local('2026-11-04', '10:00'))).drop
    // Control mirrors it before the server goes down.
    const mirror = pendingReminders(store)
    store.close()  // the server is down from 9:00 to 10:40
    nowRef.now = local('2026-11-04', '10:00')
    for (const m of mirror) center.set(m.notifyId, { feedIds: [], title: m.title, line: m.title, sources: ['reminder'], exempt: true, notifyId: m.notifyId })
    nowRef.now = local('2026-11-04', '10:40')
    const back = rig(r, nowRef, center, state, feed)
    expect(back.scheduler.tick()).toEqual({ fired: 1, late: 1 })
    expect(back.scheduler.tick().fired).toBe(0)
    expect(center.size).toBe(1)  // replaced, not doubled
    expect(center.get(`reminder-${d.id}`)!.line).toBe('Reminder (40 minutes late): call Pete')
    back.store.close()
  })

  it('a crash after firedAt is written and before the banner never fires it again on restart', () => {
    const nowRef = { now: local('2026-11-04', '10:00') }
    const r = root()
    const s1 = new DropStore(r, () => new Date(nowRef.now))
    s1.insert(reminderDrop('remind me at 10am', local('2026-11-04', '10:00')))
    expect(() => fireDueReminders(s1, nowRef.now, () => { throw new Error('crash before the banner') })).toThrow()
    s1.close()
    const s2 = new DropStore(r, () => new Date(nowRef.now))
    const got: PingCandidate[] = []
    expect(fireDueReminders(s2, nowRef.now + 60_000, c => got.push(...c)).fired).toBe(0)
    s2.close()
  })
})
