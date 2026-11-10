/**
 * Work chat on COS Control Web: the composer that messages the orchestrator about a Work card. Runs the REAL
 * panes/work.js in a vm with a fake COSWeb, a small fake DOM and a scripted server, and drives it the way taps do.
 * Nothing here reaches a real server: every route answers from the table in each test.
 *
 * The contract it pins is the Mac's (WorkTaskChat.swift) through the lens-round path (server lib/work-lens-rounds.ts):
 *   GET  /api/work/chat                           orchestrator 1, lensPlans 1, planners, efforts, lensPlansControl (unchanged)
 *   GET  /api/work/chat/web-plans                 { webPlans: 1 } on a server that records web plans; 404 on an older one
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
import { parseWorkChatInput } from '../lib/work-chat.js'
import { LENS_SEND_PICKUP_MS, LENS_SEND_REPORT_MS } from '../lib/work-lens-rounds.js'

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
  maxAssignments: 3, orchestrator: 1, lensPlans: 1, lensPlansControl: { connected: true, lastSeenSec: 2, autoSend: false } }
const WEB_PLANS = { protocolVersion: 1, webPlans: 1, sources: ['lens', 'web'] }
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
const HEALTH = { features: { durableQueryJobs: true, durableQueryJobsProtocol: 1, claude: true, codex: true } }
const MODELS_CATALOG = { options: [{ preference: 'codex-frontier', id: 'gpt-5.5' }, { preference: 'codex-balanced', id: 'gpt-5.5-mini' }] }
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
    '/api/work/chat/web-plans': WEB_PLANS, '/api/work/orchestrator/input': INPUT, '/api/work/chat/lens-rounds': RECORDED, [`/api/work/chat/lens-rounds/${ROUND}/send`]: { sendRequestId: 'ls_0123456789abcdef', state: 'send_requested' },
    '/api/work-board/activity/open': { items: [], available: true }, '/api/work-board': { tasks: [TASK], capabilities: {}, complete: true },
    // The Mac's model catalog (Q1 P1, P2): durable jobs on, Claude and Codex ready, one entry per Codex slot.
    '/api/health': HEALTH, '/api/models': MODELS_CATALOG, ...opts.answers }
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
      const a = path in answers ? answers[path] : Object.entries(answers).find(([k]) => k.endsWith('*') && path.startsWith(k.slice(0, -1)))?.[1]
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
  // Send is two taps: Send, then (after the guard time) Send to <session>.
  const send = async (key: string, ids = 'a1,a2') => { tap('chat-send', { 'data-key': key, 'data-ids': ids }); await tick(500); tap('chat-confirm', { 'data-key': key }); await flush(30) }
  const card = () => chat.of(WID)
  const sent = (path: string, method = 'POST') => calls.filter(c => c.path === path && c.method === method)
  const html = () => dom.pane.html + [...dom.ids.values()].filter(e => e !== dom.pane).map(e => e.html).join('')
  return { chat, def, dom, calls, storage, answers, tick, box, type, tap, tapEl, render, send, card, sent, html, setRoute: (r: string[], pane = 'work') => { route = { pane, args: r } }, timers }
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
    const h = await opened({ answers: { '/api/work/chat/web-plans': fail(404, 'not_found') }, storage: { 'cos.web.work.chat': JSON.stringify({ v: 1, cards: { [WID]: { at: 1, draft: 'kept words', rounds: [] } } }) } })
    expect(h.box()).toBeNull()
    expect(h.html()).toContain('This COS server plans Work chat for the Mac and the glasses, but not for the web yet.')
    expect(h.html()).toContain('Your draft is kept on this browser.')
    const old = await opened({ answers: { '/api/work/chat': fail(404, 'not_found'), '/api/work/chat/web-plans': fail(404, 'not_found') } })
    expect(old.box()).toBeNull()
    expect(old.html()).toContain('Work chat needs a newer COS server on your Mac.')
    const legacy = await opened({ answers: { '/api/work/chat': { protocolVersion: 1, planners: ['sonnet'] }, '/api/work/chat/web-plans': fail(404, 'not_found') } })
    expect(legacy.box()).toBeNull()
    // The web-plans check itself unreachable: never shown as supported, and Try again is offered.
    const flaky = await opened({ answers: { '/api/work/chat/web-plans': fail(undefined, undefined, 'Failed to fetch') } })
    expect(flaky.box()).toBeNull()
    expect(flaky.html()).toContain('Could not check Work chat on your Mac.')
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
  it('plans with the same routes and body the Mac uses, saves nothing until Send, then saves the plan as a web round and sends it', async () => {
    const h = await planned()
    expect(h.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/work/orchestrator/input', '/api/work/chat'])
    // Nothing is saved to the Mac on Plan: today's COS Control would file it as a plan from the glasses and post a notice.
    expect(h.card().rounds[0]).toMatchObject({ state: 'ready', roundId: '' })
    expect(h.html()).toContain('This plan stays on this browser until you send it. Send saves it to this card’s Work chat on the Mac.')
    await h.send(h.card().rounds[0].key)
    const order = h.calls.filter(c => c.method === 'POST').map(c => c.path)
    expect(order).toEqual(['/api/work/orchestrator/input', '/api/work/chat', '/api/work/chat/lens-rounds', `/api/work/chat/lens-rounds/${ROUND}/send`])
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
    const r = h.card().rounds[0]
    expect(r).toMatchObject({ state: 'sending', roundId: ROUND, key: rec.clientRoundId })
    expect(h.card().draft).toBe('')
    expect(h.box()!.value).toBe('')
  })
  it('a planned round reads as ready, and names its planner, its assignments and its Send', async () => {
    const h = await planned()
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
    await h.send(h.card().rounds[0].key)
    // "claude:opus (requested)" is a request the server could not confirm: the saved round names no planner, only the effort.
    const rec = h.sent('/api/work/chat/lens-rounds')[0]!.body
    expect(rec).not.toHaveProperty('planner')
    expect(rec.effort).toBe('medium')
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
    await h.send(h.card().rounds[0].key); await h.tick(1); await flush(20)
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
    expect(h.sent('/api/work/chat/lens-rounds')).toHaveLength(0)
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
      // W1 (0.5.386 parity): a round that failed before the planner answered offers Plan again in place.
      expect(h.html()).toContain('data-wk="chat-plan-again"')
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
  it('a save that gets no answer keeps the plan; the next Send saves it again under the same round id, then sends', async () => {
    let saves = 0
    const h = await planned({ answers: { '/api/work/chat/lens-rounds': () => (++saves === 1 ? fail(undefined, undefined, 'Failed to fetch') : RECORDED) } })
    const r = h.card().rounds[0]
    await h.send(r.key)
    expect(r).toMatchObject({ state: 'ready', roundId: '' })
    expect(r.error).toBe('Not sent: your Mac did not answer. The plan is kept; send it again.')
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(0)
    await h.send(r.key)
    const recs = h.sent('/api/work/chat/lens-rounds')
    expect(recs).toHaveLength(2)
    expect(recs[1]!.body.clientRoundId).toBe(recs[0]!.body.clientRoundId)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
})

describe('Send: once, through COS Control, and truthful about where it is', () => {
  it('Send asks first, naming where it goes; a double tap never confirms; the confirm sends once', async () => {
    const h = await planned()
    const key = h.card().rounds[0].key
    // A double tap on Send: the first opens the confirm, the second lands on its button inside the guard time.
    h.tap('chat-send', { 'data-key': key, 'data-ids': 'a1,a2' }); h.tap('chat-confirm', { 'data-key': key })
    await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(0)
    expect(h.html()).toContain('Send to “Pricing page” and a new Codex session?')
    expect(h.html()).toMatch(/data-wk="chat-confirm"[^>]*disabled>Send to 2 sessions</)
    await h.tick(500)
    expect(h.html()).toMatch(/data-wk="chat-confirm"[^>]*>Send to 2 sessions</)
    expect(h.html()).not.toMatch(/data-wk="chat-confirm"[^>]*disabled/)
    h.tap('chat-confirm', { 'data-key': key }); h.tap('chat-confirm', { 'data-key': key }); h.tap('chat-send', { 'data-key': key, 'data-ids': 'a1,a2' })
    expect(h.html()).toContain('Sending…')
    await flush(30)
    const sends = h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body).toEqual({ v: 1, confirm: 'two-step', confirmedAt: expect.stringMatching(/^2026-11-06T23:00:00/), assignmentIds: ['a1', 'a2'] })
    expect(h.card().rounds[0].state).toBe('sending')
    h.tap('chat-send', { 'data-key': key, 'data-ids': 'a1,a2' }); await h.tick(500); h.tap('chat-confirm', { 'data-key': key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
    expect(h.card().rounds).toHaveLength(1)
  })
  it('two sends of the same plan started at once send once', async () => {
    const h = await planned()
    const it = h.chat.item(ID), r = h.card().rounds[0]
    const [a, b] = await Promise.all([h.chat.send(it, r, ['a1', 'a2']), h.chat.send(it, r, ['a1', 'a2'])])
    await flush(30)
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
  it('Cancel closes the confirm and sends nothing', async () => {
    const h = await planned()
    const key = h.card().rounds[0].key
    h.tap('chat-send', { 'data-key': key, 'data-ids': 'a1,a2' }); await h.tick(500)
    h.tap('chat-cancel', { 'data-key': key }); await flush()
    expect(h.html()).not.toContain('data-wk="chat-confirm"')
    h.tap('chat-confirm', { 'data-key': key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(0)
  })
  it('says plainly when COS Control has not picked the send up, and never says sent before the Mac sent it', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('send_requested', 'pending', 'pending')
    await h.send(h.card().rounds[0].key); await h.tick(1)
    let page = h.html()
    expect(page).toContain('Waiting for COS Control on your Mac to send this. COS Control has to be open on the Mac. Nothing has been sent yet.')
    expect(page).toContain('Waiting for COS Control · planned with')
    expect(page).not.toContain('sent from this browser')
    expect(page).not.toContain('Dispatched')
    expect(page).not.toMatch(/wk-mono">Sent</)
    await h.tick(61000)
    page = h.html()
    expect(page).toContain('It has not picked it up yet: the Mac may be asleep or COS Control closed.')
    // COS Control picks it up: still not sent until it reports.
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await h.tick(10000)
    expect(h.html()).toContain('COS Control on your Mac is sending it.')
    expect(h.html()).not.toContain('sent from this browser')
    // Not picked up in 10 minutes: nothing was sent, and it can be sent again.
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('expired', 'pending', 'pending')
    await h.tick(10000)
    expect(h.card().rounds[0].state).toBe('expired')
    expect(h.html()).toContain('COS Control did not pick it up within 10 minutes. Nothing was sent. You can send it again.')
    expect(h.html()).toContain('data-wk="chat-send"')
  })
  it('one assignment at a time: Send names it, Skip drops it, and the rest stays sendable', async () => {
    const h = await planned()
    const key = h.card().rounds[0].key
    h.tap('chat-send', { 'data-key': key, 'data-ids': 'a1' }); await h.tick(500)
    expect(h.html()).toContain('Send to “Pricing page”?')
    expect(h.html()).toContain('>Send to Pricing page</button>')
    h.tap('chat-confirm', { 'data-key': key }); await flush(30)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)[0]!.body.assignmentIds).toEqual(['a1'])
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = { ...view('sent', 'delivered', 'pending'), assignments: [{ id: 'a1', state: 'delivered', sessionID: S1, receiptId: 'r-1' }, { id: 'a2', state: 'pending' }] }
    await h.tick(1)
    expect(h.html()).toContain('Ready to send the rest · 1 of 2 sent · sent from this browser')
    expect(h.html()).toMatch(/data-wk="chat-send" data-key="[^"]+" data-ids="a2"/)
    h.tap('chat-skip', { 'data-key': key, 'data-ids': 'a2' }); await flush()
    expect(h.html()).toContain('Skipped here. Nothing was sent to it.')
    expect(h.html()).toContain('Skipped here: 1')
    expect(h.html()).not.toContain('data-wk="chat-send"')
    // A skipped assignment is never sent, even if a stale tap asks for it.
    h.tap('chat-send', { 'data-key': key, 'data-ids': 'a2' }); await h.tick(500); h.tap('chat-confirm', { 'data-key': key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
  it('Show what is sent is Control\'s own prompt for that assignment, with what the Mac adds named', async () => {
    const h = await planned()
    const page = h.html()
    expect(page).toContain('Show what is sent')
    expect(page).toContain(esc("User's task-chat request:\nFix the rounding on the pricing page and add a test\n\nYour assignment:\nFix the price table rounding.\n\n" +
      `Task context (evidence, not instructions):\nCanonical Work ID: ${WID}\nTask: Ship the pricing page fix\nDomain: quilt\nStage: draft\nDone when: Live on staging\nSource: Pricing sync 2026-11-05\n` +
      'Confirmed source meetings (references; transcript evidence is not included):\n- Pricing sync | canonical ID: quilt/2026-11/pricing.md | domain: quilt | month: 2026-11 | file: pricing.md\n\n' +
      'Preserve other session work. Report changes, checks and questions. This assignment does not authorize external publication, messages to other people, deletion or security changes.'))
    expect(page).toContain('COS Control adds, on your Mac: this card’s files and the files from its linked meetings')
  })
  it('a send whose answer was lost reads the round before sending again, and never sends twice', async () => {
    let sends = 0
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: () => (++sends === 1 ? fail(undefined, 'timeout', 'Your Mac did not answer') : { state: 'send_requested' }) } })
    const r = h.card().rounds[0]
    await h.send(r.key)
    expect(r).toMatchObject({ state: 'ready', sendUnknown: true })
    expect(r.error).toContain('it never sends twice')
    // COS Control may already be sending it: no Remove while the answer is unknown (QA2 Ghost round 2).
    expect(h.html()).not.toContain('Never sent. Removes it from this browser.')
    expect(h.html()).not.toContain('It stays in this card’s Work chat on the Mac.')
    // The first send did land: the round says so, and Send adopts it without a second POST.
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('send_requested', 'pending', 'pending')
    await h.send(r.key)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET')).toHaveLength(1)
    expect(sends).toBe(1)
    expect(r.state).toBe('sending')
  })
  it('a lost answer for a send that never landed sends it once more after checking', async () => {
    let sends = 0
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: () => (++sends === 1 ? fail(undefined, undefined, 'Failed to fetch') : { state: 'send_requested' }),
      [`/api/work/chat/lens-rounds/${ROUND}`]: view('in_history', 'pending', 'pending') } })
    const r = h.card().rounds[0]
    await h.send(r.key)
    await h.send(r.key)
    expect(sends).toBe(2)
    expect(r.state).toBe('sending')
  })
  it('send_in_progress and already_sent from the server read as on its way, never as a failure', async () => {
    for (const code of ['send_in_progress', 'already_sent']) {
      const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, code) } })
      await h.send(h.card().rounds[0].key)
      expect(h.card().rounds[0].state, code).toBe('sending')
    }
  })
  it('COS Control not connected (423): the plan is saved for the Mac and is never offered again here', async () => {
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(423, 'control_not_connected') } })
    const r = h.card().rounds[0]
    await h.send(r.key)
    expect(r.state).toBe('held')
    expect(h.html()).toContain('COS Control was not connected, so send it from Work on the Mac. It cannot be sent again from here.')
    expect(h.html()).not.toContain('data-wk="chat-send"')
    h.tap('chat-send', { 'data-key': r.key, 'data-ids': 'a1,a2' }); await h.tick(500); h.tap('chat-confirm', { 'data-key': r.key }); await flush()
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)).toHaveLength(1)
  })
  it('a stale plan and a lost plan end plainly', async () => {
    const stale = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, 'plan_stale') } })
    await stale.send(stale.card().rounds[0].key)
    expect(stale.card().rounds[0]).toMatchObject({ state: 'notDelivered', error: 'This card’s sessions changed since the plan. Nothing was sent. Plan again.' })
    const gone = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(404, 'unknown_round') } })
    await gone.send(gone.card().rounds[0].key)
    expect(gone.card().rounds[0].error).toBe('Your Mac no longer has this plan. Nothing was sent. Plan again.')
  })
})

describe('after Send: delivery, the reply and the updates come back to this card', () => {
  it('reads the round until it ends, then shows delivered (never completed), the reply, and Latest updates', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending', { inHistory: true })
    await h.send(h.card().rounds[0].key)
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
    await h.send(h.card().rounds[0].key); await h.tick(1)
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
    await h.send(h.card().rounds[0].key); await h.tick(1)
    expect(h.card().rounds[0].state).toBe('partly')
    expect(h.html()).toContain('No Codex model is available to start a session. Nothing was sent.')
    expect(h.html()).toContain('Not sent: 1')
    expect(h.html()).toContain('Partly sent · sent from this browser')
  })
  it('stops reading after 26 minutes without calling it stopped, and Check again reads it once more', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await h.send(h.card().rounds[0].key)
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
    await h.send(h.card().rounds[0].key); await h.tick(1)
    h.tap('chat-stop', { 'data-key': h.card().rounds[0].key }); await flush(30)
    expect(h.sent(`/api/work/chat/lens-rounds/${ROUND}/stop`)[0]!.body).toEqual({ v: 1, assignmentIds: ['a2'] })
  })
  it('leaving Work stops every read; coming back picks the round up again', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await h.send(h.card().rounds[0].key)
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
    expect(r.error).toBe('Planning stopped when this page closed. Nothing was sent. Plan again to plan it.')
    again.tap('chat-again', { 'data-key': r.key })
    expect(again.box()!.value).toBe('Plan this please')
    expect(again.calls.some(c => c.path.includes('lens-rounds'))).toBe(false)
  })
  it('a sending round comes back after a reload and keeps reading the server', async () => {
    const h = await planned()
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await h.send(h.card().rounds[0].key)
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

describe('the rest of the card, as on the Mac', () => {
  const two = { ...ACTIVITY, activities: [
    { id: 'r-new', workId: WID, status: 'delivered', provider: 'claude', sessionId: S1, sessionTitle: 'Pricing page', createdAt: '2026-11-06T22:59:00.000Z',
      progress: { reported: 'done', evidence: 'Fixed and checked.', reportedBy: 'session' } },
    { id: 'r-old', workId: WID, status: 'delivered', provider: 'codex', sessionId: S3, sessionTitle: 'Price test', createdAt: '2026-11-06T20:00:00.000Z',
      progress: { reported: 'blocked', evidence: 'No fixtures for cents.', reportedBy: 'session' } }] }
  const writable = (h: ReturnType<typeof load>) => { h.chat.S.caps = { version: 1, writable: true, editTasks: 1 } }
  // A part repainted in place holds its own HTML; after a full repaint it is the slice of the pane's HTML.
  const slice = (html: string, from: string, to: string) => { const i = html.indexOf(from); return i < 0 ? '' : html.slice(i + from.length, html.indexOf(to, i)) }
  const side = (h: ReturnType<typeof load>) => h.dom.ids.get('wk-part-side')!.html || slice(h.dom.pane.html, 'id="wk-part-side">', '</aside>')
  const main = (h: ReturnType<typeof load>) => h.dom.ids.get('wk-part-main')!.html || slice(h.dom.pane.html, 'id="wk-part-main" class="wk-part">', '<section class="wk-section wk-chat"')
  it('Connections: Agent workspace, and View progress shows that session\'s handoff until Latest handoff', async () => {
    const h = await opened({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: two } })
    expect(side(h)).toContain('data-wk="show-workspace">Agent workspace</button>')
    expect(side(h)).toContain('Inspecting Pricing page')
    expect(side(h)).toMatch(/data-wk="inspect" data-id="a1b2c3d4e5f6" data-sid="codex:33333333[^"]*">View progress/)
    h.tap('inspect', { 'data-id': ID, 'data-sid': S3 }); await flush()
    expect(side(h)).toContain('Inspecting Price test')
    expect(side(h)).toContain('Session reported: Blocked')
    expect(side(h)).toContain('data-wk="inspect-clear"')
    // A reply answers the card's newest handoff only, so it is not offered while another session is inspected.
    expect(side(h)).not.toContain('data-wk="reply-open"')
    h.tap('inspect-clear', { 'data-id': ID }); await flush()
    expect(side(h)).toContain('Inspecting Pricing page')
    expect(side(h)).not.toContain('data-wk="inspect-clear"')
    expect(side(h)).toContain('data-wk="reply-open"')
  })
  it('Mark complete appears where the session reported done, confirms there, and moves the card to Complete', async () => {
    const h = load({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: two, '/api/work-board/stage': { ok: true } } })
    writable(h); h.render(); await flush(); h.render(); await flush()
    expect(side(h)).toContain('data-wk="complete-here"')
    // A session that reported blocked offers no Mark complete.
    h.tap('inspect', { 'data-id': ID, 'data-sid': S3 }); await flush()
    expect(side(h)).not.toContain('data-wk="complete-here"')
    h.tap('inspect-clear', { 'data-id': ID }); await flush()
    h.tap('complete-here', { 'data-id': ID }); await flush()
    expect(side(h)).toContain('Mark “Ship the pricing page fix” complete?')
    expect(main(h)).toContain('Copy task ID')
    expect(main(h)).not.toContain('complete?')
    h.tap('complete-yes', { 'data-id': ID }); await flush()
    expect(h.sent('/api/work-board/stage')[0]!.body).toEqual({ domain: 'quilt', id: ID, expectedText: 'Ship the pricing page fix', expectedRevision: 'f'.repeat(64), workStage: 'complete' })
    // Not offered on a server that cannot write Work, or before a session reported done.
    const ro = await opened({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: two } })
    expect(side(ro)).not.toContain('data-wk="complete-here"')
  })
  it('Link a meeting lists a month\'s saved meetings, links one with the card\'s revision, and says why when refused', async () => {
    const MEETINGS = { meetings: [
      { domain: 'quilt', month: '2026-11', filename: 'standup.md', title: 'Standup with Graham', recordId: 'quilt/2026-11/standup.md', date: '2026-11-06' },
      { domain: 'quilt', month: '2026-11', filename: 'pricing.md', title: 'Pricing sync', recordId: 'quilt/2026-11/pricing.md', date: '2026-11-05' },
      { domain: 'quilt', month: '2026-11', filename: 'broken.md', title: 'No identity' }] }
    let linkAnswer: unknown = { ok: true }
    const h = load({ answers: { '/api/meetings?limit=200&domain=all&month=2026-11': MEETINGS, '/api/work-board/meeting': () => linkAnswer } })
    writable(h); h.render(); await flush(); h.render(); await flush()
    h.tap('link-meeting', { 'data-id': ID }); await flush()
    expect(h.calls.some(c => c.path === '/api/meetings?limit=200&domain=all&month=2026-11')).toBe(true)
    expect(side(h)).toContain('Standup with Graham')
    expect(side(h)).toMatch(/Pricing sync<\/strong>.*?Linked/)
    expect(side(h)).not.toContain('No identity')
    linkAnswer = fail(409, 'meeting_identity_changed')
    h.tap('link-meeting-pick', { 'data-rid': 'quilt/2026-11/standup.md' }); await flush()
    expect(side(h)).toContain('That meeting changed since the list loaded. Refresh the list and pick it again.')
    linkAnswer = { ok: true }
    h.tap('link-meeting-pick', { 'data-rid': 'quilt/2026-11/standup.md' }); await flush()
    expect(h.sent('/api/work-board/meeting').at(-1)!.body).toEqual({ domain: 'quilt', id: ID, expectedText: 'Ship the pricing page fix', expectedRevision: 'f'.repeat(64),
      meeting: { domain: 'quilt', month: '2026-11', filename: 'standup.md', recordId: 'quilt/2026-11/standup.md' } })
    const ro = await opened()
    expect(side(ro)).toMatch(/data-wk="link-meeting"[^>]*disabled title="This server can’t write Work links yet\."/)
  })
  async function sendBack(stage: string) {
    let reads = 0
    const h = load({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: two, '/api/work-board/stage': { ok: true },
      '/api/work-board/handoff-requests': (b: any) => ({ request: { clientRequestId: b.clientRequestId, state: 'pending', createdAt: '2026-11-06T23:00:00.000Z' } }),
      '/api/work-board/handoff-requests/*': () => ({ request: { state: ++reads === 1 ? 'claimed' : 'sent', receiptId: 'r-9', createdAt: '2026-11-06T23:00:00.000Z' } }) } })
    h.chat.S.tasks = [{ ...TASK, workStage: stage }]; h.chat.S.loadedAt = Date.now() + 1
    writable(h); h.render(); await flush(); h.render(); await flush()
    h.tap('reply-open', { 'data-id': ID }); await flush()
    h.dom.fire('input', { id: '', hasAttribute: (n: string) => n === 'data-wk-reply', getAttribute: () => ID, value: 'The cents column still rounds down.' })
    h.tap('reply-send', { 'data-id': ID, 'data-intent': 'notDone' }); await flush()
    return h
  }
  it('Not done yet sends a QA card back to Draft once COS Control sent it, as the Mac does, and leaves other stages', async () => {
    const h = await sendBack('qa')
    expect(h.sent('/api/work-board/handoff-requests')[0]!.body).toMatchObject({ intent: 'notDone', replyTo: 'r-new', note: 'The cents column still rounds down.' })
    expect(h.sent('/api/work-board/stage')).toHaveLength(0)
    await h.tick(3000); await flush()
    expect(h.sent('/api/work-board/stage')).toHaveLength(0)   // claimed is not sent
    await h.tick(3000); await flush()
    expect(h.sent('/api/work-board/stage').map(c => c.body.workStage)).toEqual(['draft'])
    await h.tick(9000); await flush()
    expect(h.sent('/api/work-board/stage')).toHaveLength(1)
    const planned = await sendBack('planned')
    await planned.tick(9000); await flush()
    expect(planned.sent('/api/work-board/stage')).toHaveLength(0)
  })
  it('a tap on a plan\'s Send while the Work chat box has focus still opens the confirm', async () => {
    const h = await planned()
    h.box()!.focus()
    h.tap('chat-send', { 'data-key': h.card().rounds[0].key, 'data-ids': 'a1,a2' }); await flush()
    expect(h.html()).toContain('Send to “Pricing page” and a new Codex session?')
  })
})

describe('QA follow-ups: limits, truthful states, two tabs, Open session', () => {
  it('the 2,000-character limit is the server planner\'s own, and the 26-minute bound is the server\'s send end plus a minute', async () => {
    const h = load()
    const n = h.chat.limits.questionChars
    const body = (q: string) => ({ workID: WID, revision: 'f'.repeat(64), question: q, context: '', sessions: [], history: [], updates: [], mode: 'plan' })
    expect(() => parseWorkChatInput(body('x'.repeat(n)))).not.toThrow()
    expect(() => parseWorkChatInput(body('x'.repeat(n + 1)))).toThrow()
    expect(h.chat.limits.pollMaxMs).toBe(LENS_SEND_PICKUP_MS + LENS_SEND_REPORT_MS + 60_000)
  })
  it('send_in_progress and already_sent say Checking, never that nothing has been sent', async () => {
    for (const code of ['already_sent', 'send_in_progress']) {
      const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, code) } })
      await h.send(h.card().rounds[0].key)
      const page = h.html()
      expect(page, code).toContain('COS Control already has a send for this plan. Checking where it is…')
      expect(page, code).toContain('Checking · planned with')
      expect(page, code).not.toContain('Nothing has been sent yet')
    }
  })
  it('a held plan stops being read at the bound, stays stopped across visits and reloads, and Check again reads it once', async () => {
    const h = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(423, 'control_not_connected') } })
    h.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('in_history', 'pending', 'pending')
    await h.send(h.card().rounds[0].key)
    expect(h.card().rounds[0].state).toBe('held')
    await h.tick(27 * 60000)
    const r = h.card().rounds[0]
    expect(r.pollStopped).toBe(true)
    expect(h.html()).toContain('This page stopped checking it.')
    const reads = () => h.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET').length
    const before = reads()
    h.def.leave(); h.setRoute([], 'today'); h.setRoute([ID]); h.def.load([ID]); await flush()
    await h.tick(60000)
    expect(reads()).toBe(before)
    h.chat.save(true)
    const again = load({ storage: h.storage, answers: { [`/api/work/chat/lens-rounds/${ROUND}`]: view('in_history', 'pending', 'pending') } })
    again.def.load([ID]); await flush(); await again.tick(60000)
    expect(again.sent(`/api/work/chat/lens-rounds/${ROUND}`, 'GET')).toHaveLength(0)
    h.tap('chat-check', { 'data-key': r.key }); await h.tick(1)
    expect(reads()).toBe(before + 1)
    expect(r.state).toBe('held')
  })
  it('two tabs: neither drops the other\'s rounds, the newer copy of a round wins, and the other tab shows it', async () => {
    const storage: Record<string, string> = {}
    const a = await opened({ storage })
    const b = await opened({ storage })
    a.type('Plan from tab A'); a.tapEl('wk-cmp-plan'); await flush(30)
    a.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await a.send(a.card().rounds[0].key); a.chat.save(true)
    const key = a.card().rounds[0].key
    // Tab B loaded before A saved. It types and saves: A's round, still on its way, stays in the store, and B shows it.
    b.type('Draft in tab B'); await b.tick(400)
    let stored = JSON.parse(storage['cos.web.work.chat']!).cards[WID]
    expect(stored.rounds.map((r: { key: string }) => r.key)).toContain(key)
    expect(stored.draft).toBe('Draft in tab B')
    expect(b.card().rounds.map((r: { key: string }) => r.key)).toContain(key)
    // A's round moves on; B's older copy never overwrites it.
    a.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'delivered')
    await a.tick(1); a.chat.save(true)
    b.type('Draft in tab B, edited'); await b.tick(400)
    stored = JSON.parse(storage['cos.web.work.chat']!).cards[WID]
    expect(stored.rounds.find((r: { key: string }) => r.key === key).state).toBe('sent')
    expect(b.card().rounds.find((r: { key: string }) => r.key === key).state).toBe('sent')
    expect(stored.draft).toBe('Draft in tab B, edited')
  })
  it('a draft typed in one tab shows in another that has not typed since; a tab typing keeps its own', async () => {
    const storage: Record<string, string> = {}
    const a = await opened({ storage })
    const c = await opened({ storage })
    a.type('From tab A'); await a.tick(400)
    c.chat.mergeIn()
    expect(c.card().draft).toBe('From tab A')
    expect(c.box()!.value).toBe('From tab A')
    c.box()!.focus(); c.type('Tab C is typing')
    a.type('A again'); await a.tick(400)
    c.chat.mergeIn()
    expect(c.box()!.value).toBe('Tab C is typing')
  })
  it('keeps a round still on its way even past the eight a card keeps', async () => {
    const round = (i: number, state: string, roundId = '') => ({ key: `web-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, roundId, question: 'q' + i, answer: 'a', assignments: [{ id: 'a1', mode: 'continue', sessionID: S1, provider: 'claude', prompt: 'p', title: 't' }],
      state, states: {}, at: Date.parse('2026-11-06T20:00:00.000Z') + i * 1000, sentAt: 0 })
    const rounds = [round(1, 'sending', 'lr_aaaaaaaaaaaaaaaa'), round(2, 'sent', 'lr_bbbbbbbbbbbbbbbb'), ...[3, 4, 5, 6, 7, 8, 9, 10].map(i => round(i, 'ready'))]
    const h = await opened({ storage: { 'cos.web.work.chat': JSON.stringify({ v: 1, cards: { [WID]: { at: 1, draft: '', rounds } } }) } })
    h.type('x'); await h.tick(400)
    const kept = JSON.parse(h.storage['cos.web.work.chat']!).cards[WID].rounds.map((r: { key: string }) => r.key)
    expect(kept).toContain(rounds[0]!.key)
    expect(kept).not.toContain(rounds[1]!.key)
    expect(kept).toHaveLength(9)
  })
  it('Remove takes away a round that was never sent, from this browser only, with no server call', async () => {
    // A plan that failed: never saved, never sent.
    const h = await planned({ answers: { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : fail(503, 'work_chat_unavailable')) } })
    const r = h.card().rounds[0]
    expect(r.state).toBe('planFailed')
    expect(h.html()).toContain('Never sent. Removes it from this browser.')
    const calls = h.calls.length
    h.tap('chat-remove', { 'data-key': r.key }); await h.tick(400)
    expect(h.card().rounds).toHaveLength(0)
    expect(h.calls.length).toBe(calls)
    expect(JSON.parse(h.storage['cos.web.work.chat']!).cards[WID].rounds).toHaveLength(0)
    // A plan that was saved but never sent says where it stays; one on its way or sent has no Remove.
    const saved = await planned({ answers: { [`/api/work/chat/lens-rounds/${ROUND}/send`]: fail(409, 'plan_stale') } })
    await saved.send(saved.card().rounds[0].key)
    const html = saved.html()
    expect(saved.card().rounds[0].roundId).toBe(ROUND)
    expect(html).toContain('Removes it from this browser. It stays in this card’s Work chat on the Mac.')
    const moving = await planned()
    moving.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sending', 'pending', 'pending')
    await moving.send(moving.card().rounds[0].key)
    expect(moving.html()).not.toContain('data-wk="chat-remove"')
    moving.tap('chat-remove', { 'data-key': moving.card().rounds[0].key }); await flush()
    expect(moving.card().rounds).toHaveLength(1)
    moving.answers[`/api/work/chat/lens-rounds/${ROUND}`] = view('sent', 'delivered', 'delivered')
    await moving.tick(3000)
    expect(moving.card().rounds[0].state).toBe('sent')
    expect(moving.html()).not.toContain('data-wk="chat-remove"')
  })
  it('a round removed in one tab is not brought back by another tab\'s save', async () => {
    const storage: Record<string, string> = {}
    const a = await planned({ storage, answers: { '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : fail(503, 'work_chat_unavailable')) } })
    a.chat.save(true)
    const b = await opened({ storage })
    expect(b.card().rounds).toHaveLength(1)
    a.tap('chat-remove', { 'data-key': a.card().rounds[0].key }); a.chat.save(true)
    b.type('B types and saves'); await b.tick(400)
    expect(JSON.parse(storage['cos.web.work.chat']!).cards[WID].rounds).toHaveLength(0)
    expect(b.card().rounds).toHaveLength(0)
  })
  it('the Agent workspace box has Open session, as the Mac does', async () => {
    const two = { ...ACTIVITY, activities: [{ id: 'r-new', workId: WID, status: 'delivered', provider: 'claude', sessionId: S1, sessionTitle: 'Pricing page', createdAt: '2026-11-06T22:59:00.000Z' }] }
    const h = await opened({ answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: two } })
    const html = h.dom.ids.get('wk-part-side')!.html || h.dom.pane.html
    expect(html).toMatch(/Agent workspace<\/h2>[\s\S]*data-wk="session" data-provider="claude" data-sid="11111111-1111-4111-8111-111111111111">Open session</)
  })
})

// ── W1 (Control 0.5.386 parity, PLAN_work_chat_no_session T9): an empty card, Plan again, Start work's default ──
const EMPTY_INPUT = { ...INPUT, rows: [] as unknown[], leftOut: [] as unknown[], discovered: 0 }
const NO_ASSIGN = { protocolVersion: 1, answer: 'Nothing on this card can pick this up yet.', assignments: [] as unknown[], model: 'claude:claude-opus-5-5', effort: 'high' }
const chatPlanBody = (h: Awaited<ReturnType<typeof opened>>) => h.calls.filter(c => c.path === '/api/work/chat' && c.method === 'POST').map(c => c.body)

describe('W1: an empty card plans one New session, as Control 0.5.386 does', () => {
  it('offers the planner exactly one provider (Claude) and says so while it plans', async () => {
    const h = await planned({ answers: { '/api/work/orchestrator/input': EMPTY_INPUT, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : NO_ASSIGN) } })
    const body = chatPlanBody(h)[0]
    expect(body.newSessionProviders).toEqual(['claude'])
  })
  it('Codex when Claude is low, and never a used-up provider', async () => {
    const low = { ...EMPTY_INPUT, usage: [{ ...INPUT.usage[0], state: 'low' }, INPUT.usage[1]] }
    const h = await planned({ answers: { '/api/work/orchestrator/input': low, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : NO_ASSIGN) } })
    expect(chatPlanBody(h)[0].newSessionProviders).toEqual(['codex'])
    const out = { ...EMPTY_INPUT, usage: [INPUT.usage[0], { ...INPUT.usage[1], state: 'exhausted' }] }
    const h2 = await planned({ answers: { '/api/work/orchestrator/input': out, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : NO_ASSIGN) } })
    expect(chatPlanBody(h2)[0].newSessionProviders).toEqual(['claude'])
  })
  it('a card with a session it can continue is not an empty card', async () => {
    const h = await planned()
    expect(chatPlanBody(h)[0].newSessionProviders).toEqual(['claude', 'codex'])
  })
  it('keeps one New session at most, stops at Ready to send, and says what Send will do', async () => {
    const two = { ...NO_ASSIGN, answer: 'Start one.', assignments: [{ mode: 'newSession', provider: 'claude', prompt: 'One.' }, { mode: 'newSession', provider: 'claude', prompt: 'Two.' }] }
    const h = await planned({ answers: { '/api/work/orchestrator/input': EMPTY_INPUT, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : two) } })
    const r = h.card().rounds[0]
    expect(r.state).toBe('ready')
    expect(r.assignments.map((a: any) => a.prompt)).toEqual(['One.'])
    expect(h.html()).toContain('No session on this task yet. COS will start a new Claude session when you press Send.')
    expect(h.sent('/api/work/chat/lens-rounds')).toHaveLength(0)
  })
  it('a plan with no assignment offers the New session; the tap opens the usual confirm, and only the confirm sends, once (lead W-D1)', async () => {
    const h = await planned({ answers: { '/api/work/orchestrator/input': EMPTY_INPUT, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : NO_ASSIGN) } })
    const r = h.card().rounds[0]
    expect(r.state).toBe('answered')
    expect(h.html()).toContain('Start a new Claude session with this request')
    expect(h.html()).toContain('Nothing is sent until you press this.')
    h.tap('chat-start-new', { 'data-key': r.key }); await flush(30)
    expect(h.sent('/api/work/chat/lens-rounds'), 'the first tap only asks').toHaveLength(0)
    expect(h.html()).toContain('Send to a new Claude session?')
    h.tap('chat-confirm', { 'data-key': r.key }); await flush(30)
    expect(h.sent('/api/work/chat/lens-rounds'), 'a double tap inside the guard time sends nothing').toHaveLength(0)
    await h.tick(500)
    h.tap('chat-confirm', { 'data-key': r.key }); await flush(30)
    h.tap('chat-confirm', { 'data-key': r.key }); await flush(30)
    const saved = h.sent('/api/work/chat/lens-rounds')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.body.assignments).toEqual([{ id: 'a1', mode: 'newSession', provider: 'claude', prompt: 'Fix the rounding on the pricing page and add a test' }])
    const send = h.sent(`/api/work/chat/lens-rounds/${ROUND}/send`)
    expect(send).toHaveLength(1)
    expect(send[0]!.body).toMatchObject({ confirm: 'two-step', assignmentIds: ['a1'] })
    expect(h.html()).not.toContain('Start a new Claude session with this request')
  })
  it('the offer does nothing while the chat is busy (Q1 R7)', async () => {
    const h = await planned({ answers: { '/api/work/orchestrator/input': EMPTY_INPUT, '/api/work/chat': (b: unknown, m: string) => (m === 'GET' ? CAPS : NO_ASSIGN) } })
    const r = h.card().rounds[0]
    h.card().busy = true
    h.tap('chat-start-new', { 'data-key': r.key }); await flush(30)
    expect(r.assignments).toEqual([])
    expect(r.state).toBe('answered')
  })
  it('Q1 P1: a provider is offered only when the Mac has an available model for it', async () => {
    const noCodex = { features: { durableQueryJobs: true, durableQueryJobsProtocol: 1, claude: true, codex: false } }
    const h = await planned({ answers: { '/api/health': noCodex, '/api/work/orchestrator/input': INPUT } })
    expect(chatPlanBody(h)[0].newSessionProviders).toEqual(['claude'])
    const off = { features: { durableQueryJobs: false, claude: true, codex: true } }
    const h2 = await planned({ answers: { '/api/health': off, '/api/work/orchestrator/input': INPUT } })
    expect(chatPlanBody(h2)[0].newSessionProviders).toEqual([])
  })
})

describe('W1: Plan again reruns a round that failed before planning, in place', () => {
  it('one request is one round: Plan again reuses it, and the composer draft is left alone', async () => {
    let n = 0
    const h = await planned({ answers: { '/api/work/orchestrator/input': () => (++n === 1 ? fail(503, 'orchestrator_input_unavailable') : INPUT) } })
    const r = h.card().rounds[0]
    expect(r.state).toBe('planFailed')
    expect(h.html()).toContain('data-wk="chat-plan-again"')
    expect(h.html()).not.toContain('Use this request again')
    h.type('a new draft')
    h.tap('chat-plan-again', { 'data-key': r.key }); await flush(30)
    expect(h.card().rounds).toHaveLength(1)
    expect(h.card().rounds[0].key).toBe(r.key)
    expect(h.card().rounds[0].state).toBe('ready')
    expect(h.card().draft).toBe('a new draft')
    expect(chatPlanBody(h).map(b => b.question)).toEqual(['Fix the rounding on the pricing page and add a test'])
  })
  it('a round the planner answered is never planned again in place', async () => {
    const h = await planned()
    const r = h.card().rounds[0]
    expect(r.state).toBe('ready')
    h.tap('chat-plan-again', { 'data-key': r.key }); await flush(30)
    expect(chatPlanBody(h)).toHaveLength(1)
    expect(h.card().rounds).toHaveLength(1)
  })
})

describe('W1: Start work opens as COS Control 0.5.386 does (Q1 P2, P3)', () => {
  it('no session of its own and nothing saved: Start a new session on Claude Opus, and Opus is what is sent', async () => {
    const h = await opened({ route: [ID, 'start'] })
    h.chat.renderStart(ID); await flush(30)
    h.chat.renderStart(ID); await flush()
    const page = h.dom.pane.html as string
    expect(page).toContain('value="newSession" checked')
    expect(page).toMatch(/<option value="opus" selected>Claude Opus<\/option>/)
    expect(page).not.toContain('Server default')
    expect(page).toContain('OpenAI via Codex · Frontier')
  })
  it('Claude has no available model: Codex’s first model', async () => {
    const h = await opened({ route: [ID, 'start'], answers: { '/api/health': { features: { durableQueryJobs: true, durableQueryJobsProtocol: 1, claude: false, codex: true } } } })
    h.chat.renderStart(ID); await flush(30)
    h.chat.renderStart(ID); await flush()
    expect(h.dom.pane.html).toMatch(/<option value="codex-frontier" selected>/)
  })
  it('a saved Continue wins, as on the Mac (WorkHandoffStore.swift draft(for:) 910-912)', async () => {
    const saved = { ...ACTIVITY, savedDestination: { mode: 'continueSession', sessionId: S1 } }
    const h = await opened({ route: [ID, 'start'], answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: saved } })
    h.chat.renderStart(ID); await flush()
    expect(h.dom.pane.html).toContain('value="continueSession" checked')
  })
  it('a card with its own session opens on Continue', async () => {
    const own = { ...ACTIVITY,
      activities: [{ id: 'r-1', sessionId: S1, provider: 'claude', sessionTitle: 'Pricing page', status: 'idle', acknowledged: true, createdAt: '2026-11-06T22:00:00.000Z' }] }
    const h = await opened({ route: [ID, 'start'], answers: { [`/api/work-board/activity?domain=quilt&workIdentity=${ID}`]: own } })
    h.chat.renderStart(ID); await flush()
    expect(h.dom.pane.html).toContain('value="continueSession" checked')
  })
})

describe('W1 (audit 02 F6): Sort offers only what this server serves', () => {
  const sortWith = async (caps: Record<string, unknown>, loop: boolean | null) => {
    const h = await opened()
    h.chat.S.tasks = [{ ...JSON.parse(JSON.stringify(TASK)), workStage: 'mentioned' }]
    h.chat.S.intake = []; h.chat.S.loadedAt = Date.now() + 1
    h.chat.S.caps = caps; h.chat.S.undoBatch = 'wi_x:1'; h.chat.S.loopAvailable = loop
    return h.chat.sortView() as string
  }
  it('no undo or batch routes (7.0.13): no Undo, no Keep or Drop, and no promise of a newer server', async () => {
    const html = await sortWith({ writable: true }, false)
    expect(html).toContain('Ship the pricing page fix')
    expect(html).toContain('data-wk="open"')
    expect(html).not.toContain('data-wk="card-keep"')
    expect(html).not.toContain('data-wk="card-drop"')
    expect(html).not.toContain('data-wk="undo"')
    expect(html).not.toMatch(/newer COS server|Work batch changes/)
  })
  it('a server that serves them gets them back', async () => {
    const html = await sortWith({ writable: true, workBatch: 1 }, true)
    expect(html).toContain('data-wk="card-keep"')
    expect(html).toContain('data-wk="card-drop"')
    expect(html).toContain('data-wk="undo"')
  })
})

describe('W1 (audit 02 F8): a request from the phone says it needs COS Control open, and how long it waits', () => {
  const startWith = async (request: Record<string, unknown>) => {
    const h = await opened({ route: [ID, 'start'] })
    h.chat.S.start[WID] = { mode: 'newSession', sessionId: '', model: '', note: '', sending: false, request, error: '', fromSaved: false, madeAt: new Date(), fails: 0, pollStopped: '' }
    h.chat.renderStart(ID); await flush()
    return h.dom.pane.html as string
  }
  it('pending: COS Control has to be open on the Mac, and the minutes left', async () => {
    const html = await startWith({ clientRequestId: 'r1', state: 'pending', expiresAt: new Date(Date.parse('2026-11-06T23:00:00.000Z') + 7 * 60000 - 1000).toISOString() })
    expect(html).toContain('Waiting for COS Control on your Mac to pick this up. COS Control has to be open on the Mac. Nothing has been sent yet. It waits 7 more minutes.')
  })
  it('expired: nothing was sent, open COS Control and send again', async () => {
    const html = await startWith({ clientRequestId: 'r1', state: 'expired' })
    expect(html).toContain('COS Control on your Mac did not pick this up within 10 minutes, so nothing was sent. Open COS Control on the Mac, then send it again.')
  })
})
