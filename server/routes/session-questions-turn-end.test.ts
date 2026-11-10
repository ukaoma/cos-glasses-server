// 7.0.18 (X1): the turn-end ask counters ride GET /api/session-questions (authenticated) only while
// COS_TURN_END_ASKS is on. Off, the response is 7.0.17's, key for key. Counts only, never words.
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { requireApiToken } from '../lib/api-auth.js'
import { PermissionBroker, brokerSignalSink } from '../lib/permission-broker.js'
import { SessionSignalStore } from '../lib/session-signal-store.js'
import { lastQuestionsPollAt } from '../lib/client-liveness.js'
import { createSessionQuestionsRouter } from './permission-broker.js'

const API_TOKEN = 'x1-turn-end-token-0123456789abcdef'
const servers: Server[] = []
const brokers: PermissionBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) b.stop?.()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})

async function keysWith(turnEndAskStats: (() => Record<string, number> | null) | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
  const broker = new PermissionBroker({
    now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true, lastQuestionsPollAt,
    readDeskIdleSeconds: async () => 1_000, deskIdleSeconds: () => 90, timeoutMs: () => 4_000,
    signals: brokerSignalSink(store), pollMs: 25,
  })
  brokers.push(broker)
  const app = express()
  app.use('/api', requireApiToken(API_TOKEN))
  app.use('/api', createSessionQuestionsRouter({ broker, apiToken: () => API_TOKEN, ...(turnEndAskStats ? { turnEndAskStats } : {}) }))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-questions`, { headers: { 'X-Cos-Token': API_TOKEN } })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('turnEndAsks on GET /api/session-questions', () => {
  it('present with the counters while the switch is on', async () => {
    const counters = { armed: 3, shown: 2, clearedByReply: 1, clearedByTurn: 1, agedOut: 0, tracked: 1 }
    const { status, body } = await keysWith(() => counters)
    expect(status).toBe(200)
    expect(body.turnEndAsks).toEqual(counters)
  })

  it('absent while it is off (null), with no dep (the runtime has no tracker in tests), or when the read throws', async () => {
    const off = await keysWith(() => null)
    const none = await keysWith(undefined)
    const broken = await keysWith(() => { throw new Error('boom') })
    for (const r of [off, none, broken]) {
      expect(r.status).toBe(200)
      expect('turnEndAsks' in r.body).toBe(false)
    }
    expect(Object.keys(off.body)).toEqual(Object.keys(none.body))
  })

  it('still behind the token', async () => {
    const store = new SessionSignalStore({ isCosSpawnedPid: () => false })
    const broker = new PermissionBroker({ now: () => Date.now(), mode: () => 'all', admissionsOpen: () => true, lastQuestionsPollAt, readDeskIdleSeconds: async () => 1_000, deskIdleSeconds: () => 90, timeoutMs: () => 4_000, signals: brokerSignalSink(store), pollMs: 25 })
    brokers.push(broker)
    const app = express()
    app.use('/api', createSessionQuestionsRouter({ broker, apiToken: () => API_TOKEN, turnEndAskStats: () => ({ armed: 1 }) }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-questions`)
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('turnEndAsks')
  })
})
