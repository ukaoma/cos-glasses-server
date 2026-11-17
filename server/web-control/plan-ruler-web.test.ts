/**
 * 7.0.41 (U1; Miles 2026-11-14 12:16, "Collapsed, tap to open"): the plan ruler at the top of Sessions > Usage. Runs the
 * REAL panes/plan-ruler.js in a vm with a small fake DOM. Pinned: closed by default; the closed row shows the tool closest
 * to its limit with its ruler and the rest in quiet words; a failed, paused or missing reading draws no ruler (never 0%);
 * numbers are hidden while reading; the tap opens it and this device remembers; Refresh asks for a fresh read; a refresh
 * keeps the same rows (so the same height); the element is put back at the top of the Usage box after each repaint.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import express from 'express'
import { type Server } from 'node:http'
import { createWorkOrchestratorRouter, readPlan } from '../routes/work-orchestrator.js'
import { UsageMonitor, parseClaudeUsage, parseCodexUsage } from '../lib/work-orchestrator/usage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'panes', 'plan-ruler.js'), 'utf8')
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

class FakeEl {
  className = ''; id = ''; innerHTML = ''; parentNode: FakeEl | null = null; children: FakeEl[] = []; attrs: Record<string, string> = {}
  listeners: Record<string, Function[]> = {}; focused = 0
  classList = { set: new Set<string>(), toggle: (c: string, on: boolean) => { if (on) this.classList.set.add(c); else this.classList.set.delete(c) }, contains: (c: string) => this.classList.set.has(c) }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  addEventListener(t: string, fn: Function) { (this.listeners[t] ??= []).push(fn) }
  get firstChild() { return this.children[0] ?? null }
  insertBefore(el: FakeEl, ref: FakeEl | null) { this.children = this.children.filter(c => c !== el); const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? 0 : i, 0, el); el.parentNode = this }
  removeChild(el: FakeEl) { this.children = this.children.filter(c => c !== el); el.parentNode = null }
  contains(x: any) { return x && x.__inside === this }
  querySelector(sel: string) { const self = this; return { focus() { self.focused++ }, sel } }
}

function load(stored: Record<string, string> = {}) {
  const calls: string[] = []
  let answer: (v: unknown) => void = () => {}
  const store = { ...stored }
  const doc = { createElement: () => new FakeEl(), activeElement: null as any }
  const panes: Record<string, any> = {}
  const W = { esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    api: (url: string) => { calls.push(url); return new Promise(r => { answer = r }) }, registerPane: (n: string, d: any) => { panes[n] = d } }
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } }
  vm.runInNewContext(SOURCE, { window: { COSWeb: W }, document: doc, localStorage })
  const p = panes.planRuler
  const el = () => p._state.el as FakeEl
  const click = (cls: string) => { const t = { __inside: el(), classList: { contains: (c: string) => c === cls }, closest() { return t } }; el().listeners.click!.forEach(fn => fn({ target: t })) }
  return { p, calls, store, el, click, answer: (v: unknown) => answer(v) }
}

const line = (provider: string, name: string, over: Record<string, unknown>) => ({ provider, name, state: 'fresh', usedPct: null, gonePct: null, windowStart: null, resetsAt: null,
  windowWords: 'Week not known', short: '', shortLong: '', long: '', quiet: '', readAt: null, lastGoodAt: null, reason: null, estimate: null, ...over })
const PANE = { protocolVersion: 1, now: '2026-11-14T16:03:55.000Z', readAt: '2026-11-14T16:03:55.000Z', closest: 'codex', others: 'Claude read failed. Cursor no plan reading.',
  lines: [
    line('claude', 'Claude', { state: 'failed', short: 'Read failed, refused by Claude', shortLong: 'Read failed, refused by Claude', long: 'Read failed: refused by Claude. No number is shown until a read succeeds.', quiet: 'Claude read failed', reason: 'no_limits' }),
    line('codex', 'Codex', { usedPct: 96, gonePct: 92.6, windowWords: 'Nov 7, 10:31 PM to Nov 14, 10:31 PM', short: '96% used, resets tonight', shortLong: '96% used, resets tonight 10:31 PM',
      long: '96% used. 93% of the week gone.', quiet: 'Codex 96% used', readAt: '2026-11-14T16:03:55.000Z',
      estimate: { text: "At this week's average pace, Codex reaches its limit about 4:30 PM, before it resets tonight 10:31 PM.", arithmetic: 'Worked out from 96% used in 6 days 11.5 hours of 7 days, about 0.6% an hour.' } }),
    line('cursor', 'Cursor', { state: 'no_plan', short: 'No plan reading', shortLong: 'No plan reading', long: 'No plan reading. Cursor does not report its plan to COS.', quiet: 'Cursor no plan reading' }),
  ] }

describe('7.0.54: two Claude rows, and a pane kept past its pause (Control at 6:55 showed a 10:50 PM pause as current)', () => {
  it('a line whose pause has ended is not shown as current; the read time names its day; every row has a colour', async () => {
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString()
    const n0 = new Date(now)
    const readAt = new Date(n0.getFullYear(), n0.getMonth(), n0.getDate() - 1, 12, 0).toISOString() // always yesterday, at noon
    const pane = { protocolVersion: 1, now: readAt, readAt, closest: 'claude_desktop', others: 'Claude CLI paused. Codex 30% used.',
      lines: [
        line('claude', 'Claude CLI', { state: 'paused', short: 'Paused until tonight 11:50 PM', shortLong: 'Paused until tonight 11:50 PM',
          long: 'Paused until tonight 11:50 PM. COS waits before asking Claude CLI again.', quiet: 'Claude CLI paused', until: iso(Date.parse(readAt) + 3_600_000) }),
        line('claude_desktop', 'Claude Desktop', { usedPct: 48, gonePct: 18, short: '48% used, resets Sun', shortLong: '48% used, resets Sun 2:00 AM', long: '48% used. Ultra plan.', quiet: 'Claude Desktop 48% used', until: null }),
        line('some_new_tool', 'Some new tool', { usedPct: 30, short: '30% used', shortLong: '30% used', long: '30% used.', quiet: 'Some new tool 30% used', until: null }),
      ] }
    const t = load({ 'cos.usage.planOpen': '1' })
    void t.p.open(false); t.answer(pane); await flush()
    const html = t.el().innerHTML
    expect(html).not.toContain('Paused until')
    expect(html).not.toContain('Claude CLI paused')
    expect(html).toContain('Claude CLI: pause over.')
    expect(html).toContain('The pause ended yesterday at 1:00 PM.')   // the lead 09:0x: never "ended at yesterday 1:00 PM"
    expect(html).not.toContain('ended at yesterday')
    expect(html).toContain('Claude Desktop')
    expect(html).not.toContain('background:undefined')
    expect(html).toContain('background:var(--up-claude)')
    expect(html).not.toContain('var(--u-gold)')
    expect(html).toContain('background:var(--sub)')
    expect(html).toContain('Read yesterday 12:00 PM.')
  })
  it('the closed row lead line is guarded too: an ended limit says "Limit over", never "Limit reached" (Q1 U13, U14)', async () => {
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString()
    const pane = { protocolVersion: 1, now: iso(now - 9 * 3_600_000), readAt: iso(now - 9 * 3_600_000), closest: 'claude', others: 'Codex 30% used.', lines: [
      line('claude', 'Claude CLI', { state: 'limit', usedPct: 100, short: 'Limit reached, back tonight 11:50 PM', shortLong: 'Limit reached, back tonight 11:50 PM',
        long: 'Limit reached. Claude CLI says new work waits until tonight 11:50 PM.', quiet: 'Claude CLI at its limit', until: iso(now - 3_600_000) }),
      line('codex', 'Codex', { usedPct: 30, short: '30% used', shortLong: '30% used', long: '30% used.', quiet: 'Codex 30% used', until: null })] }
    const t = load()
    void t.p.open(false); t.answer(pane); await flush()
    const head = t.el().innerHTML
    expect(head).not.toContain('Limit reached')
    expect(head).toContain('Limit over')
    t.click('up-toggle')
    expect(t.el().innerHTML).toMatch(/The limit ended (yesterday )?at \d{1,2}:\d{2} [AP]M\./)   // yesterday only just after midnight
    expect(t.el().innerHTML).not.toContain('width:100%')
  })
  it('a pause still running keeps its words', async () => {
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString()
    const pane = { protocolVersion: 1, now: iso(now), readAt: iso(now), closest: null, others: '', lines: [
      line('claude', 'Claude CLI', { state: 'paused', short: 'Paused until today 9:15 AM', shortLong: 'Paused until today 9:15 AM', long: 'Paused until today 9:15 AM.', quiet: 'Claude CLI paused', until: iso(now + 600_000) })] }
    const t = load({ 'cos.usage.planOpen': '1' })
    void t.p.open(false); t.answer(pane); await flush()
    expect(t.el().innerHTML).toContain('Paused until today 9:15 AM')
    expect(t.el().innerHTML).not.toContain('Pause over')
  })
})

describe('the plan ruler on Control Web (Miles: "Collapsed, tap to open")', () => {
  it('is closed by default: one row with the tool closest to its limit, its ruler, and the rest in quiet words', async () => {
    const t = load()
    void t.p.open(false); t.answer(PANE); await flush()
    const html = t.el().innerHTML
    expect(t.calls).toEqual(['/api/usage/plan'])
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('id="usage-plan-rows"')
    expect(html).toContain('96% used, resets tonight 10:31 PM')
    expect(html).toContain('Claude read failed. Cursor no plan reading.')
    expect(html.match(/class="up-mini"/g)?.length).toBe(1)
    expect(html).not.toMatch(/pill|chip|eyebrow/i)
  })
  it('a failed or missing reading draws no ruler, open or closed: only the stated reading has one', async () => {
    const t = load({ 'cos.usage.planOpen': '1' })
    void t.p.open(false); t.answer(PANE); await flush()
    const html = t.el().innerHTML
    expect(html.match(/class="up-track"/g)?.length).toBe(1)
    expect(html).toContain('Read failed: refused by Claude. No number is shown until a read succeeds.')
    expect(html).not.toMatch(/width:0%/)
  })
  it('hides every number while reading, and keeps the same rows so the height does not move', async () => {
    const t = load({ 'cos.usage.planOpen': '1' })
    void t.p.open(false); t.answer(PANE); await flush()
    const lanes = t.el().innerHTML.match(/class="up-lane"/g)?.length, est = t.el().innerHTML.match(/class="up-est"/g)?.length
    t.click('up-refresh')
    expect(t.calls).toEqual(['/api/usage/plan', '/api/usage/plan?refresh=1'])
    const reading = t.el().innerHTML
    expect(reading).toContain('Reading…')
    expect(reading).not.toMatch(/\d+%/)
    expect([reading.match(/class="up-lane"/g)?.length, reading.match(/class="up-est"/g)?.length]).toEqual([lanes, est])
    t.answer(PANE); await flush()
    expect([t.el().innerHTML.match(/class="up-lane"/g)?.length, t.el().innerHTML.match(/class="up-est"/g)?.length]).toEqual([3, 1])
  })
  it('opens on a tap, shows each tool and the labelled estimate with its arithmetic, and this device remembers', async () => {
    const t = load()
    void t.p.open(false); t.answer(PANE); await flush()
    t.click('up-toggle')
    const html = t.el().innerHTML
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('<b>Estimate:</b> At this week&#39;s average pace'.replace('&#39;', "'"))
    expect(html).toContain('Worked out from 96% used in 6 days 11.5 hours of 7 days, about 0.6% an hour.')
    expect(t.store['cos.usage.planOpen']).toBe('1')
    t.click('up-toggle')
    expect(t.store['cos.usage.planOpen']).toBeUndefined()
    expect(t.el().innerHTML).not.toContain('id="usage-plan-rows"')
  })
  it('a read that fails shows no numbers and says so', async () => {
    const t = load()
    const done = t.p.open(false)
    t.answer(Promise.reject(new Error('503')) as any); await done.catch(() => {}); await flush()
    expect(t.el().innerHTML).toContain('Plan use could not be read. Refresh to try again.')
    expect(t.el().innerHTML).not.toMatch(/\d+%/)
  })
  it('sits at the top of the Usage box, goes back there after a repaint, and leaves for COS cost', async () => {
    const t = load()
    void t.p.open(false); t.answer(PANE); await flush()
    const box = new FakeEl(), other = new FakeEl()
    box.children = [other]
    t.p.mount(box, true)
    expect(box.firstChild).toBe(t.el())
    box.children = [other]; t.p.mount(box, true)
    expect(box.children).toEqual([t.el(), other])
    t.p.mount(box, false)
    expect(box.children).toEqual([other])
  })
  it('Q1 e3c3bb9e: one read at a time; Refresh is disabled and the read time hidden while reading', async () => {
    const t = load()
    void t.p.open(false); void t.p.open(false)
    expect(t.calls).toEqual(['/api/usage/plan'])
    expect(t.el().innerHTML).toContain('<button class="up-refresh" type="button" disabled>Refresh</button>')
    t.click('up-refresh')
    expect(t.calls).toEqual(['/api/usage/plan'])
    t.answer(PANE); await flush()
    expect(t.el().innerHTML).toContain('Read ')
    expect(t.el().innerHTML).toContain('<button class="up-refresh" type="button">Refresh</button>')
    t.click('up-refresh')
    expect(t.el().innerHTML).not.toMatch(/Read \d/)
    expect(t.calls).toEqual(['/api/usage/plan', '/api/usage/plan?refresh=1'])
  })
  it('Q1 e3c3bb9e: an answer with no lines is not a pane; it says it was not read and draws nothing', async () => {
    const t = load({ 'cos.usage.planOpen': '1' })
    void t.p.open(false); t.answer({ protocolVersion: 1, closest: 'codex', others: '' }); await flush()
    expect(t.p._state.pane).toBeNull()
    expect(t.el().innerHTML).toContain('Plan use was not read.')
    expect(t.el().innerHTML).not.toMatch(/up-mini|up-track/)
  })
  it('Q1 e3c3bb9e: every server word is escaped, open and closed', async () => {
    const bad = '<img src=x onerror=alert(1)>'
    const evil = { ...PANE, others: bad, lines: PANE.lines.map(l => ({ ...l, name: bad, windowWords: l.windowWords && bad, short: bad, shortLong: bad, long: bad,
      estimate: l.estimate && { text: bad, arithmetic: bad } })) }
    const t = load()
    void t.p.open(false); t.answer(evil); await flush()
    expect(t.el().innerHTML).not.toContain('<img')
    t.click('up-toggle')
    const html = t.el().innerHTML
    expect(html).not.toContain('<img')
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)!.length).toBeGreaterThanOrEqual(9)
  })
  it('Q1 e3c3bb9e: the ruler holds its fill to 0 to 100, a reached limit fills in the warning colour, and no estimate says why', async () => {
    const t = load({ 'cos.usage.planOpen': '1' })
    const lines = [PANE.lines[0], { ...PANE.lines[1], usedPct: 130, estimate: null }, { ...PANE.lines[2], usedPct: -5, state: 'limit', provider: 'cursor' }]
    void t.p.open(false); t.answer({ ...PANE, lines }); await flush()
    const html = t.el().innerHTML
    expect(html).toContain('width:100%;background:var(--u-codex)')
    expect(html).toContain('width:0%;background:var(--up-warn)')
    expect(html).toContain('No estimate: no plan is far enough into its week to project.')
  })
  it('Q1 e3c3bb9e: mounting paints the closed row at once, and the toggle keeps focus after a tap', () => {
    const t = load()
    const box = new FakeEl()
    t.p.mount(box, true)
    expect(t.el().innerHTML).toContain('aria-expanded="false"')
    expect(t.el().innerHTML).toContain('Plan use was not read.')
    t.click('up-toggle')
    expect(t.el().focused).toBe(1)
  })
  it('index.html loads it and the Usage view mounts it after each paint', () => {
    const index = readFileSync(join(HERE, 'index.html'), 'utf8'), app = readFileSync(join(HERE, 'app.js'), 'utf8')
    expect(index).toContain('"planRuler": "/control/panes/plan-ruler.js"')
    // Styles live at the end of sessions.css, so the boot stylesheet list (blank-open-web.test.ts) is unchanged.
    expect(readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')).toContain('.up-toggle {')
    expect(index).not.toContain('plan-ruler.css')
    expect(app).toContain("if (SX.view === 'usage') ensurePane('planRuler')")
    expect(app.match(/mountPlanRuler\(\)/g)?.length).toBe(4)
  })
  it("Q1 e3c3bb9e: opening Usage asks plainly (the 10-minute rule) and only the view's Refresh asks for a fresh read; runs app.js's renderUsageView", async () => {
    const app = readFileSync(join(HERE, 'app.js'), 'utf8')
    const start = app.indexOf('  function renderUsageView(force) {'), end = app.indexOf('  // background: a refresh or a breakpoint change')
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const run = async (view: string, force: unknown) => {
      const opens: unknown[] = [], mounts: number[] = []
      const ctx: Record<string, any> = {
        SX: { view, usage: { ok: 1 }, usageAt: Date.now(), usageLoading: false },
        $: () => ({ innerHTML: '' }), uLoadPrefs() {}, uWire() {}, paintUsage() {}, paintSessionsHero() {},
        api: () => new Promise(() => {}), mountPlanRuler: () => { mounts.push(1) },
        ensurePane: () => Promise.resolve({ open: (refresh: unknown) => { opens.push(refresh) } }), Date,
      }
      vm.createContext(ctx)
      vm.runInContext(app.slice(start, end) + '\n;this.__ = renderUsageView;', ctx)
      ctx.__(force); await flush()
      return { opens, mounts: mounts.length }
    }
    expect(await run('usage', undefined)).toEqual({ opens: [false], mounts: 1 })
    expect(await run('usage', false)).toEqual({ opens: [false], mounts: 1 })
    expect(await run('usage', true)).toEqual({ opens: [true], mounts: 1 })
    expect(await run('usage', 'yes')).toEqual({ opens: [false], mounts: 1 })
    expect(await run('cost', true)).toEqual({ opens: [], mounts: 0 })
  })
})

// Lead 13:00 (blocking for the ruler): Miles's rule, "read when I open Usage, at most once every 10 minutes", proved by
// execution. app.js's own renderUsageView and mountPlanRuler, the real pane, the real route over HTTP and the real
// UsageMonitor, with a fake clock and counting probes. Counted: every request the page sends, which carry ?refresh=1, and
// every read of the plan endpoints.
describe("Miles's rule on Control Web: a read when Usage opens, at most once every 10 minutes; Refresh reads one over 2", () => {
  it('open, many repaints, reopen inside 10 minutes, Refresh twice, reopen at 9 and 11 minutes: exact requests and reads', async () => {
    const FIX = join(HERE, '..', 'lib', 'work-orchestrator', '__fixtures__')
    const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'))
    let now = Date.parse('2026-10-21T03:10:00Z')
    const reads = { claude: 0, codex: 0 }
    const monitor = new UsageMonitor({ now: () => now, pollEnabled: false, probes: {
      claude: async () => { reads.claude++; return parseClaudeUsage(fixture('claude-get-usage-2026-10-20.json'))! },
      codex: async () => { reads.codex++; return parseCodexUsage(fixture('codex-rate-limits-2026-10-20.json'))! } } })
    const server = express()
    server.use('/api', createWorkOrchestratorRouter({ plan: refresh => readPlan(refresh, monitor, () => now) }))
    const s = await new Promise<Server>(resolve => { const x = server.listen(0, '127.0.0.1', () => resolve(x)) })
    const base = `http://127.0.0.1:${(s.address() as any).port}`
    try {
      // The real pane, its api over HTTP to the real route.
      const sent: string[] = []
      const panes: Record<string, any> = {}
      const W = { esc: (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        api: (url: string) => { sent.push(url); return fetch(base + url).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) },
        registerPane: (n: string, d: any) => { panes[n] = d } }
      vm.runInNewContext(SOURCE, { window: { COSWeb: W }, document: { createElement: () => new FakeEl(), activeElement: null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
      // app.js's renderUsageView and mountPlanRuler, run as they are; the Usage table's own reads are stubbed.
      const app = readFileSync(join(HERE, 'app.js'), 'utf8')
      const slice = (from: string, to: string) => { const i = app.indexOf(from), j = app.indexOf(to, i); expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i); return app.slice(i, j) }
      const box = new FakeEl()
      const ctx: Record<string, any> = { SX: { view: 'usage', usage: { ok: 1 }, usageAt: now, usageLoading: false }, PANES: panes, Date,
        $: (id: string) => id === 'sessions-usage' ? box : null, uLoadPrefs() {}, uWire() {}, paintUsage() {}, paintSessionsHero() {},
        api: () => new Promise(() => {}), ensurePane: (n: string) => Promise.resolve(panes[n]) }
      vm.createContext(ctx)
      vm.runInContext(slice('  function renderUsageView(force) {', '  // background: a refresh or a breakpoint change') +
        slice('  function mountPlanRuler() {', '\n') + '\n;this.open = renderUsageView; this.repaint = mountPlanRuler;', ctx)
      const settle = async () => { for (let i = 0; i < 40 && panes.planRuler?._state.loading !== false; i++) await new Promise(r => setTimeout(r, 5)); await flush() }
      const step = async (what: () => void) => { what(); await flush(); await settle() }

      await step(() => ctx.open(false))                                       // opens Usage at 0:00
      expect([sent, reads]).toEqual([['/api/usage/plan'], { claude: 1, codex: 1 }])
      expect(box.firstChild).toBe(panes.planRuler._state.el)
      for (let i = 0; i < 25; i++) ctx.repaint()                              // the Usage table repaints 25 times
      await flush()
      expect(sent.length).toBe(1)
      now += 5 * 60_000; await step(() => ctx.open(false))                     // reopens at 5:00
      expect(reads).toEqual({ claude: 1, codex: 1 })
      await step(() => ctx.open(true))                                         // Refresh at 5:00: the reading is 5 min old
      expect(reads).toEqual({ claude: 2, codex: 2 })
      now += 60_000; await step(() => ctx.open(true))                          // Refresh at 6:00: 1 min old, not read again
      expect(reads).toEqual({ claude: 2, codex: 2 })
      now += 8 * 60_000; await step(() => ctx.open(false))                     // reopens at 14:00: 9 min old
      expect(reads).toEqual({ claude: 2, codex: 2 })
      now += 2 * 60_000; await step(() => ctx.open(false))                     // reopens at 16:00: 11 min old
      expect(reads).toEqual({ claude: 3, codex: 3 })
      expect(sent).toEqual(['/api/usage/plan', '/api/usage/plan', '/api/usage/plan?refresh=1', '/api/usage/plan?refresh=1', '/api/usage/plan', '/api/usage/plan'])
      expect(panes.planRuler._state.pane.lines.find((l: any) => l.provider === 'codex').usedPct).not.toBeNull()
    } finally { s.close() }
  })
})

// 7.0.54 (the lead 09:0x): when a pause or limit ended, in spoken order. The three helpers run as they ship, at fixed times.
describe('7.0.54: "The pause ended yesterday at 11:50 PM", never "ended at yesterday 11:50 PM"', () => {
  const fns = ['clock', 'readWhen', 'endedWhen'].map(n => { const m = new RegExp('  function ' + n + '\\(iso, ?(nowMs)?\\) \\{[\\s\\S]*?\\n  \\}\\n|  function ' + n + '\\(iso\\) \\{[^\\n]*\\}\\n').exec(SOURCE); expect(m, n).toBeTruthy(); return m![0] }).join('')
  const ctx: Record<string, unknown> = {}
  vm.createContext(ctx); vm.runInContext(fns + ';this.endedWhen = endedWhen;', ctx)
  const ended = ctx.endedWhen as (iso: string, nowMs: number) => string
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime()   // Nov 2026, local time
  const now = at(17, 9, 5)   // Tue Nov 17, 9:05 AM
  it('today: "at 2:02 AM"', () => { expect(ended(new Date(at(17, 2, 2)).toISOString(), now)).toBe('at 2:02 AM') })
  it('yesterday: "yesterday at 11:50 PM"', () => { expect(ended(new Date(at(16, 23, 50)).toISOString(), now)).toBe('yesterday at 11:50 PM') })
  it('this week: the day first, "Sun at 11:50 PM"', () => { expect(ended(new Date(at(15, 23, 50)).toISOString(), now)).toBe('Sun at 11:50 PM') })
  it('older: the date first, "Nov 3 at 8:00 AM"', () => { expect(ended(new Date(at(3, 8, 0)).toISOString(), now)).toBe('Nov 3 at 8:00 AM') })
  it('an unreadable time is empty, never "at Invalid Date"', () => { expect(ended('not a time', now)).toBe('') })
})

// 7.0.54 (F1 09:01): the closed row's first words keep their width beside a long quiet line (the Desktop row made it long).
describe('7.0.54: the closed row keeps "62% used, resets Fri 8:59 PM" whole beside the quiet line', () => {
  const CSS = readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')
  it('wide: the quiet line takes only the width left (basis 0) and ellipsizes first; the first words keep theirs', () => {
    expect(CSS).toContain('@media (min-width: 601px) { .up-lead > .up-others { flex: 1 1 0; min-width: 0; } }')
    expect(CSS).toContain('.up-others { overflow: hidden; text-overflow: ellipsis; }')
    expect(CSS).toMatch(/\.up-seg \{ display: inline-flex; align-items: center; gap: 8px; min-width: 0; \}/)   // the first words: flex 0 1 auto, their own width
  })
  it('narrow keeps its own row for the quiet line (the wide rule never reaches it)', () => {
    const narrow = CSS.slice(CSS.indexOf('@media (max-width: 600px) {'))
    expect(narrow).toContain('.up-others { flex-basis: 100%; }')
    expect(CSS.indexOf('@media (min-width: 601px) { .up-lead > .up-others')).toBeGreaterThan(-1)
  })
})

// 7.0.55 (Miles 2026-11-17 11:25 on the Duo, "Can we set claude usage to be an orange bar as well"; the lead 11:2x): both
// Claude rows draw their chip and their bar in one look-aware Claude orange, --up-claude, in the closed row and the open
// rows. An older Claude reading keeps the orange (it was grey beside a tan chip); its words still say how old it is. A
// limit stays the warning colour. Codex, Cursor and an unknown row keep their own colours.
describe('plan ruler: both Claude rows in Claude orange (7.0.55)', () => {
  const lane = (html: string, name: string) => {
    const lanes = html.split('<div class="up-lane">').slice(1)
    const hit = lanes.filter(l => l.includes('</i>' + name + '</span>'))
    expect(hit.length, name).toBe(1)
    return hit[0]!
  }
  const pane = (desktopState: string, closest = 'claude_desktop') => ({ protocolVersion: 1, now: '2026-11-17T17:00:00.000Z', readAt: '2026-11-17T17:00:00.000Z', closest, others: '', lines: [
    line('claude', 'Claude CLI', { usedPct: 40, gonePct: 20, short: '40% used', shortLong: '40% used', long: '40% used.', quiet: 'Claude CLI 40% used' }),
    line('claude_desktop', 'Claude Desktop', { state: desktopState, usedPct: desktopState === 'limit' ? 100 : 48, gonePct: 18, short: '48% used', shortLong: '48% used, read 40 min ago', long: '48% used.', quiet: 'Claude Desktop 48% used' }),
    line('codex', 'Codex', { state: 'older', usedPct: 30, short: '30% used', shortLong: '30% used', long: '30% used.', quiet: 'Codex 30% used' }),
    line('cursor', 'Cursor', { usedPct: 70, short: '70% used', shortLong: '70% used', long: '70% used.', quiet: 'Cursor 70% used' }),
  ] })
  const render = async (p: unknown) => { const t = load({ 'cos.usage.planOpen': '1' }); void t.p.open(false); t.answer(p); await flush(); return t.el().innerHTML }

  it('Claude CLI and Claude Desktop: chip and bar in --up-claude, fresh and older alike; Codex older stays grey', async () => {
    const html = await render(pane('older'))
    for (const name of ['Claude CLI', 'Claude Desktop']) {
      const l = lane(html, name)
      expect(l, name).toContain('class="up-dot" style="background:var(--up-claude)"')
      expect(l, name).toContain('up-fill" style="width:' + (name === 'Claude CLI' ? 40 : 48) + '%;background:var(--up-claude)"')
    }
    const codex = lane(html, 'Codex')
    expect(codex).toContain('class="up-dot" style="background:var(--u-codex)"')
    expect(codex).toContain('width:30%;background:var(--sub)"')
    expect(lane(html, 'Cursor')).toContain('width:70%;background:var(--u-cursor)"')
    expect(html).not.toContain('var(--u-gold)')
  })
  it('the closed row: an older Claude Desktop reading leads with an orange chip and an orange small bar', async () => {
    const html = await render(pane('older'))
    const head = html.slice(0, html.indexOf('class="up-rows"') < 0 ? html.length : html.indexOf('class="up-rows"'))
    const seg = head.slice(head.indexOf('class="up-seg"'))
    expect(seg).toContain('class="up-dot" style="background:var(--up-claude)"></i>Claude Desktop')
    expect(seg).toContain('class="up-mini"')
    expect(seg).toContain('width:48%;background:var(--up-claude)"')
  })
  it('a Claude row at its limit keeps the orange chip and draws the warning bar', async () => {
    const l = lane(await render(pane('limit')), 'Claude Desktop')
    expect(l).toContain('class="up-dot" style="background:var(--up-claude)"')
    expect(l).toContain('width:100%;background:var(--up-warn)"')
  })
})

describe('plan ruler: the Claude orange token, light and dark, both looks (7.0.55)', () => {
  const CSS = readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')
  const APP = readFileSync(join(HERE, 'app.css'), 'utf8')
  const AMBER = readFileSync(join(HERE, 'amber.css'), 'utf8')
  const LIGHT = 'rgb(184, 98, 40)', DARK = 'rgb(226, 146, 92)'
  const tokenIn = (block: string, name: string) => {
    const m = new RegExp(name.replace(/[-]/g, '\\-') + ':\\s*([^;]+);').exec(block)
    expect(m, name).toBeTruthy()
    return m![1]!.trim()
  }
  const blockAfter = (text: string, selector: string) => { const i = text.indexOf(selector); expect(i, selector).toBeGreaterThan(-1); return text.slice(i, text.indexOf('}', i)) }
  const rgb = (c: string): number[] => {
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c); if (m) return [+m[1]!, +m[2]!, +m[3]!]
    const h = /^#([0-9a-f]{6})$/i.exec(c); expect(h, c).toBeTruthy(); return [0, 2, 4].map(i => parseInt(h![1]!.slice(i, i + 2), 16))
  }
  const lum = (c: number[]) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }
  const mix = (fg: number[], bg: number[], a: number) => fg.map((v, i) => Math.round(v * a + bg[i]! * (1 - a)))

  it('one token on the plan ruler: light by default, dark under both dark selectors, nowhere else', () => {
    expect(tokenIn(blockAfter(CSS, '.up { --up-warn'), '--up-claude')).toBe(LIGHT)
    expect(CSS).toContain(":root[data-theme='dark'] .up { --up-claude: " + DARK + '; }')
    expect(CSS).toContain("@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .up { --up-claude: " + DARK + '; } }')
    expect(CSS.match(/--up-claude:/g)!.length).toBe(3)
    expect(AMBER).not.toContain('--up-claude')   // the same two values hold in Amber; measured below
    // The rail the bar sits on is ink at 12% over the panel; the test below measures against exactly that.
    expect(CSS).toContain('.up-rail { right: 0; background: color-mix(in srgb, var(--ink) 12%, transparent); }')
  })
  it('clears 3:1 against the panel and the rail in Espresso and Amber, light and dark', () => {
    const looks: [string, string, string][] = [
      ['Espresso light', blockAfter(APP, ':root {'), LIGHT], ['Espresso dark', blockAfter(APP, ":root[data-theme='dark'] {"), DARK],
      ['Amber light', blockAfter(AMBER, "html[data-look='amber'][data-theme='light'] {"), LIGHT], ['Amber dark', blockAfter(AMBER, "html[data-look='amber'][data-theme='dark'] {"), DARK],
    ]
    for (const [name, block, token] of looks) {
      const panel = rgb(tokenIn(block, '--panel')), ink = rgb(tokenIn(block, '--ink')), bar = rgb(token)
      expect(ratio(bar, panel), name + ' on the panel').toBeGreaterThanOrEqual(3)
      expect(ratio(bar, mix(ink, panel, 0.12)), name + ' on the rail').toBeGreaterThanOrEqual(3)
    }
  })
})
