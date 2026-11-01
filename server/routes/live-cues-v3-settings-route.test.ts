// GET/POST /api/live-cues/v2/settings with v=3 (live cues v3): the cue mode, grounded cues and the general-cue limits. Real
// router behind the real token gate and a scratch data dir. The v1 body (unversioned) and the v2 body (v=2) must stay byte
// for byte what 6.97.4 answered: the first tests below pin them with strings captured from the unmodified route.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'cues-v3-settings-'))
const saved = { ...process.env }
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_SCRIPTS_DIR
const MODE_ENVS = ['COS_LIVE_CUES_MODE', 'COS_LIVE_CUES_GROUNDING']
const LIMIT_ENVS = ['COS_LIVE_CUES_V2_GATE', 'COS_LIVE_CUES_V2_MAX_PER_MEETING', 'COS_LIVE_CUES_V2_COOLDOWN_S', 'COS_LIVE_CUES_V2_DAILY_WRITER_CALLS']
const GENERAL_ENVS = ['COS_LIVE_CUES_GENERAL_INTERVAL_S', 'COS_LIVE_CUES_GENERAL_TRIGGER', 'COS_LIVE_CUES_GENERAL_ATTEMPTS', 'COS_LIVE_CUES_GENERAL_MAX_PER_MEETING',
  'COS_LIVE_CUES_GENERAL_DAILY_TOPIC_CALLS', 'COS_LIVE_CUES_GENERAL_DAILY_WEB_SEARCHES']
const clearEnv = () => { for (const k of ['COS_LIVE_CUES_V2', 'COS_LIVE_CUES', 'ANTHROPIC_API_KEY', 'SUBQ_API_KEY', 'TYPESAFE_API_KEY', 'COS_DECISION_PROVIDER', 'COS_DECISION_PROVIDER_CUES', ...MODE_ENVS, ...LIMIT_ENVS, ...GENERAL_ENVS]) delete process.env[k] }
clearEnv()
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
beforeEach(clearEnv)
const auth = { 'x-cos-token': TOKEN }
const get = (path: string) => fetch(base + path, { headers: auth })
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })
const fileText = () => (existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : null)
const fileJson = () => JSON.parse(fileText()!) as Record<string, unknown>
/** The wire text with the one wall-clock value (today's local day) replaced, so the string is stable across days. */
const wire = async (res: Response) => (await res.text()).replace(/"day":"\d{4}-\d{2}-\d{2}"/, '"day":"<day>"')

const GOLDEN = {
  getV1: '{"enabled":false,"source":"default","capability":{"available":false,"reason":"master_flag_off","protocol":2,"model":"claude-sonnet-5-5","memory":"none","decisionProvider":"jev"}}',
  postV1: '{"enabled":true,"source":"setting","capability":{"available":true,"protocol":2,"model":"claude-sonnet-5-5","memory":"none","decisionProvider":"jev"}}',
  getV2: '{"enabled":true,"source":"setting","capability":{"available":true,"protocol":2,"model":"claude-sonnet-5-5","memory":"none","decisionProvider":"jev"},"v":2,"limits":{"gate":{"value":0.8,"source":"default","locked":false,"min":0.5,"max":0.95,"default":0.8},"maxCuesPerMeeting":{"value":25,"source":"default","locked":false,"min":1,"max":25,"default":25},"cooldownSeconds":{"value":45,"source":"default","locked":false,"min":20,"max":900,"default":45},"dailyWriterCalls":{"value":150,"source":"default","locked":false,"min":1,"max":500,"default":150}},"writerCallsPerMeeting":50,"today":{"day":"<day>","writerCalls":0,"writerTokensIn":0,"writerTokensOut":0,"cues":0,"jevTokens":0}}',
  postV2: '{"enabled":true,"source":"setting","capability":{"available":true,"protocol":2,"model":"claude-sonnet-5-5","memory":"none","decisionProvider":"jev"},"v":2,"limits":{"gate":{"value":0.9,"source":"setting","locked":false,"min":0.5,"max":0.95,"default":0.8},"maxCuesPerMeeting":{"value":10,"source":"setting","locked":false,"min":1,"max":25,"default":25},"cooldownSeconds":{"value":45,"source":"default","locked":false,"min":20,"max":900,"default":45},"dailyWriterCalls":{"value":150,"source":"default","locked":false,"min":1,"max":500,"default":150}},"writerCallsPerMeeting":20,"today":{"day":"<day>","writerCalls":0,"writerTokensIn":0,"writerTokensOut":0,"cues":0,"jevTokens":0}}',
  getV2After: '{"enabled":true,"source":"setting","capability":{"available":true,"protocol":2,"model":"claude-sonnet-5-5","memory":"none","decisionProvider":"jev"},"v":2,"limits":{"gate":{"value":0.9,"source":"setting","locked":false,"min":0.5,"max":0.95,"default":0.8},"maxCuesPerMeeting":{"value":10,"source":"setting","locked":false,"min":1,"max":25,"default":25},"cooldownSeconds":{"value":45,"source":"default","locked":false,"min":20,"max":900,"default":45},"dailyWriterCalls":{"value":150,"source":"default","locked":false,"min":1,"max":500,"default":150}},"writerCallsPerMeeting":20,"today":{"day":"<day>","writerCalls":0,"writerTokensIn":0,"writerTokensOut":0,"cues":0,"jevTokens":0}}',
  file: '{"schema":2,"enabled":true,"gate":0.9,"maxCuesPerMeeting":10}',
}

describe('v1 and v2 bodies are byte for byte 6.97.4', () => {
  it('unversioned GET and POST, ?v=2 GET and POST {v:2}, and the file they leave', async () => {
    const out: Record<string, string> = {}
    out.getV1 = await wire(await get('/live-cues/v2/settings'))
    out.postV1 = await wire(await post('/live-cues/v2/settings', { enabled: true }))
    out.getV2 = await wire(await get('/live-cues/v2/settings?v=2'))
    out.postV2 = await wire(await post('/live-cues/v2/settings', { v: 2, gate: 0.9, maxCuesPerMeeting: 10 }))
    out.getV2After = await wire(await get('/live-cues/v2/settings?v=2'))
    const file = fileJson(); delete file.updatedAt
    out.file = JSON.stringify(file)
    expect(out).toEqual(GOLDEN)
  })
})
