import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'cues-v2-route-'))
process.env.COS_DATA_DIR = dataDir
vi.mock('../lib/jev.js', async (orig) => ({ ...(await orig<typeof import('../lib/jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('../lib/provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))
const { liveCuesRouter } = await import('./live-cues.js')
const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')

let server: Server
let base = ''
const saved = { ...process.env }
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api', liveCuesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`
})
afterAll(() => { server.close(); shutdownLiveCuesV2(); process.env = saved; rmSync(dataDir, { recursive: true, force: true }) })
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('live cues v2 routes', () => {
  it('with v2 off: pause and feedback are 404, and status advertises the v2 capability as off', async () => {
    delete process.env.COS_LIVE_CUES_V2; process.env.COS_LIVE_CUES = '1'
    expect((await post('/live-cues/pause', { sessionId: 'meeting_a', paused: true })).status).toBe(404)
    expect((await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: '0f8fad5b-d9cb-469f-a165-70867728950e', vote: 'up' })).status).toBe(404)
    const status = await (await fetch(base + '/live-cues/status')).json() as { v2: { available: boolean; reason: string; protocol: number } }
    expect(status.v2).toMatchObject({ available: false, reason: 'master_flag_off', protocol: 2 })
  })

  it('with v2 on: start, status, pause, feedback, stop, then a re-start is refused for the ended meeting', async () => {
    process.env.COS_LIVE_CUES = '1'; process.env.COS_LIVE_CUES_V2 = '1'; delete process.env.ANTHROPIC_API_KEY
    const start = await post('/live-cues/start', { sessionId: 'meeting_b' })
    expect(start.status).toBe(200)
    expect(await start.json()).toMatchObject({ armed: true, sessionId: 'meeting_b', protocol: 2, cuesGenerated: 0, paused: false })
    expect(await (await fetch(base + '/live-cues/status?sessionId=meeting_b')).json())
      .toMatchObject({ protocol: 2, enabled: true, session: { sessionId: 'meeting_b', paused: false, ended: false, cues: [] } })
    expect((await post('/live-cues/pause', { sessionId: 'meeting_b' })).status).toBe(400)
    expect(await (await post('/live-cues/pause', { sessionId: 'meeting_b', paused: true })).json()).toEqual({ ok: true, paused: true })
    expect((await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: 'x', vote: 'up' })).status).toBe(400)
    expect((await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: '0f8fad5b-d9cb-469f-a165-70867728950e', vote: 'sideways' })).status).toBe(400)
    expect(await (await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: '0f8fad5b-d9cb-469f-a165-70867728950e', vote: 'down', reason: 'wrong client' })).json())
      .toEqual({ ok: true, knownCue: false })
    expect(await (await post('/live-cues/stop', { sessionId: 'meeting_b' })).json()).toMatchObject({ protocol: 2, nudgesGenerated: 0, nudges: [], cues: [] })
    const again = await post('/live-cues/start', { sessionId: 'meeting_b' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ reason: 'meeting_ended', protocol: 2 })
  })
})
