// 7.0.45 (U1; Miles 2026-11-14 20:46, plan from his glasses 8:23 PM): Cursor's plan usage, switched off unless
// COS_CURSOR_PLAN_USAGE=1. No test reads the Keychain or calls api2.cursor.sh: the Keychain tool and fetch are stand-ins.
// The fixtures follow the reply shape Miles saw on 2026-11-14 as relayed (no reply has been recorded yet): field names
// and units as he named them; the numbers are made up.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CURSOR_HOST, CURSOR_KEYCHAIN_ARGS, CURSOR_KEYCHAIN_TOOL, CURSOR_READS, cursorBucketFor, cursorCliVersion, cursorPlanUsageOn,
  cursorReadUrl, jwtExpired, keychainEnv, parseCursorUsage, probeCursorUsage, readCursorToken,
  MAX_REPLY_BYTES, type ExecFn, type FetchFn, type FetchInit,
} from './cursor-plan.js'
import { UsageMonitor, UsageProbeError, USAGE_BREAKER_MS, USAGE_FAILURE_HOLD_MS, USAGE_POLL_MS, headroomOf, safeFailureText, viewOf, type UsageEntry } from './usage.js'
import { planLine, planPane } from './plan-pane.js'

const NOW = Date.parse('2026-11-15T02:30:00Z') // 8:30 PM CST, Nov 14
const TZ = 'America/Chicago'
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
// A sentinel token: if any byte of it reaches a log, an error, the cache file or a reply, an assertion below fails.
const TOKEN = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: Math.floor(NOW / 1000) + 3600 })}.SENTINELsignatureQ9xZ`
const EXPIRED = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: Math.floor(NOW / 1000) - 60 })}.SENTINELsignatureQ9xZ`
const ON = { COS_CURSOR_PLAN_USAGE: '1', HOME: '/Users/someone', PATH: '/x/bin', SECRET_THING: 'nope' }

const START = Date.parse('2026-11-01T08:00:00Z'), END = Date.parse('2026-12-01T08:00:00Z')
const usageReply = (over: Record<string, any> = {}, planUsage: Record<string, any> = {}) => ({
  billingCycleStart: String(START), billingCycleEnd: String(END),
  planUsage: { autoPercentUsed: 62, apiPercentUsed: 10, totalPercentUsed: 41, includedSpend: 2050, limit: 5000, bonusSpend: 0, ...planUsage },
  displayMessage: "You've used 90% of your included usage", autoBucketModels: ['grok-4.7-high-fast', 'grok-code-fast-1'], ...over,
})
const planReply = { planInfo: { planName: 'Pro', price: '$20/mo' } }
const hardReply = { hardLimit: 100, individualRemaining: 80 }

const okExec = (token = TOKEN): ExecFn => vi.fn(async () => ({ code: 0, stdout: `${token}\n`, timedOut: false }))
interface Call { url: string; init: FetchInit }
const fakeFetch = (replies: Partial<Record<string, { status: number; body?: unknown; type?: string }>>, calls: Call[] = []): FetchFn =>
  vi.fn(async (url: string, init: FetchInit) => {
    calls.push({ url, init })
    const method = url.split('/').pop()!
    const r = replies[method] ?? { status: 404 }
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return { status: r.status, type: r.type, headers: { get: () => null }, body: new Blob([text]).stream(), text: async () => { throw new Error('the capped reader must read the stream') } }
  })
const goodReplies = { GetCurrentPeriodUsage: { status: 200, body: usageReply() }, GetPlanInfo: { status: 200, body: planReply }, GetHardLimit: { status: 200, body: hardReply } }
const deps = (over: Partial<Parameters<typeof probeCursorUsage>[0]> = {}) => ({ env: ON, now: () => NOW, version: () => '2026.11.13-eacade1', exec: okExec(), fetch: fakeFetch(goodReplies), ...over })

/** Everything a person or another process could see: console output and thrown errors. */
function captureOutput() {
  const lines: string[] = []
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) }))
  return { lines, restore: () => spies.forEach(s => s.mockRestore()) }
}
afterEach(() => { vi.restoreAllMocks() })

describe('the switch (COS_CURSOR_PLAN_USAGE)', () => {
  it('is on only for the exact string "1"', () => {
    expect(cursorPlanUsageOn({ COS_CURSOR_PLAN_USAGE: '1' })).toBe(true)
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', 'on']) expect(cursorPlanUsageOn({ COS_CURSOR_PLAN_USAGE: v })).toBe(false)
  })
  it('off: the monitor never probes Cursor (no Keychain read, no network), and Cursor reads as before 7.0.45', async () => {
    const cursor = vi.fn(async () => parseCursorUsage(usageReply())!)
    const m = new UsageMonitor({ probes: { claude: async () => { throw new UsageProbeError('timed_out', 'timed out') }, codex: async () => { throw new UsageProbeError('timed_out', 'timed out') }, cursor }, now: () => NOW, cursorPlan: false })
    await m.ensureFresh(0); await m.onDemand(true); await m.forPlan(); await m.refresh('cursor')
    expect(cursor).not.toHaveBeenCalled()
    expect(m.views().find(v => v.provider === 'cursor')!.note).toBe('not read: Cursor usage needs its app or a Keychain read, neither approved')
    expect(planLine(m.entry('cursor'), NOW, TZ, m.cursorPlanOn())).toMatchObject({ state: 'no_plan', short: 'No plan reading', long: 'No plan reading. Cursor does not report its plan to COS.' })
  })
  it('off, even with a reading an earlier on-period left in the cache, Cursor still reads "No plan reading"', () => {
    const e = entry(parseCursorUsage(usageReply()))
    expect(viewOf({ ...e, reading: parseCursorUsage(usageReply(), planReply), lastFailure: 'keychain_refused' }, NOW, false)).toMatchObject({ state: 'unknown', headroomPct: null, plan: null, reason: null, lastGoodAt: null, ageSec: null, note: 'not read: Cursor usage needs its app or a Keychain read, neither approved' })
    expect(planLine({ ...e, lastFailure: 'keychain_refused' }, NOW, TZ, false)).toMatchObject({ reason: null, readAt: null, lastGoodAt: null })
    expect(planLine(e, NOW, TZ, false).state).toBe('no_plan')
  })
  it('off: the probe itself refuses before the Keychain or the network', async () => {
    const exec = okExec(), fetchFn = fakeFetch(goodReplies)
    await expect(probeCursorUsage(deps({ env: { HOME: '/h' }, exec, fetch: fetchFn }))).rejects.toThrow(UsageProbeError)
    expect(exec).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('the sign-in (Keychain)', () => {
  it('runs /usr/bin/security with the item names only, HOME and PATH only, and keeps the token out of argv', async () => {
    const exec = okExec()
    await expect(readCursorToken(exec, ON)).resolves.toBe(TOKEN)
    expect(exec).toHaveBeenCalledWith(CURSOR_KEYCHAIN_TOOL, CURSOR_KEYCHAIN_ARGS, { env: { HOME: '/Users/someone', PATH: '/usr/bin:/bin' }, timeoutMs: 15_000 })
    expect([...CURSOR_KEYCHAIN_ARGS]).toEqual(['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'])
    expect(keychainEnv(ON)).toEqual({ HOME: '/Users/someone', PATH: '/usr/bin:/bin' })
  })
  it('fails closed with fixed words: missing (44, empty), refused (51, 128), locked (36), timed out, anything else', async () => {
    const run = (r: { code: number | null; stdout?: string; timedOut?: boolean }) => readCursorToken(vi.fn(async () => ({ stdout: '', timedOut: false, ...r })), ON)
    await expect(run({ code: 44 })).rejects.toMatchObject({ code: 'sign_in_missing', message: 'Cursor sign-in not found in the Keychain' })
    await expect(run({ code: 0, stdout: '\n' })).rejects.toMatchObject({ code: 'sign_in_missing' })
    await expect(run({ code: 51 })).rejects.toMatchObject({ code: 'keychain_refused', message: "Cursor's sign-in was not shared with COS" })
    await expect(run({ code: 128 })).rejects.toMatchObject({ code: 'keychain_refused' })
    await expect(run({ code: 36 })).rejects.toMatchObject({ code: 'keychain_locked', message: 'Keychain locked' })
    await expect(run({ code: null, timedOut: true })).rejects.toMatchObject({ code: 'timed_out', message: 'Keychain read timed out' })
    await expect(run({ code: 2 })).rejects.toMatchObject({ code: 'error', message: 'Keychain read failed' })
  })
  it('an expired sign-in stops before the network', async () => {
    expect(jwtExpired(EXPIRED, NOW)).toBe(true); expect(jwtExpired(TOKEN, NOW)).toBe(false); expect(jwtExpired('not-a-jwt', NOW)).toBe(false)
    const fetchFn = fakeFetch(goodReplies)
    await expect(probeCursorUsage(deps({ exec: okExec(EXPIRED), fetch: fetchFn }))).rejects.toMatchObject({ code: 'sign_in_expired', message: 'Cursor sign-in expired' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('the CLI version comes from its install folder, never from running it; unknown fails closed before the Keychain', async () => {
    expect(cursorCliVersion(() => ({ ok: true, path: '/u/.local/bin/agent' }), () => '/u/.local/share/cursor-agent/versions/2026.11.13-eacade1/cursor-agent')).toBe('2026.11.13-eacade1')
    expect(cursorCliVersion(() => ({ ok: true, path: '/x' }), () => '/opt/cursor/bin/cursor-agent')).toBeNull()
    expect(cursorCliVersion(() => ({ ok: false }))).toBeNull()
    const exec = okExec()
    await expect(probeCursorUsage(deps({ version: () => null, exec }))).rejects.toMatchObject({ code: 'not_found', message: 'Cursor CLI not found' })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('the reads: one host, three methods, no redirects', () => {
  it('asks exactly the three read methods, once each, on api2.cursor.sh, POST {} with the six headers', async () => {
    const calls: Call[] = []
    const r = await probeCursorUsage(deps({ fetch: fakeFetch(goodReplies, calls) }))
    expect(calls.map(c => c.url)).toEqual(CURSOR_READS.map(m => `https://api2.cursor.sh/aiserver.v1.DashboardService/${m}`))
    expect([...CURSOR_READS]).toEqual(['GetCurrentPeriodUsage', 'GetPlanInfo', 'GetHardLimit'])
    for (const c of calls) {
      expect(new URL(c.url).host).toBe(CURSOR_HOST)
      expect(c.init).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual' })
      expect(c.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'x-cursor-client-type': 'cli', 'x-cursor-client-version': '2026.11.13-eacade1', 'x-ghost-mode': 'true' })
    }
    expect(r.plan).toBe('Pro')
  })
  it('no other method can be built, and no write is ever requested', async () => {
    for (const m of ['UseSandBankedReset', 'GetFilteredUsageEvents', 'SetHardLimit', '../x', 'GetCurrentPeriodUsage/../UseSandBankedReset', ''])
      expect(() => cursorReadUrl(m)).toThrow(UsageProbeError)
    const calls: Call[] = []
    await probeCursorUsage(deps({ fetch: fakeFetch(goodReplies, calls) }))
    expect(calls.some(c => /UseSandBankedReset|Set|Update|Reset|Create|Delete/.test(c.url))).toBe(false)
  })
  it('a redirect is never followed: the read fails and the sign-in goes nowhere else', async () => {
    for (const r of [{ status: 302 }, { status: 307 }, { status: 0, type: 'opaqueredirect' }]) {
      const calls: Call[] = []
      await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: r }, calls) }))).rejects.toMatchObject({ code: 'redirected' })
      expect(calls.length).toBe(1)
      expect(calls.every(c => new URL(c.url).host === CURSOR_HOST && c.init.redirect === 'manual')).toBe(true)
    }
  })
  it('401 and 403 read as an expired sign-in; another status as an HTTP error; the plan and hard-limit reads are extras', async () => {
    await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 401 } }) }))).rejects.toMatchObject({ code: 'sign_in_expired' })
    await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 403 } }) }))).rejects.toMatchObject({ code: 'sign_in_expired' })
    await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 429 } }) }))).rejects.toMatchObject({ code: 'http_error', message: 'Cursor answered HTTP 429' })
    const partial = await probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: goodReplies.GetCurrentPeriodUsage, GetPlanInfo: { status: 500 }, GetHardLimit: { status: 302 } }) }))
    expect(partial.plan).toBeNull(); expect(partial.cursor?.onDemand).toBeNull(); expect(headroomOf('cursor', partial, NOW)).toBe(38)
  })
  it('a read that does not answer in time fails as timed out', async () => {
    const hang: FetchFn = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))) })
    await expect(probeCursorUsage(deps({ fetch: hang, timeoutMs: 20 }))).rejects.toMatchObject({ code: 'timed_out', message: 'timed out' })
  })
  it('a network error\'s own text is never kept', async () => {
    const boom: FetchFn = async () => { throw new Error(`connect ECONNREFUSED with ${TOKEN}`) }
    await expect(probeCursorUsage(deps({ fetch: boom }))).rejects.toMatchObject({ code: 'error', message: 'unexpected error' })
  })
})

describe('Q1 21:13: bounds, a broken token, a huge reply, and TLS checks off', () => {
  it('displayMessage is kept to 200 characters, autoBucketModels to 50 ids of at most 100, the plan name to 60', () => {
    const r = parseCursorUsage(usageReply({ displayMessage: 'x'.repeat(500), autoBucketModels: [...Array.from({ length: 60 }, (_, i) => `grok-${i}`), 'y'.repeat(101)] }), { planInfo: { planName: 'P'.repeat(70) } })!
    expect(r.cursor.displayMessage).toHaveLength(200)
    expect(r.cursor.autoBucketModels).toHaveLength(50)
    expect(r.cursor.autoBucketModels.every(m => m.length <= 100)).toBe(true)
    expect(parseCursorUsage(usageReply({ autoBucketModels: ['y'.repeat(101), 'grok-a'] }))!.cursor.autoBucketModels).toEqual(['grok-a'])
    expect(r.plan).toHaveLength(60)
  })
  it('a token with a CR, LF or any space inside never reaches fetch', async () => {
    for (const bad of ['abc\r\ndef', 'abc\rdef', 'abc\ndef', 'abc def', 'abc\tdef']) {
      const fetchFn = fakeFetch(goodReplies)
      await expect(probeCursorUsage(deps({ exec: vi.fn(async () => ({ code: 0, stdout: `${bad}\n`, timedOut: false })), fetch: fetchFn }))).rejects.toMatchObject({ code: 'sign_in_missing' })
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })
  it('a reply is capped while it streams: an endless body is cancelled just past the cap, a stated huge length is never read', async () => {
    let pulled = 0, cancelled = false
    const endless: FetchFn = async () => ({ status: 200, headers: { get: () => null }, text: async () => { throw new Error('not buffered') },
      // Bounded (Q1 21:31): it ends after 4 x the cap, so with the cap removed this test fails fast (read whole, never
      // cancelled) instead of hanging and growing a worker without limit.
      body: new ReadableStream<Uint8Array>({ pull(c) { if (pulled >= 4 * MAX_REPLY_BYTES) return c.close(); pulled += 64 * 1024; c.enqueue(new Uint8Array(64 * 1024)) }, cancel() { cancelled = true } }, { highWaterMark: 0 }) })
    let signal: AbortSignal | null = null
    const watched: FetchFn = async (url, init) => { signal = init.signal; return endless(url, init) }
    await expect(probeCursorUsage(deps({ fetch: watched }))).rejects.toMatchObject({ code: 'unknown_shape' })
    expect(cancelled).toBe(true)
    expect(signal!.aborted).toBe(true) // the request itself is aborted at the cap (lead 21:19)
    expect(pulled).toBeLessThanOrEqual(MAX_REPLY_BYTES + 3 * 64 * 1024)
    let read = false
    const stated: FetchFn = async () => ({ status: 200, headers: { get: (n: string) => (n === 'content-length' ? String(10 * 1024 * 1024) : null) }, text: async () => '{}',
      // highWaterMark 0: the stream pulls only when someone reads, so `read` stays false unless the reader runs.
      body: new ReadableStream<Uint8Array>({ pull(c) { if (read) return c.close(); read = true; c.enqueue(new Uint8Array(10)) } }, { highWaterMark: 0 }) })
    await expect(probeCursorUsage(deps({ fetch: stated }))).rejects.toMatchObject({ code: 'unknown_shape' })
    expect(read).toBe(false)
  })
  it('with NODE_TLS_REJECT_UNAUTHORIZED=0 the read is refused before the Keychain is touched', async () => {
    const exec = okExec(), fetchFn = fakeFetch(goodReplies)
    await expect(probeCursorUsage(deps({ env: { ...ON, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, exec, fetch: fetchFn }))).rejects.toMatchObject({ code: 'tls_off', message: 'TLS checks are off on this Mac; Cursor was not read' })
    expect(exec).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled()
    await expect(probeCursorUsage(deps({ env: { ...ON, NODE_TLS_REJECT_UNAUTHORIZED: '1' } }))).resolves.toMatchObject({ available: true })
    expect(safeFailureText('TLS checks are off on this Mac; Cursor was not read')).toBe('TLS checks are off on this Mac; Cursor was not read')
  })
})

describe('the parser (shapes as relayed on 2026-11-14)', () => {
  it('reads Auto, API and the total; the reset from billingCycleEnd (epoch ms, as a string or a number); the plan name', () => {
    const r = parseCursorUsage({ ...usageReply(), billingCycleEnd: END, billingCycleStart: START }, planReply, hardReply)!
    expect(r.windows).toEqual([
      { kind: 'auto', usedPct: 62, resetsAt: '2026-12-01T08:00:00.000Z', durationMins: 43200 },
      { kind: 'api', usedPct: 10, resetsAt: '2026-12-01T08:00:00.000Z', durationMins: 43200 },
      { kind: 'included', usedPct: 41, resetsAt: '2026-12-01T08:00:00.000Z', durationMins: 43200 },
    ])
    expect(r).toMatchObject({ plan: 'Pro', available: true, allowed: null })
    expect(r.cursor).toMatchObject({ includedSpendCents: 2050, limitCents: 5000, bonusSpendCents: 0, onDemand: { hardLimit: 100, individualRemaining: 80 } })
    expect(parseCursorUsage(usageReply())!.windows[0]!.resetsAt).toBe('2026-12-01T08:00:00.000Z')
  })
  it('a percent outside 0 to 100, or a missing Auto or API percent, fails closed', () => {
    for (const bad of [{ autoPercentUsed: 101 }, { apiPercentUsed: -1 }, { totalPercentUsed: 250 }, { autoPercentUsed: 'lots' }, { autoPercentUsed: null }, { apiPercentUsed: undefined }, { autoPercentUsed: Number.NaN }])
      expect(parseCursorUsage(usageReply({}, bad))).toBeNull()
    expect(parseCursorUsage({ billingCycleEnd: END })).toBeNull()
    expect(parseCursorUsage(null)).toBeNull()
  })
  it('a probe whose reply does not parse fails as an unknown shape', async () => {
    await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 200, body: usageReply({}, { autoPercentUsed: 140 }) } }) }))).rejects.toMatchObject({ code: 'unknown_shape' })
    await expect(probeCursorUsage(deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 200, body: 'not json' } }) }))).rejects.toMatchObject({ code: 'unknown_shape' })
  })
  it('Grok and other Auto-bucket models pace on Auto; a named API model paces on API', () => {
    const r = parseCursorUsage(usageReply())!
    expect(cursorBucketFor('grok-4.7-high-fast', r)).toBe('auto')
    expect(cursorBucketFor('grok-5', parseCursorUsage(usageReply({ autoBucketModels: [] })))).toBe('auto')
    expect(cursorBucketFor('claude-opus-5-5', r)).toBe('api')
    expect(cursorBucketFor('gpt-6', null)).toBe('api')
  })
  it('the bar is the higher of Auto and API; headroom is 100 minus it; low under 15, exhausted at 0', () => {
    expect(headroomOf('cursor', parseCursorUsage(usageReply())!, NOW)).toBe(38)
    expect(headroomOf('cursor', parseCursorUsage(usageReply({}, { autoPercentUsed: 5, apiPercentUsed: 70 }))!, NOW)).toBe(30)
    expect(viewOf(entry(parseCursorUsage(usageReply({}, { autoPercentUsed: 90 })), NOW), NOW, true).state).toBe('low')
    expect(viewOf(entry(parseCursorUsage(usageReply({}, { autoPercentUsed: 100 })), NOW), NOW, true).state).toBe('exhausted')
    expect(viewOf(entry(parseCursorUsage(usageReply()), NOW), NOW, true)).toMatchObject({ state: 'ok', headroomPct: 38, plan: null })
  })
  it('displayMessage never becomes the bar or its words', () => {
    const line = planLine(entry(parseCursorUsage(usageReply())), NOW, TZ, true)
    expect(line.usedPct).toBe(62)
    expect(JSON.stringify(line)).not.toContain('90%')
    expect(JSON.stringify(line)).not.toContain("You've used")
  })
})

function entry(reading: ReturnType<typeof parseCursorUsage>, observedAt: number | null = NOW): UsageEntry {
  return { provider: 'cursor', reading, observedAt, source: 'probe', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false }
}

describe('the pane, switched on', () => {
  it('draws Cursor like Claude: percent used, the reset, the billing period, which bucket, and an estimate', () => {
    const line = planLine(entry(parseCursorUsage(usageReply())), NOW, TZ, true)
    expect(line).toMatchObject({ provider: 'cursor', state: 'fresh', usedPct: 62, short: '62% used, resets Dec 1', quiet: 'Cursor 62% used' })
    expect(line.gonePct).toBeGreaterThan(40); expect(line.gonePct).toBeLessThan(50)
    expect(line.long).toBe(`62% used. The bar is the Auto bucket, the higher of the two (API 10%). Total used: 41%. ${Math.round(line.gonePct!)}% of the billing period gone.`)
    expect(line.estimate?.text).toMatch(/^At this billing period's average pace, Cursor /)
    const pane = planPane([entry(null), entry(parseCursorUsage(usageReply()))].slice(1), NOW, TZ, true)
    expect(pane.closest).toBe('cursor')
  })
  it('without the period\'s start: the share and the reset, no "now" line, no estimate', () => {
    const line = planLine(entry(parseCursorUsage(usageReply({ billingCycleStart: undefined }))), NOW, TZ, true)
    expect(line).toMatchObject({ usedPct: 62, gonePct: null, estimate: null, windowStart: null })
    expect(line.long).toContain('Its start was not stated, so there is no pace line.')
  })
  it('a failed read draws no ruler and says why in plain words', () => {
    const e = { ...entry(null, null), lastFailure: 'keychain_locked' as const, holdUntil: NOW + 60_000 }
    expect(planLine(e, NOW, TZ, true)).toMatchObject({ state: 'paused', usedPct: null, windowWords: 'Billing period not known' })
    expect(planLine(e, NOW, TZ, true).long).toContain('The last read: the Keychain is locked.')
  })
  it('switched on and never read: the words say what the Mac will ask, and never suggest allowing it always', () => {
    const line = planLine(entry(null, null), NOW, TZ, true)
    expect(line).toMatchObject({ state: 'not_read', usedPct: null })
    expect(line.long).toContain('The first read asks this Mac to share Cursor\'s sign-in from the Keychain with COS')
    expect(line.long).toContain('cursor-access-token')
    expect(viewOf(entry(null, null), NOW, true).note).toContain('the first read asks this Mac to share Cursor\'s sign-in')
  })
})

describe('the monitor, switched on: the same holds as Claude', () => {
  it('a refused Keychain read (51 or 128) holds 10 minutes and says "Cursor\'s sign-in was not shared with COS", not a generic failure', async () => {
    for (const code of [51, 128]) {
      let now = NOW
      const exec = vi.fn(async () => ({ code, stdout: '', timedOut: false }))
      const fetchFn = fakeFetch(goodReplies)
      const m = new UsageMonitor({ probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor: () => probeCursorUsage(deps({ exec, fetch: fetchFn })) }, now: () => now, cursorPlan: true })
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await m.onDemand(true)
      now += USAGE_FAILURE_HOLD_MS - 1000; await m.onDemand(true); await m.refresh('cursor')
      quiet.mockRestore()
      expect(exec).toHaveBeenCalledTimes(1); expect(fetchFn).not.toHaveBeenCalled()
      expect(m.entry('cursor')).toMatchObject({ lastFailure: 'keychain_refused', holdUntil: NOW + USAGE_FAILURE_HOLD_MS })
      const line = planLine(m.entry('cursor'), now, TZ, true)
      expect(line).toMatchObject({ state: 'paused', usedPct: null, shortLong: "Cursor's sign-in was not shared with COS", short: 'Sign-in not shared' })
      expect(line.long).toMatch(/^Cursor's sign-in was not shared with COS\. COS asks again after \d{1,2}:\d{2} [AP]M\./)
      expect(JSON.stringify(line)).not.toMatch(/unexpected|failed/i)
      expect(m.views().find(v => v.provider === 'cursor')!.note).toBe("not read: Cursor's sign-in was not shared with COS")
    }
  })
  it('a 401 holds 10 minutes; three failures in a row pause an hour; a timeout does the same', async () => {
    let now = NOW
    const failing = vi.fn(async () => { throw new UsageProbeError('sign_in_expired', 'Cursor sign-in expired') })
    const m = new UsageMonitor({ probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor: failing }, now: () => now, cursorPlan: true })
    await m.onDemand(false)
    expect(failing).toHaveBeenCalledTimes(1)
    await m.onDemand(true); await m.refresh('cursor')
    expect(failing).toHaveBeenCalledTimes(1) // held
    now += USAGE_FAILURE_HOLD_MS + 1; await m.refresh('cursor')
    now += USAGE_FAILURE_HOLD_MS + 1; await m.refresh('cursor')
    expect(failing).toHaveBeenCalledTimes(3)
    expect(m.entry('cursor').pausedUntil).toBe(now + USAGE_BREAKER_MS)
    now += USAGE_FAILURE_HOLD_MS + 1; await m.refresh('cursor')
    expect(failing).toHaveBeenCalledTimes(3) // paused for the hour
    const timeouts = vi.fn(async () => { throw new UsageProbeError('timed_out', 'timed out') })
    const t = new UsageMonitor({ probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor: timeouts }, now: () => NOW, cursorPlan: true })
    await t.refresh('cursor'); await t.refresh('cursor')
    expect(timeouts).toHaveBeenCalledTimes(1); expect(t.entry('cursor').holdUntil).toBe(NOW + USAGE_FAILURE_HOLD_MS)
  })
  it('lead 21:19: a Work plan input with the switch on spawns no child and opens no socket for Cursor', async () => {
    const exec = okExec(), fetchFn = fakeFetch(goodReplies)
    const calls = () => (fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const m = new UsageMonitor({ probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor: () => probeCursorUsage(deps({ exec, fetch: fetchFn })) }, now: () => NOW, cursorPlan: true })
    const views = await m.forPlan()
    expect(exec).not.toHaveBeenCalled(); expect(calls()).toBe(0)
    expect(views.find(v => v.provider === 'cursor')).toMatchObject({ state: 'unknown', headroomPct: null })
    await m.onDemand(false)
    expect(exec).toHaveBeenCalledTimes(1); expect(calls()).toBe(3) // opening Usage does read
    await m.forPlan()
    expect(exec).toHaveBeenCalledTimes(1); expect(calls()).toBe(3)
  })
  it('lead 21:42: with the poll and the Cursor switch both on, a tick spawns no Keychain child and makes no Cursor fetch', async () => {
    vi.useFakeTimers()
    try {
      let now = NOW
      const exec = okExec(), fetchFn = fakeFetch(goodReplies)
      const claude = vi.fn(async () => parseCursorUsage(usageReply())!)
      const m = new UsageMonitor({ probes: { claude, codex: claude, cursor: () => probeCursorUsage(deps({ exec, fetch: fetchFn })) }, now: () => now, cursorPlan: true, pollEnabled: true })
      m.start({ COS_WORK_USAGE_POLL: '1' })
      for (let i = 0; i < 3; i++) { now += USAGE_POLL_MS; await vi.advanceTimersByTimeAsync(USAGE_POLL_MS) }
      m.stop()
      expect(claude.mock.calls.length).toBeGreaterThanOrEqual(3) // the timer does run, for Claude and Codex
      expect(exec).not.toHaveBeenCalled(); expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('re-reads Cursor only past 10 minutes on the usage route (2 on Refresh), and never for a Work plan', async () => {
    let now = NOW
    const cursor = vi.fn(async () => parseCursorUsage(usageReply())!)
    const m = new UsageMonitor({ probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor }, now: () => now, cursorPlan: true })
    await m.onDemand(false); now += 5 * 60_000; await m.onDemand(false)
    expect(cursor).toHaveBeenCalledTimes(1)
    // Q1 21:13: a Work plan never reads Cursor (no Keychain prompt while he is away); it sees the cached reading.
    now += 5 * 60_000; await m.forPlan(); await m.forPlan()
    expect(cursor).toHaveBeenCalledTimes(1)
    now += 6 * 60_000; await m.onDemand(false)
    expect(cursor).toHaveBeenCalledTimes(2)
  })
})

describe('the token never leaves the probe', () => {
  it('not in a log line, an error, a view, the pane or the cache file, on success or on any failure', async () => {
    const out = captureOutput()
    const dir = mkdtempSync(join(tmpdir(), 'cos-cursor-test-'))
    try {
      const path = join(dir, 'usage.json')
      const scenarios: Array<Parameters<typeof probeCursorUsage>[0]> = [
        deps(),
        deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 401 } }) }),
        deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 302 } }) }),
        deps({ fetch: fakeFetch({ GetCurrentPeriodUsage: { status: 200, body: `{"echo":"${TOKEN}","planUsage":{"autoPercentUsed":500}}` } }) }),
        deps({ fetch: async () => { throw new Error(TOKEN) } }),
        deps({ exec: okExec(EXPIRED) }),
        deps({ exec: vi.fn(async () => ({ code: 51, stdout: TOKEN, timedOut: false })) }),
      ]
      const seen: string[] = []
      for (const s of scenarios) {
        const m = new UsageMonitor({ path, probes: { claude: async () => parseCursorUsage(usageReply())!, codex: async () => parseCursorUsage(usageReply())!, cursor: () => probeCursorUsage(s) }, now: () => NOW, cursorPlan: true })
        await probeCursorUsage(s).then(r => seen.push(JSON.stringify(r)), (e: Error) => seen.push(`${e.message} ${String(e)} ${JSON.stringify(e)} ${e.stack ?? ''}`))
        await m.refresh('cursor')
        seen.push(JSON.stringify(m.views()), JSON.stringify(planPane([m.entry('claude'), m.entry('codex'), m.entry('cursor')], NOW, TZ, true)), readFileSync(path, 'utf8'))
      }
      const all = [...seen, ...out.lines].join('\n')
      // Q1 21:13 (C1b), lead 21:19: no substring of the token of 8 characters or more, anywhere. Every longer substring
      // contains an 8-character one, so checking every 8-character window of the whole token covers them all.
      for (let i = 0; i + 8 <= TOKEN.length; i++) expect(all, `token piece at ${i}`).not.toContain(TOKEN.slice(i, i + 8))
      expect(out.lines.length).toBeGreaterThan(0) // the failure log lines ran, and carry no token
    } finally { out.restore(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('no served words, in any state, suggest allowing the Keychain item always', () => {
    const states: UsageEntry[] = [entry(null, null), entry(parseCursorUsage(usageReply())), { ...entry(null, null), lastFailure: 'keychain_refused', holdUntil: NOW + 1 },
      { ...entry(null, null), lastFailure: 'keychain_refused' }, { ...entry(null, null), lastFailure: 'sign_in_missing', lastError: 'Cursor sign-in not found in the Keychain' }]
    for (const e of states) expect(JSON.stringify([planLine(e, NOW, TZ, true), viewOf(e, NOW, true)])).not.toMatch(/always/i)
  })
  it('every Cursor failure text is on the safe list, so a client never sees anything else', () => {
    for (const t of ['Cursor CLI not found', 'Keychain read timed out', 'Cursor sign-in not found in the Keychain', "Cursor's sign-in was not shared with COS", 'Keychain locked',
      'Keychain read failed', 'Cursor sign-in expired', 'Cursor answered with a redirect', 'unknown Cursor usage shape', 'Cursor answered HTTP 429'])
      expect(safeFailureText(t)).toBe(t)
    expect(safeFailureText(`Cursor answered HTTP 429 ${TOKEN}`)).toBe('unexpected error')
  })
})
