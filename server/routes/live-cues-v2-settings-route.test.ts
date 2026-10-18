// GET/POST /api/live-cues/v2/settings (6.76.2): COS Control's toggle. Real router behind the real token gate, a scratch
// data dir, and a module reload for "restart".
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'cues-v2-settings-'))
const saved = { ...process.env }
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_SCRIPTS_DIR
for (const k of ['COS_LIVE_CUES_V2', 'COS_LIVE_CUES', 'ANTHROPIC_API_KEY', 'SUBQ_API_KEY', 'TYPESAFE_API_KEY', 'COS_DECISION_PROVIDER', 'COS_DECISION_PROVIDER_CUES']) delete process.env[k]
let jevKey = true
vi.mock('../lib/jev.js', async (orig) => ({ ...(await orig<typeof import('../lib/jev.js')>()), resolveJevKey: () => (jevKey ? { key: 'k', source: 'env' as const } : null) }))
vi.mock('../lib/provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))
const TOKEN = 'test-token-not-real-0123456789'
const SETTINGS_FILE = join(dataDir, 'live-cues-v2-settings.json')

let server: Server
let base = ''
async function boot() {
  const { liveCuesRouter } = await import('./live-cues.js')
  const { requireApiToken } = await import('../lib/api-auth.js')
  const app = express(); app.use(express.json())
  app.use('/api', requireApiToken(TOKEN)); app.use('/api', liveCuesRouter)       // the order index.ts mounts them in
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`
}
async function restart() {
  const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
  shutdownLiveCuesV2()
  await new Promise<void>(r => server.close(() => r()))
  vi.resetModules()                                                                // a new process: every module-level cache is gone
  await boot()
}
beforeAll(boot)
afterAll(async () => {
  const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
  shutdownLiveCuesV2(); server.close(); process.env = saved; rmSync(dataDir, { recursive: true, force: true })
})
beforeEach(() => { delete process.env.COS_LIVE_CUES_V2; jevKey = true })
const auth = { 'x-cos-token': TOKEN }
const get = (path: string, headers: Record<string, string> = auth) => fetch(base + path, { headers })
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('live cues v2 settings routes', () => {
  it('both routes need the token like every /api route', async () => {
    expect((await get('/live-cues/v2/settings', {})).status).toBe(401)
    expect((await post('/live-cues/v2/settings', { enabled: true }, {})).status).toBe(401)
    expect((await get('/live-cues/v2/settings', { 'x-cos-token': 'wrong' })).status).toBe(401)
    expect(() => statSync(SETTINGS_FILE)).toThrow()                               // the refused POST wrote nothing
    expect((await get('/live-cues/v2/settings')).status).toBe(200)
  })

  it('default: off with source default, and the capability still says why and what it would use; nothing v2 is advertised', async () => {
    const body = await (await get('/live-cues/v2/settings')).json()
    expect(body).toEqual({ enabled: false, source: 'default',
      capability: { available: false, reason: 'master_flag_off', protocol: 2, model: 'claude-sonnet-5-5', memory: 'none', decisionProvider: 'jev' } })
    expect((await (await get('/live-cues/status')).json()).v2).toBeUndefined()
    const { liveCuesV2Advertised } = await import('../lib/live-cues-v2.js')
    expect(liveCuesV2Advertised()).toBeUndefined()                                 // what /api/health and /api/models spread
  })

  it('turning it on persists atomically and flips the advertised capability with no restart; the file survives a restart', async () => {
    const on = await post('/live-cues/v2/settings', { enabled: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ enabled: true, source: 'setting', capability: { available: true, protocol: 2, memory: 'none', decisionProvider: 'jev' } })
    expect(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))).toMatchObject({ schema: 1, enabled: true })
    expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o600)
    expect(await (await get('/live-cues/status')).json()).toMatchObject({ v2: { available: true, protocol: 2 } })
    const { liveCuesV2Advertised } = await import('../lib/live-cues-v2.js')
    expect(liveCuesV2Advertised()).toMatchObject({ available: true, decisionProvider: 'jev' })
    const start = await post('/live-cues/start', { sessionId: 'meeting_s1' })
    expect(await start.json()).toMatchObject({ armed: true, protocol: 2 })         // the v2 engine owns arming now
    await restart()
    expect(await (await get('/live-cues/v2/settings')).json()).toMatchObject({ enabled: true, source: 'setting' })
    expect(await (await get('/live-cues/status')).json()).toMatchObject({ v2: { available: true } })
  })

  it('turning it off stops running evaluations, keeps the meeting v2 for stop and status, and advertises nothing again', async () => {
    await post('/live-cues/v2/settings', { enabled: true })
    expect((await post('/live-cues/start', { sessionId: 'meeting_s2' })).status).toBe(200)
    const { peekLiveCuesV2 } = await import('../lib/live-cues-v2.js')
    const spy = vi.spyOn(peekLiveCuesV2()!, 'suspend')
    const off = await post('/live-cues/v2/settings', { enabled: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ enabled: false, source: 'setting', capability: { available: false, reason: 'master_flag_off' } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await (await get('/live-cues/status')).json()).v2).toBeUndefined()
    expect(await (await get('/live-cues/status?sessionId=meeting_s2')).json()).toMatchObject({ protocol: 2, enabled: false, session: { sessionId: 'meeting_s2', state: 'active' } })
    expect(await (await post('/live-cues/stop', { sessionId: 'meeting_s2' })).json()).toMatchObject({ protocol: 2, cues: [] })
    expect(await (await get('/live-cues/status?sessionId=meeting_s2')).json()).toMatchObject({ session: { state: 'ended' } })
    expect((await post('/live-cues/v2/settings', { enabled: false })).status).toBe(200)   // off again: no second suspend
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('with env COS_LIVE_CUES_V2=1 a request to turn it off is 409 env_forced and changes nothing; on is allowed', async () => {
    await post('/live-cues/v2/settings', { enabled: false })
    const before = readFileSync(SETTINGS_FILE, 'utf8')
    process.env.COS_LIVE_CUES_V2 = '1'
    expect(await (await get('/live-cues/v2/settings')).json()).toMatchObject({ enabled: true, source: 'env' })
    const refused = await post('/live-cues/v2/settings', { enabled: false })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'env_forced' })
    expect(readFileSync(SETTINGS_FILE, 'utf8')).toBe(before)
    const on = await post('/live-cues/v2/settings', { enabled: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ enabled: true, source: 'env' })
  })

  it('a body without a boolean enabled is 400 and writes nothing', async () => {
    const before = readFileSync(SETTINGS_FILE, 'utf8')
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, [true]]) {
      const r = await post('/live-cues/v2/settings', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(await r.json()).toEqual({ error: 'invalid_request' })
    }
    expect((await post('/live-cues/v2/settings', null)).status).toBe(400)          // refused by the JSON parser itself
    expect(readFileSync(SETTINGS_FILE, 'utf8')).toBe(before)
  })

  it('an unreadable settings file reads as no setting (off), never as on', async () => {
    writeFileSync(SETTINGS_FILE, '{"enabled": tru')
    await restart()
    expect(await (await get('/live-cues/v2/settings')).json()).toMatchObject({ enabled: false, source: 'default' })
    writeFileSync(SETTINGS_FILE, JSON.stringify({ enabled: 'yes' }))
    await restart()
    expect(await (await get('/live-cues/v2/settings')).json()).toMatchObject({ enabled: false, source: 'default' })
  })

  it('the real deps route SubQ on its own cue ledger and cap: decisionProvider subq, decision_cap_reached from subq-cues-usage.json', async () => {
    process.env.COS_LIVE_CUES_V2 = '1'
    process.env.COS_DECISION_PROVIDER_CUES = 'subq'
    process.env.COS_LIVE_CUES_SUBQ_DAILY_TOKENS = '500'
    try {
      await restart()
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: false, reason: 'decision_not_configured', decisionProvider: 'subq' })
      process.env.SUBQ_API_KEY = 'test-subq-key-not-real'
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: true, decisionProvider: 'subq' })
      const today = new Date().toISOString().slice(0, 10)
      writeFileSync(join(dataDir, 'subq-cues-usage.json'), JSON.stringify({ [today]: 500 }) + '\n', { mode: 0o600 })
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: false, reason: 'decision_cap_reached', decisionProvider: 'subq' })
      delete process.env.COS_DECISION_PROVIDER_CUES                                 // Jev key present: Jev, untouched by SubQ's spent ledger
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: true, decisionProvider: 'jev' })
      // COS Control's saved global choice and the global env both say SubQ: cues ignore them (calibrated on Jev).
      writeFileSync(join(dataDir, 'decision-provider.json'), JSON.stringify({ schema: 1, provider: 'subq', overrides: { session: 'subq', completion: 'subq', search: 'subq' } }) + '\n', { mode: 0o600 })
      process.env.COS_DECISION_PROVIDER = 'subq'
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: true, decisionProvider: 'jev' })
      delete process.env.COS_DECISION_PROVIDER
      jevKey = false                                                                // only a SubQ key: SubQ
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ reason: 'decision_cap_reached', decisionProvider: 'subq' })
      delete process.env.SUBQ_API_KEY                                               // no key at all
      expect((await (await get('/live-cues/v2/settings')).json()).capability).toMatchObject({ available: false, reason: 'decision_not_configured', decisionProvider: 'jev' })
    } finally {
      for (const k of ['COS_DECISION_PROVIDER_CUES', 'COS_DECISION_PROVIDER', 'COS_LIVE_CUES_SUBQ_DAILY_TOKENS', 'SUBQ_API_KEY']) delete process.env[k]
    }
  })
})
