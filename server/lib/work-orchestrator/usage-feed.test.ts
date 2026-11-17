// 7.0.54 (U1; Miles 2026-11-17 06:55): Claude's plan use from the readings Claude already has, by where it was read.
// The desktop fixture is the Claude Desktop app's own usage tool reply, read in a desktop session at 07:15 that day (his
// app showed the same at 06:55); its session `context` part is kept in the fixture to prove the writer drops it. The CLI
// feed is the shape the proposed status line step writes (not applied: his typed yes). No test reads a token or the network.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { type Server } from 'node:http'
import {
  desktopKind, desktopReadingFromTool, feedPath, FeedError, MAX_FEED_BYTES, parseCliFeed, readFeed, writeDesktopFeed, type FeedRead,
} from './usage-feed.js'
import { claudeCliEntry, desktopLine, planLine, planPane } from './plan-pane.js'
import { UsageMonitor, type UsageEntry } from './usage.js'
import { createWorkOrchestratorRouter, readPlan } from '../../routes/work-orchestrator.js'
import { requireApiToken } from '../api-auth.js'
import { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from '../web-session-auth.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'claude-desktop-get-usage-2026-11-17.json'), 'utf8'))
const TZ = 'America/Chicago'
const NOW = Date.parse('2026-11-17T13:15:00Z') // 7:15 AM CST
const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cos-usage-feed-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const blank = (provider: 'claude' | 'codex' | 'cursor', over: Partial<UsageEntry> = {}): UsageEntry => ({ provider, reading: null, observedAt: null, source: 'none',
  lastError: null, failures: 0, pausedUntil: null, limitUntil: null, limitSource: null, warning: false, ...over })
const cliFeed = (over: Record<string, unknown> = {}) => ({ v: 1, source: 'cli', at: '2026-11-17T13:10:00Z',
  five_hour: { used_percentage: 12.5, resets_at: 1763400000 }, seven_day: { used_percentage: 38, resets_at: Date.parse('2026-11-22T17:00:00Z') / 1000 }, ...over })

describe('the desktop reading: the Claude Desktop app usage tool reply, checked', () => {
  it('keeps the plan and each window (the week and the per-model week), drops the session context', () => {
    const r = desktopReadingFromTool(TOOL, NOW)
    expect(r).toEqual({ source: 'desktop', at: new Date(NOW).toISOString(), plan: 'Ultra', windows: [
      { label: 'Weekly · all models', kind: 'weekly_all', usedPct: 48, resetsAt: '2026-11-23T08:00:00.197Z' },
      { label: 'Weekly · Fable', kind: 'weekly_scoped', usedPct: 27, resetsAt: '2026-11-23T08:00:00.197Z' }] })
    expect(desktopReadingFromTool(TOOL.plan, NOW)).toEqual(r) // the plan part alone is accepted too
    expect(desktopKind('5-hour')).toBe('session')
  })
  it('refuses anything it cannot vouch for, with a reason and no write', () => {
    const plan = (over: Record<string, unknown>) => ({ plan: { ...TOOL.plan, ...over } })
    const w = (over: Record<string, unknown>) => plan({ windows: [{ ...TOOL.plan.windows[0], ...over }] })
    const reason = (body: unknown) => { try { desktopReadingFromTool(body, NOW); return 'accepted' } catch (e) { return e instanceof FeedError ? e.code : 'other' } }
    expect(reason(plan({ status: 'not_applicable' }))).toBe('not_applicable')
    expect(reason(plan({ status: 'unavailable' }))).toBe('not_ok')
    expect(reason(w({ percentUsed: 101 }))).toBe('bad_percent')
    expect(reason(w({ percentUsed: -1 }))).toBe('bad_percent')
    expect(reason(w({ percentUsed: '48' }))).toBe('bad_percent')
    expect(reason(w({ resetsAt: 'Monday' }))).toBe('bad_time')
    expect(reason(w({ label: 'x'.repeat(61) }))).toBe('bad_label')
    expect(reason(w({ label: 'Weekly\u0007' }))).toBe('bad_label')
    expect(reason(plan({ windows: [] }))).toBe('no_windows')
    expect(reason(plan({ windows: Array.from({ length: 11 }, () => TOOL.plan.windows[0]) }))).toBe('no_windows')
    expect(reason(plan({ plan: 'P'.repeat(61) }))).toBe('bad_plan')
    expect(reason(null)).toBe('bad_shape')
  })
  it('is written atomically, owner-only, with only the checked fields, and read back the same', () => {
    const d = tmp()
    writeDesktopFeed(desktopReadingFromTool(TOOL, NOW), d)
    const path = feedPath('desktop', d)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['at', 'plan', 'source', 'v', 'windows'])
    expect(JSON.stringify(saved)).not.toMatch(/tokensUsed|context|Messages|resetsIn|extraUsage/)
    expect(readFeed('desktop', d)).toEqual({ reading: desktopReadingFromTool(TOOL, NOW), problem: null })
  })
})

describe('the CLI reading: the terminal status line rate_limits, checked', () => {
  it('reads the 5-hour and 7-day windows; resets as epoch seconds, milliseconds or ISO', () => {
    expect(parseCliFeed(cliFeed())).toEqual({ source: 'cli', at: '2026-11-17T13:10:00.000Z', plan: null, windows: [
      { label: '5-hour', kind: 'session', usedPct: 12.5, resetsAt: new Date(1763400000 * 1000).toISOString() },
      { label: 'Weekly · all models', kind: 'weekly_all', usedPct: 38, resetsAt: '2026-11-22T17:00:00.000Z' }] })
    expect(parseCliFeed(cliFeed({ seven_day: { used_percentage: 38, resets_at: Date.parse('2026-11-22T17:00:00Z') } })).windows[1]!.resetsAt).toBe('2026-11-22T17:00:00.000Z')
    expect(parseCliFeed(cliFeed({ seven_day: { used_percentage: 38, resets_at: '2026-11-22T17:00:00Z' } })).windows[1]!.resetsAt).toBe('2026-11-22T17:00:00.000Z')
    expect(parseCliFeed(cliFeed({ five_hour: null })).windows.map(w => w.kind)).toEqual(['weekly_all'])
  })
  it('a missing, unreadable or oversized file is never a reading', () => {
    const d = tmp()
    expect(readFeed('cli', d)).toEqual({ reading: null, problem: 'missing' })
    for (const bad of ['{', JSON.stringify(cliFeed({ v: 2 })), JSON.stringify(cliFeed({ source: 'desktop' })), JSON.stringify(cliFeed({ seven_day: { used_percentage: 140 } })),
      JSON.stringify(cliFeed({ five_hour: null, seven_day: null })), JSON.stringify(cliFeed({ at: 'yesterday' }))]) {
      writeFileSync(feedPath('cli', d), bad)
      expect(readFeed('cli', d), bad).toEqual({ reading: null, problem: 'unreadable' })
    }
    writeFileSync(feedPath('cli', d), JSON.stringify(cliFeed({ pad: 'x'.repeat(MAX_FEED_BYTES) })))
    expect(readFeed('cli', d)).toEqual({ reading: null, problem: 'unreadable' })
  })
})

describe('the two Claude rows (Miles: "Claude desktop vs the CLI")', () => {
  const desktop = (at = NOW): FeedRead => ({ reading: desktopReadingFromTool(TOOL, at), problem: null })
  it('Claude Desktop: its plan, the week as the ruler, the per-model week in words, and its read time', () => {
    const line = desktopLine(desktop(), NOW, TZ)
    expect(line).toMatchObject({ provider: 'claude_desktop', name: 'Claude Desktop', state: 'fresh', usedPct: 48, readAt: new Date(NOW).toISOString(), quiet: 'Claude Desktop 48% used' })
    expect(line.long).toContain('Ultra plan.')
    expect(line.long).toContain('Also Weekly · Fable 27%.')
    expect(line.gonePct).toBeGreaterThan(0)
  })
  it('an old desktop reading shows its age and is never shown as current', () => {
    const line = desktopLine(desktop(NOW - 3 * 3_600_000), NOW, TZ)
    expect(line).toMatchObject({ state: 'older', usedPct: 48, short: '48% used, read 3 h ago' })
  })
  it('no desktop reading says so plainly; an unreadable one draws no number', () => {
    expect(desktopLine({ reading: null, problem: 'missing' }, NOW, TZ)).toMatchObject({ state: 'not_read', usedPct: null, short: 'No reading yet',
      long: 'No reading from Claude Desktop yet. A desktop session records one when it checks its usage.' })
    expect(desktopLine({ reading: null, problem: 'unreadable' }, NOW, TZ)).toMatchObject({ state: 'failed', usedPct: null })
    const ended = desktopLine({ reading: desktopReadingFromTool(TOOL, Date.parse('2026-11-16T10:00:00Z')), problem: null }, Date.parse('2026-11-24T10:00:00Z'), TZ)
    expect(ended).toMatchObject({ state: 'not_read', usedPct: null })
    expect(ended.long).toContain('A desktop session records one when it checks its usage.')
    expect(ended.long).not.toContain('Refresh')
  })
  it('Claude CLI: a newer status line reading beats the probe, even when the probe is paused after failing', () => {
    const probe = blank('claude', { observedAt: Date.parse('2026-11-16T22:26:32Z'), lastFailure: 'unknown_shape', pausedUntil: NOW + 30 * 60_000,
      reading: { plan: 'max', allowed: null, available: true, windows: [] } })
    const cli: FeedRead = { reading: parseCliFeed(cliFeed()), problem: null }
    const line = planLine(claudeCliEntry(probe, cli), NOW, TZ)
    expect(line).toMatchObject({ provider: 'claude', name: 'Claude CLI', state: 'fresh', usedPct: 38, until: null, readAt: '2026-11-17T13:10:00.000Z' })
    // An older status line reading never hides a newer probe answer.
    const newer = blank('claude', { observedAt: NOW, reading: { plan: 'max', allowed: null, available: true, windows: [{ kind: 'weekly_all', usedPct: 40, resetsAt: '2026-11-22T17:00:00Z' }] } })
    expect(planLine(claudeCliEntry(newer, cli), NOW, TZ).usedPct).toBe(40)
    // A limit the probe was told about still beats the status line's percent.
    expect(planLine(claudeCliEntry({ ...probe, limitUntil: NOW + 3_600_000, limitSource: 'provider_limit' }, cli), NOW, TZ)).toMatchObject({ state: 'limit', until: new Date(NOW + 3_600_000).toISOString() })
  })
  it('the pane: Claude CLI, then Claude Desktop, then Codex and Cursor; the closest across all four', () => {
    const pane = planPane([blank('claude'), blank('codex'), blank('cursor')], NOW, TZ, false, { cli: { reading: null, problem: 'missing' }, desktop: desktop() })
    expect(pane.lines.map(l => l.provider)).toEqual(['claude', 'claude_desktop', 'codex', 'cursor'])
    expect(pane.closest).toBe('claude_desktop')
    expect(planPane([blank('claude'), blank('codex'), blank('cursor')], NOW, TZ).lines.map(l => l.provider)).toEqual(['claude', 'codex', 'cursor'])
  })
})

describe('the expired pause (Control showed "Paused until 11:50 PM" at 6:55 the next morning)', () => {
  it('a paused line names its day and says when its words stop being true', () => {
    const at2250 = Date.parse('2026-11-17T04:50:21Z') // 10:50 PM CST on Nov 16
    const line = planLine(blank('claude', { lastFailure: 'unknown_shape', pausedUntil: Date.parse('2026-11-17T05:50:21Z') }), at2250, TZ)
    expect(line).toMatchObject({ state: 'paused', short: 'Paused until tonight 11:50 PM', until: '2026-11-17T05:50:21.000Z' })
    // Read again the next morning, the server says the read failed; it does not repeat the pause.
    expect(planLine(blank('claude', { lastFailure: 'unknown_shape', pausedUntil: Date.parse('2026-11-17T05:50:21Z') }), NOW, TZ)).toMatchObject({ state: 'failed', until: null })
  })
})

describe('POST /api/usage/feed/claude-desktop, through the real /api gate (Q1 07:38)', () => {
  const API_TOKEN = 'a'.repeat(48)
  /** The server's own order: the global 10 MB JSON parser, then requireApiToken on /api, then the router. */
  async function serve(write: (r: unknown) => void) {
    let port = 0
    const app = express(); app.use(express.json({ limit: '10mb' }))
    app.use('/api', requireApiToken(API_TOKEN, { allowedPorts: () => [port], selfDnsName: () => null }))
    app.use('/api', createWorkOrchestratorRouter({ writeDesktopFeed: write as never, now: () => NOW, plan: async () => ({ protocolVersion: 1, now: '', readAt: null, closest: null, others: '', lines: [] }) as never }))
    const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as { port: number }).port
    const origin = `http://127.0.0.1:${port}`
    const cookie = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(API_TOKEN, Date.now(), 600_000).value}`
    const post = (headers: Record<string, string>, body: unknown) => fetch(origin + '/api/usage/feed/claude-desktop', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { origin, cookie, post, close: () => new Promise(r => server.close(r)) }
  }
  it('the token writes a checked reading; a bad one is refused with its reason and nothing written', async () => {
    const written: unknown[] = []
    const s = await serve(r => written.push(r))
    try {
      const ok = await s.post({ 'x-cos-token': API_TOKEN }, TOOL)
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true, at: new Date(NOW).toISOString(), plan: 'Ultra', windows: 2 })
      expect(written).toEqual([desktopReadingFromTool(TOOL, NOW)])
      const bad = await s.post({ 'x-cos-token': API_TOKEN }, { plan: { ...TOOL.plan, windows: [{ ...TOOL.plan.windows[0], percentUsed: 480 }] } })
      expect([bad.status, await bad.json()]).toEqual([400, { error: 'invalid_reading', reason: 'bad_percent' }])
      // A reset past the last date JavaScript can hold is a refused reading, not a server error.
      const huge = await s.post({ 'x-cos-token': API_TOKEN }, { plan: { ...TOOL.plan, windows: [{ ...TOOL.plan.windows[0], resetsAt: 1e16 }] } })
      expect([huge.status, await huge.json()]).toEqual([400, { error: 'invalid_reading', reason: 'bad_time' }])
      expect(written).toHaveLength(1)
    } finally { await s.close() }
  })
  it('a signed-in Control Web cookie is refused (403) and writes nothing, though the same cookie passes the gate', async () => {
    const written: unknown[] = []
    const s = await serve(r => written.push(r))
    try {
      const web = { cookie: s.cookie, 'x-cos-web': '1', origin: s.origin }
      // Control: the cookie does get through the /api gate (the plan route answers it).
      expect((await fetch(s.origin + '/api/usage/plan', { headers: { cookie: s.cookie } })).status).toBe(200)
      const r = await s.post(web, TOOL)
      expect([r.status, await r.json()]).toEqual([403, { error: 'token_required' }])
      expect((await s.post({}, TOOL)).status).toBe(401)
      expect(written).toEqual([])
    } finally { await s.close() }
  })
  it('a body over 16 KB is refused (413) before it is read as a reading', async () => {
    const written: unknown[] = []
    const s = await serve(r => written.push(r))
    try {
      const body = JSON.stringify({ ...TOOL, pad: 'x'.repeat(MAX_FEED_BYTES) })
      expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_FEED_BYTES)
      const r = await s.post({ 'x-cos-token': API_TOKEN }, body)
      expect([r.status, await r.json()]).toEqual([413, { error: 'reading_too_large' }])
      const atCap = JSON.stringify({ ...TOOL, pad: 'x'.repeat(MAX_FEED_BYTES - Buffer.byteLength(JSON.stringify({ ...TOOL, pad: '' }))) })
      expect(Buffer.byteLength(atCap)).toBe(MAX_FEED_BYTES)
      expect((await s.post({ 'x-cos-token': API_TOKEN }, atCap)).status).toBe(200)
      expect(written).toHaveLength(1)
    } finally { await s.close() }
  })
  it('the plan route reads both feeds from the data folder and draws the rows (no network)', async () => {
    const d = tmp()
    writeDesktopFeed(desktopReadingFromTool(TOOL, NOW), d)
    mkdirSync(d, { recursive: true }); writeFileSync(feedPath('cli', d), JSON.stringify(cliFeed()))
    const m = new UsageMonitor({ probes: { claude: async () => { throw new Error('a failing probe') }, codex: async () => { throw new Error('x') } }, now: () => NOW, cursorPlan: false })
    const pane = await readPlan(false, m, () => NOW, () => ({ cli: readFeed('cli', d), desktop: readFeed('desktop', d) }))
    expect(pane.lines.map(l => [l.provider, l.name, l.usedPct])).toEqual([['claude', 'Claude CLI', 38], ['claude_desktop', 'Claude Desktop', 48], ['codex', 'Codex', null], ['cursor', 'Cursor', null]])
  })
})
