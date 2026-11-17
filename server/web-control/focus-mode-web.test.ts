/**
 * 7.0.53 focus mode, piece one (Miles 11/16 13:19; F1's direction A; the lead's 23:5x: A on the folded Duo and the phone,
 * Model and Effort folded, one tap back, his place and draft kept). Runs app.js's own focus controller (sliced out and run
 * against a fake page) and the real panes/cos-chat.js in a vm, and reads the CSS and markup it relies on.
 *
 * What only a browser proves (W1 checked it in the app's browser pane at 382x557, 402x874, 557x382 and 951x539 on F1's
 * mock; F1's WebKit pass owes it on the real engine): the first card he can see held within a pixel across enter and leave,
 * the strip's width kept, the stack at mid height on a phone, and the draft across a fold.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const APP_CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const CHAT_CSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const BLOCK = APP.slice(APP.indexOf('  // ── focus mode (7.0.53'), APP.indexOf('  // ── layout reports and the visible box'))

class Cls { set = new Set<string>(); contains = (c: string) => this.set.has(c); add = (c: string) => { this.set.add(c) }; remove = (c: string) => { this.set.delete(c) }; toggle = (c: string, on?: boolean) => { const want = on ?? !this.set.has(c); if (want) this.set.add(c); else this.set.delete(c); return want } }
class Node0 { classList = new Cls(); hidden = false; focused = 0; focus() { this.focused++; doc.activeElement = this } }
let doc: any

function controller(o: { route?: { pane: string; args: string[] }; narrow?: boolean; stored?: string | null; noChat?: boolean; sheetOpen?: boolean } = {}) {
  const de = new Node0(), enter = new Node0(), leave = new Node0(), stack = new Node0(), sheet = new Node0()
  enter.classList.add('hidden'); stack.hidden = true
  if (!o.sheetOpen) sheet.classList.add('hidden')
  const listeners: Record<string, Array<(e: any) => void>> = {}
  doc = { documentElement: de, activeElement: null, addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ??= []).push(fn) } }
  const ids: Record<string, Node0> = { 'focus-enter': enter, 'focus-leave': leave, 'focus-stack': stack, 'ask-sheet': sheet }
  let route = o.route ?? { pane: 'messages', args: ['cos'] }
  let narrow = o.narrow ?? true
  const mqListeners: Array<() => void> = []
  const store = new Map<string, string>(); if (o.stored != null) store.set('cos.focus', o.stored)
  const routeHooks: Array<() => void> = []
  const holds: number[] = [], latest: number[] = []
  const chat = o.noChat ? undefined : { holdPlace: (flip: () => void) => { holds.push(1); flip() }, latest: () => { latest.push(1) } }
  const window: any = {
    matchMedia: (q: string) => ({ get matches() { return q === '(max-width: 599px)' ? narrow : false }, addEventListener: (_t: string, fn: () => void) => { mqListeners.push(fn) } }),
    COSWeb: { cosChat: chat, onRoute: (fn: () => void) => { routeHooks.push(fn) } },
  }
  const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', '$', 'parseRoute', 'sessionStorage', BLOCK)(window, doc, (id: string) => ids[id] ?? null, () => route, sessionStorage)
  const fire = (t: string, e: any) => (listeners[t] ?? []).forEach(fn => fn(e))
  const tap = (act: string) => fire('click', { target: { closest: (s: string) => (s === '[data-focus]' ? { getAttribute: () => act } : null) } })
  const go = (r: { pane: string; args: string[] }) => { route = r; routeHooks.forEach(fn => fn()) }
  const fold = (n: boolean) => { narrow = n; mqListeners.forEach(fn => fn()) }
  routeHooks.forEach(fn => fn())   // the first route() at load
  return { de, enter, leave, stack, store, holds, latest, tap, go, fold, fire, api: window.COSWeb.focus, doc }
}
const on = (h: ReturnType<typeof controller>) => h.de.classList.contains('focus')

describe('focus mode: where it is offered', () => {
  it('on the COS thread below 600 px: the enter control shows, the stack does not', () => {
    const h = controller()
    expect(h.enter.classList.contains('hidden')).toBe(false)
    expect(h.stack.hidden).toBe(true)
    expect(on(h)).toBe(false)
  })
  it('nowhere else, and not from 600 px (the open Duo is the next piece)', () => {
    for (const route of [{ pane: 'messages', args: [] }, { pane: 'messages', args: ['cos', 'fi_9'] }, { pane: 'sessions', args: [] }, { pane: 'today', args: [] }]) {
      expect(controller({ route }).enter.classList.contains('hidden'), JSON.stringify(route)).toBe(true)
    }
    expect(controller({ narrow: false }).enter.classList.contains('hidden')).toBe(true)
  })
})

describe('focus mode: one tap in, one tap out, place held, kept for this tab', () => {
  it('enter: the class, the stack, the enter control gone, his place held, focus on Leave, and this tab remembers', () => {
    const h = controller()
    h.tap('enter')
    expect(on(h)).toBe(true)
    expect(h.stack.hidden).toBe(false)
    expect(h.enter.classList.contains('hidden')).toBe(true)
    expect(h.holds).toHaveLength(1)
    expect(h.doc.activeElement).toBe(h.leave)
    expect(h.store.get('cos.focus')).toBe('1')
  })
  it('leave: all of it back, place held again, focus on the enter control, the tab forgets', () => {
    const h = controller()
    h.tap('enter'); h.tap('leave')
    expect(on(h)).toBe(false)
    expect(h.stack.hidden).toBe(true)
    expect(h.enter.classList.contains('hidden')).toBe(false)
    expect(h.holds).toHaveLength(2)
    expect(h.doc.activeElement).toBe(h.enter)
    expect(h.store.has('cos.focus')).toBe(false)
  })
  it('a second enter does nothing (no second hold, nothing moves)', () => {
    const h = controller()
    h.tap('enter'); h.tap('enter')
    expect(h.holds).toHaveLength(1)
  })
  it('the newest-line control asks the chat for its newest line', () => {
    const h = controller()
    h.tap('enter'); h.tap('newest')
    expect(h.latest).toHaveLength(1)
    expect(on(h)).toBe(true)
  })
  it('Escape leaves; not while a sheet over the page is open', () => {
    const h = controller()
    h.tap('enter'); h.fire('keydown', { key: 'Escape' })
    expect(on(h)).toBe(false)
    const s = controller({ sheetOpen: true })
    s.tap('enter'); s.fire('keydown', { key: 'Escape' })
    expect(on(s)).toBe(true)
  })
  it('a reload in this tab comes back in focus; anything else stored is not focus', () => {
    expect(on(controller({ stored: '1' }))).toBe(true)
    expect(on(controller({ stored: 'yes' }))).toBe(false)
  })
  it('without the chat (an old pane) the class still flips', () => {
    const h = controller({ noChat: true })
    h.tap('enter')
    expect(on(h)).toBe(true)
  })
})

describe('focus mode: other panes and the fold', () => {
  it('leaving the thread (a session opened) drops the class but keeps the choice; coming back shows it again', () => {
    const h = controller()
    h.tap('enter')
    h.go({ pane: 'sessions', args: ['claude', 'x'] })
    expect(on(h)).toBe(false)
    expect(h.stack.hidden).toBe(true)
    expect(h.api.on()).toBe(true)
    h.go({ pane: 'messages', args: ['cos'] })
    expect(on(h)).toBe(true)
  })
  it('folding open past 600 px drops the class, folding shut brings it back, each through the hold', () => {
    const h = controller()
    h.tap('enter')
    h.fold(false)
    expect(on(h)).toBe(false)
    expect(h.enter.classList.contains('hidden')).toBe(true)
    h.fold(true)
    expect(on(h)).toBe(true)
    expect(h.holds).toHaveLength(3)
  })
})

// ── the chat's side: the folded line and the hold ─────────────────────────────────────────────────────────────────
function chat(o: { models?: Array<{ value: string; label: string; available: boolean }>; model?: string; effort?: string } = {}) {
  const els: Record<string, any> = {}
  const document: any = { addEventListener: () => {}, querySelectorAll: (s: string) => (s === '[data-cos="menus"]' ? (els.me ? [els.me] : []) : []), getElementById: () => null, activeElement: null, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const W: Record<string, unknown> = { $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {}, parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, api: () => Promise.resolve({}) }
  const window = { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, scrollBy: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  vm.runInContext(CHAT, vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto }))
  const c = W.cosChat as any
  Object.assign(c._state, { models: o.models ?? null, model: o.model ?? '', effort: o.effort ?? '' })
  return { c, document, els }
}
describe('the composer in focus: Model and Effort folded into one line', () => {
  it('the line is in the chat composer only, after the clip and before Ask, and says what is chosen', () => {
    const src = CHAT.slice(CHAT.indexOf('  function composerHtml(k, o) {'), CHAT.indexOf('  function hydrate(k) {'))
    expect(src).toContain("(k === CHAT ? '<button type=\"button\" class=\"link-btn cc-me\" data-cos=\"menus\" aria-expanded=\"false\">' + esc(meLabel()) + '</button>' : '')")
    expect(src.indexOf("clipHtml('data-cos-file')")).toBeLessThan(src.indexOf('cc-me'))
    expect(src.indexOf('cc-me')).toBeLessThan(src.indexOf('cc-ask'))
    const me = (o: Parameters<typeof chat>[0]) => {
      const h = chat(o); const b = { textContent: '', attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v }, closest: () => null }
      h.els.me = b; h.c._syncMenus(); return b.textContent
    }
    const models = [{ value: 'opus', label: 'Opus 5.5', available: true }]
    expect(me({ models })).toBe('Model and effort: default')
    expect(me({ models, model: 'opus' })).toBe('Model and effort: Opus 5.5, default')
    expect(me({ models, effort: 'xhigh' })).toBe('Model and effort: default, extra high')
    expect(me({ models, model: 'opus', effort: 'max' })).toBe('Model and effort: Opus 5.5, max')
    // A model the list no longer has still says what is set, never "default".
    expect(me({ models: [], model: 'gone-model' })).toBe('Model and effort: gone-model, default')
  })
  it('a tap opens Model and Effort under the box and closes them again; the choice itself is unchanged', () => {
    const h = chat()
    const form = { cls: new Set<string>(), classList: { toggle(c: string) { if (form.cls.has(c)) form.cls.delete(c); else form.cls.add(c) }, contains(c: string) { return form.cls.has(c) } } }
    const b = { textContent: '', attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v }, closest: () => form, getAttribute: (k: string) => (k === 'data-cos' ? 'menus' : null), tagName: 'BUTTON' }
    h.els.me = b
    h.c.onClick(b)
    expect(form.cls.has('menus-open')).toBe(true)
    expect(b.attrs['aria-expanded']).toBe('true')
    h.c.onClick(b)
    expect(form.cls.has('menus-open')).toBe(false)
    expect(b.attrs['aria-expanded']).toBe('false')
    expect(h.c._state.model).toBe('')
  })
})

describe('the hold across the flip (cos-chat.js holdPlace)', () => {
  const src = CHAT.slice(CHAT.indexOf('  function holdPlace(flip) {'), CHAT.indexOf('  function isComposerInput(el) {'))
  it('reading the newest line: flip, then the newest line again; else the same hold a quiet repaint uses; no chat on screen: just the flip', () => {
    expect(src).toContain("if (!feed || !chatVisible()) { flip(); return; }")
    expect(src).toContain('if (TAIL && TAIL.following) { flip(); scrollToEnd(feed); return; }')
    expect(src).toContain('keepPlace(flip, true);')
    expect(src.indexOf('chatVisible()')).toBeLessThan(src.indexOf('TAIL.following'))
    expect(src.indexOf('TAIL.following')).toBeLessThan(src.indexOf('keepPlace(flip, true)'))
  })
  it('both are exported for app.js', () => {
    expect(CHAT).toContain('    holdPlace: holdPlace, latest: latest,\n')
  })
})

describe('markup and styles', () => {
  it('the controls start hidden and say what they do; the icons are in the sprite', () => {
    expect(HTML).toContain('<button type="button" class="icon-btn focus-enter hidden" id="focus-enter" data-focus="enter" aria-label="Focus: the thread fills the screen">')
    expect(HTML).toContain('<div class="focus-stack" id="focus-stack" hidden>')
    expect(HTML).toContain('data-focus="leave" aria-label="Leave focus"')
    expect(HTML).toContain('data-focus="newest" aria-label="Go to the newest line"')
    for (const i of ['i-expand', 'i-collapse', 'i-down']) expect(HTML).toContain(`<symbol id="${i}" viewBox="0 0 24 24">`)
  })
  it('every focus rule is under html.focus inside the narrow query, or hides the controls by default; tokens only', () => {
    const appBlock = APP_CSS.slice(APP_CSS.indexOf('/* ── 7.0.53 focus mode'))
    const chatBlock = CHAT_CSS.slice(CHAT_CSS.indexOf('/* 7.0.53 focus mode'))
    for (const block of [appBlock, chatBlock]) {
      expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
      const inner = block.slice(block.indexOf('@media (max-width: 599px) {'))
      expect(inner.length).toBeGreaterThan(100)
    }
    expect(appBlock).toContain('html.focus .topbar, html.focus .navbar, html.focus .trail { display: none !important; }')
    expect(appBlock).toContain('html.focus.short-screen .rail > * { display: none !important; }')
    expect(chatBlock).toContain('.cc-me { display: none; }')
    expect(chatBlock).toContain('html.focus .cc-composer[data-cos-form="chat"]:not(.menus-open) > .cc-foot { display: none; }')
  })
})
