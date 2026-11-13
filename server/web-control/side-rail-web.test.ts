/**
 * 7.0.29 (Miles 21:39 "These side buttons are a must on the duo"; 21:42 tall phones keep the top menu; 23:36 "build the
 * rail as a private candidate"): the folded Duo's side rail. It is the wide rail's own nav, drawn at the right edge as
 * icons, so these pin: one pane list; the screen-shape test in theme.js, run against fakes for every phone in the brief;
 * the CSS that draws it only under that class, under 600 px, on touch; the 44-point targets under Page Zoom; the top
 * bar's menu going inert and its Back moving to the rail. The layout itself is checked in WebKit with renders:
 * operations/personal/wk46_2026/production_hardening/lanes/W1_evidence/two_column/rail_check.cjs.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')

const PANES = ['today', 'messages', 'speakers', 'meetings', 'memories', 'threads', 'sessions', 'work', 'dictation', 'settings']

describe('one pane list', () => {
  it('the page has one rail, and every pane button in it is the wide rail\'s, in the wide rail\'s order', () => {
    expect(HTML.match(/<nav class="rail"/g)).toHaveLength(1)
    const nav = HTML.slice(HTML.indexOf('<nav class="rail"'), HTML.indexOf('</nav>', HTML.indexOf('<nav class="rail"')))
    expect([...nav.matchAll(/data-pane="([a-z]+)"/g)].map(m => m[1])).toEqual(PANES)
    // No pane button anywhere else in the page: the section menu (data-goto) is the only other place panes are named.
    expect([...HTML.matchAll(/data-pane="([a-z]+)"/g)].map(m => m[1])).toEqual(PANES)
  })
  it('the section menu names the same panes in the same order (it is closed and unreachable while the side rail shows)', () => {
    const menu = HTML.slice(HTML.indexOf('<div id="section-menu"'), HTML.indexOf('<div id="ask-sheet"'))
    expect([...menu.matchAll(/data-goto="([a-z]+)"/g)].map(m => m[1])).toEqual(PANES)
  })
  it('the side rail is drawn from that nav, never built: no script makes pane buttons', () => {
    const block = sideBlock()
    expect(block).toContain('html.short-screen .rail {')
    expect(block).toContain('html.short-screen .rail-btn, html.short-screen .rail-settings {')
    expect(APP).not.toMatch(/rail-btn['"]\s*[;,)]|className\s*=\s*['"][^'"]*rail-btn/)
  })
})

// theme.js's screen test, run against fakes.
const SHAPE = (() => { const a = THEME.indexOf('/* 7.0.29 (Miles 21:42)'); expect(a).toBeGreaterThan(-1); const s = THEME.indexOf('(function () {', a); return THEME.slice(s, THEME.indexOf('})();', s) + 5) })()
function shapeKit(screen: unknown) {
  const cls = new Set<string>(), listeners: Record<string, Array<() => void>> = {}
  const window: any = { screen, addEventListener: (t: string, f: () => void) => { (listeners[t] = listeners[t] || []).push(f) } }
  const document = { documentElement: { classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', SHAPE)(window, document)
  return { window, cls, listeners, on: () => cls.has('short-screen') }
}
function shape(screen: unknown) { return shapeKit(screen).on() }
describe("theme.js: which screens are short (the rail's first condition)", () => {
  it('the folded Duo is short, as the phone reports it at 85 and 100 percent, and turned sideways', () => {
    expect(shape({ width: 466, height: 678 })).toBe(true)
    expect(shape({ width: 678, height: 466 })).toBe(true)
  })
  it('no iPhone is: SE and 8 Plus (16:9), 16, Pro Max, mini; the screen does not change in a Safari tab, so neither does the answer', () => {
    for (const [w, h] of [[375, 667], [414, 736], [393, 852], [430, 932], [375, 812], [440, 956]]) expect(shape({ width: w, height: h }), `${w}x${h}`).toBe(false)
  })
  it('a tablet or a computer screen is not (short side 600 or more), whatever its shape', () => {
    for (const [w, h] of [[1512, 982], [1920, 1080], [820, 1180], [744, 1133], [600, 700]]) expect(shape({ width: w, height: h }), `${w}x${h}`).toBe(false)
  })
  it('cannot decide, no class: no screen, zero, or numbers that are not numbers', () => {
    for (const s of [undefined, null, {}, { width: 0, height: 678 }, { width: 466, height: 0 }, { width: NaN, height: 678 }, { width: 'x', height: 678 }, { width: Infinity, height: 678 }, { width: -466, height: 678 }]) expect(shape(s), JSON.stringify(s)).toBe(false)
  })
  it('worked out again on every resize and orientation change, from the one function (load open, then fold)', () => {
    const k = shapeKit({ width: 1119, height: 787 })
    expect(k.on()).toBe(false)
    expect(k.listeners.resize).toHaveLength(1)
    expect(k.listeners.orientationchange).toHaveLength(1)
    expect(k.listeners.resize![0]).toBe(k.window.CosShortScreen)
    k.window.screen = { width: 466, height: 678 }
    k.listeners.resize![0]!()
    expect(k.on(), 'folded: the class comes on without a reload').toBe(true)
    k.window.screen = { width: 393, height: 852 }
    k.listeners.orientationchange![0]!()
    expect(k.on(), 'and goes off again').toBe(false)
    k.window.screen = undefined
    expect(k.window.CosShortScreen()).toBe(false)
  })
  it('its comment says what was measured and what is assumed, not the other way round', () => {
    expect(THEME).toContain('MEASURED:')
    expect(THEME).toContain('ASSUMED, not measured:')
    expect(THEME).not.toContain('the Duo reports 466 by 678 at 85 and 100 percent, folded and open')
  })
  it('the line is 1.6: the Duo (1.46) is under it, a 16:9 phone (1.78) is over it', () => {
    expect(shape({ width: 500, height: 799 })).toBe(true)
    expect(shape({ width: 500, height: 800 })).toBe(false)
  })
})

function sideBlock() {
  const a = CSS.indexOf("/* ── 7.0.29: the folded Duo's side rail")
  expect(a).toBeGreaterThan(-1)
  return CSS.slice(a)
}
describe('app.css: the side rail is drawn only on a short screen, under 600 px, on touch', () => {
  it('every rule but the default-off Back sits in the one media block, and every selector in it starts with html.short-screen', () => {
    const block = sideBlock()
    const mq = '@media (max-width: 599px) and (pointer: coarse) {'
    expect(block.split(mq)).toHaveLength(2)
    const before = block.slice(0, block.indexOf(mq)).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    expect(before).toBe('.rail-back { display: none; }')
    const inner = block.slice(block.indexOf(mq) + mq.length).replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...inner.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(15)
    for (const sel of selectors) for (const part of sel.split(',')) expect(part.trim(), sel).toMatch(/^html\.short-screen([.\s]|$)/)
  })
  it('the media query is the one app.js reads, so the CSS and the script never disagree', () => {
    expect(APP).toContain("var SIDE_RAIL_MQ = '(max-width: 599px) and (pointer: coarse)';")
    expect(sideBlock()).toContain('@media (max-width: 599px) and (pointer: coarse) {')
  })
  it('the pane menu loses its caret while the rail shows; the top bar keeps its named Back on a reader (7.0.33 A12)', () => {
    expect(sideBlock()).toContain('html.short-screen .section-btn .caret { display: none !important; }')
    expect(sideBlock()).not.toContain('#topbar-back { display: none')
  })
  it('no new colours: every colour in the block is a theme token (the one shadow is the wide rail\'s own)', () => {
    const inner = sideBlock().replace(/\/\*[\s\S]*?\*\//g, '')
    expect(inner.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull()
    expect(inner.match(/rgba?\(/g)).toHaveLength(1)
    expect(CSS).toContain(".rail-btn[aria-current='page'] { background: var(--rail-active); color: var(--ink); box-shadow: 0 1px 2px rgba(43, 33, 26, 0.08); }")
    expect(inner).toContain("background: var(--rail-active); color: var(--ink); box-shadow: 0 1px 2px rgba(43, 33, 26, 0.08); }")
  })
  it('targets are --rail-hit both ways, Back too; the focus ring is the theme\'s accent, inside the button', () => {
    const inner = sideBlock()
    expect(inner.match(/width: var\(--rail-hit, 52px\); height: var\(--rail-hit, 52px\);/g)).toHaveLength(2)
    expect(inner).toContain('html.short-screen .rail :focus-visible { outline: 2px solid var(--accent); outline-offset: -4px; border-radius: 12px; }')
  })
})

// app.js's block, run against fakes.
const RAILJS = (() => { const a = APP.indexOf("  // 7.0.29: the folded Duo's side rail"), b = APP.indexOf('  /** A keyboard and a fine pointer'); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return APP.slice(a, b) })()
function rail(o: { short?: boolean; narrowTouch?: boolean; scale?: number | null; cw?: number } = {}) {
  const props: Record<string, string> = {}, listeners: Record<string, Array<() => void>> = {}, mqListeners: Array<() => void> = []
  const attrs: Record<string, string> = { 'aria-haspopup': 'dialog' }
  const btn = { inert: false, setAttribute: (k: string, v: string) => { attrs[k] = v }, removeAttribute: (k: string) => { delete attrs[k] } }
  let menuClosed = 0, shapeCalls = 0
  const env = { short: o.short ?? true, narrowTouch: o.narrowTouch ?? true, cw: o.cw ?? 449, scale: o.scale === undefined ? 0.85 : o.scale }
  const document = { documentElement: { get clientWidth() { return env.cw }, classList: { contains: (c: string) => c === 'short-screen' && env.short }, style: { setProperty: (k: string, v: string) => { props[k] = v } } } }
  const crumbs: Array<{ what: string; data: any }> = []
  const window: any = {
    screen: { width: 466, height: 678 },
    CosShortScreen: () => { shapeCalls++ },
    get visualViewport() { return env.scale === null ? undefined : { scale: env.scale } },
    matchMedia: (q: string) => ({ get matches() { return q === '(max-width: 599px) and (pointer: coarse)' ? env.narrowTouch : false }, addEventListener: (_t: string, f: () => void) => mqListeners.push(f) }),
    addEventListener: (t: string, f: () => void) => { (listeners[t] = listeners[t] || []).push(f) },
  }
  const $ = (id: string) => (id === 'section-btn' ? btn : null)
  // eslint-disable-next-line no-new-func
  const fns = new Function('window', 'document', '$', 'closeMenu', 'layoutCrumb', `${RAILJS}\nreturn { sideRail, railHitSync, railSync, RAIL };`)(window, document, $, () => { menuClosed++ }, (what: string, data: any) => { crumbs.push({ what, data }) })
  return { fns, env, props, attrs, btn, listeners, mqListeners, crumbs, get menuClosed() { return menuClosed }, get shapeCalls() { return shapeCalls } }
}

describe('app.js: when the rail is on', () => {
  it('only with both: a short screen AND the narrow touch media query', () => {
    expect(rail().fns.sideRail()).toBe(true)
    expect(rail({ short: false }).fns.sideRail()).toBe(false)
    expect(rail({ narrowTouch: false }).fns.sideRail()).toBe(false)
  })
  it('the section button goes inert and loses its menu; turned back on when the rail goes (rotation)', () => {
    const h = rail()
    h.fns.railSync()
    expect(h.btn.inert).toBe(true)
    expect(h.attrs['aria-haspopup']).toBeUndefined()
    expect(h.menuClosed).toBe(1)
    h.env.narrowTouch = false
    h.mqListeners.forEach(f => f())
    expect(h.btn.inert).toBe(false)
    expect(h.attrs['aria-haspopup']).toBe('dialog')
  })
  it('a resize or an orientation change runs the screen test again, then the rail; a change after boot is reported once with the screen numbers', () => {
    const h = rail({ short: false })
    h.fns.railSync()
    expect(h.shapeCalls).toBe(1)
    expect(h.crumbs, 'boot is the device report\'s, not this one').toHaveLength(0)
    h.env.short = true
    h.listeners.resize!.forEach(f => f())
    expect(h.shapeCalls).toBe(2)
    expect(h.btn.inert).toBe(true)
    // 7.0.31: the fold report also carries 100dvh (app.js lrProbe; this harness has none, so null), the number Miles's
    // 17:25 open-Duo frame was missing.
    expect(h.crumbs).toEqual([{ what: 'rail', data: { sw: 466, sh: 678, rail: true, railHit: 52, dvh: null } }])
    h.listeners.orientationchange!.forEach(f => f())
    expect(h.crumbs, 'no change, no report').toHaveLength(1)
    h.env.short = false
    h.listeners.orientationchange!.forEach(f => f())
    expect(h.btn.inert).toBe(false)
    expect(h.crumbs.map(c => c.data.rail)).toEqual([true, false])
  })
  it('without the rail nothing changes: the button keeps its menu and no size is set', () => {
    const h = rail({ short: false })
    h.fns.railSync()
    expect(h.btn.inert).toBe(false)
    expect(h.attrs['aria-haspopup']).toBe('dialog')
    expect(h.props['--rail-hit']).toBeUndefined()
  })
  it('openMenu does nothing while the rail shows', () => {
    expect(APP).toContain("function openMenu() { if (sideRail()) return; $('section-menu').classList.remove('hidden');")
  })
})

describe('app.js: 44 points on the phone', () => {
  it('52 px at Safari\'s 85 percent Page Zoom (44.2 points), 44 px at 100, 88 at 50 percent, the lowest', () => {
    const at = (scale: number | null) => { const h = rail({ scale }); h.fns.railSync(); return h.props['--rail-hit'] }
    expect(at(0.85)).toBe('52px')
    expect(at(1)).toBe('44px')
    expect(at(0.75)).toBe('59px')
    expect(at(0.5)).toBe('88px')
    expect(at(0.4)).toBe('44px')   // not a Page Zoom anyone sets: read as 1
    expect(at(1.6)).toBe('44px')   // zoomed in: 44 px is more than 44 points already
    expect(at(null)).toBe('44px')  // no visualViewport
    for (const s of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1]) { const px = parseInt(at(s)!, 10); expect(px * s, String(s)).toBeGreaterThanOrEqual(44) }
  })
  it('a pinch does not resize the rail; a rotation (a new layout width) does', () => {
    const h = rail({ scale: 0.85 })
    h.fns.railSync()
    h.env.scale = 1
    h.listeners.resize!.forEach(f => f())
    expect(h.props['--rail-hit']).toBe('52px')
    h.env.cw = 797
    h.listeners.resize!.forEach(f => f())
    expect(h.props['--rail-hit']).toBe('44px')
  })
})

describe('Back at thumb height', () => {
  it('the rail has its own Back, hidden by default, named, with the back icon', () => {
    expect(HTML).toContain('<button type="button" class="rail-back" id="rail-back" aria-label="Back" hidden><svg class="icon"><use href="#i-back"/></svg></button>')
    expect(HTML.indexOf('id="rail-back"')).toBeGreaterThan(HTML.indexOf('<nav class="rail"'))
    expect(HTML.indexOf('id="rail-back"')).toBeLessThan(HTML.indexOf('</nav>', HTML.indexOf('<nav class="rail"')))
  })
  it('it shows exactly where the top bar shows Back (a reader), and calls the same goBack', () => {
    expect(APP).toContain("$('topbar-back').classList.toggle('hidden', !reading);\n    var railBack = $('rail-back');\n    if (railBack) railBack.hidden = !reading;")
    expect(APP).toContain("#topbar-back,#rail-back,#section-btn,")
    expect(APP).toContain("    if (t.id === 'topbar-back') return goBack();\n    if (t.id === 'rail-back') return goBack();")
  })
  it('boot sets the rail up before the shell shows, and the device report says whether it showed and how big', () => {
    expect(APP).toContain("  function boot() {\n    if (typeof railSync === 'function') railSync();")
    expect(APP).toContain("rail: typeof sideRail === 'function' ? sideRail() : false, railHit: typeof RAIL === 'object' ? RAIL.hit : 0, phone: isPhone(),")
  })
})

// F3 (lead 00:35): Back sits level with Send, so words in the reply box must survive Back. The behaviour is checked in
// WebKit (back_words_check.cjs: kept after Back and after another pane; sent words never come back; 3 of 3 mutants
// killed); these pin the four places it hangs on.
describe('F3: unsent words in the reply box survive leaving the session', () => {
  it('saved as he types, restored when the session opens again, re-saved when a refusal puts words back, dropped when sent', () => {
    expect(APP).toContain("    if (e.target.id === 'session-input' && typeof unsentSave === 'function') unsentSave();")
    expect(APP).toContain("      readerImagesMount($('session-turns'), r);\n      if (typeof unsentRestore === 'function') unsentRestore(r);")
    expect(APP).toContain("input.value = text; autoGrow(input); if (typeof unsentSave === 'function') unsentSave(); sessionStatus(why + ' Your message is back in the box.'")
    expect(APP).toContain("  function clearBoxOf(text, r) {\n    if (typeof unsentDrop === 'function') unsentDrop(text, r || state.reading);")
  })
})

// F2 (lead 00:35): with the rail at 382 px the reply box's words wrapped and the second line was cut. Measured in WebKit
// (rail_check.cjs R10 at every size and view, keyboard up too); these pin how it is done.
describe('F2: the reply box never cuts its placeholder', () => {
  it('the long words are kept where they fit; where they would wrap the box says the short form', () => {
    expect(APP).toContain("box.phShort = open && !te ? 'Message (not an answer)' : '';")
    expect(APP).toContain("if (box.phShort) { var one = placeholderHeight(box, 'M'), two = placeholderHeight(box, box.phLong); if (one > 0 && two > one + 2) ph = box.phShort; }")
  })
  it('an empty box is as tall as its placeholder, measured in a hidden copy (the box itself is never written to)', () => {
    expect(APP).toContain("if (!ta.value && ta.id === 'session-input' && ta.placeholder) h = Math.max(h, placeholderHeight(ta, ta.placeholder));")
    const fn = APP.slice(APP.indexOf('  function placeholderHeight(ta, text) {'), APP.indexOf('  }\n', APP.indexOf('  function placeholderHeight(ta, text) {')))
    expect(fn).toContain('c.value = text;')
    expect(fn).not.toMatch(/ta\.value\s*=/)
  })
  it('a width change (the rail coming or going, a rotation) fits it again', () => {
    expect(APP).toContain("if (si && typeof sxPlaceholderFit === 'function' && si.phLong) sxPlaceholderFit(si);")
  })
})

// R4 (Q1 Note 1): words belong to the session they were typed in. Run against fakes: two sessions, A and B.
describe('R4: unsent words and returned words stay with their own session', () => {
  const UNSENT = (() => { const a = APP.indexOf('  var SX_UNSENT = {};'), b = APP.indexOf('  // Your words show in the conversation the moment'); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return APP.slice(a, b) })()
  function two() {
    const A = { provider: 'claude', id: 'aaa' }, B = { provider: 'claude', id: 'bbb' }
    const box = { value: '' }, status: string[] = []
    const deps: any = { state: { reading: A }, $: (id: string) => (id === 'session-input' ? box : null), autoGrow: () => {}, turnEndBare: (t: string) => String(t).trim(), sessionStatus: (t: string) => { status.push(t) } }
    // eslint-disable-next-line no-new-func
    const f = new Function('deps', `with (deps) {\n${UNSENT}\nreturn { SX_UNSENT, unsentSave, unsentRestore, unsentDrop, clearBoxOf, returnToBox };\n}`)(deps)
    const open = (r: any) => { deps.state.reading = r; box.value = ''; f.unsentRestore(r) }
    return { A, B, box, status, deps, f, open }
  }
  it('words sent from A drop only A’s saved words; B’s identical words stay', () => {
    const h = two()
    h.box.value = 'ship it'; h.f.unsentSave()
    h.open(h.B); h.box.value = 'ship it'; h.f.unsentSave()
    h.f.unsentDrop('ship it', h.A)
    expect(Object.keys(h.f.SX_UNSENT)).toEqual(['claude|bbb'])
    h.f.unsentDrop('ship it', null)
    expect(Object.keys(h.f.SX_UNSENT), 'no session named: nothing dropped').toEqual(['claude|bbb'])
  })
  it('a send from A that lands while B is open never clears B’s box', () => {
    const h = two()
    h.open(h.B); h.box.value = 'ship it'
    h.f.clearBoxOf('ship it', h.A)
    expect(h.box.value).toBe('ship it')
    h.f.clearBoxOf('ship it', h.B)
    expect(h.box.value).toBe('')
  })
  it('a held message from A that comes back while B is open goes to A’s saved words, not into B’s box; A shows it when opened', () => {
    const h = two()
    h.open(h.B)
    h.f.returnToBox('the held words', 'Not sent.', '', h.A)
    expect(h.box.value).toBe('')
    expect(h.status, 'nothing is said on B').toEqual([])
    expect(h.f.SX_UNSENT['claude|aaa']).toBe('the held words')
    h.open(h.A)
    expect(h.box.value).toBe('the held words')
  })
  it('words A already had saved are kept, with the returned words after them', () => {
    const h = two()
    h.box.value = 'typed later'; h.f.unsentSave()
    h.open(h.B)
    h.f.returnToBox('the held words', 'Not sent.', '', h.A)
    expect(h.f.SX_UNSENT['claude|aaa']).toBe('typed later\n\nthe held words')
  })
  it('with A open, the words go back in its box and are saved under A, as before', () => {
    const h = two()
    h.f.returnToBox('the held words', 'Not sent.', '', h.A)
    expect(h.box.value).toBe('the held words')
    expect(h.f.SX_UNSENT['claude|aaa']).toBe('the held words')
    expect(h.status[0]).toContain('Your message is back in the box.')
  })
  it('every caller names the session', () => {
    expect(APP).toContain('    clear: function (r, text) { clearBoxOf(text, r); },')
    expect(APP).toContain('    clearBoxOf(draft.text, r);\n    sessionStatus(\'COS is still answering.')
    expect(APP).toContain("returnToBox(h.text, how === 'cancelled' ? 'Not sent.' : copy || 'Not sent.', heldFilesBack(r, h), r);")
    expect(APP).toContain('r.forkDraft = null; clearBoxOf(text, r);')
  })
})
