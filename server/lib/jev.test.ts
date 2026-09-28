import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JEV_KEY_FILE, JEV_LIMITS, JEV_MODEL, JevClient, resolveJevKey, saveJevKey, validateJevKey } from './jev.js'

const KEY = 'ts_live_' + 'k'.repeat(32)
let dir = ''
beforeEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.COS_JEV_DAILY_TOKENS; dir = mkdtempSync(join(tmpdir(), 'jev-')); if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (existsSync(JEV_KEY_FILE)) unlinkSync(JEV_KEY_FILE); delete process.env.TYPESAFE_API_KEY })

const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
const ok = (tokens = 500) => reply(200, { model: JEV_MODEL, answers: { q: { noul: 0.9 } }, usage: { input_tokens: tokens } })
function client(fetchImpl: (...a: any[]) => Promise<Response>, now = () => new Date('2026-09-28T20:00:00Z')) {
  return new JevClient(fetchImpl as typeof fetch, now, join(dir, 'usage.json'))
}

it('resolves the key saved from Control first (0600), then the environment, else none', () => {
  expect(resolveJevKey()).toBeNull()
  process.env.TYPESAFE_API_KEY = `'env-key-${'e'.repeat(20)}'`
  expect(resolveJevKey()).toMatchObject({ key: 'env-key-' + 'e'.repeat(20), source: 'env' })  // quotes from a .env are stripped
  saveJevKey(KEY, new Date('2026-09-28T20:00:00Z'))
  expect(statSync(JEV_KEY_FILE).mode & 0o777).toBe(0o600)
  // An explicit Settings key wins over any .env (both .env files hold a key on Miles's Mac).
  expect(resolveJevKey()).toMatchObject({ key: KEY, source: 'config', savedAt: '2026-09-28T20:00:00.000Z' })
})

it('a newly saved key clears the breaker and the last error', async () => {
  process.env.TYPESAFE_API_KEY = KEY
  const f = vi.fn(async () => reply(503))
  const c = client(f)
  for (let i = 0; i < JEV_LIMITS.breakerFailures; i++) await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_unavailable' })
  expect(c.status().breakerOpenUntil).not.toBeNull()
  c.resetForNewKey()
  expect(c.status()).toMatchObject({ breakerOpenUntil: null, lastError: null })
  f.mockImplementation(async () => ok(10))
  await expect(c.ask({}, { q: {} }, 1)).resolves.toMatchObject({ inputTokens: 10 })
})

it('validates a key against the free model listing and explains a refusal', async () => {
  const seen: string[] = []
  expect(await validateJevKey(KEY, (async (url: string, init: RequestInit) => { seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`); return reply(200) }) as typeof fetch)).toEqual({ ok: true })
  expect(seen).toEqual([`https://api.typesafe.ai/v1/models Bearer ${KEY}`])
  expect(await validateJevKey(KEY, (async () => reply(401)) as typeof fetch)).toMatchObject({ ok: false, status: 401, reason: 'TypeSafe did not accept this key.' })
  expect(await validateJevKey(KEY, (async () => { throw new Error('offline') }) as typeof fetch)).toMatchObject({ ok: false, status: 0 })
})

it('refuses without a key, sends the pinned model, and counts usage toward the daily cap before sending', async () => {
  const f = vi.fn(async () => ok(700))
  await expect(client(f).ask({}, {}, 10)).rejects.toMatchObject({ code: 'jev_not_configured' })
  process.env.TYPESAFE_API_KEY = KEY
  const c = client(f)
  expect((await c.ask({ a: 1 }, { q: {} }, 10)).inputTokens).toBe(700)
  const body = JSON.parse((f.mock.calls[0] as any)[1].body)
  expect(body).toEqual({ state: { a: 1 }, model: JEV_MODEL, questions: { q: {} } })
  expect(c.usedToday()).toBe(700)
  process.env.COS_JEV_DAILY_TOKENS = '1000'
  await expect(c.ask({}, {}, 400)).rejects.toMatchObject({ code: 'jev_cap_reached' })
  expect(f).toHaveBeenCalledTimes(1)  // refused before sending
  expect(client(f, () => new Date('2026-09-29T20:00:00Z')).usedToday()).toBe(0)  // a new day starts at zero
})

it('opens the breaker after three counted failures; a rejected request does not count; success resets', async () => {
  process.env.TYPESAFE_API_KEY = KEY
  const f = vi.fn(async () => reply(503))
  const c = client(f)
  await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_unavailable' })
  await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_unavailable' })
  f.mockImplementationOnce(async () => reply(422))
  await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_request_rejected' })
  f.mockImplementationOnce(async () => ok())
  await c.ask({}, {}, 1)  // resets the count
  for (let i = 0; i < JEV_LIMITS.breakerFailures; i++) await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_unavailable' })
  const calls = f.mock.calls.length
  await expect(c.ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_breaker_open' })
  expect(f.mock.calls.length).toBe(calls)
  expect(c.status().breakerOpenUntil).toBe('2026-09-28T21:00:00.000Z')
  f.mockImplementation(async () => reply(401))
  await expect(client(f).ask({}, {}, 1)).rejects.toMatchObject({ code: 'jev_key_rejected' })
})

it('status never contains the key', () => {
  process.env.TYPESAFE_API_KEY = KEY
  const status = client(vi.fn()).status()
  expect(status).toMatchObject({ configured: true, source: 'env', dailyCap: JEV_LIMITS.defaultDailyTokens, usedToday: 0 })
  expect(JSON.stringify(status)).not.toContain(KEY)
})
