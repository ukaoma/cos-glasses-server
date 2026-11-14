// 6.83.0 plan usage (canary C1): parsing the real responses read on 2026-10-20, the rules that decide state, the breaker,
// the freshness rule, and the probes' exact wire (no luna reserve, no reset-credit call), by execution with fake children.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClaudeUsage, parseCodexUsage, parseLimitReset, UsageMonitor, viewOf, windowLive, probeClaudeUsage, probeCodexUsage,
  CLAUDE_USAGE_LINES, CODEX_INIT, CODEX_READ, USAGE_FRESH_MS, USAGE_CACHE_MS, USAGE_POLL_MS, USAGE_BREAKER_MS, usagePollOptedIn, type SpawnLines,
  classifyClaudeUsage, UsageProbeError, USAGE_NO_LIMITS_HOLD_MS } from './usage.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const claudeFixture = JSON.parse(readFileSync(join(here, '__fixtures__', 'claude-get-usage-2026-10-20.json'), 'utf8'))
const codexFixture = JSON.parse(readFileSync(join(here, '__fixtures__', 'codex-rate-limits-2026-10-20.json'), 'utf8'))
const NOW = Date.parse('2026-10-21T03:10:00Z')

describe('parsing what the providers answered on 2026-10-20', () => {
  it('Claude: limits[] by kind; session and weekly_all bind', () => {
    const r = parseClaudeUsage(claudeFixture)!
    expect(r.plan).toBe('max')
    expect(r.windows.map(w => [w.kind, w.usedPct])).toEqual([['session', 9], ['weekly_all', 55], ['weekly_scoped', 0]])
    const v = viewOf({ provider: 'claude', reading: r, observedAt: NOW, source: 'probe', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false }, NOW)
    expect(v).toMatchObject({ state: 'ok', headroomPct: 45, resetsAt: '2026-10-26T08:00:00.432Z' })
  })
  it('Claude: only the session and weekly all-models windows bind; a model-scoped weekly window does not', () => {
    const scoped = { ...claudeFixture, rate_limits: { ...claudeFixture.rate_limits, limits: [
      { kind: 'session', percent: 9, resets_at: '2026-10-21T05:50:00Z' }, { kind: 'weekly_all', percent: 55, resets_at: '2026-10-26T08:00:00Z' },
      { kind: 'weekly_scoped', percent: 97, resets_at: '2026-10-26T08:00:00Z' }] } }
    const v = viewOf({ provider: 'claude', reading: parseClaudeUsage(scoped), observedAt: NOW, source: 'probe', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false }, NOW)
    expect(v).toMatchObject({ state: 'ok', headroomPct: 45 })
  })
  it('Claude: an unknown shape is unknown, never zero; an API-key login has no plan limits', () => {
    expect(parseClaudeUsage({ rate_limits_available: true, rate_limits: { five_hour: {} } })).toBeNull()
    expect(parseClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent: 'lots' }] } })).toBeNull()
    expect(parseClaudeUsage({ rate_limits_available: false, subscription_type: null })).toMatchObject({ available: false, windows: [] })
  })
  it('Codex: primary weekly at 92% used is low; ordinaryUsageAllowed false is exhausted whatever the percentages say', () => {
    const r = parseCodexUsage(codexFixture)!
    expect(r).toMatchObject({ plan: 'prolite', allowed: true })
    expect(r.windows).toEqual([{ kind: 'primary', usedPct: 92, resetsAt: new Date(1793101874 * 1000).toISOString(), durationMins: 10080 }])
    const entry = (reading: any) => ({ provider: 'codex' as const, reading, observedAt: NOW, source: 'probe' as const, lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false })
    expect(viewOf(entry(r), NOW)).toMatchObject({ state: 'low', headroomPct: 8 })
    const blocked = parseCodexUsage({ ...codexFixture, ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: { ...codexFixture.rateLimitsByLimitId.codex, primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1793101874 } } } })!
    expect(viewOf(entry(blocked), NOW).state).toBe('exhausted')
  })
  it('a stated limit beats a cached percentage until its reset; Cursor is unknown and says why', () => {
    const r = parseClaudeUsage(claudeFixture)!
    const base = { provider: 'claude' as const, reading: r, observedAt: NOW, source: 'probe' as const, lastError: null, failures: 0, pausedUntil: null, limitSource: 'provider_limit', warning: false }
    expect(viewOf({ ...base, limitUntil: NOW + 60_000 }, NOW)).toMatchObject({ state: 'exhausted', headroomPct: 0 })
    expect(viewOf({ ...base, limitUntil: NOW - 1 }, NOW).state).toBe('ok')
    expect(viewOf({ provider: 'cursor', reading: null, observedAt: null, source: 'none', lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false }, NOW))
      .toMatchObject({ state: 'unknown', note: expect.stringContaining('neither approved') })
  })
  it('reads a reset from the provider\'s limit text', () => {
    expect(parseLimitReset('limit reached, resets 2026-10-21T05:50:00Z', NOW)).toBe(Date.parse('2026-10-21T05:50:00Z'))
    expect(parseLimitReset('Try again in 20 minutes', NOW)).toBe(NOW + 20 * 60_000)
    expect(parseLimitReset("You've hit your session limit · resets 4pm", NOW)).toBeNull()
  })
})

describe('the monitor', () => {
  it('re-reads only what is older than 2 minutes, pauses a provider after three failures, notes limits and rate-limit frames', async () => {
    let now = NOW
    const claude = vi.fn(async () => parseClaudeUsage(claudeFixture)!)
    const codex = vi.fn(async () => { throw new Error('codex not found') })
    const m = new UsageMonitor({ probes: { claude, codex }, now: () => now, pollEnabled: false })
    await m.ensureFresh()
    expect(claude).toHaveBeenCalledTimes(1); expect(codex).toHaveBeenCalledTimes(1)
    now += USAGE_FRESH_MS - 1000
    await m.ensureFresh()
    expect(claude).toHaveBeenCalledTimes(1)
    expect(codex).toHaveBeenCalledTimes(2)
    await m.ensureFresh()
    expect(codex).toHaveBeenCalledTimes(3)
    expect(m.entry('codex').pausedUntil).toBe(now + USAGE_BREAKER_MS)
    await m.ensureFresh()
    expect(codex).toHaveBeenCalledTimes(3)
    expect(m.views().find(v => v.provider === 'codex')).toMatchObject({ state: 'unknown', note: 'not read: codex not found' })
    m.noteLimit('claude', 'usage limit, try again in 30 minutes')
    expect(m.views().find(v => v.provider === 'claude')).toMatchObject({ state: 'exhausted', resetsAt: new Date(now + 30 * 60_000).toISOString() })
    m.noteClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.round((now + 7200_000) / 1000) } })
    expect(m.entry('claude').limitUntil).toBe(Math.round((now + 7200_000) / 1000) * 1000)
  })
  it('no timer reads usage by default; only COS_WORK_USAGE_POLL=1 starts the 10-minute poll', async () => {
    vi.useFakeTimers()
    try {
      for (const env of [{}, { COS_WORK_USAGE_POLL: '0' }, { COS_WORK_USAGE_POLL: 'true' }, { COS_WORK_USAGE_POLL: '' }] as NodeJS.ProcessEnv[]) {
        expect(usagePollOptedIn(env)).toBe(false)
        const claude = vi.fn(async () => parseClaudeUsage(claudeFixture)!), codex = vi.fn(async () => parseCodexUsage(codexFixture)!)
        const m = new UsageMonitor({ probes: { claude, codex } })
        m.start(env)
        await vi.advanceTimersByTimeAsync(3 * USAGE_POLL_MS)
        expect([JSON.stringify(env), claude.mock.calls.length, codex.mock.calls.length]).toEqual([JSON.stringify(env), 0, 0])
        m.stop()
      }
      expect(usagePollOptedIn({ COS_WORK_USAGE_POLL: '1' })).toBe(true)
      const claude = vi.fn(async () => parseClaudeUsage(claudeFixture)!), codex = vi.fn(async () => parseCodexUsage(codexFixture)!)
      const m = new UsageMonitor({ probes: { claude, codex } })
      m.start({ COS_WORK_USAGE_POLL: '1' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect([claude.mock.calls.length, codex.mock.calls.length]).toEqual([1, 1])
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
      expect([claude.mock.calls.length, codex.mock.calls.length]).toEqual([2, 2])
      m.stop()
    } finally { vi.useRealTimers() }
  })
  it('on demand: GET answers from a reading under 10 minutes old, refresh=1 and a plan re-read one over 2 minutes', async () => {
    let now = NOW
    const claude = vi.fn(async () => parseClaudeUsage(claudeFixture)!), codex = vi.fn(async () => parseCodexUsage(codexFixture)!)
    const m = new UsageMonitor({ probes: { claude, codex }, now: () => now })
    const calls = () => [claude.mock.calls.length, codex.mock.calls.length]
    // Never read: the first on-demand read probes both.
    const first = await m.onDemand()
    expect(calls()).toEqual([1, 1])
    expect(first.find(v => v.provider === 'claude')).toMatchObject({ state: 'ok', headroomPct: 45, ageSec: 0, source: 'probe' })
    // 3 minutes later: GET answers from the cache; refresh=1 and a plan input re-read.
    now += 3 * 60_000
    await m.onDemand(); expect(calls()).toEqual([1, 1])
    await m.onDemand(true); expect(calls()).toEqual([2, 2])
    now += 3 * 60_000
    const plan = await m.forPlan(); expect(calls()).toEqual([3, 3])
    expect(plan.find(v => v.provider === 'codex')).toMatchObject({ state: 'low', ageSec: 0 })
    // Under 2 minutes: nothing re-reads, not even a plan.
    now += USAGE_FRESH_MS - 1000
    await m.forPlan(); await m.onDemand(true); await m.onDemand(); expect(calls()).toEqual([3, 3])
    // Past 10 minutes since the last read: a plain GET re-reads.
    now += USAGE_CACHE_MS - USAGE_FRESH_MS + 2000
    await m.onDemand(); expect(calls()).toEqual([4, 4])
  })
})

describe('7.0.39: a window that has reset no longer counts', () => {
  // The reading on Miles's Mac on 2026-11-14: Claude last read on Oct 23 (week 23% used, reset Oct 26), probes failing since.
  const LATER = Date.parse('2026-11-14T16:03:54Z')
  const oct23 = { plan: 'max', allowed: null, available: true, windows: [
    { kind: 'session', usedPct: 2, resetsAt: '2026-10-23T18:09:59.848Z' },
    { kind: 'weekly_all', usedPct: 23, resetsAt: '2026-10-26T07:59:59.848Z' },
    { kind: 'weekly_scoped', usedPct: 0, resetsAt: '2026-10-26T08:00:00.000Z' }] }
  const entry = (over: Record<string, unknown> = {}) => ({ provider: 'claude' as const, reading: oct23, observedAt: Date.parse('2026-10-23T14:18:57Z'), source: 'probe' as const,
    lastError: 'unknown get_usage shape', failures: 1, pausedUntil: null, limitUntil: null, limitSource: null, warning: true, ...over })
  it('every binding window past its reset: unknown, no headroom, no reset, and the note says why (never the old 77%)', () => {
    expect(viewOf(entry(), LATER)).toMatchObject({ state: 'unknown', headroomPct: null, resetsAt: null,
      note: 'not read since its window ended; last read failed: unknown get_usage shape' })
  })
  it('only the windows past their reset drop out: a reset 5-hour window does not bind, the live week still does', () => {
    const mixed = { ...oct23, windows: [{ kind: 'session', usedPct: 99, resetsAt: '2026-11-14T15:00:00Z' }, { kind: 'weekly_all', usedPct: 30, resetsAt: '2026-11-16T08:00:00Z' }] }
    expect(viewOf(entry({ reading: mixed, warning: false }), LATER)).toMatchObject({ state: 'ok', headroomPct: 70, resetsAt: '2026-11-16T08:00:00Z' })
  })
  it('the boundary: a window resetting exactly now, or a second ago, has ended; one resetting a second from now still counts', () => {
    const at = (ms: number) => ({ kind: 'weekly_all', usedPct: 40, resetsAt: new Date(ms).toISOString() })
    expect([windowLive(at(LATER), LATER), windowLive(at(LATER - 1000), LATER), windowLive(at(LATER + 1000), LATER)]).toEqual([false, false, true])
    expect(viewOf(entry({ reading: { ...oct23, windows: [at(LATER)] }, warning: false }), LATER)).toMatchObject({ state: 'unknown', headroomPct: null })
    expect(viewOf(entry({ reading: { ...oct23, windows: [at(LATER + 1000)] }, warning: false }), LATER)).toMatchObject({ state: 'ok', headroomPct: 60 })
  })
  it('a reset COS cannot parse counts as live (the same as no reset given): the percentage is not thrown away on a bad date', () => {
    const odd = { kind: 'weekly_all', usedPct: 40, resetsAt: 'next Sunday' }
    expect([windowLive(odd, LATER), windowLive({ ...odd, resetsAt: null }, LATER)]).toEqual([true, true])
    expect(viewOf(entry({ reading: { ...oct23, windows: [odd] }, warning: false }), LATER)).toMatchObject({ state: 'ok', headroomPct: 60 })
  })
  it('a stated limit still wins over windows that have reset; a warning stops counting once the window it warned about resets', () => {
    expect(viewOf(entry({ limitUntil: LATER + 60_000, limitSource: 'rate_limit_event' }), LATER)).toMatchObject({ state: 'exhausted', headroomPct: 0 })
    const live = { ...oct23, windows: [{ kind: 'weekly_all', usedPct: 50, resetsAt: '2026-11-16T08:00:00Z' }] }
    expect(viewOf(entry({ reading: live, warningUntil: LATER - 1 }), LATER)).toMatchObject({ state: 'ok', headroomPct: 50 })
    expect(viewOf(entry({ reading: live, warningUntil: LATER + 60_000 }), LATER)).toMatchObject({ state: 'low', headroomPct: 50 })
    const m = new UsageMonitor({ probes: { claude: async () => live as any, codex: async () => live as any }, now: () => LATER })
    m.noteClaudeRateLimitEvent({ rate_limit_info: { status: 'allowed_warning', resetsAt: Math.round((LATER + 3_600_000) / 1000) } })
    expect(m.entry('claude')).toMatchObject({ warning: true, warningUntil: Math.round((LATER + 3_600_000) / 1000) * 1000 })
  })
})

function fakeSpawn(answer: (line: Record<string, any>, emit: (o: unknown) => void) => void) {
  const writes: string[] = [], calls: Array<{ bin: string; args: string[]; cwd: string }> = []
  let killed = 0
  const spawnFn: SpawnLines = (bin, args, cwd) => {
    calls.push({ bin, args, cwd })
    const fns: Array<(o: any) => void> = []
    return {
      pid: 4242,
      write: line => { writes.push(line); queueMicrotask(() => answer(JSON.parse(line), o => fns.forEach(fn => fn(o)))) },
      end: () => {}, kill: () => { killed++ }, onLine: fn => { fns.push(fn) }, onExit: () => {},
    }
  }
  return { spawnFn, writes, calls, killed: () => killed }
}

describe('the probes on the wire', () => {
  it('Claude: initialize then get_usage with skip_behaviors, hooks and MCP off, in a scratch directory; no turn is sent', async () => {
    const f = fakeSpawn((line, emit) => { if (line.request?.subtype === 'get_usage') emit({ type: 'control_response', response: { subtype: 'success', request_id: 'cos_usage', response: claudeFixture } }) })
    const reading = await probeClaudeUsage(f.spawnFn, 2000)
    expect(reading.windows).toHaveLength(3)
    expect(f.writes.map(w => JSON.parse(w))).toEqual(CLAUDE_USAGE_LINES)
    expect(f.writes.join('\n')).not.toMatch(/"type":"user"/)
    expect(f.calls[0]!.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })]))
    expect(f.calls[0]!.cwd).toMatch(/cos-usage-/)
  })
  it('Codex: initialize, initialized, account/rateLimits/read; never supportsLunaReserve, never a reset-credit call', async () => {
    const f = fakeSpawn((line, emit) => { if (line.id === 1) emit({ id: 1, result: {} }); if (line.id === 2) emit({ id: 2, result: codexFixture }) })
    const reading = await probeCodexUsage(f.spawnFn, 2000).catch(e => e)
    if (reading instanceof Error) { expect(reading.message).toBe('codex not found'); return } // no Codex on this machine
    expect(reading.plan).toBe('prolite')
    expect(f.writes.map(w => JSON.parse(w))).toEqual([CODEX_INIT, { method: 'initialized' }, CODEX_READ])
    expect(f.writes.join('\n')).not.toMatch(/supportsLunaReserve|ConsumeAccountRateLimitResetCredit/)
    expect(f.writes.map(w => JSON.parse(w).method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    expect(f.calls[0]!.args).toEqual(['app-server'])
  })
  it('a probe that never answers is killed by its own handle and fails', async () => {
    const f = fakeSpawn(() => {})
    await expect(probeClaudeUsage(f.spawnFn, 50)).rejects.toThrow('timed out')
    expect(f.killed()).toBeGreaterThan(0)
  })
})

describe('7.0.39: Claude answering "limits available" with none (its usage service refused the CLI)', () => {
  const noLimits = { session: {}, subscription_type: 'max', rate_limits_available: true, rate_limits: null, behaviors: null }
  it('is its own result, never "unknown shape", on the wire too', async () => {
    expect(classifyClaudeUsage(noLimits)).toEqual({ code: 'no_limits' })
    expect(classifyClaudeUsage({ rate_limits_available: true, rate_limits: { five_hour: {} } })).toEqual({ code: 'unknown_shape' })
    expect(classifyClaudeUsage(claudeFixture)).toHaveProperty('reading')
    const f = fakeSpawn((line, emit) => { if (line.request?.subtype === 'get_usage') emit({ type: 'control_response', response: { subtype: 'success', request_id: 'cos_usage', response: noLimits } }) })
    const err = await probeClaudeUsage(f.spawnFn, 2000).catch(e => e)
    expect(err).toBeInstanceOf(UsageProbeError)
    expect([err.code, err.message]).toEqual(['no_limits', 'Claude gave no plan limits (its usage service may be refusing reads)'])
  })
  it('holds Claude for 10 minutes across probes and restarts, and counts toward the breaker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos usage.'))
    try {
      let now = NOW
      const path = join(dir, 'usage.json')
      const claude = vi.fn(async () => { throw new UsageProbeError('no_limits', 'Claude gave no plan limits') })
      const codex = vi.fn(async () => parseCodexUsage(codexFixture)!)
      const m = new UsageMonitor({ path, probes: { claude, codex }, now: () => now })
      await m.ensureFresh(); expect(claude).toHaveBeenCalledTimes(1)
      expect(m.entry('claude').holdUntil).toBe(NOW + USAGE_NO_LIMITS_HOLD_MS)
      now += 3 * 60_000
      await m.ensureFresh(); await m.onDemand(true); expect(claude).toHaveBeenCalledTimes(1)
      // A restart keeps the hold (the breaker's pause does not survive a restart; this must).
      const again = new UsageMonitor({ path, probes: { claude, codex }, now: () => now })
      await again.ensureFresh(); expect(claude).toHaveBeenCalledTimes(1)
      now = NOW + USAGE_NO_LIMITS_HOLD_MS + 1000
      await m.ensureFresh(); expect(claude).toHaveBeenCalledTimes(2)
      now += USAGE_NO_LIMITS_HOLD_MS + 1000
      await m.ensureFresh(); expect(claude).toHaveBeenCalledTimes(3)
      expect(m.entry('claude')).toMatchObject({ failures: 3, pausedUntil: now + USAGE_BREAKER_MS })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('every failed read logs one line with a code and no account detail; the view says the reason and the last good read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let now = NOW, fail = false
      const claude = vi.fn(async () => { if (fail) throw new UsageProbeError('no_limits', 'Claude gave no plan limits'); return parseClaudeUsage(claudeFixture)! })
      const m = new UsageMonitor({ probes: { claude, codex: async () => parseCodexUsage(codexFixture)! }, now: () => now })
      await m.refresh('claude')
      fail = true; now += 60_000
      await m.refresh('claude')
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('usage probe claude'))
      expect(lines).toEqual([`[work-orchestrator] usage probe claude failed: no_limits; 1 in a row; last good read ${new Date(NOW).toISOString()}; next read after ${new Date(now + USAGE_NO_LIMITS_HOLD_MS).toISOString()}`])
      expect(lines[0]).not.toMatch(/max|subscription|email|account/i)
      expect(m.views().find(v => v.provider === 'claude')).toMatchObject({ reason: 'no_limits', lastGoodAt: new Date(NOW).toISOString() })
      fail = false; now += USAGE_NO_LIMITS_HOLD_MS + 1000
      await m.refresh('claude')
      expect(m.views().find(v => v.provider === 'claude')).toMatchObject({ reason: null, lastGoodAt: new Date(now).toISOString() })
    } finally { warn.mockRestore() }
  })
})
