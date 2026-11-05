import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DropStore, InboxFeedStore, type DropRecord } from './drop-store.js'
import { PingStateStore } from './ping-engine.js'
import { createDropP2Runtime, journalReceiptsLite, readCacheArray, P2_TIMING, type BoardRowLite } from './drop-p2-runtime.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function rig(start: number) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-p2-')); dirs.push(dir)
  const scripts = join(dir, 'scripts'); mkdirSync(scripts)
  const clock = { now: start }
  const drops = new DropStore(join(dir, 'drops'), () => new Date(clock.now))
  const feed = new InboxFeedStore(join(dir, 'inbox'), () => new Date(clock.now))
  const pingState = new PingStateStore(join(dir, 'pings'))
  const lens: Array<{ type: string; data: Record<string, unknown> }> = []
  const boardRef: { rows: BoardRowLite[] | null } = { rows: [] }
  const runtime = createDropP2Runtime({
    drops, feed, pingState, timezone: () => TZ, now: () => clock.now, scriptsDir: scripts,
    nextEvent: async () => null, intakeOpen: () => [],
    board: async () => { if (!boardRef.rows) throw new Error('board unread'); return boardRef.rows },
    journal: () => [], emitLens: e => lens.push(e), bootId: 'boot-a',
  })
  const close = () => { runtime.stop(); drops.close(); feed.close(); pingState.close() }
  return { dir, scripts, clock, drops, feed, runtime, lens, boardRef, close }
}
function baseDrop(text: string, at: number, extra: Partial<DropRecord>): DropRecord {
  const iso = new Date(at).toISOString()
  return { id: randomUUID(), text, source: 'mac', createdAt: iso, updatedAt: iso, state: 'filed', dest: 'note', kind: 'note', links: [], route: { by: 'rule' }, undoUntil: null, timeline: [], ...extra }
}

describe('Drop it P2 runtime, end to end on fixtures', () => {
  it('a reminder fires into the chat, the Mac outbox and the lens, once', async () => {
    const r = rig(local('2026-11-04', '09:59'))
    const d = r.drops.insert(baseDrop('remind me at 10am to call Pete', local('2026-11-04', '09:00'), {
      dest: 'reminder', kind: 'reminder', links: [], remind: { at: new Date(local('2026-11-04', '10:00')).toISOString(), tz: TZ, firedAt: null, ackAt: null, snoozes: 0 },
    })).drop
    expect(r.runtime.pendingReminders().map(p => p.notifyId)).toEqual([`reminder-${d.id}`])
    r.clock.now = local('2026-11-04', '10:00')
    expect(r.runtime.tickReminders().fired).toBe(1)
    expect(r.runtime.tickReminders().fired).toBe(0)
    const pings = r.feed.list().filter(i => i.kind === 'ping')
    expect(pings.map(p => [p.line, p.readAt, p.source])).toEqual([['Reminder: call Pete', null, 'cos']])
    const out = r.runtime.banners()
    expect(out.banners.map(b => [b.line, b.notifyId, b.seq])).toEqual([['Reminder: call Pete', `reminder-${d.id}`, 1]])
    expect(r.runtime.banners({ bootId: 'boot-a', seq: 1 }).banners).toEqual([])
    expect(r.runtime.banners({ bootId: 'old-boot', seq: 1 }).banners).toHaveLength(1)  // another boot's cursor starts over
    expect(r.lens).toEqual([{ type: 'cos_ping', data: { title: 'Reminder', line: 'Reminder: call Pete', feedIds: [pings[0].id], notifyId: `reminder-${d.id}` } }])
    // Done from the chat.
    expect(r.runtime.reminderAction(d.id, 'reminder_done')!.remind!.ackAt).not.toBeNull()
    expect(r.runtime.pendingReminders()).toEqual([])
    r.close()
  })

  it('a drop-linked card reaching Complete posts one follow-up under its drop; an unread board posts nothing', async () => {
    const r = rig(local('2026-11-04', '10:00'))
    const d = r.drops.insert(baseDrop('send Gina the JCK numbers', local('2026-11-04', '09:00'), {
      dest: 'new_card', kind: 'task', links: [{ kind: 'card', id: 'wid-1', label: 'JCK numbers', domain: 'quilt' }],
    })).drop
    r.boardRef.rows = null
    expect(await r.runtime.pollOnce()).toBe(0)
    r.boardRef.rows = [{ id: 'abc123def456', domain: 'quilt', workIdentity: 'wid-1', workStage: 'draft', checked: false }]
    expect(await r.runtime.pollOnce()).toBe(0)  // a move to Draft updates status silently
    r.boardRef.rows = [{ id: 'abc123def456', domain: 'quilt', workIdentity: 'wid-1', workStage: 'complete', checked: true }]
    r.clock.now += P2_TIMING.resolutionPollMs
    expect(await r.runtime.pollOnce()).toBe(1)
    r.runtime.onCardWrite('quilt', 'wid-1', { workStage: 'complete', checked: true })  // the event arrives late: no second post
    const f = r.feed.list().filter(i => i.kind === 'followup')
    expect(f.map(i => [i.threadId, i.title, i.line])).toEqual([[d.id, 'Re: send Gina the JCK numbers', 'Done: JCK numbers moved to Complete.']])
    expect(r.runtime.banners().banners).toHaveLength(1)
    expect(r.lens).toEqual([])  // only reminders push to the lens
    r.close()
  })

  it('reads the thread cache read-only: a stale thread lands silently in the chat (that source banners only when turned on)', async () => {
    const r = rig(local('2026-11-04', '10:00'))
    writeFileSync(join(r.scripts, '.threads_cache.json'), JSON.stringify({ threads: [{ id: 'thr-1', name: 'JCK follow-through', is_stale: true, is_resolved: false, last_seen: '2026-10-21T12:00:00Z' }] }))
    writeFileSync(join(r.scripts, '.signals_cache.json'), JSON.stringify({ signals: [{ id: 'sig-1', severity: 'red', title: 'Pet leads down 30%', context: { explanation: 'Two weeks below plan.' } }, { id: 'sig-2', severity: 'yellow', title: 'x' }] }))
    await r.runtime.pingOnce()
    expect(r.feed.list().filter(i => i.kind === 'ping').map(i => i.line).sort()).toEqual(['JCK follow-through quiet for 14 days.', 'Pet leads down 30%. Two weeks below plan.'])
    expect(r.runtime.banners().banners).toEqual([])
    r.close()
  })

  it('a missing signals cache does not quiet stale threads', async () => {
    const r = rig(local('2026-11-04', '10:00'))
    writeFileSync(join(r.scripts, '.threads_cache.json'), JSON.stringify({ threads: [{ id: 'thr-1', name: 'JCK follow-through', is_stale: true, is_resolved: false, last_seen: '2026-10-21T12:00:00Z' }] }))
    await r.runtime.pingOnce()
    expect(r.feed.list().filter(i => i.kind === 'ping').map(i => i.line)).toEqual(['JCK follow-through quiet for 14 days.'])
    r.close()
  })

  it('a missing, oversized or malformed cache is unread, never an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-cache-')); dirs.push(dir)
    expect(readCacheArray(dir, '.threads_cache.json', 'threads')).toBeUndefined()
    writeFileSync(join(dir, '.threads_cache.json'), '{not json')
    expect(readCacheArray(dir, '.threads_cache.json', 'threads')).toBeUndefined()
    writeFileSync(join(dir, '.threads_cache.json'), JSON.stringify({ threads: 'nope' }))
    expect(readCacheArray(dir, '.threads_cache.json', 'threads')).toBeUndefined()
    writeFileSync(join(dir, '.threads_cache.json'), JSON.stringify({ threads: [1] }))
    expect(readCacheArray(dir, '.threads_cache.json', 'threads')).toEqual([1])
    expect(readCacheArray(null, '.threads_cache.json', 'threads')).toBeUndefined()
  })

  it('maps journal receipts to the fields the poll reads, skipping rows without an id or status', () => {
    expect(journalReceiptsLite([
      { id: 'h1', status: 'completed', workID: 'task:quilt:wid-1', result: 'Pushed.', prompt: 'secret words' },
      { id: 'h2', status: 'running' }, { status: 'failed' }, { id: 3, status: 'failed' },
    ])).toEqual([
      { id: 'h1', status: 'completed', workID: 'task:quilt:wid-1', result: 'Pushed.' },
      { id: 'h2', status: 'running', workID: null, result: null },
    ])
  })

  it('the outbox keeps the last 50 banners', () => {
    const r = rig(local('2026-11-04', '10:00'))
    for (let i = 0; i < 60; i++) r.runtime.push([{ source: 'reminder', key: `reminder:x${i}`, line: `r${i}`, links: [], actions: [], createdAt: r.clock.now }])
    const all = r.runtime.banners()
    expect(all.banners).toHaveLength(P2_TIMING.outbox)
    expect(all.banners[0].seq).toBe(11)
    expect(all.seq).toBe(60)
    r.close()
  }, 20_000)  // 60 real store writes: about 1.3 s idle, over 5 s while another suite loads the Mac
})
