/**
 * 6.99.10 (Drop it plan section 12): `waiting` on GET /api/inbox/summary. What waits on you (a live question, a live
 * item marked needsReply, and Work items in Your move) clears only when answered, done or dismissed. Unread clears on
 * open. COS Control 0.5.371's badge reads `waiting` by that exact name, as a plain whole number.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DropStore, InboxFeedStore, parseFeedItem, type FeedItem } from './drop-store.js'
import { DropRouter } from './drop-router.js'
import { DropService, isWaiting } from './drop-service.js'
import { fakeWriters, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'
import { createDropsRouter, YOUR_MOVE_WAIT_MS } from '../routes/drops.js'
import { countYourMove, createYourMoveCounter } from './your-move-count.js'
import { readWorkJournal } from './work-activity.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'drop-waiting-'))
  const drops = new DropStore(join(root, 'drops')), feed = new InboxFeedStore(join(root, 'inbox'))
  const service = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }) })
  cleanup.push(() => { drops.close(); feed.close(); rmSync(root, { recursive: true, force: true }) })
  return { service, feed }
}
let pings = 0
function ping(feed: InboxFeedStore, patch: Partial<FeedItem> = {}): FeedItem {
  const n = ++pings
  const [item] = feed.insert([{ id: `fi_${n.toString(16).padStart(32, '0')}`, kind: 'ping', threadId: `ping-${n}`, createdAt: new Date().toISOString(),
    readAt: null, source: 'cos', line: 'Pete 1:1 at 2:00. Prep me?', links: [], actions: [{ id: 'open', label: 'Open' }], state: 'live', key: `ping:${n}`, ...patch }])
  return item
}
// "Call Dale about the Kickoff deck" is a scripted ask in the replay fixtures (one question with three choices).
const ASKS = 'Call Dale about the Kickoff deck'

describe('waiting in the service', () => {
  it('counts a live question, keeps it through Mark read, and clears it when it is answered', async () => {
    const h = harness()
    expect(h.service.summary()).toMatchObject({ unread: 0, waiting: 0 })
    const asked = await h.service.submit({ dropId: randomUUID(), text: ASKS, source: 'web' })
    expect(asked.drop.state).toBe('asking')
    expect(h.service.summary()).toMatchObject({ unread: 1, waiting: 1 })
    // Opening the chat clears unread only.
    const read = h.service.markRead(asked.items.at(-1)!.id)
    expect(read).toMatchObject({ unread: 0, waiting: 1 })
    expect(h.service.summary()).toMatchObject({ unread: 0, waiting: 1 })
    const question = asked.items.find(i => i.kind === 'question')!
    await h.service.choose(question.id, asked.drop.choices![0].id)
    expect(h.service.summary()).toMatchObject({ waiting: 0 })
  })

  it('a question undone stops waiting', async () => {
    const h = harness()
    const asked = await h.service.submit({ dropId: randomUUID(), text: ASKS, source: 'mac' })
    expect(h.service.summary().waiting).toBe(1)
    await h.service.undo(asked.drop.id)
    expect(h.service.summary().waiting).toBe(0)
  })

  it('a filed drop, its receipt and a plain ping never wait; a needsReply ping waits until dismissed', async () => {
    const h = harness()
    await h.service.submit({ dropId: randomUUID(), text: 'Draft the onboarding email sequence for new liquor stores', source: 'web' })
    const plain = ping(h.feed)
    expect(h.service.summary()).toMatchObject({ unread: 1, waiting: 0 })
    const asks = ping(h.feed, { needsReply: true })
    expect(h.service.summary()).toMatchObject({ unread: 2, waiting: 1 })
    h.service.markRead(asks.id)
    expect(h.service.summary()).toMatchObject({ unread: 0, waiting: 1 })
    expect(() => h.service.dismiss(plain.id)).toThrow(expect.objectContaining({ code: 'not_dismissable', status: 409 }))
    expect(h.service.dismiss(asks.id)).toMatchObject({ waiting: 0 })
    expect(h.service.dismiss(asks.id)).toMatchObject({ waiting: 0 })  // idempotent
    expect(h.feed.get(asks.id)).toMatchObject({ state: 'done', actions: [] })
    expect(() => h.service.dismiss('fi_' + 'f'.repeat(32))).toThrow(expect.objectContaining({ code: 'feed_item_not_found' }))
  })

  it('a done item marked needsReply does not wait, and needsReply survives a reopen of the store', async () => {
    const h = harness()
    ping(h.feed, { needsReply: true, state: 'done', actions: [] })
    const live = ping(h.feed, { needsReply: true })
    expect(h.service.summary().waiting).toBe(1)
    expect(h.feed.get(live.id)!.needsReply).toBe(true)
  })

  it('needsReply is kept only as a real boolean; an old row without it parses and does not wait', () => {
    const base = { id: 'fi_' + 'c'.repeat(32), kind: 'ping', threadId: 'ping-x', createdAt: new Date().toISOString(), readAt: null, source: 'cos',
      line: 'x', links: [], actions: [], state: 'live', key: 'ping:x' }
    expect(parseFeedItem(base)).not.toHaveProperty('needsReply')
    expect(isWaiting(parseFeedItem(base))).toBe(false)
    expect(parseFeedItem({ ...base, needsReply: true }).needsReply).toBe(true)
    expect(parseFeedItem({ ...base, needsReply: false }).needsReply).toBe(false)
    for (const junk of ['true', 1, null, {}, []]) expect(parseFeedItem({ ...base, needsReply: junk }), String(junk)).not.toHaveProperty('needsReply')
    expect(isWaiting(parseFeedItem({ ...base, needsReply: true }))).toBe(true)
    expect(isWaiting(parseFeedItem({ ...base, needsReply: true, state: 'done' }))).toBe(false)
    expect(isWaiting(parseFeedItem({ ...base, needsReply: false }))).toBe(false)
    const h = harness()
    ping(h.feed, { needsReply: false })
    expect(h.service.summary().waiting).toBe(0)
  })

  it('adds Work items in Your move, and only a sane whole number', () => {
    const h = harness()
    ping(h.feed, { needsReply: true })
    expect(h.service.summary({ yourMove: 3 }).waiting).toBe(4)
    for (const bad of [null, undefined, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(h.service.summary({ yourMove: bad as number }).waiting).toBe(1)
  })
})

describe('waiting on the routes', () => {
  async function serve(yourMove?: () => Promise<number | null>) {
    const h = harness()
    const app = express(); app.use(express.json())
    app.use('/api', createDropsRouter({ enabled: () => true, service: () => h.service, ...(yourMove ? { yourMove } : {}) }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
    const get = (p: string) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() as any }))
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() as any }))
    return { ...h, get, post }
  }

  it('the summary carries waiting as a plain integer, with Work counted in', async () => {
    const s = await serve(async () => 2)
    expect((await s.get('/inbox/summary')).body).toMatchObject({ unread: 0, waiting: 2 })
    const asks = ping(s.feed, { needsReply: true })
    const sum = (await s.get('/inbox/summary')).body
    expect(sum.waiting).toBe(3)
    expect(Number.isInteger(sum.waiting)).toBe(true)
    // Mark read clears unread, not waiting; its answer counts Work too.
    expect((await s.post('/inbox/read', { through: asks.id })).body).toMatchObject({ unread: 0, waiting: 3 })
    expect((await s.post('/inbox/action', { itemId: asks.id, action: 'dismiss' })).body).toMatchObject({ waiting: 2 })
    expect((await s.get('/inbox/summary')).body.waiting).toBe(2)
  })

  it('without a Work count, or when it fails, waiting counts the chat alone and the summary still answers', async () => {
    for (const yourMove of [undefined, async () => null, async () => { throw new Error('board down') }]) {
      const s = await serve(yourMove)
      ping(s.feed, { needsReply: true })
      const res = await s.get('/inbox/summary')
      expect(res.status).toBe(200)
      expect(res.body.waiting).toBe(1)
    }
  })

  it('a Work count that hangs is waited on for a bounded time only', async () => {
    const s = await serve(() => new Promise<number>(() => {}))
    ping(s.feed, { needsReply: true })
    const started = Date.now()
    const res = await s.get('/inbox/summary')
    expect(res.body.waiting).toBe(1)
    expect(Date.now() - started).toBeLessThan(YOUR_MOVE_WAIT_MS + 1_000)
  })

  it('dismiss on something that does not wait is refused', async () => {
    const s = await serve()
    const plain = ping(s.feed)
    expect(await s.post('/inbox/action', { itemId: plain.id, action: 'dismiss' })).toMatchObject({ status: 409, body: { error: { code: 'not_dismissable' } } })
  })
})

describe('Your move count', () => {
  const nowMs = 1_790_100_000_000, nowS = nowMs / 1000
  const id = (n: number) => n.toString(16).padStart(12, '0')
  const row = (n: number) => ({ id: id(n), domain: 'business', title: `Board ${n}`, text: `Board text ${n}`, workIdentity: id(n), meetingRefs: [] })
  const receipt = (n: number, status: string) => ({ id: `r${n}`, workID: `task:business:${id(n)}`, workTitle: 'T', sourceRevision: 'r', mode: 'continueSession', provider: 'codex',
    modelID: 'codex-frontier', sessionID: 'codex:owned', sessionTitle: 'S', status, detail: '', prompt: '', result: '', createdAt: nowS - n * 60 })
  function journal(receipts: unknown[]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'your-move-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const journalPath = join(root, 'handoffs.json')
    writeFileSync(journalPath, JSON.stringify({ version: 2, receipts, sessions: [], drafts: [] }), { mode: 0o600 })
    return readWorkJournal({ journalPath })
  }

  it('counts what waits on you and leaves out what is still running', () => {
    const j = journal([receipt(1, 'running'), receipt(2, 'failed'), receipt(3, 'unknown'), receipt(4, 'queued')])
    expect(countYourMove(j, [row(1), row(2), row(3), row(4)], nowMs)).toBe(2)
    expect(countYourMove({ available: false, reason: 'x' } as never, [row(1)], nowMs)).toBe(0)
  })

  it('shares one read for its time to live, shares a read in flight, and does not keep a failure', async () => {
    let clock = nowMs, reads = 0, fail = false
    const j = journal([receipt(2, 'failed')])
    const count = createYourMoveCounter({ journal: () => j, rows: async () => { reads++; if (fail) return null; return [row(2)] }, now: () => clock, ttlMs: 30_000 })
    expect(await Promise.all([count(), count()])).toEqual([1, 1])
    expect(reads).toBe(1)
    clock += 29_000
    expect(await count()).toBe(1)
    expect(reads).toBe(1)
    clock += 2_000; fail = true
    expect(await count()).toBeNull()
    expect(await count()).toBeNull()
    expect(reads).toBe(3)
    fail = false
    expect(await count()).toBe(1)
  })
})
