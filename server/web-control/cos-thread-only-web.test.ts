/**
 * 7.0.39, thread candidate 2 (lead 10:38; S1's contract ca33273e, docs/cos-thread.md "Thread-only chats"): an Ask from the
 * pinned thread's composer carries cosThread only when /api/health says features.cosThreadOnly, reads the thread with
 * ?threadOnly=1, keeps its own pending card until the history has the chat, draws the four job states, asks again as the
 * next generation of the same chat, reattaches a running chat it did not send, and says the two refusals in words.
 * Runs the real panes/cos-chat.js in a vm with a fake COSWeb.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const H = '/api/cos-thread/history?limit=40'
const err = (status: number, code: string, message = code) => Object.assign(new Error(message), { status, code })

type Call = { path: string; opts?: { method?: string; body?: Record<string, unknown> } }
type Answer = unknown | ((path: string, opts?: Call['opts']) => unknown)
function load(answers: Record<string, Answer>, caps: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: () => {}, autoGrow: () => {},
    md: (s: unknown) => '<p>' + String(s) + '</p>', structureLensAnswer: (s: string) => s, skeletonRows: () => '<sk>',
    toDate: (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d }, readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, clock: (d: Date) => d.toISOString(),
    api: (path: string, opts?: Call['opts']) => {
      calls.push({ path, opts })
      const key = (opts && opts.method === 'POST' ? 'POST ' : '') + path
      const a = answers[key] ?? answers[key.replace(/(before|after)=[^&]*/, '$1=*')]
      const v = typeof a === 'function' ? (a as (p: string, o?: Call['opts']) => unknown)(path, opts) : a
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  const feed: any = { innerHTML: '', scrollTop: 0, scrollHeight: 0, clientHeight: 500, hasAttribute: (a: string) => a === 'data-cos-feed',
    getBoundingClientRect() { return { top: 0, bottom: 0 } }, contains: () => false, querySelectorAll: () => [], querySelector: () => null }
  const chatEl = { offsetParent: {}, getAttribute: () => 'drop-thread-only' }
  const host: any = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? feed : sel === '[data-cos-chat]' ? chatEl : null), innerHTML: '' }
  const window: any = { COSWeb: W, matchMedia: (q: string) => ({ matches: false, addEventListener: () => {}, q }),
    scrollTo: () => {}, scrollBy: () => {}, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const document: any = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 },
    createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  // Timers are held until run(): a running job's poll would otherwise loop for its whole 20 minutes.
  const timers: Array<() => void> = []
  const run = () => { const now = timers.splice(0); now.forEach(fn => fn()) }
  const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: true, history: true, threadOnly: true, dropFiles: 0, ...caps }
  chat._state.host = host; chat._state.items = []; chat._state.feedState = 'ready'
  const tap = (what: string, o: Record<string, string> = {}) => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : o[a] ?? null), closest: () => null })
  const posts = (path: string) => calls.filter(c => c.path === path && c.opts && c.opts.method === 'POST').map(c => c.opts!.body!)
  return { chat, feed, calls, posts, tap, run, W }
}
const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).toISOString()
const entry = (id: string, o: Record<string, unknown> = {}) => ({ id: 't:' + id, at: at(9), kind: 'chat', question: 'Q ' + id, answer: 'A ' + id, answerChars: 3, full: true, threadId: 'th_1', status: 'completed', messageNo: null, ...o })
const page = (entries: unknown[], newest = 'c1.1.0') => ({ protocol: 2, entries, older: null, newest, more: false, updated: [] })
const HEALTH = (only: boolean | undefined) => ({ features: { durableQueryJobs: true, ...(only === undefined ? {} : { cosThreadOnly: only }) },
  capabilities: { durableQueryJobs: true, dropIt: { enabled: true, thread: { protocol: 1, history: 1 } } } })
const THREAD = { thread: { id: 'th_1', asks: 3, sessionId: 's_thread' }, next: { mode: 'continue', sessionId: 's_thread' } }
const job = (o: Record<string, unknown> = {}) => ({ job: { jobId: 'j1', status: 'running', sessionId: 's_thread', ...o } })

describe('7.0.39 thread candidate 2: the flag', () => {
  it('only /api/health features.cosThreadOnly === true turns it on, and only with the history', () => {
    const h = load({})
    h.chat._setCaps(HEALTH(true)); expect(h.chat._threadOnlyOn()).toBe(true)
    h.chat._setCaps(HEALTH(undefined)); expect(h.chat._threadOnlyOn()).toBe(false)
    h.chat._setCaps(HEALTH(false)); expect(h.chat._threadOnlyOn()).toBe(false)
    h.chat._setCaps({ ...HEALTH(true), features: { cosThreadOnly: 'true' } }); expect(h.chat._threadOnlyOn()).toBe(false)
    // Advertised in capabilities instead of features: not this contract.
    h.chat._setCaps({ capabilities: { ...HEALTH(true).capabilities, cosThreadOnly: true } }); expect(h.chat._threadOnlyOn()).toBe(false)
    // No history routes: a thread-only chat could not be seen again, so it is not sent as one.
    h.chat._setCaps({ features: { cosThreadOnly: true }, capabilities: { durableQueryJobs: true, dropIt: { enabled: true, thread: { protocol: 1 } } } })
    expect(h.chat._threadOnlyOn()).toBe(false)
  })
  it('the header reads the mock’s words, with no thread line and no New thread; without the flag it is as before', () => {
    const h = load({})
    h.chat._setCaps(HEALTH(true))
    const on = h.chat._chatSkeleton()
    expect(on).toContain('<p class="cc-sub">One running thread. What you ask here stays here.</p>')
    expect(on).toContain('data-mode="drop-thread-only"')
    expect(on).not.toContain('data-cos-thread')
    expect(on).not.toContain('data-cos="new-thread"')
    h.chat._setCaps(HEALTH(undefined))
    const off = h.chat._chatSkeleton()
    expect(off).toContain('Text it anything: a thought, an ask, a reminder. It texts back.')
    expect(off).toContain('data-cos-thread')
    expect(off).toContain('data-mode="drop-thread-history"')
  })
})

describe('7.0.39 thread candidate 2: an Ask from the thread', () => {
  it('reads ?threadOnly=1, sends cosThread with source web, keeps its pending card, and posts no turn', async () => {
    let body: any = null
    const h = load({ '/api/cos-thread?threadOnly=1': THREAD, 'POST /api/query-jobs': (_p: string, o: any) => { body = o.body; return job() } })
    h.chat._submitAsk('What changed today?', null, () => {}, {})
    // Before the job is taken: his words and a COS card, nothing numbered, no glasses line.
    expect(h.feed.innerHTML).toContain('What changed today?')
    expect(h.feed.innerHTML).toContain('data-ask-title>COS</span>')
    expect(h.feed.innerHTML).not.toContain('Asked on the web')
    await flush()
    expect(h.calls.some(c => c.path === '/api/cos-thread?threadOnly=1')).toBe(true)
    expect(h.calls.some(c => c.path === '/api/cos-thread')).toBe(false)
    expect(body).toMatchObject({ source: 'web', cosThread: true, generation: 1, sessionId: 's_thread' })
    expect(body.cosThread).toBe(true)
    expect(h.feed.innerHTML).toContain('<span class="cc-wait">COS is answering.</span>')
    expect(h.feed.innerHTML).not.toContain('lands in Messages')
    // The history now has the chat (the turn appears when the job starts): it is drawn once, as this page's card.
    const cid = body.clientJobId
    h.chat._state.hist.entries = [entry(cid, { status: 'running', answer: '', answerChars: null, full: false, clientJobId: cid, generation: 1 })]
    h.chat._paintFeed(false)
    expect((h.feed.innerHTML.match(/What changed today\?/g) || []).length).toBe(1)
    expect(h.feed.innerHTML).toContain('data-ask="' + cid + '"')
    // It ends: the server wrote the turn, so the page posts none.
    const a = h.chat._state.asks[0]
    a.status = 'completed'; a.response = 'Three things.'
    h.chat._finished(a)
    await flush()
    expect(h.posts('/api/cos-thread/turn')).toEqual([])
  })
  it('without the flag: the old read and an ordinary Ask (no cosThread), and its turn is posted', async () => {
    let body: any = null
    const h = load({ '/api/cos-thread': THREAD, 'POST /api/query-jobs': (_p: string, o: any) => { body = o.body; return job({ globalMsgNum: 1050 }) } }, { threadOnly: false })
    h.chat._submitAsk('Plain ask', null, () => {}, {})
    await flush()
    expect(h.calls.some(c => c.path === '/api/cos-thread?threadOnly=1')).toBe(false)
    expect(body).not.toHaveProperty('cosThread')
    const a = h.chat._state.asks[0]
    a.status = 'completed'; a.response = 'Done.'
    h.chat._finished(a)
    await flush()
    expect(h.posts('/api/cos-thread/turn').length).toBe(1)
  })
  it('a Reply from the message reader never carries cosThread, and keeps its turn’s conversation', async () => {
    let body: any = null
    const h = load({ 'POST /api/query-jobs': (_p: string, o: any) => { body = o.body; return job({ globalMsgNum: 1051 }) } })
    h.chat._submitAsk('Reply words', null, () => {}, { replyKey: 'r1', sessionId: 's_turn' })
    await flush()
    expect(body).not.toHaveProperty('cosThread')
    expect(body.sessionId).toBe('s_turn')
    expect(h.chat._state.asks[0].threadOnly).toBe(false)
  })
  it('the chat is drawn again when only the flag changes', () => {
    const h = load({})
    let n = 0
    h.chat._setCaps(HEALTH(undefined))
    h.chat._state.onChange = () => { n++ }
    h.chat._setCaps(HEALTH(true))
    expect(n).toBe(1)
  })
  it('a fresh start for thread_only carries the digest and no sessionId', async () => {
    let body: any = null
    const h = load({ '/api/cos-thread?threadOnly=1': { thread: { id: 'th_2', asks: 0 }, next: { mode: 'fresh', reason: 'thread_only', digest: 'Earlier: the 7.0.38 install.' } },
      'POST /api/query-jobs': (_p: string, o: any) => { body = o.body; return job() } })
    h.chat._submitAsk('Next?', null, () => {}, {})
    await flush()
    expect(body.cosThread).toBe(true)
    expect(body).not.toHaveProperty('sessionId')
    expect(body.reference).toEqual({ query: 'Summary carried over from earlier in this COS thread', response: 'Earlier: the 7.0.38 install.' })
  })
  it('409 thread_session_web_only: says so, keeps his words, and reads /api/health again', async () => {
    let ok: boolean | null = null
    const h = load({ '/api/cos-thread?threadOnly=1': THREAD, 'POST /api/query-jobs': err(409, 'thread_session_web_only', 'That conversation is the pinned COS thread. Ask from the thread.'),
      '/api/health': HEALTH(true) })
    h.chat._submitAsk('Hi', null, (v: boolean) => { ok = v }, {})
    await flush()
    expect(ok).toBe(false)
    expect(h.feed.innerHTML).toContain('Not sent. This page asked outside your COS thread, so it checked your Mac again. Ask again. Your words are still in the box.')
    expect(h.calls.filter(c => c.path === '/api/health').length).toBe(1)
  })
  it('400 invalid_cos_thread: says so in words, with the code', async () => {
    const h = load({ '/api/cos-thread?threadOnly=1': THREAD, 'POST /api/query-jobs': err(400, 'invalid_cos_thread', 'cosThread is true or absent.') })
    h.chat._submitAsk('Hi', null, () => {}, {})
    await flush()
    expect(h.feed.innerHTML).toContain('Not sent. Your Mac did not take this page’s thread mark (invalid_cos_thread). Reload the page, then ask again. Your words are still in the box.')
    expect(h.calls.some(c => c.path === '/api/health')).toBe(false)
  })
})

describe('7.0.39 thread candidate 2: the four job states in the history', () => {
  const states = () => {
    const h = load({ [H]: page([
      entry('run1', { status: 'running', answer: '', answerChars: null, full: false, clientJobId: 'run1', generation: 1 }),
      entry('fail1', { status: 'failed', answer: 'Partial words', answerChars: 5000, full: false, clientJobId: 'fail1', generation: 1 }),
      entry('stop1', { status: 'interrupted', answer: 'Started to', answerChars: 10, full: false, clientJobId: 'stop1', generation: 2 }),
      entry('done1', { status: 'completed', answer: 'All of it', answerChars: 9, full: true, clientJobId: 'done1', generation: 1 }),
      entry('nojob', { status: 'failed', answer: '', answerChars: null, full: false, generation: 1 }),
      entry('nogen', { status: 'failed', answer: '', answerChars: null, full: false, clientJobId: 'nogen' }),
    ]), '/api/query-jobs/by-client/run1?generation=1': err(404, 'not_found') })
    return h
  }
  it('running reads COS is answering; failed and stopped show what came through, say so, and offer Ask again; completed is whole', async () => {
    const h = states()
    h.chat._loadHistory(); await flush()
    const html = h.feed.innerHTML
    expect(html).toContain('<span class="cc-wait">COS is answering.</span>')
    expect(html).toContain('<p>Partial words</p>')
    expect(html).toContain('<span class="cc-fine">This ask did not finish.</span>')
    expect(html).toContain('<p>Started to</p>')
    expect(html).toContain('<span class="cc-fine">This ask was stopped before it finished.</span>')
    expect(html).toContain('data-cos="hist-again" data-id="t:fail1"')
    expect(html).toContain('data-cos="hist-again" data-id="t:stop1"')
    expect(html).not.toContain('data-cos="hist-again" data-id="t:done1"')
    // No job identity (a row from before candidate 2), or no generation: nothing to ask again with.
    expect(html).not.toContain('data-cos="hist-again" data-id="t:nojob"')
    expect(html).not.toContain('data-cos="hist-again" data-id="t:nogen"')
    expect(html).toContain('This ask did not finish.</span>')
    // A partial answer has no rest to show.
    expect(html).not.toContain('data-cos="hist-full" data-id="t:fail1"')
    expect(html).toContain('<p>All of it</p>')
  })
  it('without the flag, no Ask again (the next generation would be an ordinary Ask)', async () => {
    const h = states()
    h.chat._state.caps.threadOnly = false
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).not.toContain('data-cos="hist-again"')
    expect(h.feed.innerHTML).toContain('This ask did not finish.')
  })
})

describe('7.0.39 thread candidate 2: Ask again is the next generation of the same chat', () => {
  it('from a history card: the same clientJobId, generation + 1, cosThread, no sessionId, one entry, polled at that generation', async () => {
    let body: any = null
    const h = load({ [H]: page([entry('stop1', { status: 'interrupted', answer: 'Started to', answerChars: 10, full: false, clientJobId: 'stop1', generation: 2 })]),
      'POST /api/query-jobs': (_p: string, o: any) => { body = o.body; return job({ jobId: 'j9' }) }, '/api/query-jobs/j9?generation=3&trail=1': job({ jobId: 'j9', status: 'completed', response: 'Now whole.' }) })
    h.chat._loadHistory(); await flush()
    h.tap('hist-again', { 'data-id': 't:stop1' })
    // While it is admitted: one card for the chat, his words once.
    expect((h.feed.innerHTML.match(/Q stop1/g) || []).length).toBe(1)
    await flush()
    expect(body).toMatchObject({ clientJobId: 'stop1', generation: 3, query: 'Q stop1', source: 'web', cosThread: true })
    expect(body).not.toHaveProperty('sessionId')
    expect(body).not.toHaveProperty('reference')
    h.run(); await flush()
    expect(h.calls.some(c => c.path === '/api/query-jobs/j9?generation=3&trail=1')).toBe(true)
    expect((h.feed.innerHTML.match(/Q stop1/g) || []).length).toBe(1)
    expect(h.feed.innerHTML).toContain('<p>Now whole.</p>')
  })
  it('a second tap while one is admitted sends nothing more', async () => {
    let n = 0
    const h = load({ [H]: page([entry('f', { status: 'failed', answer: 'x', answerChars: 1, full: false, clientJobId: 'f', generation: 1 })]),
      'POST /api/query-jobs': () => { n++; return new Promise(() => {}) } })
    h.chat._loadHistory(); await flush()
    h.tap('hist-again', { 'data-id': 't:f' }); h.tap('hist-again', { 'data-id': 't:f' })
    await flush()
    expect(n).toBe(1)
  })
  it('refused: the history card stays, says why, and Ask again is offered again', async () => {
    const h = load({ [H]: page([entry('f', { status: 'failed', answer: 'x', answerChars: 1, full: false, clientJobId: 'f', generation: 1 })]),
      'POST /api/query-jobs': err(409, 'thread_session_web_only'), '/api/health': HEALTH(true) })
    h.chat._loadHistory(); await flush()
    h.tap('hist-again', { 'data-id': 't:f' }); await flush()
    expect(h.feed.innerHTML).toContain('data-hist="t:f"')
    expect(h.feed.innerHTML).toContain('<span class="cc-fine warn">Not sent. This page asked outside your COS thread, so it checked your Mac again. Ask again.</span>')
    expect(h.feed.innerHTML).toMatch(/data-cos="hist-again" data-id="t:f">Ask again</)
  })
  it('from this page’s own failed card: the same clientJobId at generation 2, replacing the card', async () => {
    const bodies: any[] = []
    let n = 0
    const h = load({ '/api/cos-thread?threadOnly=1': THREAD,
      'POST /api/query-jobs': (_p: string, o: any) => { bodies.push(o.body); n++; return job({ jobId: 'j' + n }) },
      '/api/query-jobs/j1?generation=1&trail=1': job({ jobId: 'j1', status: 'failed', partialText: 'half', error: { code: 'provider_timeout' } }) })
    h.chat._submitAsk('Long one', null, () => {}, {})
    await flush(); h.run(); await flush()
    const a = h.chat._state.asks[0]
    expect(a.status).toBe('failed')
    expect(h.feed.innerHTML).toContain('data-cos="again"')
    await h.chat._askAgain(a.cid)
    expect(bodies[1]).toMatchObject({ clientJobId: bodies[0].clientJobId, generation: 2, cosThread: true, query: 'Long one' })
    expect(bodies[1]).not.toHaveProperty('sessionId')
    expect(h.chat._state.asks.length).toBe(1)
    expect(h.chat._state.asks[0].gen).toBe(2)
  })
})

describe('7.0.39 thread candidate 2: reattach a running chat this page did not send', () => {
  it('finds the job by client id and generation, follows it as a live card, once', async () => {
    const h = load({ [H]: page([entry('r', { status: 'running', answer: '', answerChars: null, full: false, clientJobId: 'r', generation: 2 })]),
      '/api/query-jobs/by-client/r?generation=2': job({ jobId: 'jr', partialText: 'So far' }),
      '/api/query-jobs/jr?generation=2&trail=1': job({ jobId: 'jr', status: 'completed', response: 'Done now.' }) })
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).toContain('data-ask="r"')
    expect(h.feed.innerHTML).toContain('<p>So far</p>')
    expect(h.feed.innerHTML).not.toContain('data-hist="t:r"')
    h.chat._reattach(); await flush()
    expect(h.calls.filter(c => c.path === '/api/query-jobs/by-client/r?generation=2').length).toBe(1)
    h.run(); await flush()
    expect(h.calls.some(c => c.path === '/api/query-jobs/jr?generation=2&trail=1')).toBe(true)
    expect(h.feed.innerHTML).toContain('<p>Done now.</p>')
    expect(h.posts('/api/cos-thread/turn')).toEqual([])
  })
  it('a job not found stays the history card, and is not asked for again on the next read', async () => {
    const h = load({ [H]: page([entry('r', { status: 'running', answer: '', answerChars: null, full: false, clientJobId: 'r', generation: 1 })]),
      '/api/query-jobs/by-client/r?generation=1': err(404, 'not_found') })
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).toContain('data-hist="t:r"')
    expect(h.feed.innerHTML).toContain('COS is answering.')
    h.chat._reattach(); await flush()
    expect(h.calls.filter(c => c.path.indexOf('/by-client/r') >= 0).length).toBe(1)
  })
  it('a job already ended is not adopted: the newer entries are read for its end', async () => {
    const h = load({ [H]: page([entry('r', { status: 'running', answer: '', answerChars: null, full: false, clientJobId: 'r', generation: 1 })]),
      '/api/query-jobs/by-client/r?generation=1': job({ status: 'completed', response: 'x' }),
      [H + '&after=*']: { entries: [], updated: [entry('r', { status: 'completed', answer: 'Ended.', answerChars: 6, full: true, clientJobId: 'r', generation: 1 })], newest: 'c1.1.1' } })
    h.chat._loadHistory(); await flush()
    expect(h.chat._state.asks.length).toBe(0)
    expect(h.calls.some(c => c.path.indexOf('&after=') >= 0)).toBe(true)
    expect(h.feed.innerHTML).toContain('<p>Ended.</p>')
  })
  it('one this page is already showing is never reattached', async () => {
    const h = load({ '/api/cos-thread?threadOnly=1': THREAD, 'POST /api/query-jobs': job() })
    h.chat._submitAsk('Mine', null, () => {}, {})
    await flush()
    const cid = h.chat._state.asks[0].cid
    h.chat._state.hist.state = 'ready'
    h.chat._state.hist.entries = [entry(cid, { status: 'running', answer: '', answerChars: null, full: false, clientJobId: cid, generation: 1 })]
    h.chat._reattach(); await flush()
    expect(h.calls.some(c => c.path.indexOf('/by-client/') >= 0)).toBe(false)
  })
})
