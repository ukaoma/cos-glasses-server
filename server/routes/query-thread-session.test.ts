/**
 * 7.0.39 (persistent COS thread, candidate 2; Q1 2026-11-14): the legacy POST /api/query never runs a chat in the
 * pinned COS thread's conversation. It would land there numbered, on the display bus and outside the thread store.
 * Real conversation store (the per-file data dir); the model router is a spy that must not be reached.
 */
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../lib/model-router.js', () => ({ callModelStreaming: vi.fn(async () => { model.calls++; return 'x' }) }))

let server: Server
let base = ''
beforeAll(async () => {
  const { queryRouter } = await import('./query.js')
  const app = express(); app.use(express.json()); app.use('/api', queryRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())) })

describe('legacy POST /api/query and the COS thread conversation', () => {
  it('refuses a thread conversation with 409 thread_session_web_only and never calls the model; an ordinary one is not refused here', async () => {
    const { createSession } = await import('../lib/conversation.js')
    const thread = createSession({ cosThread: true })
    const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'placeholder', sessionId: thread }) })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'thread_session_web_only' })
    expect(model.calls).toBe(0)
    const plain = createSession()
    const ok = await fetch(`${base}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'placeholder', sessionId: plain }) })
    expect(ok.status).toBe(200)   // the stream opens (the spy model never finishes it, so it is not read)
    await ok.body?.cancel()
    await vi.waitFor(() => expect(model.calls).toBe(1))
  })
})
