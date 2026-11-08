/**
 * 7.0.2 "Duo Build A" (the Duo design audit, 11/07): Control Web on Miles's iPhone Duo in Comet, at the sizes the phone
 * itself reported: 382x557 folded, 951x539 unfolded landscape. Each piece runs from the shipped file itself (app.js,
 * panes/cos-chat.js, panes/messages.js) in a vm or a Function with a fake window, never re-implemented here; the
 * stylesheet facts are read from the CSS. Nothing here reaches a server.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const APP = read('app.js')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const VP_SRC = slice(APP, '  var VP = { layoutH: 0 };', '  // ── layout breadcrumbs')
const LR_SRC = slice(APP, '  // ── layout reports and the visible box, every pane (7.0.2) ──', '  // ── end layout reports')

// ── the fake page ───────────────────────────────────────────────────────────────────────────────────────────────────
type Crumb = { what: string; data: Record<string, any> }
function page(o: { w: number; h: number; route?: { pane: string; args: string[] }; scrollH?: number; fine?: boolean }) {
  const clock = { t: 1_000_000 }
  const winListeners: Record<string, Array<() => void>> = {}, docListeners: Record<string, Array<(e?: any) => void>> = {}, vvListeners: Record<string, Array<() => void>> = {}
  const frames: Array<() => void> = [], timers: Array<{ fn: () => void; ms: number }> = []
  const props: Record<string, string> = {}, cls = new Set<string>(), writes = { n: 0 }
  const vv: any = { height: o.h, width: o.w, offsetTop: 0, scale: 1, addEventListener: (t: string, fn: () => void) => { (vvListeners[t] ??= []).push(fn) } }
  const se: any = { scrollHeight: o.scrollH ?? o.h, clientHeight: o.h, scrollWidth: o.w }
  const window: any = { innerWidth: o.w, innerHeight: o.h, outerHeight: o.h, outerWidth: o.w, scrollY: 0, devicePixelRatio: 3, visualViewport: vv,
    screen: { width: 382, height: 873, availHeight: 873, orientation: { type: o.w > o.h ? 'landscape-secondary' : 'portrait-primary' } },
    matchMedia: (q: string) => ({ matches: o.fine ? false : /coarse/.test(q) && !/max-height/.test(q) ? true : /max-height: 720px/.test(q) ? window.innerHeight <= 720 && /coarse/.test(q) : false }),
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length },
    addEventListener: (t: string, fn: () => void) => { (winListeners[t] ??= []).push(fn) },
    scrollTo: (_x: number, y: number) => { window.scrollY = y },
    COSWeb: {} }
  const body: any = { appendChild: () => {}, removeChild: () => {} }
  const document: any = { activeElement: body, body, scrollingElement: se,
    documentElement: { clientHeight: o.h, style: { setProperty: (k: string, v: string) => { props[k] = v; writes.n++ } }, classList: { toggle: (c: string, on: boolean) => { if (on) cls.add(c); else cls.delete(c) } } },
    createElement: () => { const el: any = { style: { cssText: '' }, setAttribute: () => {} }; Object.defineProperty(el, 'offsetHeight', { get: () => (/100dvh/.test(el.style.cssText) ? window.innerHeight : /100svh/.test(el.style.cssText) ? 266 : /100lvh/.test(el.style.cssText) ? 557 : 0) }); return el },
    addEventListener: (t: string, fn: (e?: any) => void) => { (docListeners[t] ??= []).push(fn) } }
  const getComputedStyle = (el: any) => ({ fontSize: el.fs ?? '16px', paddingTop: /safe-area-inset-top/.test(el.style?.cssText || '') ? '47px' : '0px', paddingBottom: /safe-area-inset-bottom/.test(el.style?.cssText || '') ? '34px' : '0px' })
  const crumbs: Crumb[] = []
  const shellHooks: Array<() => void> = []
  const route = o.route ?? { pane: 'messages', args: ['cos'] }
  // eslint-disable-next-line no-new-func
  const kit = new Function('window', 'document', 'layoutCrumb', 'parseRoute', 'isPhone', 'SHORT_TOUCH_MQ', 'shellHooks', 'setTimeout', 'clearTimeout', 'getComputedStyle', 'console', 'Date',
    VP_SRC + LR_SRC + '\nreturn { LR: LR, viewportFit: viewportFit };')(window, document, (what: string, data: any) => { crumbs.push({ what, data }); return true }, () => route,
    () => window.innerWidth < 600, '(pointer: coarse) and (max-height: 720px)', shellHooks,
    (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, () => {}, getComputedStyle, console, { now: () => clock.t })
  const runFrames = () => { while (frames.length) frames.shift()!() }
  const runTimers = () => { while (timers.length) timers.shift()!.fn() }
  const form: any = { bottom: o.h, getBoundingClientRect: () => ({ bottom: form.bottom }) }
  const field: any = { tagName: 'TEXTAREA', fs: '16px', closest: (sel: string) => (sel === 'form' ? form : null), getBoundingClientRect: () => ({ bottom: form.bottom - 60 }) }
  const focus = (el: any = field) => { document.activeElement = el; (docListeners.focusin || []).forEach(fn => fn({ target: el })); runFrames() }
  const blur = () => { document.activeElement = body; (docListeners.focusout || []).forEach(fn => fn({})); runTimers(); runFrames() }
  const resize = (vh: number, ih = window.innerHeight, top = 0) => { Object.assign(vv, { height: vh, offsetTop: top }); window.innerHeight = ih; (vvListeners.resize || []).forEach(fn => fn()); runFrames() }
  return { clock, kit, window, document, crumbs, props, cls, writes, shellHooks, runFrames, runTimers, timers, focus, blur, resize, form, field, se, vv, docListeners }
}

// ── A3: viewportFit sees the keyboard whether or not the web view shrinks ──────────────────────────────────────────
describe('7.0.2 A3: viewportFit, layoutH is the largest unzoomed innerHeight at this width (width only, never the orientation type) while typing on touch', () => {
  it('RS (the web view shrinks with the keyboard, folded 382x557): a typing field focused, the keyboard is the inset; dock is 0', () => {
    const p = page({ w: 382, h: 557 })
    p.document.activeElement = p.field
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 0 })
    Object.assign(p.vv, { height: 266 }); p.window.innerHeight = 266
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 291, top: 0, height: 266, below: 291, dock: 0 })
  })
  it('VV (only visualViewport shrinks): the same inset, and dock is the layout viewport under the visible box', () => {
    const p = page({ w: 382, h: 557 })
    p.document.activeElement = p.field
    p.kit.viewportFit()
    Object.assign(p.vv, { height: 266, offsetTop: 40 })
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 291, top: 40, height: 266, dock: 251 })
  })
  it('no typing field: innerHeight is followed as before, so a browser bar that comes and goes is never a keyboard', () => {
    const p = page({ w: 382, h: 557 })
    p.kit.viewportFit()
    Object.assign(p.vv, { height: 480 }); p.window.innerHeight = 480
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 480, inset: 0 })
  })
  it('the keyboard making the web view wider than tall (382x266) is still a keyboard, even where the orientation type flips with it', () => {
    const p = page({ w: 382, h: 557 })
    p.document.activeElement = p.field
    p.kit.viewportFit()
    Object.assign(p.vv, { height: 266 }); p.window.innerHeight = 266; p.window.screen.orientation.type = 'landscape-primary'
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 291 })
  })
  it('a new width (a turn) starts over: turned with the keyboard up, the old portrait height is not the layout height', () => {
    const p = page({ w: 382, h: 557 })
    p.document.activeElement = p.field
    p.kit.viewportFit()
    Object.assign(p.vv, { height: 182 }); Object.assign(p.window, { innerWidth: 557, innerHeight: 182 }); p.window.screen.orientation.type = 'landscape-primary'
    expect(p.kit.viewportFit().layoutH, 'starts from what the turned screen reports').toBe(182)
    Object.assign(p.vv, { height: 382 }); p.window.innerHeight = 382
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 382, inset: 0 })
  })
  it('pinch zoom still keeps the height read before the zoom', () => {
    const p = page({ w: 382, h: 557 })
    p.kit.viewportFit()
    Object.assign(p.vv, { height: 557 / 2, scale: 2, offsetTop: 100 }); p.window.innerHeight = 300
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 0, zoomed: true })
  })
  it('QA W1: a browser bar that collapses and comes back while typing never reads as a keyboard (capped at the unfocused height + 20)', () => {
    const p = page({ w: 382, h: 664 })
    p.kit.viewportFit()                                         // unfocused: 664 with the bar shown
    p.document.activeElement = p.field
    Object.assign(p.vv, { height: 745 }); p.window.innerHeight = 745
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 745, inset: 0 })   // never under innerHeight itself
    Object.assign(p.vv, { height: 664 }); p.window.innerHeight = 664      // the bar comes back, no keyboard
    const v = p.kit.viewportFit()
    expect(v.layoutH).toBe(684)
    expect(v.inset, 'at most the 20 px of slack, under any strip or keyboard threshold').toBeLessThanOrEqual(20)
  })
  it('QA W2: a refocus while the keyboard is still closing starts from the full height, not the half-closed one', () => {
    const p = page({ w: 382, h: 557 })
    p.kit.viewportFit()
    p.document.activeElement = p.field
    Object.assign(p.vv, { height: 266 }); p.window.innerHeight = 266
    expect(p.kit.viewportFit().inset).toBe(291)
    p.document.activeElement = p.document.body                  // blur: the web view grows back in steps
    p.clock.t += 50; Object.assign(p.vv, { height: 400 }); p.window.innerHeight = 400
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 400, inset: 0 })
    p.clock.t += 50; p.document.activeElement = p.field          // refocus mid-close
    Object.assign(p.vv, { height: 266 }); p.window.innerHeight = 266
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 557, inset: 291 })
  })
  it('QA W2: after the settle time, a shorter unfocused height is the new full height (a bar that stayed)', () => {
    const p = page({ w: 382, h: 557 })
    p.kit.viewportFit()
    p.document.activeElement = p.field; p.kit.viewportFit()
    p.document.activeElement = p.document.body; p.kit.viewportFit()
    p.clock.t += 5000; Object.assign(p.vv, { height: 500 }); p.window.innerHeight = 500
    p.kit.viewportFit()
    p.document.activeElement = p.field
    Object.assign(p.vv, { height: 260 }); p.window.innerHeight = 260
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 500, inset: 240 })
  })
  it('QA N3: a fine pointer (a Mac window resized or DevTools docked while typing) follows innerHeight: no keyboard, no kb-up', () => {
    const p = page({ w: 1200, h: 800, fine: true })
    p.focus()
    p.resize(600, 600)
    expect(p.kit.viewportFit()).toMatchObject({ layoutH: 600, inset: 0 })
    expect(p.cls.has('kb-up')).toBe(false)
    expect(p.crumbs.filter(c => c.what === 'kb-open')).toHaveLength(0)
  })
  it('QA W7: a select is not typing: opening the Model picker never counts as a keyboard', () => {
    const p = page({ w: 382, h: 557 })
    p.focus({ tagName: 'SELECT' })
    p.resize(266, 266)
    expect(p.kit.viewportFit().inset).toBe(0)
    expect(p.cls.has('kb-up')).toBe(false)
  })
})

// ── A1: layout reports on every pane ──────────────────────────────────────────────────────────────────────────────
describe('7.0.2 A1: layout reports from every pane, numbers and fixed labels only', () => {
  it('device: once per load, after sign-in, with the screen, pixel ratio, safe areas and pointer kind', () => {
    const p = page({ w: 382, h: 557 })
    expect(p.crumbs).toHaveLength(0)
    p.shellHooks.forEach(fn => fn()); p.shellHooks.forEach(fn => fn())
    const dev = p.crumbs.filter(c => c.what === 'device')
    expect(dev).toHaveLength(1)
    expect(dev[0]!.data).toMatchObject({ sw: 382, sh: 873, sah: 873, oh: 557, dpr: 3, sat: 47, sab: 34, anyCoarse: true, shortTouch: true, phone: true })
  })
  it('focus on any pane: the pane, the field kind, its computed font size, scrollY, the scroll range and scrollWidth', () => {
    const p = page({ w: 951, h: 539, route: { pane: 'sessions', args: [] }, scrollH: 1200 })
    p.window.scrollY = 40; p.field.fs = '16px'
    p.focus()
    expect(p.crumbs[0]).toMatchObject({ what: 'focus', data: { pane: 'sessions', field: 'textarea', fs: 16, sy: 40, smax: 661, scw: 951, kb: false, n: 1 } })
    expect(p.crumbs[0]!.data.sw, 'sw is the device line’s screen width, never this').toBeUndefined()
    p.focus({ tagName: 'INPUT', type: 'search', fs: '15px' })
    expect(p.crumbs[1]).toMatchObject({ what: 'focus', data: { field: 'input.search', fs: 15, n: 2 } })
    p.focus({ tagName: 'BUTTON' })
    expect(p.crumbs.filter(c => c.what === 'focus'), 'a button is not a typing field').toHaveLength(2)
    for (const c of p.crumbs) for (const v of Object.values(c.data)) expect(['number', 'boolean', 'string'].includes(typeof v) || v === null).toBe(true)
  })
  it('RS keyboard on the COS chat: kb-open says the web view shrank, html.kb-up and --vv-* are published, close and after follow', () => {
    const p = page({ w: 382, h: 557, scrollH: 900 })
    const heard: string[] = []
    p.window.COSWeb.onKeyboard((what: string) => heard.push(what))
    p.focus()
    p.resize(266, 266)
    const open = p.crumbs.find(c => c.what === 'kb-open')!
    expect(open.data).toMatchObject({ pane: 'messages.cos', n: 1, inset: 291, lh: 557, h: 266, dock: 0, shrank: true })
    expect(p.cls.has('kb-up')).toBe(true)
    expect(p.props).toMatchObject({ '--vv-top': '0px', '--vv-h': '266px', '--vv-below': '0px' })
    expect(p.window.COSWeb.keyboardUp()).toBe(true)
    p.window.scrollY = 400
    p.form.bottom = 450
    p.resize(557, 557)
    expect(p.crumbs.find(c => c.what === 'kb-close')!.data).toMatchObject({ n: 2, inset: 0, shrank: false })
    expect(p.cls.has('kb-up')).toBe(false)
    expect(p.crumbs.filter(c => c.what === 'kb-after'), 'not until the keyboard has had time to go').toHaveLength(0)
    expect(p.timers.map(t => t.ms)).toEqual([300])
    p.runTimers()
    const after = p.crumbs.find(c => c.what === 'kb-after')!
    expect(after.data).toMatchObject({ pane: 'messages.cos', n: 2, gap: 107, sy: 400, smax: 343, over: true, dvh: 557, svh: 266, lvh: 557, lh: 557 })
    expect(heard).toEqual(['open', 'close', 'after'])
  })
  it('VV keyboard: shrank is false and --vv-below is what lies under the visible box', () => {
    const p = page({ w: 382, h: 557 })
    p.focus(); p.resize(266)
    expect(p.crumbs.find(c => c.what === 'kb-open')!.data).toMatchObject({ inset: 291, shrank: false, dock: 291 })
    expect(p.props['--vv-below']).toBe('291px')
  })
  it('every open and close is reported and numbered, even with the same numbers each time (never dropped as a duplicate)', () => {
    const p = page({ w: 951, h: 539 })
    for (let i = 0; i < 3; i++) { p.focus(); p.resize(209); p.blur(); p.resize(539) }
    const kb = p.crumbs.filter(c => c.what === 'kb-open' || c.what === 'kb-close')
    expect(kb.map(c => c.what)).toEqual(['kb-open', 'kb-close', 'kb-open', 'kb-close', 'kb-open', 'kb-close'])
    expect(new Set(kb.map(c => JSON.stringify(c.data))).size, 'each line differs').toBe(6)
  })
  it('--vv-* are written only when they change (a pinch or pan fires every frame)', () => {
    const p = page({ w: 382, h: 557 })
    p.focus(); p.resize(266)
    const n = p.writes.n
    expect(n, "the open box, then the keyboard box").toBe(6)
    for (let i = 0; i < 5; i++) p.resize(266)
    expect(p.writes.n, 'same box, no writes').toBe(n)
    p.resize(266, 557, 30)
    expect(p.writes.n).toBe(n + 3)
    expect(p.props['--vv-top']).toBe('30px')
  })
  it('QA W3: no focus line on a fine pointer', () => {
    const p = page({ w: 1200, h: 800, fine: true })
    p.focus()
    expect(p.crumbs.filter(c => c.what === 'focus')).toHaveLength(0)
  })
  it('something tall covering the bottom with no field focused is not a keyboard', () => {
    const p = page({ w: 382, h: 557 })
    p.runFrames(); p.resize(400)
    expect(p.cls.has('kb-up')).toBe(false)
    expect(p.crumbs.filter(c => c.what === 'kb-open')).toHaveLength(0)
  })
  it('QA W3: focus lines have their own 20; keyboard lines keep the other 60, so typing never starves them', () => {
    const posts: any[] = []
    let now = 1_000_000
    const ctx: any = vm.createContext({ window: { innerWidth: 382, innerHeight: 557, visualViewport: { height: 557, width: 382, offsetTop: 0, scale: 1 }, matchMedia: () => ({ matches: true }) },
      document: { documentElement: { clientHeight: 557 } }, navigator: { userAgent: 'x', maxTouchPoints: 5 }, screen: {}, api: (_p: string, o: any) => { posts.push(o.body.data); return Promise.resolve({}) },
      Date: { now: () => now }, JSON, Math, isFinite, Object, String })
    vm.runInContext(slice(APP, '  // ── layout breadcrumbs', '  // ── the shared kit') + '\n;this.crumb = layoutCrumb;', ctx)
    for (let i = 0; i < 40; i++) { now += 10_001; ctx.crumb('focus', { n: i }) }
    expect(posts.filter(d => d.what === 'focus'), 'focus stops at its own 20').toHaveLength(20)
    for (let i = 0; i < 100; i++) { now += 10_001; ctx.crumb('kb-open', { n: i }) }
    expect(posts.filter(d => d.what === 'kb-open'), 'the keyboard still has its 60').toHaveLength(60)
    expect(posts).toHaveLength(80)
    // In one 10 s window a focus line goes only while the window is under half full; keyboard lines up to 20.
    const ctx2: any = vm.createContext({ ...ctx, api: (_p: string, o: any) => { posts2.push(o.body.data.what); return Promise.resolve({}) } })
    const posts2: string[] = []
    vm.runInContext(slice(APP, '  // ── layout breadcrumbs', '  // ── the shared kit') + '\n;this.crumb = layoutCrumb;', ctx2)
    for (let i = 0; i < 15; i++) ctx2.crumb('focus', { n: i })
    for (let i = 0; i < 15; i++) ctx2.crumb('kb-open', { n: i })
    expect(posts2.filter(w => w === 'focus')).toHaveLength(10)
    expect(posts2.filter(w => w === 'kb-open')).toHaveLength(10)
  })
})

// ── A2, A4, A5, A8: the stylesheets ───────────────────────────────────────────────────────────────────────────────
const APP_CSS = noComments(read('app.css')), CHAT_CSS = noComments(read('panes/cos-chat.css'))
describe('7.0.2 A2: no dead workspace padding on the COS chat route', () => {
  it('app.css: ws-chat takes the 96 px (and the 40 px from 600 px) away', () => {
    expect(APP_CSS).toContain('.workspace.ws-chat { padding-bottom: 0; }')
    expect(APP_CSS).toContain('@media (min-width: 860px) { .workspace.ws-chat { padding-bottom: calc(var(--safe-bottom) + 16px); } }')
  })
  it('messages.js: splitHost puts ws-chat on the workspace on the chat route only, and any other route takes it off', () => {
    const MSG = read('panes/messages.js')
    const ws = { cls: new Set<string>(), classList: { toggle: (c: string, on: boolean) => { if (on) ws.cls.add(c); else ws.cls.delete(c) } } }
    const routeHooks: Array<(r: any) => void> = []
    let current: string[] = ['cos']
    const pane: any = { querySelector: () => split, innerHTML: '' }
    const split: any = { setAttribute: (k: string, v: string) => { split[k] = v } }
    const W: any = { onRoute: (fn: (r: any) => void) => routeHooks.push(fn) }
    const $ = (id: string) => (id === 'workspace' ? ws : null)
    // eslint-disable-next-line no-new-func
    const host = new Function('W', '$', 'pane', 'SPLIT_KIT', 'SPLIT', 'getCurrent',
      'var current; ' + slice(MSG, '  function splitHost() {', '  function renderList() {').replace(/current\[0\]/g, 'getCurrent()[0]') + '\nreturn splitHost;')(
      W, $, pane, { mount: () => null, handle: () => '' }, {}, () => current)
    host()
    expect(ws.cls.has('ws-chat')).toBe(true)
    current = []; host()
    expect(ws.cls.has('ws-chat'), 'the list route').toBe(false)
    current = ['cos']; host()
    routeHooks.forEach(fn => fn({ pane: 'today', args: [] }))
    expect(ws.cls.has('ws-chat'), 'leaving Messages').toBe(false)
    host(); routeHooks.forEach(fn => fn({ pane: 'messages', args: ['cos'] }))
    expect(ws.cls.has('ws-chat'), 'the chat route keeps it').toBe(true)
  })
})
describe('7.0.2 A4: the unfolded chat fits the screen and docks above the keyboard', () => {
  it('.msg-right never asks for more than the screen: min(420px, 100dvh - 72px)', () => {
    expect(CHAT_CSS).toContain('min-height: min(420px, calc(100dvh - 72px - var(--safe-top, 0px)))')
  })
  it('kb-chat: the two-column chat column is the visible box; the one-column composer sticks above the keyboard', () => {
    expect(CHAT_CSS).toContain('html.kb-chat .msg-right { top: calc(var(--vv-top, 0px) + 8px); height: calc(var(--vv-h, 100dvh) - 16px); min-height: 0; }')
    expect(CHAT_CSS).toContain("html.kb-chat .msg-split[data-show='chat'] .cc-composer { bottom: var(--vv-below, 0px); padding-bottom: 8px; }")
    // The column's feed may shrink to nothing so the composer fits a 193 px column (WebKit render, 951x209).
    expect(CHAT_CSS).toContain('html.kb-chat .msg-right .cc-feed { min-height: 0; }')
  })
  it('QA W7: nothing in the chat keys on the page-wide kb-up alone: the column on kb-chat, the composer on .cc-kb', () => {
    for (const r of noComments(read('panes/cos-chat.css')).split('\n').filter(l => /html\.kb-up/.test(l))) expect(r, r).toMatch(/\.cc-kb\b/)
    expect(CHAT_CSS).not.toMatch(/html\.kb-up \.msg-/)
  })
})
describe('7.0.2 A5: the composer the keyboard is for is compact while it is up', () => {
  it('the hint and camera go, the box caps at 3 lines, then two rows: the buttons, then Model and Effort side by side', () => {
    for (const r of ['html.kb-up .cc-kb .cc-input { max-height: 88px; }', 'html.kb-up .cc-composer.cc-kb .cc-hint, html.kb-up .cc-composer.cc-kb .cc-camera { display: none; }',
      'html.kb-up .cc-kb .cc-menus { display: flex; flex-wrap: nowrap; width: 100%; gap: 8px; }', 'html.kb-up .cc-kb .cc-model { flex: 1 1 0; }']) expect(CHAT_CSS, r).toContain(r)
  })
  it('the Model select never widens the page: min-width 0 and max-width 100% at every width', () => {
    expect(CHAT_CSS).toContain('.cc-menus, .cc-model { min-width: 0; max-width: 100%; }')
    expect(CHAT_CSS).toContain('.cc-model .field { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }')
  })
})
describe('7.0.2 A8: a short wide touch screen is a phone', () => {
  const isPhoneOf = (matches: (q: string) => boolean) => {
    // eslint-disable-next-line no-new-func
    const src = APP.split('\n').filter(l => /^  var SHORT_TOUCH_MQ = |^  function isPhone\(\)/.test(l))
    expect(src).toHaveLength(2)
    return new Function('window', src.join('\n') + '\nreturn isPhone;')({ matchMedia: (q: string) => ({ matches: matches(q) }) }) as () => boolean
  }
  it('isPhone: under 600 wide, or coarse and at most 720 tall (951x539 Duo); a tall or fine screen is not', () => {
    const mq = (w: number, h: number, coarse: boolean) => (q: string) => q === '(min-width: 600px)' ? w >= 600 : q === '(pointer: coarse) and (max-height: 720px)' ? coarse && h <= 720 : false
    expect(isPhoneOf(mq(382, 557, true))()).toBe(true)
    expect(isPhoneOf(mq(951, 539, true))(), 'the unfolded Duo').toBe(true)
    expect(isPhoneOf(mq(1430, 1000, true))(), 'a tall touch screen').toBe(false)
    expect(isPhoneOf(mq(951, 539, false))(), 'a short laptop window').toBe(false)
  })
  it('the 44 px floor and the phone Ask sheet reach coarse screens 720 px tall or less', () => {
    expect(APP_CSS).toContain('@media (max-width: 599px), (pointer: coarse) and (max-height: 720px) {\n  .cx-btn, .field { min-height: 44px !important; }')
    const sheet = APP_CSS.slice(APP_CSS.indexOf('@media (min-width: 600px) and (pointer: coarse) and (max-height: 720px) {'))
    expect(sheet).toMatch(/^@media \(min-width: 600px\) and \(pointer: coarse\) and \(max-height: 720px\) \{\n  \.sheet-backdrop \{ padding-top: 0; \}\n  \.sheet \{ max-width: none;/)
    // It must come after the desktop sheet rules it overrides (same specificity).
    expect(APP_CSS.indexOf('@media (min-width: 600px) and (pointer: coarse) and (max-height: 720px) {')).toBeGreaterThan(APP_CSS.indexOf('.sheet { max-width: 620px;'))
  })
})

// ── A6, A7, A2 scroll-back: the chat itself ──────────────────────────────────────────────────────────────────────
const CHAT_SRC = read('panes/cos-chat.js')
function chat(o: { models?: unknown; route?: { pane: string; args: string[] }; wide?: boolean; failAsk?: { code: string; message: string }; jobSession?: string; jobDone?: boolean } = {}) {
  const posts: Array<{ path: string; body: any }> = [], gets: string[] = []
  const kbHooks: Array<(w: string, v?: any) => void> = [], docListeners: Record<string, Array<(e: any) => void>> = {}
  const htmlCls = new Set<string>(), formCls = new Set<string>()
  let job = 0, models = o.models
  const W: any = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {}, parseRoute: () => o.route ?? { pane: 'messages', args: ['cos'] }, go: () => {},
    onKeyboard: (fn: (w: string, v?: any) => void) => kbHooks.push(fn),
    api: (path: string, opts?: { method?: string; body?: any }) => {
      if (opts?.method === 'POST' && path === '/api/query-jobs' && o.failAsk) { posts.push({ path, body: opts.body }); return Promise.reject(Object.assign(new Error(o.failAsk.message), { code: o.failAsk.code })) }
      if (opts?.method === 'POST') { posts.push({ path, body: opts.body }); if (path === '/api/query-jobs') return Promise.resolve({ job: { jobId: 'j' + (++job), status: 'running', ...(o.jobSession ? { sessionId: o.jobSession } : {}) } }); return Promise.resolve({}) }
      gets.push(path)
      if (path.startsWith('/api/models')) return Promise.resolve(models ?? {})
      if (path.startsWith('/api/query-jobs/j') && o.jobDone) return Promise.resolve({ job: { jobId: path.split('/')[3]!.split('?')[0], status: 'completed', response: 'ok', ...(o.jobSession ? { sessionId: o.jobSession } : {}) } })
      return Promise.resolve({})
    },
  }
  const media = { matches: !!o.wide, addEventListener: () => {} }
  const form: any = { bottom: 557, getBoundingClientRect: () => ({ bottom: form.bottom }), querySelector: () => null, querySelectorAll: () => [], getAttribute: () => 'chat',
    classList: { add: (c: string) => formCls.add(c), remove: (c: string) => formCls.delete(c), toggle() {} } }
  const se: any = { scrollHeight: 900 }
  const window: any = { COSWeb: W, matchMedia: () => media, innerHeight: 557, scrollY: 0, scrollTo: (_x: number, y: number) => { window.scrollY = y }, localStorage: { getItem: () => null, setItem: () => {} } }
  const document: any = {
    addEventListener: (t: string, fn: (e: any) => void) => { (docListeners[t] ??= []).push(fn) }, querySelectorAll: (sel: string) => (sel === '.cc-composer.cc-kb' && formCls.has('cc-kb') ? [form] : []), getElementById: () => null,
    querySelector: (sel: string) => (sel === '[data-cos-form="chat"]' ? form : null),
    activeElement: null, hidden: false, body: { scrollHeight: 900 }, scrollingElement: se, documentElement: { classList: { toggle: (c: string, on: boolean) => { if (on) htmlCls.add(c); else htmlCls.delete(c) } } }, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const timers: Array<() => void> = []
  const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout, console, Date, JSON, Math, Promise, isFinite, Number, String,
    localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(CHAT_SRC, ctx)
  return { c: W.cosChat as any, posts, gets, kbHooks, docListeners, window, document, form, se, timers, htmlCls, formCls, setModels: (m: unknown) => { models = m } }
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }

describe('7.0.2 A6: a failed Ask says why, by error.code, and offers Ask again', () => {
  const line = (job: any) => chat().c._errorLine(job)
  it('provider_limit with the reset time in the provider’s words (Codex, 11/07)', () => {
    const job = { status: 'failed', provider: 'codex', error: { code: 'provider_limit', message: "You've hit your usage limit. Upgrade to Pro or try again at Nov 13th, 2026 12:20 PM." } }
    expect(line(job)).toBe('Codex is out of usage until Nov 13th, 2026 12:20 PM. Pick another model under Model and ask again.')
  })
  it('provider_limit: Claude’s "resets 4pm", a duration, retryAfterMs, and no time at all', () => {
    expect(line({ provider: 'claude', error: { code: 'provider_limit', message: "You've hit your session limit · resets 4pm" } })).toBe('Claude is out of usage until 4pm. Pick another model under Model and ask again.')
    expect(line({ requestedModel: 'codex-frontier', error: { code: 'provider_limit', message: 'Rate limited, resets in 2 hours' } })).toBe('Codex is out of usage for 2 hours. Pick another model under Model and ask again.')
    const later = line({ resolvedModel: 'opus', error: { code: 'provider_limit', message: 'Too many requests', retryAfterMs: 3_600_000 } })
    expect(later).toMatch(/^Claude is out of usage until .+\d.+\. Pick another model under Model and ask again\.$/)
    expect(line({ error: { code: 'provider_limit', message: 'quota exceeded' } })).toBe('This model is out of usage for now. Pick another model under Model and ask again.')
  })
  it('provider_auth, provider_timeout, interrupted (each cause), and the generic line for anything else', () => {
    expect(line({ provider: 'cursor', error: { code: 'provider_auth', message: 'not logged in' } })).toBe('Cursor is not signed in on your Mac. Sign in there, or pick another model under Model and ask again.')
    expect(line({ error: { code: 'provider_timeout', message: 'x' } })).toBe('The model took longer than the time limit, so COS stopped waiting. Ask again, or pick a lower Effort for a faster answer.')
    expect(line({ status: 'interrupted', error: { code: 'interrupted', cause: 'server_restarted', message: 'Server restarted. Tap to retry.' } })).toBe('COS on your Mac restarted before this answer finished. Ask again when you are ready.')
    expect(line({ status: 'interrupted', error: { code: 'interrupted', cause: 'server_shutdown' } })).toBe('COS on your Mac shut down before this answer finished. When it is back, ask again.')
    expect(line({ status: 'interrupted', error: { code: 'interrupted', cause: 'crash_loop_parked' } })).toMatch(/^COS on your Mac stopped after crashing several times/)
    expect(line({ status: 'failed', error: { code: 'query_job_failed', message: 'Codex failed (codex.error)' } })).toBe('COS could not finish this answer. Ask again when you are ready.')
  })
  it('a machine reset time (ISO 8601, or UTC) is shown in local time, never raw', () => {
    const iso = line({ provider: 'codex', error: { code: 'provider_limit', message: 'usage_limit_exceeded: try again at 2026-11-13T18:20:00.000Z' } })
    expect(iso).not.toContain('2026-11-13T')
    expect(iso).toMatch(/^Codex is out of usage until Nov 1[34], \d{1,2}:20\s?[AP]M\. Pick another model/)
    const utc = line({ provider: 'claude', error: { code: 'provider_limit', message: 'Limit reached. Resets at Nov 13, 2026 18:20 UTC' } })
    expect(utc).not.toContain('UTC')
    expect(utc).toMatch(/^Claude is out of usage until Nov 1[34], \d{1,2}:20\s?[AP]M\./)
  })
  it('QA N2: a conversation too long for the model has its own line', () => {
    expect(line({ provider: 'claude', error: { code: 'provider_context_too_long', message: 'prompt is too long' } }))
      .toBe('This conversation is too long for Claude. Start a new chat, or pick a model with a larger context under Model.')
  })
  it('no em dash in any line', () => {
    for (const code of ['provider_limit', 'provider_auth', 'provider_timeout', 'provider_context_too_long', 'interrupted', 'other']) expect(line({ provider: 'codex', error: { code } })).not.toMatch(/—/)
  })
  it('a failed card has Ask again; it resends the same words and files as a new Ask, once', async () => {
    const h = chat()
    const C = h.c._state
    C.caps = { jobs: true }
    const a = { cid: 'c1', jobId: 'j0', query: 'What did Graham say?', status: 'failed', error: 'x', atts: [{ name: 'a.png', kind: 'image' }],
      again: { attachmentIds: ['m_aaaaaaaaaaaaaaaaaaaaaaaa'], atts: [{ name: 'a.png', kind: 'image' }], sessionId: '', replyKey: '', context: '' } }
    C.asks.push(a)
    expect(h.c._askHtml(a, false)).toContain('data-cos="again" data-cid="c1">Ask again</button>')
    h.c.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'again', 'data-cid': 'c1' }) as Record<string, string>)[k] ?? null })
    await flush()
    const sent = h.posts.filter(p => p.path === '/api/query-jobs')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ query: 'What did Graham say?', attachmentIds: ['m_aaaaaaaaaaaaaaaaaaaaaaaa'], source: 'web' })
    expect(sent[0]!.body.clientJobId, 'a new client job id').not.toBe('c1')
    expect(h.c._askHtml(a, false), 'the failed card loses its button').not.toContain('data-cos="again"')
    h.c.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'again', 'data-cid': 'c1' }) as Record<string, string>)[k] ?? null })
    await flush()
    expect(h.posts.filter(p => p.path === '/api/query-jobs'), 'a second tap sends nothing').toHaveLength(1)
  })
  it('QA W4: a failed Prep card has no Ask again and is never resent as a plain Ask', async () => {
    const h = chat()
    const a = { cid: 'p1', jobId: 'j0', query: 'Prep me for Board', status: 'failed', error: 'x', atts: [], prepDraftId: 'draft-1', again: { attachmentIds: [], atts: [] } }
    h.c._state.asks.push(a)
    expect(h.c._askHtml(a, false)).not.toContain('data-cos="again"')
    expect(h.c._askAgain('p1')).toBeNull()
    await flush()
    expect(h.posts.filter(p => p.path === '/api/query-jobs')).toHaveLength(0)
  })
  it('an Ask again whose file can no longer be read never points at the box (it never came from the box)', async () => {
    const h = chat({ failAsk: { code: 'attachment_not_found', message: 'The file expired.' } })
    h.c._state.caps = { jobs: true }
    const a = { cid: 'c2', jobId: 'j0', query: 'q', status: 'failed', error: 'x', atts: [], again: { attachmentIds: ['m_aaaaaaaaaaaaaaaaaaaaaaaa'], atts: [] } }
    h.c._state.asks.push(a)
    const again = h.c._askAgain('c2')
    await flush()
    expect(again.status).toBe('failed')
    expect(again.error).toBe('An attachment could not be read: The file expired. Attach the file again in the box and ask again.')
  })
  it('a running, completed or never-admitted Ask has no Ask again', () => {
    const h = chat()
    expect(h.c._askHtml({ cid: 'r', jobId: 'j', status: 'running', query: 'q', atts: [] }, false)).not.toContain('data-cos="again"')
    expect(h.c._askHtml({ cid: 'd', jobId: 'j', status: 'completed', no: 4, query: 'q', atts: [] }, false)).not.toContain('data-cos="again"')
    expect(h.c._askHtml({ cid: 'n', status: 'failed', error: 'Not sent', query: 'q', atts: [] }, false), 'the words are still in the box').not.toContain('data-cos="again"')
  })
})

describe('7.0.2 A7: "Default" in the Model menu names what it resolves to', () => {
  it('labels from /api/models defaultModel: Codex Frontier, Claude Opus; an older server keeps plain Default', async () => {
    const h = chat({ models: { defaultModel: { preference: 'codex-frontier', source: 'env' }, options: [] } })
    expect(h.c._defaultLabel({ preference: 'codex-frontier' })).toBe('Codex Frontier')
    expect(h.c._defaultLabel({ preference: 'opus' })).toBe('Claude Opus')
    expect(h.c._defaultLabel({ preference: 'sonnet' })).toBe('Claude Sonnet')
    expect(h.c._defaultLabel(undefined)).toBe('')
    h.c._state.caps = { jobs: true }
    h.c.mount({ querySelector: () => null, set innerHTML(_v: string) {} } as any, true)
    await flush()
    expect(h.gets.some(g => g.startsWith('/api/models'))).toBe(true)
    expect(h.c._modelMenuHtml()).toContain('<option value="">Default (Codex Frontier)</option>')
    const old = chat({ models: { options: [] } })
    old.c._state.caps = { jobs: true }
    old.c.mount({ querySelector: () => null, set innerHTML(_v: string) {} } as any, true)
    await flush()
    expect(old.c._modelMenuHtml()).toContain('<option value="">Default</option>')
  })
  it('a session bound to a key profile reads "Default (key profile)"', async () => {
    const h = chat({ models: { defaultModel: { preference: null, source: 'profile' }, options: [] } })
    expect(h.c._defaultLabel({ preference: null, source: 'profile' })).toBe('key profile')
    h.c._state.caps = { jobs: true }
    h.c.mount({ querySelector: () => null, set innerHTML(_v: string) {} } as any, true)
    await flush()
    expect(h.c._modelMenuHtml()).toContain('<option value="">Default (key profile)</option>')
  })
  it('QA W5: read again when the chat’s session changes, with that session, and again after each Ask finishes', async () => {
    const h = chat({ models: { defaultModel: { preference: 'codex-frontier', source: 'env' }, options: [] }, jobSession: 's-1', jobDone: true })
    h.c._state.caps = { jobs: true }
    h.c.mount({ querySelector: () => null, set innerHTML(_v: string) {} } as any, true)
    await flush()
    expect(h.c._modelMenuHtml()).toContain('Default (Codex Frontier)')
    h.setModels({ defaultModel: { preference: 'opus', source: 'session' }, options: [] })
    h.c.askFromSheet('hello')
    await flush()
    expect(h.gets, 'the new session is named').toContain('/api/models?sessionId=s-1')
    expect(h.c._modelMenuHtml()).toContain('Default (Claude Opus)')
    h.setModels({ defaultModel: { preference: 'fable', source: 'session' }, options: [] })
    while (h.timers.length) h.timers.shift()!()
    await flush()
    expect(h.c._modelMenuHtml(), 'after the Ask finished').toContain('Default (Claude Fable)')
  })
})

describe('7.0.2 A2: after the keyboard closes on the chat, the page scrolls back', () => {
  it('scrollY past the end comes back to the end', () => {
    const h = chat()
    h.window.scrollY = 450                     // max = 900 - 557 = 343
    h.kbHooks.forEach(fn => fn('after'))
    expect(h.window.scrollY).toBe(343)
  })
  it('the chat box had the keyboard and blank page shows under the composer: back to the bottom', () => {
    const h = chat()
    ;(h.docListeners.focusin || []).forEach(fn => fn({ target: { closest: () => ({ getAttribute: () => 'chat' }) } }))
    h.window.scrollY = 200; h.form.bottom = 450
    h.kbHooks.forEach(fn => fn('after'))
    expect(h.window.scrollY).toBe(343)
  })
  it('a steer box or another field had it, inside the range: nothing moves (reading history is left alone)', () => {
    const h = chat()
    ;(h.docListeners.focusin || []).forEach(fn => fn({ target: { closest: () => null } }))
    h.window.scrollY = 200; h.form.bottom = 450
    h.kbHooks.forEach(fn => fn('after'))
    expect(h.window.scrollY).toBe(200)
  })
  it('only the one-column chat route: two columns or another pane never scroll', () => {
    const wide = chat({ wide: true }); wide.window.scrollY = 450; wide.kbHooks.forEach(fn => fn('after'))
    expect(wide.window.scrollY).toBe(450)
    const other = chat({ route: { pane: 'today', args: [] } }); other.window.scrollY = 450; other.kbHooks.forEach(fn => fn('after'))
    expect(other.window.scrollY).toBe(450)
  })
})

describe('7.0.2 A4: two columns with the keyboard up, the chat column is scrolled to and capped to the visible box', () => {
  function wideChat(top: number, vis: { top: number; height: number }, scrollRoom: number) {
    const h = chat({ wide: true })
    const box = { id: 'cos-input' }
    const mr: any = { style: { maxHeight: '' }, _top: top, getBoundingClientRect: () => ({ top: mr._top }), contains: (x: unknown) => x === box }
    h.c._state.host = mr
    h.document.activeElement = box
    h.window.COSWeb.viewportFit = () => ({ top: vis.top, height: vis.height })
    h.window.scrollBy = (_x: number, dy: number) => { const moved = Math.min(dy, scrollRoom); scrollRoom -= moved; mr._top -= moved; h.window.scrollY += moved }
    return { h, mr }
  }
  it('951x539, 209 px visible: the page scrolls the column to the top of the visible box and caps it there', () => {
    const { h, mr } = wideChat(64, { top: 0, height: 209 }, 280)
    h.kbHooks.forEach(fn => fn('open'))
    expect(mr._top).toBe(8)
    expect(mr.style.maxHeight).toBe('193px')
    h.kbHooks.forEach(fn => fn('close'))
    expect(mr.style.maxHeight, 'the cap goes with the keyboard').toBe('')
  })
  it('a page too short to scroll: the column is capped to what is left above the keyboard', () => {
    const { mr, h } = wideChat(64, { top: 0, height: 209 }, 10)
    h.kbHooks.forEach(fn => fn('open'))
    expect(mr._top).toBe(54)
    expect(mr.style.maxHeight).toBe('147px')
  })
  it('the keyboard is for the list’s search box on the left: the chat column is left alone', () => {
    const { h, mr } = wideChat(64, { top: 0, height: 209 }, 280)
    h.document.activeElement = { id: 'msg-q' }
    h.kbHooks.forEach(fn => fn('open'))
    expect(mr._top).toBe(64)
    expect(mr.style.maxHeight).toBe('')
  })
  it('QA W6: the cap follows the visible box while the keyboard rises in steps, and a fold to one column clears it', () => {
    const { h, mr } = wideChat(64, { top: 0, height: 300 }, 280)
    h.kbHooks.forEach(fn => fn('open'))
    expect(mr.style.maxHeight).toBe('284px')
    h.kbHooks.forEach(fn => fn('move', { top: 0, height: 209 }))
    expect(mr.style.maxHeight, 'the keyboard rose further').toBe('193px')
    h.window.matchMedia = () => ({ matches: false, addEventListener: () => {} })
    h.kbHooks.forEach(fn => fn('move', { top: 0, height: 266 }))
    expect(mr.style.maxHeight, 'folded to one column with the keyboard up').toBe('')
  })
  it('QA W7: the chat column and its composer are marked only for a field in the chat (kb-chat, cc-kb)', () => {
    const { h } = wideChat(64, { top: 0, height: 209 }, 280)
    h.document.activeElement = { id: 'cos-input', closest: () => h.form }
    h.c._state.host.contains = (x: any) => x && x.id === 'cos-input'
    h.kbHooks.forEach(fn => fn('open'))
    expect(h.htmlCls.has('kb-chat')).toBe(true)
    expect(h.formCls.has('cc-kb')).toBe(true)
    h.document.activeElement = { id: 'msg-q', closest: () => null }
    ;(h.docListeners.focusin || []).forEach(fn => fn({ target: h.document.activeElement }))
    // keyboardUp is not in this harness: drive the hook as app.js would on the next move.
    h.kbHooks.forEach(fn => fn('move', { top: 0, height: 209 }))
    expect(h.htmlCls.has('kb-chat'), 'the Messages search box leaves the chat alone').toBe(false)
    expect(h.formCls.has('cc-kb')).toBe(false)
    h.kbHooks.forEach(fn => fn('close'))
    expect(h.htmlCls.has('kb-chat')).toBe(false)
  })
  it('one column: nothing is capped (the composer docks by CSS there)', () => {
    const h = chat({ wide: false })
    const box = { id: 'cos-input' }
    const mr: any = { style: { maxHeight: '' }, getBoundingClientRect: () => ({ top: 64 }), contains: (x: unknown) => x === box }
    h.c._state.host = mr
    h.document.activeElement = box
    h.window.scrollBy = () => {}
    h.window.COSWeb.viewportFit = () => ({ top: 0, height: 266 })
    h.kbHooks.forEach(fn => fn('open'))
    expect(mr.style.maxHeight).toBe('')
  })
})

// ── B1 (QA round 1): the rail's stories on a short touch screen ─────────────────────────────────────────────────────
describe('7.0.2 B1: the unfolded Duo (951x539, touch) still loads the rail’s stories', () => {
  const SHELL = read('shell.js')
  function shell(width: number, coarseShort: boolean) {
    const timers: Array<() => void> = [], shellHooks: Array<() => void> = [], clicks: Array<(e: any) => void> = []
    const reads: string[] = []
    const W: any = {
      $: () => null, esc: (s: unknown) => String(s), titles: {}, go: () => {}, goBack: () => {},
      api: (path: string) => { reads.push(path); return Promise.resolve({}) },
      onRoute: () => {}, onServer: () => {}, onShell: (fn: () => void) => shellHooks.push(fn),
      sessionList: () => { reads.push('sessionList'); return Promise.resolve({ sessions: [] }) },
      // 7.0.2 A8: a short touch screen at any width is a phone here.
      isPhone: () => width < 600 || coarseShort,
    }
    const window: any = { COSWeb: W, matchMedia: (q: string) => ({ matches: q === '(min-width: 600px)' ? width >= 600 : false }) }
    const document: any = { addEventListener: (t: string, fn: (e: any) => void) => { if (t === 'click') clicks.push(fn) }, querySelectorAll: () => [], querySelector: () => null, hidden: false, body: { classList: { toggle() {} } } }
    const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, setInterval: () => 1, clearInterval: () => {},
      console, Date, JSON, Math, Promise, Number, String, isNaN, encodeURIComponent })
    vm.runInContext(SHELL, ctx)
    return { W, shellHooks, timers, reads, clicks }
  }
  it('951x539 coarse: after sign-in the stories load (the rail and its hot dots are on screen there)', async () => {
    const s = shell(951, true)
    expect(s.W.isPhone(), 'A8: it is a phone for the sheet and the tap floor').toBe(true)
    s.shellHooks.forEach(fn => fn()); while (s.timers.length) s.timers.shift()!()
    await flush()
    expect(s.reads).toContain('sessionList')
    expect(s.reads).toContain('/api/work-board/your-move')
  })
  it('382x557 (no rail): the stories wait for the section menu, as before', async () => {
    const s = shell(382, true)
    s.shellHooks.forEach(fn => fn()); while (s.timers.length) s.timers.shift()!()
    await flush()
    expect(s.reads).not.toContain('sessionList')
    s.clicks.forEach(fn => fn({ target: { closest: (sel: string) => (sel === '#section-btn' ? {} : null) } }))
    await flush()
    expect(s.reads).toContain('sessionList')
  })
})
