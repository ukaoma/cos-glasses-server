/** Source-extracted behavioural harness. No browser geometry claim: F1 still owes the physical Duo/fold/keyboard run. */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')

function frame() {
  const classes = new Set<string>(['short-screen']), events: Record<string, Function[]> = {}, frames: Function[] = [], writes: number[] = []
  let width = 449, coarse = true, page = 0, wsY = 500, nodeY = 900, hidden = false, route = { pane: 'today', args: [] as string[] }
  const cls = { contains: (s: string) => classes.has(s), toggle: (s: string, on: boolean) => { if (on) classes.add(s); else classes.delete(s) } }
  const de: any = { classList: cls, get clientWidth() { return width } }
  const framed = () => classes.has('pg-frame'), wsTop = () => width >= 600 ? 64 : 112
  const rect = (y: number) => ({ top: (framed() ? wsTop() + y - wsY : 64 + y - page), bottom: 0, left: 0, width: width - 80, height: 24 })
  const node: any = { isConnected: true, getBoundingClientRect: () => rect(nodeY) }
  const pane: any = { contains: (n: any) => n === node, getBoundingClientRect: () => ({ ...rect(0), height: 4000 }) }
  const ws: any = { get scrollTop() { return wsY }, set scrollTop(n: number) { wsY = Math.max(0, Math.min(n, 4000)); writes.push(wsY) }, scrollHeight: 4700,
    getBoundingClientRect: () => ({ top: wsTop(), bottom: 787, width: width - 80, height: 675 }), contains: () => false }
  const shell = { classList: { contains: (s: string) => s === 'hidden' && hidden }, getBoundingClientRect: () => ({ top: 0, bottom: 787 }) }
  const rail = { getBoundingClientRect: () => ({ top: 0, bottom: 787 }) }
  const bar = { getBoundingClientRect: () => ({ top: 0, bottom: 64 }) }
  const emit = (name: string) => (events[name] || []).forEach(fn => fn({}))
  const on = (name: string, fn: Function) => { (events[name] ||= []).push(fn) }
  const win: any = { get innerWidth() { return width }, get scrollY() { return page }, addEventListener: on,
    scrollTo: (_x: number, y: number) => { page = y }, scrollBy: (_x: number, y: number) => { page += y },
    matchMedia: (q: string) => ({ matches: q.includes('600px') ? width >= 600 && coarse : coarse }),
    getComputedStyle: (el: any) => ({ position: el === bar ? 'sticky' : 'static', display: 'block' }) }
  const doc: any = { documentElement: de, body: {}, addEventListener: on, scrollingElement: { scrollHeight: 4700 },
    querySelector: (s: string) => s === '.rail' ? rail : s === '.topbar' ? bar : null, elementFromPoint: () => node }
  const src = APP.slice(APP.indexOf('  var PG_FRAME_PANES'), APP.indexOf('  var RD_FRAME = { hooked: false, n: 0 };'))
  const make = new Function('document', 'window', '$', 'getComputedStyle', 'parseRoute', 'sideRail', 'viewportFit', 'layoutCrumb', 'requestAnimationFrame', src +
    '\nreturn { sync: pgFrameSync, on: pgFrameOn, remember: typeof pgPlaceRemember === "function" ? pgPlaceRemember : function () {}, drop: typeof pgPlaceDrop === "function" ? pgPlaceDrop : function () {}, capture: pgPlaceCapture, place: PG_PLACE };')
  const api = make(doc, win, (id: string) => id === 'workspace' ? ws : id === 'app-shell' ? shell : id === 'pane-' + route.pane ? pane : null,
    win.getComputedStyle, () => route, () => width < 600 && coarse && classes.has('short-screen'),
    () => ({ top: 0, height: 787, bad: true }), () => true, (fn: Function) => frames.push(fn))
  return { ...api, doc, pane, classes, ws, node, writes, emit, flush: () => { const q = frames.splice(0); q.forEach(fn => fn()) },
    resize: (w: number, shift = 0) => { width = w; nodeY += shift; emit('resize') },
    setCoarse: (on: boolean) => { coarse = on }, setPage: (y: number) => { page = y }, page: () => page,
    setHidden: (on: boolean) => { hidden = on }, route: (pane: string, args: string[] = []) => { route = { pane, args }; api.sync(route) } }
}

describe('Duo page-frame ownership and live place migration', () => {
  it('frames Today/Settings at 449 short/coarse and 1019 coarse, never tall phones or a fine pointer', () => {
    const f = frame(); expect(f.sync()).toBe(true)
    f.route('settings'); expect(f.classes.has('pg-frame')).toBe(true)
    f.classes.delete('short-screen'); expect(f.sync()).toBe(false); f.flush()
    f.resize(1019); f.flush(); expect(f.classes.has('pg-frame')).toBe(true)
    f.setCoarse(false); expect(f.sync()).toBe(false); f.flush()
    expect(f.classes.has('pg-frame')).toBe(false)
  })
  it('leaving focused COS frames Today immediately, without changing Focus itself', () => {
    const f = frame(); f.classes.add('focus'); f.route('messages', ['cos'])
    expect(f.classes.has('pg-frame')).toBe(false)
    f.route('today'); expect(f.classes.has('pg-frame')).toBe(true)
    expect(f.classes.has('focus')).toBe(true) // focusSync owns clearing this later in routeHooks, not this frame
  })
  it('does not opt in COS, message readers, any Sessions view, or unreviewed panes; never stacks sx/rd', () => {
    const f = frame()
    for (const pane of ['messages', 'sessions', 'usage', 'work', 'meetings', 'speakers', 'memories', 'threads', 'dictation', 'constructor', 'toString']) {
      f.route(pane); expect(f.classes.has('pg-frame'), pane).toBe(false)
    }
    f.route('today')
    for (const other of ['sx-frame', 'rd-frame']) {
      f.classes.add(other); expect(f.sync()).toBe(false); expect(f.classes.has('pg-frame')).toBe(false); expect(f.classes.has(other)).toBe(true); f.flush()
      f.classes.delete(other); f.sync(); f.flush()
    }
    f.setHidden(true); expect(f.sync()).toBe(false)
  })
  it('449 -> 1019 -> 449 preserves the same live anchor after reflow and applies each queued restoration once', () => {
    const f = frame(); f.sync(); f.remember(); f.writes.length = 0
    f.resize(1019, 250); expect(f.writes).toHaveLength(0)
    f.flush(); expect(f.ws.scrollTop).toBe(750); expect(f.writes).toHaveLength(1)
    f.flush(); expect(f.writes).toHaveLength(1)
    f.resize(449, -250); f.flush(); expect(f.ws.scrollTop).toBe(500); expect(f.writes).toHaveLength(2)
    expect(f.page()).toBe(0)
  })
  it('moves a live page anchor into workspace on entry and back to page on exit, not an old saved offset', () => {
    const f = frame(); f.classes.delete('short-screen'); f.setPage(500); f.ws.scrollTop = 0; f.sync(); f.remember()
    f.resize(1019); f.flush(); expect(f.ws.scrollTop).toBe(500); expect(f.page()).toBe(0)
    f.resize(449); f.flush(); expect(f.page()).toBe(500)
  })
  it('a new gesture or route cancels pending restoration; no delayed stale offset or force-bottom write', () => {
    for (const gesture of ['touchstart', 'wheel', 'keydown']) {
      const f = frame(); f.sync(); f.remember(); f.resize(1019, 250)
      f.emit(gesture); f.ws.scrollTop = 825; f.emit('scroll'); f.writes.length = 0; f.flush()
      expect(f.ws.scrollTop, gesture).toBe(825); expect(f.writes, gesture).toHaveLength(0)
    }
    const f = frame(); f.sync(); f.remember(); f.resize(1019, 250); f.route('messages', ['cos']); f.writes.length = 0; f.flush()
    expect(f.writes).toHaveLength(0); expect(f.classes.has('pg-frame')).toBe(false)
  })
  it('the shared viewportFit rejects a stranded height and stale positive top, using innerHeight from zero', () => {
    const src = APP.slice(APP.indexOf('  function viewportFit() {'), APP.indexOf('  // ── layout breadcrumbs'))
    const fit = new Function('window', 'document', 'vpTyping', 'var VP = { w: 0, maxH: 0, free: 0, typing: false, badReads: 0, badN: 0 }; var VP_SETTLE_MS = 1200, VP_SLACK_PX = 80, VV_MIN_PX = 80; ' + src + '; return viewportFit();')
    for (const height of [0, -33554432, 79]) {
      const v = fit({ innerWidth: 1019, innerHeight: 787, visualViewport: { height, offsetTop: 482.3, scale: 0.85 }, matchMedia: () => ({ matches: true }) }, { documentElement: { clientHeight: 787 } }, () => false)
      expect(v).toMatchObject({ bad: true, top: 0, height: 787, dock: 0 })
    }
  })
  it('a replaced anchor is not restored; at-top stays at-top; authentication drops queued ownership', () => {
    const f = frame(); f.sync(); f.remember(); f.node.isConnected = false; f.resize(1019, 250); f.writes.length = 0; f.flush()
    expect(f.writes).toHaveLength(0)
    const top = frame(); top.ws.scrollTop = 0; top.sync(); top.remember(); top.resize(1019, 250); top.flush(); expect(top.ws.scrollTop).toBe(0)
    const auth = frame(); auth.sync(); auth.remember(); auth.resize(1019, 250); auth.drop(); auth.writes.length = 0; auth.flush(); expect(auth.writes).toHaveLength(0)
    expect(APP).toContain("if (typeof pgPlaceDrop === 'function') pgPlaceDrop();")
  })

  // W1 (F1 12:48: at 449 Running 121 px down, 1019 fine, back at 449 the page sat at its end with Running at -185).
  it('a restore the browser clamps is not taken as his place: the round trip comes back to where he was', () => {
    const f = frame(); f.sync(); f.remember()
    f.resize(1019, 3800); f.flush(); expect(f.ws.scrollTop).toBe(4000)   // asked 4300: clamped at the end
    f.emit('scroll')                                                     // the browser's own scroll for the clamp
    f.resize(449, -3800); f.flush()
    expect(f.ws.scrollTop).toBe(500)                                     // where he was, not 200 from the clamped place
  })
  it('after a restore, his next gesture and scroll take the place again', () => {
    const f = frame(); f.sync(); f.remember(); f.resize(1019, 250); f.flush()
    f.emit('touchstart'); f.emit('touchend'); f.ws.scrollTop = 900; f.emit('scroll')
    expect(f.place.auto).toBe(false)
    expect(f.place.a.node).toBe(f.node); expect(f.place.a.dy).toBe(250)   // taken fresh at 1019 (it was 400 before the fold)
  })
  it('the main column first: the left point down the whole band before the centre (the right column stacks below at 449)', () => {
    const f = frame(); f.sync()
    const left = { isConnected: true, getBoundingClientRect: () => ({ top: 130, height: 24 }) }, right = { isConnected: true, getBoundingClientRect: () => ({ top: 116, height: 24 }) }
    f.pane.contains = (n: unknown) => n === left || n === right
    f.doc.elementFromPoint = (x: number, y: number) => (x < 100 ? (y >= 130 ? left : null) : right)   // the centre hits the right column first
    const a = f.capture({ pane: 'today', args: [] }, true)
    expect(a.node).toBe(left)
  })
  it('never a container taller than half the visible box (the columns, the pane): the next probe, else the pane top', () => {
    const f = frame(); f.sync()
    const big = { isConnected: true, getBoundingClientRect: () => ({ top: 0, height: 3000 }) }, small = { isConnected: true, getBoundingClientRect: () => ({ top: 160, height: 24 }) }
    f.pane.contains = (n: unknown) => n === big || n === small
    f.doc.elementFromPoint = (x: number, y: number) => (x < 100 ? big : y >= 140 ? small : big)
    expect(f.capture({ pane: 'today', args: [] }, true).node).toBe(small)
    f.doc.elementFromPoint = () => big
    expect(f.capture({ pane: 'today', args: [] }, true).node).toBe(f.pane)
  })
  it('a caret whose text is not inside the element hit there, or not on the probe line, is ignored', () => {
    const f = frame(); f.sync()
    const hit = { isConnected: true, contains: () => false, getBoundingClientRect: () => ({ top: 116, height: 24 }) }
    const stray = { nodeType: 3, isConnected: true }
    f.pane.contains = (n: unknown) => n === hit || n === stray
    f.doc.elementFromPoint = () => hit
    f.doc.caretRangeFromPoint = () => ({ startContainer: stray, startOffset: 0 })
    const a = f.capture({ pane: 'today', args: [] }, true)
    expect(a.node).toBe(hit); expect(a.text).toBeUndefined()
  })
  it('a fold with a finger down queues no restore: his own motion owns the place', () => {
    const f = frame(); f.sync(); f.remember(); f.emit('touchstart'); f.writes.length = 0
    f.resize(1019, 250); f.flush()
    expect(f.writes).toHaveLength(0)
  })
  it('a fold during a fling, however long it has run, queues no restore; once the fling has stopped, a fold restores (Codex 12:5x)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const t0 = Date.now(), f = frame(); f.sync(); f.remember(); f.emit('touchstart'); f.emit('touchend')
      for (let ms = 100; ms <= 1200; ms += 100) { vi.setSystemTime(t0 + ms); f.emit('scroll') }   // a 1.2 s fling, a scroll every 100 ms
      vi.setSystemTime(t0 + 1220); f.writes.length = 0
      f.resize(1019, 250); f.flush()
      expect(f.writes).toHaveLength(0)
      const g = frame(); g.sync(); g.remember(); g.emit('touchstart'); g.emit('touchend'); g.emit('scroll')
      vi.setSystemTime(t0 + 5000); g.emit('scroll')            // a gap: the fling is over, this scroll is the browser's or his next
      g.writes.length = 0; g.resize(1019, 250); g.flush()
      expect(g.writes).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
  it('a still page restores on a fold; sign-out or a new route clears the restore mark', () => {
    const g = frame(); g.sync(); g.remember(); g.writes.length = 0
    g.resize(1019, 250); g.flush()
    expect(g.writes).toHaveLength(1); expect(g.place.auto).toBe(true)
    g.drop(); expect(g.place.auto).toBe(false)
  })
})

