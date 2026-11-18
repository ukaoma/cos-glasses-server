/**
 * 7.0.56: the Sessions dock, Direction 2 (A1's mock and README, wk47_2026/sessions_dock_mocks; Miles 18:3x "yup this
 * design is it."; the lead's OK on W1's plan, 18:5x). The real SX_DOCK block and the real note functions, sliced out of
 * app.js and run with fakes for the page; the CSS and the markup read as they ship. Geometry here is the mock's own
 * arithmetic; the real measurement at 382x557, 449x655 and 951x539 is F1's probe, which gates the build.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')
const CHATCSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const TA = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error('marker moved: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const DOCK = between(APP, '  // ── 7.0.56: the Sessions dock, Direction 2', '  function paintActivity(r) {')
const NOTE = between(APP, '  var SX_PARK = {', "  /** The composer's \"Working right now\" note")
const DOCKCSS = between(CSS, '/* ── 7.0.56: the Sessions dock, Direction 2', '/* ── the list (7.0.23, step 2b-1;')
const PLAIN = new Function('return ' + between(APP, '  function plain(text) {', '\n').trim())()

// ── a page of fakes ───────────────────────────────────────────────────────────────────────────────────────────────
class El {
  attrs: Record<string, string> = {}; cls = new Set<string>(); style: any = { setProperty(this: any, k: string, v: string) { this[k] = v } }; focused = 0; writes = 0; html = ''
  get innerHTML() { return this.html }
  set innerHTML(v: string) { this.html = v; this.writes++ }
  constructor(public id = '', public h = 0) {}
  get classList() { const c = this.cls; return { toggle: (n: string, on: boolean) => { if (on) c.add(n); else c.delete(n) }, contains: (n: string) => c.has(n) } }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  removeAttribute(k: string) { delete this.attrs[k] }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  getBoundingClientRect() { return { height: this.h, top: 0 } }
  closest(sel: string) { return sel === '#session-handle' && this.id === 'session-handle' ? this : null }
  querySelector(sel: string): El | null {
    if (sel === '[data-sx="dock-full"]') return this.kids.full ?? null
    if (sel === '[data-sx="dock-focus"]') return this.kids.focus ?? null
    if (sel === '[data-sx="dock-stop-keep"]') return /data-sx="dock-stop-keep"/.test(this.innerHTML) ? this.kids.keep ?? (this.kids.keep = new El('keep')) : null
    if (sel === '.sx-reader-head') return this.kids.head ?? null
    return null
  }
  kids: Record<string, El> = {}
  focus() { this.focused++ }
  setPointerCapture() {}
  clientHeight = 0; offsetHeight = 0
}
interface Opts { docked?: boolean; stored?: string | null; storageThrows?: boolean; working?: boolean; card?: 'enabled' | 'disabled'; question?: boolean
  w?: number; h?: number; pointer?: 'coarse' | 'fine'; drawn?: Record<string, number> }
// A real media query against the page's size and pointer (7.0.58: so a size or pointer gate put back is seen): comma
// is or, "and" joins; pointer, min- and max-width and -height. Anything else does not match.
function mediaMatches(q: string, w: number, h: number, pointer: string): boolean {
  return q.split(',').some(part => part.trim().split(/\s+and\s+/).every(c => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9.]+)\s*\)$/.exec(c.trim()); if (!m) return false
    const n = parseFloat(m[2])
    return m[1] === 'pointer' ? m[2] === pointer : m[1] === 'max-width' ? w <= n : m[1] === 'min-width' ? w >= n
      : m[1] === 'max-height' ? h <= n : m[1] === 'min-height' ? h >= n : false
  }))
}
function page(o: Opts = {}) {
  const reader = new El('session-reader'), handle = new El('session-handle'), dock = new El('session-dock', 126), stop = new El('session-stop-row')
  // The dock as the page draws it at each height (7.0.58, F1 probe 9): by default the mock's 68, 126 and 378 (382x557).
  const drawn: Record<string, number> = o.drawn ?? { focus: 68, middle: 126, full: 378 }
  dock.getBoundingClientRect = () => { const v = drawn[reader.attrs['data-dock']]; return { height: v != null ? v : dock.h, top: 0 } }
  reader.kids.full = new El('full'); reader.kids.focus = new El('focus'); reader.kids.head = Object.assign(new El('head'), { offsetHeight: 37 })
  reader.clientHeight = 463
  const input: any = Object.assign(new El('session-input'), { phLong: 'Continue this session…' }), fits: unknown[] = []
  const go: any = Object.assign(new El('go'), { disabled: o.card === 'disabled' })
  const form: any = Object.assign(new El('session-form'), { __paCard: o.card ? new El('session-phone-card') : null })
  form.querySelector = (sel: string) => (sel === '[data-phone-offer]' && o.card ? go : null)
  const qs: any = Object.assign(new El('session-questions'), { children: o.question ? [new El('q')] : [], textContent: o.question ? 'Which branch should I use?' : '' })
  const why: any = Object.assign(new El('session-dock-why'), { hidden: true, textContent: '' })
  const body: any = Object.assign(new El('session-body'), { scrollTop: 812 })
  const ids: Record<string, El> = { 'session-reader': reader, 'session-handle': handle, 'session-dock': dock, 'session-stop-row': stop, 'session-input': input,
    'session-form': form, 'session-questions': qs, 'session-dock-why': why, 'session-body': body }
  const store: Record<string, string> = o.stored == null ? {} : { 'cos.sxDock': o.stored }
  const writes: string[] = []
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const localStorage = {
    getItem: (k: string) => { if (o.storageThrows) throw new Error('SecurityError'); return k in store ? store[k] : null },
    setItem: (k: string, v: string) => { if (o.storageThrows) throw new Error('QuotaExceeded'); store[k] = v; writes.push(v) },
  }
  const r: any = { live: { working: o.working !== false } }
  const mqCalls: string[] = []; let mqListen = 0
  const ctx: Record<string, unknown> = {
    window: { localStorage, innerWidth: o.w ?? 382, innerHeight: o.h ?? 557,
      matchMedia: (q: string) => { mqCalls.push(q); return { matches: mediaMatches(q, o.w ?? 382, o.h ?? 557, o.pointer ?? 'coarse'), addEventListener: () => { mqListen++ }, addListener: () => { mqListen++ } } },
      addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ||= []).push(f) } },
    $: (id: string) => ids[id] ?? null, state: { reading: r }, Math, Infinity, sxPlaceholderFit: (b: unknown) => { fits.push(b) }, plain: PLAIN,
  }
  vm.createContext(ctx)
  vm.runInContext(DOCK + `
;this.api = { SX_DOCK: SX_DOCK, SX_DOCK_PX: SX_DOCK_PX, measure: sxDockMeasure, applies: sxDockApplies, plainLine: sxPlainLine, cancel: sxDockCancel, height: sxDockHeight, set: sxDockSet, next: sxDockNext, step: sxDockStep, snap: sxDockSnap,
  paint: sxDockPaint, apply: sxDockApply, hold: sxDockHold, stop: sxStopPaint, click: sxDockClick, key: sxDockKey, down: sxDockDown, move: sxDockMove, up: sxDockUp, hook: sxDockHook };`, ctx)
  const api = (ctx as { api: any }).api
  return { api, reader, handle, dock, stop, store, writes, r, listeners, input, fits, form, go, qs, why, body, mqCalls, mqListen: () => mqListen, drawn }
}

describe('the height: one value per device, Middle when nothing is stored (the lead 18:5x)', () => {
  it('nothing stored: middle; a stored height is used; anything else stored: middle', () => {
    expect(page().api.height()).toBe('middle')
    expect(page({ stored: 'focus' }).api.height()).toBe('focus')
    expect(page({ stored: 'full' }).api.height()).toBe('full')
    expect(page({ stored: 'tall' }).api.height()).toBe('middle')
    expect(page({ stored: '__proto__' }).api.height()).toBe('middle')
  })
  it('storage that throws: middle, and his choice still holds for this page', () => {
    const p = page({ storageThrows: true })
    expect(p.api.height()).toBe('middle')
    expect(() => p.api.set('focus')).not.toThrow()
    expect(p.api.height()).toBe('focus')
  })
  it('his choice is kept for the next open on this device', () => {
    const p = page(); p.api.set('full')
    expect(p.store['cos.sxDock']).toBe('full')
    expect(page({ stored: p.store['cos.sxDock'] }).api.height()).toBe('full')
  })
  it('an unknown height is never written', () => {
    const p = page(); p.api.set('huge'); p.api.set('')
    expect(p.writes).toEqual([]); expect(p.api.height()).toBe('middle')
  })
})

describe('only his drag, tap or keys change it', () => {
  it('a tap on the handle steps focus, middle, full, then focus again', () => {
    const p = page({ stored: 'focus' })
    p.api.click('dock-handle'); expect(p.api.height()).toBe('middle')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('focus')
  })
  it('the chat bubble opens full; pressed in full it goes back to middle; from focus it opens full', () => {
    const p = page(); p.api.click('dock-full'); expect(p.api.height()).toBe('full')
    p.api.click('dock-full'); expect(p.api.height()).toBe('middle')
    const f = page({ stored: 'focus' }); f.api.click('dock-full'); expect(f.api.height()).toBe('full')
  })
  it('expand goes to focus from middle or full; in focus it is "Show the reply box" and goes back to middle', () => {
    const p = page(); p.api.click('dock-focus'); expect(p.api.height()).toBe('focus')
    p.api.click('dock-focus'); expect(p.api.height()).toBe('middle')
    const f = page({ stored: 'full' }); f.api.click('dock-focus'); expect(f.api.height()).toBe('focus')
  })
  it('the arrow keys on the handle: up is a taller dock, down a shorter one, and they stop at the ends', () => {
    const p = page({ stored: 'focus' }), key = (k: string) => p.api.key({ target: p.handle, key: k, preventDefault() {} })
    key('ArrowDown'); expect(p.api.height()).toBe('focus')
    key('ArrowUp'); expect(p.api.height()).toBe('middle')
    key('ArrowUp'); expect(p.api.height()).toBe('full')
    key('ArrowUp'); expect(p.api.height()).toBe('full')
    key('ArrowDown'); expect(p.api.height()).toBe('middle')
    p.api.key({ target: p.handle, key: 'Enter', preventDefault() {} }); expect(p.api.height()).toBe('middle')
    p.api.key({ target: p.dock, key: 'ArrowUp', preventDefault() {} }); expect(p.api.height()).toBe('middle')   // not the handle
  })
  // 7.0.58 (F1 probe 9, the lead 13:2x): the nearest of the three heights as drawn, never a written step; the drawn
  // numbers F1 measured: Middle 188 and Full 412 at 382x557, Focus 102, Middle 165 and Full 358 at 1440x900.
  const DRAWN: Array<[string, Record<string, number>]> = [['382x557', { focus: 112, middle: 188, full: 412 }], ['1440x900', { focus: 102, middle: 165, full: 358 }]]
  for (const [size, H] of DRAWN) {
    it(`${size}: a 12 px nudge either way keeps every height; a release at a drawn height lands on it`, () => {
      const p = page()
      for (const k of ['focus', 'middle', 'full']) {
        expect(p.api.snap(H[k] + 12, H[k], H, k), k + ' +12').toBe(k)
        expect(p.api.snap(H[k] - 12, H[k], H, k), k + ' -12').toBe(k)
        for (const to of ['focus', 'middle', 'full']) expect(p.api.snap(H[to], H[k], H, k), k + ' to ' + to).toBe(to)
      }
    })
    it(`${size}: either side of each midpoint goes to the nearer drawn height`, () => {
      const p = page(), fm = (H.focus + H.middle) / 2, mf = (H.middle + H.full) / 2
      expect(p.api.snap(fm + 1, H.middle, H, 'middle')).toBe('middle'); expect(p.api.snap(fm - 1, H.middle, H, 'middle')).toBe('focus')
      expect(p.api.snap(mf - 1, H.middle, H, 'middle')).toBe('middle'); expect(p.api.snap(mf + 1, H.middle, H, 'middle')).toBe('full')
      expect(p.api.snap(mf + 1, H.full, H, 'full')).toBe('full'); expect(p.api.snap(mf - 1, H.full, H, 'full')).toBe('middle')
      expect(p.api.snap(fm - 1, H.focus, H, 'focus')).toBe('focus'); expect(p.api.snap(fm + 1, H.focus, H, 'focus')).toBe('middle')
    })
    it(`${size}: a release never lands further the other way than the finger went (every px, every start)`, () => {
      const p = page()
      for (const k of ['focus', 'middle', 'full']) for (let px = H.focus - 40; px <= H.full + 40; px++) {
        const got = H[p.api.snap(px, H[k], H, k)]
        if (px > H[k]) expect(got, `${k} up to ${px}`).toBeGreaterThanOrEqual(H[k])
        if (px < H[k]) expect(got, `${k} down to ${px}`).toBeLessThanOrEqual(H[k])
      }
    })
  }
  it('a tie keeps the height it began at (keyboard up: Middle and Full draw the same)', () => {
    const p = page(), K = { focus: 12, middle: 90, full: 90 }
    expect(p.api.snap(120, 90, K, 'middle')).toBe('middle'); expect(p.api.snap(51, 90, K, 'middle')).toBe('middle')
    expect(p.api.snap(51, 12, K, 'focus')).toBe('focus')
  })
  it('the snap reads only the heights it is given: no height written in it', () => {
    const snap = between(APP, '  function sxDockSnap(px, h0, heights, start) {', '  /** The dock\'s height at each of the three')
    expect(snap).not.toMatch(/SX_DOCK_PX|\b\d{2,}\b|\bhalf\b/)
  })
  it('the drawn heights are measured at the drag\'s start and the page is put back: its height and the thread\'s scroll', () => {
    const p = page({ stored: 'middle', drawn: { focus: 102, middle: 165, full: 358 } }); p.api.paint()
    const set = p.reader.setAttribute.bind(p.reader)
    p.reader.setAttribute = (k: string, v: string) => { set(k, v); if (k === 'data-dock' && v === 'focus') p.body.scrollTop = 0 }   // the thread clamps
    expect(p.api.measure()).toEqual({ focus: 102, middle: 165, full: 358 })
    expect(p.reader.attrs['data-dock']).toBe('middle'); expect(p.body.scrollTop).toBe(812)
    p.api.down({ target: p.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' })
    expect(p.api.SX_DOCK.drag.heights).toEqual({ focus: 102, middle: 165, full: 358 })
    expect(p.reader.attrs['data-dock']).toBe('middle'); expect(p.body.scrollTop).toBe(812)
  })
  it('the drag itself: the dock follows the finger, lets go at the nearest height, and the click after it is not a tap', () => {
    const p = page({ stored: 'middle' })
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 })
    p.api.move({ clientY: 0 }); expect(p.dock.style.height).toBe('378px')     // never past full (the reader less 48)
    p.api.move({ clientY: 1000 }); expect(p.dock.style.height).toBe('68px')   // never under focus
    p.api.move({ clientY: 340 })                          // up 160 px: the dock grows from 126
    expect(p.dock.style.height).toBe('286px')
    p.api.up({ clientY: 300 })                            // let go 200 px up: 326, nearest is full (378)
    expect(p.api.height()).toBe('full'); expect(p.dock.style.height).toBe('')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')   // the click the browser sends after a drag
    p.api.click('dock-handle'); expect(p.api.height()).toBe('focus')  // the next tap steps again
  })
  it('a press that moves less than 6 px is a tap, not a drag', () => {
    const p = page({ stored: 'middle' })
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 }); p.api.move({ clientY: 497 }); p.api.up({ clientY: 497 })
    expect(p.api.height()).toBe('middle'); expect(p.dock.style.height).toBe('')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')
  })
  it('a press anywhere but the handle starts no drag', () => {
    const p = page(); p.api.down({ target: p.dock, clientY: 500 }); p.api.move({ clientY: 100 }); p.api.up({ clientY: 100 })
    expect(p.api.height()).toBe('middle'); expect(p.writes).toEqual([])
  })
  it('nothing else writes the height: in all of app.js, only sxDockSet writes it, and only his handlers call sxDockSet', () => {
    expect(APP.match(/SX_DOCK\.h\s*=[^=]/g)).toHaveLength(2)                  // sxDockSet, and sxDockHeight's first read
    expect(APP).toContain('if (!SX_DOCK.h) SX_DOCK.h = sxDockRead();')
    expect(APP.match(/setItem\(SX_DOCK_KEY/g)).toHaveLength(1)
    const calls = [...APP.matchAll(/sxDockSet\(/g)].length - 1                 // less its own definition
    expect(calls).toBe(5)                                                        // tap, bubble, expand, key, drag
    const inClick = between(APP, '  function sxDockClick(act) {', '  function sxDockKey(e) {').match(/sxDockSet\(/g)!.length
    const inKey = between(APP, '  function sxDockKey(e) {', '  function sxDockDown(e) {').match(/sxDockSet\(/g)!.length
    const inUp = between(APP, '  function sxDockUp(e) {', '  function sxDockHook() {').match(/sxDockSet\(/g)!.length
    expect([inClick, inKey, inUp]).toEqual([3, 1, 1])
    expect(calls - inClick - inKey - inUp).toBe(0)                               // no caller anywhere else
  })
  it('painting draws the stored height and never chooses one (a fold, a render, a frame)', () => {
    const p = page({ docked: true, stored: 'focus' })
    p.api.paint(); p.api.paint()
    expect(p.reader.attrs['data-dock']).toBe('focus'); expect(p.reader.cls.has('sx-docked')).toBe(true)
    expect(p.writes).toEqual([])
  })
})

describe('7.0.58: the dock is the reader\'s at every size and every pointer (Miles 12:27, "EVERYWHERE")', () => {
  const SIZES: Array<[number, number]> = [[1119, 787], [1119, 634], [951, 539], [1280, 800], [1440, 900], [1920, 1080], [382, 557], [449, 655]]
  for (const [w, h] of SIZES) for (const pointer of ['coarse', 'fine'] as const) {
    it(`${w}x${h}, ${pointer} pointer: docked, Middle with nothing stored, and the handle is there`, () => {
      const p = page({ w, h, pointer }); p.api.paint()
      expect(p.api.applies()).toBe(true)
      expect(p.reader.cls.has('sx-docked')).toBe(true)
      expect(p.reader.getAttribute('data-dock')).toBe('middle')
      expect(p.handle.attrs['aria-valuetext']).toBe('middle')
    })
  }
  it('no media query, width, height or pointer test anywhere in the dock (a gate put back is caught)', () => {
    const p = page({ w: 1440, h: 900, pointer: 'fine' }); p.api.paint(); p.api.hook()
    expect(p.mqCalls).toEqual([]); expect(p.mqListen()).toBe(0)
    const code = DOCK.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    expect(code).not.toMatch(/matchMedia|SHORT_TOUCH_MQ|SIDE_RAIL_MQ|isPhone\(|sideRail\(|pointer\s*:\s*(coarse|fine)|max-width|min-width|max-height|min-height|innerWidth|innerHeight|clientWidth/)
    expect(DOCKCSS, 'no media query around a dock rule').not.toMatch(/@media/)
  })
  it('every dock rule keys on .sx-docked, but the one that hides the new parts where the reader is not drawn', () => {
    const rules = DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean)
    const off = rules.filter(sel => !sel.split(',').every(part => /\.sx-docked/.test(part)))
    expect(off).toEqual(['.sx-dock-handle, .sx-dock-acts, .sx-x2, .sx-x2-note, .sx-stop-row', '.sx-dock-ico'])
  })
  it('a fine pointer: the handle says it resizes, never selects text, shows its focus, and a click steps', () => {
    expect(DOCKCSS).toContain('cursor: ns-resize; touch-action: none; user-select: none; -webkit-user-select: none; }')
    expect(DOCKCSS).toContain('.sx-docked .sx-dock-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }')
    expect(DOCKCSS).not.toContain('cursor: grab')
    const p = page({ w: 1440, h: 900, pointer: 'fine', stored: 'middle' }); p.api.click('dock-handle')
    expect(p.api.height()).toBe('full')
  })
  it('a drag that cannot finish (the window loses focus, pointercancel) ends where it began; the next release sets nothing', () => {
    const p = page({ w: 1440, h: 900, pointer: 'fine', stored: 'middle' }); p.api.hook()
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 }); p.api.move({ clientY: 300 })
    expect(p.dock.style.height).not.toBe('')
    p.listeners.blur[0]({}); expect(p.dock.style.height).toBe('')
    p.api.up({ clientY: 0 }); expect(p.api.height()).toBe('middle'); expect(p.writes).toEqual([])
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 }); p.api.move({ clientY: 300 }); p.listeners.pointercancel[0]({})
    expect(p.writes, 'a cancelled drag stores no height').toEqual([]); expect(p.api.height()).toBe('middle')
    expect(p.dock.style.height).toBe(''); p.api.click('dock-handle'); expect(p.api.height()).toBe('full')   // a tap after it still steps
    expect(p.listeners.blur).toHaveLength(1); expect(p.listeners.pointercancel).toHaveLength(1)
  })
  it('the dock is hooked once to resize and the pointer (it repaints; the height stays his)', () => {
    const p = page(); p.api.hook(); p.api.hook()
    expect(p.listeners.resize).toHaveLength(1)
    expect(p.listeners.pointermove).toHaveLength(1); expect(p.listeners.pointerup).toHaveLength(1)
  })
})

describe('7.0.58: a desk drag knows the drawn heights, and one pointer drives it (Q1 12:59, F1 probe 9)', () => {
  const DESK = { focus: 102, middle: 165, full: 358 }
  const desk = (stored: string, drawn: Record<string, number> = DESK) => { const p = page({ w: 1440, h: 900, pointer: 'fine', stored, drawn }); p.reader.clientHeight = 836; p.api.paint(); return p }
  it('from Middle, a release at Full\'s drawn height is Full and the preview never passes it; 12 px up stays Middle', () => {
    const p = desk('middle')
    p.api.down({ target: p.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' })
    p.api.move({ clientY: 100, pointerId: 1, buttons: 1 }); expect(p.dock.style.height).toBe('358px')   // not the 751 cap
    p.api.up({ clientY: 407, pointerId: 1 }); expect(p.api.height()).toBe('full')                       // 165 + 193 = 358
    const q = desk('middle')
    q.api.down({ target: q.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' }); q.api.move({ clientY: 588, pointerId: 1, buttons: 1 })
    q.api.up({ clientY: 588, pointerId: 1 }); expect(q.api.height()).toBe('middle')                    // F1: this went to Full
  })
  it('the preview never goes under Focus as drawn, and never past the reader less the floor', () => {
    const p = desk('middle')
    p.api.down({ target: p.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' }); p.api.move({ clientY: 900, pointerId: 1, buttons: 1 })
    expect(p.dock.style.height).toBe('102px')
    const q = desk('middle', { focus: 102, middle: 165, full: 900 })
    q.api.down({ target: q.handle, clientY: 900, pointerId: 1, pointerType: 'mouse' }); q.api.move({ clientY: 0, pointerId: 1, buttons: 1 })
    expect(q.dock.style.height).toBe((836 - 37 - q.api.SX_DOCK_PX.keep) + 'px')
  })
  it('a repaint during a drag (a stream event) does not change the heights the drag measured at its start', () => {
    const p = desk('full')
    p.api.down({ target: p.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' }); p.api.move({ clientY: 700, pointerId: 1, buttons: 1 })
    p.drawn.full = 180; p.api.apply()
    p.api.up({ clientY: 600, pointerId: 1 }); expect(p.api.height()).toBe('full')
  })
  it('a second finger moves and releases nothing; the first one finishes the drag', () => {
    const p = page({ stored: 'middle' })
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1, pointerType: 'touch' }); p.api.move({ clientY: 400, pointerId: 1 })
    const h1 = p.dock.style.height
    p.api.move({ clientY: 0, pointerId: 2 }); expect(p.dock.style.height).toBe(h1)
    p.api.up({ clientY: 0, pointerId: 2 }); expect(p.api.height()).toBe('middle'); expect(p.dock.style.height).toBe(h1)
    p.api.up({ clientY: 300, pointerId: 1 }); expect(p.api.height()).toBe('full'); expect(p.dock.style.height).toBe('')   // 126 + 200 = 326, nearer 378
  })
  it('a mouse moving with no button down missed its release: the drag ends where it began and stores nothing', () => {
    const p = desk('middle')
    p.api.down({ target: p.handle, clientY: 600, pointerId: 1, pointerType: 'mouse' }); p.api.move({ clientY: 400, pointerId: 1, buttons: 1 })
    expect(p.dock.style.height).not.toBe('')
    p.api.move({ clientY: 300, pointerId: 1, buttons: 0 })
    expect(p.dock.style.height).toBe(''); expect(p.api.SX_DOCK.drag).toBeNull()
    p.api.up({ clientY: 300, pointerId: 1 }); expect(p.api.height()).toBe('middle'); expect(p.writes).toEqual([])
  })
})

describe('7.0.58: the working line and the activity excerpt are plain text (Miles 12:27)', () => {
  it('bold, code, headings, bullets, quotes and link brackets come out; the words stay, on one line', () => {
    const p = page()
    expect(p.api.plainLine('last reply: **What is on your Mac right now:**')).toBe('last reply: What is on your Mac right now:')
    expect(p.api.plainLine('`npm test` passed with *no* failures')).toBe('npm test passed with no failures')
    expect(p.api.plainLine('## Plan\n- one step\n> a quote with [a link](https://x.test/a)\n2. two')).toBe('Plan one step a quote with a link two')
    expect(p.api.plainLine(null)).toBe('')
    // A lone star is not emphasis: a path keeps it (Q1 12:59); a star bullet goes.
    expect(p.api.plainLine('edited src/*.ts and 2 * 3')).toBe('edited src/*.ts and 2 * 3')
    expect(p.api.plainLine('* first\n* second')).toBe('first second')
  })
  it('paintActivity draws both through it, escaped after', () => {
    expect(APP).toContain("'<span class=\"sx-act-detail\">' + esc(sxPlainLine(detail)) + '</span>' +")
    expect(APP).toContain("'<div class=\"sx-act-prose\">' + esc(sxPlainLine(String(live.prose).slice(-600))) + '</div>'")
  })
})

describe('Stop: full only, never one tap, Keep working the default', () => {
  it('while working, full\'s Stop only asks: the first tap is not stop-session', () => {
    const p = page({ stored: 'full' }); p.api.stop(p.r)
    expect(p.stop.innerHTML).toBe('<button type="button" class="cx-btn quiet sx-stop-ask" data-sx="dock-stop">Stop</button>')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
  it('asked: "Stop this session?", Keep working filled and focused first, Stop to the right', () => {
    const p = page({ stored: 'full' }); p.api.click('dock-stop')
    expect(p.stop.innerHTML).toBe('<p class="sx-stop-q" id="session-stop-q">Stop this session?</p>' +
      '<button type="button" class="cx-btn primary sx-stop-keep" data-sx="dock-stop-keep" aria-describedby="session-stop-q">Keep working</button>' +
      '<button type="button" class="cx-btn danger sx-stop-go" data-action="stop-session">Stop</button>')
    expect(p.stop.kids.keep.focused).toBe(1)
    expect(p.stop.innerHTML.indexOf('dock-stop-keep')).toBeLessThan(p.stop.innerHTML.indexOf('stop-session'))
  })
  it('Keep working puts the one Stop back; a height change forgets the question', () => {
    const p = page({ stored: 'full' }); p.api.click('dock-stop'); p.api.click('dock-stop-keep')
    expect(p.stop.innerHTML).toContain('data-sx="dock-stop"'); expect(p.stop.innerHTML).not.toContain('stop-session')
    p.api.click('dock-stop'); p.api.click('dock-focus'); p.api.click('dock-full')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
  it('Q1 07:15: asked, a stream of activity and resize paints never rebuild the row or move focus; Keep working is focused once', () => {
    const p = page({ docked: true, stored: 'full' })
    p.api.stop(p.r)                                        // the first paint: one Stop that asks
    p.api.click('dock-stop')                               // his tap: the question
    const w = p.stop.writes
    for (let i = 0; i < 6; i++) { p.api.stop(p.r); p.api.paint() }   // paintActivity per stream event, sxDockPaint per resize
    expect(p.stop.writes, 'the same buttons stay under his thumb').toBe(w)
    expect(p.stop.kids.keep.focused, 'focus moved once, from his tap').toBe(1)
    expect(p.stop.innerHTML).toContain('data-sx="dock-stop-keep"')
  })
  it('the row is rebuilt only when its state changes: ask, asked, ask again, none when it stops', () => {
    const p = page({ stored: 'full' })
    p.api.stop(p.r); p.api.stop(p.r); expect([p.stop.attrs['data-stop'], p.stop.writes]).toEqual(['ask', 1])
    p.api.click('dock-stop'); expect([p.stop.attrs['data-stop'], p.stop.writes]).toEqual(['asked', 2])
    p.api.click('dock-stop-keep'); expect([p.stop.attrs['data-stop'], p.stop.writes]).toEqual(['ask', 3])
    p.r.live.working = false; p.api.stop(p.r); expect([p.stop.attrs['data-stop'], p.stop.innerHTML]).toEqual(['none', ''])
    p.r.live.working = true; p.api.stop(p.r); expect(p.stop.innerHTML).toContain('data-sx="dock-stop"')   // asked was forgotten
  })
  it('a turn that ends forgets the question: the next turn shows the one Stop, not "Stop this session?" (S4)', () => {
    const p = page({ stored: 'full' })
    p.api.stop(p.r); p.api.click('dock-stop')                   // asked, and he leaves it
    p.r.live.working = false; p.api.stop(p.r)                  // the turn ends
    p.r.live.working = true; p.api.stop(p.r)                   // the next turn starts
    expect(p.stop.attrs['data-stop']).toBe('ask')
    expect(p.stop.innerHTML).toBe('<button type="button" class="cx-btn quiet sx-stop-ask" data-sx="dock-stop">Stop</button>')
  })
  it('only his tap of Stop moves focus: the painters never call focus', () => {
    expect(between(APP, '  function sxStopPaint(r) {', '  function sxStopFocusKeep() {')).not.toContain('focus(')
    expect(between(APP, '  function paintActivity(r) {', '\n  }\n')).toContain("if (typeof sxStopPaint === 'function') sxStopPaint(r);")
    expect(APP).toContain("if (act === 'dock-stop') { SX_DOCK.stopAsk = true; sxStopPaint(state.reading); return sxStopFocusKeep(); }")
  })
  it('not working: no Stop at all', () => {
    const p = page({ stored: 'full', working: false }); p.api.stop(p.r)
    expect(p.stop.innerHTML).toBe('')
  })
  it('the lead 18:5x: Stop cannot be reached in one tap from focus or middle', () => {
    // No Stop on the working line while docked, and the Stop row is drawn in full only.
    expect(DOCKCSS).toContain('.sx-docked .sx-act-label, .sx-docked .sx-act-prompt, .sx-docked .sx-act-stop, .sx-docked .sx-act-tail { display: none; }')
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-form > .sx-x2-note, .sx-docked:not([data-dock='full']) #session-form > .sx-stop-row,")
    expect(DOCKCSS).toContain(".sx-docked[data-dock='focus'] #session-verdict, .sx-docked[data-dock='focus'] #session-form,")
    // The reader has two Stops that stop: the working line's (not drawn docked) and the answer to the ask.
    expect(APP.match(/data-action="stop-session"/g)).toHaveLength(2)
    expect(APP).toContain('<button type="button" class="cx-btn quiet sx-act-stop" data-action="stop-session">Stop</button>')
    // The working line's two buttons only change the height.
    const p = page({ stored: 'middle' }); p.api.click('dock-full'); p.api.click('dock-focus')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
})

describe('7.0.57: a card he must read holds Full at Middle (F1 probe 6; the lead 09:3x, 09:4x)', () => {
  const REQ = 'Answer the request to open the full view.', QN = 'Answer the question to open the full view.'
  it('a request card whose Approve can be tapped: Full is drawn as Middle and the working line says why', () => {
    const p = page({ docked: true, stored: 'full', working: false, card: 'enabled' }); p.api.paint()
    expect(p.reader.attrs['data-dock']).toBe('middle')
    expect([p.why.hidden, p.why.textContent]).toEqual([false, REQ])
    expect(p.reader.kids.full.attrs['aria-pressed']).toBe('false')
    expect(p.api.height()).toBe('full')                               // his choice is kept
    expect(p.writes).toEqual([])
  })
  it('while the session works Approve is disabled and Full stays, so Stop is reachable', () => {
    const p = page({ docked: true, stored: 'full', working: true, card: 'disabled' }); p.api.paint()
    expect(p.reader.attrs['data-dock']).toBe('full'); expect(p.why.hidden).toBe(true)
    expect(p.stop.innerHTML).toContain('data-sx="dock-stop"')
  })
  it('this session\'s question card while it is not working: Middle and its own words; working: Full', () => {
    const p = page({ docked: true, stored: 'full', working: false, question: true }); p.api.paint()
    expect(p.reader.attrs['data-dock']).toBe('middle'); expect([p.why.hidden, p.why.textContent]).toEqual([false, QN])
    p.r.live.working = true; p.api.apply()
    expect(p.reader.attrs['data-dock']).toBe('full'); expect(p.why.hidden).toBe(true)
  })
  it('Full comes back the moment the card goes; the line goes with it', () => {
    const p = page({ docked: true, stored: 'full', working: false, card: 'enabled' }); p.api.paint()
    p.form.__paCard = null; p.api.apply()
    expect(p.reader.attrs['data-dock']).toBe('full'); expect([p.why.hidden, p.why.textContent]).toEqual([true, ''])
    const q = page({ docked: true, stored: 'full', working: false, question: true }); q.api.paint()
    q.qs.children = []; q.qs.textContent = ''; q.api.apply()
    expect(q.reader.attrs['data-dock']).toBe('full'); expect(q.why.hidden).toBe(true)
  })
  it('the reason line only while it holds: never at Middle or Focus, never with no card', () => {
    for (const stored of ['middle', 'focus']) {
      const p = page({ docked: true, stored, working: false, card: 'enabled' }); p.api.paint()
      expect(p.reader.attrs['data-dock']).toBe(stored); expect(p.why.hidden).toBe(true)
    }
    const none = page({ docked: true, stored: 'full', working: false }); none.api.paint()
    expect(none.reader.attrs['data-dock']).toBe('full'); expect(none.why.hidden).toBe(true)
  })
  it('the bubble and a drag to Full are not dead: Full is stored, Middle drawn, the reason shown', () => {
    const p = page({ docked: true, stored: 'middle', working: false, card: 'enabled' }); p.api.paint()
    p.api.click('dock-full')
    expect(p.api.height()).toBe('full'); expect(p.reader.attrs['data-dock']).toBe('middle'); expect(p.why.textContent).toBe(REQ)
    p.api.click('dock-full')                                          // again: still asks for Full, not back to Middle
    expect(p.api.height()).toBe('full'); expect(p.why.hidden).toBe(false)
    const d = page({ docked: true, stored: 'middle', working: false, card: 'enabled' }); d.api.paint()
    d.api.down({ target: d.handle, clientY: 500, pointerId: 1 }); d.api.move({ clientY: 0 }); d.api.up({ clientY: 0 })
    expect(d.api.height()).toBe('full'); expect(d.reader.attrs['data-dock']).toBe('middle'); expect(d.why.textContent).toBe(REQ)
  })
  // The lead 09:5x: the switch happens by itself, so it must move nothing he holds.
  it('the switch by itself (the session stops and Approve opens; the card goes) keeps his focus, his draft and his reading place', () => {
    const p = page({ docked: true, stored: 'full', working: true, card: 'disabled' })
    p.input.value = 'half a sentence he is still writing'
    p.api.paint(); const fits0 = p.fits.length
    expect(p.reader.attrs['data-dock']).toBe('full')
    p.r.live.working = false; p.go.disabled = false; p.api.apply()     // phoneBusyApply's call when it stops
    expect(p.reader.attrs['data-dock']).toBe('middle')
    p.form.__paCard = null; p.api.apply()                               // clearPhoneOffer's call when the card goes
    expect(p.reader.attrs['data-dock']).toBe('full')
    expect(p.input.value).toBe('half a sentence he is still writing')
    expect([p.input.focused, p.handle.focused, p.why.focused, p.go.focused]).toEqual([0, 0, 0, 0])
    expect(p.body.scrollTop).toBe(812)
    expect(p.fits.length, 'the light apply never refits the box').toBe(fits0)
    expect(p.writes).toEqual([])
    const apply = between(APP, '  function sxDockApply() {', '  /** Draw the stored height on the reader.')
    expect(apply).not.toMatch(/focus\(|scrollTop|scrollTo|scrollIntoView|\.value\b|sxPlaceholderFit|sxDockSet/)
  })
  it('Approve never shows enabled under Full for even one paint: its one writer sets it, then the dock applies, in the same call', () => {
    expect(APP.match(/go\.disabled\s*=[^=]/g)).toHaveLength(1)
    const busy = between(APP, '  function phoneBusyApply(r, view) {', '  function phoneArrange(view) {')
    const set = busy.indexOf('    go.disabled = !!why;'), dock = busy.indexOf("    if (view.prefix === 'session' && typeof sxDockApply === 'function') sxDockApply();")
    expect(set).toBeGreaterThan(-1); expect(dock).toBeGreaterThan(set)
    // Synchronous between the two: no timer, frame, promise or await can let the browser paint in the middle.
    expect(busy.slice(set, dock)).not.toMatch(/setTimeout|requestAnimationFrame|\.then\(|await|queueMicrotask/)
    expect(busy).not.toMatch(/setTimeout\(sxDockApply|requestAnimationFrame\(sxDockApply/)
  })
  it('both mounts: the hold reads the form\'s carried card, never where it is mounted; the hooks that change a card call it', () => {
    const hold = between(APP, '  function sxDockHold() {', '  /** The height drawn:')
    expect(hold).toContain('form && form.__paCard && go && !go.disabled')
    expect(hold).not.toMatch(/parentNode|session-body|sx-chat/)
    expect(APP).toContain("    if (typeof sxDockApply === 'function') sxDockApply();   // the working flag decides whether a card holds Full\n")
    expect(APP).toContain("    if (view.prefix === 'session' && typeof sxDockApply === 'function') sxDockApply();   // Approve enabled or not decides the hold\n")
    expect(APP).toContain("    if (view.prefix === 'session' && typeof sxDockApply === 'function') sxDockApply();   // the card is gone: Full comes back\n")
    expect(APP).toContain("  function sxGoQuestionPaint() {\n    if (typeof sxDockApply === 'function') sxDockApply();   // a question card came or went\n")
    expect(APP).toContain('\'<p class="sx-dock-why" id="session-dock-why" role="status" hidden></p>\' +')
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock-why { display: none; }')
  })
})

describe('the one note (README "The working note")', () => {
  function note(o: { provider?: string; midTurn?: boolean; files?: boolean; passkey?: boolean }) {
    const ctx: Record<string, unknown> = {
      phoneEngine: (r: any) => (r.provider === 'codex' ? 'Codex' : r.provider === 'cursor' ? 'Cursor' : 'Claude'),
      sxProvider: (p: string) => (p === 'codex' || p === 'cursor' ? p : 'claude'), sxReaderHasFiles: () => !!o.files, WEB_KEY: { views: [] },
    }
    vm.createContext(ctx)
    vm.runInContext(NOTE + ';this.note = sxWorkNote;', ctx)
    return (ctx as any).note({ provider: o.provider || 'claude', verdict: { midTurn: !!o.midTurn } }, !!o.passkey, o.files)
  }
  it('a session that takes a message mid-turn: Queue message lands at its next step', () => {
    expect(note({ midTurn: true, passkey: true })).toBe('Claude is working. Queue message lands at its next step. Send with passkey opens when it stops.')
  })
  it('one that does not: it waits and lands when this turn ends', () => {
    expect(note({ passkey: true })).toBe('Claude is working. A message you send waits and lands when this turn ends. Send with passkey opens when it stops.')
  })
  it('with files in the box: a message with files waits for the turn end', () => {
    expect(note({ midTurn: true, files: true, passkey: true })).toBe('Claude is working. A message with files waits and lands when this turn ends. Send with passkey opens when it stops.')
  })
  it('Codex and Cursor say their own', () => {
    expect(note({ provider: 'codex', passkey: true })).toBe('Codex is working. A message you send joins the Codex app’s queue for this thread. Send with passkey opens when it stops.')
    expect(note({ provider: 'cursor', passkey: true })).toBe('Cursor is working. A message you send goes into this Cursor chat when its turn ends. Send with passkey opens when it stops.')
  })
  it('the passkey sentence only where the passkey button exists', () => {
    expect(note({ midTurn: true, passkey: false })).toBe('Claude is working. Queue message lands at its next step.')
  })
  it('sxPaOn: true only for this session, and only where its form carries pa-on', () => {
    const r1 = {}, r2 = {}, form = (on: boolean) => ({ classList: { contains: (c: string) => on && c === 'pa-on' } })
    const ctx: Record<string, unknown> = { WEB_KEY: { views: [{ r: r1, view: { form: form(true) } }, { r: r2, view: { form: form(false) } }] } }
    vm.createContext(ctx); vm.runInContext(NOTE + ';this.paOn = sxPaOn;', ctx)
    const paOn = (ctx as any).paOn
    expect(paOn(r1)).toBe(true); expect(paOn(r2)).toBe(false); expect(paOn({})).toBe(false); expect(paOn(null)).toBe(false)
  })
  it('one note: where the passkey composer is on, the reader\'s, the Answer box\'s and Today\'s park notes are not drawn', () => {
    expect(APP).toContain("if (sxParkNoteShows(r) && !paOn) html = '<div class=\"sx-park\"><p>' + esc(sxParkLine(r)) + '</p>'")
    expect(APP).toContain("return sxParkNoteShows(r) && !sxPaOn(r) ? '<div class=\"sx-park\"><p>' + esc(sxParkLine(r, false)) + '</p></div>' : '';")
    expect(TA).toContain("if (K.feed.parkNoteShows(r) && !(typeof K.paOn === 'function' && K.paOn(r))) html = '<p class=\"sx-park\">'")
    expect(APP).toContain('paOn: sxPaOn,')
  })
})

describe('the markup and the CSS', () => {
  it('the dock opens with the handle and the working line with its two 44 px buttons; full\'s parts live inside the form', () => {
    expect(APP).toContain('\'<button type="button" class="sx-dock-handle" id="session-handle" data-sx="dock-handle" aria-valuetext="middle"><span aria-hidden="true"></span></button>\' +')
    expect(APP).toContain('data-sx="dock-full" aria-pressed="false" aria-label="Show all actions">')
    expect(APP).toContain('data-sx="dock-focus" aria-label="Expand the thread">')
    expect(APP).toContain('<div class="sx-x2"><button type="button" class="cx-btn quiet" data-action="fork-session"')
    expect(APP).toContain('\'<div class="sx-stop-row" id="session-stop-row"></div>\' +')
    expect(DOCKCSS).toContain('.sx-docked .sx-dock-btn { display: grid; place-items: center; width: 44px; height: 44px;')
    expect(DOCKCSS).toContain('.sx-docked .sx-stop-ask, .sx-docked .sx-stop-keep, .sx-docked .sx-stop-go { min-height: 44px; }')
    // The handle is 20 px to see and 44 to touch: 24 more above it.
    expect(DOCKCSS).toContain('height: 20px;')
    expect(DOCKCSS).toContain(".sx-docked .sx-dock-handle::before { content: ''; position: absolute; left: 0; right: 0; top: -24px; bottom: 0; }")
  })
  // Miles 08:2x ("Hidden is fine"), F1 08:2x class A: Approve is never drawn while the request card is not.
  it('THE INVARIANT: with the keyboard up the request card and every passkey send share one rule, and nothing else touches them', () => {
    const rules = DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean).map(r => ({ sels: r.split('{')[0].split(',').map(s => s.trim()), body: r.split('{')[1] }))
    const kbPa = rules.filter(r => r.sels.some(s => s.includes('.kb-up') && /\.pa-card|#session-phone-card|\.pa-go/.test(s)))
    expect(kbPa).toHaveLength(1)
    expect(kbPa[0].sels).toEqual(['html.sx-frame.kb-up .sx-docked #session-phone-card', 'html.sx-frame.kb-up .sx-docked #session-form .pa-go'])
    // ...and the selector names the element the code really draws, wherever it puts it (X1 08:3x: the card is never in the
    // form, so '#session-form > .pa-card' matched nothing at dcddf408).
    expect(APP).toContain("card.className = 'pa-card'; card.id = view.prefix + '-phone-card';")
    const place = between(APP, '  function phoneCardPlace(view, card) {', '    if (reader && !reader.__paRo')
    expect(place).toContain('if (wide) { if (card.parentNode !== body) body.insertBefore(card, body.firstChild); }')
    expect(place).toContain('else if (chat && card.parentNode !== chat) chat.insertBefore(card, chat.firstChild);')
    expect(DOCKCSS, 'no rule may select the card as a child of the form').not.toContain('#session-form > .pa-card')
    expect(kbPa[0].body.trim()).toBe('display: none;')
    // It outranks every rule that draws either one (specificity: ids, then classes/attributes/pseudo-classes, then types).
    const spec = (s: string) => [(s.match(/#[\w-]+/g) || []).length, (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length, (s.match(/(^|\s)[a-z]+(?=[.#\[:\s]|$)/g) || []).length]
    const beats = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    const shows = rules.filter(r => /display:\s*(?!none\b)[a-z]/.test(r.body) && r.sels.some(s => /\.pa-card|#session-phone-card|\.pa-go/.test(s)))
    expect(shows.length).toBeGreaterThan(0)
    // Each against the rules that draw the same thing: the card's against the card's, Approve's against Approve's.
    for (const r of shows) for (const s of r.sels.filter(x => /\.pa-card|#session-phone-card|\.pa-go/.test(x))) {
      const inv = /\.pa-go/.test(s) ? kbPa[0].sels[1] : kbPa[0].sels[0]
      expect(beats(spec(inv), spec(s)), inv + ' over ' + s).toBeGreaterThan(0)
    }
  })
  it('with a request card up and the keyboard up, the plain send (a message, not an answer) is the reply row\'s send', () => {
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked #session-form.pa-req #session-send { display: inline-flex; grid-area: send; width: 140px; margin-bottom: 0; }')
    // And Middle's request-state rule that hides it is outranked (2 ids and 4 classes plus html, against 2 and 3).
    expect(DOCKCSS).toContain(".sx-docked[data-dock='middle'] #session-form.pa-req #session-send { display: none; }")
  })
  it('keyboard up: the handle is 12 px to see and still 44 to touch (12 + 32 of reach)', () => {
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock-handle { height: 12px; }')
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock-handle::before { top: -32px; }')
  })
  it('F1 08:02: the docked form has no row gap, so its empty template rows add nothing; the 8 px sits under what is drawn', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-form { display: grid; grid-template-columns: auto auto minmax(0, 1fr) 140px; column-gap: 6px; row-gap: 0; align-items: center;')
    expect(DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#session-form \{[^}]*row-gap: [1-9]/)
    const sel = between(DOCKCSS, '.sx-docked #session-form > .pa-note, .sx-docked #session-form > .sx-x2,', '{ margin-bottom: 8px; }')
    for (const part of ['#session-form > .pa-note', '#session-form > .sx-x2', '#session-form > .sx-stop-row', '#session-files:not(.hidden)', '#session-clip', '#session-form:not(.pa-req) .pa-go', '#session-form.pa-req #session-send'])
      expect(sel.split(',').map(x => x.trim()).filter(Boolean), part).toContain('.sx-docked ' + part)
    // The reply row itself carries no margin: it is the form's last row and its foot.
    expect(sel).not.toMatch(/#session-input|#session-send,|\.pa-req \.pa-go/)
    expect(DOCKCSS).toContain('.sx-docked #session-form > .sx-x2-note { grid-area: x2n; display: block; margin: -4px 0 8px;')
  })
  it('the plain send keeps 140 px for both its labels, so the field never moves', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-send { grid-area: send; width: 140px; min-height: 44px; }')
    expect(DOCKCSS).toContain("grid-template-columns: auto auto minmax(0, 1fr) 140px;")
  })
  it('one Fork: the composer\'s small Fork is not drawn docked, and the busy box\'s is not drawn beside full\'s', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-form .sx-fork-small { display: none; }')
    expect(DOCKCSS).toContain(".sx-docked[data-dock='full'] #session-verdict [data-action='fork-session'] { display: none; }")
  })
  it('camera, attach and the passkey send live in full only', () => {
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-form > .pa-note, .sx-docked:not([data-dock='full']) #session-form .pa-go,")
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-clip, .sx-docked:not([data-dock='full']) #session-form > .sx-x2,")
  })
  it('a request card up keeps Approve and send in the reply row at every height (the lead 18:5x: not flipped)', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-form.pa-req .pa-go { grid-area: send; width: 140px; }')
    expect(DOCKCSS).toContain(".sx-docked[data-dock='middle'] #session-form.pa-req .pa-go { display: inline-flex; }")
  })
  // F1 07:17 (382x557, 3 queued and Not sent): Middle grew to 691 px and left 8 px of thread, Full left 48. This
  // harness has no layout engine, so the heights themselves are F1's probe; here: the floor is one constant
  // (SX_DOCK_PX.keep, read from the code, never restated), the paint sets it, and every height's CSS is held to it.
  it('the thread floor is SX_DOCK_PX.keep: the paint sets --sx-floor from it', () => {
    const p = page({ docked: true }), keep = p.api.SX_DOCK_PX.keep
    p.api.paint()
    expect(p.reader.style['--sx-floor']).toBe(keep + 'px')
    expect(keep).toBeGreaterThan(0)
  })
  it('every height keeps the floor: the thread never under it, the dock gives way and scrolls, so Middle is never taller than Full', () => {
    expect(DOCKCSS).toContain('html.sx-frame .sx-docked .sx-body { min-height: var(--sx-floor); }')
    expect(DOCKCSS).toContain('html.sx-frame .sx-docked .sx-dock { flex: 0 1 auto; min-height: 0; }')
    // 7.0.58: Full is its content's height under the same cap; no rule gives Full's dock or thread a size of its own.
    expect(DOCKCSS).not.toMatch(/\[data-dock='full'\] \.sx-(body|dock) \{/)
    const rules = DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules, 'no px thread height: the floor is the one constant').not.toMatch(/sx-body \{[^}]*\d+px/)
    expect(rules, 'no dock minimum that could beat the floor').not.toMatch(/\.sx-dock \{[^}]*min-height: [1-9]/)
    // The frame scrolls the dock and pins the reply row at its foot (7.0.55), which the floor relies on.
    expect(CSS).toContain('html.sx-frame .sx-dock { overflow-y: auto; overscroll-behavior: contain; }')
    expect(CSS).toContain('html.sx-frame .sx-dock #session-form { order: 10; position: sticky; bottom: 0; z-index: 1; background: var(--page); }')
  })
  it('keyboard up (F1 07:41, Q1 07:42): the dock is the handle and the reply row at every height; what answers a send sits under it', () => {
    const hide = between(DOCKCSS, "html.sx-frame.kb-up .sx-docked .sx-wline,", '{ display: none; }')
    // Whole selectors, never a substring: '#session-form > .sx-x2' is inside '... > .sx-x2-note' (mutant K2 survived that).
    const sels = hide.split(',').map(x => x.trim()).filter(Boolean)
    expect(sels).toEqual(['.sx-wline', '#session-queue', '#session-clip', '#session-form > .pa-note', '#session-form > .sx-x2', '#session-form > .sx-x2-note',
      '#session-form > .sx-stop-row'].map(p => 'html.sx-frame.kb-up .sx-docked ' + p))
    // The field itself is never hidden.
    expect(hide).not.toMatch(/\.pa-req \.pa-go|#session-input|#session-send,|#session-form,/)
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock #session-verdict, html.sx-frame.kb-up .sx-docked .sx-dock > .sx-mac-q { order: 11; }')
    // The one-line status (Sent, Not sent) above the field, before the form's order 10 (Q1 07:48).
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock #session-status { order: 9; }')
    expect(CSS).toContain('html.sx-frame .sx-dock #session-form { order: 10; position: sticky; bottom: 0; z-index: 1; background: var(--page); }')
    // Full is its content's height at every size (7.0.58), so with the keyboard up the extras cannot push the field under it.
    expect(DOCKCSS).not.toMatch(/kb-up \.sx-docked\[data-dock='full'\] \.sx-(body|dock)/)
  })
  it('the working line stays one line: a dropped-feed note is cut, not wrapped (F1: Focus grew to 180 px)', () => {
    expect(DOCKCSS).toContain('.sx-docked .sx-act-fallback { height: 44px; padding-top: 0; line-height: 44px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }')
  })
  it('the placeholder is whole: the empty field takes two lines when its words need them, keyboard up too (F1 07:17 at 382)', () => {
    expect(DOCKCSS).toContain('html.sx-frame .sx-docked .sx-dock #session-input { max-height: 140px; }')
    expect(DOCKCSS).toContain('html.sx-frame.kb-up .sx-docked .sx-dock #session-input { max-height: 4.5em; }')
    // autoGrow sizes an empty box to its placeholder; the dock paint fits it again when the dock changes the width.
    expect(APP).toContain("if (!ta.value && ta.id === 'session-input' && ta.placeholder) h = Math.max(h, placeholderHeight(ta, ta.placeholder));")
    const p = page({ docked: true }); p.api.paint()
    expect(p.fits).toEqual([p.input])
  })
  it('no motion on a height change (reduced motion is respected by having none)', () => {
    expect(DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/transition|animation/)
  })
  it('the send rule\'s weight everywhere the passkey composer runs; a request card keeps today\'s', () => {
    expect(CHATCSS).toContain('.composer.pa-on:not(.pa-req) .pa-go, .rr-answer.pa-on:not(.pa-req) .pa-go { background: transparent; color: var(--accent); border: 1px solid var(--accent); }')
    expect(CHATCSS).toContain('.rr-answer.pa-on:not(.pa-req) #rr-send { background: var(--accent); color: var(--on-accent); border-color: var(--accent); min-height: 44px; }')
  })
})
