import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createDropsRouter, lazyDropService, openDropService } from './drops.js'
import { DropRouter } from '../lib/drop-router.js'
import type { DropService } from '../lib/drop-service.js'
import { fakeWriters, scriptedDecisionClient } from '../lib/__fixtures__/drop-fixtures.js'

const servers: Server[] = [], roots: string[] = [], services: Array<{ close(): void }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  services.splice(0).forEach(s => s.close())
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})

async function setup(options: { enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drops-route-')); roots.push(root)
  const state = { enabled: options.enabled ?? true, saved: [] as boolean[] }
  const writers = fakeWriters()
  let opened: DropService | null = null
  const service = lazyDropService(() => {
    opened = openDropService(part => join(root, part), { router: new DropRouter({ client: scriptedDecisionClient(), enabled: () => true }), writers })
    return opened
  })
  services.push({ close: () => (opened as DropService | null)?.close() })
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', createDropsRouter({ enabled: () => state.enabled, service, writeSetting: v => { state.saved.push(v) },
    routerStatus: () => ({ on: true, dailyCap: 300_000, usedToday: 0, breakerOpenUntil: null }) }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() as any }
  }
  return { call, state, root, writers }
}

describe('off by default', () => {
  it('every route but settings answers 404 drop_it_off, and no store file is created', async () => {
    const h = await setup({ enabled: false })
    for (const [method, path] of [['POST', '/drops'], ['GET', '/drops'], ['GET', '/inbox/summary'], ['GET', '/inbox/feed'], ['POST', '/inbox/read'],
      ['POST', `/drops/${randomUUID()}/undo`], ['POST', '/inbox/action']] as const) {
      const out = await h.call(method, path, method === 'POST' ? { dropId: randomUUID(), text: 'x', source: 'mac' } : undefined)
      expect(out.status, `${method} ${path}`).toBe(404)
      expect(out.body.error.code).toBe('drop_it_off')
    }
    expect(existsSync(join(h.root, 'drops'))).toBe(false)
    expect(existsSync(join(h.root, 'inbox'))).toBe(false)
  })

  it('settings read and write while off', async () => {
    const h = await setup({ enabled: false })
    const read = await h.call('GET', '/drops/settings')
    expect(read.body).toMatchObject({ protocol: 1, router: { on: true, dailyCap: 300_000 } })
    expect(read.cache).toBe('private, no-store')
    expect((await h.call('PUT', '/drops/settings', { enabled: 'yes' })).status).toBe(400)
    expect((await h.call('PUT', '/drops/settings', { enabled: true })).status).toBe(200)
    expect(h.state.saved).toEqual([true])
  })
})

describe('on', () => {
  it('POST /drops files and answers the drop, its chat items, and a receipt', async () => {
    const h = await setup()
    const dropId = randomUUID()
    const out = await h.call('POST', '/drops', { dropId, text: 'Draft the onboarding email sequence for new liquor stores', source: 'mac' })
    expect(out.status).toBe(200)
    expect(out.cache).toBe('private, no-store')
    expect(out.body).toMatchObject({ replayed: false, drop: { id: dropId, dest: 'new_card', kind: 'task', status: 'open', canUndo: true } })
    expect(out.body.items.map((i: { kind: string }) => i.kind)).toEqual(['drop', 'receipt'])
    const again = await h.call('POST', '/drops', { dropId, text: 'Draft the onboarding email sequence for new liquor stores', source: 'mac' })
    expect(again.body.replayed).toBe(true)
    expect((await h.call('GET', `/drops/${dropId}`)).body.drop.id).toBe(dropId)
  })

  it('refuses unknown body fields and bad ids', async () => {
    const h = await setup()
    expect((await h.call('POST', '/drops', { dropId: randomUUID(), text: 'x', source: 'mac', extra: 1 })).body.error.code).toBe('invalid_drop')
    expect((await h.call('POST', '/drops', { dropId: 'abc', text: 'x', source: 'mac' })).body.error.code).toBe('invalid_drop_id')
    expect((await h.call('GET', '/drops/not-a-uuid')).status).toBe(404)
    expect((await h.call('GET', '/drops?kind=nope')).status).toBe(400)
    expect((await h.call('GET', '/drops?status=nope')).status).toBe(400)
  })

  it('question, answer by action, Undo by action, Move by route, History, summary and read', async () => {
    const h = await setup()
    const asked = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'Call Dale about the Kickoff deck', source: 'web' })
    const question = asked.body.items.find((i: { kind: string }) => i.kind === 'question')
    expect((await h.call('GET', '/inbox/summary')).body).toMatchObject({ unread: 1, lastLine: expect.stringMatching(/^Is this/) })
    const chosen = await h.call('POST', '/inbox/action', { itemId: question.id, action: 'choose:o1' })
    expect(chosen.body.drop).toMatchObject({ dest: 'new_card', route: { by: 'user' } })
    const receipt = chosen.body.items.at(-1)
    const undone = await h.call('POST', '/inbox/action', { itemId: receipt.id, action: 'undo' })
    expect(undone.body.drop.state).toBe('undone')
    expect((await h.call('POST', `/drops/${undone.body.drop.id}/undo`)).body.replayed).toBe(true)

    const filed = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'Trade show budget might need another booth panel', source: 'mac' })
    expect((await h.call('POST', `/drops/${filed.body.drop.id}/move`, { dest: 'new_card' })).status).toBe(400)
    const moved = await h.call('POST', `/drops/${filed.body.drop.id}/move`, { dest: 'new_card', target: { id: 'work', label: 'Work', domain: 'work' } })
    expect(moved.body.drop).toMatchObject({ dest: 'new_card', links: [{ kind: 'card', domain: 'work' }] })

    const history = await h.call('GET', '/drops?q=trade&kind=task')
    expect(history.body.drops.map((d: { id: string }) => d.id)).toEqual([filed.body.drop.id])
    const feed = await h.call('GET', '/inbox/feed?limit=200')
    expect(feed.body.items.length).toBeGreaterThan(5)
    const last = feed.body.items.at(-1)
    expect((await h.call('POST', '/inbox/read', { through: last.id })).body.unread).toBe(0)
    expect((await h.call('POST', '/inbox/read', { through: 'fi_nope' })).status).toBe(404)
  })

  it('a move target with a bad label is refused before anything is undone', async () => {
    const h = await setup()
    const filed = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'Draft the onboarding email sequence for new liquor stores', source: 'mac' })
    for (const target of [{ id: 'thread-3', label: 'a\nb' }, { id: 'thread-3', label: 'x'.repeat(201) }, { id: '../x', label: 'ok' }, { id: 'thread-3' }]) {
      const out = await h.call('POST', `/drops/${filed.body.drop.id}/move`, { dest: 'thread', target })
      expect(out.status, JSON.stringify(target)).toBe(400)
    }
    expect([...h.writers.cards.values()][0].archived).toBe(false)
    expect((await h.call('GET', `/drops/${filed.body.drop.id}`)).body.drop.dest).toBe('new_card')
  })

  it('an Undo it cannot do answers 409 with a reason', async () => {
    const h = await setup()
    const ask = await h.call('POST', '/drops', { dropId: randomUUID(), text: 'what did we decide?', source: 'mac' })
    expect(ask.body.next).toEqual({ kind: 'ask', prompt: 'what did we decide?' })
    const out = await h.call('POST', `/drops/${ask.body.drop.id}/undo`)
    expect(out.status).toBe(409)
    expect(out.body.error).toEqual({ code: 'undo_not_available', message: 'A question cannot be undone. The answer stays.' })
    const linked = await h.call('POST', `/drops/${ask.body.drop.id}/ask`, { clientJobId: randomUUID(), generation: 1 })
    expect(linked.body.drop.links[0].kind).toBe('ask')
  })

  it('answers 503 when its stores cannot open', async () => {
    const app = express(); app.use(express.json())
    app.use('/api', createDropsRouter({ enabled: () => true, service: () => null }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/inbox/summary`)
    expect(res.status).toBe(503)
    expect((await res.json() as any).error.code).toBe('drop_store_unavailable')
  })
})
