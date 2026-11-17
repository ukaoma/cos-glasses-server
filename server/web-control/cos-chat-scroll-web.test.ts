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
    for (const gesture of ['touchstart', 'pointerdown', 'wheel']) {
      it(`${label}: Jump then ${gesture} survives a queued bottom scroll before the upward movement`, async () => {
        const h = fixture(wide), target = wide ? h.feed : h.win
        h.chat.mount(h.host, true); await flush(); h.layout()
        h.tap('latest') // its final scroll/RAF can still be pending when the next gesture starts
        h.emit(target, gesture, { deltaY: -1 })
        h.emit(target, 'scroll') // delivered at bottom before the gesture has moved any pixels
        h.scroll.scrollTop -= 1; h.emit(target, 'scroll')
        const before = h.scroll.scrollTop
        h.emit(h.win.visualViewport, 'resize'); h.layout()
        h.grow(100); h.emit(h.feed, 'load'); h.layout()
        h.chat._paintFeed(false); h.layout()
        expect(h.scroll.scrollTop).toBe(before)
      })
    }
    it(`${label}: touching the bottom during a gesture reversal does not take ownership from the reader`, async () => {
      const h = fixture(wide), target = wide ? h.feed : h.win
      h.chat.mount(h.host, true); await flush(); h.layout(); h.tap('latest')
      h.emit(target, 'touchstart')
      h.scroll.scrollTop -= 40; h.emit(target, 'scroll')
      h.scroll.scrollTop = h.scroll.scrollHeight - h.scroll.clientHeight; h.emit(target, 'scroll')
      h.scroll.scrollTop -= 2; h.emit(target, 'scroll')
      const before = h.scroll.scrollTop
      h.emit(h.win.visualViewport, 'scroll'); h.grow(90); h.layout()
      expect(h.scroll.scrollTop).toBe(before)
      h.tap('latest'); h.layout()
      expect(h.scroll.scrollTop).toBe(h.scroll.scrollHeight - h.scroll.clientHeight)
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

// 7.0.52 (Miles 14:52): Back from a reader that "Open result" opened returns to the COS chat where he tapped, not to
// the newest line. Any other way back into the chat is as before: it follows the newest line.
describe('Back from Open result keeps his place in the COS chat', () => {
  const SID = '019a7b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b'
  const item = { id: 'fi_r', kind: 'ping', threadId: 'fi_r', createdAt: '2026-11-16T20:49:05.000Z', readAt: null, source: 'cos', title: 'Reply ready',
    line: 'Codex has a reply ready.', links: [{ kind: 'session', id: SID, label: 'Fix the importer', provider: 'codex' }],
    actions: [{ id: 'open_result', label: 'Open result' }], state: 'live', key: `agent:${SID}:turn:${'a'.repeat(64)}` }
  function trip(wide: boolean) {
    const h = fixture(wide), W = h.win.COSWeb, hooks: Function[] = [], went: unknown[] = []
    W.onRoute = (fn: Function) => hooks.push(fn)
    W.go = (pane: string, args: string[]) => went.push([pane, args])
    // Every scroll position written, so a test can say the newest line was never visited on the way back.
    const writes: number[] = []
    const d = Object.getOwnPropertyDescriptor(h.scroll, 'scrollTop')!
    Object.defineProperty(h.scroll, 'scrollTop', { get: d.get, set(y: number) { writes.push(y); d.set!.call(h.scroll, y) }, configurable: true })
    // Which scroller moves: from 860 px the chat column, below it the page.
    const pageBy: number[] = [], pageBy0 = h.win.scrollBy
    h.win.scrollBy = (x: number, y: number) => { pageBy.push(y); pageBy0(x, y) }
    // The chat's cards as the page has them: an earlier one near the top and the tapped one 900 px down. Their distance
    // from the top of the view moves with the scroll. keepPlace (which holds the first visible card through a repaint)
    // finds them in the feed, as it does in the browser (F1 16:3x: WebKit undid the restore through it).
    let gone = false, shift = 0, pendingShift = 0
    // A repaint can add content above the cards (older history read in): it lands when the feed is drawn again.
    let html = ''
    Object.defineProperty(h.feed, 'innerHTML', { get: () => html, set(v: string) { html = v; shift += pendingShift; pendingShift = 0 }, configurable: true })
    const centred: string[] = []
    const mk = (id: string, off: number) => ({ getBoundingClientRect: () => ({ top: off + shift - h.scroll.scrollTop, bottom: off + shift + 80 - h.scroll.scrollTop }),
      scrollIntoView: () => { centred.push(id) },
      hasAttribute: (a: string) => a === 'data-item-id', getAttribute: (a: string) => a === 'data-item-id' ? id : null })
    const card = mk('fi_r', 900), early = mk('fi_a', 100)
    const cards = () => gone ? [early] : [early, card]
    const byId = (s: string) => cards().find(c => s === `[data-item-id="${c.getAttribute('data-item-id')}"]`) ?? null
    const hostQ = h.host.querySelector, feedQ = h.feed.querySelector
    h.host.querySelector = (s: string) => byId(s) ?? hostQ(s)
    h.feed.querySelector = (s: string) => byId(s) ?? feedQ(s)
    h.feed.querySelectorAll = (s: string) => /data-item-id/.test(s) ? cards() : []
    Object.assign(h.chat._state, { caps: { jobs: true, dropIt: true }, feedMode: 'drop', feedState: 'ready', items: [item] })
    const target = wide ? h.feed : h.win
    const to = (pane: string, args: string[]) => { h.route.pane = pane; h.route.args.splice(0, h.route.args.length, ...args); return { pane, args } }
    const readBack = () => { h.emit(target, 'wheel', { deltaY: -200 }); h.scroll.scrollTop = 600; h.emit(target, 'scroll') }
    const tapOpen = () => h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'act', 'data-item': 'fi_r', 'data-act': 'open_result' }) as Record<string, string>)[k] ?? null })
    // What app.js does on each address: a new pane starts at the top of the page (route's changedPane scrollTo(0, 0),
    // the page being the scroller below 860 px), the pane loads (the chat mounts), then the route hooks run.
    let paneNow = h.route.pane
    const arrive = async (pane: string, args: string[]) => {
      const changed = pane !== paneNow; paneNow = pane
      const r = to(pane, args)
      if (changed && !wide) h.win.scrollTo(0, 0)
      if (pane === 'messages') h.chat.mount(h.host, true)
      hooks.forEach(fn => fn(r))
      await flush(); h.layout()
    }
    return { h, card, went, readBack, tapOpen, arrive, pageBy, writes, setGone: () => { gone = true }, addAbove: (px: number) => { pendingShift = px }, draw: () => { gone = false }, centred, bottom: () => h.scroll.scrollHeight - 500 }
  }
  for (const wide of [true, false]) {
    const label = wide ? 'wide feed' : 'narrow page'
    it(`${label}: Open result, then Back: the tapped card is where it was, not the newest line`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
      t.readBack()
      expect(t.card.getBoundingClientRect().top).toBe(300)
      t.tapOpen()
      expect(t.went).toEqual([['sessions', ['codex', SID]]])
      await t.arrive('sessions', ['codex', SID])
      if (!wide) t.h.scroll.scrollTop = 0   // the reader scrolled the page (narrow); wide, the chat column keeps its own
      t.pageBy.length = 0; t.writes.length = 0
      await t.arrive('messages', ['cos'])
      expect(t.card.getBoundingClientRect().top).toBe(300)
      expect(t.writes.filter(y => y >= t.bottom()), 'never at the newest line on the way back').toEqual([])
      if (wide) expect(t.pageBy, 'the wide chat scrolls its own column, never the page').toEqual([])
      else expect(t.pageBy.length, 'the narrow chat scrolls the page').toBeGreaterThan(0)
      // And it stays: a later paint does not pull him to the newest line.
      t.h.chat._paintFeed(false); t.h.layout()
      expect(t.card.getBoundingClientRect().top).toBe(300)
    })
    it(`${label}: the place is used once: after Back and a scroll to the newest line, the chat opening again moves nothing (Q1 Q17)`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      await t.arrive('messages', ['cos'])
      expect(t.card.getBoundingClientRect().top).toBe(300)
      // He reads down to the newest line himself.
      t.h.emit(wide ? t.h.feed : t.h.win, 'wheel', { deltaY: 200 }); t.h.scroll.scrollTop = t.bottom(); t.h.emit(wide ? t.h.feed : t.h.win, 'scroll')
      t.writes.length = 0
      // A list refresh opens the chat again at the same address.
      t.h.chat.mount(t.h.host, true); await flush(); t.h.layout()
      expect(t.writes, 'no scroll at all').toEqual([])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
      expect(t.h.chat._state.returnTo).toBe(null)
    })
    it(`${label}: the restore is one placement: a later repaint that adds content above still holds his place (Q1 16:4x)`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      await t.arrive('messages', ['cos'])
      expect(t.card.getBoundingClientRect().top).toBe(300)
      expect(t.h.chat._state.focusTop).toBe(null)
      // A poll repaints with 200 px of older history read in above: keepPlace holds the card he is reading.
      t.addAbove(200)
      t.h.chat._paintFeed(false); t.h.layout()
      expect(t.card.getBoundingClientRect().top).toBe(300)
    })
    it(`${label}: the kept offset belongs to the tapped card: asked for another card first, neither the skip nor the offset applies`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack()
      // A return is pending for fi_r, but the chat is asked for fi_a first (a notification link names it).
      Object.assign(t.h.chat._state, { focusItem: 'fi_a', focusTop: { item: 'fi_r', top: 300, at: Date.now() }, focusQuiet: true })
      const before = t.card.getBoundingClientRect().top
      t.addAbove(200)
      t.h.chat._paintFeed(false); t.h.layout()
      // keepPlace held the card on screen through the repaint, and fi_r's offset was not applied to fi_a; fi_a is still
      // shown, as that link asked.
      expect(t.card.getBoundingClientRect().top).toBe(before)
      expect(t.h.chat._state.focusTop).toBe(null)
      expect(t.centred).toEqual(['fi_a'])
    })
    // A Back placement still pending: the tapped card is not drawn yet (the chat is reading its lines again).
    const pendingReturn = async (wide: boolean, at: number) => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.setGone()
      Object.assign(t.h.chat._state, { feedState: 'loading', focusItem: 'fi_r', focusTop: { item: 'fi_r', top: 300, at }, focusQuiet: true })
      return t
    }
    it(`${label}: his own scroll always wins: a pending placement is dropped, and the card arriving later moves nothing`, async () => {
      const t = await pendingReturn(wide, Date.now())
      t.h.emit(wide ? t.h.feed : t.h.win, 'wheel', { deltaY: 200 }); t.h.scroll.scrollTop = 1000; t.h.emit(wide ? t.h.feed : t.h.win, 'scroll')
      expect(t.h.chat._state.focusTop).toBe(null)
      expect(t.h.chat._state.focusItem).toBe('')
      t.writes.length = 0
      t.draw(); t.h.chat._state.feedState = 'ready'
      t.h.chat._paintFeed(false); t.h.layout()
      expect(t.writes, 'nothing moved him').toEqual([])
      expect(t.h.scroll.scrollTop).toBe(1000)
      expect(t.centred).toEqual([])
    })
    it(`${label}: a placement not made within 10 seconds is dropped whole: no restore, no centring later, keepPlace back on`, async () => {
      const t = await pendingReturn(wide, Date.now() - 10001)
      t.h.scroll.scrollTop = 1000
      t.writes.length = 0
      t.draw(); t.h.chat._state.feedState = 'ready'
      t.h.chat._paintFeed(false); t.h.layout()
      expect(t.writes).toEqual([])
      expect(t.centred).toEqual([])
      expect(t.h.chat._state.focusItem).toBe('')
      expect(t.h.chat._state.focusTop).toBe(null)
    })
    it(`${label}: an expired placement found on a sticky paint opens nothing (no older questions)`, async () => {
      const t = await pendingReturn(wide, Date.now() - 10001)
      t.h.chat._state.feedState = 'ready'
      t.h.chat._paintFeed(true); t.h.layout()
      expect(t.h.chat._state.archiveOpen).toBe(false)
      expect(t.centred).toEqual([])
    })
    it(`${label}: an expired placement with its card drawn, on a sticky paint, is not restored first`, async () => {
      const t = await pendingReturn(wide, Date.now() - 10001)
      t.draw(); t.h.chat._state.feedState = 'ready'
      t.writes.length = 0
      t.h.chat._paintFeed(true); t.h.layout()
      // A sticky paint follows the newest line; the expired offset never gets a scroll of its own on the way.
      expect(t.writes.filter(y => y < t.bottom())).toEqual([])
      expect(t.centred).toEqual([])
    })
    it(`${label}: once placed, the offset is spent: the same card asked for again (a notification link) is centred`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      await t.arrive('messages', ['cos'])
      expect(t.card.getBoundingClientRect().top).toBe(300)
      t.h.chat._state.focusItem = 'fi_r'
      t.h.chat._paintFeed(false); t.h.layout()
      expect(t.centred).toEqual(['fi_r'])
    })
    it(`${label}: a reader reached any other way: back in the chat, it follows the newest line as before`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack()
      await t.arrive('sessions', [])
      await t.arrive('sessions', ['codex', SID])
      await t.arrive('messages', ['cos'])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
    })
    it(`${label}: Open result, then somewhere else before the chat: the place is dropped`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      await t.arrive('today', [])
      await t.arrive('messages', ['cos'])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
    })
    it(`${label}: Open result, then Back after more than 30 minutes: the newest line`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      t.h.chat._state.returnTo.at -= 30 * 60000 + 1
      await t.arrive('messages', ['cos'])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
    })
    it(`${label}: the tapped card is gone by the time he is back: the newest line, quietly (no older questions, no notice)`, async () => {
      const t = trip(wide), toasts: string[] = []
      t.h.win.COSWeb.toast = (s: string) => toasts.push(s)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      t.setGone()
      await t.arrive('messages', ['cos'])
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
      expect(t.h.chat._state.archiveOpen).toBe(false)
      expect(toasts).toEqual([])
    })
    // Only from 860 px: below it #/messages is the list and the chat is not shown there (messages.js chatShown).
    if (wide) it(`${label}: back at another address of the chat than the one he tapped from: the newest line`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      t.h.route.pane = 'messages'; t.h.route.args.splice(0, t.h.route.args.length)
      t.h.chat.mount(t.h.host, true); await flush(); t.h.layout()
      expect(t.h.scroll.scrollTop).toBe(t.bottom())
    })
    it(`${label}: tapped from a card's own address (a notification link): Back keeps his place, not that card centred`, async () => {
      const t = trip(wide)
      await t.arrive('messages', ['cos', 'fi_r'])
      t.readBack(); t.tapOpen()
      await t.arrive('sessions', ['codex', SID])
      if (!wide) t.h.scroll.scrollTop = 0
      await t.arrive('messages', ['cos', 'fi_r'])
      expect(t.card.getBoundingClientRect().top).toBe(300)
    })
  }
})

// 7.0.53 (Codex 3712d0a4 P2): a Reply ready row is one row per session, so a newer reply gives it a new newest item id
// and moves it to its new place in time. A quiet repaint must still hold the row he is reading.
describe('a Reply ready row being read stays put when a newer reply changes and moves it', () => {
  for (const wide of [true, false]) {
    it(`${wide ? 'wide feed' : 'narrow page'}: the row keeps its height on screen through the repaint`, async () => {
      const h = fixture(wide)
      let id = 'fi_1', off = 900, move = false, html = ''
      Object.defineProperty(h.feed, 'innerHTML', { get: () => html, set(v: string) { html = v; if (move) { id = 'fi_2'; off = 1400; move = false } }, configurable: true })
      const row = {
        getBoundingClientRect: () => ({ top: off - h.scroll.scrollTop, bottom: off + 80 - h.scroll.scrollTop }),
        hasAttribute: (a: string) => a === 'data-rr-row' || a === 'data-item-id',
        getAttribute: (a: string) => (a === 'data-rr-row' ? 'claude|A' : a === 'data-item-id' ? id : null),
      }
      const feedQ = h.feed.querySelector
      h.feed.querySelectorAll = (s: string) => (/data-item-id/.test(s) ? [row] : [])
      h.feed.querySelector = (s: string) => (s === '[data-rr-row="claude|A"]' || s === `[data-item-id="${id}"]` ? row : feedQ(s))
      h.chat.mount(h.host, true); await flush(); h.layout()
      h.emit(wide ? h.feed : h.win, 'wheel', { deltaY: -200 }); h.scroll.scrollTop = 600; h.emit(wide ? h.feed : h.win, 'scroll')
      expect(row.getBoundingClientRect().top).toBe(300)
      move = true
      h.chat._paintFeed(false); h.layout()
      expect(id).toBe('fi_2')
      expect(row.getBoundingClientRect().top).toBe(300)
    })
  }
})
