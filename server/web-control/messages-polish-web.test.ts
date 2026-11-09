/**
 * 7.0.9 (Miles 11/08, Control Web on the unfolded Duo): the Messages fixes, driven through the real panes/cos-chat.js in
 * a vm with a fake COSWeb and document (the cos-thread-web.test.ts harness).
 *  1. The rail badge counts net new only; the pinned row's "waiting" is the chat's own replies, never Work's 284.
 *  2. A finished Ask with no words never shows "COS is answering" (Message #463), and reads the answer from Messages.
 *  3. A running Ask shows its steps (the job trail, ?trail=1 on the poll it already runs), then a quiet "N steps".
 *  4. An Ask that sent a message to another session says where it went, opens it, and shows that session's reply.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

function railButton() {
  const kids: Array<{ cls: Set<string>; attrs: Record<string, string>; textContent: string }> = []
  const mk = () => {
    const el = { cls: new Set<string>(), attrs: {} as Record<string, string>, textContent: '',
      set className(v: string) { v.split(' ').forEach(c => el.cls.add(c)) },
      setAttribute(k: string, v: string) { el.attrs[k] = v },
      classList: { add: (c: string) => el.cls.add(c), toggle: (c: string, on: boolean) => { if (on) el.cls.add(c); else el.cls.delete(c) } } }
    return el
  }
  const b = {
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { b.attrs[k] = v },
    appendChild(el: any) { kids.push(el) },
    querySelector(sel: string) { const key = sel.slice(1, -1); return kids.find(k => key in k.attrs) ?? null },
    count() { const c = kids.find(k => 'data-inbox-count' in k.attrs)!; return c.cls.has('hidden') ? '' : c.textContent },
    dot() { return !kids.find(k => 'data-inbox-dot' in k.attrs)!.cls.has('hidden') },
  }
  return { b, mk }
}

type Answer = unknown | ((body: any) => unknown)
// One card in the page, for the in-place repaint: its body, steps and relay slots hold innerHTML and attributes.
function fakeCard() {
  const part = () => { const p = { innerHTML: '', attrs: {} as Record<string, string>, textContent: '',
    getAttribute: (k: string) => (k in p.attrs ? p.attrs[k] : null), setAttribute: (k: string, v: string) => { p.attrs[k] = v }, removeAttribute: (k: string) => { delete p.attrs[k] } }; return p }
  const parts: Record<string, ReturnType<typeof part>> = { '[data-ask-title]': part(), '[data-ask-state]': part(), '[data-ask-body]': part(), '[data-ask-steps]': part(), '[data-ask-relay-slot]': part() }
  parts['[data-ask-body]'].innerHTML = '<span class="cc-wait">COS is answering. It also lands in Messages on the glasses.</span>'
  return { el: { querySelector: (sel: string) => parts[sel] ?? null }, parts }
}
function load(answers: Record<string, Answer> = {}, sessions: unknown[] | (() => unknown[]) = [], card?: ReturnType<typeof fakeCard>) {
  const calls: Array<{ method: string; path: string }> = []
  const liveHooks: Array<() => void> = []
  const went: unknown[][] = []
  const rail = railButton()
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    structureLensAnswer: (s: unknown) => String(s),
    toDate: (s: unknown) => { if (s == null || s === '') return null; const d = new Date(s as string); return isNaN(d.getTime()) ? null : d },
    readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: (...a: unknown[]) => { went.push(a) },
    sessionList: () => { calls.push({ method: 'GET', path: 'sessionList' }); return Promise.resolve({ sessions: typeof sessions === 'function' ? sessions() : sessions }) },
    live: { on: (fn: () => void) => { liveHooks.push(fn) } },
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      calls.push({ method: o?.method ?? 'GET', path })
      const a = answers[path]
      const v = typeof a === 'function' ? (a as (b: unknown) => unknown)(o?.body) : a
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelector: (sel: string) => (card && sel === '[data-ask="c1"]' ? card.el : null),
    querySelectorAll: (sel: string) => (sel.indexOf('rail-btn') >= 0 ? [rail.b] : []),
    getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => rail.mk(),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const fastTimeout = (fn: () => void) => setTimeout(fn, 0)
  const ctx = vm.createContext({ window, document, setTimeout: fastTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  const tap = (what: string, attrs: Record<string, string> = {}) => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : attrs[a] ?? null), closest: () => null })
  return { chat, calls, went, rail: rail.b, tap, liveHooks }
}
const ask = (patch: Record<string, unknown> = {}) => ({ cid: 'c1', jobId: 'job-463', query: 'Did it reach the other session?', at: Date.now() - 60_000, status: 'running', partial: '', response: '', ...patch })

describe('1. the rail badge counts net new only', () => {
  // The state in Miles's screenshot: Mark all read done, 2 chat questions open, 284 Work items in Your move.
  const SHOT = { unread: 0, waiting: 286, asked: 2, yourMove: 284, lastLine: 'x', lastAt: null, version: 1 }

  it('nothing new: no number on the rail, only a dot for the chat replies, and the pinned row never says 286', async () => {
    const h = load({ '/api/inbox/summary': SHOT })
    h.chat.fromHealth({ capabilities: { dropIt: { enabled: true } } })
    await flush()
    expect(h.rail.count()).toBe('')
    expect(h.rail.dot()).toBe(true)
    expect(h.rail.attrs['aria-label']).toBe('Messages, 2 waiting on your reply')
    const pin = h.chat.pinnedRowHtml(false)
    expect(pin).toContain('2 waiting on your reply')
    expect(pin).not.toContain('286')
  })

  it('net new shows as a number, capped at 99+, and clears when the chat is read on any device', async () => {
    let unread = 3
    const h = load({ '/api/inbox/summary': () => ({ ...SHOT, unread }) })
    h.chat.fromHealth({ capabilities: { dropIt: { enabled: true } } })
    await flush()
    expect(h.rail.count()).toBe('3')
    expect(h.rail.dot()).toBe(false)
    expect(h.rail.attrs['aria-label']).toBe('Messages, 3 new in COS, 2 waiting on your reply')
    expect(h.chat.pinnedRowHtml(false)).toContain('3 new · 2 waiting on your reply')
    unread = 140
    await h.chat.refreshSummary()
    expect(h.rail.count()).toBe('99+')
    // Read on the Mac or the glasses' Control: the server's readAt is shared, so the next status read clears it here.
    unread = 0
    await h.chat.refreshSummary()
    expect(h.rail.count()).toBe('')
  })

  it('Mark all read takes the server\'s new counts, the chat\'s replies included', async () => {
    const h = load({ '/api/inbox/summary': { ...SHOT, unread: 4 }, '/api/inbox/read': { unread: 0, waiting: 285, asked: 1, version: 2 } })
    h.chat.fromHealth({ capabilities: { dropIt: { enabled: true } } })
    await flush()
    expect(h.rail.count()).toBe('4')
    h.chat._state.host = { querySelector: () => ({ offsetParent: {} }) }
    h.chat._state.items = [{ id: 'fi_1', kind: 'ping', createdAt: 'x' }]
    h.tap('read-all')
    await flush()
    expect(h.calls.some(c => c.path === '/api/inbox/read')).toBe(true)
    expect(h.rail.count()).toBe('')
    expect(h.chat.pinnedRowHtml(false)).toContain('1 waiting on your reply')
  })

  it('an older server without asked claims nothing as waiting on a reply (it cannot tell the chat from Work)', async () => {
    const h = load({ '/api/inbox/summary': { unread: 0, waiting: 286 } })
    h.chat.fromHealth({ capabilities: { dropIt: { enabled: true } } })
    await flush()
    expect(h.rail.count()).toBe('')
    expect(h.rail.dot()).toBe(false)
    expect(h.chat.pinnedRowHtml(false)).not.toContain('286')
  })
})

describe('2. a finished Ask never says it is still answering (Message #463)', () => {
  it('completed with no words: never the placeholder, in the card or the reader', () => {
    const h = load()
    const html = h.chat._askHtml(ask({ status: 'completed', no: 463, recovered: true }), false)
    expect(html).toContain('Answered')
    expect(html).not.toContain('COS is answering')
    expect(html).toContain('COS finished without a written answer.')
    // Still running: the placeholder is right.
    expect(h.chat._askHtml(ask({ status: 'running', no: 465 }), false)).toContain('COS is answering')
    // Failed or canceled with no words: no placeholder either.
    expect(h.chat._askHtml(ask({ status: 'canceled' }), false)).not.toContain('COS is answering')
  })

  it("#463's state: the job finished with no words, so the card reads the turn from Messages and shows it", async () => {
    const h = load({
      '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: '', partialText: '', globalMsgNum: 463, sessionId: 's-cos' } },
      '/api/sessions/today/all-messages?limit=100': { messages: [{ no: 463, text: 'It reached the session at 9:41.', sessionId: 's-cos' }, { no: 464, text: 'A newer answer', sessionId: 's-cos' }] },
    })
    const a = ask({ no: 463, sessionId: 's-cos' })
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(30)
    expect(h.calls.some(c => c.path === '/api/sessions/today/all-messages?limit=100')).toBe(true)
    expect(a.response).toBe('It reached the session at 9:41.')
    const html = h.chat._askHtml(a, false)
    expect(html).toContain('It reached the session at 9:41.')
    expect(html).not.toContain('COS is answering')
  })

  it('the card already on the page loses "COS is answering" in place when the job ends with no words, and gains its steps', async () => {
    const card = fakeCard()
    const h = load({
      '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: '', partialText: '', globalMsgNum: 463, trail: TRAIL } },
      '/api/sessions/today/all-messages?limit=100': { messages: [] },
    }, [], card)
    const a = ask({ no: 463 })
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(30)
    expect(card.parts['[data-ask-state]'].textContent).toBe('Answered')
    expect(card.parts['[data-ask-body]'].innerHTML).not.toContain('COS is answering')
    expect(card.parts['[data-ask-body]'].innerHTML).toContain('COS finished without a written answer.')
    expect(card.parts['[data-ask-steps]'].innerHTML).toContain('>7 steps</summary>')
  })

  it('when Messages has no words either, it says so once and never asks again', async () => {
    const h = load({
      '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: '', partialText: '', globalMsgNum: 463 } },
      '/api/sessions/today/all-messages?limit=100': { messages: [{ no: 463, text: '' }] },
    })
    const a = ask({ no: 463 })
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(30)
    h.chat._finished(a)
    await flush(10)
    expect(h.calls.filter(c => c.path === '/api/sessions/today/all-messages?limit=100')).toHaveLength(1)
    expect(h.chat._askHtml(a, false)).toContain('COS finished without a written answer.')
  })
})

const TRAIL = [
  { trailSeq: 1, at: 'x', kind: 'prose', text: 'Checking whether a message from another session ever reached this one.' },
  { trailSeq: 2, at: 'x', kind: 'tool', verb: 'read', target: 'session-peer-inbox.ts', detail: '' },
  { trailSeq: 3, at: 'x', kind: 'status', state: 'working', tool_outcome: { ok: true } },
  { trailSeq: 4, at: 'x', kind: 'tool', verb: 'bash', target: 'grep peer', detail: '' },
  { trailSeq: 5, at: 'x', kind: 'status', state: 'working', detail: 'Reading /Users/ukaoma/.claude/sessions/4412.json' },
  { trailSeq: 6, at: 'x', kind: 'tool', verb: 'search', target: 'Another Claude session', detail: '' },
  { trailSeq: 7, at: 'x', kind: 'tool', verb: 'edit', target: 'notes.md', detail: '+3 -1' },
  { trailSeq: 8, at: 'x', kind: 'prose', text: 'Found it in /Users/ukaoma/Documents/GitHub/repo/server/lib/x.ts.' },
]

describe('3. the steps of a running Ask, then a quiet "N steps"', () => {
  it('the poll asks for the trail on the read it already makes (no second loop)', async () => {
    const h = load({ '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: 'ok' } } })
    const a = ask()
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(20)
    const reads = h.calls.filter(c => c.path.indexOf('/api/query-jobs/job-463') === 0).map(c => c.path)
    expect(reads).toEqual(['/api/query-jobs/job-463?generation=1&trail=1'])
  })

  it('running: the newest steps, newest last, with how many came before; no Mac path', () => {
    const h = load()
    const html = h.chat._askHtml(ask({ status: 'running', trail: TRAIL, partial: 'Checking whether a message from another session ever reached this one.' }), false)
    expect(html).toContain('class="cc-steps live"')
    const steps = html.match(/<li class="cc-step [a-z]+">([^<]*)<\/li>/g)!.map((s: string) => s.replace(/<[^>]+>/g, ''))
    expect(steps).toEqual(['1 earlier step', 'Read session-peer-inbox.ts', 'Ran grep peer', 'Reading 4412.json', 'Searched Another Claude session', 'Edited notes.md (+3 -1)', 'Found it in x.ts.'])
    expect(html).not.toMatch(/\/Users\//)
  })

  it('finished: collapses to "N steps", closed until opened, and stays open across a repaint', () => {
    const h = load()
    const a = ask({ status: 'completed', response: 'Done.', trail: TRAIL })
    h.chat._state.asks.push(a)
    let html = h.chat._askHtml(a, false)
    expect(html).toContain('<details class="cc-steps-done">')
    expect(html).toContain('>7 steps</summary>')
    expect(html).not.toContain('cc-steps live')
    h.tap('steps', { 'data-cid': 'c1' })
    html = h.chat._askHtml(a, false)
    expect(html).toContain('<details class="cc-steps-done" open>')
  })

  it('an Ask with no trail (an older Mac, or tool activity off) draws no steps at all', () => {
    const h = load()
    for (const a of [ask({ status: 'running' }), ask({ status: 'completed', response: 'ok' }), ask({ status: 'running', trail: [{ trailSeq: 1, kind: 'status', state: 'working', tool_outcome: { ok: true } }] })]) {
      const html = h.chat._askHtml(a, false)
      expect(html).not.toContain('<ol class="cc-steps')
      expect(html).not.toContain('<details')
    }
  })
})

describe('4. an Ask that sent a message to another session', () => {
  const RELAY = [
    { trailSeq: 1, at: 'x', kind: 'tool', verb: 'other', target: 'ListPeers', detail: '' },
    { trailSeq: 2, at: 'x', kind: 'tool', verb: 'other', target: 'SendMessage', detail: 'to today-brief-builder', call: 'toolu_1' },
  ]
  const row = (patch: Record<string, unknown> = {}) => ({ provider: 'claude', session_id: 'claude:9f1c2b3a-0000', display_label: 'today-brief-builder',
    agent_state: 'idle', last_reply: 'Got it. The brief now leads with the meeting.', state_since: new Date().toISOString(), ...patch })

  it('says where it went, opens that session, and shows its newest reply once it answered', async () => {
    const h = load({ '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: '', partialText: '', globalMsgNum: 463, trail: RELAY } },
      '/api/sessions/today/all-messages?limit=100': { messages: [] } }, [row()])
    const a = ask({ no: 463 })
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(30)
    const html = h.chat._askHtml(a, false)
    expect(html).toContain('Sent to today-brief-builder. Its answer shows in that session, not here.')
    expect(html).toContain('today-brief-builder replied')
    expect(html).toContain('Got it. The brief now leads with the meeting.')
    expect(html).toContain('Sent a message to today-brief-builder')
    // The relay says it; the card does not also claim COS is answering or wrote nothing.
    expect(html).not.toContain('COS is answering')
    expect(html).not.toContain('without a written answer')
    h.tap('open-session', { 'data-provider': 'claude', 'data-sid': '9f1c2b3a-0000' })
    expect(h.went).toEqual([['sessions', ['claude', '9f1c2b3a-0000']]])
  })

  it('a reply from before this Ask is not its answer; a session it cannot find still says where, with Open Sessions', async () => {
    const old = row({ state_since: new Date(Date.now() - 3_600_000).toISOString() })
    const h = load({}, [old])
    const a = ask({ status: 'completed', no: 470, trail: RELAY, recovered: true })
    h.chat._state.asks.push(a)
    h.chat._state.sessionRows = [old]
    let html = h.chat._askHtml(a, false)
    expect(html).toContain('Sent to today-brief-builder.')
    expect(html).not.toContain('replied')
    expect(html).toContain('Its reply shows here when it answers.')
    h.chat._state.sessionRows = []
    html = h.chat._askHtml(a, false)
    expect(html).toContain('data-cos="open-sessions"')
    expect(html).not.toContain('data-cos="open-session"')
  })

  it('the reply arrives later: the live stream and the shell\'s status read refresh the list it reads, with no loop of its own', async () => {
    let rows = [row({ last_reply: '', agent_state: 'running' })]
    const h = load({ '/api/query-jobs/job-463?generation=1&trail=1': { job: { jobId: 'job-463', status: 'completed', response: 'Sent it.', globalMsgNum: 463, trail: RELAY } } }, () => rows)
    const a = ask({ no: 463 })
    h.chat._state.asks.push(a)
    h.chat._poll(a)
    await flush(30)
    const reads = () => h.calls.filter(c => c.path === 'sessionList').length
    expect(reads()).toBe(1)
    expect(h.chat._askHtml(a, false)).not.toContain('replied')
    // A live frame: the list is read again, and the reply shows.
    rows = [row()]
    expect(h.liveHooks).toHaveLength(1)
    h.liveHooks[0]!()
    await flush()
    expect(reads()).toBe(2)
    expect(h.chat._askHtml(a, false)).toContain('today-brief-builder replied')
    // Answered: nothing is pending, so neither the stream nor the status read asks again.
    h.liveHooks[0]!()
    h.chat.fromHealth({ capabilities: {} })
    await flush()
    expect(reads()).toBe(2)
  })

  it('without a live stream, the shell\'s status read is what refreshes it', async () => {
    let rows = [row({ last_reply: '' })]
    const h = load({}, () => rows)
    const a = ask({ status: 'completed', response: 'Sent it.', no: 471, trail: RELAY })
    h.chat._state.asks.push(a)
    h.chat._state.sessionRows = rows
    rows = [row()]
    h.chat.fromHealth({ capabilities: {} })
    await flush()
    expect(h.calls.filter(c => c.path === 'sessionList')).toHaveLength(1)
    expect(h.chat._askHtml(a, false)).toContain('today-brief-builder replied')
  })

  it('a socket address never reaches the page', () => {
    const h = load()
    const html = h.chat._askHtml(ask({ status: 'completed', response: 'Sent.', trail: [{ trailSeq: 1, at: 'x', kind: 'tool', verb: 'other', target: 'SendMessage', detail: 'to another session' }] }), false)
    expect(html).toContain('Sent to another session.')
    expect(html).not.toContain('uds:')
  })
})

describe('older questions: past 7 days they stop counting and move above the chat, still answerable', () => {
  const q = (id: string, line: string) => ({ id, kind: 'question', threadId: 'd-' + id, createdAt: '2026-10-20T09:00:00.000Z', readAt: 'x', source: 'cos', line,
    links: [], actions: [{ id: 'choose:c1', label: 'A task' }, { id: 'choose:c2', label: 'Just a note' }], state: 'live', key: 'k-' + id, archived: true })
  function chatWith(answers: Record<string, Answer>) {
    const h = load(answers)
    const feed = { innerHTML: '', contains: () => false }
    h.chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: false, dropFiles: 0 }
    h.chat._state.host = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? feed : null) }
    h.chat._state.feedState = 'ready'
    h.chat._state.summary = { unread: 0, asked: 1, archived: 2, waitingExpiryDays: 7, waiting: 1 }
    h.chat._state.items = [q('fi_old1', 'Is Call Dale a task?'), { id: 'fi_new', kind: 'question', threadId: 'd-new', createdAt: '2026-11-08T09:00:00.000Z', readAt: null, source: 'cos',
      line: 'Is Pick up cake a task?', links: [], actions: [{ id: 'choose:c1', label: 'A task' }], state: 'live', key: 'k-new' }]
    return { ...h, feed }
  }

  it('the chat shows a closed "2 older questions" with the 7 days from the server, and keeps the expired one out of the stream', () => {
    const h = chatWith({})
    h.chat._paintFeed(false)
    expect(h.feed.innerHTML).toContain('>2 older questions</summary>')
    expect(h.feed.innerHTML).toContain('Asked more than 7 days ago, so they no longer count as waiting on you. You can still answer here.')
    expect(h.feed.innerHTML).toContain('Is Pick up cake a task?')
    expect(h.feed.innerHTML).not.toContain('Is Call Dale a task?')
    expect(h.feed.innerHTML).not.toContain('<details class="cc-archive" data-cos-archive open>')
  })

  it('opening it lists them from the server; answering one posts the same action and takes it off the list', async () => {
    let listed = [q('fi_old1', 'Is Call Dale a task?'), q('fi_old2', 'Is Book the venue a task?')]
    const h = chatWith({
      '/api/inbox/archive': () => ({ items: listed, total: listed.length, waitingExpiryDays: 7 }),
      '/api/inbox/action': (b: { itemId: string }) => { listed = listed.filter(i => i.id !== b.itemId); return { items: [{ ...q(b.itemId, 'answered'), archived: undefined, state: 'done', actions: [] }] } },
    })
    h.tap('archive')
    await flush()
    expect(h.feed.innerHTML).toContain('<details class="cc-archive" data-cos-archive open>')
    expect(h.feed.innerHTML).toContain('Is Book the venue a task?')
    expect(h.feed.innerHTML).toContain('data-item="fi_old2" data-act="choose:c2"')
    h.tap('act', { 'data-item': 'fi_old2', 'data-act': 'choose:c1' })
    await flush()
    expect(h.calls.filter(c => c.path === '/api/inbox/action')).toHaveLength(1)
    expect(h.calls.filter(c => c.path === '/api/inbox/archive')).toHaveLength(2)
    expect(h.chat._state.archive.map((i: { id: string }) => i.id)).toEqual(['fi_old1'])
    expect(h.calls.find(c => c.path === '/api/inbox/action')).toBeTruthy()
  })

  it('nothing older: no list at all', () => {
    const h = chatWith({})
    h.chat._state.summary = { unread: 0, asked: 1, archived: 0, waitingExpiryDays: 7 }
    h.chat._state.items = h.chat._state.items.filter((i: { archived?: boolean }) => !i.archived)
    h.chat._paintFeed(false)
    expect(h.feed.innerHTML).not.toContain('cc-archive')
  })
})
