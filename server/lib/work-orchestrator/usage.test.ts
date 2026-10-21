// 6.83.0 plan usage (canary C1): parsing the real responses read on 2026-10-20, the rules that decide state, the breaker,
// the freshness rule, and the probes' exact wire (no luna reserve, no reset-credit call), by execution with fake children.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClaudeUsage, parseCodexUsage, parseLimitReset, UsageMonitor, viewOf, probeClaudeUsage, probeCodexUsage,
  CLAUDE_USAGE_LINES, CODEX_INIT, CODEX_READ, USAGE_FRESH_MS, USAGE_BREAKER_MS, type SpawnLines } from './usage.js'

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
  it('the poll does not start when switched off', () => {
    const prior = process.env.COS_WORK_USAGE_POLL
    process.env.COS_WORK_USAGE_POLL = '0'
    try {
      const m = new UsageMonitor({ probes: { claude: vi.fn(), codex: vi.fn() } as any })
      m.start(); expect((m as any).timer).toBeNull(); m.stop()
    } finally { if (prior === undefined) delete process.env.COS_WORK_USAGE_POLL; else process.env.COS_WORK_USAGE_POLL = prior }
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
