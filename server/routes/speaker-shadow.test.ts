// GET /api/speaker-shadow/* behind the real token gate. Read only: there is no write route.
import express from 'express'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
let resumed = 0
const snapshot = () => ({ enabled: true, source: 'setting' as const, state: 'idle' as const, queued: 0, runsToday: 1, dailyCap: 12, breaker: { open: false, failures: 0, until: null }, lastRun: null, lastError: null, lastErrorDetail: null, deferredReason: null })

beforeAll(async () => {
  for (const [n, status] of [[1, 'proposed'], [2, 'skipped'], [3, 'failed']] as const) {
    await appendSpeakerShadowRecord(root, { schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: `2026-10-28T1${n}:00:00.000Z`, serverVersion: 't', sessionId: `mac_00000000-0000-4000-8000-00000000000${n}`, enqueuedAt: `2026-10-28T1${n}:00:00.000Z`, status, reason: null, detail: null, gates: {} as any })
  }
  const app = express()
  app.use(express.json())
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', createSpeakerShadowRouter({ root: () => root, snapshot, env: {}, onEnabled: () => { resumed++ } }))
  app.use('/api/pinned', requireApiToken(TOKEN))
  app.use('/api/pinned', createSpeakerShadowRouter({ root: () => join(scratch, 'pinned'), snapshot, env: { COS_SPEAKER_SHADOW: '0' } }))
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

  it('has no write route for proposals or status', async () => {
    for (const path of ['/api/speaker-shadow/proposals', '/api/speaker-shadow/status']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method, headers: { 'X-Cos-Token': TOKEN } })
        expect(res.status).toBe(404)
      }
    }
  })
})

describe('/api/speaker-shadow/settings: this Mac\'s switch', () => {
  const post = (body: unknown, prefix = '/api', token: string | null = TOKEN) => fetch(`${base}${prefix}/speaker-shadow/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Cos-Token': token } : {}) }, body: JSON.stringify(body) })

  it('is off by default and needs the token to change', async () => {
    expect(await (await get('/api/speaker-shadow/settings')).json()).toEqual({ enabled: false, source: 'default' })
    expect((await post({ enabled: true }, '/api', null)).status).toBe(401)
    expect(existsSync(join(root, 'settings.json'))).toBe(false)
  })

  it('turns it on and off, saved for this Mac only', async () => {
    const before = resumed
    expect(await (await post({ enabled: true })).json()).toEqual({ enabled: true, source: 'setting' })
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toMatchObject({ schema: 1, enabled: true })
    expect(resumed).toBe(before + 1)
    expect(await (await get('/api/speaker-shadow/settings')).json()).toEqual({ enabled: true, source: 'setting' })
    expect(await (await post({ enabled: false })).json()).toEqual({ enabled: false, source: 'setting' })
    expect(resumed).toBe(before + 1)
  })

  it('refuses anything but {"enabled": boolean}', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: true, extra: 1 }, [true]]) expect((await post(body)).status).toBe(400)
  })

  it('answers 409 env_forced when the environment pins the other value', async () => {
    expect(await (await get('/api/pinned/speaker-shadow/settings')).json()).toEqual({ enabled: false, source: 'env' })
    const res = await post({ enabled: true }, '/api/pinned')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'env_forced', enabled: false, source: 'env' })
    expect(existsSync(join(scratch, 'pinned', 'settings.json'))).toBe(false)
    expect((await post({ enabled: false }, '/api/pinned')).status).toBe(200)
  })
})
