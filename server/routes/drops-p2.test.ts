import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createDropsRouter, lazyDropService, openDropService } from './drops.js'
import { DropRouter } from '../lib/drop-router.js'
import type { DropService } from '../lib/drop-service.js'
import { fakeWriters, scriptedDecisionClient } from '../lib/__fixtures__/drop-fixtures.js'
import { PingStateStore } from '../lib/ping-engine.js'
import { createDropP2Runtime, type DropP2Runtime } from '../lib/drop-p2-runtime.js'
import { DropHistorySearcher } from '../lib/drop-history-search.js'
import { createP2SettingsReader, P2_DEFAULTS } from '../lib/drop-p2-settings.js'

const servers: Server[] = [], cleanups: Array<() => void> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  cleanups.splice(0).forEach(fn => fn())
})

async function setup(options: { p2?: boolean; search?: boolean; settings?: boolean; enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drops-p2-route-'))
  const clock = { now: Date.parse('2026-11-04T15:00:00.000Z') }  // Wednesday 9:00 CST
  let opened: DropService | null = null
  const service = lazyDropService(() => {
    opened = openDropService(part => join(root, part), { router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }), writers: fakeWriters(),
      now: () => new Date(clock.now), timezone: () => 'America/Chicago' })
    return opened
  })
  let runtime: DropP2Runtime | null = null
  let pings: PingStateStore | null = null
  const p2 = () => {
    if (!options.p2) return null
    if (runtime) return runtime
    const s = service(); if (!s) return null
    pings = new PingStateStore(join(root, 'pings'))
    const { drops, feed } = s.p2Stores()
    runtime = createDropP2Runtime({ drops, feed, pingState: pings, timezone: () => 'America/Chicago', now: () => clock.now, bootId: 'boot-1' })
    return runtime
  }
  const searcher = new DropHistorySearcher({ async ask(_s, q) { const c = (q as { c: { criteria: Record<string, string> } }).c.criteria; return { answers: { c: { probabilities: { t0: 0.9, none: 0.1, ...Object.fromEntries(Object.keys(c).filter(k => k !== 't0' && k !== 'none').map(k => [k, 0])) } } }, inputTokens: 10 } } }, () => clock.now, {})
  cleanups.push(() => { runtime?.stop(); pings?.close(); (opened as DropService | null)?.close(); rmSync(root, { recursive: true, force: true }) })
  const app = express(); app.use(express.json({ limit: '1mb' }))
  const settingsReader = createP2SettingsReader(join(root, 'drop-p2-settings.json'))
  app.use('/api', createDropsRouter({ enabled: () => options.enabled ?? true, service, p2, ...(options.search ? { search: () => searcher } : {}), ...(options.settings ? { p2Settings: settingsReader } : {}) }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  return { call, clock, p2 }
}

describe('Drop it P2 routes', () => {
  it('lists pending reminders for the Mac mirror (not read as a drop id), soonest first', async () => {
    const h = await setup()
    const a = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'remind me Friday to send the deck', source: 'mac' })
    const b = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'remind me Thursday to send Gina the JCK numbers', source: 'web' })
    const out = await h.call('GET', '/drops/reminders')
    expect(out.status).toBe(200)
    expect(out.body.reminders.map((r: { id: string }) => r.id)).toEqual([b.body.drop.id, a.body.drop.id])
    expect(out.body.reminders[0]).toMatchObject({ at: '2026-11-05T15:00:00.000Z', title: 'Reminder: send Gina the JCK numbers', notifyId: `reminder-${b.body.drop.id}` })
  })

  it('when: sets a time on a reminder that asked; the summary stops waiting', async () => {
    const h = await setup()
    const out = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'remind me to call mom', source: 'mac' })
    const ask = out.body.items.find((i: { kind: string }) => i.kind === 'receipt')
    expect((await h.call('GET', '/inbox/summary')).body.waiting).toBe(1)
    const set = await h.call('POST', '/inbox/action', { itemId: ask.id, action: 'when:monday_9' })
    expect(set.status).toBe(200)
    expect(set.body.drop.remind.at).toBe('2026-11-09T15:00:00.000Z')
    expect((await h.call('GET', '/inbox/summary')).body.waiting).toBe(0)
    expect((await h.call('POST', '/inbox/action', { itemId: ask.id, action: 'when:yesterday' })).status).toBe(400)
  })

  it('a fired reminder reaches the chat and the banner outbox; Snooze answers the new counts', async () => {
    const h = await setup({ p2: true })
    const out = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'remind me at 10am to call Pete', source: 'mac' })
    h.clock.now = Date.parse('2026-11-04T16:00:00.000Z')
    expect(h.p2()!.tickReminders().fired).toBe(1)
    const banners = await h.call('GET', '/inbox/banners')
    expect(banners.body).toMatchObject({ bootId: 'boot-1', seq: 1, banners: [{ line: 'Reminder: call Pete', notifyId: `reminder-${out.body.drop.id}` }] })
    expect((await h.call('GET', '/inbox/banners?bootId=boot-1&seq=1')).body.banners).toEqual([])
    const feed = await h.call('GET', '/inbox/feed')
    const ping = feed.body.items.find((i: { kind: string }) => i.kind === 'ping')
    expect(ping.actions.map((a: { id: string }) => a.id)).toEqual(['reminder_done', 'snooze_1h', 'snooze_tomorrow'])
    const snoozed = await h.call('POST', '/inbox/action', { itemId: ping.id, action: 'snooze_1h' })
    expect(snoozed.status).toBe(200)
    expect(snoozed.body).toMatchObject({ item: { state: 'done' }, drop: { remind: { at: '2026-11-04T17:00:00.000Z', snoozes: 1 } }, waiting: 0 })
    expect(typeof snoozed.body.unread).toBe('number')
  })

  it('banners answer 503 without the runtime; search answers search_off without a searcher', async () => {
    const h = await setup()
    expect((await h.call('GET', '/inbox/banners')).body.error.code).toBe('pings_unavailable')
    expect((await h.call('POST', '/drops/search', { q: 'gina' })).body).toMatchObject({ available: false, reason: 'search_off' })
  })

  it('search by meaning over the drops', async () => {
    const h = await setup({ search: true })
    const a = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'remind me Thursday to send Gina the JCK numbers', source: 'mac' })
    const r = await h.call('POST', '/drops/search', { q: 'jewelry show numbers' })
    expect(r.body).toMatchObject({ available: true, results: [{ id: a.body.drop.id, p: 0.9 }], searched: 1 })
    expect((await h.call('POST', '/drops/search', { q: 'x' })).body.reason).toBe('query_invalid')
  })
})

describe('P2 settings routes (6.99.11)', () => {
  it('GET answers the defaults; PUT merges, clamps and keeps the rest; works while Drop it is off', async () => {
    const h = await setup({ settings: true, enabled: false })
    const read = await h.call('GET', '/drops/settings/p2')
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ protocol: 1, settings: P2_DEFAULTS, defaults: P2_DEFAULTS })
    const put = await h.call('PUT', '/drops/settings/p2', { pings: { dailyCap: 50, sources: { stale: false } }, steer: { leaveAlone: 'HubDB' } })
    expect(put.status).toBe(200)
    expect(put.body.settings.pings).toMatchObject({ dailyCap: 20, perSource: 2, sources: { stale: false, prep: true } })
    expect(put.body.settings.steer).toEqual({ about: '', leaveAlone: 'HubDB' })
    expect((await h.call('GET', '/drops/settings/p2')).body.settings.pings.dailyCap).toBe(20)
    // A second save of another section keeps the first.
    const second = await h.call('PUT', '/drops/settings/p2', { checkin: { time: '10:30' } })
    expect(second.body.settings.checkin.time).toBe('10:30')
    expect(second.body.settings.pings).toMatchObject({ dailyCap: 20, sources: { stale: false } })
    expect(second.body.settings.steer.leaveAlone).toBe('HubDB')
  })
  it('refuses a body that is not sections, and answers 503 with no store', async () => {
    const h = await setup({ settings: true })
    for (const body of [{}, { nope: {} }, { pings: 3 }, [1]]) expect((await h.call('PUT', '/drops/settings/p2', body)).status).toBe(400)
    const bare = await setup()
    expect((await bare.call('PUT', '/drops/settings/p2', { pings: { on: false } })).status).toBe(503)
    expect((await bare.call('GET', '/drops/settings/p2')).body.settings).toEqual(P2_DEFAULTS)
  })
})
