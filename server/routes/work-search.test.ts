import express from 'express'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkSearchRouter, WORK_SEARCH_LOG_EVERY_MS } from './work-search.js'
import { readFileSync } from 'node:fs'
import { JEV_KEY_FILE, JEV_LIMITS, JEV_MODEL } from '../lib/jev.js'
import { WORK_SEARCH_LIMITS, WorkSearcher, createWorkSearchJevClient } from '../lib/work-search.js'

const KEY = 'ts_live_' + 'k'.repeat(32)
const ID = (n: number) => n.toString(16).padStart(12, '0')
const servers: Server[] = []
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'work search route.')); delete process.env.COS_JEV_SEARCH; if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE) })
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  rmSync(dir, { recursive: true, force: true }); delete process.env.COS_JEV_SEARCH; delete process.env.TYPESAFE_API_KEY
  vi.restoreAllMocks()
})

const board = [
  { id: ID(1), domain: 'quilt', text: 'Send the Jewel360 LinkedIn article to Nick', checked: false, workIdentity: ID(1) },
  { id: ID(2), domain: 'quilt', text: 'Launch the State of Pet report', checked: true, workIdentity: ID(2) },
  { id: ID(3), domain: 'personal', text: 'Book the dentist', checked: false, workIdentity: ID(9) },
]

async function setup(overrides: Record<string, unknown> = {}) {
  const deps = { searcher: { search: vi.fn(async () => ({ available: true, results: [], none: 1, cached: false, tokens: 0 })) },
    list: vi.fn(async () => board), ...overrides }
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createWorkSearchRouter(deps as any))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const post = (body: unknown, token = 't') => fetch(base + '/work/search', { method: 'POST', headers: { 'X-COS-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { deps, post }
}
const { queryMin: MIN, queryMax: MAX, maxCandidates: CAP } = WORK_SEARCH_LIMITS
const searched = (deps: any) => (deps.searcher.search.mock.calls.at(-1)?.[1] as Array<{ id: string }>).map(r => r.id)

it('is authenticated like the task routes and not cached by clients', async () => {
  const s = await setup()
  expect((await s.post({ query: 'nick' }, 'wrong')).status).toBe(401)
  const res = await s.post({ query: 'nick' })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('private, no-store')
})

it('validates the body: a 2 to 200 character query, a safe domain, a known scope, 12-hex ids, nothing else', async () => {
  const s = await setup()
  for (const bad of [{}, { query: 'a' }, { query: ' a ' }, { query: 'x'.repeat(MAX + 1) }, { query: 'x'.repeat(MIN - 1) }, { query: 7 }, { query: 'ok', domain: '../x' },
    { query: 'ok', scope: 'everything' }, { query: 'ok', ids: 'abc' }, { query: 'ok', ids: ['XYZ'] }, { query: 'ok', text: 'client task text' }, []]) {
    const res = await s.post(bad)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_search_request')
  }
  expect(s.deps.searcher.search).not.toHaveBeenCalled()
  expect((await s.post({ query: 'ok' })).status).toBe(200)
  expect((await s.post({ query: 'x'.repeat(MAX) })).status).toBe(200)
  expect(s.deps.searcher.search).toHaveBeenLastCalledWith('x'.repeat(MAX), expect.any(Array))
})

it('counts the query in code points: 150 emoji (300 UTF-16 units) are accepted, as Control counts them', async () => {
  const s = await setup()
  for (const ok of ['😀'.repeat(150), '😀'.repeat(MAX), '😀'.repeat(MIN)]) {
    const res = await s.post({ query: ok })
    expect(res.status).toBe(200)
    expect(s.deps.searcher.search).toHaveBeenLastCalledWith(ok, expect.any(Array))
  }
  for (const bad of ['😀'.repeat(MAX + 1), '😀'.repeat(MIN - 1)]) expect((await s.post({ query: bad })).status).toBe(400)
})

it('searches the board the view shows: domain, All work, Completed, or exact ids', async () => {
  const s = await setup()
  await s.post({ query: 'nick' }); expect(searched(s.deps)).toEqual([ID(1), ID(3)])                         // All work: open cards
  await s.post({ query: 'nick', domain: 'quilt' }); expect(searched(s.deps)).toEqual([ID(1), ID(2)])        // a domain board
  await s.post({ query: 'nick', scope: 'completed' }); expect(searched(s.deps)).toEqual([ID(2)])
  await s.post({ query: 'nick', scope: 'progress', ids: [ID(9), ID(2), ID(2)] }); expect(searched(s.deps)).toEqual([ID(2), ID(3)])
  expect(s.deps.searcher.search).toHaveBeenLastCalledWith('nick', expect.any(Array))
})

it('refuses more than 254 cards as too_many_candidates (HTTP 200), from ids or from the board', async () => {
  const s = await setup()
  const tooMany = Array.from({ length: CAP + 1 }, (_, i) => ID(i + 100))
  const res = await s.post({ query: 'nick', ids: tooMany })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ available: false, reason: 'too_many_candidates', message: expect.stringContaining(String(CAP)) })
  expect(s.deps.list).not.toHaveBeenCalled()  // refused before reading the board
  expect((await (await s.post({ query: 'nick', ids: tooMany.slice(1) })).json()).available).toBe(true)
  const big = await setup({ list: vi.fn(async () => tooMany.map(id => ({ id, domain: 'quilt', text: `Task ${id}`, checked: false }))) })
  expect(await (await big.post({ query: 'nick' })).json()).toMatchObject({ available: false, reason: 'too_many_candidates' })
  expect(big.deps.searcher.search).not.toHaveBeenCalled()
})

it('COS_JEV_SEARCH=0 turns it off before anything is read or sent', async () => {
  const s = await setup()
  process.env.COS_JEV_SEARCH = '0'
  expect(await (await s.post({ query: 'nick' })).json()).toMatchObject({ available: false, reason: 'search_off', message: expect.any(String) })
  expect(s.deps.list).not.toHaveBeenCalled(); expect(s.deps.searcher.search).not.toHaveBeenCalled()
  process.env.COS_JEV_SEARCH = '1'
  expect(await (await s.post({ query: 'nick' })).json()).toMatchObject({ available: true })
})

it('a board failure is a 503; a searcher failure degrades to jev_unavailable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const noBoard = await setup({ list: vi.fn(async () => { throw new Error('bridge down') }) })
  const res = await noBoard.post({ query: 'nick' })
  expect(res.status).toBe(503); expect((await res.json()).error.code).toBe('work_board_unavailable')
  const broken = await setup({ searcher: { search: vi.fn(async () => { throw new Error('boom') }) } })
  const degraded = await broken.post({ query: 'nick' })
  expect(degraded.status).toBe(200)  // advice only: Control keeps its word search, never an error
  expect(await degraded.json()).toEqual({ available: false, reason: 'jev_unavailable', message: expect.any(String) })
})

it('every degrade reason reaches the client as HTTP 200 { available: false, reason, message } through the real searcher', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ok = () => new Response(JSON.stringify({ model: JEV_MODEL, answers: { c: { choice: 't0', confidence: 0.9, probabilities: { t0: 0.9, none: 0.1 }, type: 'choice' } },
    usage: { input_tokens: 5_000 } }), { status: 200 })
  const cases: Array<{ reason: string; arrange: () => { fetchImpl: () => Promise<Response>; body?: Record<string, unknown> } }> = [
    { reason: 'jev_not_configured', arrange: () => { delete process.env.TYPESAFE_API_KEY; return { fetchImpl: async () => ok() } } },
    { reason: 'jev_cap_reached', arrange: () => { process.env.COS_JEV_SEARCH_DAILY_TOKENS = '5'; return { fetchImpl: async () => ok() } } },
    { reason: 'jev_unavailable', arrange: () => ({ fetchImpl: async () => new Response('', { status: 503 }) }) },
    { reason: 'jev_unavailable', arrange: () => ({ fetchImpl: async () => { throw new Error('offline') } }) },
    { reason: 'jev_key_rejected', arrange: () => ({ fetchImpl: async () => new Response('', { status: 401 }) }) },
    { reason: 'jev_request_rejected', arrange: () => ({ fetchImpl: async () => new Response('', { status: 413 }) }) },
    { reason: 'search_off', arrange: () => { process.env.COS_JEV_SEARCH = 'off'; return { fetchImpl: async () => ok() } } },
    { reason: 'too_many_candidates', arrange: () => ({ fetchImpl: async () => ok(), body: { ids: Array.from({ length: CAP + 1 }, (_, i) => ID(i + 1000)) } }) },
  ]
  for (const { reason, arrange } of cases) {
    process.env.TYPESAFE_API_KEY = KEY; delete process.env.COS_JEV_SEARCH; delete process.env.COS_JEV_SEARCH_DAILY_TOKENS
    const { fetchImpl, body } = arrange()
    const jev = createWorkSearchJevClient(vi.fn(fetchImpl) as unknown as typeof fetch, () => new Date('2026-10-06T23:00:00Z'), join(dir, `usage-${reason}-${Math.random()}.json`))
    const s = await setup({ searcher: new WorkSearcher(jev) })
    const res = await s.post({ query: 'pet campaign', ...body })
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out).toEqual({ available: false, reason, message: expect.any(String) })
    expect(out.message.length).toBeGreaterThan(10)
  }
  // The breaker: three failures, then jev_breaker_open without another request.
  process.env.TYPESAFE_API_KEY = KEY; delete process.env.COS_JEV_SEARCH; delete process.env.COS_JEV_SEARCH_DAILY_TOKENS
  const down = vi.fn(async () => new Response('', { status: 503 }))
  const s = await setup({ searcher: new WorkSearcher(createWorkSearchJevClient(down as unknown as typeof fetch, () => new Date('2026-10-06T23:00:00Z'), join(dir, 'breaker.json'))) })
  for (let i = 0; i < JEV_LIMITS.breakerFailures; i++) expect((await (await s.post({ query: `pet ${i}` })).json()).reason).toBe('jev_unavailable')
  const open = await s.post({ query: 'pet again' })
  expect(open.status).toBe(200)
  expect(await open.json()).toEqual({ available: false, reason: 'jev_breaker_open', message: expect.any(String) })
  expect(down).toHaveBeenCalledTimes(JEV_LIMITS.breakerFailures)
  delete process.env.COS_JEV_SEARCH_DAILY_TOKENS
})

it('end to end with a fake Jev: results by card id, then the cache, then each degrade reason', async () => {
  process.env.TYPESAFE_API_KEY = KEY
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MODEL,
    answers: { c: { choice: 't1', confidence: 0.8, probabilities: { t0: 0.15, t1: 0.8, none: 0.05 }, type: 'choice' } }, usage: { input_tokens: 4_321 } }), { status: 200 }))
  const jev = createWorkSearchJevClient(fetchImpl as unknown as typeof fetch, () => new Date('2026-10-06T23:00:00Z'), join(dir, 'usage.json'))
  const s = await setup({ searcher: new WorkSearcher(jev) })
  const first = await (await s.post({ query: 'pet campaign', domain: 'quilt' })).json()
  expect(first).toEqual({ available: true, results: [{ id: ID(2), p: 0.8 }, { id: ID(1), p: 0.15 }], none: 0.05, cached: false, tokens: 4_321 })
  expect(await (await s.post({ query: 'Pet Campaign', domain: 'quilt' })).json()).toMatchObject({ cached: true, tokens: 0 })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  delete process.env.TYPESAFE_API_KEY
  expect(await (await s.post({ query: 'dentist' })).json()).toMatchObject({ available: false, reason: 'jev_not_configured' })
})

it('logs each degrade reason once per 10 minutes, so a quiet fallback in Control still leaves a trace', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const now = vi.spyOn(Date, 'now')
  try {
    now.mockReturnValue(1_000_000)
    const s = await setup()
    process.env.COS_JEV_SEARCH = '0'
    await s.post({ query: 'nick' }); await s.post({ query: 'nick again' })
    const lines = () => warn.mock.calls.filter(c => c[0] === '[work-search] meaning search unavailable: search_off').length
    expect(lines()).toBe(1)
    now.mockReturnValue(1_000_000 + WORK_SEARCH_LOG_EVERY_MS - 1); await s.post({ query: 'nick' }); expect(lines()).toBe(1)
    now.mockReturnValue(1_000_000 + WORK_SEARCH_LOG_EVERY_MS); await s.post({ query: 'nick' }); expect(lines()).toBe(2)
  } finally { now.mockRestore() }
})

it('index.ts lets Work search past the mutation lease, before the lease is taken (source check: index.ts boots the server)', () => {
  const index = readFileSync(join(process.cwd(), 'server/index.ts'), 'utf8')
  const middleware = index.slice(index.indexOf("app.use('/api', (req, res, next) => {\n  if (req.method === 'GET'"), index.indexOf("acquireMaintenanceWork('api_mutation'"))
  expect(middleware.length).toBeGreaterThan(0)
  expect(middleware).toContain('if (isReadOnlyApiPost(req.method, req.path)) return next()')
  expect(index.split('isReadOnlyApiPost(').length - 1).toBe(1)
})
