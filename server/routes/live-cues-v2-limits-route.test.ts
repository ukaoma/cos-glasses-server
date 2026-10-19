// GET/POST /api/live-cues/v2/settings with v=2 (6.79.2): COS Control's spend limits. Real router behind the real token gate,
// a scratch data dir, and a module reload for "restart". The v1 body (an older Control) must stay byte for byte as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'cues-v2-limits-'))
const saved = { ...process.env }
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_SCRIPTS_DIR
const LIMIT_ENVS = ['COS_LIVE_CUES_V2_GATE', 'COS_LIVE_CUES_V2_MAX_PER_MEETING', 'COS_LIVE_CUES_V2_COOLDOWN_S', 'COS_LIVE_CUES_V2_DAILY_WRITER_CALLS']
for (const k of ['COS_LIVE_CUES_V2', 'COS_LIVE_CUES', 'ANTHROPIC_API_KEY', 'SUBQ_API_KEY', 'TYPESAFE_API_KEY', 'COS_DECISION_PROVIDER', 'COS_DECISION_PROVIDER_CUES', ...LIMIT_ENVS]) delete process.env[k]
vi.mock('../lib/jev.js', async (orig) => ({ ...(await orig<typeof import('../lib/jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('../lib/provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))
const TOKEN = 'test-token-not-real-0123456789'
const SETTINGS_FILE = join(dataDir, 'live-cues-v2-settings.json')

let server: Server
let base = ''
async function boot() {
  const { liveCuesRouter } = await import('./live-cues.js')
  const { requireApiToken } = await import('../lib/api-auth.js')
  const app = express(); app.use(express.json())
  app.use('/api', requireApiToken(TOKEN)); app.use('/api', liveCuesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`
}
async function restart() {
  const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
  shutdownLiveCuesV2()
  await new Promise<void>(r => server.close(() => r()))
  vi.resetModules()
  await boot()
}
beforeAll(boot)
afterAll(async () => {
  const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
  shutdownLiveCuesV2(); server.close(); process.env = saved; rmSync(dataDir, { recursive: true, force: true })
})
beforeEach(() => { for (const k of ['COS_LIVE_CUES_V2', ...LIMIT_ENVS]) delete process.env[k] })
const auth = { 'x-cos-token': TOKEN }
const get = (path: string) => fetch(base + path, { headers: auth })
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })
const fileText = () => (existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : null)
const DEFAULT_LIMITS = {
  gate: { value: 0.8, source: 'default', locked: false, min: 0.5, max: 0.95, default: 0.8 },
  maxCuesPerMeeting: { value: 25, source: 'default', locked: false, min: 1, max: 25, default: 25 },
  cooldownSeconds: { value: 45, source: 'default', locked: false, min: 20, max: 900, default: 45 },
  dailyWriterCalls: { value: 150, source: 'default', locked: false, min: 1, max: 500, default: 150 },
}

describe('live cues v2 limits (settings v2)', () => {
  it('an older Control (no v) gets exactly the v1 body from GET and POST, and the file stays schema 1', async () => {
    const g = await (await get('/live-cues/v2/settings')).json() as Record<string, unknown>
    expect(Object.keys(g).sort()).toEqual(['capability', 'enabled', 'source'])
    const p = await post('/live-cues/v2/settings', { enabled: true })
    expect(p.status).toBe(200)
    const body = await p.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['capability', 'enabled', 'source'])
    expect(body).toMatchObject({ enabled: true, source: 'setting' })
    expect(Object.keys(JSON.parse(fileText()!)).sort()).toEqual(['enabled', 'schema', 'updatedAt'])
    expect(JSON.parse(fileText()!)).toMatchObject({ schema: 1, enabled: true })
  })

  it('GET ?v=2: the v1 body plus every limit at its default, the writer cap and today\'s usage', async () => {
    const res = await get('/live-cues/v2/settings?v=2')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ v: 2, enabled: true, source: 'setting', capability: { protocol: 2 } })
    expect(body.limits).toEqual(DEFAULT_LIMITS)
    expect(body.writerCallsPerMeeting).toBe(50)
    expect(body.today).toEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), writerCalls: 0, writerTokensIn: 0, writerTokensOut: 0, cues: 0, jevTokens: 0 })
    expect((await get('/live-cues/v2/settings?v=3')).status).toBe(400)
  })

  it('POST v2 takes any subset, keeps the rest, writes once (schema 2, 0600), and the old toggle keeps the limits', async () => {
    const res = await post('/live-cues/v2/settings', { v: 2, gate: 0.9, maxCuesPerMeeting: 10 })
    expect(res.status).toBe(200)
    const body = await res.json() as { limits: typeof DEFAULT_LIMITS; writerCallsPerMeeting: number; v: number }
    expect(body.v).toBe(2)
    expect(body.limits.gate).toEqual({ ...DEFAULT_LIMITS.gate, value: 0.9, source: 'setting' })
    expect(body.limits.maxCuesPerMeeting).toEqual({ ...DEFAULT_LIMITS.maxCuesPerMeeting, value: 10, source: 'setting' })
    expect(body.limits.cooldownSeconds).toEqual(DEFAULT_LIMITS.cooldownSeconds)
    expect(body.writerCallsPerMeeting).toBe(20)
    expect(JSON.parse(fileText()!)).toMatchObject({ schema: 2, enabled: true, gate: 0.9, maxCuesPerMeeting: 10 })
    expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o600)
    await post('/live-cues/v2/settings', { v: 2, cooldownSeconds: 120, dailyWriterCalls: 40 })
    const off = await post('/live-cues/v2/settings', { enabled: false })                       // an older Control's toggle
    expect(Object.keys(await off.json() as object).sort()).toEqual(['capability', 'enabled', 'source'])
    expect(JSON.parse(fileText()!)).toMatchObject({ schema: 2, enabled: false, gate: 0.9, maxCuesPerMeeting: 10, cooldownSeconds: 120, dailyWriterCalls: 40 })
    expect((await post('/live-cues/v2/settings', { v: 2, enabled: true })).status).toBe(200)    // the switch through v2
    expect(JSON.parse(fileText()!)).toMatchObject({ enabled: true, gate: 0.9 })
  })

  it('saved limits survive a restart', async () => {
    await restart()
    const body = await (await get('/live-cues/v2/settings?v=2')).json() as { limits: typeof DEFAULT_LIMITS }
    expect([body.limits.gate.value, body.limits.maxCuesPerMeeting.value, body.limits.cooldownSeconds.value, body.limits.dailyWriterCalls.value]).toEqual([0.9, 10, 120, 40])
  })

  it('each bad v2 body is 400 with a reason and writes nothing', async () => {
    const before = fileText()
    const bad: Array<[unknown, Record<string, unknown>]> = [
      [{ v: 2, gate: 0.49 }, { reason: 'out_of_bounds', field: 'gate', min: 0.5, max: 0.95 }],
      [{ v: 2, gate: 0.96 }, { reason: 'out_of_bounds', field: 'gate' }],
      [{ v: 2, gate: '0.8' }, { reason: 'out_of_bounds', field: 'gate' }],
      [{ v: 2, maxCuesPerMeeting: 0 }, { reason: 'out_of_bounds', field: 'maxCuesPerMeeting', min: 1, max: 25, integer: true }],
      [{ v: 2, maxCuesPerMeeting: 26 }, { reason: 'out_of_bounds', field: 'maxCuesPerMeeting' }],
      [{ v: 2, maxCuesPerMeeting: 2.5 }, { reason: 'out_of_bounds', field: 'maxCuesPerMeeting' }],
      [{ v: 2, cooldownSeconds: 19 }, { reason: 'out_of_bounds', field: 'cooldownSeconds' }],
      [{ v: 2, cooldownSeconds: 901 }, { reason: 'out_of_bounds', field: 'cooldownSeconds' }],
      [{ v: 2, cooldownSeconds: 30.5 }, { reason: 'out_of_bounds', field: 'cooldownSeconds' }],
      [{ v: 2, dailyWriterCalls: 0 }, { reason: 'out_of_bounds', field: 'dailyWriterCalls', min: 1, max: 500 }],
      [{ v: 2, dailyWriterCalls: 501 }, { reason: 'out_of_bounds', field: 'dailyWriterCalls' }],
      [{ v: 2, gate: 0.9, dailyWriterCalls: 0 }, { reason: 'out_of_bounds', field: 'dailyWriterCalls' }],   // a good field does not land either
      [{ v: 2, gate: 0.9, weeklyWriterCalls: 10 }, { reason: 'unknown_field', field: 'weeklyWriterCalls' }],
      [{ v: 2 }, { reason: 'empty' }],
      [{ v: 2, enabled: 'yes' }, { reason: 'invalid_enabled' }],
      [{ v: 3, gate: 0.9 }, { reason: 'unsupported_version' }],
      [{ v: '2', gate: 0.9 }, { reason: 'unsupported_version' }],
    ]
    for (const [body, expected] of bad) {
      const res = await post('/live-cues/v2/settings', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ error: 'invalid_request', ...expected })
    }
    expect(fileText()).toBe(before)
  })

  it('an env var wins and locks its limit; a POST naming a locked limit is 409 and saves nothing, not even the other fields', async () => {
    Object.assign(process.env, { COS_LIVE_CUES_V2_GATE: '0.7', COS_LIVE_CUES_V2_MAX_PER_MEETING: '5', COS_LIVE_CUES_V2_COOLDOWN_S: '60', COS_LIVE_CUES_V2_DAILY_WRITER_CALLS: '30' })
    const body = await (await get('/live-cues/v2/settings?v=2')).json() as { limits: typeof DEFAULT_LIMITS; writerCallsPerMeeting: number }
    expect(body.limits.gate).toEqual({ ...DEFAULT_LIMITS.gate, value: 0.7, source: 'env', locked: true })
    expect(body.limits.maxCuesPerMeeting).toEqual({ ...DEFAULT_LIMITS.maxCuesPerMeeting, value: 5, source: 'env', locked: true })
    expect(body.limits.cooldownSeconds).toEqual({ ...DEFAULT_LIMITS.cooldownSeconds, value: 60, source: 'env', locked: true })
    expect(body.limits.dailyWriterCalls).toEqual({ ...DEFAULT_LIMITS.dailyWriterCalls, value: 30, source: 'env', locked: true })
    expect(body.writerCallsPerMeeting).toBe(10)
    const before = fileText()
    const refused = await post('/live-cues/v2/settings', { v: 2, gate: 0.6, dailyWriterCalls: 20 })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'env_locked', fields: ['gate', 'dailyWriterCalls'] })
    delete process.env.COS_LIVE_CUES_V2_DAILY_WRITER_CALLS
    expect((await post('/live-cues/v2/settings', { v: 2, gate: 0.6, dailyWriterCalls: 20 })).status).toBe(409)   // gate still locked
    expect(fileText()).toBe(before)
  })

  it('an env value outside its range does not lock: the saved setting applies, with one log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.COS_LIVE_CUES_V2_MAX_PER_MEETING = '99'
    const body = await (await get('/live-cues/v2/settings?v=2')).json() as { limits: typeof DEFAULT_LIMITS }
    expect(body.limits.maxCuesPerMeeting).toMatchObject({ value: 10, source: 'setting', locked: false })
    expect(warn.mock.calls.some(c => String(c[0]).includes('COS_LIVE_CUES_V2_MAX_PER_MEETING'))).toBe(true)
    for (const raw of ['5.5', '1e1', '-3']) {
      process.env.COS_LIVE_CUES_V2_MAX_PER_MEETING = raw                                    // whole numbers only
      const b = await (await get('/live-cues/v2/settings?v=2')).json() as { limits: typeof DEFAULT_LIMITS }
      expect(b.limits.maxCuesPerMeeting, raw).toMatchObject({ value: 10, source: 'setting', locked: false })
    }
    warn.mockRestore()
  })

  it('turning v2 off through v2 while env forces it on is 409 env_forced', async () => {
    process.env.COS_LIVE_CUES_V2 = '1'
    const refused = await post('/live-cues/v2/settings', { v: 2, enabled: false, gate: 0.85 })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'env_forced' })
    expect(JSON.parse(fileText()!).gate).toBe(0.9)
  })
})
