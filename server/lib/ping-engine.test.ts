import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PingEngine, PingStateStore, type PingBanner, type PingFeedSink, type PingSnapshot, type PingState } from './ping-engine.js'
import { PING_SOURCES, type PingSource } from './ping-budget.js'
import { isoWeek, type PingCandidate } from './ping-sources.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }

function fakeFeed() {
  const byKey = new Map<string, { id: string; c: PingCandidate }>()
  let n = 0
  const sink: PingFeedSink = {
    hasKey: k => byKey.has(k),
    post: c => { const hit = byKey.get(c.key); if (hit) return hit.id; const id = `f${++n}`; byKey.set(c.key, { id, c }); return id },
  }
  return { sink, byKey }
}
function memState(initial?: PingState) {
  let s: PingState = initial ?? { ledger: [], held: [], consumed: [] }
  let writes = 0
  return { store: { read: () => structuredClone(s), write: (next: PingState) => { s = structuredClone(next); writes++ } }, get: () => s, writes: () => writes }
}
function harness(opts: { now: number; snap?: PingSnapshot; enabled?: PingSource[]; state?: ReturnType<typeof memState>; feed?: ReturnType<typeof fakeFeed>; bannerThrows?: boolean }) {
  const clock = { now: opts.now }
  const state = opts.state ?? memState()
  const feed = opts.feed ?? fakeFeed()
  const banners: PingBanner[] = []
  const order: string[] = []
  const snapRef = { snap: opts.snap ?? {} as PingSnapshot }
  const engine = new PingEngine({
    state: { read: () => state.store.read(), write: (s: PingState) => { order.push('ledger'); state.store.write(s) } },
    feed: feed.sink,
    read: async () => snapRef.snap,
    banner: b => { order.push('banner'); if (opts.bannerThrows) throw new Error('notifier down'); banners.push(b) },
    now: () => clock.now, timezone: () => TZ, enabled: () => opts.enabled ?? ['reminder', 'resolution'],
  })
  return { engine, clock, state, feed, banners, order, snapRef }
}
const thread = (id: string, name: string, lastSeen: string) => ({ id, name, is_stale: true, is_resolved: false, last_seen: lastSeen })

describe('PingEngine', () => {
  it('posts a prep ping silently 15 minutes out; prep banners only when he turns it on', async () => {
    const now = local('2026-11-04', '13:46')
    const snap = { nextEvent: { title: 'Pete 1:1', time: new Date(local('2026-11-04', '14:00')).toISOString() } }
    const off = harness({ now, snap })
    expect(await off.engine.tick()).toMatchObject({ posted: 1, banners: 0 })
    expect([...off.feed.byKey.values()][0].c.line).toBe('Pete 1:1 at 2:00 PM. Prep me?')
    const on = harness({ now, snap, enabled: [...PING_SOURCES] })
    expect(await on.engine.tick()).toMatchObject({ posted: 1, banners: 1 })
    // 16 minutes out: not yet.
    expect(await harness({ now: now - 2 * 60_000, snap }).engine.tick()).toMatchObject({ posted: 0 })
  })

  it('posts each key exactly once: a second tick, and a restart on the same state and feed', async () => {
    const now = local('2026-11-04', '10:00')
    const snap = { threads: [thread('t1', 'JCK thread', '2026-10-21T12:00:00Z')], signals: [] }
    const h = harness({ now, snap })
    expect((await h.engine.tick()).posted).toBe(1)
    expect((await h.engine.tick()).posted).toBe(0)
    const again = harness({ now: now + 3_600_000, snap, state: h.state, feed: h.feed })
    expect((await again.engine.tick()).posted).toBe(0)
    expect([...h.feed.byKey.keys()]).toEqual([`stale:t1:${isoWeek(now, TZ)}`])
    // Next week the same stale thread may ping again: at most weekly.
    const nextWeek = harness({ now: now + 7 * 86_400_000, snap, state: h.state, feed: h.feed })
    expect((await nextWeek.engine.tick()).posted).toBe(1)
  })

  it('holds work pings over quiet hours and posts them as one item from 8:00, dropping what moved on', async () => {
    const evening = local('2026-11-04', '19:00')
    const snap: PingSnapshot = {
      threads: [thread('t1', 'JCK thread', '2026-10-21T12:00:00Z'), thread('t2', 'Rain promo', '2026-10-20T12:00:00Z')],
      signals: [], intakeOpen: [{ id: 'wi_1', status: 'review', meeting: { recordId: 'rec-1', title: 'Midweek Huddle', domain: 'quilt' } }],
    }
    const h = harness({ now: evening, snap, enabled: [...PING_SOURCES] })
    expect(await h.engine.tick()).toMatchObject({ posted: 0, held: 3, banners: 0 })
    expect(h.feed.byKey.size).toBe(0)  // no work ping is created in quiet hours
    // 6:30: work time, but the held items wait for 8:00. Meanwhile t2 moved on (no longer stale).
    h.clock.now = local('2026-11-05', '06:30')
    h.snapRef.snap = { ...snap, threads: [snap.threads![0]] }
    expect(await h.engine.tick()).toMatchObject({ posted: 0, released: 0 })
    h.clock.now = local('2026-11-05', '08:00')
    expect(await h.engine.tick()).toMatchObject({ posted: 1, released: 2, expired: 1, banners: 1 })
    const digest = [...h.feed.byKey.values()].map(v => v.c).find(c => c.key.startsWith('offhours:'))!
    expect(digest.title).toBe('While you were off: 2 updates')
    expect(digest.line.split('\n')).toEqual(['- 1 follow-up from Midweek Huddle.', '- JCK thread quiet for 14 days.'])
    expect(digest.needsReply).toBe(true)
    // The held keys never post again on their own.
    h.clock.now = local('2026-11-05', '10:00')
    expect((await h.engine.tick()).posted).toBe(0)
  })

  it('keeps held items when their source could not be read, instead of calling them expired', async () => {
    const h = harness({ now: local('2026-11-04', '19:00'), snap: { threads: [thread('t1', 'JCK thread', '2026-10-21T12:00:00Z')], signals: [] } })
    await h.engine.tick()
    h.clock.now = local('2026-11-05', '08:05')
    h.snapRef.snap = {}  // the thread cache could not be read
    expect(await h.engine.tick()).toMatchObject({ released: 1, expired: 0 })
  })

  it('a reminder banners at 3 AM on a Saturday; a resolution then lands silently', () => {
    const h = harness({ now: local('2026-11-07', '03:00') })
    const reminder: PingCandidate = { source: 'reminder', key: 'reminder:r1:2026-11-07T09:00:00.000Z', line: 'Reminder: call mom.', title: 'Reminder', links: [], actions: [], createdAt: h.clock.now }
    const resolution: PingCandidate = { source: 'resolution', key: 'res:d1:card:c1:Complete', line: 'Done: the JCK card moved to Complete.', links: [], actions: [], createdAt: h.clock.now }
    expect(h.engine.push([reminder, resolution])).toMatchObject({ posted: 2, held: 0, banners: 1 })
    expect(h.banners).toEqual([{ feedIds: ['f1'], sources: ['reminder'], exempt: true, title: 'Reminder', line: 'Reminder: call mom.' }])
  })

  it('writes the ledger before any banner, and a notifier failure never repeats a banner', () => {
    const h = harness({ now: local('2026-11-04', '10:00'), bannerThrows: true })
    const res: PingCandidate = { source: 'resolution', key: 'res:d1', line: 'Done.', links: [], actions: [], createdAt: 0 }
    expect(h.engine.push([res])).toMatchObject({ posted: 1, banners: 0 })
    expect(h.order).toEqual(['ledger', 'banner'])
    expect(h.state.get().ledger).toHaveLength(1)
    expect(h.engine.push([res])).toMatchObject({ posted: 0, banners: 0 })
    expect(h.order).toEqual(['ledger', 'banner'])
  })

  it('a failed source read never throws and other sources still post', async () => {
    const h = harness({ now: local('2026-11-09', '09:05') })  // Monday
    ;(h.engine as unknown as { deps: { read: () => Promise<PingSnapshot> } }).deps.read = async () => { throw new Error('bridge down') }
    expect(await h.engine.tick()).toMatchObject({ posted: 1 })  // the weekly check-in reads only the clock
    expect([...h.feed.byKey.values()][0].c).toMatchObject({ source: 'checkin', needsReply: true })
  })

  it('one source that throws on a bad snapshot never stops the others', async () => {
    const snap = { intakeOpen: { length: 1 } as unknown as PingSnapshot['intakeOpen'], threads: [thread('t1', 'JCK thread', '2026-10-21T12:00:00Z')], signals: [] }
    const h = harness({ now: local('2026-11-04', '10:00'), snap })
    expect(await h.engine.tick()).toMatchObject({ posted: 1 })
  })

  it('a thread marked resolved is never pinged as stale, even with is_stale still set', async () => {
    const snap = { threads: [{ ...thread('t1', 'JCK thread', '2026-10-21T12:00:00Z'), is_resolved: true }], signals: [] }
    expect(await harness({ now: local('2026-11-04', '10:00'), snap }).engine.tick()).toMatchObject({ posted: 0 })
  })

  it('an expired item never posts (prep after the meeting started)', () => {
    const h = harness({ now: local('2026-11-04', '14:01') })
    const late: PingCandidate = { source: 'prep', key: 'prep:x', line: 'x', links: [], actions: [], createdAt: 0, expiresAt: local('2026-11-04', '14:00') }
    expect(h.engine.push([late])).toMatchObject({ posted: 0, expired: 1 })
  })
})

describe('PingStateStore', () => {
  it('round-trips, trims, and keeps a 0700 folder with a 0600 file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-pings-'))
    try {
      const root = join(dir, 'pings')
      const now = local('2026-11-04', '10:00')
      const a = new PingStateStore(root)
      a.write({ ledger: [{ at: now, sources: ['prep'], ids: ['f1'] }, { at: now - 9 * 86_400_000, sources: ['prep'], ids: ['old'] }], held: [], consumed: [{ key: 'k', at: now }, { key: 'gone', at: now - 31 * 86_400_000 }] }, now)
      a.close()
      const b = new PingStateStore(root)
      expect(b.read()).toEqual({ ledger: [{ at: now, sources: ['prep'], ids: ['f1'] }], held: [], consumed: [{ key: 'k', at: now }] })
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(join(root, 'state.json')).mode & 0o077).toBe(0)
      b.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/**
 * Canary 9 (plan sections 5 and 8): the ping path calls no model and reaches nothing outward. Walks the real import
 * graph from each ping module (value imports only) and fails if any reachable file is an LLM, Jev, Ask, mail, Slack,
 * Telegram or calendar-write module.
 */
describe('canary 9: no LLM and nothing outward in the ping path', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const FORBIDDEN = /(?:^|\/)(?:jev|decision-provider|decision-settings|llm[-\w]*|claude[-\w]*|openai[-\w]*|anthropic[-\w]*|query-job[-\w]*|codex[-\w]*|telegram[-\w]*|mail[-\w]*|slack[-\w]*|calendar-write[-\w]*|python-bridge|work-search|drop-router)\.ts$/
  const PACKAGES_OK = /^node:/

  function graph(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>(), packages = new Set<string>()
    const walk = (file: string) => {
      if (files.has(file)) return
      files.add(file)
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
        else packages.add(spec)
      }
    }
    walk(entry)
    return { files, packages }
  }

  for (const entry of ['ping-engine.ts', 'ping-sources.ts', 'ping-budget.ts', 'drop-when.ts']) {
    it(entry, () => {
      const { files, packages } = graph(join(here, entry))
      expect(files.size).toBeGreaterThan(entry === 'ping-budget.ts' ? 1 : 2)  // the walk really followed imports
      const bad = [...files].map(f => f.slice(here.length + 1)).filter(f => FORBIDDEN.test('/' + f))
      expect(bad).toEqual([])
      expect([...packages].filter(p => !PACKAGES_OK.test(p))).toEqual([])
    })
  }

  it('the walk would catch a forbidden import (the guard can fail)', () => {
    expect(FORBIDDEN.test('/jev.ts')).toBe(true)
    expect(FORBIDDEN.test('/query-job-store.ts')).toBe(true)
    expect(FORBIDDEN.test('/telegram-notify.ts')).toBe(true)
    expect(FORBIDDEN.test('/ping-engine.ts')).toBe(false)
  })
})
