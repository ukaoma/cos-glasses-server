/**
 * 7.0.52 (S1; Anand's report, Work card task:personal:ce1f04b2f016): the pinned Ask COS chat (Drop it off, durable query
 * jobs on) opened empty after a reload, though his web-asked questions and answers were on the Mac and Messages listed
 * them. Runs the real panes/cos-chat.js in a vm with a fake COSWeb, as cos-thread-history-web.test.ts does.
 *
 * Fail-before on 33f8ab3e (7.0.50) and 23d60dee (7.0.51): a fresh page in Ask mode read only /api/models and painted
 * "Ask COS anything." The fix (lead 09:5x, option 1): in Ask mode, on mount, read GET /api/sessions/<today's web
 * conversation>/messages once, and draw each pair with the history card and the day lines; a number an Ask on this page
 * already shows is drawn once; 404 is nothing to show; any other error is one quiet line with Try again.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const dayKey = (x: Date) => x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate()
const TODAY = dayKey(new Date())
const YESTERDAY = dayKey(new Date(Date.now() - 86_400_000))
const MSGS = '/api/sessions/sweb0001/messages'
const EMPTY = 'Ask COS anything. Attach photos or files with the clip.'
const FAILED = 'Couldn’t load your earlier asks.'

/** A rejection the fake api gives, shaped like app.js api(): an Error with the HTTP status. */
const fail = (status: number) => ({ __fail: status })

function load(answers: Record<string, unknown>, opts: { session?: { id: string, day: string } | null, dropIt?: boolean } = {}) {
  const calls: string[] = []
  const session = opts.session === undefined ? { id: 'sweb0001', day: TODAY } : opts.session
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: () => {}, autoGrow: () => {},
    md: (s: unknown) => '<p>' + String(s) + '</p>', structureLensAnswer: (s: string) => s, skeletonRows: () => '<sk>',
    toDate: (s: string) => { const x = new Date(s); return isNaN(x.getTime()) ? null : x },
    // The page's own store after earlier visits: today's web conversation (cos-chat.js save(), C.session).
    readStore: () => (session ? { session } : {}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, clock: (x: Date) => x.toISOString(),
    api: (path: string) => {
      calls.push(path)
      const key = Object.keys(answers).find(k => path === k || path.startsWith(k + '?'))
      const v = key ? answers[key] : {}
      if (typeof v === 'function') return (v as () => Promise<unknown>)()
      if (v && typeof v === 'object' && '__fail' in (v as object)) {
        const err = new Error('The server answered ' + (v as { __fail: number }).__fail + '.') as Error & { status?: number }
        err.status = (v as { __fail: number }).__fail
        return Promise.reject(err)
      }
      return Promise.resolve(v)
    },
  }
  const feed: any = { innerHTML: '', scrollTop: 0, clientHeight: 500, scrollHeight: 0, hasAttribute: (a: string) => a === 'data-cos-feed',
    getBoundingClientRect: () => ({ top: 0 }), contains: () => false }
  // The chat is already drawn in its mode, so mount() reads, it does not redraw the skeleton.
  const mode = opts.dropIt ? 'drop' : 'ask'
  const chatEl = { offsetParent: {}, getAttribute: (a: string) => (a === 'data-mode' ? mode : null) }
  const host: any = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? feed : sel === '[data-cos-chat]' ? chatEl : null), innerHTML: '' }
  const window: any = { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, scrollBy: () => {},
    addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const document: any = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 },
    createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout, setInterval: () => 0, clearInterval: () => {},
    console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  // A public install: Drop it off (no settings file), durable query jobs on. The chat is Ask COS.
  chat._setCaps({ features: { durableQueryJobs: true }, capabilities: { dropIt: { enabled: !!opts.dropIt } } })
  return { chat, feed, host, calls }
}

// Anand's shape: #3 to #5 asked on the web today in the page's own conversation (GET /api/sessions/:id/messages's pairs).
const now = Date.now()
const pair = (no: number, at: number) => ({ query: 'Question number ' + no, text: 'Answer number ' + no, timestamp: at, sessionId: 'sweb0001', no })
const PAIRS = { messages: [pair(3, now - 30 * 60_000), pair(4, now - 20 * 60_000), pair(5, now - 10 * 60_000)] }
const msgReads = (calls: string[]) => calls.filter(c => c.startsWith('/api/sessions/')).length
const count = (html: string, s: string) => html.split(s).length - 1
const click = (what: string) => ({ getAttribute: (a: string) => (a === 'data-cos' ? what : null) })

describe('Ask COS (Drop it off): a reload keeps his earlier asks in the chat', () => {
  it('Ask mode is what a public install gets', () => {
    const h = load({})
    expect(h.chat.dropOn()).toBe(false)
    expect(h.chat.askOn()).toBe(true)
    expect(h.chat._historyOn()).toBe(false)
  })

  it('a fresh load shows the questions and answers already asked from this chat today', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    const html = h.feed.innerHTML
    expect(h.calls, 'reads: ' + JSON.stringify(h.calls)).toContain(MSGS)
    for (const n of [3, 4, 5]) {
      expect(html, 'question #' + n + ' after a reload').toContain('Question number ' + n)
      expect(html, 'answer #' + n + ' after a reload').toContain('Answer number ' + n)
      // The history card: COS, with the number quiet beside the time.
      expect(html).toContain('<span class="cc-hist-no">#' + n + '</span>')
    }
    expect(count(html, 'class="cc-line cos"')).toBe(3)
    // In time order, under one day line.
    expect(html.indexOf('Question number 3')).toBeLessThan(html.indexOf('Question number 4'))
    expect(html.indexOf('Question number 4')).toBeLessThan(html.indexOf('Question number 5'))
    expect(count(html, 'class="tl-day"')).toBe(1)
    expect(html).toContain('>Today, ')
    expect(html).not.toContain(EMPTY)
  })

  it('reads the conversation once per page, not on every mount', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    h.chat.mount(h.host, false); h.chat.mount(h.host, true); await flush()
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(1)
    expect(count(h.feed.innerHTML, 'Question number 4')).toBe(1)
  })

  it('a number an Ask on this page already shows is drawn once, as that Ask', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {} })
    h.chat._state.asks.push({ cid: 'c5', query: 'Question number 5', at: now - 10 * 60_000, status: 'completed', partial: '', response: 'Answer number 5', no: 5, sessionId: 'sweb0001', atts: [], replyKey: '', dropId: '' })
    h.chat.mount(h.host, true); await flush()
    const html = h.feed.innerHTML
    expect(count(html, 'Question number 5')).toBe(1)
    expect(html).toContain('data-ask="c5"')
    expect(html).not.toContain('<span class="cc-hist-no">#5</span>')
    for (const n of [3, 4]) expect(html).toContain('<span class="cc-hist-no">#' + n + '</span>')
  })

  it('a 404 (the conversation is gone or empty) is nothing to show', async () => {
    const h = load({ [MSGS]: fail(404), '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(1)
    expect(h.feed.innerHTML).toContain(EMPTY)
    expect(h.feed.innerHTML).not.toContain(FAILED)
  })

  it('any other failure is one quiet line with Try again, and Try again reads once more', async () => {
    const answers: Record<string, unknown> = { [MSGS]: fail(503), '/api/models': {} }
    const h = load(answers)
    h.chat.mount(h.host, true); await flush()
    let html = h.feed.innerHTML
    expect(html).toContain('<p class="tl-start" data-asks-top>' + FAILED + ' <button type="button" class="link-btn" data-cos="asks-retry">Try again</button></p>')
    expect(count(html, 'data-cos="asks-retry"')).toBe(1)
    expect(html).not.toContain(EMPTY)
    // A later mount does not read again by itself; Try again does.
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(1)
    answers[MSGS] = PAIRS
    h.chat.onClick(click('asks-retry')); await flush()
    expect(msgReads(h.calls)).toBe(2)
    html = h.feed.innerHTML
    expect(html).not.toContain(FAILED)
    for (const n of [3, 4, 5]) expect(html).toContain('Answer number ' + n)
  })

  it('a malformed answer shows nothing rather than half a card', async () => {
    const h = load({ [MSGS]: { messages: [{ query: 'Question number 9' }, null, 'x', { query: 7, text: 'y', timestamp: now },
      { query: 'Question number 6', timestamp: now - 2 * 60_000, no: 6 },
      { query: 'Question number 8', text: 'z', timestamp: 1e20 }, pair(4, now - 60_000)] }, '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    const html = h.feed.innerHTML
    expect(html).not.toContain('Question number 9')
    expect(html).not.toContain('Question number 8')
    expect(html).not.toContain('Question number 6')
    expect(html).not.toContain('This answer was not kept.')
    expect(html).not.toContain('>7<')
    expect(count(html, 'class="cc-line cos"')).toBe(1)
    expect(html).toContain('Answer number 4')
  })

  it('pairs without a number are each drawn (none folds into another)', async () => {
    const un = (q: string, at: number) => ({ query: q, text: 'Answer to ' + q, timestamp: at, sessionId: 'sweb0001' })
    const h = load({ [MSGS]: { messages: [un('First unnumbered', now - 9 * 60_000), un('Second unnumbered', now - 8 * 60_000)] }, '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    const html = h.feed.innerHTML
    expect(html).toContain('Answer to First unnumbered')
    expect(html).toContain('Answer to Second unnumbered')
    expect(html).not.toContain('class="cc-hist-no"')
  })

  it('an answer from a read that Try again replaced is dropped, whichever lands last', async () => {
    let failFirst: (e: unknown) => void = () => {}
    const first = new Promise((_, reject) => { failFirst = reject })
    const answers: Record<string, unknown> = { [MSGS]: () => first, '/api/models': {} }
    const h = load(answers)
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(1)
    answers[MSGS] = PAIRS
    h.chat.onClick(click('asks-retry')); await flush()
    expect(msgReads(h.calls)).toBe(2)
    const err = new Error('The server answered 503.') as Error & { status?: number }; err.status = 503
    failFirst(err); await flush()
    const html = h.feed.innerHTML
    expect(html).not.toContain(FAILED)
    for (const n of [3, 4, 5]) expect(html).toContain('Answer number ' + n)
  })

  it('no conversation today (none saved, or one from yesterday): nothing is read', async () => {
    for (const session of [null, { id: 'sweb0001', day: YESTERDAY }]) {
      const h = load({ [MSGS]: PAIRS, '/api/models': {} }, { session })
      h.chat.mount(h.host, true); await flush()
      expect(msgReads(h.calls), JSON.stringify(session)).toBe(0)
      expect(h.feed.innerHTML).toContain(EMPTY)
    }
  })

  it('a page left open past midnight does not read yesterday\'s conversation', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {} }, { session: null })
    // Yesterday's Ask set C.session in this page's memory (cos-chat.js doAsk); the day has since turned.
    h.chat._state.session = { id: 'sweb0001', day: YESTERDAY }
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(0)
    expect(h.feed.innerHTML).toContain(EMPTY)
  })

  it('Drop it turned on after the read: the drop chat does not draw the earlier asks', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {} })
    h.chat.mount(h.host, true); await flush()
    expect(h.feed.innerHTML).toContain('Answer number 3')
    h.chat._setCaps({ features: { durableQueryJobs: true }, capabilities: { dropIt: { enabled: true } } })
    h.chat._state.items = []; h.chat._state.feedState = 'ready'; h.chat._state.feedMode = 'drop'
    h.chat._paintFeed(true)
    expect(h.chat.dropOn()).toBe(true)
    expect(h.feed.innerHTML).not.toContain('Answer number 3')
    expect(h.feed.innerHTML).not.toContain('class="tl-day"')
  })

  it('Drop it on: the chat reads its inbox as before, not the web conversation', async () => {
    const h = load({ [MSGS]: PAIRS, '/api/models': {}, '/api/inbox/feed': { items: [] } }, { dropIt: true })
    h.chat.mount(h.host, true); await flush()
    expect(msgReads(h.calls)).toBe(0)
    expect(h.calls.some(c => c.startsWith('/api/inbox/feed'))).toBe(true)
  })

  it('control: before the reload the same page shows them from its own memory (C.asks), with no day line', async () => {
    const h = load({ '/api/models': {} }, { session: null })
    for (const n of [3, 4, 5]) h.chat._state.asks.push({ cid: 'c' + n, query: 'Question number ' + n, at: now - (6 - n) * 600_000, status: 'done', partial: '', response: 'Answer number ' + n, no: n, sessionId: 'sweb0001', atts: [], replyKey: '', dropId: '' })
    h.chat.mount(h.host, true); await flush()
    for (const n of [3, 4, 5]) expect(h.feed.innerHTML).toContain('Question number ' + n)
    expect(h.feed.innerHTML).not.toContain('class="tl-day"')
    expect(h.calls.filter(c => !c.startsWith('/api/models')), 'nothing but models is read').toEqual([])
  })
})
