// X1 (session catch-up): index.ts wires the READ-ONLY readers (never their side-effecting twins), and /api/health says
// whether the route exists (features.sessionCatchUp, lead 15:59 condition 6).
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { healthRouter } from './health.js'
import { __resetSessionCatchUpMountedForTests, markSessionCatchUpMounted } from '../lib/session-catch-up.js'

describe('X1 catch-up: index.ts wiring', () => {
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const start = index.indexOf('  catchUp: {')
  const block = start >= 0 ? index.slice(start, index.indexOf('  },', start) + 4) : ''

  it('each reader is the peek, never the twin that writes: peekTurnEndAsk not openTurnEndAsk, peekPendingFor not list(), readQueue only', () => {
    expect(block).toContain('view: (provider, sessionId, opts) => readSessionCatchUpView(provider, sessionId, opts),')
    expect(block).toContain('peekAsk: sessionId => peekTurnEndAsk(sessionId),')
    expect(block).toContain('asksTracked: () => turnEndAsksTracked(),')
    expect(block).toContain('queued: (provider, threadId, now) => readQueue(provider, threadId, now),')
    expect(block).toContain('pendingPrompts: sessionId => permissionBroker.peekPendingFor(sessionId),')
    expect(block).toContain('bootId: serverMetrics.bootId,')
    for (const twin of ['openTurnEndAsk', 'permissionBroker.list(', 'writeQueue', 'kickQueueDrain', 'attachBlocked', 'fencedReason']) expect(block, twin).not.toContain(twin)
  })

  it('it sits inside the bindings router call, and health is marked right after it, once', () => {
    const router = index.indexOf('app.use(\'/api\', createAgentSessionBindingsRouter({')
    expect(router).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(router)
    const mark = index.indexOf('markSessionCatchUpMounted()')
    expect(mark).toBeGreaterThan(start)
    expect(index.split('markSessionCatchUpMounted()').length - 1).toBe(1)
    // The same /api token gate is in front of it as in front of the detail route.
    const gate = index.indexOf('app.use(\'/api\', requireApiToken(')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(index.indexOf('app.use(\'/api\', agentSessionsRouter)'))
    expect(gate).toBeLessThan(router)
  })
})

describe('X1 catch-up: features.sessionCatchUp on /api/health', () => {
  let server: Server | null = null
  let base = ''
  beforeAll(async () => {
    const app = express()
    app.use('/api', healthRouter)
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())) })
  afterEach(() => __resetSessionCatchUpMountedForTests())

  it('false until index.ts mounts the route, true after', async () => {
    __resetSessionCatchUpMountedForTests()
    expect(((await (await fetch(`${base}/api/health`)).json()) as any).features.sessionCatchUp).toBe(false)
    markSessionCatchUpMounted()
    expect(((await (await fetch(`${base}/api/health`)).json()) as any).features.sessionCatchUp).toBe(true)
  }, 20_000)
})
