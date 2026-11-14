/**
 * 7.0.39 (persistent thread, candidate 1): GET /api/cos-thread/history and /entry/:id over real HTTP, the real store in
 * a temp dir, a fake live answer reader and a fake archive reader. Placeholder words only.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCosThreadRouter } from './cos-thread.js'
import { CosThread, ENTRY_MAX_ANSWER_CHARS, lazyCosThread, type CosThreadEntryLookup } from '../lib/cos-thread.js'

const servers: Server[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})

async function setup(options: { enabled?: boolean; live?: Record<string, string>; archive?: (l: CosThreadEntryLookup) => string | undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-hist-route-')); roots.push(root)
  const dir = join(root, 'data', 'cos-thread')
  const state = { enabled: options.enabled ?? true, archiveCalls: [] as CosThreadEntryLookup[] }
  const thread = lazyCosThread(() => new CosThread({
    dir, capTokens: () => 150_000, context: () => ({ found: true, tokens: 1000 }),
    answerFor: (sessionId, clientId) => options.live?.[`${sessionId}:${clientId}`],
  }))
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', createCosThreadRouter({
    enabled: () => state.enabled, thread,
    archiveAnswer: l => { state.archiveCalls.push(l); return options.archive?.(l) },
  }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() as any }
  }
  const turn = (n: number, extra: Record<string, unknown> = {}) => call('POST', '/cos-thread/turn',
    { clientId: `web-${String(n).padStart(6, '0')}`, sessionId: 'sess0001', query: `question ${n}`, answer: `answer ${n}`, messageNo: 600 + n, ...extra })
  return { call, turn, state, root }
}
const id = (n: number) => `t:web-${String(n).padStart(6, '0')}`

describe('gate', () => {
  it('while Drop it is off both routes answer 404 drop_it_off, private, and no file is created', async () => {
    const h = await setup({ enabled: false })
    for (const path of ['/cos-thread/history', '/cos-thread/entry/' + id(1)]) {
      const out = await h.call('GET', path)
      expect(out.status, path).toBe(404)
      expect(out.body.error.code).toBe('drop_it_off')
      expect(out.cache).toBe('private, no-store')
    }
    expect(existsSync(join(h.root, 'data'))).toBe(false)
  })
})

describe('GET /cos-thread/history', () => {
  it('default 40, oldest to newest, older and newest cursors that page back and forward', async () => {
    const h = await setup()
    for (let n = 1; n <= 45; n++) expect((await h.turn(n)).status).toBe(200)
    const page = await h.call('GET', '/cos-thread/history')
    expect(page.status).toBe(200)
    expect(page.cache).toBe('private, no-store')
    expect(page.body.entries).toHaveLength(40)
    expect(page.body.entries[0].id).toBe(id(6))
    expect(page.body.entries[39].id).toBe(id(45))
    expect(page.body).toMatchObject({ protocol: 1, older: 'c1.5', newest: 'c1.45', more: false, updated: [] })
    const back = await h.call('GET', `/cos-thread/history?before=${page.body.older}&limit=10`)
    expect(back.body.entries.map((e: any) => e.id)).toEqual([1, 2, 3, 4, 5].map(id))
    expect(back.body.older).toBeNull()
    await h.turn(46)
    const ahead = await h.call('GET', `/cos-thread/history?after=${page.body.newest}`)
    expect(ahead.body.entries.map((e: any) => e.id)).toEqual([id(46)])
    expect(ahead.body.newest).toBe('c1.46')
  })

  it('refuses a bad limit, a bad cursor and both cursors at once', async () => {
    const h = await setup()
    for (const q of ['limit=0', 'limit=101', 'limit=x', 'limit=4.5']) expect((await h.call('GET', `/cos-thread/history?${q}`)).body.error.code, q).toBe('invalid_limit')
    for (const q of ['before=5', 'before=c2.5', 'after=c1.-1', 'after=c1.', 'before=c1.1234567890', 'before=c1.1&after=c1.2', 'before=c1.1&before=c1.2', 'before=xc1.5', 'before=c1.5x']) {
      const out = await h.call('GET', `/cos-thread/history?${q}`)
      expect(out.status, q).toBe(400)
      expect(out.body.error.code, q).toBe('invalid_cursor')
    }
  })
})

describe('GET /cos-thread/entry/:id', () => {
  it('the ledger when it holds the whole answer; never asks further', async () => {
    const h = await setup()
    await h.turn(1)
    const out = await h.call('GET', '/cos-thread/entry/' + id(1))
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ source: 'ledger', entry: expect.objectContaining({ id: id(1), answer: 'answer 1', full: true, answerChars: 8 }) })
    expect(h.state.archiveCalls).toHaveLength(0)
  })

  it('the live conversation, then the archive, then the preview', async () => {
    const long = 'z'.repeat(5000)
    const h = await setup({
      live: { 'sess0001:web-000001': long },
      archive: l => l.clientId === 'web-000002' ? 'from the archive ' + long : undefined,
    })
    for (let n = 1; n <= 3; n++) await h.turn(n, { answer: long })
    const live = await h.call('GET', '/cos-thread/entry/' + id(1))
    expect(live.body.source).toBe('live')
    expect(live.body.entry).toMatchObject({ answer: long, full: true, answerChars: 5000 })
    const archived = await h.call('GET', '/cos-thread/entry/' + id(2))
    expect(archived.body.source).toBe('archive')
    expect(archived.body.entry).toMatchObject({ full: true, answerChars: 5017 })
    expect(h.state.archiveCalls.at(-1)).toMatchObject({ sessionId: 'sess0001', clientId: 'web-000002', messageNo: 602, query: 'question 2' })
    const preview = await h.call('GET', '/cos-thread/entry/' + id(3))
    expect(preview.body.source).toBe('preview')
    expect(preview.body.entry).toMatchObject({ full: false, answerChars: null })
    expect(preview.body.entry.answer).toHaveLength(2000)
  })

  it('an answer past the cap is cut and reads full: false; an archive reader that throws reads as the preview', async () => {
    const h = await setup({ archive: l => { if (l.clientId === 'web-000002') throw new Error('boom'); return 'w'.repeat(ENTRY_MAX_ANSWER_CHARS + 1) } })
    await h.turn(1, { answer: 'q'.repeat(3000) }); await h.turn(2, { answer: 'q'.repeat(3000) })
    const cut = await h.call('GET', '/cos-thread/entry/' + id(1))
    expect(cut.body.entry).toMatchObject({ full: false, answerChars: ENTRY_MAX_ANSWER_CHARS + 1 })
    expect(cut.body.entry.answer).toHaveLength(ENTRY_MAX_ANSWER_CHARS)
    expect((await h.call('GET', '/cos-thread/entry/' + id(2))).body.source).toBe('preview')
  })

  it('400 for an id that is not t:<clientId>, 404 for one the history does not hold', async () => {
    const h = await setup()
    for (const bad of ['web-000001', 'b:web-000001', 't:short', 't:' + 'x'.repeat(81), 't:web 000001']) {
      expect((await h.call('GET', '/cos-thread/entry/' + encodeURIComponent(bad))).body.error.code, bad).toBe('invalid_entry')
    }
    const missing = await h.call('GET', '/cos-thread/entry/' + id(99))
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('entry_not_found')
  })
})
