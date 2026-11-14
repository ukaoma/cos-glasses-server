/**
 * 7.0.39 (persistent COS thread, candidate 4): GET /api/cos-thread/timeline, COS's look-back by local day, over real HTTP
 * with the real store in a temp dir, an injected clock, and a spy in place of the sweeper. Placeholder words only.
 */
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCosThreadRouter } from './cos-thread.js'
import { CosThread, lazyCosThread } from '../lib/cos-thread.js'
import { localDay } from '../lib/local-day.js'

/** Local noon on 14 November 2026: "today" for every test here. */
const TODAY = new Date(2026, 10, 14, 12, 0, 0).getTime()
/** Local midnight `n` days from today's (negative: before), with an offset in ms. */
const midnight = (n: number, plus = 0) => new Date(2026, 10, 14 + n).getTime() + plus
const day = (n: number) => localDay(midnight(n))

const servers: Server[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
})
async function setup(options: { enabled?: boolean; broken?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cos-thread-lookback-route-')); roots.push(root)
  let clock = TODAY
  const thread = options.broken ? () => null : lazyCosThread(() => new CosThread({ dir: join(root, 'cos-thread'), now: () => clock, context: () => ({ found: true, tokens: 1 }) }))
  const app = express(); app.use(express.json())
  app.use('/api', createCosThreadRouter({ enabled: () => options.enabled ?? true, thread, archiveAnswer: () => undefined, startTimeline: () => {}, now: () => TODAY }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() as any } }
  const chat = (n: number, atMs: number) => {
    clock = atMs
    const t = thread()!
    t.recordTurn({ clientId: `web-${String(n).padStart(8, '0')}`, sessionId: 'sess0001', query: `question ${n}`, answer: `answer ${n}` })
    clock = TODAY
  }
  const crumb = (key: string, atMs: number) => thread()!.timeline().add([
    { key, at: new Date(atMs).toISOString(), kind: 'meeting', line: `meeting ${key}`, ref: { type: 'meeting', domain: 'quilt', month: '2026-11', filename: `${key}.md` } },
  ])
  return { get, chat, crumb }
}
const said = (body: any) => body.entries.map((e: any) => e.kind === 'chat' ? e.question : e.line)

describe('GET /cos-thread/timeline', () => {
  it('reads the last seven local days by default; one day by from and to; both ends whole days', async () => {
    const h = await setup()
    h.chat(1, midnight(-8, 3_600_000))          // 8 days ago
    h.chat(2, midnight(-6, -1))                 // the last millisecond of 7 days ago
    h.chat(3, midnight(-6))                     // the first millisecond of 6 days ago
    h.crumb('m6', midnight(-6, 60_000))
    h.chat(4, midnight(0, 1000))                // today
    h.chat(5, midnight(1))                      // tomorrow (a clock that moved): never in today's window
    const week = await h.get('/cos-thread/timeline')
    expect(week.status).toBe(200)
    expect(week.cache).toBe('private, no-store')
    expect(week.body).toMatchObject({ protocol: 1, from: day(-6), to: day(0), older: null })
    expect(said(week.body)).toEqual(['question 3', 'meeting m6', 'question 4'])
    expect(week.body.entries[0]).toMatchObject({ kind: 'chat', threadId: expect.any(String), answer: 'answer 3', full: true, status: 'completed' })
    const eight = await h.get(`/cos-thread/timeline?from=${day(-8)}&to=${day(-8)}`)
    expect(said(eight.body)).toEqual(['question 1'])
    const seven = await h.get(`/cos-thread/timeline?from=${day(-7)}&to=${day(-7)}`)
    expect(said(seven.body)).toEqual(['question 2'])
    // `to` alone: the seven days ending there. `from` alone: from there through today.
    expect(said((await h.get(`/cos-thread/timeline?to=${day(-7)}`)).body)).toEqual(['question 1', 'question 2'])
    expect((await h.get(`/cos-thread/timeline?to=${day(-7)}`)).body.from).toBe(day(-13))
    expect(said((await h.get(`/cos-thread/timeline?from=${day(-7)}`)).body)).toEqual(['question 2', 'question 3', 'meeting m6', 'question 4'])
  })

  it('kinds, limit and the older cursor', async () => {
    const h = await setup()
    for (let n = 1; n <= 5; n++) h.chat(n, midnight(-1, n * 60_000))
    h.crumb('m', midnight(-1, 150_000))
    const range = `from=${day(-1)}&to=${day(-1)}`
    expect(said((await h.get(`/cos-thread/timeline?${range}&kinds=meeting`)).body)).toEqual(['meeting m'])
    const first = await h.get(`/cos-thread/timeline?${range}&limit=2`)
    expect(said(first.body)).toEqual(['question 4', 'question 5'])
    expect(first.body.older).toMatch(/^c2\.\d+\.t[0-9a-f]+$/)
    const next = await h.get(`/cos-thread/timeline?${range}&limit=2&before=${first.body.older}`)
    expect(said(next.body)).toEqual(['meeting m', 'question 3'])
    const last = await h.get(`/cos-thread/timeline?${range}&limit=50&before=${next.body.older}`)
    expect(said(last.body)).toEqual(['question 1', 'question 2'])
    expect(last.body.older).toBeNull()
    expect((await h.get(`/cos-thread/timeline?${range}&limit=200`)).body.entries).toHaveLength(6)
  })

  it('50 entries by default', async () => {
    const h = await setup()
    for (let i = 1; i <= 51; i++) h.crumb(`m${String(i).padStart(2, '0')}`, midnight(-1, i * 1000))
    const page = await h.get(`/cos-thread/timeline?from=${day(-1)}&to=${day(-1)}`)
    expect(page.body.entries).toHaveLength(50)
    expect(page.body.entries[0].line).toBe('meeting m02')
    expect(page.body.older).not.toBeNull()
  })

  it('refuses a day that is not a real YYYY-MM-DD, from after to, and a bad limit, kind or cursor', async () => {
    const h = await setup()
    const code = async (q: string) => { const r = await h.get(`/cos-thread/timeline?${q}`); return [r.status, r.body.error?.code] }
    expect(await code('from=2026-02-30&to=2026-03-01')).toEqual([400, 'invalid_day'])
    expect(await code('from=2026-11-1')).toEqual([400, 'invalid_day'])
    expect(await code('to=yesterday')).toEqual([400, 'invalid_day'])
    expect(await code('to=2026-13-01')).toEqual([400, 'invalid_day'])
    expect(await code('from=2026-11-01&from=2026-11-02')).toEqual([400, 'invalid_day'])
    expect(await code('to=2026-11-01&to=2026-11-02')).toEqual([400, 'invalid_day'])
    expect(await code(`from=${day(-1)}&to=${day(-2)}`)).toEqual([400, 'invalid_range'])
    expect(await code(`from=${day(1)}`)).toEqual([400, 'invalid_range'])
    expect(await code(`from=${day(-2)}&to=${day(-2)}`)).toEqual([200, undefined])
    expect(await code('limit=0')).toEqual([400, 'invalid_limit'])
    expect(await code('limit=201')).toEqual([400, 'invalid_limit'])
    expect(await code('limit=200')).toEqual([200, undefined])
    expect(await code('kinds=chat,work')).toEqual([400, 'invalid_kinds'])
    expect(await code('kinds=')).toEqual([400, 'invalid_kinds'])
    expect(await code('kinds=chat,meeting,notification,session_question,message')).toEqual([200, undefined])
    expect(await code('before=c3.1.0.0.0')).toEqual([400, 'invalid_cursor'])
    expect(await code('before=c1.4')).toEqual([400, 'invalid_cursor'])
    expect(await code('before=nope')).toEqual([400, 'invalid_cursor'])
    expect(await code(`before=c2.${midnight(0)}.t0000000001`)).toEqual([200, undefined])
  })

  it('answers 404 while Drop it is off and 503 when the store cannot open', async () => {
    const off = await setup({ enabled: false })
    expect(await off.get('/cos-thread/timeline').then(r => [r.status, r.body.error.code])).toEqual([404, 'drop_it_off'])
    const broken = await setup({ broken: true })
    expect(await broken.get('/cos-thread/timeline').then(r => [r.status, r.body.error.code])).toEqual([503, 'cos_thread_unavailable'])
  })
})
