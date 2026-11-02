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

const DEFAULT_GENERAL = {
  intervalSeconds: { value: 300, source: 'default', locked: false, min: 120, max: 1800, default: 300 },
  trigger: { value: 0.6, source: 'default', locked: false, min: 0.4, max: 0.9, default: 0.6 },
  attemptsPerMeeting: { value: 8, source: 'default', locked: false, min: 1, max: 30, default: 8 },
  maxCuesPerMeeting: { value: 4, source: 'default', locked: false, min: 1, max: 12, default: 4 },
  dailyTopicCalls: { value: 60, source: 'default', locked: false, min: 1, max: 200, default: 60 },
  dailyWebSearches: { value: 30, source: 'default', locked: false, min: 1, max: 100, default: 30 },
}
const ZERO_TODAY = { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), topicCalls: 0, webSearches: 0, breakerOpenUntil: null }
/** 6.97.8: the additive web ledger view. A fresh data dir counts nothing, and says the file is readable. */
const ZERO_WEB_TODAY = { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), readable: true, cues: { searches: 0, pagesRead: 0 }, ask: { searches: 0, pagesRead: 0 }, factCheck: { searches: 0, pagesRead: 0 },
  withheld: { total: 0, byReason: {}, byFeature: { cues: 0, ask: 0, factCheck: 0 } } }

describe('settings v3 (live cues v3)', () => {
  it('GET ?v=3 is the v2 body with v 3, plus the cue mode, grounding and the six general limits at their defaults', async () => {
    const res = await get('/live-cues/v2/settings?v=3')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const v3 = await res.json() as Record<string, unknown>
    const v2 = await (await get('/live-cues/v2/settings?v=2')).json() as Record<string, unknown>
    expect(v3).toEqual({ ...v2, v: 3, cueMode: { value: 'focused', source: 'default', locked: false }, grounding: { value: 'classic', source: 'default', locked: false },
      general: { limits: DEFAULT_GENERAL, today: ZERO_TODAY, publicTopics: false, homeArea: null }, webToday: ZERO_WEB_TODAY })
    expect(v3.limits).toEqual(v2.limits)
  })

  it('any other version is 400 unsupported_version, from GET and from POST', async () => {
    for (const q of ['4', '1', 'abc', '3.0', '']) {
      const res = await get(`/live-cues/v2/settings?v=${q}`)
      expect(res.status, q).toBe(400)
      expect(await res.json(), q).toEqual({ error: 'invalid_request', reason: 'unsupported_version' })
    }
    for (const v of [4, 1, '3', null, 3.5]) expect((await post('/live-cues/v2/settings', { v, cueMode: 'general' })).status, String(v)).toBe(400)
  })

  it('POST v3 takes any subset in ONE write (schema 3, 0600), answers the v3 body, and the older writers keep every v3 field', async () => {
    const before = fileJson()
    const res = await post('/live-cues/v2/settings', { v: 3, cueMode: 'general', grounding: 'grounded', generalIntervalSeconds: 600, generalTrigger: 0.75, generalMaxCuesPerMeeting: 2 })
    expect(res.status).toBe(200)
    const body = await res.json() as { v: number; cueMode: unknown; grounding: unknown; general: { limits: typeof DEFAULT_GENERAL } }
    expect(body.v).toBe(3)
    expect(body.cueMode).toEqual({ value: 'general', source: 'setting', locked: false })
    expect(body.grounding).toEqual({ value: 'grounded', source: 'setting', locked: false })
    expect(body.general.limits.intervalSeconds).toEqual({ ...DEFAULT_GENERAL.intervalSeconds, value: 600, source: 'setting' })
    expect(body.general.limits.trigger).toEqual({ ...DEFAULT_GENERAL.trigger, value: 0.75, source: 'setting' })
    expect(body.general.limits.maxCuesPerMeeting).toEqual({ ...DEFAULT_GENERAL.maxCuesPerMeeting, value: 2, source: 'setting' })
    expect(body.general.limits.attemptsPerMeeting).toEqual(DEFAULT_GENERAL.attemptsPerMeeting)
    const file = fileJson()
    expect(file).toMatchObject({ schema: 3, enabled: before.enabled, gate: 0.9, maxCuesPerMeeting: 10, cueMode: 'general', grounding: 'grounded', generalIntervalSeconds: 600, generalTrigger: 0.75, generalMaxCuesPerMeeting: 2 })
    expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o600)
    // The v1 toggle and a v2 limit change leave the v3 fields alone, and v1 and v2 answer their own bodies.
    const v1 = await post('/live-cues/v2/settings', { enabled: true })
    expect(Object.keys(await v1.json() as object).sort()).toEqual(['capability', 'enabled', 'source'])
    const v2 = await post('/live-cues/v2/settings', { v: 2, cooldownSeconds: 90 })
    expect(Object.keys(await v2.json() as object).sort()).toEqual(['capability', 'enabled', 'limits', 'source', 'today', 'v', 'writerCallsPerMeeting'])
    expect(fileJson()).toMatchObject({ schema: 3, cueMode: 'general', grounding: 'grounded', generalIntervalSeconds: 600, generalTrigger: 0.75, generalMaxCuesPerMeeting: 2, cooldownSeconds: 90 })
    // v3 can carry the v2 fields too.
    expect((await post('/live-cues/v2/settings', { v: 3, enabled: true, gate: 0.85 })).status).toBe(200)
    expect(fileJson()).toMatchObject({ gate: 0.85, cueMode: 'general' })
  })

  it('saved v3 values survive a restart', async () => {
    await restart()
    const body = await (await get('/live-cues/v2/settings?v=3')).json() as { cueMode: { value: string }; grounding: { value: string }; general: { limits: typeof DEFAULT_GENERAL } }
    expect([body.cueMode.value, body.grounding.value, body.general.limits.intervalSeconds.value, body.general.limits.trigger.value, body.general.limits.maxCuesPerMeeting.value]).toEqual(['general', 'grounded', 600, 0.75, 2])
  })

  it('each bad v3 body is 400 with a reason, and writes nothing', async () => {
    const before = fileText()
    const bad: Array<[unknown, Record<string, unknown>]> = [
      [{ v: 3, cueMode: 'loud' }, { reason: 'invalid_value', field: 'cueMode' }],
      [{ v: 3, cueMode: 1 }, { reason: 'invalid_value', field: 'cueMode' }],
      [{ v: 3, cueMode: null }, { reason: 'invalid_value', field: 'cueMode' }],
      [{ v: 3, grounding: 'on' }, { reason: 'invalid_value', field: 'grounding' }],
      [{ v: 3, grounding: true }, { reason: 'invalid_value', field: 'grounding' }],
      [{ v: 3, cueModes: 'general' }, { reason: 'unknown_field', field: 'cueModes' }],
      [{ v: 3, cueMode: 'general', weeklyWriterCalls: 10 }, { reason: 'unknown_field', field: 'weeklyWriterCalls' }],
      [{ v: 3, generalTrigger: 0.7, local: 'Austin' }, { reason: 'unknown_field', field: 'local' }],
      [{ v: 3, enabled: 'yes' }, { reason: 'invalid_enabled', field: 'enabled' }],
      [{ v: 3 }, { reason: 'empty' }],
      [{ v: 3, generalIntervalSeconds: 119 }, { reason: 'out_of_bounds', field: 'generalIntervalSeconds', min: 120, max: 1800, integer: true }],
      [{ v: 3, generalIntervalSeconds: 1801 }, { reason: 'out_of_bounds', field: 'generalIntervalSeconds' }],
      [{ v: 3, generalIntervalSeconds: 300.5 }, { reason: 'out_of_bounds', field: 'generalIntervalSeconds' }],
      [{ v: 3, generalTrigger: 0.39 }, { reason: 'out_of_bounds', field: 'generalTrigger', min: 0.4, max: 0.9, integer: false }],
      [{ v: 3, generalTrigger: 0.91 }, { reason: 'out_of_bounds', field: 'generalTrigger' }],
      [{ v: 3, generalTrigger: '0.6' }, { reason: 'out_of_bounds', field: 'generalTrigger' }],
      [{ v: 3, generalAttemptsPerMeeting: 0 }, { reason: 'out_of_bounds', field: 'generalAttemptsPerMeeting', min: 1, max: 30, integer: true }],
      [{ v: 3, generalAttemptsPerMeeting: 31 }, { reason: 'out_of_bounds', field: 'generalAttemptsPerMeeting' }],
      [{ v: 3, generalMaxCuesPerMeeting: 0 }, { reason: 'out_of_bounds', field: 'generalMaxCuesPerMeeting', min: 1, max: 12 }],
      [{ v: 3, generalMaxCuesPerMeeting: 13 }, { reason: 'out_of_bounds', field: 'generalMaxCuesPerMeeting' }],
      [{ v: 3, generalDailyTopicCalls: 0 }, { reason: 'out_of_bounds', field: 'generalDailyTopicCalls', min: 1, max: 200 }],
      [{ v: 3, generalDailyTopicCalls: 201 }, { reason: 'out_of_bounds', field: 'generalDailyTopicCalls' }],
      [{ v: 3, generalDailyWebSearches: 0 }, { reason: 'out_of_bounds', field: 'generalDailyWebSearches', min: 1, max: 100 }],
      [{ v: 3, generalDailyWebSearches: 101 }, { reason: 'out_of_bounds', field: 'generalDailyWebSearches' }],
      [{ v: 3, gate: 0.96 }, { reason: 'out_of_bounds', field: 'gate' }],                                  // a v2 limit through v3
      [{ v: 3, cueMode: 'all', generalDailyWebSearches: 0 }, { reason: 'out_of_bounds', field: 'generalDailyWebSearches' }],   // a good field does not land either
    ]
    for (const [body, expected] of bad) {
      const res = await post('/live-cues/v2/settings', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ error: 'invalid_request', ...expected })
    }
    expect(fileText()).toBe(before)
  })

  it('every bound is inclusive: the min and the max of each general limit are accepted', async () => {
    const edges = { generalIntervalSeconds: [120, 1800], generalTrigger: [0.4, 0.9], generalAttemptsPerMeeting: [1, 30], generalMaxCuesPerMeeting: [1, 12], generalDailyTopicCalls: [1, 200], generalDailyWebSearches: [1, 100] } as const
    for (const [field, [min, max]] of Object.entries(edges)) {
      for (const value of [min, max]) expect((await post('/live-cues/v2/settings', { v: 3, [field]: value })).status, `${field}=${value}`).toBe(200)
    }
    await post('/live-cues/v2/settings', { v: 3, generalIntervalSeconds: 600, generalTrigger: 0.75, generalMaxCuesPerMeeting: 2 })
  })

  it('v2 refuses every v3 field as unknown, exactly as before, and the older body is unchanged', async () => {
    const before = fileText()
    for (const body of [{ v: 2, cueMode: 'general' }, { v: 2, grounding: 'grounded' }, { v: 2, generalTrigger: 0.7 }, { v: 2, gate: 0.9, generalDailyTopicCalls: 5 }]) {
      const res = await post('/live-cues/v2/settings', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ error: 'invalid_request', reason: 'unknown_field' })
    }
    expect(fileText()).toBe(before)
  })

  it('env COS_LIVE_CUES_MODE=focused forces focused: the view says so, general and all are 409 env_forced and save nothing, focused is allowed', async () => {
    process.env.COS_LIVE_CUES_MODE = 'focused'
    const view = await (await get('/live-cues/v2/settings?v=3')).json() as { cueMode: unknown }
    expect(view.cueMode).toEqual({ value: 'focused', source: 'env', locked: true })
    const before = fileText()
    for (const cueMode of ['general', 'all']) {
      const res = await post('/live-cues/v2/settings', { v: 3, cueMode, generalTrigger: 0.5 })
      expect(res.status, cueMode).toBe(409)
      expect(await res.json(), cueMode).toEqual({ error: 'env_forced', fields: ['cueMode'] })
    }
    expect(fileText()).toBe(before)
    expect((await post('/live-cues/v2/settings', { v: 3, cueMode: 'focused' })).status).toBe(200)
    expect(fileJson().cueMode).toBe('focused')
    await post('/live-cues/v2/settings', { v: 3, cueMode: 'general' }).catch(() => undefined)   // refused while forced
    delete process.env.COS_LIVE_CUES_MODE
    expect((await post('/live-cues/v2/settings', { v: 3, cueMode: 'general' })).status).toBe(200)
  })

  it('env COS_LIVE_CUES_GROUNDING=classic forces classic the same way, and any other env value defers to the setting', async () => {
    process.env.COS_LIVE_CUES_GROUNDING = 'classic'
    expect((await (await get('/live-cues/v2/settings?v=3')).json() as { grounding: unknown }).grounding).toEqual({ value: 'classic', source: 'env', locked: true })
    const refused = await post('/live-cues/v2/settings', { v: 3, grounding: 'grounded' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'env_forced', fields: ['grounding'] })
    expect((await post('/live-cues/v2/settings', { v: 3, grounding: 'classic' })).status).toBe(200)
    for (const [name, value] of [['COS_LIVE_CUES_GROUNDING', 'grounded'], ['COS_LIVE_CUES_GROUNDING', 'Classic'], ['COS_LIVE_CUES_MODE', 'general'], ['COS_LIVE_CUES_MODE', 'Focused'], ['COS_LIVE_CUES_MODE', 'all']]) {
      clearEnv(); process.env[name] = value
      const view = await (await get('/live-cues/v2/settings?v=3')).json() as { cueMode: { source: string; locked: boolean }; grounding: { source: string; locked: boolean } }
      expect([view.cueMode.source, view.cueMode.locked, view.grounding.source, view.grounding.locked], `${name}=${value}`).toEqual(['setting', false, 'setting', false])
    }
    clearEnv()
    expect((await post('/live-cues/v2/settings', { v: 3, grounding: 'grounded' })).status).toBe(200)
  })

  it('an env var for a general limit wins and locks it: a POST naming it is 409 env_locked with the wire name and saves nothing, other fields included', async () => {
    Object.assign(process.env, { COS_LIVE_CUES_GENERAL_INTERVAL_S: '240', COS_LIVE_CUES_GENERAL_TRIGGER: '0.5', COS_LIVE_CUES_GENERAL_ATTEMPTS: '5', COS_LIVE_CUES_GENERAL_MAX_PER_MEETING: '3',
      COS_LIVE_CUES_GENERAL_DAILY_TOPIC_CALLS: '20', COS_LIVE_CUES_GENERAL_DAILY_WEB_SEARCHES: '10' })
    const view = await (await get('/live-cues/v2/settings?v=3')).json() as { general: { limits: typeof DEFAULT_GENERAL } }
    expect(view.general.limits.intervalSeconds).toEqual({ ...DEFAULT_GENERAL.intervalSeconds, value: 240, source: 'env', locked: true })
    expect(view.general.limits.trigger).toEqual({ ...DEFAULT_GENERAL.trigger, value: 0.5, source: 'env', locked: true })
    expect(view.general.limits.attemptsPerMeeting).toEqual({ ...DEFAULT_GENERAL.attemptsPerMeeting, value: 5, source: 'env', locked: true })
    expect(view.general.limits.maxCuesPerMeeting).toEqual({ ...DEFAULT_GENERAL.maxCuesPerMeeting, value: 3, source: 'env', locked: true })
    expect(view.general.limits.dailyTopicCalls).toEqual({ ...DEFAULT_GENERAL.dailyTopicCalls, value: 20, source: 'env', locked: true })
    expect(view.general.limits.dailyWebSearches).toEqual({ ...DEFAULT_GENERAL.dailyWebSearches, value: 10, source: 'env', locked: true })
    const before = fileText()
    const refused = await post('/live-cues/v2/settings', { v: 3, cueMode: 'all', gate: 0.7, generalIntervalSeconds: 300, generalDailyWebSearches: 5 })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'env_locked', fields: ['generalIntervalSeconds', 'generalDailyWebSearches'] })
    expect(fileText()).toBe(before)
    delete process.env.COS_LIVE_CUES_GENERAL_INTERVAL_S; delete process.env.COS_LIVE_CUES_GENERAL_DAILY_WEB_SEARCHES
    expect((await post('/live-cues/v2/settings', { v: 3, generalIntervalSeconds: 300, generalDailyWebSearches: 5 })).status).toBe(200)
    clearEnv()
  })

  it('a general-limit env value outside its range does not lock: the saved value applies, with one log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post('/live-cues/v2/settings', { v: 3, generalMaxCuesPerMeeting: 6, generalTrigger: 0.65 })
    for (const [name, raw] of [['COS_LIVE_CUES_GENERAL_MAX_PER_MEETING', '13'], ['COS_LIVE_CUES_GENERAL_MAX_PER_MEETING', '2.5'], ['COS_LIVE_CUES_GENERAL_MAX_PER_MEETING', '0'],
      ['COS_LIVE_CUES_GENERAL_TRIGGER', '0.95'], ['COS_LIVE_CUES_GENERAL_TRIGGER', 'high']]) {
      clearEnv(); process.env[name] = raw
      const view = await (await get('/live-cues/v2/settings?v=3')).json() as { general: { limits: Record<string, { value: number; source: string; locked: boolean }> } }
      const key = name.endsWith('TRIGGER') ? 'trigger' : 'maxCuesPerMeeting'
      expect(view.general.limits[key], `${name}=${raw}`).toMatchObject({ source: 'setting', locked: false })
    }
    expect(warn.mock.calls.some(c => String(c[0]).includes('COS_LIVE_CUES_GENERAL_TRIGGER'))).toBe(true)
    clearEnv()
    warn.mockRestore()
  })

  it('general.today comes from the registered provider (zero until one registers, zero again if it throws), and the view survives a provider that is removed', async () => {
    const { setGeneralCuesTodayProvider } = await import('../lib/live-cues-v2.js')
    const read = async () => (await (await get('/live-cues/v2/settings?v=3')).json() as { general: { today: unknown } }).general.today
    expect(await read()).toEqual(ZERO_TODAY)
    setGeneralCuesTodayProvider(() => ({ day: '2026-11-01', topicCalls: 7, webSearches: 3, breakerOpenUntil: 1_793_000_000_000 }))
    expect(await read()).toEqual({ day: '2026-11-01', topicCalls: 7, webSearches: 3, breakerOpenUntil: 1_793_000_000_000 })
    setGeneralCuesTodayProvider(() => { throw new Error('store unreadable') })
    expect(await read()).toEqual(ZERO_TODAY)
    setGeneralCuesTodayProvider(null)
    expect(await read()).toEqual(ZERO_TODAY)
  })

  it('general.publicTopics follows the Ask consent and homeArea is the owner\'s city only', async () => {
    const { MeetingAskStore } = await import('../lib/meeting-ask-store.js')
    const { updateProfileFields } = await import('../lib/profile.js')
    const read = async () => (await (await get('/live-cues/v2/settings?v=3')).json() as { general: { publicTopics: boolean; homeArea: string | null } }).general
    expect(await read()).toMatchObject({ publicTopics: false, homeArea: null })
    new MeetingAskStore().setPublicTopics(true)
    updateProfileFields({ home_city: 'Austin, TX' })
    expect(await read()).toEqual({ ...(await read()), publicTopics: true, homeArea: 'Austin, TX' })
    updateProfileFields({ home_city: '123 Main St' })                                    // digits: an address is never read as an area
    expect((await read()).homeArea).toBeNull()
    new MeetingAskStore().setPublicTopics(false)
    updateProfileFields({ home_city: '' })
    expect(await read()).toMatchObject({ publicTopics: false, homeArea: null })
  })

  // 6.97.8. Control relabels its "Today" line from this; the general cue counters keep their meaning beside it.
  it('webToday is additive: v3 carries the ledger, v2 and v1 do not, and general.today still counts only the general cues', async () => {
    const { webLedger } = await import('../lib/web-lookup-ledger.js')
    webLedger().search('ask'); webLedger().pagesRead('ask', 2); webLedger().search('cues'); webLedger().search('factCheck'); webLedger().withheld('ask', 'no_public_intent'); webLedger().withheld('cues', 'personal')
    const v3 = await (await get('/live-cues/v2/settings?v=3')).json() as Record<string, any>
    expect(v3.webToday).toEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), readable: true, cues: { searches: 1, pagesRead: 0 }, ask: { searches: 1, pagesRead: 2 }, factCheck: { searches: 1, pagesRead: 0 },
      withheld: { total: 2, byReason: { no_public_intent: 1, personal: 1 }, byFeature: { cues: 1, ask: 1, factCheck: 0 } } })
    expect(v3.general.today).toEqual(ZERO_TODAY)                       // topicCalls and webSearches stay the general cues' own
    expect('webToday' in await (await get('/live-cues/v2/settings?v=2')).json()).toBe(false)
    expect('webToday' in await (await get('/live-cues/v2/settings')).json()).toBe(false)
  })
})
