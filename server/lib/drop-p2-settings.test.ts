/**
 * 6.99.11 P2 settings. Every value must be honored by the code that does the thing, so each one has a test that
 * changes it and watches the behavior change, through the real module (budget, engine, sources, parser, scheduler,
 * service, runtime, routes).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  bannerSourcesFrom, budgetFrom, createP2SettingsReader, matchesSteer, mergeP2Settings, normalizeP2Settings, P2_DEFAULTS, readP2Settings, steerWords,
  writeP2Settings, type P2Settings,
} from './drop-p2-settings.js'
import { DEFAULT_BUDGET, isQuietHours, planBanners, type BannerRecord } from './ping-budget.js'
import { PingEngine, type PingBanner, type PingSnapshot, type PingState } from './ping-engine.js'
import type { PingCandidate } from './ping-sources.js'
import { parseWhen, whenSuggestions } from './drop-when.js'
import { fireDueReminders, reminderActions } from './reminder-scheduler.js'
import { DropStore, InboxFeedStore, type DropRecord } from './drop-store.js'
import { createDropP2Runtime, followUpAllowed } from './drop-p2-runtime.js'
import { PingStateStore } from './ping-engine.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cos-p2set-')); dirs.push(d); return d }
const with_ = (patch: unknown): P2Settings => mergeP2Settings(P2_DEFAULTS, patch)

function engine(settings: P2Settings, now: number, snap: PingSnapshot = {}) {
  let st: PingState = { ledger: [], held: [], consumed: [] }
  const feed = new Map<string, PingCandidate>()
  const banners: PingBanner[] = []
  const e = new PingEngine({
    state: { read: () => structuredClone(st), write: s => { st = structuredClone(s) } },
    feed: { hasKey: k => feed.has(k), post: c => { feed.set(c.key, c); return `f_${feed.size}` } },
    read: async () => snap, banner: b => banners.push(b), now: () => now, timezone: () => TZ, settings: () => settings,
  })
  return { e, feed, banners }
}
const staleThread = { id: 't1', name: 'JCK thread', is_stale: true, is_resolved: false, last_seen: '2026-10-21T12:00:00Z' }
const redSignal = { id: 's1', severity: 'red', title: 'Pet leads down' }
const ping = (id: string, source: PingCandidate['source'], line = 'x', title?: string): PingCandidate => ({ id, source, key: `${source}:${id}`, line, title, links: [], actions: [], createdAt: 0 } as unknown as PingCandidate)

describe('P2 settings: reading, clamping, saving', () => {
  it('defaults are the decided values', () => {
    expect(normalizeP2Settings(undefined)).toEqual(P2_DEFAULTS)
    expect(budgetFrom(P2_DEFAULTS)).toEqual(DEFAULT_BUDGET)
    expect(bannerSourcesFrom(P2_DEFAULTS)).toEqual(['reminder', 'resolution'])
  })
  it('clamps numbers, keeps the base for anything unreadable, drops unknown fields, caps steer at 300', () => {
    const s = normalizeP2Settings({ pings: { dailyCap: 99, perSource: 0, gapMinutes: -5, quietStart: '25:00', on: 'yes', extra: 1 }, checkin: { weekday: 9, time: '7:5' },
      reminders: { snoozeMinutes: 1 }, steer: { about: 'a'.repeat(500), leaveAlone: 'line\nbreak' }, junk: true })
    expect(s.pings).toMatchObject({ dailyCap: 20, perSource: 1, gapMinutes: 0, quietStart: '18:00', on: true })
    expect(s.checkin).toMatchObject({ weekday: 6, time: '09:00' })
    expect(s.reminders.snoozeMinutes).toBe(5)
    expect(s.steer.about).toHaveLength(300)
    expect(s.steer.leaveAlone).toBe('line break')
    expect(s).not.toHaveProperty('junk')
  })
  it('a partial save changes only what it names', () => {
    const a = mergeP2Settings(P2_DEFAULTS, { pings: { sources: { stale: false } } })
    const b = mergeP2Settings(a, { checkin: { time: '10:30' } })
    expect(b.pings.sources).toEqual({ ...P2_DEFAULTS.pings.sources, stale: false })
    expect(b.checkin).toEqual({ on: true, weekday: 1, time: '10:30' })
    expect(b.pings.dailyCap).toBe(6)
  })
  it('round-trips to a 0600 file; a missing, oversized or foreign file reads as the defaults', () => {
    const dir = tmp(), file = join(dir, 'data', 'drop-p2-settings.json')
    expect(readP2Settings(file)).toEqual(P2_DEFAULTS)
    writeP2Settings(with_({ pings: { dailyCap: 3 } }), file)
    expect(readP2Settings(file).pings.dailyCap).toBe(3)
    expect(statSync(file).mode & 0o077).toBe(0)
    writeFileSync(file, JSON.stringify({ v: 99, settings: { pings: { dailyCap: 1 } } }))
    expect(readP2Settings(file)).toEqual(P2_DEFAULTS)
    writeFileSync(file, '{not json')
    expect(readP2Settings(file)).toEqual(P2_DEFAULTS)
    const reader = createP2SettingsReader(file, 60_000)
    expect(reader.write(with_({ checkin: { on: false } })).checkin.on).toBe(false)
    expect(reader.read().checkin.on).toBe(false)  // the write updates the cache at once
  })
  it('steer words: whole words of 3 or more letters, filler left out', () => {
    expect(steerWords("Ping me about JCK, Rain and the pet report. Don't ping me about HubDB")).toEqual(['jck', 'rain', 'pet', 'report', 'hubdb'])
    expect(matchesSteer('The JCK thread went quiet', ['jck'])).toBe(true)
    expect(matchesSteer('jcktest', ['jck'])).toBe(false)
  })
})

describe('P2 settings change behavior: the budget', () => {
  const WED_10 = local('2026-11-04', '10:00')
  const one = (id: string, source = 'resolution' as const) => [{ id, source, createdAt: 0 }]
  const ledger = (times: string[], source: 'prep' | 'resolution' = 'prep'): BannerRecord[] => times.map((t, i) => ({ at: local('2026-11-04', t), sources: [source], ids: [`l${i}`] }))

  it('daily cap', () => {
    const l = ledger(['08:00', '09:00'])
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { dailyCap: 2 } }))).silent[0]?.reason).toBe('daily_cap')
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { dailyCap: 3 } }))).banners).toHaveLength(1)
  })
  it('per-source cap', () => {
    const l = ledger(['08:00'], 'resolution')
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { perSource: 1 } }))).silent[0]?.reason).toBe('source_cap')
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { perSource: 2 } }))).banners).toHaveLength(1)
  })
  it('minimum gap', () => {
    const l = ledger(['09:40'])
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { gapMinutes: 45 } }))).silent[0]?.reason).toBe('too_soon')
    expect(planBanners(one('a'), l, WED_10, TZ, ['resolution'], budgetFrom(with_({ pings: { gapMinutes: 15 } }))).banners).toHaveLength(1)
  })
  it('quiet hours start, end and weekends', () => {
    const at = (d: string, t: string) => local(d, t)
    expect(isQuietHours(at('2026-11-04', '19:00'), TZ, budgetFrom(P2_DEFAULTS))).toBe(true)
    expect(isQuietHours(at('2026-11-04', '19:00'), TZ, budgetFrom(with_({ pings: { quietStart: '21:00' } })))).toBe(false)
    expect(isQuietHours(at('2026-11-04', '06:30'), TZ, budgetFrom(with_({ pings: { quietEnd: '07:00' } })))).toBe(true)
    expect(isQuietHours(at('2026-11-07', '12:00'), TZ, budgetFrom(with_({ pings: { weekendsQuiet: false } })))).toBe(false)
    expect(isQuietHours(at('2026-11-04', '23:00'), TZ, budgetFrom(with_({ pings: { quietStart: '00:00', quietEnd: '00:00' } })))).toBe(false)  // equal: no quiet hours
    expect(isQuietHours(at('2026-11-04', '13:00'), TZ, budgetFrom(with_({ pings: { quietStart: '12:00', quietEnd: '14:00' } })))).toBe(true)  // no wrap
  })
  it('first banner time', () => {
    const t = local('2026-11-04', '07:30')
    expect(planBanners(one('a'), [], t, TZ, ['resolution'], budgetFrom(P2_DEFAULTS)).silent[0]?.reason).toBe('before_first_banner')
    expect(planBanners(one('a'), [], t, TZ, ['resolution'], budgetFrom(with_({ pings: { firstBanner: '07:00' } }))).banners).toHaveLength(1)
  })
  it('which kinds may banner, and reminder banners off', () => {
    expect(bannerSourcesFrom(with_({ banners: { prep: true, resolution: false } }))).toEqual(['reminder', 'prep'])
    expect(bannerSourcesFrom(with_({ reminders: { banners: false } }))).toEqual(['resolution'])
    const sat = local('2026-11-07', '03:00')
    expect(planBanners([{ id: 'r', source: 'reminder', createdAt: 0 }], [], sat, TZ, bannerSourcesFrom(with_({ reminders: { banners: false } }))).silent).toEqual([{ id: 'r', reason: 'source_off' }])
  })
})

describe('P2 settings change behavior: the engine and its sources', () => {
  const WED_10 = local('2026-11-04', '10:00')
  const snap = { threads: [staleThread], signals: [redSignal], intakeOpen: [{ id: 'wi_1', status: 'review', meeting: { recordId: 'r1', title: 'Huddle', domain: 'quilt' } }],
    nextEvent: { title: 'Pete 1:1', time: new Date(local('2026-11-04', '10:10')).toISOString() } }
  const keys = (h: ReturnType<typeof engine>) => [...h.feed.keys()].map(k => k.split(':')[0]).sort()

  it('the pings switch stops every polled source', async () => {
    const on = engine(P2_DEFAULTS, WED_10, snap); await on.e.tick()
    expect(keys(on)).toEqual(['followups', 'prep', 'signal', 'stale'])
    const off = engine(with_({ pings: { on: false } }), WED_10, snap); await off.e.tick()
    expect(keys(off)).toEqual([])
  })
  it('each source has its own switch', async () => {
    for (const [source, prefix] of [['prep', 'prep'], ['followups', 'followups'], ['stale', 'stale'], ['signals', 'signal']] as const) {
      const h = engine(with_({ pings: { sources: { [source]: false } } }), WED_10, snap); await h.e.tick()
      expect(keys(h), source).not.toContain(prefix)
      expect(keys(h).length, source).toBe(3)
    }
    const agentOff = engine(with_({ pings: { sources: { agent: false } } }), WED_10)
    expect(agentOff.e.pushAgent({ sessionId: 'codex:a', turnEndedAt: WED_10, label: 'x', provider: 'codex' }).posted).toBe(0)
    expect(engine(P2_DEFAULTS, WED_10).e.pushAgent({ sessionId: 'codex:a', turnEndedAt: WED_10, label: 'x', provider: 'codex' }).posted).toBe(1)
  })
  it('the check-in: on or off, its day and its time', async () => {
    const mon905 = local('2026-11-09', '09:05'), tue1035 = local('2026-11-10', '10:35')
    const k = async (s: P2Settings, now: number) => { const h = engine(s, now); await h.e.tick(); return keys(h) }
    expect(await k(P2_DEFAULTS, mon905)).toEqual(['checkin'])
    expect(await k(with_({ checkin: { on: false } }), mon905)).toEqual([])
    expect(await k(with_({ checkin: { weekday: 2, time: '10:30' } }), mon905)).toEqual([])
    expect(await k(with_({ checkin: { weekday: 2, time: '10:30' } }), tue1035)).toEqual(['checkin'])
    expect(await k(with_({ checkin: { time: '09:30' } }), mon905)).toEqual([])
  })
  it('quiet hours from settings hold work pings', async () => {
    const at1830 = local('2026-11-04', '18:30')
    const held = engine(P2_DEFAULTS, at1830, { threads: [staleThread], signals: [] }); expect((await held.e.tick()).held).toBe(1)
    const later = engine(with_({ pings: { quietStart: '21:00' } }), at1830, { threads: [staleThread], signals: [] }); expect((await later.e.tick()).posted).toBe(1)
  })
  it('Leave alone mutes a ping by its words, never a reminder or a follow-up', () => {
    const h = engine(with_({ steer: { leaveAlone: 'JCK' } }), WED_10)
    const out = h.e.push([ping('a', 'stale', 'JCK thread quiet for 14 days.'), ping('b', 'stale', 'Rain thread quiet.'), ping('r', 'reminder', 'Reminder: JCK numbers'), ping('f', 'resolution', 'Done: JCK card')])
    expect(out.posted).toBe(3)
    expect([...h.feed.keys()].sort()).toEqual(['reminder:r', 'resolution:f', 'stale:b'])
  })
  it('Ping me about lets a matching ping banner though its kind is silent; the caps still hold', () => {
    const h = engine(with_({ steer: { about: 'rain' } }), WED_10)
    h.e.push([ping('a', 'stale', 'Rain thread quiet.', 'Rain'), ping('b', 'stale', 'Pet thread quiet.', 'Pet')])
    expect(h.banners.map(b => b.line)).toEqual(['Rain thread quiet.'])
    const none = engine(P2_DEFAULTS, WED_10)
    none.e.push([ping('a', 'stale', 'Rain thread quiet.')])
    expect(none.banners).toEqual([])
  })
  it('a kind switched to banner in settings banners through the engine', () => {
    const silent = engine(P2_DEFAULTS, WED_10); silent.e.push([ping('a', 'prep', 'Pete 1:1 at 2:00 PM. Prep me?')])
    expect(silent.banners).toEqual([])
    const loud = engine(with_({ banners: { prep: true } }), WED_10); loud.e.push([ping('a', 'prep', 'Pete 1:1 at 2:00 PM. Prep me?')])
    expect(loud.banners.map(b => b.sources)).toEqual([['prep']])
  })

  it('the daily cap from settings reaches the engine', () => {
    const h = engine(with_({ pings: { dailyCap: 0 } }), WED_10)
    h.e.push([ping('f', 'resolution', 'Done.')])
    expect(h.banners).toEqual([])
  })
})

describe('P2 settings change behavior: reminders and follow-ups', () => {
  const WED_10 = local('2026-11-04', '10:00')
  it('default time: a day alone, and the two picks', () => {
    expect(parseWhen('remind me Friday', WED_10, TZ, { dayMinutes: 8 * 60 + 30 }).at).toBe(local('2026-11-06', '08:30'))
    expect(parseWhen('remind me Friday', WED_10, TZ).at).toBe(local('2026-11-06', '09:00'))
    expect(whenSuggestions(WED_10, TZ, { dayMinutes: 7 * 60 }).map(w => [w.label, w.at])).toEqual([['Tomorrow 7:00', local('2026-11-05', '07:00')], ['Monday 7:00', local('2026-11-09', '07:00')]])
  })
  it('snooze length: the button names it and the snooze uses it', () => {
    expect(reminderActions(30).find(a => a.id === 'snooze_1h')!.label).toBe('Snooze 30 minutes')
    expect(reminderActions(120).find(a => a.id === 'snooze_1h')!.label).toBe('Snooze 2 hours')
    expect(reminderActions().find(a => a.id === 'snooze_1h')!.label).toBe('Snooze 1 hour')
    const dir = tmp(), store = new DropStore(join(dir, 'drops'))
    const id = randomUUID(), at = new Date(WED_10).toISOString()
    store.insert({ id, text: 'remind me at 10am', source: 'mac', createdAt: at, updatedAt: at, state: 'filed', dest: 'reminder', kind: 'reminder', links: [], route: { by: 'rule' },
      undoUntil: null, timeline: [], remind: { at, tz: TZ, firedAt: null, ackAt: null, snoozes: 0 } } as DropRecord)
    const got: PingCandidate[] = []
    fireDueReminders(store, WED_10, c => got.push(...c), { snoozeMinutes: 30 })
    expect(got[0].actions.map(a => a.label)).toEqual(['Done', 'Snooze 30 minutes', 'Tomorrow 9'])
    store.close()
  })
  it('follow-ups: the switch and each kind', () => {
    const c = (kind: string) => ({ key: `d1:${kind}:x:complete` } as PingCandidate)
    for (const kind of ['card', 'handoff', 'session', 'thread']) {
      expect(followUpAllowed(c(kind), P2_DEFAULTS), kind).toBe(true)
      expect(followUpAllowed(c(kind), with_({ followUps: { kinds: { [kind]: false } } })), kind).toBe(false)
      expect(followUpAllowed(c(kind), with_({ followUps: { on: false } })), kind).toBe(false)
    }
  })
  it('the runtime honors follow-up kinds, lens push and reminder banners end to end', async () => {
    const dir = tmp()
    let settings = with_({ followUps: { kinds: { card: false } }, reminders: { lensPush: false } })
    const drops = new DropStore(join(dir, 'drops')), feed = new InboxFeedStore(join(dir, 'inbox')), pings = new PingStateStore(join(dir, 'pings'))
    const lens: unknown[] = []
    const rt = createDropP2Runtime({ drops, feed, pingState: pings, timezone: () => TZ, now: () => WED_10, settings: () => settings,
      board: async () => [{ id: 'abc123def456', domain: 'quilt', workIdentity: 'w1', workStage: 'complete', checked: true }], emitLens: e => lens.push(e) })
    const at = new Date(WED_10 - 3_600_000).toISOString()
    drops.insert({ id: randomUUID(), text: 'send the deck', source: 'mac', createdAt: at, updatedAt: at, state: 'filed', dest: 'new_card', kind: 'task',
      links: [{ kind: 'card', id: 'w1', label: 'Deck', domain: 'quilt' }], route: { by: 'rule' }, undoUntil: null, timeline: [] } as DropRecord)
    expect(await rt.pollOnce()).toBe(0)  // card follow-ups off
    settings = with_({ reminders: { lensPush: false } })
    expect(await rt.pollOnce()).toBe(1)
    rt.push([{ source: 'reminder', key: 'reminder:z', line: 'Reminder: z', links: [], actions: [], createdAt: WED_10 }])
    expect(lens).toEqual([])  // lens push off
    expect(rt.banners().banners.map(b => b.line)).toContain('Reminder: z')
    settings = P2_DEFAULTS
    rt.push([{ source: 'reminder', key: 'reminder:y', line: 'Reminder: y', links: [], actions: [], createdAt: WED_10 }])
    expect(lens).toHaveLength(1)
    rt.stop(); drops.close(); feed.close(); pings.close()
  })
})
