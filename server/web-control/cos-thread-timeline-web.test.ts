/**
 * 7.0.41, thread candidate 3 (lead 13:36; S1's timeline, docs/cos-thread.md "Timeline"; mock A, thread_A): notes in the
 * flow beside the chats. Only with capabilities.dropIt.thread.timeline >= 1 (and the history); the same route with
 * timeline=1; quiet one-line notes that say what happened and link to the source; a notification whose card is in the
 * chat is not said twice; a message number links only in the Mac's current era; older pages still keep his place.
 * Runs the real panes/cos-chat.js in a vm with a fake COSWeb.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const LINE = 100
const HT = '/api/cos-thread/history?limit=40&timeline=1'

type Call = { path: string; opts?: { method?: string; body?: Record<string, unknown> } }
function load(answers: Record<string, unknown | ((p: string) => unknown)>, o: { wide?: boolean; caps?: Record<string, unknown> } = {}) {
  const calls: Call[] = [], toasts: string[] = [], went: unknown[][] = [], scrolledTo: string[] = []
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: (m: string) => { toasts.push(m) }, autoGrow: () => {},
    md: (s: unknown) => '<p>' + String(s) + '</p>', structureLensAnswer: (s: string) => s, skeletonRows: () => '<sk>',
    toDate: (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d }, readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: (...a: unknown[]) => { went.push(a) }, clock: (d: Date) => d.toISOString(),
    api: (path: string, opts?: Call['opts']) => {
      calls.push({ path, opts })
      const a = answers[path] ?? answers[path.replace(/(before|after)=[^&]*/, '$1=*')]
      const v = typeof a === 'function' ? (a as (p: string) => unknown)(path) : a
      if (v instanceof Promise) return v
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  // The chat column: its height is its lines (chats, notes, day lines); cards are found by their item id in the html.
  const feed: any = { innerHTML: '', scrollTop: 0, clientHeight: 500, hasAttribute: (a: string) => a === 'data-cos-feed',
    get scrollHeight() { return ((this.innerHTML.match(/class="cc-line/g) || []).length + (this.innerHTML.match(/class="cc-note"/g) || []).length) * LINE + (this.innerHTML.match(/class="tl-day"/g) || []).length * 40 },
    getBoundingClientRect() { return { top: 0, bottom: 0 } }, contains: () => false,
    querySelectorAll: () => [], querySelector: (sel: string) => null }
  const chatEl = { offsetParent: {}, getAttribute: () => 'drop-thread-only' }
  const host: any = { querySelector: (sel: string) => {
    if (sel === '[data-cos-feed]') return feed
    if (sel === '[data-cos-chat]') return chatEl
    const m = /^\[data-item-id="([^"]+)"\]$/.exec(sel)
    if (m && feed.innerHTML.includes('data-item-id="' + m[1] + '"')) return { scrollIntoView: () => { scrolledTo.push(m[1]) } }
    return null
  }, innerHTML: '' }
  const window: any = { COSWeb: W, matchMedia: (q: string) => ({ matches: /min-width: 860px/.test(q) ? !!o.wide : false, addEventListener: () => {} }),
    scrollTo: () => {}, scrollBy: () => {}, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const document: any = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 },
    createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const ctx = vm.createContext({ window, document, setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout, setInterval: () => 0, clearInterval: () => {},
    console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: true, history: true, threadOnly: true, timeline: true, dropFiles: 0, ...(o.caps || {}) }
  chat._state.host = host; chat._state.items = []; chat._state.feedState = 'ready'
  const tap = (what: string, attrs: Record<string, string> = {}) => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : attrs[a] ?? null), closest: () => null })
  return { chat, feed, calls, toasts, went, scrolledTo, tap }
}
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const chatE = (id: string, when: string) => ({ id: 't:' + id, at: when, kind: 'chat', question: 'Q ' + id, answer: 'A ' + id, answerChars: 3, full: true, threadId: 'th', status: 'completed', messageNo: null })
const note = (id: string, when: string, kind: string, o: Record<string, unknown> = {}) => ({ id: 'b:' + id.padEnd(20, '0'), at: when, kind, line: 'Line ' + id, ref: { type: kind === 'session_question' ? 'session' : kind, id: 'r_' + id }, ...o })
const page = (entries: unknown[], older: string | null = null) => ({ protocol: 1, entries, older, newest: 'c3.1.0.1.0', more: false, updated: [] })
const HEALTH = (timeline: unknown) => ({ features: { durableQueryJobs: true, cosThreadOnly: true },
  capabilities: { durableQueryJobs: true, dropIt: { enabled: true, thread: { protocol: 1, history: 1, ...(timeline === undefined ? {} : { timeline }) } } } })

describe('7.0.41 thread candidate 3: the flag and the route', () => {
  it('on only with history and thread.timeline >= 1', () => {
    const h = load({})
    h.chat._setCaps(HEALTH(1)); expect(h.chat._timelineOn()).toBe(true)
    h.chat._setCaps(HEALTH(undefined)); expect(h.chat._timelineOn()).toBe(false)
    h.chat._setCaps(HEALTH(0)); expect(h.chat._timelineOn()).toBe(false)
    h.chat._setCaps({ ...HEALTH(1), capabilities: { durableQueryJobs: true, dropIt: { enabled: true, thread: { protocol: 1, timeline: 1 } } } })
    expect(h.chat._timelineOn()).toBe(false)
  })
  it('reads the history with timeline=1 only while on', async () => {
    const h = load({ [HT]: page([]), '/api/cos-thread/history?limit=40': page([]) })
    h.chat._loadHistory(); await flush()
    expect(h.calls.some(c => c.path === HT)).toBe(true)
    const off = load({ '/api/cos-thread/history?limit=40': page([]) }, { caps: { timeline: false } })
    off.chat._loadHistory(); await flush()
    expect(off.calls.some(c => /timeline=1/.test(c.path))).toBe(false)
  })
  it('turning it on starts the history again (its cursors differ) and drops an answer still in flight', async () => {
    let release: (v: unknown) => void = () => {}
    const h = load({ '/api/cos-thread/history?limit=40': () => new Promise(r => { release = r }) }, { caps: { timeline: false } })
    h.chat._setCaps(HEALTH(undefined))
    h.chat._loadHistory()
    let changed = 0; h.chat._state.onChange = () => { changed++ }
    h.chat._setCaps(HEALTH(1))
    expect(changed).toBe(1)
    expect(h.chat._state.hist.state).toBe('idle')
    release(page([chatE('late', at(14, 9))], 'c1.old'))
    await flush()
    expect(h.chat._state.hist.entries).toEqual([])
    expect(h.chat._state.hist.older).toBe(null)
  })
  it('a note is kept only in timeline mode, only of a known kind, with its line and reference', async () => {
    const h = load({ [HT]: page([note('a', at(14, 9), 'notification'), note('b', at(14, 9, 5), 'weather'), { ...note('c', at(14, 9, 6), 'meeting'), ref: null },
      { ...note('d', at(14, 9, 7), 'message'), line: 5 }, chatE('x', at(14, 10))]) })
    h.chat._loadHistory(); await flush()
    expect(h.chat._state.hist.entries.map((e: any) => e.id)).toEqual([note('a', '', '').id, 't:x'])
  })
})

describe('7.0.41 thread candidate 3: the words of a note', () => {
  const words = (h: any, e: unknown) => h.chat._noteHtml(e).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"')
  it('a notification says what he did with it, or nothing when he did nothing', () => {
    const h = load({})
    expect(words(h, note('n', at(14, 9), 'notification', { outcome: 'dismissed' }))).toContain('COS sent “Line n”. You dismissed it.')
    expect(words(h, note('n', at(14, 9), 'notification', { outcome: 'replied', reply: { type: 'notification', id: 'r2' } }))).toContain('You replied.')
    expect(words(h, note('n', at(14, 9), 'notification', { outcome: 'seen' }))).toContain('You saw it.')
    expect(words(h, note('n', at(14, 9), 'notification', { outcome: 'acted' }))).toContain('You acted on it.')
    expect(words(h, note('n', at(14, 9), 'notification', { outcome: 'closed' }))).toContain('It was closed.')
    const none = words(h, note('n', at(14, 9), 'notification'))
    expect(none).toContain('COS sent “Line n”.')
    expect(none).not.toMatch(/You |It was/)
  })
  it('a session question shows the question and his answer, or what happened instead', () => {
    const h = load({})
    expect(words(h, note('q', at(14, 9), 'session_question', { outcome: 'answered', answer: 'Keep it first.', by: 'web' }))).toContain('A session asked “Line q”. You answered “Keep it first.”.')
    expect(words(h, note('q', at(14, 9), 'session_question', { outcome: 'moved_on' }))).toContain('The session moved on before an answer.')
    expect(words(h, note('q', at(14, 9), 'session_question', { outcome: 'session_ended' }))).toContain('The session ended before an answer.')
    expect(words(h, note('q', at(14, 9), 'session_question', { outcome: 'aged_out' }))).toContain('It went unanswered.')
    const open = h.chat._noteHtml(note('q', at(14, 9), 'session_question'))
    expect(open).toMatch(/A <button[^>]*>session<\/button> asked “Line q”\.<\/span>/)
  })
  it('a meeting shows its title', () => {
    const h = load({})
    const e = { ...note('m', at(14, 9), 'meeting'), line: 'Friday Focus', ref: { type: 'meeting', domain: 'quilt', month: '2026-11', filename: 'focus.md' } }
    expect(words(h, e)).toContain('Meeting recorded: Friday Focus')
    expect(h.chat._noteHtml(e)).toContain('data-domain="quilt" data-month="2026-11" data-file="focus.md"')
  })
  it('a message says "Asked on glasses" only when the row says glasses; the number links only in the current era', () => {
    const h = load({})
    h.chat._state.msgEra = 'era-2'
    const m = (o: Record<string, unknown>) => ({ ...note('g', at(14, 9), 'message'), line: 'How is traffic on 183?', ref: { type: 'message', no: 1039, era: 'era-2' }, ...o })
    expect(words(h, m({ surface: 'glasses' }))).toContain('Asked on glasses: “How is traffic on 183?” #1039')
    expect(words(h, m({ surface: 'web' }))).toContain('Asked in Messages: “How is traffic on 183?” #1039')
    expect(words(h, m({}))).toContain('Asked in Messages:')
    expect(words(h, m({ surface: 'mac' }))).toContain('Asked in Messages:')
    expect(h.chat._noteHtml(m({}))).toContain('data-cos="tl-open" data-kind="message" data-no="1039"')
    expect(h.chat._noteHtml(m({ ref: { type: 'message', no: 1039, era: 'era-1' } }))).not.toContain('data-kind="message"')
    expect(h.chat._noteHtml(m({ ref: { type: 'message', no: 1039, era: 'era-1' } }))).toContain('<span class="cc-note-no">#1039</span>')
    h.chat._state.msgEra = ''
    expect(h.chat._noteHtml(m({}))).not.toContain('data-kind="message"')
  })
  it('quiet: one line with its time, no box, label, pill, chip or icon', () => {
    const h = load({})
    const html = h.chat._noteHtml(note('n', at(14, 9, 14), 'notification', { outcome: 'dismissed' }))
    expect(html).toMatch(/^<p class="cc-note" data-hist="b:n0+"><span><\/span><span class="cc-note-text">.*<\/span><span class="cc-note-t">9:14/)
    expect(html).not.toMatch(/cc-card|cc-avatar|<svg|cx-tag|chip|pill|eyebrow|cc-card-title/)
  })
  it('the line and answer are escaped, for every kind', () => {
    const h = load({})
    const html = h.chat._noteHtml({ ...note('x', at(14, 9), 'session_question', { outcome: 'answered', answer: '<b>no</b>' }), line: '<img src=x>' })
    expect(html).not.toContain('<img'); expect(html).not.toContain('<b>')
    for (const kind of ['notification', 'meeting', 'message']) {
      const one = h.chat._noteHtml({ ...note('y', at(14, 9), kind), line: '<img src=x>', ref: kind === 'meeting' ? { type: 'meeting', domain: 'd', month: 'm', filename: 'f' } : { type: kind, id: 'r', no: 3, era: 'E' } })
      expect(one, kind).not.toContain('<img')
    }
  })
  it('a note sent while the timeline is off is dropped (the page asked for chats only)', async () => {
    const h = load({ '/api/cos-thread/history?limit=40': page([note('n', at(14, 9), 'notification'), chatE('a', at(14, 10))]) }, { caps: { timeline: false } })
    h.chat._loadHistory(); await flush()
    expect(h.chat._state.hist.entries.map((e: any) => e.id)).toEqual(['t:a'])
  })
})

describe('7.0.41 thread candidate 3: notes in the chat', () => {
  it('notes sit between chats by time, under the day lines', async () => {
    const h = load({ [HT]: page([chatE('a', at(13, 20)), note('n', at(14, 9), 'notification', { outcome: 'dismissed' }), chatE('b', at(14, 14))]) })
    h.chat._loadHistory(); await flush()
    const html = h.feed.innerHTML
    const ia = html.indexOf('Q a'), id2 = html.indexOf('class="tl-day"', ia), inote = html.indexOf('class="cc-note"'), ib = html.indexOf('Q b')
    expect(ia).toBeGreaterThan(-1); expect(id2).toBeGreaterThan(ia); expect(inote).toBeGreaterThan(id2); expect(ib).toBeGreaterThan(inote)
  })
  it('a notification whose card is in the chat is not said twice; without its card the note shows', async () => {
    const h = load({ [HT]: page([note('n', at(14, 9), 'notification'), note('o', at(14, 9, 1), 'notification')]) })
    h.chat._state.items = [{ id: 'r_n', kind: 'followup', line: 'x', state: 'live', createdAt: at(14, 9), threadId: 't1' }]
    h.chat._loadHistory(); await flush()
    expect(h.feed.innerHTML).not.toContain('data-id="r_n"')
    expect(h.feed.innerHTML).toContain('data-id="r_o"')
  })
  it('an outcome that changes later replaces the note in place', async () => {
    const h = load({ [HT]: page([note('n', at(14, 9), 'notification')]),
      [HT + '&after=*']: { entries: [], updated: [note('n', at(14, 9), 'notification', { outcome: 'dismissed' })], newest: 'c3.1.0.1.1', more: false } })
    h.chat._loadHistory(); await flush()
    h.chat._loadNewer(); await flush()
    expect(h.feed.innerHTML).toContain('You dismissed it.')
    expect((h.feed.innerHTML.match(/class="cc-note"/g) || []).length).toBe(1)
  })
  it('reads the era once with the timeline, and links the numbers after it', async () => {
    const h = load({ [HT]: page([{ ...note('g', at(14, 9), 'message'), ref: { type: 'message', no: 7, era: 'E' } }]), '/api/message-counter': { max: 9, era: 'E' } })
    h.chat._loadHistory(); await flush()
    expect(h.calls.filter(c => c.path === '/api/message-counter').length).toBe(1)
    expect(h.feed.innerHTML).toContain('data-kind="message" data-no="7"')
    h.chat._state.hist.state = 'idle'; h.chat._loadHistory(); await flush()
    expect(h.calls.filter(c => c.path === '/api/message-counter').length).toBe(1)
  })
  it('an older page with notes in it keeps his place (the column takes the added height)', async () => {
    const h = load({ [HT]: page([chatE('b', at(14, 14))], 'c2.1.0'),
      [HT + '&before=*']: page([note('n', at(14, 9), 'notification'), chatE('a', at(14, 8)), note('m', at(14, 10), 'meeting')]) }, { wide: true })
    h.chat._loadHistory(); await flush()
    h.feed.scrollTop = 50
    const before = h.feed.scrollHeight
    await h.chat._loadOlder(); await flush()
    expect(h.feed.scrollTop - 50).toBe(h.feed.scrollHeight - before)
    expect((h.feed.innerHTML.match(/class="cc-note"/g) || []).length).toBe(2)
  })
})

describe('7.0.41 thread candidate 3: each note opens its source', () => {
  it('a session, a meeting and a message go to their own pages', () => {
    const h = load({})
    h.tap('tl-open', { 'data-kind': 'session', 'data-provider': 'claude', 'data-sid': 's1' })
    h.tap('tl-open', { 'data-kind': 'meeting', 'data-domain': 'quilt', 'data-month': '2026-11', 'data-file': 'f.md' })
    h.tap('tl-open', { 'data-kind': 'message', 'data-no': '1039' })
    expect(h.went).toEqual([['sessions', ['claude', 's1']], ['meetings', ['quilt', '2026-11', 'f.md']], ['messages', ['m', '1039']]])
  })
  it('a notification card in the chat is scrolled to', () => {
    const h = load({})
    h.feed.innerHTML = '<div class="cc-line cos" data-item-id="fi_1"></div>'
    h.tap('tl-open', { 'data-kind': 'notification', 'data-id': 'fi_1' })
    expect(h.scrolledTo).toEqual(['fi_1'])
    expect(h.calls.some(c => c.path === '/api/inbox/archive')).toBe(false)
  })
  it('one filed under the older questions: they open, and it is scrolled to once read', async () => {
    const h = load({ '/api/inbox/archive': { items: [{ id: 'fi_2', kind: 'followup', line: 'old', state: 'live', createdAt: at(1, 9), threadId: 't2', archived: true }] } })
    h.chat._state.summary = { archived: 1 }
    h.tap('tl-open', { 'data-kind': 'notification', 'data-id': 'fi_2' }); await flush()
    expect(h.calls.some(c => c.path === '/api/inbox/archive')).toBe(true)
    expect(h.scrolledTo).toEqual(['fi_2'])
    expect(h.toasts).toEqual([])
  })
  it('one no longer kept says so', async () => {
    const h = load({ '/api/inbox/archive': { items: [] } })
    h.tap('tl-open', { 'data-kind': 'notification', 'data-id': 'fi_gone' }); await flush()
    expect(h.toasts).toEqual(['That notification is no longer kept in this chat.'])
    expect(h.scrolledTo).toEqual([])
  })
})
