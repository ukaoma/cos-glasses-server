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
const MKCSS = CSS.slice(CSS.indexOf('/* 7.0.54: the COS mark at work'))

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

interface Opts { signedIn?: boolean; reduced?: boolean; hidden?: boolean; live?: boolean; listAgeMs?: number; failed?: boolean; noList?: boolean; now?: number }
function page(o: Opts = {}) {
  const now = { t: o.now ?? 1_700_000_001_234 }
  const rail = node(box(20, 30), { 'data-mk': 'rest' })
  let rows: Node[] = []
  const listeners: Record<string, Array<() => void>> = {}
  const timers = { intervals: new Map<number, () => void>(), timeouts: new Map<number, () => void>(), id: 0 }
  const doc = {
    hidden: !!o.hidden, body: {} as unknown, documentElement: {} as unknown,
    querySelector: (sel: string) => (sel === '.rail-head .mk' ? rail : null),
    querySelectorAll: (sel: string) => {
      if (sel === '#run-list .mk[data-mk="work"]') return rows.filter(r => r.isConnected && r.attrs['data-mk'] === 'work')
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
  }
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
  }
  vm.createContext(ctx)
  vm.runInContext(BLOCK + '\n;this.api = { mkRow: mkRow, mkSync: mkSync, mkSoon: mkSoon, MK: MK };', ctx)
  const api = (ctx as { api: { mkRow(st: string): string; mkSync(): void; mkSoon(): void; MK: { live: unknown; timer: unknown } } }).api
  return {
    api, rail, now, doc, SL, state, sessions, timers, listeners,
    working(n = 1) { for (let i = 0; i < n; i++) sessions.push({ session_id: 's' + i, running_active: true }) },
    rowsAt(...tops: number[]) { rows = tops.map(t => node(t < 0 ? NONE : box(t), { 'data-mk': 'work' })); return rows },
    setRows(r: Node[]) { rows = r },
    live() { return [rail, ...rows].filter(r => r.cls.has('mk-live')) },
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
  it('no rail on screen (a phone, the short screen): the first working row ON SCREEN plays, and only it', () => {
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
