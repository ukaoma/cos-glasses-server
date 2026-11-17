// 7.0.53 item 1 (W1's Reply ready row; the lead 20:5x): a Reply ready feed item names its session (the cleaned, exact-id title as the
// link label), carries the turn's reply as plain text (excerpt, at most DROP_LIMITS.excerpt) and the turn's end (turnAt), and G3
// groups one live item per session (count, earlier; the older one is marked superseded, never deleted, and the feed route leaves it
// out). title, line and the 'Session' fallback stay as they were. X1's rule: the excerpt is UI data only and never reaches a
// timeline crumb, the quiet-hours digest, a banner, phone words or a prompt.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentCandidate, digestCandidate, type PingCandidate } from './ping-sources.js'
import { DROP_LIMITS, DropStore, InboxFeedStore, parseFeedItem, type FeedItem } from './drop-store.js'
import { feedSink, replyGroupOf, toFeedItem } from './ping-feed-sink.js'
import { DropService } from './drop-service.js'
import { DropRouter } from './drop-router.js'
import { fakeWriters, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'
import { PingEngine, type PingBanner, type PingState } from './ping-engine.js'
import { bannerPayload } from './web-push-sender.js'
import { TimelineStore, TimelineSweeper } from './cos-thread-timeline.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const WORK = taskInstant('2026-11-17', 10 * 60, TZ)
const A = 'aa000000-0000-0000-0000-00000000000a', B = 'bb000000-0000-0000-0000-00000000000b'
const SECRET = 'PRIVATE-REPLY-TEXT'
const reply = (sessionId: string, at: number, text = `${SECRET} ${at}`, title: unknown = 'Pricing page') =>
  agentCandidate({ provider: 'claude', sessionId, turnEndedAt: at, replyReady: true, title, reply: text })!

const roots: string[] = []
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'reply-feed-')); roots.push(d); return d }

describe('the Reply ready candidate', () => {
  it('keeps title, line and the fallback label as before; adds the cleaned title as label, the excerpt and turnAt', () => {
    const c = reply(A, WORK, 'Done.\n\n**Bold** `code` here', ' The **pricing** page\u202e ')
    expect(c.title).toBe('Reply ready')
    expect(c.line).toBe('Claude has a reply ready.')
    expect(c.links).toEqual([{ kind: 'session', id: A, label: 'The pricing page', provider: 'claude' }])
    expect(c.excerpt).toBe('Done. Bold code here')
    expect(c.turnAt).toBe(new Date(WORK).toISOString())
    const bare = agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, replyReady: true })!
    expect(bare.links[0].label).toBe('Session')
    expect('excerpt' in bare).toBe(false)
  })
  it('the excerpt is cut to DROP_LIMITS.excerpt code points; a finished or stopped item gets neither excerpt nor turnAt', () => {
    expect(Array.from(reply(A, WORK, 'x'.repeat(DROP_LIMITS.excerpt + 50)).excerpt!)).toHaveLength(DROP_LIMITS.excerpt)
    const done = agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, label: 'Build', title: 'T', reply: 'R' })!
    expect(done).not.toHaveProperty('excerpt')
    expect(done).not.toHaveProperty('turnAt')
    expect(done.links[0].label).toBe('Build')
  })
})

describe('parseFeedItem keeps the new fields only when they fit, and never throws for them', () => {
  const base = () => ({ ...toFeedItem(reply(A, WORK), WORK) })
  it('valid ones survive a round trip', () => {
    const raw = { ...base(), count: 3, earlier: [{ at: new Date(WORK).toISOString(), excerpt: 'older' }], superseded: true }
    const item = parseFeedItem(raw)
    expect(item).toMatchObject({ excerpt: `${SECRET} ${WORK}`, turnAt: new Date(WORK).toISOString(), count: 3, earlier: [{ excerpt: 'older' }], superseded: true })
  })
  it('a value that does not fit is dropped, and the item stays', () => {
    const raw = { ...base(), excerpt: 'x'.repeat(DROP_LIMITS.excerpt + 1), turnAt: 'soon', count: 1.5, superseded: 'yes',
      earlier: [{ at: 'never', excerpt: 'a' }, { at: new Date(WORK).toISOString(), excerpt: 7 }, ...Array.from({ length: 9 }, (_, i) => ({ at: new Date(WORK + i).toISOString(), excerpt: `e${i}` }))] }
    const item = parseFeedItem(raw)
    expect(item).not.toHaveProperty('excerpt')
    expect(item).not.toHaveProperty('turnAt')
    expect(item).not.toHaveProperty('count')
    expect(item).not.toHaveProperty('superseded')
    expect(item.earlier?.map(e => e.excerpt)).toEqual(['e0', 'e1', 'e2'])   // the first DROP_LIMITS.earlier entries, the bad ones left out
    expect(parseFeedItem({ ...base(), count: 0 })).not.toHaveProperty('count')
    expect(parseFeedItem({ ...base(), excerpt: 'x'.repeat(DROP_LIMITS.excerpt) }).excerpt).toHaveLength(DROP_LIMITS.excerpt)
  })
})

describe('G3: one live Reply ready per session', () => {
  const store = () => new InboxFeedStore(join(tmp(), 'inbox'), () => new Date(WORK))
  it('a second reply carries the first; a third carries both, newest first; another session is its own', () => {
    const feed = store(), sink = feedSink(feed, () => WORK)
    const a1 = sink.post(reply(A, WORK, 'one')), a2 = sink.post(reply(A, WORK + 1, 'two')), b1 = sink.post(reply(B, WORK + 2, 'bee')), a3 = sink.post(reply(A, WORK + 3, 'three'))
    const by = (id: string) => feed.get(id)!
    expect(by(a1).superseded).toBe(true)
    expect(by(a2)).toMatchObject({ superseded: true, count: 2, earlier: [{ excerpt: 'one' }] })
    expect(by(a3)).toMatchObject({ count: 3, earlier: [{ excerpt: 'two' }, { excerpt: 'one' }] })
    expect(by(a3)).not.toHaveProperty('superseded')
    expect(by(b1)).toMatchObject({ count: 1 })
    expect(by(b1)).not.toHaveProperty('earlier')
    expect(feed.list()).toHaveLength(4)   // never deleted
    feed.close()
  })
  it('earlier keeps at most DROP_LIMITS.earlier; a repeated key changes nothing', () => {
    const feed = store(), sink = feedSink(feed, () => WORK)
    const ids = Array.from({ length: DROP_LIMITS.earlier + 3 }, (_, i) => sink.post(reply(A, WORK + i, `r${i}`)))
    const last = feed.get(ids.at(-1)!)!
    expect(last.count).toBe(DROP_LIMITS.earlier + 3)
    expect(last.earlier).toHaveLength(DROP_LIMITS.earlier)
    expect(last.earlier![0].excerpt).toBe(`r${DROP_LIMITS.earlier + 1}`)
    expect(sink.post(reply(A, WORK + DROP_LIMITS.earlier + 2, 'again'))).toBe(ids.at(-1))
    expect(feed.get(ids.at(-1)!)!.superseded).toBeUndefined()
    feed.close()
  })
  it('his older items (no turnAt) are never grouped or marked; one he answered (done) starts a new count', () => {
    const feed = store(), sink = feedSink(feed, () => WORK)
    const old = toFeedItem(reply(A, WORK - 10), WORK - 10)
    delete (old as Partial<FeedItem>).turnAt; delete (old as Partial<FeedItem>).excerpt
    const [oldItem] = feed.insert([old])
    expect(replyGroupOf(oldItem)).toBeNull()
    const a1 = sink.post(reply(A, WORK, 'one'))
    expect(feed.get(oldItem.id)!.superseded).toBeUndefined()
    expect(feed.get(a1)!.count).toBe(1)
    feed.update(new Set([a1]), i => ({ ...i, state: 'done' }))
    const a2 = sink.post(reply(A, WORK + 1, 'two'))
    expect(feed.get(a2)).toMatchObject({ count: 1 })
    expect(feed.get(a1)!.superseded).toBeUndefined()
    feed.close()
  })
  it('without list and update (an older caller), nothing is grouped', () => {
    const feed = store()
    const sink = feedSink({ byKey: k => feed.byKey(k), insert: i => feed.insert(i) }, () => WORK)
    const a1 = sink.post(reply(A, WORK)), a2 = sink.post(reply(A, WORK + 1))
    expect(feed.get(a1)!.superseded).toBeUndefined()
    expect(feed.get(a2)!.count).toBeUndefined()
    feed.close()
  })
})

describe('GET /api/inbox/feed (DropService.feed) leaves superseded items out', () => {
  it('only the newest per session is listed; an `after` naming a superseded item still pages on', () => {
    const root = tmp(), now = () => new Date(WORK)
    const drops = new DropStore(join(root, 'drops'), now), feed = new InboxFeedStore(join(root, 'inbox'), now)
    const service = new DropService({ drops, feed, router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }), writers: fakeWriters(), now, timezone: () => TZ })
    const sink = feedSink(feed, () => WORK)
    const a1 = sink.post(reply(A, WORK, 'one')), b1 = sink.post(reply(B, WORK + 1, 'bee')), a2 = sink.post(reply(A, WORK + 2, 'two'))
    expect(service.feed().items.map(i => i.id)).toEqual([b1, a2])
    expect(service.feed({ after: a1 }).items.map(i => i.id)).toEqual([b1, a2])
    expect(service.feed({ limit: 1 })).toMatchObject({ items: [{ id: a2 }], more: true })
    drops.close(); feed.close()
  })
})

describe('X1: the excerpt never leaves the item', () => {
  const withExcerpt = (): FeedItem => parseFeedItem(toFeedItem(reply(A, WORK), WORK))
  it('the COS thread timeline crumb (the one feed path into a prompt) is title or line, never the excerpt', () => {
    const dir = tmp(), store = new TimelineStore(dir, () => WORK)
    const sweeper = new TimelineSweeper(store, dir, { feed: () => [withExcerpt()] } as never, () => '2026-11-17')
    sweeper.sweep()
    expect(store.crumbs.length).toBeGreaterThan(0)
    expect(JSON.stringify(store.crumbs)).not.toContain(SECRET)
  })
  it('the quiet-hours digest, the Mac banner and the phone words carry no excerpt', () => {
    const held: PingCandidate[] = [reply(A, WORK), reply(B, WORK + 1)]
    expect(JSON.stringify(digestCandidate(held, WORK, TZ))).not.toContain(SECRET)
    let state: PingState = { ledger: [], held: [], consumed: [] }
    let n = 0
    const keys = new Set<string>(), shown: PingBanner[] = []
    new PingEngine({ state: { read: () => structuredClone(state), write: s => { state = structuredClone(s) } },
      feed: { hasKey: k => keys.has(k), post: c => { keys.add(c.key); return `f${++n}` } }, read: async () => ({}),
      banner: b => { shown.push(b) }, now: () => WORK, timezone: () => TZ, enabled: () => ['agent'] }).push([reply(A, WORK)])
    expect(shown).toHaveLength(1)
    expect(JSON.stringify(shown)).not.toContain(SECRET)
    const phone = bannerPayload(shown[0], 'https://mac-x1.example-tailnet.ts.net:3143', true, () => 'Title').toString()
    expect(phone).not.toContain(SECRET)
  })
})
