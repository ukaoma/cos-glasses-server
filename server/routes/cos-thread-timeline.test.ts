/**
 * 7.0.39 (persistent COS thread, candidate 3): GET /api/cos-thread/history?timeline=1 over real HTTP, the real store in a
 * temp dir, breadcrumbs added directly, and a spy in place of the server's sweeper. Placeholder words only.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCosThreadRouter } from './cos-thread.js'
import { CosThread, lazyCosThread } from '../lib/cos-thread.js'

const servers: Server[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-tl-route-')); roots.push(root)
  const thread = lazyCosThread(() => new CosThread({ dir: join(root, 'cos-thread'), context: () => ({ found: true, tokens: 1 }) }))
  const started: unknown[] = []
  const app = express(); app.use(express.json())
  app.use('/api', createCosThreadRouter({ enabled: () => true, thread, archiveAnswer: () => undefined, startTimeline: t => { started.push(t) } }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any } }
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
  return { thread, started, get, post }
}

describe('GET /cos-thread/history?timeline=1', () => {
  it('returns chats and breadcrumbs in time order with c2 and c3 cursors; without the parameter, chats only', async () => {
    const h = await setup()
    await h.post('/cos-thread/turn', { clientId: 'web-00000001', sessionId: 'sess0001', query: 'a chat', answer: 'an answer' })
    h.thread()!.timeline().add([
      { key: 'mt:x', at: new Date(Date.now() - 3_600_000).toISOString(), kind: 'meeting', line: 'a meeting', ref: { type: 'meeting', domain: 'quilt', month: '2026-11', filename: 'x.md' } },
      { key: 'fi:y', at: new Date(Date.now() + 1000).toISOString(), kind: 'notification', line: 'a notification', ref: { type: 'notification', id: 'fi_y', threadId: 'fi_y' } },
    ])
    const tl = await h.get('/cos-thread/history?timeline=1')
    expect(tl.status).toBe(200)
    expect(tl.body.entries.map((e: any) => e.kind)).toEqual(['meeting', 'chat', 'notification'])
    expect(tl.body.entries[0]).toMatchObject({ line: 'a meeting', ref: { type: 'meeting', domain: 'quilt', month: '2026-11', filename: 'x.md' } })
    expect(tl.body.newest).toMatch(/^c3\.1\.0\.2\.0$/)
    const meetingsOnly = await h.get('/cos-thread/history?timeline=1&kinds=meeting,notification')
    expect(meetingsOnly.body.entries.map((e: any) => e.kind)).toEqual(['meeting', 'notification'])
    const back = await h.get('/cos-thread/history?timeline=1&limit=1')
    expect(back.body.older).toMatch(/^c2\.\d+\.b[0-9a-f]{20}$/)
    const older = await h.get(`/cos-thread/history?timeline=1&limit=1&before=${back.body.older}`)
    expect(older.body.entries.map((e: any) => e.kind)).toEqual(['chat'])
    const plain = await h.get('/cos-thread/history')
    expect(plain.body.entries.map((e: any) => e.kind)).toEqual(['chat'])
    expect(plain.body.newest).toBe('c1.1.0')
    expect(h.started.length).toBeGreaterThan(0)
    expect(new Set(h.started).size).toBe(1)
  })

  it('refuses unknown kinds and a cursor of the wrong family or direction', async () => {
    const h = await setup()
    expect((await h.get('/cos-thread/history?timeline=1&kinds=chat,work')).body.error.code).toBe('invalid_kinds')
    expect((await h.get('/cos-thread/history?timeline=1&kinds=')).body.error.code).toBe('invalid_kinds')
    for (const q of ['before=c1.3', 'after=c1.3.0', 'before=c3.1.0.0.0', 'after=c2.123.t000000001', 'before=c2.1.x', 'after=c3.1.0.0']) {
      const out = await h.get(`/cos-thread/history?timeline=1&${q}`)
      expect(out.status, q).toBe(400)
      expect(out.body.error.code, q).toBe('invalid_cursor')
    }
  })
})
