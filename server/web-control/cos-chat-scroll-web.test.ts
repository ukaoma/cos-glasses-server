import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./panes/cos-chat.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('./panes/cos-chat.css', import.meta.url), 'utf8')
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }

function fixture(wide: boolean) {
  const listeners = new Map<any, Record<string, Function[]>>()
  function events(obj: any) {
    const ls: Record<string, Function[]> = {}; listeners.set(obj, ls)
    obj.addEventListener = (name: string, fn: Function) => (ls[name] ||= []).push(fn)
    obj.removeEventListener = (name: string, fn: Function) => { ls[name] = (ls[name] || []).filter(f => f !== fn) }
    return obj
  }
  const emit = (obj: any, name: string, value = {}) => (listeners.get(obj)?.[name] || []).forEach(fn => fn({ type: name, target: obj, ...value }))
  let height = 2400, top = 0
  const scroll = { clientHeight: 500, get scrollHeight() { return height }, get scrollTop() { return top }, set scrollTop(y) { top = Math.max(0, Math.min(y, height - 500)) } }
  const content = {}
  const feed: any = events({ ...scroll, innerHTML: '', isConnected: true, children: [content], contains: () => false,
    querySelector: (s: string) => s === '[data-cos-content]' ? content : null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0 }), hasAttribute: () => true })
  Object.defineProperties(feed, { scrollHeight: { get: () => height }, scrollTop: { get: () => scroll.scrollTop, set: y => { scroll.scrollTop = y } } })
  const chatEl = { offsetParent: {}, getAttribute: () => 'ask' }
  const host: any = { querySelector: (s: string) => s === '[data-cos-feed]' ? feed : s === '[data-cos-chat]' ? chatEl : null }
  const frames: Function[] = [], resizes: Function[] = []
  const answers: Record<string, any> = {}
  const route = { pane: 'messages', args: ['cos'] }, viewport = { bad: false }
  const W: any = { $: () => null, esc: String, md: String, readStore: () => ({}), writeStore() {}, toDate: (s: string) => new Date(s),
    parseRoute: () => route, viewportFit: () => viewport, autoGrow() {}, skeletonRows: () => '', api: (p: string) => Promise.resolve(answers[p] || {}), toast() {} }
  const win: any = events({ COSWeb: W, visualViewport: events({}), matchMedia: () => ({ matches: wide, addEventListener() {} }),
    scrollTo: (_x: number, y: number) => { scroll.scrollTop = y }, scrollBy: (_x: number, y: number) => { scroll.scrollTop += y },
    requestAnimationFrame: (fn: Function) => { frames.push(fn); return frames.length }, cancelAnimationFrame() {} })
  const fonts = events({ ready: Promise.resolve() })
  const doc: any = events({ scrollingElement: scroll, body: { get scrollHeight() { return height } }, fonts,
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, activeElement: null, hidden: false })
  const ResizeObserver = class { constructor(fn: Function) { resizes.push(fn) } observe() {} disconnect() {} }
  vm.runInNewContext(source, { window: win, document: doc, ResizeObserver, requestAnimationFrame: win.requestAnimationFrame,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, crypto: globalThis.crypto, console })
  const chat = W.cosChat
  Object.assign(chat._state, { host, caps: { jobs: true }, items: [], feedState: 'ready', feedMode: 'ask' })
  const layout = () => { resizes.forEach(fn => fn()); const now = frames.splice(0); now.forEach(fn => fn()) }
  const tap = (what: string) => chat.onClick({ getAttribute: (s: string) => s === 'data-cos' ? what : null })
  return { chat, host, feed, scroll, emit, win, doc, route, fonts, layout, tap, answers, viewport, grow: (n: number) => { height += n } }
}

describe('COS chat scroll ownership', () => {
  for (const wide of [true, false]) {
    const label = wide ? 'wide feed' : 'narrow page'
    it(`${label}: a malformed viewport releases the narrow sticky composer, then restores it without moving the reader`, () => {
      const h = fixture(wide), classes = new Set<string>()
      const form = { classList: { toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) } }
      const original = h.host.querySelector
      h.host.querySelector = (s: string) => s === '[data-cos-form="chat"]' ? form : original(s)
      h.viewport.bad = true
      h.chat._paintFeed(true); h.layout()
      expect(classes.has('cc-vv-lost')).toBe(!wide)
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -200 }); h.scroll.scrollTop = 600
      h.viewport.bad = false; h.emit(h.win.visualViewport, 'resize'); h.layout()
      expect(classes.has('cc-vv-lost')).toBe(false)
      expect(h.scroll.scrollTop).toBe(600)
      h.viewport.bad = true; h.emit(h.win.visualViewport, 'scroll'); h.layout()
      expect(classes.has('cc-vv-lost')).toBe(!wide)
      expect(h.scroll.scrollTop).toBe(600)
      h.viewport.bad = false; h.emit(h.win, 'pageshow'); h.layout()
      expect(classes.has('cc-vv-lost')).toBe(false)
      expect(css).toMatch(/\.msg-split\[data-show='chat'\] \.cc-composer\.cc-vv-lost \{ position: static; \}/)
    })
    it(`${label}: opening follows delayed layout, media, fonts and restored scroll`, async () => {
      const h = fixture(wide)
      h.chat.mount(h.host, true); await flush(); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - h.scroll.clientHeight)
      h.grow(1800); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - h.scroll.clientHeight)
      h.scroll.scrollTop = 300
      h.emit(wide ? h.feed : h.win, 'scroll'); h.emit(h.win, 'pageshow'); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - h.scroll.clientHeight)
      h.grow(200); h.emit(h.feed, 'load'); h.emit(h.fonts, 'loadingdone'); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - h.scroll.clientHeight)
    })
    it(`${label}: reading survives polling; Jump to latest and cached reopen resume following`, async () => {
      const h = fixture(wide)
      h.chat.mount(h.host, true); await flush(); h.layout()
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -200 })
      h.scroll.scrollTop = 600; h.emit(wide ? h.feed : h.win, 'scroll')
      h.grow(500); h.chat._paintFeed(false); h.layout()
      expect(h.scroll.scrollTop).toBe(600)
      h.tap('latest'); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - 500)
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -200 }); h.scroll.scrollTop = 600
      h.chat.mount(h.host, false); h.chat.mount(h.host, true); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - 500)
    })
    it(`${label}: intentional item focus wins over pending opening layout`, () => {
      const h = fixture(wide)
      h.chat._paintFeed(true)
      h.chat._state.focusItem = 'an-item'; h.chat._state.archiveOpen = true; h.chat._state.archive = []
      const original = h.host.querySelector
      h.host.querySelector = (s: string) => s.includes('data-item-id') ? { scrollIntoView() { h.scroll.scrollTop = 700 } } : original(s)
      h.chat._paintFeed(false); h.grow(400); h.layout()
      expect(h.scroll.scrollTop).toBe(700)
    })
    it(`${label}: a notification route resolves the named card and never re-pins on polling`, async () => {
      const h = fixture(wide)
      h.route.args.push('fi_notification')
      const original = h.host.querySelector
      h.host.querySelector = (s: string) => s.includes('data-item-id="fi_notification"') ? { scrollIntoView() { h.scroll.scrollTop = 700 } } : original(s)
      h.chat.mount(h.host, true); await flush(); h.layout()
      expect(h.scroll.scrollTop).toBe(700)
      h.chat.mount(h.host, true); h.grow(500); h.layout()
      expect(h.scroll.scrollTop).toBe(700)
      h.chat.mount(h.host, false); h.scroll.scrollTop = 100
      h.chat.mount(h.host, true); h.layout()
      expect(h.scroll.scrollTop).toBe(700)
    })
    it(`${label}: a late initial history response respects reading that began while loading`, async () => {
      const h = fixture(wide)
      let resolve!: (value: unknown) => void
      h.answers['/api/cos-thread/history?limit=40'] = new Promise(r => { resolve = r })
      Object.assign(h.chat._state, { caps: { jobs: true, dropIt: true, thread: true, history: true }, feedMode: 'drop' })
      // Match the mounted history mode, so the fixture's host is retained.
      const original = h.host.querySelector
      h.host.querySelector = (s: string) => s === '[data-cos-chat]' ? { offsetParent: {}, getAttribute: () => 'drop-thread-history' } : original(s)
      h.chat.mount(h.host, true)
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -200 }); h.scroll.scrollTop = 400
      resolve({ entries: [], older: null, newest: 'n1' }); await flush(); h.layout()
      expect(h.scroll.scrollTop).toBe(400)
    })
    it(`${label}: even a small intentional scroll up remains owned by the reader`, async () => {
      const h = fixture(wide)
      h.chat.mount(h.host, true); await flush(); h.layout()
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -30 })
      h.scroll.scrollTop -= 30; h.emit(wide ? h.feed : h.win, 'scroll')
      const before = h.scroll.scrollTop
      h.chat._paintFeed(false); h.grow(50); h.layout()
      expect(h.scroll.scrollTop).toBe(before)
    })
  }
  it('a missing notification falls back to latest after the archive lookup', async () => {
    const h = fixture(true)
    h.route.args.push('fi_gone')
    h.chat.mount(h.host, true); await flush(); h.layout()
    expect(h.chat._state.focusItem).toBe('')
    expect(h.chat._state.archiveOpen).toBe(true)
    expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - 500)
  })
  it('offers a native keyboard-accessible button with a persistent touch target', () => {
    const h = fixture(true)
    expect(h.chat._chatSkeleton()).toContain('type="button"')
    expect(h.chat._chatSkeleton()).toContain('data-cos="latest">Jump to latest</button>')
    expect(css).toMatch(/\.cc-latest[^}]*min-height:\s*44px/s)
  })
})
