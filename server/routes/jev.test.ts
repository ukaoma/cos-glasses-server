import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createJevRouter } from './jev.js'

const KEY = 'ts_live_' + 'k'.repeat(32)
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })
const row = { domain: 'personal', id: 'a'.repeat(12), workIdentity: 'b'.repeat(12), text: 'Board text of the task', title: 'Board', meetingRefs: [{ recordId: 'r', title: 'Server QA' }] }
const status = { configured: true, source: 'config', usedToday: 0, dailyCap: 1_000_000, breakerOpenUntil: null, lastError: null }

async function setup(overrides: Record<string, unknown> = {}) {
  const deps = { jev: { status: vi.fn(() => status), resetForNewKey: vi.fn() }, recommender: { recommend: vi.fn(async () => ({ provider: 'jev', action: 'new' })) },
    list: vi.fn(async () => [row]), validate: vi.fn(async () => ({ ok: true })), save: vi.fn(), ...overrides }
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.header('X-COS-Token') === 't' ? next() : res.sendStatus(401))
  app.use('/api', createJevRouter(deps as any))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'X-COS-Token': 't', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { deps, base, call }
}

it('requires auth, validates the key live before saving, and never echoes it', async () => {
  const s = await setup()
  expect((await fetch(s.base + '/jev-key/status')).status).toBe(401)
  const res = await s.call('POST', '/jev-key/set', { key: `  ${KEY}  ` })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).not.toContain(KEY)
  expect(s.deps.validate).toHaveBeenCalledWith(KEY); expect(s.deps.save).toHaveBeenCalledWith(KEY)
  expect(s.deps.jev.resetForNewKey).toHaveBeenCalledTimes(1)  // a validated key starts with a closed breaker
  for (const bad of [{}, { key: 'short' }, { key: KEY + ' x' }, { key: KEY, extra: 1 }]) {
    expect((await s.call('POST', '/jev-key/set', bad)).status).toBe(400)
  }
  const refused = await setup({ validate: vi.fn(async () => ({ ok: false, status: 401, reason: 'TypeSafe did not accept this key.' })) })
  const r = await refused.call('POST', '/jev-key/set', { key: KEY })
  expect(r.status).toBe(400); expect((await r.json()).error).toMatchObject({ code: 'jev_key_not_accepted', message: 'TypeSafe did not accept this key.' })
  expect(refused.deps.save).not.toHaveBeenCalled(); expect(refused.deps.jev.resetForNewKey).not.toHaveBeenCalled()
  expect(await (await s.call('GET', '/jev-key/status')).json()).toEqual(status)
})

it('recommends from the board task, not client text, and never blocks the workspace', async () => {
  const s = await setup()
  const sessions = [{ id: 'claude:a', provider: 'claude', title: 'Server work' }]
  expect((await s.call('POST', '/work-board/session-recommendation', { domain: 'personal', id: 'a'.repeat(12), sessions })).status).toBe(200)
  expect(s.deps.recommender.recommend).toHaveBeenCalledWith({ task: { text: 'Board text of the task', domain: 'personal', meetings: ['Server QA'] }, sessions: [expect.objectContaining({ id: 'claude:a' })] })
  expect((await s.call('POST', '/work-board/session-recommendation', { domain: 'personal', id: 'b'.repeat(12), sessions })).status).toBe(200)  // by Work identity
  expect((await s.call('POST', '/work-board/session-recommendation', { domain: 'personal', id: 'c'.repeat(12), sessions })).status).toBe(404)
  for (const bad of [{ domain: 'personal', id: 'a'.repeat(12) }, { domain: '../x', id: 'a'.repeat(12), sessions }, { domain: 'personal', id: 'a'.repeat(12), sessions, text: 'inject' }]) {
    expect((await s.call('POST', '/work-board/session-recommendation', bad)).status).toBe(400)
  }
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const broken = await setup({ recommender: { recommend: vi.fn(async () => { throw new Error('boom') }) } })
    const res = await broken.call('POST', '/work-board/session-recommendation', { domain: 'personal', id: 'a'.repeat(12), sessions })
    expect(await res.json()).toEqual({ provider: 'none', reason: 'recommendation_unavailable' })
    expect(logged).toHaveBeenCalledWith('[jev] session recommendation failed:', 'boom')
  } finally { logged.mockRestore() }
})
