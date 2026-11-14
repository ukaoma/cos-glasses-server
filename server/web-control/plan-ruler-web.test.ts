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
  it('index.html loads it and the Usage view mounts it after each paint', () => {
    const index = readFileSync(join(HERE, 'index.html'), 'utf8'), app = readFileSync(join(HERE, 'app.js'), 'utf8')
    expect(index).toContain('"planRuler": "/control/panes/plan-ruler.js"')
    // Styles live at the end of sessions.css, so the boot stylesheet list (blank-open-web.test.ts) is unchanged.
    expect(readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')).toContain('.up-toggle {')
    expect(index).not.toContain('plan-ruler.css')
    expect(app).toContain("if (SX.view === 'usage') ensurePane('planRuler')")
    expect(app.match(/mountPlanRuler\(\)/g)?.length).toBe(4)
  })
})
