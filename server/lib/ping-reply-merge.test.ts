// 7.0.52 B (Miles 16:08 and 16:29, "Everything tonight"; the lead's 16:33 rulings on X1's read): with mergeReplies on, Reply ready
// pings banner as ONE merged banner at most once per gapMinutes, not counted against the daily or per-source caps (Miles's call);
// quiet hours and the first banner hold; held replies are persisted and counted by distinct session; an item purged from the chat is
// dropped at release (zero left: no banner); "stopped on", finished and reminders are never held. Off by default; off is today's
// behaviour. Not tonight (the lead, 16:42): a re-check against the session's state; a named 7.0.53 follow-up.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PING_STATE_LIMITS, PingEngine, PingStateStore, REPLY_MIN_GAP_MS, replyStillNewFromSignal, type HeldReply, type PingBanner, type PingFeedSink, type PingState } from './ping-engine.js'
import { agentCandidate, type PingCandidate } from './ping-sources.js'
import { normalizeP2Settings, P2_DEFAULTS, type P2Settings } from './drop-p2-settings.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const at = (hhmm: string, day = '2026-11-17') => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }   // a Tuesday
const A = 'aa000000-0000-0000-0000-00000000000a', B = 'bb000000-0000-0000-0000-00000000000b', C = 'cc000000-0000-0000-0000-00000000000c'
const reply = (sessionId: string, when: number, provider = 'claude') => agentCandidate({ provider, sessionId, turnEndedAt: when, replyReady: true })!
const on = (over: Record<string, unknown> = {}) => normalizeP2Settings({ pings: { mergeReplies: true, gapMinutes: 45, ...over }, banners: { agent: true } })

function rig(settings: P2Settings, stillNew?: (r: HeldReply) => boolean) {
  let state: PingState = { ledger: [], held: [], consumed: [] }
  let n = 0
  const keys = new Set<string>()
  const feed: PingFeedSink = { hasKey: k => keys.has(k), post: c => { keys.add(c.key); return `f${++n}` } }
  const purge = (c: PingCandidate) => { keys.delete(c.key) }
  const clock = { now: at('10:00') }
  const shown: PingBanner[] = [], phone: PingBanner[] = []
  let set = settings
  const engine = new PingEngine({
    state: { read: () => structuredClone(state), write: s => { state = structuredClone(s) } }, feed, read: async () => ({}),
    banner: b => { shown.push(b) }, phoneBanner: b => { phone.push(b) }, now: () => clock.now, timezone: () => TZ, settings: () => set,
    ...(stillNew ? { replyStillNew: stillNew } : {}),
  })
  const push = (when: string, ...cs: PingCandidate[]) => { clock.now = at(when); return engine.push(cs) }
  const tick = async (when: string) => { clock.now = at(when); return engine.tick() }
  return { engine, push, tick, shown, phone, purge, state: () => state, setSettings: (s: P2Settings) => { set = s } }
}

describe('mergeReplies off (the default): today\'s behaviour', () => {
  it('defaults to off; a second reply inside the gap is silent, and nothing waits', async () => {
    expect(P2_DEFAULTS.pings.mergeReplies).toBe(false)
    const r = rig(normalizeP2Settings({ banners: { agent: true } }))
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:10', reply(B, at('10:10')))
    await r.tick('11:00')
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0]).toMatchObject({ title: 'Reply ready', line: 'Claude has a reply ready.' })
    expect('replies' in r.state()).toBe(false)
    expect(r.state().ledger.every(b => !('replies' in b))).toBe(true)
  })
})

describe('mergeReplies on', () => {
  it('the first reply banners at once; later ones wait and release as ONE banner when the gap ends, by distinct session', async () => {
    const r = rig(on())
    r.push('10:00', reply(A, at('10:00')))
    expect(r.shown).toEqual([expect.objectContaining({ title: 'Reply ready', line: 'Claude has a reply ready.', replies: true, sessions: [{ id: A, provider: 'claude' }] })])
    r.push('10:10', reply(B, at('10:10'), 'codex'))
    r.push('10:20', reply(C, at('10:20')))
    r.push('10:30', reply(B, at('10:30'), 'codex'))
    expect(r.shown).toHaveLength(1)
    expect(r.state().replies?.map(h => h.sessionId)).toEqual([B, C, B])
    await r.tick('10:44')
    expect(r.shown).toHaveLength(1)
    await r.tick('10:45')
    expect(r.shown).toHaveLength(2)
    expect(r.shown[1]).toEqual({ feedIds: ['f2', 'f3', 'f4'], sources: ['agent'], exempt: false, replies: true,
      sessions: [{ id: B, provider: 'codex' }, { id: C, provider: 'claude' }], title: '2 sessions replied', line: '2 sessions have a reply ready.' })
    expect(r.phone[1]).toEqual(r.shown[1])
    expect(r.state().replies).toBeUndefined()
    expect(r.state().ledger.at(-1)).toMatchObject({ at: at('10:45'), replies: true, ids: ['f2', 'f3', 'f4'] })
    await r.tick('11:29')
    expect(r.shown).toHaveLength(2)
  })
  it('never more often than once per REPLY_MIN_GAP_MS, even with gapMinutes 0; a longer gap he sets still wins', async () => {
    expect(REPLY_MIN_GAP_MS).toBe(45 * 60_000)
    const floorMin = REPLY_MIN_GAP_MS / 60_000
    const hhmm = (min: number) => `${String(10 + Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
    const zero = rig(on({ gapMinutes: 0 }))
    zero.push('10:00', reply(A, at('10:00')))
    zero.push('10:01', reply(B, at('10:01')))
    await zero.tick(hhmm(floorMin - 1))
    expect(zero.shown).toHaveLength(1)
    await zero.tick(hhmm(floorMin))
    expect(zero.shown).toHaveLength(2)
    const long = rig(on({ gapMinutes: 240 }))
    long.push('10:00', reply(A, at('10:00')))
    long.push('10:01', reply(B, at('10:01')))
    await long.tick(hhmm(floorMin))
    await long.tick('13:59')
    expect(long.shown).toHaveLength(1)
    await long.tick('14:00')
    expect(long.shown).toHaveLength(2)
  })
  it('the gap counts from the last merged reply banner only, not from a banner of another kind', async () => {
    const r = rig(on())
    const resolution: PingCandidate = { source: 'resolution', key: 'res:1', line: 'Your drop is done.', links: [], actions: [], createdAt: at('10:30') }
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:30', resolution)
    r.push('10:31', reply(B, at('10:31')))
    expect(r.shown.map(b => b.sources[0])).toEqual(['agent', 'resolution'])
    await r.tick('10:45')
    expect(r.shown).toHaveLength(3)
    expect(r.shown[2]).toMatchObject({ replies: true, sessions: [{ id: B, provider: 'claude' }] })
  })
  it('one session replying twice in the gap: "Reply ready" with its newest line', async () => {
    const r = rig(on())
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:05', reply(B, at('10:05'), 'cursor'))
    r.push('10:06', reply(B, at('10:06'), 'cursor'))
    await r.tick('10:45')
    expect(r.shown[1]).toMatchObject({ title: 'Reply ready', line: 'Cursor has a reply ready.', sessions: [{ id: B, provider: 'cursor' }], feedIds: ['f2', 'f3'] })
  })
  it('not counted against the daily cap, the per-source cap or the other sources\' gap; those still hold for the others', () => {
    const r = rig(on({ dailyCap: 1, perSource: 1 }))
    const resolution = (key: string, when: number): PingCandidate => ({ source: 'resolution', key, line: 'Your drop is done.', links: [], actions: [], createdAt: when })
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:00', resolution('res:1', at('10:00')))   // same minute: neither the cap of 1 nor the gap counts the reply banner
    expect(r.shown.map(b => b.sources[0])).toEqual(['agent', 'resolution'])
    r.push('11:00', resolution('res:2', at('11:00')))   // the cap of 1 is the resolution's own
    expect(r.shown).toHaveLength(2)
    r.push('11:00', reply(B, at('11:00')))              // a second reply banner the same day, past the cap and per source 1
    expect(r.shown).toHaveLength(3)
    expect(r.shown[2]).toMatchObject({ replies: true, sessions: [{ id: B, provider: 'claude' }] })
  })
  it('finished, "stopped on" and reminders never wait', () => {
    const r = rig(on())
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:01', agentCandidate({ provider: 'claude', sessionId: B, turnEndedAt: at('10:01'), label: 'Build', failed: true })!)
    r.push('10:02', { source: 'reminder', key: 'reminder:x', line: 'Call Sam', links: [], actions: [], createdAt: at('10:02') })
    expect(r.state().replies).toBeUndefined()
    // The failed item goes through the budget at once (the merged reply banner is not counted, so it is not "too soon"), and the
    // reminder banners as always: neither waits in the merged queue.
    expect(r.shown.map(b => b.line)).toEqual(['Claude has a reply ready.', 'Claude stopped on Build. It needs a look.', 'Call Sam'])
    expect(r.shown[1].replies).toBeUndefined()
  })
  it('agent banners switched off: replies are not held (silent, as the source switch says)', () => {
    const r = rig(normalizeP2Settings({ pings: { mergeReplies: true }, banners: { agent: false } }))
    r.push('10:00', reply(A, at('10:00')))
    expect(r.shown).toHaveLength(0)
    expect(r.state().replies).toBeUndefined()
  })
  it('quiet hours: what waited is dropped with no banner, now or in the morning; a reply in quiet hours goes to the morning item', async () => {
    const r = rig(on())
    r.push('17:40', reply(A, at('17:40')))
    r.push('17:50', reply(B, at('17:50')))
    expect(r.state().replies).toHaveLength(1)
    await r.tick('18:01')
    expect(r.state().replies).toBeUndefined()
    r.push('19:00', reply(C, at('19:00')))
    expect(r.state().replies).toBeUndefined()
    expect(r.state().held.map(h => h.key)).toContain(reply(C, at('19:00')).key)
    expect(r.shown).toHaveLength(1)
  })
  it('the first banner of the day waits for firstBanner (08:00), and the gap from yesterday has long passed', async () => {
    const r = rig(on())
    r.push('06:30', reply(A, at('06:30')))
    expect(r.shown).toHaveLength(0)
    await r.tick('07:59')
    expect(r.shown).toHaveLength(0)
    await r.tick('08:00')
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0]).toMatchObject({ title: 'Reply ready', sessions: [{ id: A, provider: 'claude' }] })
  })
  it('at release an item purged from the chat is dropped; none left means no banner and no ledger record', async () => {
    const r = rig(on())
    const b1 = reply(B, at('10:10')), c1 = reply(C, at('10:20')), a2 = reply(A, at('11:00'))
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:10', b1)
    r.push('10:20', c1)
    r.purge(b1)
    await r.tick('10:45')
    expect(r.shown[1]).toMatchObject({ title: 'Reply ready', sessions: [{ id: C, provider: 'claude' }], feedIds: ['f3'] })
    r.push('11:00', a2)
    r.purge(a2)
    await r.tick('11:30')
    expect(r.shown).toHaveLength(2)
    expect(r.state().replies).toBeUndefined()
    expect(r.state().ledger.filter(b => b.replies)).toHaveLength(2)   // no record for a banner that was not shown
  })
  it('7.0.53 re-check at release: a session no longer news is dropped; none left means no banner; a throwing check keeps them', async () => {
    let stale = new Set<string>([B])
    const r = rig(on(), h => !stale.has(h.sessionId))
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:10', reply(B, at('10:10')))
    r.push('10:20', reply(C, at('10:20')))
    await r.tick('10:45')
    expect(r.shown[1]).toMatchObject({ title: 'Reply ready', sessions: [{ id: C, provider: 'claude' }], feedIds: ['f3'] })
    r.push('11:00', reply(A, at('11:00')))
    stale = new Set([A])
    await r.tick('11:30')
    expect(r.shown).toHaveLength(2)
    expect(r.state().replies).toBeUndefined()
    expect(r.state().ledger.filter(b => b.replies)).toHaveLength(2)
    const t = rig(on(), () => { throw new Error('signal store unreadable') })
    t.push('10:00', reply(A, at('10:00')))
    expect(t.shown).toHaveLength(1)
  })
  it('switched off while replies wait: they are dropped (they are in the chat), and no merged banner follows', async () => {
    const r = rig(on())
    r.push('10:00', reply(A, at('10:00')))
    r.push('10:10', reply(B, at('10:10')))
    r.setSettings(normalizeP2Settings({ banners: { agent: true } }))
    await r.tick('11:00')
    expect(r.state().replies).toBeUndefined()
    expect(r.shown).toHaveLength(1)
  })
})

describe('what is kept on disk', () => {
  const roots: string[] = []
  afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const store = () => { const d = mkdtempSync(join(tmpdir(), 'ping-replies-')); roots.push(d); return { d, s: new PingStateStore(join(d, 'pings')) } }
  it('held replies and the merged ledger mark survive a restart; at most PING_STATE_LIMITS.replies, the newest', () => {
    const { d, s } = store()
    const replies: HeldReply[] = Array.from({ length: PING_STATE_LIMITS.replies + 44 }, (_, i) => ({ feedId: `f${i}`, key: `agent:s${i}:${i}`, sessionId: `s${i}`, provider: 'codex', at: at('10:00') + i, line: 'Codex has a reply ready.' }))
    s.write({ ledger: [{ at: at('10:00'), sources: ['agent'], ids: ['f0'], replies: true }], held: [], consumed: [], replies }, at('10:00'))
    s.close()
    const again = new PingStateStore(join(d, 'pings'))
    const back = again.read()
    expect(back.replies).toHaveLength(PING_STATE_LIMITS.replies)
    expect(back.replies![0].feedId).toBe('f44')
    expect(back.replies!.at(-1)).toEqual(replies.at(-1))
    expect(back.ledger[0].replies).toBe(true)
    again.close()
  })
  it('with nothing waiting, the file carries no replies field (byte-identical to before while off)', () => {
    const { d, s } = store()
    s.write({ ledger: [], held: [], consumed: [] }, at('10:00'))
    s.close()
    const files = ['state.json']
    expect(JSON.parse(readFileSync(join(d, 'pings', files[0]), 'utf8'))).toEqual({ version: 1, ledger: [], held: [], consumed: [] })
  })
})

describe('7.0.53: the re-check, from the session\'s hook signal and open asks', () => {
  const r = { at: 1_000 }
  const sig = (over: Record<string, unknown> = {}) => ({ ended: null, turnStartedAt: null, waiting: null, failure: null, ...over }) as Parameters<typeof replyStillNewFromSignal>[0]
  it('still news only when nothing happened since the reply', () => {
    expect(replyStillNewFromSignal(sig(), r, false)).toBe(true)
    expect(replyStillNewFromSignal(sig({ turnStartedAt: 999 }), r, false)).toBe(true)
    expect(replyStillNewFromSignal(sig({ turnStartedAt: 1_000 }), r, false)).toBe(true)
    expect(replyStillNewFromSignal(sig({ failure: { kind: 'x', at: 999 } }), r, false)).toBe(true)   // an older failure, before this reply
  })
  it('gone, ended, answered, waiting, failed after the reply, or asking: not news', () => {
    expect(replyStillNewFromSignal(undefined, r, false)).toBe(false)
    expect(replyStillNewFromSignal(sig({ ended: { at: 900, reason: 'x' } }), r, false)).toBe(false)
    expect(replyStillNewFromSignal(sig({ turnStartedAt: 1_001 }), r, false)).toBe(false)
    expect(replyStillNewFromSignal(sig({ waiting: { kind: 'permission', since: 500 } }), r, false)).toBe(false)
    expect(replyStillNewFromSignal(sig({ failure: { kind: 'x', at: 1_001 } }), r, false)).toBe(false)
    expect(replyStillNewFromSignal(sig(), r, true)).toBe(false)
  })
})
