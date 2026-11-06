/**
 * 6.99.16: the COS thread routes (routes/cos-thread.ts) over real HTTP, with the real store in a temp dir, a fake
 * projects dir for the Claude Code logs, and the Drop it switch the way drops.ts reads it. Plus the health capability.
 */
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCosThreadRouter } from './cos-thread.js'
import { claudeContextReader, CosThread, lazyCosThread } from '../lib/cos-thread.js'
import { healthRouter } from './health.js'
import { dropItCapability } from '../lib/drop-settings.js'

const servers: Server[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})

async function setup(options: { enabled?: boolean; cap?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-route-')); roots.push(root)
  const projects = join(root, 'projects'); mkdirSync(join(projects, 'p'), { recursive: true })
  const dir = join(root, 'data', 'cos-thread')
  const state = { enabled: options.enabled ?? true }
  const thread = lazyCosThread(() => new CosThread({ dir, capTokens: () => options.cap ?? 150_000, context: claudeContextReader({ projectsDir: () => projects }) }))
  const app = express(); app.use(express.json({ limit: '1mb' }))
  app.use('/api', createCosThreadRouter({ enabled: () => state.enabled, thread }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() as any }
  }
  const log = (id: string, tokens: number) => writeFileSync(join(projects, 'p', `${id}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n')
  return { call, state, root, dir, log }
}
const turn = (n: number, sessionId: string) => ({ clientId: `web-${String(n).padStart(6, '0')}`, sessionId, query: `question ${n}`, answer: `answer ${n}`, messageNo: 600 + n })

describe('gate', () => {
  it('while Drop it is off every route answers 404 drop_it_off, private, and no file is created', async () => {
    const h = await setup({ enabled: false })
    for (const [method, path, body] of [['GET', '/cos-thread'], ['POST', '/cos-thread/new', {}], ['POST', '/cos-thread/turn', turn(1, 'sess0001')],
      ['GET', '/cos-thread/search?q=ab'], ['GET', '/cos-thread/threads']] as const) {
      const out = await h.call(method, path, body)
      expect(out.status, `${method} ${path}`).toBe(404)
      expect(out.body.error.code).toBe('drop_it_off')
      expect(out.cache).toBe('private, no-store')
    }
    expect(existsSync(join(h.root, 'data'))).toBe(false)
    h.state.enabled = true
    expect((await h.call('GET', '/cos-thread')).status).toBe(200)
    expect(existsSync(join(h.dir, 'ledger.jsonl'))).toBe(true)
  })
})

describe('the thread over HTTP', () => {
  it('GET, turn, size rollover, New thread: the contract shapes', async () => {
    const h = await setup({ cap: 20_000 })
    const first = await h.call('GET', '/cos-thread')
    expect(first.status).toBe(200)
    expect(first.cache).toBe('private, no-store')
    expect(first.body).toEqual({
      protocol: 1, capTokens: 20_000,
      thread: { id: expect.stringMatching(/^th_[0-9a-f]{16}$/), startedAt: expect.any(String), lastAskAt: null, asks: 0, segments: 0, sessionId: null, provider: null, contextTokens: null },
      next: { mode: 'fresh', sessionId: null, reason: 'empty', digest: null },
    })
    const recorded = await h.call('POST', '/cos-thread/turn', { ...turn(1, 'sess0001'), provider: 'claude' })
    expect(recorded.status).toBe(200)
    expect(recorded.body.thread).toMatchObject({ asks: 1, segments: 1, sessionId: 'sess0001', provider: 'claude' })
    expect(recorded.body.next.reason).toBe('missing_session')  // no log yet
    h.log('sess0001', 20_000)
    expect((await h.call('GET', '/cos-thread')).body.next).toEqual({ mode: 'continue', sessionId: 'sess0001', reason: 'continue', digest: null })
    h.log('sess0001', 20_001)
    const size = (await h.call('GET', '/cos-thread')).body
    expect(size.thread.contextTokens).toBe(20_001)
    expect(size.next).toMatchObject({ mode: 'fresh', sessionId: null, reason: 'size' })
    expect(size.next.digest).toMatch(/^Earlier in this COS thread \(a summary carried over; ask COS to search History or Messages for more\):/)
    const again = await h.call('POST', '/cos-thread/turn', turn(1, 'sess0001'))
    expect(again.body.thread.asks).toBe(1)  // idempotent
    const rolled = (await h.call('POST', '/cos-thread/turn', turn(2, 'sess0002'))).body
    expect(rolled.thread).toMatchObject({ id: first.body.thread.id, asks: 2, segments: 2, sessionId: 'sess0002' })
    const fresh = await h.call('POST', '/cos-thread/new', {})
    expect(fresh.status).toBe(200)
    expect(fresh.body.thread).toMatchObject({ asks: 0, segments: 0, sessionId: null })
    expect(fresh.body.thread.id).not.toBe(first.body.thread.id)
    expect(fresh.body.next).toMatchObject({ mode: 'fresh', reason: 'manual', sessionId: null })
    expect(fresh.body.next.digest).toContain('question 2')
    const kinds = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)
    expect(kinds).toEqual(['thread', 'turn', 'rollover', 'turn', 'rollover', 'close', 'thread'])
    // An empty POST body is {} too.
    expect((await h.call('POST', '/cos-thread/new')).status).toBe(200)
    expect((await h.call('POST', '/cos-thread/new', { force: true })).status).toBe(400)
  })

  it('turn validation answers 400 invalid_turn and writes nothing', async () => {
    const h = await setup()
    await h.call('GET', '/cos-thread')
    const before = readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')
    for (const body of [{}, { ...turn(1, 'sess0001'), clientId: 'x' }, { ...turn(1, 'bad id!!') }, { ...turn(1, 'sess0001'), query: '' },
      { ...turn(1, 'sess0001'), messageNo: -1 }, { ...turn(1, 'sess0001'), provider: 'UPPER' }, { ...turn(1, 'sess0001'), answer: 'a'.repeat(40_001) },
      { ...turn(1, 'sess0001'), surprise: 1 }]) {
      const out = await h.call('POST', '/cos-thread/turn', body)
      expect(out.status, JSON.stringify(body).slice(0, 60)).toBe(400)
      expect(out.body).toEqual({ error: { code: 'invalid_turn' } })
    }
    expect(readFileSync(join(h.dir, 'ledger.jsonl'), 'utf8')).toBe(before)
  })

  it('search and threads', async () => {
    const h = await setup()
    await h.call('POST', '/cos-thread/turn', { ...turn(1, 'sess0001'), query: 'Where is the Waco itinerary?' })
    await h.call('POST', '/cos-thread/turn', { ...turn(2, 'sess0001'), answer: 'The WACO trip is Sunday.' })
    const s = await h.call('GET', '/cos-thread/search?q=waco&limit=5')
    expect(s.status).toBe(200)
    expect(s.cache).toBe('private, no-store')
    expect(s.body.scanned).toBe(2)
    expect(s.body.hits).toEqual([
      { threadId: expect.any(String), sessionId: 'sess0001', at: expect.any(String), query: 'question 2', answerHead: 'The WACO trip is Sunday.', messageNo: 602 },
      { threadId: expect.any(String), sessionId: 'sess0001', at: expect.any(String), query: 'Where is the Waco itinerary?', answerHead: 'answer 1', messageNo: 601 },
    ])
    for (const q of ['?q=a', '?q=' + 'x'.repeat(201), '', '?q=ok&limit=0', '?q=ok&limit=51', '?q=ok&limit=two']) {
      expect((await h.call('GET', '/cos-thread/search' + q)).status, q).toBe(400)
    }
    expect((await h.call('GET', '/cos-thread/search?q=ok&limit=50')).status).toBe(200)
    const list = await h.call('GET', '/cos-thread/threads?limit=10')
    expect(list.body).toEqual({ threads: [{ id: expect.any(String), startedAt: expect.any(String), endedAt: null, asks: 2, segments: 1, title: 'Where is the Waco itinerary?' }] })
    expect((await h.call('GET', '/cos-thread/threads?limit=0')).status).toBe(400)
  })

  it('a store that cannot open answers 503 cos_thread_unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-thread-route-')); roots.push(root)
    writeFileSync(join(root, 'cos-thread'), 'not a directory')
    const app = express(); app.use(express.json())
    app.use('/api', createCosThreadRouter({ enabled: () => true, thread: lazyCosThread(() => new CosThread({ dir: join(root, 'cos-thread') })) }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/cos-thread`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'cos_thread_unavailable' } })
  })
})

describe('health capability', () => {
  let server: Server | null = null
  let base = ''
  const saved = process.env.COS_DROP_IT
  beforeAll(async () => {
    const app = express(); app.use('/api', healthRouter)
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.COS_DROP_IT; else process.env.COS_DROP_IT = saved
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  })

  it('dropIt.thread is { protocol: 1 } only while Drop it is on; every other dropIt key stays', async () => {
    process.env.COS_DROP_IT = '1'
    const on = (await (await fetch(`${base}/api/health`)).json() as any).capabilities.dropIt
    expect(on).toEqual({ protocol: 1, enabled: true, source: 'env', p2Settings: 1, attachments: 5, thread: { protocol: 1 } })
    process.env.COS_DROP_IT = '0'
    const off = (await (await fetch(`${base}/api/health`)).json() as any).capabilities.dropIt
    expect(off).toEqual({ protocol: 1, enabled: false, source: 'env', p2Settings: 1, attachments: 5 })
    expect(dropItCapability({ COS_DROP_IT: '1' }).thread).toEqual({ protocol: 1 })
    expect('thread' in dropItCapability({ COS_DROP_IT: '0' })).toBe(false)
  }, 20_000)
})
