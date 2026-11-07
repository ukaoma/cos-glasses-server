/**
 * Work chat on COS Control Web: the composer that messages the orchestrator about a Work card. Runs the REAL
 * panes/work.js in a vm with a fake COSWeb, a small fake DOM and a scripted server, and drives it the way taps do.
 * Nothing here reaches a real server: every route answers from the table in each test.
 *
 * The contract it pins is the Mac's (WorkTaskChat.swift) through the lens-round path (server lib/work-lens-rounds.ts):
 *   GET  /api/work/chat                           orchestrator 1, lensPlans 1, webPlans 1, planners, efforts, lensPlansControl
 *   POST /api/work/orchestrator/input             { workID, meetingWorkIDs }
 *   POST /api/work/chat                           the orchestrator planner body (orchestrator: true)
 *   POST /api/work/chat/lens-rounds               { v:1, clientRoundId: web-<uuid>, source: "web", ... }   saved, never sent
 *   POST /api/work/chat/lens-rounds/:id/send      { v:1, confirm: "two-step", confirmedAt }                COS Control sends
 *   GET  /api/work/chat/lens-rounds/:id           the round's state, per assignment
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'work.js'), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

const ID = 'a1b2c3d4e5f6'
const WID = `task:quilt:${ID}`
const S1 = 'claude:11111111-1111-4111-8111-111111111111'
const S2 = 'codex:22222222-2222-4222-8222-222222222222'
const S3 = 'codex:33333333-3333-4333-8333-333333333333'
const ROUND = 'lr_0123456789abcdef'
const TASK = { id: ID, workIdentity: ID, domain: 'quilt', text: 'Ship the pricing page fix', workStage: 'draft', doneWhen: 'Live on staging', source: 'Pricing sync 2026-11-05',
  workRevision: 'f'.repeat(64), taskRevision: 'e'.repeat(64), createdAt: '2026-11-05',
  meetingRefs: [{ title: 'Pricing sync', recordId: 'quilt/2026-11/pricing.md', domain: 'quilt', month: '2026-11', filename: 'pricing.md' }] }
const CAPS = { protocolVersion: 1, planner: 'sonnet', planners: ['sonnet', 'opus'], effort: 'high', efforts: ['low', 'medium', 'high'], automaticProviders: ['claude', 'codex'],
  maxAssignments: 3, orchestrator: 1, lensPlans: 1, lensPlansControl: { connected: true, lastSeenSec: 2, autoSend: false }, webPlans: 1 }
const INPUT = { protocolVersion: 1, workID: WID, now: '2026-11-06T23:00:00.000Z', discovered: 2, snapshotAgeSec: 4, liveListAgeSec: 4, logScanComplete: true, leftOut: [],
  rows: [
    { id: S1, title: 'Pricing page', summary: 'Working on the price table', status: 'idle', discoveredBy: ['link'], linked: true, member: true, lastTouchedCard: null,
      lastActivity: '2026-11-06T22:50:00.000Z', live: true, busy: false, pickup: 'Last: fixed the header.', available: true, forkable: true },
    { id: S2, title: 'Release checks', summary: '', status: 'idle', discoveredBy: ['prompt'], linked: false, member: false, lastTouchedCard: null, lastActivity: null,
      live: true, busy: false, pickup: '', available: false, reason: 'app_owned', forkable: true },
  ],
  usage: [{ provider: 'claude', state: 'ok', headroomPct: 60, resetsAt: null, ageSec: 30, source: 'probe', plan: 'max', stale: false, note: '' },
    { provider: 'codex', state: 'ok', headroomPct: 80, resetsAt: null, ageSec: 30, source: 'probe', plan: null, stale: false, note: '' }] }
const PLAN = { protocolVersion: 1, answer: 'Continue the pricing session for the fix, and start a Codex session for the test.',
  assignments: [{ sessionID: S1, prompt: 'Fix the price table rounding.' }, { mode: 'newSession', provider: 'codex', prompt: 'Add a test for the rounding.' }],
  model: 'claude:claude-opus-5-5', effort: 'high' }
const RECORDED = { roundId: ROUND, workID: WID, state: 'recorded', control: { connected: true } }
const view = (state: string, a1: string, a2: string, extra: Record<string, unknown> = {}) => ({ roundId: ROUND, workID: WID, state, inHistory: true, autoSendCard: false, source: 'web',
  assignments: [{ id: 'a1', state: a1, sessionID: S1, ...(a1 === 'delivered' || a1 === 'sent' ? { receiptId: 'r-1' } : {}) },
    { id: 'a2', state: a2, ...(a2 === 'delivered' || a2 === 'sent' ? { sessionID: S3, receiptId: 'r-2' } : {}) }], updatedAt: '2026-11-06T23:01:00.000Z', ...extra })
const ACTIVITY = { taskRevision: 'e'.repeat(64), capabilities: { progress: 1, requests: 1 }, activities: [] as unknown[] }
const fail = (status: number | undefined, code?: string, message = 'refused') => Object.assign(new Error(message), status ? { status } : {}, code ? { code } : {})

// ── a small DOM: the pane's HTML, and an element for every id it holds ──
class El {
  html = ''; value = ''; textContent = ''; disabled = false; scrollHeight = 40; __html?: string
  style: Record<string, string> = {}
  classes = new Set<string>()
  classList = { toggle: (c: string, on?: boolean) => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c) }, add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c), contains: (c: string) => this.classes.has(c) }
  constructor(readonly dom: Dom, readonly id: string, readonly tag: string, readonly attrs: Record<string, string>) {}
  get innerHTML() { return this.html }
  set innerHTML(v: string) { this.html = v; this.dom.scan(v) }
  getAttribute(n: string) { return n in this.attrs ? this.attrs[n]! : null }
  hasAttribute(n: string) { return n in this.attrs }
  querySelectorAll() { return [] }
  querySelector() { return null }
  contains(x: unknown) { return x === this }
  closest(sel: string) { return sel === '[data-wk]' && this.attrs['data-wk'] ? this : null }
  focus() { this.dom.active = this }
  blur() { if (this.dom.active === this) this.dom.active = null }
  click() { this.dom.fire('click', this) }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } }
  addEventListener(_type?: string, _fn?: (e: any) => void) {}
}
class Dom {
  ids = new Map<string, El>()
  active: El | null = null
  writes = 0
  listeners: Record<string, Array<(e: any) => void>> = {}
  pane: El
  constructor() {
    this.pane = new El(this, 'pane-work', 'section', {})
    const dom = this
    Object.defineProperty(this.pane, 'innerHTML', { get() { return dom.pane.html }, set(v: string) { dom.writes++; dom.pane.html = v; dom.ids.clear(); dom.ids.set('pane-work', dom.pane); if (dom.active && dom.active !== dom.pane) dom.active = null; dom.scan(v) } })
    this.pane.addEventListener = (type: string, fn: (e: any) => void) => { (this.listeners[type] ??= []).push(fn) }
    this.pane.querySelector = ((sel: string) => {
      if (sel === '.wk-detail') { const m = /class="wk-detail" data-wid="([^"]*)"/.exec(this.pane.html); return m ? { getAttribute: (n: string) => (n === 'data-wid' ? unesc(m[1]!) : null) } : null }
      if (sel === '.wk') return /class="cx wk"/.test(this.pane.html) ? {} : null
      return null
    }) as any
    this.pane.contains = (x: unknown) => !!x && [...this.ids.values()].includes(x as El)
    this.ids.set('pane-work', this.pane)
  }
  scan(html: string) {
    const re = /<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
      const attrs: Record<string, string> = {}
      const raw = `${m[2]} ${m[4]}`
      for (const a of raw.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = unesc(a[2]!)
      if (/\sdisabled(\s|$|>)/.test(` ${raw} `)) attrs.disabled = ''
      const el = new El(this, m[3]!, m[1]!, attrs)
      if ('disabled' in attrs) el.disabled = true
      if (m[1] === 'textarea') { const end = html.indexOf('</textarea>', m.index); el.value = unesc(html.slice(m.index + m[0].length, end)) }
      this.ids.set(m[3]!, el)
    }
  }
  fire(type: string, target: unknown, extra: Record<string, unknown> = {}) { for (const fn of this.listeners[type] ?? []) fn({ target, preventDefault() {}, ...extra }) }
}

type Answer = unknown | ((body: any, method: string) => unknown)
function load(opts: { answers?: Record<string, Answer>; storage?: Record<string, string>; route?: string[] } = {}) {
  const answers: Record<string, Answer> = { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : PLAN), [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: ACTIVITY,
    '/api/work/orchestrator/input': INPUT, '/api/work/chat/lens-rounds': RECORDED, [`/api/work/chat/lens-rounds/${ROUND}/send`]: { sendRequestId: 'ls_0123456789abcdef', state: 'send_requested' },
    '/api/work-board/activity/open': { items: [], available: true }, '/api/work-board': { tasks: [TASK], capabilities: {}, complete: true }, ...opts.answers }
  const calls: Array<{ method: string; path: string; body: any; timeoutMs?: number }> = []
  const storage = opts.storage ?? {}
  let route = { pane: 'work', args: opts.route ?? [ID] }
  const dom = new Dom()
  const defs: Record<string, any> = {}
  const W: Record<string, unknown> = {
    $: (id: string) => dom.ids.get(id) ?? null, esc, md: (s: unknown) => esc(s), plain: (s: unknown) => String(s), toast: () => {}, skeletonRows: () => '<div class="skel"></div>',
    toDate: (v: unknown) => { if (!v) return null; const d = new Date(v as string); return Number.isNaN(d.getTime()) ? null : d },
    readStore: (k: string) => { try { const v = JSON.parse(storage[k] ?? '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} } },
    writeStore: (k: string, v: unknown) => { storage[k] = JSON.stringify(v) },
    registerPane: (name: string, def: unknown) => { defs[name] = def }, parseRoute: () => route, go: (p: string, a?: string[]) => { route = { pane: p, args: a ?? [] } }, goBack: () => {},
    setCrumb: () => {}, copyText: () => Promise.resolve(), domainLabel: (d: string) => d, sessionList: () => Promise.resolve({ sessions: [] }),
    api: (path: string, o: { method?: string; body?: unknown; timeoutMs?: number } = {}) => {
      const method = o.method ?? 'GET'
      calls.push({ method, path, body: o.body === undefined ? undefined : JSON.parse(JSON.stringify(o.body)), timeoutMs: o.timeoutMs })
      const a = answers[path]
      let v: unknown
      try { v = typeof a === 'function' ? (a as (b: unknown, m: string) => unknown)(o.body, method) : a } catch (e) { return Promise.reject(e) }
      if (v instanceof Promise) return v
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  // A clock this test turns: polls, the draft's save and the bar's checks wait for tick().
  let now = Date.parse('2026-11-06T23:00:00.000Z')
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  let seq = 0
  const fakeSet = (fn: () => void, ms = 0) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id }
  const fakeClear = (id: number) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) }
  class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(now) } static now() { return now } }
  const document = { addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], get activeElement() { return dom.active }, hidden: false }
  const window = { COSWeb: W, matchMedia: () => ({ matches: true, addEventListener() {} }), scrollTo: () => {}, scrollBy: () => {}, scrollY: 0, scrollX: 0, innerHeight: 800,
    addEventListener: () => {}, navigator: { platform: 'MacIntel', userAgent: 'test' } }
  const ctx = vm.createContext({ window, document, navigator: window.navigator, setTimeout: fakeSet, clearTimeout: fakeClear, setInterval: () => 0, clearInterval: () => {},
    console, Date: FakeDate, JSON, Math, Promise, Array, Object, String, Number, Set, Map, Error, RegExp, isNaN, encodeURIComponent, decodeURIComponent, crypto: globalThis.crypto, CSS: { escape: (s: string) => s } })
  vm.runInContext(SOURCE, ctx)
  const def = defs.work
  const chat = def._chat
  chat.S.tasks = [JSON.parse(JSON.stringify(TASK))]; chat.S.loadedAt = now; chat.S.openAt = now; chat.S.open = []
  const tick = async (ms: number) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift(); now = Math.max(now, next.at); next.fn(); await flush()
    }
    now = until; await flush()
  }
  const box = () => dom.ids.get('wk-chat-text') ?? null
  const type = (text: string) => { const b = box()!; b.value = text; dom.fire('input', b) }
  const tap = (act: string, attrs: Record<string, string> = {}) => dom.fire('click', { closest: (s: string) => (s === '[data-wk]' ? { getAttribute: (n: string) => (n === 'data-wk' ? act : attrs[n] ?? null), disabled: false } : null) })
  const tapEl = (id: string) => { const el = dom.ids.get(id)!; dom.fire('click', { closest: (s: string) => (s === '[data-wk]' ? el : null) }) }
  const render = () => chat.render(ID)
  const card = () => chat.of(WID)
  const sent = (path: string, method = 'POST') => calls.filter(c => c.path === path && c.method === method)
  const html = () => dom.pane.html + [...dom.ids.values()].filter(e => e !== dom.pane).map(e => e.html).join('')
  return { chat, def, dom, calls, storage, answers, tick, box, type, tap, tapEl, render, card, sent, html, setRoute: (r: string[], pane = 'work') => { route = { pane, args: r } }, timers }
}
async function opened(opts: Parameters<typeof load>[0] = {}) {
  const h = load(opts)
  h.render(); await flush()
  h.render(); await flush()
  return h
}
async function planned(opts: Parameters<typeof load>[0] = {}) {
  const h = await opened(opts)
  h.type('Fix the rounding on the pricing page and add a test')
  h.tapEl('wk-cmp-plan')
  await flush(30)
  return h
}

describe('what the server offers: the composer shows only on a server that takes web plans', () => {
  it('a server with webPlans 1 shows the composer, with the planner and effort it advertises', async () => {
    const h = await opened()
    expect(h.box()).not.toBeNull()
    expect(h.dom.ids.get('wk-cmp-picks')!.html).toContain('data-wk-chat="planner"')
    expect(h.dom.ids.get('wk-cmp-picks')!.html).toContain('<option value="opus" selected>Opus</option>')
    expect(h.dom.ids.get('wk-cmp-picks')!.html).toContain('<option value="high" selected>High</option>')
    expect(h.html()).toContain('Files to send.')
  })
  it('a server without webPlans hides the composer and says why in plain words, keeping a draft', async () => {
    const { webPlans: _w, ...lensOnly } = CAPS
    const h = await opened({ answers: { '/api/work/chat': lensOnly }, storage: { 'cos.web.work.chat': JSON.stringify({ v: 1, cards: { [WID]: { at: 1, draft: 'kept words', rounds: [] } } }) } })
    expect(h.box()).toBeNull()
    expect(h.html()).toContain('This COS server plans Work chat for the Mac and the glasses, but not for the web yet.')
    expect(h.html()).toContain('Your draft is kept on this browser.')
    const old = await opened({ answers: { '/api/work/chat': fail(404, 'not_found') } })
    expect(old.box()).toBeNull()
    expect(old.html()).toContain('Work chat needs a newer COS server on your Mac.')
    const legacy = await opened({ answers: { '/api/work/chat': { protocolVersion: 1, planners: ['sonnet'] } } })
    expect(legacy.box()).toBeNull()
  })
  it('an unreachable server says so with Try again, and Try again asks once more', async () => {
    let n = 0
    const h = await opened({ answers: { '/api/work/chat': () => (++n === 1 ? fail(undefined, undefined, 'Failed to fetch') : CAPS) } })
    expect(h.box()).toBeNull()
    expect(h.html()).toContain('Could not check Work chat on your Mac.')
    h.tap('chat-caps'); await flush()
    expect(h.box()).not.toBeNull()
  })
  it('says when COS Control on the Mac is not connected, without hiding Plan', async () => {
    const h = await opened({ answers: { '/api/work/chat': { ...CAPS, lensPlansControl: { connected: false, lastSeenSec: 400, autoSend: false } } } })
    expect(h.dom.ids.get('wk-cmp-status')!.html).toContain('COS Control on your Mac is not connected right now.')
  })
})

describe('the request and its plan (the Mac contract)', () => {
  it('plans with the same three routes and body the Mac uses, then saves the plan as a web round, and sends nothing', async () => {
    const h = await planned()
    const order = h.calls.filter(c => c.method === 'POST').map(c => c.path)
    expect(order).toEqual(['/api/work/orchestrator/input', '/api/work/chat', '/api/work/chat/lens-rounds'])
    expect(h.sent('/api/work/orchestrator/input')[0]!.body).toEqual({ workID: WID, meetingWorkIDs: ['meeting:quilt/2026-11/pricing.md'] })
    const plan = h.sent('/api/work/chat')[0]!
    expect(plan.timeoutMs).toBe(190000)
    expect(Object.keys(plan.body).sort()).toEqual(['context', 'effort', 'history', 'leftOut', 'mode', 'newSessionProviders', 'now', 'orchestrator', 'planner', 'question',
      'revision', 'sessions', 'updates', 'usage', 'workID'].sort())
    expect(plan.body).toMatchObject({ workID: WID, revision: 'f'.repeat(64), question: 'Fix the rounding on the pricing page and add a test', mode: 'plan', orchestrator: true,
      planner: 'opus', effort: 'high', history: [], updates: [], newSessionProviders: ['claude', 'codex'], leftOut: [] })
    // Control's helper builds this exact context (work-context): the task block, then one line per confirmed meeting.
    expect(plan.body.context).toBe(`Canonical Work ID: ${WID}\nTask: Ship the pricing page fix\nDomain: quilt\nStage: draft\nDone when: Live on staging\nSource: Pricing sync 2026-11-05\n` +
      'Confirmed source meetings (references; transcript evidence is not included):\n- Pricing sync | canonical ID: quilt/2026-11/pricing.md | domain: quilt | month: 2026-11 | file: pricing.md')
    expect(plan.body.sessions.map((s: { id: string; automatic: boolean }) => [s.id, s.automatic])).toEqual([[S1, true], [S2, false]])
    expect(plan.body.sessions[1]).toMatchObject({ reason: 'app_owned', available: false })
    const rec = h.sent('/api/work/chat/lens-rounds')[0]!.body
    expect(rec).toMatchObject({ v: 1, workID: WID, source: 'web', orchestrator: true, planner: 'opus', effort: 'high', question: 'Fix the rounding on the pricing page and add a test',
      answer: PLAN.answer, assignments: [{ id: 'a1', mode: 'continue', sessionID: S1, provider: 'claude', prompt: 'Fix the price table rounding.' },
        { id: 'a2', mode: 'newSession', provider: 'codex', prompt: 'Add a test for the rounding.' }] })
    expect(rec.clientRoundId).toMatch(/^web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(rec.assignments[1]).not.toHaveProperty('sessionID')
    expect(h.calls.some(c => c.path.endsWith('/send'))).toBe(false)
    const r = h.card().rounds[0]
    expect(r).toMatchObject({ state: 'ready', roundId: ROUND, key: rec.clientRoundId })
    expect(h.card().draft).toBe('')
    expect(h.box()!.value).toBe('')
    const page = h.html()
    expect(page).toContain('Ready to send · planned with claude-opus-5-5 · high effort')
    expect(page).toContain('Review each assignment. Nothing is sent until you press Send.')
    expect(page).toContain('Send all 2')
    expect(page).toContain('Continue · Pricing page')
    expect(page).toContain('New Codex session')
  })
  it('names the planner it asked for only as a request when the server did not say what ran', async () => {
    const h = await planned({ answers: { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : { ...PLAN, model: 'claude:opus (requested)', effort: 'medium' }) } })
    expect(h.html()).toContain('Ready to send · requested Opus (not confirmed) · medium effort')
    expect(h.sent('/api/work/chat/lens-rounds')[0]!.body.planner).toBe('opus')
  })
  it('the planner and effort picked here go in the next plan', async () => {
    const h = await opened()
    h.dom.fire('change', { hasAttribute: (n: string) => n === 'data-wk-chat', getAttribute: () => 'planner', value: 'sonnet', id: '', name: '' })
    h.dom.fire('change', { hasAttribute: (n: string) => n === 'data-wk-chat', getAttribute: () => 'effort', value: 'low', id: '', name: '' })
    h.type('Plan with Sonnet'); h.tapEl('wk-cmp-plan'); await flush(30)
    expect(h.sent('/api/work/chat')[0]!.body).toMatchObject({ planner: 'sonnet', effort: 'low' })
    expect(JSON.parse(h.storage['cos.web.work.chat']!)).toMatchObject({ planner: 'sonnet', effort: 'low' })
  })
  it('a second plan carries this browser\'s earlier round as history and its sends as updates', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'sent')
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(20); await h.tick(1); await flush(20)
    h.answers['/api/work/chat/lens-rounds'] = { ...RECORDED, roundId: 'lr_1111111111111111' }
    h.type('Now update the docs'); h.tapEl('wk-cmp-plan'); await flush(30)
    const second = h.sent('/api/work/chat')[1]!.body
    expect(second.history).toEqual([{ question: 'Fix the rounding on the pricing page and add a test', answer: PLAN.answer }])
    expect(second.updates).toEqual([{ sessionID: S1, status: 'Delivered', detail: '', result: '' }])
  })
  it('over 2,000 characters Plan is off and says why; nothing is asked', async () => {
    const h = await opened()
    h.type('x'.repeat(2001))
    expect(h.dom.ids.get('wk-cmp-plan')!.disabled).toBe(true)
    expect(h.dom.ids.get('wk-cmp-count')!.textContent).toBe('2,001/2,000')
    expect(h.dom.ids.get('wk-cmp-status')!.html).toContain('Keep your request under 2,000 characters.')
    h.tapEl('wk-cmp-plan'); await flush()
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0)
    h.type('x'.repeat(2000))
    expect(h.dom.ids.get('wk-cmp-plan')!.disabled).toBe(false)
  })
  it('a double tap on Plan plans once', async () => {
    const h = await opened()
    h.type('Do the thing')
    h.tapEl('wk-cmp-plan'); h.tapEl('wk-cmp-plan')
    await flush(30)
    expect(h.sent('/api/work/chat')).toHaveLength(1)
    expect(h.sent('/api/work/chat/lens-rounds')).toHaveLength(1)
    expect(h.card().rounds).toHaveLength(1)
  })
  it('two plans started at once (a tap and Command Return together) plan once', async () => {
    const h = await opened()
    h.card().draft = 'Do the thing'
    const it = h.chat.item(ID)
    const [a, b] = await Promise.all([h.chat.plan(it), h.chat.plan(it)])
    await flush(30)
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(h.sent('/api/work/orchestrator/input')).toHaveLength(1)
    expect(h.card().rounds).toHaveLength(1)
  })
  it('the text estimate counts what Control counts: the request, the task, each meeting line and COS instructions', async () => {
    const h = await opened()
    const context = h.chat.context(TASK, WID)
    const m = h.chat.meter('abcd', context, WID)
    const task = context.split('\nConfirmed source meetings')[0]
    const line = context.split('\n').pop()!
    const cos = 'Preserve other session work. Report changes, checks and questions. This assignment does not authorize external publication, messages to other people, deletion or security changes.'
    const instruction = '\n\nWhen you finish this task, or if you need input or are blocked, make this the first line of your reply, in plain text (not bold, not in a code block), so COS can track it:\n' +
      `COS-WORK ${ID}: <done, needs input or blocked>: <one sentence of evidence>\nUse done only when the work is finished and checked. If you are handling several COS tasks, give one line per task.`
    const t = (s: string) => Math.ceil(s.length / 4)
    expect(m).toEqual({ tokens: t('abcd') + t(task) + t(line) + t(cos) + Math.ceil(instruction.length / 4), meetings: 1 })
    h.type('abcd')
    expect(h.dom.ids.get('wk-cmp-size')!.textContent).toBe(`Sends ≈ ${m.tokens} tokens of text`)
  })
})

describe('the plan failing: nothing is sent, and the words come back', () => {
  it('a busy planner, a refused plan and a too-long plan each fail plainly and save nothing', async () => {
    for (const [answer, words] of [
      [fail(409, 'work_chat_busy'), 'COS is planning another request right now. Nothing was sent.'],
      [{ ...PLAN, assignments: [{ sessionID: S2, prompt: 'x' }] }, 'The plan named a session it may not send to here, or broke a limit. Nothing was sent.'],
      [{ ...PLAN, assignments: [1, 2, 3, 4].map(() => ({ mode: 'newSession', provider: 'claude', prompt: 'x' })) }, 'The plan has more than 3 assignments'],
      [fail(undefined, 'timeout', 'Your Mac did not answer in 190 seconds.'), 'Your Mac did not answer while planning. Nothing was sent.'],
    ] as const) {
      const h = await planned({ answers: { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : answer) } })
      const r = h.card().rounds[0]
      expect(r.state, String(words)).toBe('planFailed')
      expect(r.error).toContain(words)
      expect(h.sent('/api/work/chat/lens-rounds')).toHaveLength(0)
      expect(h.html()).toContain('Use this request again')
      h.tap('chat-again', { 'data-key': r.key })
      expect(h.card().draft).toBe('Fix the rounding on the pricing page and add a test')
      expect(h.box()!.value).toBe('Fix the rounding on the pricing page and add a test')
    }
  })
  it('a card that changed since the page loaded is not planned, and the words stay in the box', async () => {
    const h = await opened({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: { ...ACTIVITY, taskRevision: 'd'.repeat(64) } } })
    h.type('Keep these words'); h.tapEl('wk-cmp-plan'); await flush(30)
    expect(h.sent('/api/work/orchestrator/input')).toHaveLength(0)
    expect(h.card().rounds).toHaveLength(0)
    expect(h.card().draft).toBe('Keep these words')
    expect(h.dom.ids.get('wk-cmp-status')!.html).toContain('This task changed since the page loaded.')
  })
  it('a save that gets no answer keeps the plan; Send saves it again under the same round id, then sends', async () => {
    let saves = 0
    const h = await planned({ answers: { '/api/work/chat/lens-rounds': () => (++saves === 1 ? fail(undefined, undefined, 'Failed to fetch') : RECORDED) } })
    const r = h.card().rounds[0]
    expect(r).toMatchObject({ state: 'ready', roundId: '' })
    expect(r.error).toContain('Not saved to the Mac yet')
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    const recs = h.sent('/api/work/chat/lens-rounds')
    expect(recs).toHaveLength(2)
    expect(recs[1]!.body.clientRoundId).toBe(recs[0]!.body.clientRoundId)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
})

describe('Send: once, through COS Control, and truthful about where it is', () => {
  it('sends with the two-step confirm, once, however many times it is tapped', async () => {
    const h = await planned()
    const key = h.card().rounds[0].key
    h.tap('chat-send', { 'data-key': key }); h.tap('chat-send', { 'data-key': key }); h.tap('chat-send', { 'data-key': key })
    expect(h.html()).toContain('Sending…')
    await flush(30)
    const sends = h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body).toEqual({ v: 1, confirm: 'two-step', confirmedAt: expect.stringMatching(/^2026-11-06T23:00:00/) })
    expect(h.card().rounds[0].state).toBe('sending')
    h.tap('chat-send', { 'data-key': key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
    expect(h.html()).toContain('Waiting for COS Control on your Mac to pick it up. Nothing has been sent yet.')
  })
  it('a send whose answer was lost reads the round before sending again, and never sends twice', async () => {
    let sends = 0
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: () => (++sends === 1 ? fail(undefined, 'timeout', 'Your Mac did not answer') : { state: 'send_requested' }) } })
    const r = h.card().rounds[0]
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    expect(r).toMatchObject({ state: 'ready', sendUnknown: true })
    expect(r.error).toContain('it never sends twice')
    // The first send did land: the round says so, and Send adopts it without a second POST.
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('send_requested', 'pending', 'pending')
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET')).toHaveLength(1)
    expect(sends).toBe(1)
    expect(r.state).toBe('sending')
  })
  it('a lost answer for a send that never landed sends it once more after checking', async () => {
    let sends = 0
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: () => (++sends === 1 ? fail(undefined, undefined, 'Failed to fetch') : { state: 'send_requested' }),
      [`/api/work/chat/lens-rounds/${ROUND}`]: view('in_history', 'pending', 'pending') } })
    const r = h.card().rounds[0]
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    expect(sends).toBe(2)
    expect(r.state).toBe('sending')
  })
  it('send_in_progress and already_sent from the server read as on its way, never as a failure', async () => {
    for (const code of ['send_in_progress', 'already_sent']) {
      const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, code) } })
      h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30)
      expect(h.card().rounds[0].state, code).toBe('sending')
    }
  })
  it('COS Control not connected (423): the plan is saved for the Mac and is never offered again here', async () => {
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(423, 'control_not_connected') } })
    const r = h.card().rounds[0]
    h.tap('chat-send', { 'data-key': r.key }); await flush(30)
    expect(r.state).toBe('held')
    expect(h.html()).toContain('COS Control was not connected, so send it from Work on the Mac. It cannot be sent again from here.')
    expect(h.html()).not.toContain('data-wk="chat-send"')
    h.tap('chat-send', { 'data-key': r.key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
  it('a stale plan and a lost plan end plainly', async () => {
    const stale = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, 'plan_stale') } })
    stale.tap('chat-send', { 'data-key': stale.card().rounds[0].key }); await flush(30)
    expect(stale.card().rounds[0]).toMatchObject({ state: 'notDelivered', error: 'This card’s sessions changed since the plan. Nothing was sent. Plan again.' })
    const gone = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(404, 'unknown_round') } })
    gone.tap('chat-send', { 'data-key': gone.card().rounds[0].key }); await flush(30)
    expect(gone.card().rounds[0].error).toBe('Your Mac no longer has this plan. Nothing was sent. Plan again.')
  })
})

describe('after Send: delivery, the reply and the updates come back to this card', () => {
  it('reads the round until it ends, then shows delivered (never completed), the reply, and Latest updates', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending', { inHistory: true })
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30)
    await h.tick(1)
    expect(h.html()).toContain('COS Control on your Mac is sending it.')
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'sent')
    h.answers[`/api/work-board/activity?domain=quilt&workIdentity=${ID}`] = { ...ACTIVITY, activities: [
      { id: 'r-1', workId: WID, status: 'delivered', provider: 'claude', sessionId: S1, sessionTitle: 'Pricing page', createdAt: '2026-11-06T23:00:30.000Z',
        progress: { reported: 'done', evidence: 'Rounding fixed and checked on staging.', reportedBy: 'session' } }] }
    await h.tick(3000); await flush(30)
    const r = h.card().rounds[0]
    expect(r.state).toBe('sent')
    const page = h.html()
    expect(page).toContain('Instruction delivered to the session. Inspect the response; this does not mark the task complete.')
    expect(page).toContain('Session reported: Done')
    expect(page).toContain('“Rounding fixed and checked on staging.”')
    expect(page).toContain('Read the reply in Claude')
    expect(page).toContain('Open the session in Codex')
    expect(page.indexOf('“Pricing page” reported: done')).toBeLessThan(page.indexOf('Still outstanding: 1'))
    expect(page).toContain('Dispatched · sent from this browser · planned with claude-opus-5-5 · high effort')
    expect(page).toContain('Latest updates')
    expect(page).toContain('Delivered to 1 session')
    expect(page).toContain('Sent, not yet confirmed: 1')
    expect(page).toContain('“Pricing page” reported: done')
    expect(page).toContain('Still outstanding: 1')
    expect(page).toContain('in this card’s Work chat on the Mac')
    // It stops reading the round once the round ended.
    const reads = h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET').length
    await h.tick(30000)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET').length).toBe(reads)
  })
  it('a reply that lands after the round ended still shows: the card is read again every 15 seconds, then stops', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'delivered')
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30); await h.tick(1)
    expect(h.card().rounds[0].state).toBe('sent')
    expect(h.html()).not.toContain('Session reported')
    h.answers[`/api/work-board/activity?domain=quilt&workIdentity=${ID}`] = { ...ACTIVITY, activities: [
      { id: 'r-1', workId: WID, status: 'delivered', provider: 'claude', sessionId: S1, sessionTitle: 'Pricing page', createdAt: '2026-11-06T23:00:30.000Z',
        progress: { reported: 'needsInput', evidence: 'Which rounding rule: banker or half up?', reportedBy: 'session' } },
      { id: 'r-2', workId: WID, status: 'delivered', provider: 'codex', sessionId: S3, sessionTitle: 'Test', createdAt: '2026-11-06T23:00:30.000Z',
        progress: { reported: 'done', evidence: 'Test added.', reportedBy: 'session' } }] }
    await h.tick(15000); await flush(20)
    expect(h.html()).toContain('Session reported: Needs your input')
    expect(h.html()).toContain('“Which rounding rule: banker or half up?”')
    // Every sent assignment has a report now: the card is not read again.
    const reads = h.calls.filter(c => c.path.startsWith('/api/work-board/activity?')).length
    await h.tick(60000)
    expect(h.calls.filter(c => c.path.startsWith('/api/work-board/activity?')).length).toBe(reads)
  })
  it('a partly sent or refused round says what did not go and why', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = { ...view('partly_sent', 'delivered', 'refused'), assignments: [{ id: 'a1', state: 'delivered', sessionID: S1, receiptId: 'r-1' },
      { id: 'a2', state: 'refused', detail: 'No Codex model is available to start a session. Nothing was sent.' }] }
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30); await h.tick(1)
    expect(h.card().rounds[0].state).toBe('partly')
    expect(h.html()).toContain('No Codex model is available to start a session. Nothing was sent.')
    expect(h.html()).toContain('Not sent: 1')
    expect(h.html()).toContain('Partly sent · sent from this browser')
  })
  it('stops reading after 26 minutes without calling it stopped, and Check again reads it once more', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30)
    await h.tick(27 * 60000)
    const r = h.card().rounds[0]
    expect(r.state).toBe('quiet')
    expect(r.error).toContain('Still with COS Control.')
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'delivered')
    h.tap('chat-check', { 'data-key': r.key }); await h.tick(1)
    expect(r.state).toBe('sent')
  })
  it('Stop asks COS Control to stop what has not gone yet', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'delivered', 'pending')
    h.answers[`/api/work/chat/lens-rounds/${ROUND}/stop`] = { stopRequestId: 'lst_0123456789abcdef', state: 'stop_requested' }
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30); await h.tick(1)
    h.tap('chat-stop', { 'data-key': h.card().rounds[0].key }); await flush(30)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/stop`)[0]!.body).toEqual({ v: 1, assignmentIds: ['a2'] })
  })
  it('leaving Work stops every read; coming back picks the round up again', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30)
    h.def.leave(); h.setRoute([], 'today')
    expect(h.timers.length).toBe(0)
    h.setRoute([ID]); h.def.load([ID]); await flush(); await h.tick(1)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET').length).toBeGreaterThan(0)
  })
})

describe('the draft and the keyboard: nothing typed is lost', () => {
  it('typing saves the draft to this browser; a reload or a fold brings it back', async () => {
    const h = await opened()
    h.type('Half a thought')
    await h.tick(400)
    expect(JSON.parse(h.storage['cos.web.work.chat']!).cards[WID].draft).toBe('Half a thought')
    const again = await opened({ storage: h.storage })
    expect(again.box()!.value).toBe('Half a thought')
    expect(again.card().draft).toBe('Half a thought')
  })
  it('a repaint never replaces the text box: the draft, the caret and the keyboard stay', async () => {
    const h = await opened()
    const first = h.box()!
    h.type('Typing on the Duo')
    first.focus()
    const writes = h.dom.writes
    // A background load lands (the card's activity, a poll): the page repaints.
    h.chat.S.activity[WID] = { ...ACTIVITY, activities: [] }
    h.render(); h.render()
    expect(h.dom.writes).toBe(writes)
    expect(h.box()).toBe(first)
    expect(h.box()!.value).toBe('Typing on the Duo')
    expect(h.chat.S.chatDeferred).toBe(true)
    // Unfocused, the parts around it repaint, and the box is still the same element.
    first.blur(); h.dom.fire('focusout', first); await h.tick(1)
    expect(h.chat.S.chatDeferred).toBe(false)
    expect(h.box()).toBe(first)
    expect(h.dom.writes).toBe(writes)
  })
  it('a page closed while planning comes back as an interrupted request: nothing sent, the words recoverable', async () => {
    // The planner is still thinking when the page goes away.
    const h = await opened({ answers: { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : new Promise(() => {})) } })
    h.type('Plan this please'); h.tapEl('wk-cmp-plan')
    await flush(2)
    h.chat.save(true)
    const stored = JSON.parse(h.storage['cos.web.work.chat']!).cards[WID].rounds[0]
    expect(stored.state).toBe('planning')
    const again = await opened({ storage: h.storage })
    const r = again.card().rounds[0]
    expect(r.state).toBe('planFailed')
    expect(r.error).toBe('Planning stopped when this page closed. Nothing was sent. Use this request again to plan it.')
    again.tap('chat-again', { 'data-key': r.key })
    expect(again.box()!.value).toBe('Plan this please')
    expect(again.calls.some(c => c.path.includes('lens-rounds'))).toBe(false)
  })
  it('a sending round comes back after a reload and keeps reading the server', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key }); await flush(30)
    h.chat.save(true)
    const again = load({ storage: h.storage, answers: { [`/api/work/chat/lens-rounds/${ROUND}`]: view('sent', 'delivered', 'delivered') } })
    again.def.load([ID]); await flush(); await again.tick(1)
    expect(again.card().rounds[0].state).toBe('sent')
    expect(again.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(0)
  })
  it('keeps at most 8 rounds a card and 30 cards, newest first; a full or blocked store never breaks the page', async () => {
    const cards: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) cards[`task:quilt:${String(i).padStart(12, '0')}`] = { at: i, draft: 'd' + i, rounds: [] }
    const h = await opened({ storage: { 'cos.web.work.chat': JSON.stringify({ v: 1, cards }) } })
    h.type('newest'); await h.tick(400)
    const saved = JSON.parse(h.storage['cos.web.work.chat']!).cards
    expect(Object.keys(saved)).toHaveLength(30)
    expect(saved[WID].draft).toBe('newest')
    expect(saved['task:quilt:000000000000']).toBeUndefined()
    const broken = await opened({ storage: { 'cos.web.work.chat': '{not json' } })
    expect(broken.box()).not.toBeNull()
  })
})
