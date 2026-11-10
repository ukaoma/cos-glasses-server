// Final review S1 (lead 2026-11-10 02:09): a query job's event stream no longer outlives the browser sign-in that
// opened it. The /api gate stores a sign-in re-check for a cookie-admitted request (lib/api-auth.ts); the middleware
// here stands in for it so this route's heartbeat guard is driven alone. A job that never finishes keeps the stream
// open until its heartbeat.
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/conversation.js', () => ({ getOrCreateSession: () => 'http-session' }))

import { QueryJobCoordinator } from '../lib/query-job-coordinator.js'
import { QueryJobStore } from '../lib/query-job-store.js'
import { createQueryJobsRouter } from './query-jobs.js'
import { WEB_SESSION_RECHECK_LOCAL } from '../lib/api-auth.js'

const HEARTBEAT_MS = 1_000
let root = ''
let server: http.Server
let base = ''
const holds = { ok: true }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cos-query-job-signin-'))
  const coordinator = new QueryJobCoordinator(
    new QueryJobStore({ root, bootId: randomUUID() }),
    async context => {
      await context.callbacks.onStart({ provider: 'codex', resolvedModel: 'gpt-5', sessionId: context.request.sessionId })
      await new Promise(() => { /* never finishes: the stream stays open */ })
    },
    { resolveSessionId: () => 'http-session', partialFlushMs: 0 },
  )
  await coordinator.init()
  const app = express()
  app.use(express.json())
  app.use('/api', (req, res, next) => { if (req.headers['x-test-cookie']) res.locals[WEB_SESSION_RECHECK_LOCAL] = () => holds.ok; next() })
  app.use('/api', createQueryJobsRouter(coordinator, { enabled: () => true, heartbeatMs: HEARTBEAT_MS }))
  server = await new Promise<http.Server>(r => { const l = app.listen(0, '127.0.0.1', () => r(l)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  await rm(root, { recursive: true, force: true })
})

function opened(url: string, headers: Record<string, string>) {
  return new Promise<{ ended: Promise<boolean>; first: Promise<void>; close(): void }>((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let firstDone!: () => void
      const first = new Promise<void>(r => { firstDone = r })
      let endDone!: (v: boolean) => void
      const ended = new Promise<boolean>(r => { endDone = r })
      res.on('data', () => firstDone())
      res.on('end', () => endDone(true)); res.on('close', () => endDone(true))
      resolve({ ended, first, close: () => req.destroy() })
    })
    req.on('error', reject)
  })
}
const within = (p: Promise<boolean>, ms: number) => Promise.race([p, new Promise<boolean>(r => setTimeout(() => r(false), ms))])

describe('GET /api/query-jobs/:jobId/events re-checks a browser sign-in on every heartbeat (final review S1)', () => {
  it('a browser-opened stream ends at the next heartbeat once its sign-in fails; a token stream stays', async () => {
    const admission = await fetch(`${base}/api/query-jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientJobId: randomUUID(), generation: 1, query: 'keep streaming' }),
    })
    expect(admission.status).toBe(202)
    const { job } = await admission.json() as { job: { jobId: string } }
    const url = `${base}/api/query-jobs/${job.jobId}/events?generation=1&after=0`
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const browser = await opened(url, { 'x-test-cookie': '1' }), token = await opened(url, {})
      await browser.first; await token.first
      await new Promise(r => setTimeout(r, 100))   // the stream installs its heartbeat after the replay
      vi.advanceTimersByTime(HEARTBEAT_MS)
      expect(await within(browser.ended, 150), 'still signed in: stays open').toBe(false)
      holds.ok = false
      vi.advanceTimersByTime(HEARTBEAT_MS)
      expect(await within(browser.ended, 1_000), 'signed out: closed by the next heartbeat').toBe(true)
      expect(await within(token.ended, 150), 'a token stream never re-checks').toBe(false)
      token.close()
    } finally { vi.useRealTimers() }
  })
})
