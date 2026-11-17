/**
 * 7.0.54: the COS mark at work (F1's final files of 11/16 23:05; the lead's 11/17 06:57 scope). The rail's mark and the
 * mark on Today's Running rows: the glass still at rest, frame 00 for Waiting, frame 03 for Working, and at most ONE
 * mark on the page plays the 24-frame loop (2 s, steps(24), a transform). app.js's mark block (mkRow, mkSync and the
 * rest) is sliced and run with fakes for the page; the CSS, the markup and the files are read as they ship.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildWebAssetTable } from '../lib/web-control-static'
// @ts-expect-error: a plain .mjs script with no types
import { manifestFor } from '../scripts/write-web-control-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error('marker moved: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const BLOCK = between(APP, '  // ── 7.0.54: the COS mark at work', '  // 6.99.27 (Miles 11/07 09:29, "a big delay')
const MKCSS = between(CSS, '/* 7.0.54: the COS mark at work', "/* ── 7.0.29: the folded Duo's side rail")

// ── a page of fakes ───────────────────────────────────────────────────────────────────────────────────────────────
type Rect = { top: number; left: number; bottom: number; right: number; width: number; height: number }
const box = (top: number, h = 18, left = 20, w = 18): Rect => ({ top, left, bottom: top + h, right: left + w, width: w, height: h })
const NONE: Rect = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }
interface Node { attrs: Record<string, string>; cls: Set<string>; props: Record<string, string>; rect: Rect; isConnected: boolean; parentElement: Node | null; overflow?: string; vis?: string; setProps: number;
  getAttribute(k: string): string | null; setAttribute(k: string, v: string): void; getBoundingClientRect(): Rect;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean }; style: { setProperty(k: string, v: string): void } }
function node(rect: Rect, attrs: Record<string, string> = {}, parent: Node | null = null): Node {
  const n: Node = {
    attrs: { ...attrs }, cls: new Set(['mk']), props: {}, rect, isConnected: true, parentElement: parent, setProps: 0,
    getAttribute(k) { return this.attrs[k] ?? null }, setAttribute(k, v) { this.attrs[k] = v },
    getBoundingClientRect() { return this.rect },
    classList: { add: (c) => { n.cls.add(c) }, remove: (c) => { n.cls.delete(c) }, contains: (c) => n.cls.has(c) },
    style: { setProperty: (k, v) => { n.props[k] = v; n.setProps++ } },
  }
  return n
}

interface Glass { mount: (p: unknown, o: { onFail: (why: string) => void }) => boolean; sync: (rows: unknown[]) => void; wake: () => void; animating: () => boolean; mounts: number; synced: unknown[][]; wakes: number; onFail?: (why: string) => void; anim: boolean; ok: boolean }
function fakeGlass(ok = true): Glass {
  const g: Glass = { mounts: 0, synced: [], wakes: 0, anim: false, ok,
    mount(_p, o) { g.mounts++; g.onFail = o.onFail; return g.ok }, sync(rows) { g.synced.push(rows) }, wake() { g.wakes++ }, animating() { return g.anim } }
  return g
}
interface Opts { glass?: Glass | null; lazyGlass?: Glass | 'fails'; signedIn?: boolean; reduced?: boolean; hidden?: boolean; live?: boolean; listAgeMs?: number; failed?: boolean; noList?: boolean; now?: number }
function page(o: Opts = {}) {
  const now = { t: o.now ?? 1_700_000_001_234 }
  const rail = node(box(20, 30), { 'data-mk': 'rest' })
  const panel = node(box(100, 300, 16, 350)); panel.cls = new Set(['run-panel'])
  const list = { closest: (s: string) => (s === '.run-panel' ? panel : null) }
  const ensured: string[] = []
  const bar = node(NONE, { 'data-mk': 'rest' })   // the top bar's mark: not laid out where the rail shows
  let rows: Node[] = []
  const listeners: Record<string, Array<() => void>> = {}
  const timers = { intervals: new Map<number, () => void>(), timeouts: new Map<number, () => void>(), id: 0 }
  const doc = {
    hidden: !!o.hidden, body: {} as unknown, documentElement: {} as unknown,
    querySelector: (sel: string) => (sel === '.rail-head .mk' ? rail : sel === '#section-btn .mk' ? bar : null),
    querySelectorAll: (sel: string) => {
      if (sel === '#run-list .mk[data-mk="work"]') return rows.filter(r => r.isConnected && r.attrs['data-mk'] === 'work')
      if (sel === '.run-panel.rg-on') return panel.cls.has('rg-on') ? [panel] : []
      throw new Error('unexpected selector ' + sel)
    },
    addEventListener: (t: string, f: () => void) => { (listeners[t] ||= []).push(f) },
  }
  const sessions: Array<Record<string, unknown>> = []
  const SL: { data: { sessions: Array<Record<string, unknown>> } | null; at: number; failed: boolean } = { data: o.noList ? null : { sessions }, at: now.t - (o.listAgeMs ?? 1000), failed: !!o.failed }
  const state: Record<string, unknown> = { sessions }
  const win = {
    innerWidth: 951, innerHeight: 539,
    matchMedia: (q: string) => ({ matches: q.includes('reduced-motion') ? !!o.reduced : false, addEventListener: () => {} }),
    getComputedStyle: (n: Node) => ({ visibility: n.vis || 'visible', overflowX: n.overflow || 'visible', overflowY: n.overflow || 'visible' }),
    addEventListener: (t: string, f: () => void) => { (listeners['w:' + t] ||= []).push(f) },
    MutationObserver: class { observe() {} },
    CosRunGlass: o.glass || undefined,
  } as Record<string, unknown>
  const ctx: Record<string, unknown> = {
    document: doc, window: win, state, SL,
    Date: { now: () => now.t },
    setTimeout: (f: () => void) => { const id = ++timers.id; timers.timeouts.set(id, f); return id },
    clearTimeout: (id: number) => { timers.timeouts.delete(id) },
    setInterval: (f: () => void) => { const id = ++timers.id; timers.intervals.set(id, f); return id },
    clearInterval: (id: number) => { timers.intervals.delete(id) },
    liveSignedIn: () => o.signedIn !== false,
    liveCanOverlay: () => !!o.live,
    sxState: (s: { agent_state?: string; running_active?: boolean }) => (s.agent_state === 'waiting' ? 'waiting' : s.running_active ? 'running' : 'recent'),
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    splitSessionId: (provider: string, id: string) => ({ provider: provider || 'claude', id }),
    ensurePane: (name: string) => { ensured.push(name)
      if (o.lazyGlass === 'fails') return Promise.reject(new Error('no'))
      if (o.lazyGlass) win.CosRunGlass = o.lazyGlass
      return Promise.resolve(o.lazyGlass || null) },
  }
  vm.createContext(ctx)
  vm.runInContext(BLOCK + '\n;this.api = { mkRow: mkRow, mkSync: mkSync, mkSoon: mkSoon, MK: MK, rgRender: rgRender, rgRow: rgRow, rgSlot: rgSlot, RG: RG };', ctx)
  const api = (ctx as { api: { mkRow(st: string): string; mkSync(): void; mkSoon(): void; MK: { live: unknown; timer: unknown }; rgRender(l: unknown, r: unknown[]): void; rgRow(s: unknown, a: boolean): unknown; rgSlot(st: string, k: string): string; RG: { failed: boolean; panel: unknown } } }).api
  return {
    api, rail, bar, panel, list, ensured, win, now, doc, SL, state, sessions, timers, listeners,
    working(n = 1) { for (let i = 0; i < n; i++) sessions.push({ session_id: 's' + i, running_active: true }) },
    rowsAt(...tops: number[]) { rows = tops.map(t => node(t < 0 ? NONE : box(t), { 'data-mk': 'work' })); return rows },
    setRows(r: Node[]) { rows = r },
    live() { return [rail, bar, ...rows].filter(r => r.cls.has('mk-live')) },
    flush() { const fs = [...timers.timeouts.values()]; timers.timeouts.clear(); fs.forEach(f => f()) },
  }
}

describe('the Running row mark (mkRow)', () => {
  it('Working is a mark that says "working"; Waiting is frame 00 and silent; anything else draws nothing', () => {
    const { api } = page()
    expect(api.mkRow('work')).toBe('<span class="mk mk-row" data-mk="work" aria-label="working"><span class="mk-w"><span class="mk-s"></span></span></span>')
    expect(api.mkRow('wait')).toBe('<span class="mk mk-row" data-mk="wait" aria-hidden="true"><span class="mk-w"><span class="mk-s"></span></span></span>')
    expect(api.mkRow('')).toBe('')
  })
  it('runRow puts it where the 8 px pulse was: Working on a working row, Waiting on a waiting one, nothing on a quiet one', () => {
    const run = between(APP, '  function runRow(s, activeNow) {', '  function renderRunning(')
    expect(run).toContain("'<span class=\"run-who\">' + badge(key.provider) + (typeof mkRow === 'function' ? mkRow(sxState(s) === 'waiting' ? 'wait' : activeNow ? 'work' : '') : '') + '</span>'")
    expect(run).not.toContain('class="pulse"')
  })
})

describe('one mark plays on the whole page (mkSync)', () => {
  it('a session working, the rail on screen: the rail plays and the rows hold frame 03', () => {
    const p = page(); p.working(2); p.rowsAt(100, 160)
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('work')
    expect(p.live()).toEqual([p.rail])
  })
  it('the rail hidden (a phone, the open Duo): the top bar\'s mark takes its role, in every pane that shows it', () => {
    const p = page(); p.working(); p.rail.rect = NONE; p.bar.rect = box(10, 28, 16, 28)
    const [row] = p.rowsAt(200)
    p.api.mkSync()
    expect(p.live()).toEqual([p.bar]); expect(row.cls.has('mk-live')).toBe(false)
    expect(p.bar.attrs['data-mk']).toBe('work'); expect(p.rail.attrs['data-mk']).toBe('work')
    p.sessions[0].running_active = false; p.api.mkSync()
    expect(p.bar.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])   // frame 00's still when nothing works
  })
  it('a top bar tucking away on scroll (it slides for 220 ms) is gone at once: the row on screen plays', () => {
    const p = page(); p.working(); p.rail.rect = NONE
    const topbar = node(box(0, 56, 0, 382)); topbar.cls = new Set(['topbar', 'tucked'])
    p.bar.parentElement = topbar; p.bar.rect = box(-20, 28, 16, 28)   // still partly in the window, mid-slide
    const [row] = p.rowsAt(200)
    p.api.mkSync()
    expect(p.live()).toEqual([row])
    topbar.cls.delete('tucked'); p.bar.rect = box(10, 28, 16, 28); p.api.mkSync()
    expect(p.live()).toEqual([p.bar])
  })
  it('watches the top bar\'s own class, so its return is seen', () => {
    expect(BLOCK).toContain("var tb = document.getElementById && document.getElementById('topbar');")
    expect(BLOCK).toContain("if (tb) mo.observe(tb, { attributes: true, attributeFilter: ['class'] });")
  })
  it('the rail\'s mark comes first when both could show', () => {
    const p = page(); p.working(); p.bar.rect = box(10, 28, 16, 28)
    p.api.mkSync()
    expect(p.live()).toEqual([p.rail])
  })
  it('no rail and no top bar mark on screen (a reader with Back): the first working row ON SCREEN plays, and only it', () => {
    const p = page(); p.working(2); p.rail.rect = NONE
    const [offTop, first, second] = p.rowsAt(-1, 200, 260)
    p.api.mkSync()
    expect(p.live()).toEqual([first])
    expect(offTop.cls.has('mk-live')).toBe(false); expect(second.cls.has('mk-live')).toBe(false)
  })
  it('a row scrolled below the window, or clipped by the box that scrolls it, is not on screen', () => {
    const p = page(); p.working(); p.rail.rect = NONE
    const scroller = node(box(0, 300, 0, 951)); scroller.overflow = 'auto'
    const clipped = node(box(400), { 'data-mk': 'work' }, scroller)   // inside the window, outside its scroller
    const below = node(box(600), { 'data-mk': 'work' })                 // below the 539 px window
    p.setRows([clipped, below])
    p.api.mkSync()
    expect(p.live()).toEqual([])
    clipped.rect = box(200); p.api.mkSync()
    expect(p.live()).toEqual([clipped])
  })
  it('a row inside a box made invisible (visibility: hidden) is not on screen', () => {
    const p = page(); p.working(); p.rail.rect = NONE
    const sheet = node(box(0, 539, 0, 951)); sheet.vis = 'hidden'
    const row = node(box(100), { 'data-mk': 'work' }, sheet)
    p.setRows([row]); p.api.mkSync()
    expect(p.live()).toEqual([])
    sheet.vis = 'visible'; p.api.mkSync()
    expect(p.live()).toEqual([row])
  })
  it('a row redrawn under the live mark: the new row plays from the same clock, the old one lets go', () => {
    const p = page({ now: 1_700_000_000_750 }); p.working(); p.rail.rect = NONE
    const [a] = p.rowsAt(100)
    p.api.mkSync()
    expect(p.live()).toEqual([a]); expect(a.props['--mk-delay']).toBe('-750ms')
    a.isConnected = false
    p.now.t += 1300
    const [b] = p.rowsAt(100)
    p.api.mkSync()
    expect(p.live()).toEqual([b]); expect(a.cls.has('mk-live')).toBe(false)
    expect(b.props['--mk-delay']).toBe('-50ms')   // (750 + 1300) mod 2000: the loop goes on, never back to frame 00
  })
  it('the mark that already plays is left alone: no new delay, so a heartbeat never restarts the loop', () => {
    const p = page(); p.working(); p.rowsAt(100)
    p.api.mkSync(); p.now.t += 700; p.api.mkSync(); p.api.mkSync()
    expect(p.rail.setProps).toBe(1)
    expect(p.live()).toEqual([p.rail])
  })
  it('a waiting session is not working: the rail rests and nothing plays', () => {
    const p = page(); p.sessions.push({ session_id: 'w', running_active: true, agent_state: 'waiting' }); p.rowsAt(100)
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])
  })
  it('Working stops: the rail goes back to rest and the live mark lets go', () => {
    const p = page(); p.working()
    p.api.mkSync(); expect(p.live()).toEqual([p.rail])
    p.sessions[0].running_active = false; p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])
  })
})

describe('never Working from a list that is not fresh', () => {
  it('a list older than 90 s with no live stream: rest, nothing plays', () => {
    const p = page({ listAgeMs: 90_001 }); p.working(); p.rowsAt(100)
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])
  })
  it('the same old list kept current by the live stream: Working', () => {
    const p = page({ listAgeMs: 600_000, live: true }); p.working()
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('work'); expect(p.live()).toEqual([p.rail])
  })
  it('a list read that failed since: the cached Working is not believed', () => {
    const p = page({ failed: true, live: true }); p.working(); p.rowsAt(100)
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])
  })
  it('a pane still holding an OLDER array that says Working never outranks the fresh list (Codex 07:3x)', () => {
    const p = page(); p.rowsAt(100)
    p.state.sessions = [{ session_id: 'old', running_active: true }]           // what Today drew a while ago
    p.SL.data = { sessions: [{ session_id: 'old', running_active: false, agent_state: 'waiting' }] }   // the fresh read
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.live()).toEqual([])
    p.SL.data = { sessions: [] }                                                // a fresh read with nothing in it
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('rest')
    p.state.sessions = []; p.SL.data = { sessions: [{ session_id: 'new', running_active: true }] }   // and the other way round
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('work')
  })
  it('no list read yet, or signed out: rest', () => {
    const a = page({ noList: true }); a.working(); a.api.mkSync(); expect(a.rail.attrs['data-mk']).toBe('rest')
    const b = page({ signedIn: false }); b.working(); b.api.mkSync(); expect(b.rail.attrs['data-mk']).toBe('rest'); expect(b.live()).toEqual([])
  })
  it('looks again every 15 s while anything says Working, and stops looking when nothing does', () => {
    const p = page(); p.working()
    p.api.mkSync()
    expect(p.timers.intervals.size).toBe(1)
    p.api.mkSync()
    expect(p.timers.intervals.size).toBe(1)   // one timer, never one per look
    p.now.t += 91_000; p.api.mkSync()          // the list went stale with no event: the 15 s look catches it
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.timers.intervals.size).toBe(0)
  })
})

describe('wired to the shared list', () => {
  it('a read that lands or fails looks again, on a branch of its own, so callers still get the read\'s own answer or failure', () => {
    const sl = between(APP, '  function sessionList(maxAgeMs) {', '  function sessionListCached()')
    expect(sl).toContain("    }, function (err) { SL.inflight = null; SL.failed = true; throw err; });\n    // 7.0.54: a read that lands or fails may start or stop the mark (mkSync).")
    expect(sl).toContain("    if (typeof mkSoon === 'function') SL.inflight.then(mkSoon, mkSoon);\n    return SL.inflight;")
  })
  it('the route, the Running card and the live repaint look again', () => {
    expect(between(APP, '  function route(forceChanged) {', "    document.querySelectorAll('#section-menu [data-goto]')")).toContain("if (typeof mkSoon === 'function') mkSoon();")
    const rr = between(APP, '  function renderRunning(working, open) {', '  function runJobsHtml()')
    expect(rr.split("if (typeof mkSoon === 'function') mkSoon();")).toHaveLength(3)   // the failed branch and the rows
    expect(between(APP, '  function liveRepaint(rows, structural) {', '  function liveSessionRows(')).toMatch(/^  function liveRepaint\(rows, structural\) \{\n    if \(typeof mkSoon === 'function'\) mkSoon\(\);/)
  })
  it('no page (a script sliced into a test, a worker): nothing to do, no throw', () => {
    const ctx: Record<string, unknown> = { SL: { data: null }, state: {} }
    vm.createContext(ctx)
    expect(() => vm.runInContext(BLOCK + '\n;mkSoon();', ctx)).not.toThrow()
  })
})

describe('paused when hidden, still under reduced motion', () => {
  it('a hidden page plays nothing and keeps no timer; it picks the mark again when it is back', () => {
    const p = page(); p.working()
    p.api.mkSync(); expect(p.live()).toEqual([p.rail])
    p.doc.hidden = true; p.api.mkSoon()          // hidden: at once, not after a timer that a hidden page may never run
    expect(p.live()).toEqual([]); expect(p.timers.intervals.size).toBe(0); expect(p.timers.timeouts.size).toBe(0)
    p.doc.hidden = false; p.api.mkSoon(); p.flush()
    expect(p.live()).toEqual([p.rail])
  })
  it('wires visibility, back-forward, resize, scroll, reduced motion and the <html> classes once', () => {
    const p = page(); p.api.mkSoon(); p.api.mkSoon()
    expect(p.listeners.visibilitychange).toHaveLength(1); expect(p.listeners.scroll).toHaveLength(1)
    expect(p.listeners['w:pageshow']).toHaveLength(1); expect(p.listeners['w:resize']).toHaveLength(1)
  })
  it('reduced motion: the rail still says Working (frame 03) but nothing plays', () => {
    const p = page({ reduced: true }); p.working(); p.rowsAt(100)
    p.api.mkSync()
    expect(p.rail.attrs['data-mk']).toBe('work'); expect(p.live()).toEqual([])
  })
})

describe('the CSS', () => {
  it('a 24-frame strip in a one-frame window: frame 03 at rest, the loop 0 to -100% in 2 s steps(24, end), on a transform', () => {
    expect(MKCSS).toContain('.mk-s { position: absolute; left: 0; top: 0; width: 2400%; height: 100%;')
    expect(MKCSS).toContain(".mk[data-mk='work'] .mk-s { transform: translateX(-12.5%); }")   // 3 of 24 frames
    expect(MKCSS).toContain(".mk.mk-live[data-mk='work'] .mk-s { animation: mk-run 2s steps(24, end) var(--mk-delay, 0ms) infinite; }")
    expect(MKCSS).toContain('@keyframes mk-run { from { transform: translateX(0); } to { transform: translateX(-100%); } }')
    expect(MKCSS).toContain(".mk[data-mk='work'] .mk-w, .mk[data-mk='wait'] .mk-w { display: block; }")
    expect(MKCSS).not.toMatch(/\.mk\[data-mk='wait'\] \.mk-s \{[^}]*translateX\(-/)   // Waiting is frame 00
  })
  it('reduced motion turns the loop off (beating the page-wide one-short-run rule), so frame 03 holds', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce) { .mk.mk-live .mk-s { animation-name: none !important; } }')
    expect(CSS.lastIndexOf('animation-name: none !important')).toBeGreaterThan(CSS.indexOf('*, *::before, *::after { animation-duration: 0.001ms !important;'))
  })
  it('both appearances: light files by default, dark ones on a dark page and always on the Running card (it is dark in every look)', () => {
    expect(MKCSS).toMatch(/^\.mk \{ position: relative;[^}]*--mk-still: url\('\/control\/marks\/mark_glass_light_2x\.png'\); --mk-s1: url\('\/control\/marks\/work_light_64_strip\.png'\); --mk-s2: url\('\/control\/marks\/work_light_128_strip\.png'\); \}/m)
    const dark = "--mk-still: url('/control/marks/mark_glass_dark_2x.png'); --mk-s1: url('/control/marks/work_dark_64_strip.png'); --mk-s2: url('/control/marks/work_dark_128_strip.png'); }"
    expect(MKCSS).toContain(":root[data-theme='dark'] .mk, .run-panel .mk {\n  " + dark)
    expect(MKCSS).toContain("@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .mk {\n  " + dark + ' }')
    for (const look of ['light', 'dark']) {
      const v = new RegExp(`html\\[data-look='amber'\\]\\[data-theme='${look}'\\] \\{[^}]*--run-bg: #([0-9a-f]{6})`).exec(readFileSync(join(HERE, 'amber.css'), 'utf8'))!
      const lum = parseInt(v[1].slice(0, 2), 16) + parseInt(v[1].slice(2, 4), 16) + parseInt(v[1].slice(4, 6), 16)
      expect(lum, look).toBeLessThan(150)   // the Running card is dark in both Amber appearances, so it takes the dark files
    }
  })
  it('no layout shift: the rail mark keeps the SVG box, a row mark (18 px) is shorter than the badge beside it (22 px at the smallest)', () => {
    expect(HTML).toContain('<div class="rail-head"><span class="mark mk" data-mk="rest" aria-hidden="true"><svg class="mark" width="28" height="28"><use href="#i-mark"/></svg><span class="mk-w"><span class="mk-s"></span></span></span><span class="rail-brand">Control</span></div>')
    expect(HTML).toContain('<span class="mark mk" data-mk="rest" aria-hidden="true"><svg class="mark" width="28" height="28"><use href="#i-mark"/></svg><span class="mk-w"><span class="mk-s"></span></span></span><span id="section-name">Today</span>')
    expect(MKCSS).toContain('.mk-row { width: 18px; height: 18px; flex: none; }')
    expect(CSS).toContain('.badge { height: 22px;')
    expect(MKCSS).toContain('.mk > svg { display: none; }')
    // Every overhang is absolute, so it draws outside the box and moves nothing.
    expect(MKCSS).toContain(".mk[data-mk='rest']::before { content: ''; position: absolute; top: -7.807%; bottom: -7.807%; left: -3.488%; right: -3.488%;")
    expect(MKCSS).toContain('.mk-w { display: none; position: absolute; inset: -3px; overflow: hidden; }')
  })
})

describe('the files ship and are the accepted ones', () => {
  const MARKS = join(HERE, 'marks')
  const ACCEPTED: Record<string, string> = {
    'mark_glass_dark_2x.png': 'a804ed5e6b64', 'mark_glass_light_2x.png': '39e4ba0e8955',
    'work_dark_64_strip.png': 'c6d7c9816f88', 'work_light_64_strip.png': 'b99d72dfb63c',
    'work_dark_128_strip.png': 'f8dda3754cb2', 'work_light_128_strip.png': 'e2c1c70fa8cb',
  }
  it('marks/ holds exactly the six accepted files, byte for byte (F1 23:05; A1 21:57 hashes)', () => {
    expect(readdirSync(MARKS).sort()).toEqual(Object.keys(ACCEPTED).sort())
    for (const [f, h] of Object.entries(ACCEPTED)) expect(createHash('sha256').update(readFileSync(join(MARKS, f))).digest('hex').slice(0, 12), f).toBe(h)
  })
  it('every file the CSS names exists, and the server stamps each reference with its hash', () => {
    const named = [...MKCSS.matchAll(/url\('\/control\/(marks\/[^']+)'\)/g)].map(m => m[1])
    expect(new Set(named)).toEqual(new Set(Object.keys(ACCEPTED).map(f => 'marks/' + f)))
    const table = buildWebAssetTable(HERE)
    const css = table.get('/app.css')!.body.toString('utf8')
    for (const f of Object.keys(ACCEPTED)) {
      const png = table.get('/marks/' + f)!
      expect(png.type).toBe('image/png')
      expect(css).toContain(`url('/control/marks/${f}?v=${png.hash}')`)
    }
  })
  it('the pack manifest (integrity mode) lists them', () => {
    const files = manifestFor(HERE).files as Record<string, string>
    for (const f of Object.keys(ACCEPTED)) expect(files['/marks/' + f], f).toBe(createHash('sha256').update(readFileSync(join(MARKS, f))).digest('hex'))
  })
})

// 7.0.55: A1's live glass on the Running rows, adopted (the lead 09:32 and 09:4x). The one-live rule Q1 pinned this
// morning CHANGES, on purpose: live glass rows on screen take the motion, else the rail, else the top bar, else (the
// glass off or failed) the first working strip row.
describe('7.0.55: the live glass takes the motion', () => {
  it('glass rows moving on screen: the rail and top-bar marks rest (the still) and no strip plays', () => {
    const g = fakeGlass(); g.anim = true
    const p = page({ glass: g }); p.working(); p.rowsAt(200)
    p.api.rgRender(p.list, [{ key: 'claude|s0', state: 'work' }])
    p.api.mkSync()
    expect(p.live()).toEqual([])
    expect(p.rail.attrs['data-mk']).toBe('rest'); expect(p.bar.attrs['data-mk']).toBe('rest')
  })
  it('the glass mounted but not moving (off screen, hidden, Reduce Motion): the rail takes it, as in 7.0.54', () => {
    const g = fakeGlass(); g.anim = false
    const p = page({ glass: g }); p.working()
    p.api.rgRender(p.list, [{ key: 'claude|s0', state: 'work' }])
    p.api.mkSync()
    expect(p.live()).toEqual([p.rail]); expect(p.rail.attrs['data-mk']).toBe('work')
  })
  it('a glass that says it moves but never mounted (or failed) is not believed', () => {
    const g = fakeGlass(false); g.anim = true
    const p = page({ glass: g }); p.working()
    p.api.rgRender(p.list, [{ key: 'claude|s0', state: 'work' }])
    expect(p.api.RG.failed).toBe(true)
    p.api.mkSync()
    expect(p.live()).toEqual([p.rail])
  })
  it('every look asks the glass to look again (scroll, resize, visibility, route)', () => {
    const g = fakeGlass(); const p = page({ glass: g }); p.working()
    p.api.rgRender(p.list, [{ key: 'claude|s0', state: 'work' }])
    const before = g.wakes; p.api.mkSoon()
    expect(g.wakes).toBe(before + 1)
  })
})

describe('7.0.55: rgRender mounts once and tells the glass only what the rows say', () => {
  it('mounts once on the panel, marks it .rg-on, then only syncs', () => {
    const g = fakeGlass(); const p = page({ glass: g })
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }, null])
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'wait' }])
    expect(g.mounts).toBe(1); expect(p.panel.cls.has('rg-on')).toBe(true)
    expect(g.synced).toEqual([[{ key: 'claude|a', state: 'work' }], [{ key: 'claude|a', state: 'wait' }]])   // nulls dropped
  })
  it('no WebGL here (mount says false): no .rg-on, the strips stay, and it never tries again', () => {
    const g = fakeGlass(false); const p = page({ glass: g })
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    expect(p.panel.cls.has('rg-on')).toBe(false); expect(g.mounts).toBe(1); expect(g.synced).toEqual([])
  })
  it('a lost context later (onFail): .rg-on goes, the strips come back, the mark looks again', () => {
    const g = fakeGlass(); const p = page({ glass: g }); p.working()
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    g.onFail!('context-lost')
    expect(p.panel.cls.has('rg-on')).toBe(false); expect(p.api.RG.failed).toBe(true)
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    expect(g.mounts).toBe(1)
  })
  it('loads the script only when a row works or waits, once, through the lazy list', async () => {
    const g = fakeGlass(); const p = page({ lazyGlass: g })
    p.api.rgRender(p.list, [])
    expect(p.ensured).toEqual([])
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }]); p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    expect(p.ensured).toEqual(['runGlass'])
    await new Promise(r => setTimeout(r, 0))
    expect(g.mounts).toBe(1); expect(g.synced.at(-1)).toEqual([{ key: 'claude|a', state: 'work' }])
  })
  it('a script that will not load leaves the strips', async () => {
    const p = page({ lazyGlass: 'fails' })
    p.api.rgRender(p.list, [{ key: 'claude|a', state: 'work' }])
    await new Promise(r => setTimeout(r, 0))
    expect(p.api.RG.failed).toBe(true); expect(p.panel.cls.has('rg-on')).toBe(false)
  })
  it('a row: Working or Waiting as the row says; done and total only from subagent_activity; activity from last_activity_at', () => {
    const p = page()
    const at = '2026-11-17T15:00:05.000Z'
    expect(p.api.rgRow({ provider: 'claude', session_id: 'a', running_active: true, last_activity_at: at, subagent_activity: { active: 1, completed: 2, total: 3 } }, true))
      .toEqual({ key: 'claude|a', state: 'work', done: 2, total: 3, activityAt: Date.parse(at) })
    expect(p.api.rgRow({ provider: 'codex', session_id: 'b', running_active: true, agent_state: 'waiting' }, true))
      .toEqual({ key: 'codex|b', state: 'wait', done: null, total: null, activityAt: null })
    expect(p.api.rgRow({ provider: 'claude', session_id: 'c', subagent_activity: { active: 0, unknown: 1 } }, true))
      .toEqual({ key: 'claude|c', state: 'work', done: null, total: null, activityAt: null })   // no real count: none invented
    expect(p.api.rgRow({ provider: 'claude', session_id: 'd' }, false)).toBe(null)   // a quiet open row: no glass
  })
  it('the slot: escaped key, only on a row that works or waits', () => {
    const p = page()
    expect(p.api.rgSlot('work', 'claude|a"b')).toBe('<span class="rg-slot" data-rg-key="claude|a&quot;b"></span>')
    expect(p.api.rgSlot('', 'claude|a')).toBe('')
  })
  it('wired: runRow puts the slot before the strip; renderRunning syncs the rows it drew; a failed read syncs none', () => {
    const run = between(APP, '  function runRow(s, activeNow) {', '  function renderRunning(')
    expect(run).toContain("(typeof rgSlot === 'function' ? rgSlot(mkSt, key.provider + '|' + key.id) : '') + (typeof mkRow === 'function' ? mkRow(mkSt) : '')")
    const rr = between(APP, '  function renderRunning(working, open) {', '  function runJobsHtml()')
    expect(rr).toContain("rgRender(list, shown.length ? shown.map(function (s) { return rgRow(s, true); }) : open.slice(0, 2).map(function (s) { return rgRow(s, false); }));")
    expect(rr).toContain("if (typeof rgRender === 'function') rgRender(list, []); if (typeof mkSoon === 'function') mkSoon(); return; }")
    expect(HTML).toContain('"runGlass": "/control/run-glass.js"')
  })
  it('the CSS: slots only while mounted, strips hidden only then', () => {
    expect(CSS).toContain('.rg-slot { display: none; width: 36px; height: 20px; flex: none; }')
    expect(CSS).toContain('.run-panel.rg-on .rg-slot { display: inline-block; }')
    expect(CSS).toContain('.run-panel.rg-on .mk-row { display: none; }')
  })
})
