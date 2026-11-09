/**
 * 7.0.9 (Miles 11/08): the server halves of the Control Web Messages fixes.
 *  1. The rail counts net new only. The inbox feed keeps a read floor: the first open by a build that has it marks
 *     every item still unread as read, once, so things already on screen never count again. The summary says which
 *     part of `waiting` is the chat's own (`asked`) and which is Work's (`yourMove`).
 *  4. A COS answer that relayed a message to another session says where it went: SendMessage's `to` rides the step's
 *     detail, never a socket path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DropStore, InboxFeedStore, type FeedItem } from './drop-store.js'
import { DropRouter } from './drop-router.js'
import { DropService, WAITING_EXPIRY_DAYS, WAITING_EXPIRY_MS, isWaiting } from './drop-service.js'
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Server } from 'node:http'
import { createDropsRouter } from '../routes/drops.js'
import { fakeWriters, scriptedDecisionClient } from './__fixtures__/drop-fixtures.js'
import { createJobTrailReader, type JobTrailDraft } from './job-trail.js'
import { sendMessageDetail } from './session-stream-events.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'msg-709-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
let n = 0
function item(patch: Partial<FeedItem> = {}): FeedItem {
  const k = ++n
  return { id: `fi_${k.toString(16).padStart(32, '0')}`, kind: 'ping', threadId: `ping-${k}`, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    readAt: null, source: 'cos', line: 'Pete 1:1 at 2:00. Prep me?', links: [], actions: [], state: 'live', key: `ping:${k}`, ...patch }
}
function service(root: string, at?: () => Date) {
  const drops = new DropStore(join(root, 'drops')), feed = new InboxFeedStore(join(root, 'inbox'), at)
  const s = new DropService({ drops, feed, writers: fakeWriters(), router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }) })
  return { s, feed, close: () => { drops.close(); feed.close() } }
}

describe('the read floor (issue 1)', () => {
  it('a feed an older build wrote: what was unread when this build first opens it is read, once; what comes after counts', () => {
    const root = dir()
    // As 7.0.8 wrote it: no readFloorAt, three unread COS lines Miles had already seen on the web.
    const old = [item(), item({ kind: 'followup' }), item({ kind: 'question', needsReply: true })]
    const inbox = join(root, 'inbox')
    const first = new InboxFeedStore(inbox); first.insert(old); first.close()
    const path = join(inbox, 'feed.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')); delete raw.readFloorAt
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 })

    const opened = service(root, () => new Date('2026-11-09T02:00:00.000Z'))
    expect(opened.s.summary()).toMatchObject({ unread: 0, asked: 1 })
    expect(opened.feed.readFloor()).toBe('2026-11-09T02:00:00.000Z')
    expect(JSON.parse(readFileSync(path, 'utf8')).readFloorAt).toBe('2026-11-09T02:00:00.000Z')
    // Net new after the floor counts, and Mark read clears it.
    const fresh = opened.feed.insert([item({ createdAt: '2026-11-09T02:05:00.000Z' })])[0]
    expect(opened.s.summary().unread).toBe(1)
    expect(opened.s.markRead(fresh.id)).toMatchObject({ unread: 0, asked: 1 })
    opened.close()

    // A reopen does not migrate again: an unread item written after the floor stays unread.
    const again = service(root, () => new Date('2026-11-09T03:00:00.000Z'))
    again.feed.insert([item({ createdAt: '2026-11-09T02:30:00.000Z' })])
    again.close()
    const third = service(root, () => new Date('2026-11-09T04:00:00.000Z'))
    expect(third.feed.readFloor()).toBe('2026-11-09T02:00:00.000Z')
    expect(third.s.summary().unread).toBe(1)
    third.close()
  })

  it('a brand new feed has nothing to migrate and counts every new line', () => {
    const root = dir()
    const h = service(root)
    h.feed.insert([item(), item()])
    expect(h.s.summary().unread).toBe(2)
    h.close()
    const back = service(root)
    expect(back.s.summary().unread).toBe(2)
    back.close()
  })
})

describe('what waits, said apart (issue 1)', () => {
  it('asked is the chat alone; yourMove is Work; waiting keeps both for COS Control', () => {
    const h = service(dir())
    h.feed.insert([item({ needsReply: true }), item(), item({ needsReply: true, state: 'done' })])
    expect(h.s.summary({ yourMove: 284 })).toMatchObject({ waiting: 285, asked: 1, yourMove: 284 })
    expect(h.s.summary()).toMatchObject({ waiting: 1, asked: 1, yourMove: null })
    expect(h.s.summary({ yourMove: 0 })).toMatchObject({ waiting: 1, asked: 1, yourMove: 0 })
    for (const bad of [-1, 1.5, Number.NaN]) expect(h.s.summary({ yourMove: bad }).yourMove).toBeNull()
    h.close()
  })
})

describe('where a relayed message went (issue 4)', () => {
  function read(records: unknown[]): JobTrailDraft[] {
    const out: JobTrailDraft[] = []
    const reader = createJobTrailReader('claude', d => out.push(d))
    for (const r of records) reader.line(JSON.stringify(r))
    reader.end()
    return out
  }
  it('a SendMessage step carries who it went to, as the trail journals it', () => {
    const drafts = read([{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_01Send', name: 'SendMessage',
      input: { to: 'today-brief-builder', message: 'Did my last message reach you?' } }] } }])
    expect(drafts).toEqual([{ kind: 'tool', verb: 'other', target: 'SendMessage', detail: 'to today-brief-builder', call: 'toolu_01Send' }])
    // The message's own words are never in the step.
    expect(JSON.stringify(drafts)).not.toContain('reach you')
  })
  it('never a socket path or a Mac path; a session id shows its first 8 characters', () => {
    expect(sendMessageDetail('uds:/Users/ukaoma/.claude/sessions/123.sock')).toBe('to another session')
    expect(sendMessageDetail('bridge:0f3c2a9e-1111-2222-3333-444455556666')).toBe('to session 0f3c2a9e')
    expect(sendMessageDetail('uds:4412.sock')).toBe('to another session')
    expect(sendMessageDetail('../secret/thing')).toBe('to another session')
    expect(sendMessageDetail('*')).toBe('to every session')
    expect(sendMessageDetail('')).toBe('')
    expect(sendMessageDetail(42)).toBe('')
    expect(sendMessageDetail('A very long peer session name that will not fit in a detail').length).toBeLessThanOrEqual(40)
  })
})

describe('a question stops waiting 7 days after it was asked (Miles 11/08, "Expire after 7 days")', () => {
  const ASKS = 'Call Dale about the Kickoff deck'   // a scripted router question with three choices
  function clocked() {
    const root = dir()
    const clock = { t: Date.parse('2026-11-01T09:00:00.000Z') }
    const now = () => new Date(clock.t)
    const drops = new DropStore(join(root, 'drops')), feed = new InboxFeedStore(join(root, 'inbox'), now)
    const s = new DropService({ drops, feed, now, writers: fakeWriters(), router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }) })
    cleanup.push(() => { drops.close(); feed.close() })
    return { s, feed, clock }
  }

  it('one rule: 7 days, from when it was asked', () => {
    expect(WAITING_EXPIRY_DAYS).toBe(7)
    expect(WAITING_EXPIRY_MS).toBe(7 * 86_400_000)
  })

  it('just under 7 days it waits; at 7 days it moves to older questions, out of asked and the chat part of waiting only', async () => {
    const h = clocked()
    const asked = await h.s.submit({ dropId: randomUUID(), text: ASKS, source: 'web' })
    const q = asked.items.find(i => i.kind === 'question')!
    // Read the next minute: reading never restarts the clock.
    h.clock.t += 60_000
    h.s.markRead(q.id)
    h.clock.t = Date.parse(q.createdAt) + WAITING_EXPIRY_MS - 1
    expect(h.s.summary({ yourMove: 5 })).toMatchObject({ asked: 1, archived: 0, waiting: 6, waitingExpiryDays: 7 })
    expect(h.s.archive().items).toEqual([])
    expect(h.s.feed().items.find(i => i.id === q.id)).not.toHaveProperty('archived')
    h.clock.t += 1
    // Work's part of waiting is unchanged; only the chat's expired question leaves it.
    expect(h.s.summary({ yourMove: 5 })).toMatchObject({ asked: 0, archived: 1, waiting: 5 })
    expect(h.s.archive()).toMatchObject({ total: 1, waitingExpiryDays: 7, items: [{ id: q.id, archived: true, kind: 'question', state: 'live' }] })
    expect(h.s.feed().items.find(i => i.id === q.id)).toMatchObject({ archived: true })
    // A new question counts as before.
    const fresh = await h.s.submit({ dropId: randomUUID(), text: ASKS, source: 'web' })
    expect(h.s.summary()).toMatchObject({ asked: 1, archived: 1 })
    expect(h.s.archive().items.map(i => i.id)).not.toContain(fresh.items.find(i => i.kind === 'question')!.id)
  })

  it('an older question still answers, and answering it clears it from older questions', async () => {
    const h = clocked()
    const asked = await h.s.submit({ dropId: randomUUID(), text: ASKS, source: 'web' })
    const q = asked.items.find(i => i.kind === 'question')!
    h.clock.t += 9 * 86_400_000
    expect(h.s.archive().total).toBe(1)
    const answered = await h.s.choose(q.id, asked.drop.choices![0].id)
    expect(answered.items.find(i => i.id === q.id)).toMatchObject({ state: 'done' })
    expect(h.s.archive().total).toBe(0)
    expect(h.s.summary()).toMatchObject({ asked: 0, archived: 0 })
  })

  it('a needs-reply ping past 7 days dismisses from older questions too, and isWaiting takes the clock it is given', () => {
    const h = clocked()
    const [p] = h.feed.insert([item({ needsReply: true, createdAt: new Date(h.clock.t).toISOString() })])
    expect(isWaiting(p, h.clock.t + WAITING_EXPIRY_MS - 1)).toBe(true)
    expect(isWaiting(p, h.clock.t + WAITING_EXPIRY_MS)).toBe(false)
    h.clock.t += WAITING_EXPIRY_MS
    expect(h.s.archive().total).toBe(1)
    expect(h.s.dismiss(p.id)).toMatchObject({ asked: 0 })
    expect(h.s.archive().total).toBe(0)
  })

  it('GET /api/inbox/archive serves the list', async () => {
    const h = clocked()
    await h.s.submit({ dropId: randomUUID(), text: ASKS, source: 'web' })
    h.clock.t += 8 * 86_400_000
    const app = express(); app.use(express.json())
    app.use('/api', createDropsRouter({ enabled: () => true, service: () => h.s }))
    const server = await new Promise<Server>(r => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
    try {
      const body = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/inbox/archive`).then(r => r.json()) as any
      expect(body).toMatchObject({ total: 1, waitingExpiryDays: 7 })
      expect(body.items[0]).toMatchObject({ kind: 'question', archived: true })
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })
})
