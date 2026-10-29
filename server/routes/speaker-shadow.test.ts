// GET /api/speaker-shadow/* behind the real token gate. Read only: there is no write route.
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'speaker-shadow-route-'))
process.env.COS_DATA_DIR = join(scratch, 'data')

const { requireApiToken } = await import('../lib/api-auth.js')
const { appendSpeakerShadowRecord } = await import('../lib/speaker-shadow.js')
const { createSpeakerShadowRouter } = await import('./speaker-shadow.js')

const TOKEN = 'test-api-token'
const root = join(scratch, 'shadow')
let server: Server
let base = ''
const snapshot = () => ({ enabled: true, state: 'idle' as const, queued: 0, runsToday: 1, dailyCap: 12, breaker: { open: false, failures: 0, until: null }, lastRun: null, lastError: null, lastErrorDetail: null, deferredReason: null })

beforeAll(async () => {
  for (const [n, status] of [[1, 'proposed'], [2, 'skipped'], [3, 'failed']] as const) {
    await appendSpeakerShadowRecord(root, { schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: `2026-10-28T1${n}:00:00.000Z`, serverVersion: 't', sessionId: `mac_00000000-0000-4000-8000-00000000000${n}`, enqueuedAt: `2026-10-28T1${n}:00:00.000Z`, status, reason: null, detail: null, gates: {} as any })
  }
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', createSpeakerShadowRouter({ root: () => root, snapshot }))
  server = await new Promise<Server>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
})

const get = (path: string, token: string | null = TOKEN) => fetch(`${base}${path}`, { headers: token ? { 'X-Cos-Token': token } : {} })

describe('GET /api/speaker-shadow/*', () => {
  it('refuses a request without the token', async () => {
    expect((await get('/api/speaker-shadow/proposals', null)).status).toBe(401)
    expect((await get('/api/speaker-shadow/status', null)).status).toBe(401)
    expect((await get('/api/speaker-shadow/proposals', 'wrong')).status).toBe(401)
  })

  it('lists records newest first with the shadow state', async () => {
    const res = await get('/api/speaker-shadow/proposals?limit=2')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.logOnly).toBe(true)
    expect(body.shadow).toMatchObject({ enabled: true, state: 'idle', dailyCap: 12 })
    expect(body.records.map((r: any) => r.status)).toEqual(['failed', 'skipped'])
  })

  it('filters by session', async () => {
    const body = await (await get('/api/speaker-shadow/proposals?sessionId=mac_00000000-0000-4000-8000-000000000001')).json()
    expect(body.records.map((r: any) => r.sessionId)).toEqual(['mac_00000000-0000-4000-8000-000000000001'])
  })

  it('validates its query', async () => {
    expect((await get('/api/speaker-shadow/proposals?limit=0')).status).toBe(400)
    expect((await get('/api/speaker-shadow/proposals?limit=101')).status).toBe(400)
    expect((await get('/api/speaker-shadow/proposals?sessionId=../../etc')).status).toBe(400)
  })

  it('answers status', async () => {
    const body = await (await get('/api/speaker-shadow/status')).json()
    expect(body).toMatchObject({ logOnly: true, enabled: true, runsToday: 1, lastErrorDetail: null })
  })

  it('has no write route', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/speaker-shadow/proposals`, { method, headers: { 'X-Cos-Token': TOKEN } })
      expect(res.status).toBe(404)
    }
  })
})
