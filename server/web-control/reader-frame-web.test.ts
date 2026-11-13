/**
 * 7.0.31 hotfix (Miles 17:25 on the open Duo, message #490): from 600 px the message reader is its own frame. The page
 * is one screen (html.rd-frame), the reader scrolls inside its own box and its Reply box sticks to that box's bottom,
 * so a stale Safari viewport after folds can no longer leave Reply and the rail mid-screen with the message drawn below
 * them. Under 600 px, and on a message's image, nothing changes. These run app.js's own text against fakes and pin the
 * CSS; W1_evidence/7031_hotfix/reader_frame_check.cjs checks the layout in WebKit at seven sizes, light and dark.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes/cos-chat.css'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const SRC = slice(APP, '  function rdFrameOn(r) {', "  // Where the frame's parts sit against the VISIBLE area")

class FakeClass { s = new Set<string>(); toggle(c: string, on?: boolean) { const v = on === undefined ? !this.s.has(c) : on; if (v) this.s.add(c); else this.s.delete(c); return v } contains(c: string) { return this.s.has(c) } add(c: string) { this.s.add(c) } remove(...cs: string[]) { cs.forEach(c => this.s.delete(c)) } }

function kit(o: { wide?: boolean; shellHidden?: boolean; route?: { pane: string; args: string[] }; crumbOk?: boolean; reply?: boolean } = {}) {
  const de: any = { classList: new FakeClass() }
  const mqs: Array<{ q: string; fns: Array<() => void> }> = []
  const frames: Array<() => void> = []
  const crumbs: Array<{ what: string; data: any }> = []
  const box = (t: number, b: number, more: any = {}) => ({ getBoundingClientRect: () => ({ top: t, bottom: b }), ...more })
  let wide = o.wide ?? true
  const win: any = {
    scrollY: 0,
    matchMedia: (q: string) => { const m = { q, fns: [] as Array<() => void> }; mqs.push(m); return { get matches() { return q === '(min-width: 600px)' ? wide : false }, addEventListener: (_t: string, fn: () => void) => m.fns.push(fn) } },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length },
  }
  const deps: any = {
    window: win,
    document: { documentElement: de, scrollingElement: { scrollHeight: 787 }, querySelector: (s: string) => (s === '#pane-messages .cx-reply-form' ? (o.reply === false ? null : box(680, 787)) : s === '#pane-messages > .cx' ? box(62, 787, { clientHeight: 725, scrollHeight: 2142 }) : null) },
    $: (id: string) => (id === 'app-shell' ? { classList: { contains: (c: string) => c === 'hidden' && !!o.shellHidden } } : id === 'workspace' ? { clientHeight: 743, scrollHeight: 2400 } : null),
    parseRoute: () => o.route ?? { pane: 'messages', args: ['m', 'i5'] },
    viewportFit: () => ({ top: 0, height: 787, bad: false }),
    layoutCrumb: (what: string, data: any) => { crumbs.push({ what, data }); return o.crumbOk ?? true },
    lrProbe: () => 787,
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${SRC}\nreturn { on: rdFrameOn, sync: rdFrameSync, crumb: rdFrameCrumb, RD: RD_FRAME };\n}`)(deps)
  return { k, de, mqs, frames, crumbs, setWide: (v: boolean) => { wide = v } }
}

describe('html.rd-frame: on only for a message reader from 600 px', () => {
  it('a message reader at 600 px and wider: on', () => {
    const h = kit()
    expect(h.k.sync({ pane: 'messages', args: ['m', 'i5'] })).toBe(true)
    expect(h.de.classList.contains('rd-frame')).toBe(true)
  })
  it('off, and the class taken away, for: under 600 px, a message image, the list, the archive, other panes, the sign-in gate', () => {
    const cases: Array<[string, any]> = [
      ['under 600 px', { wide: false }],
      ['a message image', { route: { pane: 'messages', args: ['m', 'i5', 'a', 'att1'] } }],
      ['the Messages list', { route: { pane: 'messages', args: [] } }],
      ['the archive', { route: { pane: 'messages', args: ['archive'] } }],
      ['a session reader', { route: { pane: 'sessions', args: ['claude', 'x'] } }],
      ['a meeting', { route: { pane: 'meetings', args: ['m', 'i5'] } }],
      ['the shell hidden (sign-in gate)', { shellHidden: true }],
    ]
    for (const [name, o] of cases) {
      const h = kit(o)
      h.de.classList.add('rd-frame')
      expect(h.k.sync(o.route), name).toBe(false)
      expect(h.de.classList.contains('rd-frame'), name).toBe(false)
    }
  })
  it('crossing 600 px resyncs it from the route, with one listener however often it syncs', () => {
    const h = kit()
    h.k.sync(); h.k.sync(); h.k.sync()
    const six = h.mqs.filter(m => m.q === '(min-width: 600px)' && m.fns.length)
    expect(six, 'one 600 px listener').toHaveLength(1)
    h.setWide(false); six[0].fns[0]()
    expect(h.de.classList.contains('rd-frame'), 'folded under 600: off').toBe(false)
    h.setWide(true); six[0].fns[0]()
    expect(h.de.classList.contains('rd-frame'), 'unfolded: on again').toBe(true)
  })
  it('route() syncs it right after the Sessions frame, with the route it parsed', () => {
    const r = slice(APP, '  function route(forceChanged) {', '    var paneEl')
    expect(r).toContain("    if (typeof sxFrameSync === 'function') sxFrameSync();\n    if (typeof rdFrameSync === 'function') rdFrameSync(r);\n")
  })
  it('showAuth takes it off with the Sessions frame (run on its own text)', () => {
    const AUTH = slice(APP, '  function showAuth(message) {', '  function signedInOnce() {')
    const de: any = { classList: new FakeClass() }
    de.classList.add('rd-frame'); de.classList.add('sx-frame')
    const els: Record<string, any> = {}
    const $ = (id: string) => (els[id] ??= { classList: new FakeClass() })
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${AUTH}\nshowAuth('Signed out');\n}`)({ $, document: { documentElement: de }, readerImagesStop: () => {}, setStatus: () => {}, CONN: {} })
    expect(de.classList.contains('rd-frame')).toBe(false)
    expect(de.classList.contains('sx-frame')).toBe(false)
  })
})

describe('the reader report (lead 17:48): where the box and Reply sit, numbers only, bounded', () => {
  it('one report a frame after a message reader opens, with the box, the reader, the workspace and its content, Reply, the document and 100dvh', () => {
    const h = kit()
    h.k.sync()
    expect(h.crumbs).toHaveLength(0)
    h.frames.forEach(f => f())
    expect(h.crumbs).toHaveLength(1)
    expect(h.crumbs[0]).toEqual({ what: 'reader', data: { why: 'open', frame: true, fb: false, boxT: 0, boxB: 787, rdT: 62, rdB: 787, rdH: 725, wsH: 743, wsSH: 2400,
      replyT: 680, replyB: 787, docH: 787, sy: 0, dvh: 787 } })
    for (const v of Object.values(h.crumbs[0].data)) expect(['number', 'boolean', 'string']).toContain(typeof v)
  })
  it('a reader under 600 px reports too, with frame false; another page never does', () => {
    const narrow = kit({ wide: false })
    narrow.k.sync(); narrow.frames.forEach(f => f())
    expect(narrow.crumbs).toHaveLength(1)
    expect(narrow.crumbs[0].data.frame).toBe(false)
    for (const route of [{ pane: 'messages', args: [] }, { pane: 'messages', args: ['m', 'i5', 'a', 'x'] }, { pane: 'today', args: [] }]) {
      const h = kit({ route })
      h.k.sync(route); h.frames.forEach(f => f())
      expect(h.crumbs, JSON.stringify(route)).toHaveLength(0)
    }
  })
  it('at most 8 a page load', () => {
    const h = kit()
    for (let i = 0; i < 12; i++) h.k.crumb('open')
    expect(h.crumbs).toHaveLength(8)
  })
  it('a report the log refused does not count against the 8', () => {
    const h = kit({ crumbOk: false })
    h.de.classList.add('rd-frame')
    for (let i = 0; i < 12; i++) h.k.crumb('open')
    expect(h.k.RD.n).toBe(0)
  })
  it('the fold report (rail) also carries 100dvh, the number his 17:25 frame was missing', () => {
    expect(slice(APP, '  function railSync() {', '\n  }\n')).toContain("layoutCrumb('rail', { sw: sc.width, sh: sc.height, rail: on, railHit: RAIL.hit, dvh: typeof lrProbe === 'function' ? lrProbe('height:100dvh', 'h') : null });")
  })
})

describe('the frame CSS (panes/cos-chat.css)', () => {
  const block = slice(CSS, '@media (min-width: 600px) {\n  html.rd-frame, html.rd-frame body', '\n}\n')
  it('every html.rd-frame rule is inside the 600 px block: nothing reaches the phone or the folded Duo', () => {
    const outside = CSS.replace(block, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(outside).not.toMatch(/html\.rd-frame/)
  })
  it('the page is one screen: html and body clipped, the shell fixed to the visible box', () => {
    expect(block).toContain('html.rd-frame, html.rd-frame body { height: 100%; overflow: hidden; overscroll-behavior: none; }')
    expect(block).toMatch(/html\.rd-frame \.app-shell \{ position: fixed; left: 0; right: 0; top: var\(--vv-top, 0px\); height: var\(--vv-h, 100dvh\);/)
  })
  it('the rail is a column of the shell (not 100dvh), and the workspace is the one scroller, with no bottom padding', () => {
    expect(block).toContain('html.rd-frame .rail { position: static; top: auto; height: auto; min-height: 0; overflow-y: auto;')
    expect(block).toContain('html.rd-frame .workspace { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 0; }')
    expect(block, 'the notice and the question card scroll with the message, as in 7.0.30').not.toMatch(/#sq-host|#conn-notice|#pane-messages > \.cx \{/)
  })
  it('with the keyboard up the Reply box stays at the frame bottom (the frame is already the visible box)', () => {
    expect(block).toContain('html.rd-frame.kb-reply .cx-reply-form { bottom: 0; }')
  })
  it('contained, not hidden: no z-index in the frame', () => {
    expect(block).not.toMatch(/z-index/)
  })
})

describe('the reading place, ONLY across a fold (lead 20:41): run on its own text', () => {
  const POS = slice(APP, '  var RD_POS_STILL_MS = 300', '  function rdPosHook() {')
  function pos(o: { mode?: 'frame' | 'page'; key?: string; route?: any; rectTop?: number; wsTop?: number } = {}) {
    let now = 10_000, mode = o.mode ?? 'frame'
    const timers: Array<{ fn: () => void; at: number }> = []
    const ws: any = { scrollTop: 500, getBoundingClientRect: () => ({ top: o.wsTop ?? 44 }) }
    const cx: any = { getAttribute: () => o.key ?? 'i5', contains: () => true, querySelector: () => null, getBoundingClientRect: () => ({ top: 0, left: 0, width: 800 }) }
    const node: any = { nodeType: 3, nodeValue: 'Paragraph 26. The price holds', isConnected: true }
    const win: any = { scrollY: 0, scrolls: [] as any[], scrollTo: (_x: number, y: number) => win.scrolls.push(['to', y]), scrollBy: (_x: number, y: number) => win.scrolls.push(['by', y]) }
    const deps: any = {
      window: win, Date: { now: () => now },
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, at: now + ms }); return timers.length },
      getComputedStyle: (e: any) => (e === ws ? { overflowY: mode === 'frame' ? 'auto' : 'visible' } : { display: 'none', position: 'static' }),
      document: { querySelector: (s: string) => (s === '#pane-messages > .cx[data-reader-key]' ? cx : null), createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ top: o.rectTop ?? 300, height: 20, width: 9 }) }) },
      $: (id: string) => (id === 'workspace' ? ws : null),
      parseRoute: () => o.route ?? { pane: 'messages', args: ['m', 'i5'] },
    }
    // eslint-disable-next-line no-new-func
    const k = new Function('deps', `with (deps) {\n${POS}\nreturn { apply: rdPosApply, check: rdPosCheck, tick: rdPosTick, RD: RD_POS, STILL: RD_POS_STILL_MS };\n}`)(deps)
    const advance = (ms: number) => { const end = now + ms; for (;;) { timers.sort((x, y) => x.at - y.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn() } now = end }
    return { k, ws, win, node, advance, setMode: (m: 'frame' | 'page') => { mode = m }, get now() { return now } }
  }
  it('apply, in the frame: the workspace moves by exactly how far the anchored character is from where it was read', () => {
    const h = pos({ rectTop: 300, wsTop: 44 })
    h.k.RD.a = { key: 'i5', node: h.node, offset: 3, dy: 4 }
    expect(h.k.apply()).toBe(true)
    expect(h.ws.scrollTop, '500 + (300 - 44 - 4)').toBe(752)
  })
  it('apply, on the page: the window scrolls by the same difference, measured from the top bars', () => {
    const h = pos({ mode: 'page', rectTop: 300 })
    h.k.RD.a = { key: 'i5', node: h.node, offset: 3, dy: 4 }
    h.k.apply()
    expect(h.win.scrolls).toEqual([['by', 296]])
  })
  it('apply: at the top he stays at the top; another message or a removed line changes nothing', () => {
    const top = pos(); top.k.RD.a = { key: 'i5', atTop: true }; top.k.apply(); expect(top.ws.scrollTop).toBe(0)
    const other = pos({ key: 'i4' }); other.k.RD.a = { key: 'i5', node: other.node, offset: 3, dy: 4 }
    expect(other.k.apply()).toBe(false); expect(other.ws.scrollTop).toBe(500)
    const gone = pos(); gone.node.isConnected = false; gone.k.RD.a = { key: 'i5', node: gone.node, offset: 3, dy: 4 }
    expect(gone.k.apply()).toBe(false); expect(gone.ws.scrollTop).toBe(500)
  })
  it('a switch is only a change of scroller: the same mode, no recorded mode, or another page never starts one', () => {
    const same = pos(); same.k.RD.mode = 'frame'; same.k.check(); expect(same.k.RD.pending).toBe(false)
    const fresh = pos(); fresh.k.RD.mode = ''; fresh.k.check(); expect(fresh.k.RD.pending).toBe(false)
    const other = pos({ route: { pane: 'today', args: [] } }); other.k.RD.mode = 'page'; other.k.check(); expect(other.k.RD.pending).toBe(false)
    const fold = pos(); fold.k.RD.mode = 'page'; fold.k.check(); expect(fold.k.RD.pending).toBe(true)
  })
  it('after a switch with him still: one apply, no sooner than the first tick', () => {
    const h = pos({ rectTop: 300 }); h.k.RD.a = { key: 'i5', node: h.node, offset: 3, dy: 4 }; h.k.RD.mode = 'page'
    h.k.check(); expect(h.ws.scrollTop).toBe(500)
    h.advance(100); expect(h.ws.scrollTop).toBe(752); expect(h.k.RD.pending).toBe(false)
    h.advance(2000); expect(h.ws.scrollTop, 'once only').toBe(752)
  })
  it('a finger down waits, with no movement while it is held; the place comes back once it lifts and the scroll is still', () => {
    const h = pos({ rectTop: 300 }); h.k.RD.a = { key: 'i5', node: h.node, offset: 3, dy: 4 }; h.k.RD.mode = 'page'
    h.k.RD.touching = true; h.k.check(); h.advance(2000); expect(h.ws.scrollTop).toBe(500)
    h.k.RD.touching = false; h.k.RD.scrollAt = h.now; h.advance(h.k.STILL - 50); expect(h.ws.scrollTop).toBe(500)
    h.advance(200); expect(h.ws.scrollTop).toBe(752)
  })
  it('his deliberate scroll before it applies wins: nothing is applied', () => {
    const h = pos({ rectTop: 300 }); h.k.RD.a = { key: 'i5', node: h.node, offset: 3, dy: 4 }; h.k.RD.mode = 'page'
    h.k.RD.touching = true; h.k.check(); h.advance(200); h.k.RD.moved = true; h.k.RD.touching = false; h.advance(2000)
    expect(h.ws.scrollTop).toBe(500); expect(h.k.RD.pending).toBe(false)
  })
  it('the wiring: nothing but a change of scroller restores (no ResizeObserver, no shift check), and his scroll is a moved touch, the wheel or a key', () => {
    const block = slice(APP, '  var RD_POS_STILL_MS = 300', '  // Where the frame')
    expect(block).not.toMatch(/ResizeObserver|cxOff|rdPosSettle/)
    expect(block).toContain("window.addEventListener('resize', rdPosCheck);")
    expect(block).toContain('if (RD_POS.pending && Math.abs(y - RD_POS.ty) > RD_POS_MOVE_PX) RD_POS.moved = true;')
    expect(block).toContain("['wheel', 'keydown'].forEach(function (t) { document.addEventListener(t, function () { if (RD_POS.pending) RD_POS.moved = true; }, o); });")
    const sync = slice(APP, '  function rdFrameSync(r) {', '\n  }\n')
    expect(sync).toContain('    rdPosHook();\n')
    expect(sync).toContain("if (!RD_POS.a || RD_POS.a.key !== key) { RD_POS.pending = false; rdPosCapture(); }")
  })
})
