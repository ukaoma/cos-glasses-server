/**
 * 7.0.39, thread candidate 1 (Miles 11/14 08:20, pick A "notes in flow"; S1's routes, docs/cos-thread.md): the pinned
 * COS chat reads the thread's history. Runs the real panes/cos-chat.js in a vm with a fake COSWeb and a fake chat column
 * whose height follows its lines, so keeping his place can be measured.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const LINE = 100   // px a chat line takes in the fake column
const H = '/api/cos-thread/history?limit=40'

type Answer = unknown | ((path: string) => unknown)
function load(answers: Record<string, Answer>, o: { wide?: boolean } = {}) {
  const calls: string[] = []
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: () => {}, autoGrow: () => {},
    md: (s: unknown) => '<p>' + String(s) + '</p>', structureLensAnswer: (s: string) => s, skeletonRows: () => '<sk>',
    toDate: (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d }, readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, clock: (d: Date) => d.toISOString(),
    api: (path: string) => {
      calls.push(path)
      const a = answers[path] ?? answers[path.replace(/(before|after)=[^&]*/, '$1=*')]
      const v = typeof a === 'function' ? (a as (p: string) => unknown)(path) : a
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  // A chat column whose height is its lines; scrollTop is where he is.
  const feed: any = { innerHTML: '', scrollTop: 0, clientHeight: 500, hasAttribute: (a: string) => a === 'data-cos-feed',
    get scrollHeight() { return (this.innerHTML.match(/class="cc-line/g) || []).length * LINE + (this.innerHTML.match(/class="tl-day"/g) || []).length * 40 },
    getBoundingClientRect() { return { top: feed.top ?? 0 } }, contains: () => false }
  const chatEl = { offsetParent: {}, getAttribute: () => 'drop-thread-history' }
  const host: any = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? feed : sel === '[data-cos-chat]' ? chatEl : null), innerHTML: '' }
  const scrolled: number[] = []
  const window: any = { COSWeb: W, matchMedia: (q: string) => ({ matches: /min-width: 860px/.test(q) ? !!o.wide : false, addEventListener: () => {} }),
    scrollTo: () => {}, scrollBy: (_x: number, y: number) => { scrolled.push(y) }, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const document: any = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 }, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const intervals: Array<() => void> = []
  const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout, setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length }, clearInterval: () => {},
    console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: true, history: true, dropFiles: 0 }
  chat._state.host = host; chat._state.items = []; chat._state.feedState = 'ready'
  const tap = (what: string, id?: string) => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : a === 'data-id' ? id ?? null : null), closest: () => null })
  return { chat, feed, host, calls, scrolled, intervals, tap, document }
}
const day = (d: number, h = 9, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const entry = (id: string, at: string, o: Record<string, unknown> = {}) => ({ id: 't:' + id, at, kind: 'chat', question: 'Q ' + id, answer: 'A ' + id, answerChars: null, full: true, threadId: 'th_1', status: 'completed', ...o })
const page = (entries: unknown[], older: string | null, newest = 'n1', more = false) => ({ protocol: 1, entries, older, newest, more, updated: [] })

describe('7.0.39 thread candidate 1: capability', () => {
  it('history only when the thread is protocol 1 and history >= 1; New thread goes only then', () => {
    const h = load({})
    h.chat._setCaps({ capabilities: { dropIt: { enabled: true, thread: { protocol: 1, history: 1 } } } })
    expect(h.chat._historyOn()).toBe(true)
    expect(h.chat._chatSkeleton()).not.toContain('data-cos="new-thread"')
    expect(h.chat._chatSkeleton()).toContain('cc-history')
    h.chat._setCaps({ capabilities: { dropIt: { enabled: true, thread: { protocol: 1 } } } })
    expect(h.chat._historyOn()).toBe(false)
    expect(h.chat._chatSkeleton()).toContain('data-cos="new-thread"')
    h.chat._setCaps({ capabilities: { dropIt: { enabled: true, thread: { protocol: 2, history: 1 } } } })
    expect(h.chat._historyOn()).toBe(false)
    h.chat._setCaps({ capabilities: { dropIt: { enabled: false, thread: { protocol: 1, history: 1 } } } })
    expect(h.chat._historyOn()).toBe(false)
  })
})

describe('7.0.39 thread candidate 1: history in the chat', () => {
  it('opens on the newest page: his words with their time, COS’s answer, a day line per local day, the top line while older exists', async () => {
    const h = load({ [H]: page([entry('a', day(12, 20, 5)), entry('b', day(13, 14, 47), { messageNo: 472 })], 'c1') })
    h.chat._loadHistory(); await flush()
    expect(h.calls[0]).toBe(H)
    const html = h.feed.innerHTML
    expect(html).toContain('<p class="tl-start" data-hist-top>Earlier entries load as you scroll up.</p>')
    expect((html.match(/class="tl-day"/g) || []).length).toBe(2)
    expect(html.indexOf('Q a')).toBeLessThan(html.indexOf('Q b'))
    expect(html.indexOf('tl-day')).toBeLessThan(html.indexOf('Q a'))
    expect(html).toContain('<div class="cc-bubble">Q a</div><div class="cc-src">')
    expect(html).toContain('<span>Message #472</span>')
    expect(html).toContain('<span>COS</span>')
  })
  it('the start of the thread (older null): no top line', async () => {
    const h = load({ [H]: page([entry('a', day(13))], null) })
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).not.toContain('tl-start')
  })
  it('day lines: "Today, …" for today, the weekday and date otherwise, the year only when it is not this year', () => {
    const h = load({})
    const now = new Date()
    expect(h.chat._dayLabel(now)).toMatch(/^Today, /)
    const old = new Date(now.getFullYear() - 1, 0, 5)
    expect(h.chat._dayLabel(old)).toContain(String(now.getFullYear() - 1))
    const y = new Date(now.getTime() - 3 * 86400000)
    if (y.getFullYear() === now.getFullYear()) { expect(h.chat._dayLabel(y)).not.toMatch(/^Today/); expect(h.chat._dayLabel(y)).not.toContain(String(now.getFullYear())) }
  })
  it('a chat this page is still showing as an Ask is drawn once, as the Ask', async () => {
    const h = load({ [H]: page([entry('cid-1', day(13, 9)), entry('x', day(13, 8))], null) })
    h.chat._state.asks.push({ cid: 'cid-1', query: 'Live one', at: new Date(day(13, 9)).getTime(), status: 'completed', response: 'live answer' })
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).not.toContain('Q cid-1')
    expect(h.feed.innerHTML).toContain('Live one')
    expect(h.feed.innerHTML).toContain('Q x')
  })
  it('entries that are not chats or have no valid time are left out', async () => {
    const h = load({ [H]: page([entry('ok', day(13)), { id: 'b:n', at: day(13), kind: 'notification', line: 'x' }, entry('bad', 'not a date'), { ...entry('nq', day(13)), question: 5 }], null) })
    h.chat._loadHistory(); await flush()
    expect(h.chat._state.hist.entries.map((e: any) => e.id)).toEqual(['t:ok'])
  })
  it('the history cannot be read: says so with Try again, which reads it again', async () => {
    let n = 0
    const h = load({ [H]: () => (++n === 1 ? new Error('down') : page([entry('a', day(13))], null)) })
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).toContain('Couldn’t load the thread’s history.')
    expect(h.feed.innerHTML).toContain('data-cos="hist-retry"')
    h.tap('hist-retry'); await flush()
    expect(h.feed.innerHTML).toContain('Q a')
  })
})

describe('7.0.39 thread candidate 1: older entries never move him', () => {
  for (const wide of [true, false]) {
    it(`${wide ? 'open Duo (the column scrolls)' : 'phone (the page scrolls)'}: an older page goes above and the scroll takes up exactly its height`, async () => {
      const h = load({ [H]: page([entry('c', day(13, 10)), entry('d', day(13, 11)), entry('e', day(13, 12)), entry('f', day(13, 13)), entry('g', day(13, 14)), entry('h', day(13, 15))], 'c1'),
        '/api/cos-thread/history?limit=40&before=c1': page([entry('a', day(12, 10)), entry('b', day(12, 11))], 'c0') }, { wide })
      h.chat._loadHistory(); await flush()
      h.feed.scrollTop = 120
      const before = h.feed.scrollHeight, top0 = h.feed.scrollTop
      await h.chat._loadOlder(); await flush()
      const grew = h.feed.scrollHeight - before
      expect(grew).toBeGreaterThan(0)
      if (wide) expect(h.feed.scrollTop - top0, 'the column scrolled by exactly what was added above').toBe(grew)
      else expect(h.scrolled, 'the page scrolled by exactly what was added above').toEqual([grew])
      expect(h.feed.innerHTML.indexOf('Q a')).toBeLessThan(h.feed.innerHTML.indexOf('Q c'))
      expect(h.calls).toContain('/api/cos-thread/history?limit=40&before=c1')
    })
  }
  it('scrolling near the top asks for the older page once; not again while it loads; not at all far from the top', async () => {
    let release: (v: unknown) => void = () => {}
    const h = load({ [H]: page(Array.from({ length: 8 }, (_, i) => entry('n' + i, day(13, 8 + i))), 'c1'),
      '/api/cos-thread/history?limit=40&before=c1': () => new Promise(r => { release = r }) }, { wide: true })
    h.chat._loadHistory(); await flush()
    h.feed.scrollTop = 600; h.chat._onHistScroll()
    expect(h.calls.filter(c => /before=/.test(c))).toHaveLength(0)
    h.feed.scrollTop = 100; h.chat._onHistScroll(); h.chat._onHistScroll()
    expect(h.calls.filter(c => /before=/.test(c))).toHaveLength(1)
    expect(h.chat._state.hist.olderState, 'loading (its line is swapped in place in a real page; WebKit checks it)').toBe('loading')
    release(page([], null)); await flush()
    expect(h.chat._state.hist.older).toBeNull()
  })
  it('a short history fills the column by itself (no scroll can ask), at most five pages', async () => {
    const answers: Record<string, unknown> = { [H]: page([entry('z', day(13))], 'p0') }
    for (let i = 0; i < 9; i++) answers['/api/cos-thread/history?limit=40&before=p' + i] = page([entry('o' + i, day(12, 10 + i))], 'p' + (i + 1))
    const h = load(answers, { wide: true })
    h.feed.clientHeight = 100000
    h.chat._loadHistory(); await flush(60)
    expect(h.calls.filter(c => /before=/.test(c))).toHaveLength(5)
  })
  it('an older page that fails: says so in the top line with Try again; Try again reads it', async () => {
    let n = 0
    const h = load({ [H]: page([entry('c', day(13))], 'c1'), '/api/cos-thread/history?limit=40&before=c1': () => (++n === 1 ? new Error('x') : page([entry('a', day(12))], null)) }, { wide: true })
    h.feed.clientHeight = 50
    h.chat._loadHistory(); await flush()
    await h.chat._loadOlder(); await flush()
    expect(h.chat._state.hist.olderState).toBe('error')
    h.tap('hist-older'); await flush()
    expect(h.feed.innerHTML).toContain('Q a')
  })
})

describe('7.0.39 thread candidate 1: newer entries and whole answers', () => {
  it('newer entries are added below; more:true reads on from newest; updated ones are replaced where they are', async () => {
    const h = load({ [H]: page([entry('a', day(13, 9))], null, 'n1'),
      '/api/cos-thread/history?limit=40&after=n1': { protocol: 1, entries: [entry('b', day(13, 10))], updated: [entry('a', day(13, 9), { answer: 'A a revised' })], newest: 'n2', more: true, older: null },
      '/api/cos-thread/history?limit=40&after=n2': { protocol: 1, entries: [entry('c', day(13, 11))], updated: [], newest: 'n3', more: false, older: null } }, { wide: true })
    h.chat._loadHistory(); await flush()
    h.chat._loadNewer(); await flush()
    expect(h.chat._state.hist.entries.map((e: any) => e.id)).toEqual(['t:a', 't:b', 't:c'])
    expect(h.feed.innerHTML).toContain('A a revised')
    expect(h.chat._state.hist.newest).toBe('n3')
  })
  it('the poll runs every 30 s while the chat shows, and reads only after the first page', async () => {
    const h = load({ [H]: page([entry('a', day(13))], null, 'n1') })
    expect(h.intervals, 'nothing installed before the history is read').toHaveLength(0)
    h.chat._loadHistory(); await flush()
    h.chat._loadHistory(); await flush()
    expect(h.intervals, 'installed once').toHaveLength(1)
    h.intervals.forEach(f => f()); await flush()
    expect(h.calls.filter(c => /after=n1/.test(c))).toHaveLength(1)
  })
  it('"Show all of it" only when the preview is not the whole answer; it reads /entry and draws the whole answer', async () => {
    const long = entry('l', day(13), { answer: 'preview', full: false, answerChars: 5000 })
    const unknown = entry('u', day(13), { answer: 'preview2', full: false, answerChars: null })
    const short = entry('s', day(13), { answer: 'all of it', full: false, answerChars: 9 })
    const whole = entry('w', day(13), { full: true })
    const h = load({ [H]: page([long, unknown, short, whole], null), '/api/cos-thread/entry/t%3Al': { entry: { ...long, answer: 'THE WHOLE ANSWER', full: true }, source: 'live' } })
    h.chat._loadHistory(); await flush()
    expect(h.chat._histHtml(long)).toContain('data-cos="hist-full" data-id="t:l"')
    expect(h.chat._histHtml(unknown)).toContain('Show all of it')
    expect(h.chat._histHtml(short)).not.toContain('Show all of it')
    expect(h.chat._histHtml(whole)).not.toContain('Show all of it')
    h.tap('hist-full', 't:l'); await flush()
    expect(h.calls).toContain('/api/cos-thread/entry/t%3Al')
    expect(h.chat._histHtml(long)).toContain('THE WHOLE ANSWER')
    expect(h.chat._histHtml(long)).not.toContain('Show all of it')
  })
  it('the whole answer cannot be read: says so, and Show all of it stays to try again', async () => {
    const long = entry('l', day(13), { answer: 'preview', full: false, answerChars: 5000 })
    const h = load({ [H]: page([long], null), '/api/cos-thread/entry/t%3Al': new Error('x') })
    h.chat._loadHistory(); await flush()
    h.tap('hist-full', 't:l'); await flush()
    expect(h.chat._histHtml(long)).toContain('Couldn’t load the rest.')
    expect(h.chat._histHtml(long)).toContain('Show all of it')
  })
  it('the server has only the preview (entry full:false): the card says the rest was not kept, keeps the preview, no button', async () => {
    const long = entry('l', day(13), { answer: 'preview', full: false, answerChars: 5000 })
    const h = load({ [H]: page([long], null), '/api/cos-thread/entry/t%3Al': { entry: { ...long, answer: 'preview', full: false }, source: 'preview' } })
    h.chat._loadHistory(); await flush()
    h.tap('hist-full', 't:l'); await flush()
    const html = h.chat._histHtml(long)
    expect(html).toContain('The rest of this answer was not kept.')
    expect(html).not.toContain('Show all of it')
    expect(html).toContain('<p>preview</p>')
  })
  it('an answer the server no longer holds (empty preview) says so plainly, with no Show all of it', () => {
    const h = load({})
    const html = h.chat._histHtml(entry('e', day(13), { answer: '', full: false, answerChars: null }))
    expect(html).toContain('This answer was not kept.')
    expect(html).not.toContain('Show all of it')
  })
  it('his words and the answer are escaped', () => {
    const h = load({})
    const html = h.chat._histHtml(entry('x', day(13), { question: '<img src=x onerror=1>' }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})
