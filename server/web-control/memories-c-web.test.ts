/**
 * COS Control Web: Memories direction C (the index; the build after 7.0.42, F1 plan
 * wk46_2026/production_hardening/lanes/F1_memories_C_build_plan.md). Runs the REAL panes/memories.js in a vm with a fake
 * COSWeb, document, bridge and cue routes, the way memories-web.test.ts and settings-p2.test.ts do, and drives it with
 * the same act() a tap runs. Every write goes to the fakes; nothing reaches a live server.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'panes', 'memories.js'), 'utf8')
const REVIEW_SOURCE = readFileSync(join(HERE, 'memory-review.js'), 'utf8')
const APP_ESC_SRC = /\n  function esc\(s\) \{\n[\s\S]*?\n  \}\n/.exec(readFileSync(join(HERE, 'app.js'), 'utf8'))
if (!APP_ESC_SRC) throw new Error('app.js esc() not found: the escaping tests need the real one')
const APP_ESC = new Function(APP_ESC_SRC[0] + '; return esc;')() as (s: unknown) => string
const flush = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

type Answer = unknown | ((args: any) => unknown)
type CueAnswer = (path: string, body?: any) => unknown
const NOW = Date.now()
const MIN = 60_000

// ── fixtures ──
const needsItem = (o: Record<string, unknown>) => ({ gate: 'attribution', rank: 0, reason: "names bradley near 'wants' with no attribution field", store: 'bot_memory', category: 'decision', ts: '2026-11-13T17:20:31Z', ...o })
function block(o: Record<string, unknown> = {}) {
  return { count: 41, limit: 7, gates: { prune_ready: 40, attribution: 1 }, items: [
    needsItem({ lesson_id: 'mem_who', event_id: 'evt_who', title: 'decision: Bradley wants the discount as a percentage' }),
    needsItem({ gate: 'prune_ready', reason: 'never recalled, older than 180 days', lesson_id: 'mem_old1', event_id: 'evt_pr1', title: 'Old memory one' }),
  ], ...o }
}
function status(o: Record<string, unknown> = {}) {
  return { runtimeState: 'ready', installedVersion: '7.0.43', ownerName: 'Miles Ukaoma', contextScriptsDirectory: '/x', learningRewardEnabled: false, learningToReview: 2,
    needsYou: { meetings: 2, decisions: 1, quarantineBatch: 1, total: 4 }, needs_you: block(), ...o }
}
function base(): Record<string, Answer> {
  return {
    status: status(),
    'ws:learning_page': { protocol: 1, matched_total: 34195, next_cursor: null, coverage: {}, counts_by_type: { retrieved: 30886, used: 170 },
      stores: { capture_ledger: { readable: true, count: 10, last_ts: new Date(NOW - 3600_000).toISOString() } }, complete: true, items: [] },
    'ws:review_page': { protocol: 1, matched_total: 3, next_cursor: null, items: [
      { event_id: 'evt_prop', lesson_id: 'siq_1', event_type: 'proposed', store: 'self_improvement_queue', title: 'daily-reflect: repair graph queries', target: { kind: 'task-proposal', id: 'siq_1' }, source_refs: [], ts: '2026-11-12T05:00:00Z' },
      { event_id: 'evt_pr1', lesson_id: 'mem_old1', event_type: 'captured', store: 'bot_memory', category: 'Prune ready · never recalled, older than 180 days', title: 'Old memory one', target: { kind: 'memory' }, source_refs: [], ts: '2026-05-07T01:37:36Z' },
    ] },
    'graph.status': { engine: 'lightrag', entities: 53297, relationships: 123180, index_state: 'fresh', build: { doc_count: 1945 }, source: { owner_state: 'owner', is_owner: true },
      queue: { pending: 0 }, budget: { used: 0, cap: 1500 }, lock: { state: 'free' }, processor: { state: 'none' } },
    'graph.search': { items: [] },
    'memories.list': { memories: [], total: 21837, byType: { correction: 2492, decision: 4673, session_summary: 14566 } },
    'memory.detail': (a: { id: string }) => ({ id: a.id, summary: 'Summary of ' + a.id, content: 'Content of ' + a.id, type: 'decision' }),
    'ws:memory_page': (a: { q: string }) => ({ protocol: 1, matched_total: 3, next_cursor: null, items: a.q
      ? [{ id: 'mem_hit', type: 'decision', created_at: '2026-11-13T10:00:00', summary: 'A match for ' + a.q }]
      : [{ id: 'mem_c1', type: 'correction', created_at: '2026-11-13T10:00:00', summary: 'Use percent for discounts' },
        { id: 'mem_d1', type: 'decision', created_at: '2026-11-13T09:00:00', summary: 'Ship on Thursday' }] }),
    'learning.list': { events: [{ event_id: 'evt_u1', lesson_id: 'mem_u', event_type: 'used', store: 'memory_trace', title: 'Applied 3 times · deterministic_check', source_refs: [{ kind: 'assistant_turn', id: 'x', excerpt: 'Used it.' }], ts: '2026-11-13T03:08:09Z' }], total: 76, nextCursor: null, coverage: { used: { state: 'ok' } } },
    'memory.review': (a: { decision: string }) => ({ decision: { decision: a.decision === 'prune' ? 'pruned' : 'accepted' } }),
  }
}
const G2 = 'meeting_' + (NOW - 300 * MIN) + '_g2'
const MAC = 'mac_' + (NOW - 120 * MIN) + '_desk'
const cue = (id: string, sessionId: string, at: number, o: Record<string, unknown> = {}) => ({ v: 1, cueId: id, sessionId, createdAt: at, armedAt: null, detail: 'Cue text ' + id, kind: 'insight', title: '', meetingTitle: '', titleSource: 'capture', sources: [], rating: null, ...o })
function history(o: { cues?: unknown[]; counts?: Record<string, number>; skips?: unknown; noSkips?: boolean } = {}) {
  const cues = o.cues ?? [
    cue('cue-g2-0001', G2, NOW - 290 * MIN, { title: 'Pricing review' }), cue('cue-g2-0002', G2, NOW - 280 * MIN, { title: 'Pricing review' }), cue('cue-g2-0003', G2, NOW - 270 * MIN, { title: 'Pricing review' }),
    cue('cue-mac-0001', MAC, NOW - 110 * MIN), cue('cue-mac-0002', MAC, NOW - 100 * MIN),
  ]
  const out: Record<string, unknown> = { v: 1, cues, counts: o.counts ?? { total: 12, rated: 7, unrated: cues.length, byVerdict: {} }, truncated: false, skipped: 0, maxCuesPerMeeting: 40 }
  if (!o.noSkips) out.skips = o.skips === undefined ? {} : o.skips
  return out
}
function cueRoutes(o: { week?: () => unknown; rated?: () => unknown; skip?: (body: any) => unknown; clear?: (body: any) => unknown } = {}): CueAnswer {
  return (path, body) => {
    if (path.startsWith('/api/live-cues/history') && path.includes('unrated=1')) return (o.week ?? (() => history()))()
    if (path.startsWith('/api/live-cues/history')) return (o.rated ?? (() => ({ v: 1, cues: [cue('cue-rated-01', G2, NOW - 2000 * MIN, { rating: { verdict: 'useful', note: null, vote: null, at: 1 } })], counts: { total: 1, rated: 1, unrated: 0, byVerdict: {} }, truncated: false, skips: {} })))()
    if (path === '/api/live-cues/skip') return (o.skip ?? ((b: any) => ({ ok: true, sessionId: b.sessionId, skippedAt: NOW })))(body)
    if (path === '/api/live-cues/skip/clear') return (o.clear ?? ((b: any) => ({ ok: true, sessionId: b.sessionId, skippedAt: null })))(body)
    if (path === '/api/live-cues/feedback') return { ok: true, cueId: body.cueId, verdict: body.verdict, vote: null }
    const e = new Error('Not found') as Error & { status?: number }; e.status = 404; throw e
  }
}

/** A server whose needsYou.meetings follows its own skips (S1's computeNeedsYou leaves skipped meetings out). */
function skippingServer(base = 2) {
  const skips = new Set<string>()
  const meetings = () => base - skips.size
  return {
    answers: { status: () => status({ needsYou: { meetings: meetings(), decisions: 1, quarantineBatch: 1, total: meetings() + 2 } }) } as Record<string, Answer>,
    cues: cueRoutes({ skip: (b: any) => { skips.add(b.sessionId); return { ok: true, sessionId: b.sessionId, skippedAt: NOW } },
      clear: (b: any) => { skips.delete(b.sessionId); return { ok: true, sessionId: b.sessionId, skippedAt: null } } }),
  }
}

interface FakeEl { id: string; innerHTML: string; value: string; [k: string]: any }
function load(opts: { answers?: Record<string, Answer>; wide?: boolean; cues?: CueAnswer } = {}) {
  const answers: Record<string, Answer> = { ...base(), ...(opts.answers ?? {}) }
  const calls: Array<{ op: string; args: any }> = []
  const cueCalls: Array<{ method: string; path: string; body: any }> = []
  const cueAnswer: CueAnswer = opts.cues ?? cueRoutes()
  const toasts: string[] = []
  const els = new Map<string, FakeEl>()
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const make = (id: string): FakeEl => {
    const cls = new Set<string>()
    let html = ''
    return {
      id, value: '', disabled: false,
      get innerHTML() { return html },
      set innerHTML(v: string) { html = String(v); for (const m of html.matchAll(/\sid="([^"]+)"/g)) if (!els.has(m[1]!)) els.set(m[1]!, make(m[1]!)) },
      classList: { toggle: (c: string, on?: boolean) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c) }, add: (c: string) => { cls.add(c) }, remove: (c: string) => { cls.delete(c) }, contains: (c: string) => cls.has(c) },
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) },
      querySelector: () => null, querySelectorAll: () => [], contains: () => false, focus() {}, blur() {}, select() {}, getAttribute: () => null,
    }
  }
  const pane = make('pane-memories'); els.set('pane-memories', pane)
  let route = { pane: 'memories', args: [] as string[] }
  let def: any = null
  const W = {
    $: (id: string) => els.get(id) ?? null,
    // The page's own escape, read from app.js (the pane's one escape is W.esc), so an escaping test tests the real thing.
    esc: APP_ESC,
    toast: (t: string) => { toasts.push(t) }, readStore: () => ({}), writeStore: () => {},
    skeletonRows: () => '<div class="list"><div class="skel-row"></div></div>',
    copyText: () => Promise.resolve(),
    parseRoute: () => route,
    go: (p: string, args: string[] = []) => { route = { pane: p, args }; def.load(args) },
    goBack: () => { route = { pane: 'memories', args: [] }; def.load([]) },
    replace: (h: string) => location.replace(h),
    setCrumb: () => {}, crumb: () => '',
    registerPane: (name: string, d: unknown) => { if (name === 'memories') def = d },
    api: (path: string, o: { method?: string; body: any } = { body: undefined }) => {
      if (path.startsWith('/api/live-cues/')) {
        cueCalls.push({ method: o.method ?? 'GET', path, body: o.body })
        try { return Promise.resolve(cueAnswer(path, o.body)) } catch (e) { return Promise.reject(e) }
      }
      expect(path).toBe('/api/web-bridge/memories')
      const { op, args } = o.body
      calls.push({ op, args })
      const key = op === 'workspace.request' ? 'ws:' + args.action : op
      const a = answers[key]
      let v: unknown
      try { v = typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a } catch (e) { return Promise.resolve({ ok: false, message: (e as Error).message, details: {} }) }
      if (v instanceof Error) return Promise.resolve({ ok: false, message: v.message, details: {} })
      return Promise.resolve({ ok: true, message: '', details: v ?? {} })
    },
  }
  const document = {
    getElementById: (id: string) => els.get(id) ?? null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners['doc:' + type] ??= []).push(fn) },
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild: () => {} }, body: { classList: make('body').classList, appendChild: () => {} }, activeElement: null,
  }
  const media = { matches: !!opts.wide, addEventListener: () => {} }
  const timeout = (fn: () => void, ms?: number) => { if ((ms ?? 0) >= 5000) return 0; return setTimeout(fn, 0) }
  const window = { COSWeb: W, matchMedia: () => media, crypto: globalThis.crypto, localStorage: { getItem: () => null, setItem: () => {} } }
  const location = {
    get hash() { return '#/' + [route.pane].concat(route.args).map(encodeURIComponent).join('/') },
    replace: (h: string) => {
      const args = h.replace(/^#\/memories\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
      const changed = JSON.stringify(args) !== JSON.stringify(route.args)
      route = { pane: 'memories', args }
      if (changed) setTimeout(() => def.load(args), 0)
    },
  }
  const ctx = vm.createContext({ window, document, location, crypto: globalThis.crypto, console, Date, JSON, Math, Promise, Object, Array, String, Number, RegExp, Error, Uint8Array, URL,
    setTimeout: timeout, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} })
  vm.runInContext(REVIEW_SOURCE, ctx)
  vm.runInContext(SOURCE, ctx)
  const t = def._t
  const tap = (name: string, attrs: Record<string, string> = {}) => t.act(name, { getAttribute: (k: string) => attrs[k] ?? null, disabled: false }, null)
  const open = async (args: string[] = []) => { route = { pane: 'memories', args }; def.load(args); await flush() }
  const html = (id: string) => els.get(id)?.innerHTML ?? ''
  const page = () => ['mm-hero', 'mm-health', 'mm-list', 'mm-tools', 'mm-reader'].map(html).join('\n')
  // The pane's own input and submit listeners, as the browser fires them.
  const fire = (type: string, ev: Record<string, unknown>) => { for (const fn of listeners[type] ?? []) fn(ev) }
  return { def, t, S: t.S, calls, cueCalls, toasts, tap, open, html, page, els, fire, route: () => route }
}

// The Needs you header's number, and every counted row's (data-counted), from the index's own markup.
function needsHeader(index: string) {
  const m = /<h2 class="group-title mm-group"><span>Needs you<\/span>(?:<span>([\d,]+)<\/span>)?<\/h2>/.exec(index)
  expect(m, 'Needs you heading').not.toBeNull()
  return m![1] == null ? null : Number(m![1].replace(/,/g, ''))
}
function countedRows(index: string) { return [...index.matchAll(/data-counted="(\d*)"/g)].map(m => m[1] === '' ? null : Number(m[1])) }
function rowNumber(index: string, job: string) {
  const m = new RegExp('data-arg="' + job + '"[^>]*>.*?<span class="mm-idx-n[^"]*">([^<]*)</span>').exec(index)
  return m ? m[1] : undefined
}
function expectHeaderIsSum(index: string) {
  const rows = countedRows(index), head = needsHeader(index)
  expect(rows.length).toBeGreaterThan(0)
  if (rows.some(n => n == null)) expect(head).toBeNull()
  else expect(head).toBe(rows.reduce((a, b) => a! + b!, 0))
}

describe('Memories C: the index', () => {
  it('draws Needs you, Learned, Knowledge and Is it working with their counts, counted rows in the accent, Suggestions not counted', async () => {
    const h = load({ wide: false })
    await h.open()
    const idx = h.html('mm-list')
    for (const head of ['Needs you', 'Learned', 'Knowledge', 'Is it working']) expect(idx).toContain('<span>' + head + '</span>')
    expect(needsHeader(idx)).toBe(4)
    expect(rowNumber(idx, 'meetings')).toBe('2')
    expect(rowNumber(idx, 'who')).toBe('1')
    expect(rowNumber(idx, 'quarantine')).toBe('1')
    expect(idx).toContain('40 old, unused memories, one batch')
    expect(idx).toContain('2 cues in the last one')
    // Suggestions: one open proposal, listed, never counted, and said so in its name.
    expect(rowNumber(idx, 'suggestions')).toBe('1')
    expect(idx).toMatch(/data-arg="suggestions"(?![^>]*data-counted)[^>]*aria-label="Suggestions, 1, not counted"/)
    expect(idx).toMatch(/data-arg="meetings"[^>]*data-counted="2"[\s\S]*?class="mm-idx-n hot">2</)
    expect(idx).toMatch(/data-arg="suggestions"[\s\S]*?class="mm-idx-n">1</)
    // Learned from the memory overview; Rules has no number until the journal reports what it promoted.
    expect(rowNumber(idx, 'corrections')).toBe('2,492')
    expect(rowNumber(idx, 'decisions')).toBe('4,673')
    expect(rowNumber(idx, 'summaries')).toBe('14,566')
    expect(rowNumber(idx, 'rules')).toBe('')
    expect(rowNumber(idx, 'graph')).toBe('53,297')
    expect(idx).toContain('123,180 links')
    expect(rowNumber(idx, 'sources')).toBe('1,945')
    expect(rowNumber(idx, 'used')).toBe('76')
    expect(idx).toContain('This week, 170 in 90 days')
    expect(rowNumber(idx, 'rated')).toBe('1')
    expect(idx).toContain('data-mm="log"')
  })

  it('Sources shows no number from a server that does not send doc_count', async () => {
    const g = { ...(base()['graph.status'] as Record<string, unknown>), build: null }
    const h = load({ answers: { 'graph.status': g } })
    await h.open()
    expect(rowNumber(h.html('mm-list'), 'sources')).toBe('')
  })

  it('the Needs you header equals the sum of its counted rows on the phone index, the wide index and a job page', async () => {
    const srv = skippingServer()
    const phone = load({ wide: false, answers: srv.answers, cues: srv.cues })
    await phone.open()
    expectHeaderIsSum(phone.html('mm-list'))
    const wide = load({ wide: true })
    await wide.open()
    expectHeaderIsSum(wide.html('mm-list'))
    expect(wide.html('mm-reader')).toContain('Skip this meeting')   // the last job opened shows beside the index
    await wide.open(['i', 'who'])
    expectHeaderIsSum(wide.html('mm-list'))
    await phone.open(['i', 'meetings'])
    expectHeaderIsSum(phone.html('mm-list'))
    // After a skip and after deciding the who-said-it item, it still adds up, one less each time.
    phone.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(needsHeader(phone.html('mm-list'))).toBe(3)
    expectHeaderIsSum(phone.html('mm-list'))
    phone.S.decisions.mem_who = 'accepted'; phone.t.paint()
    expect(needsHeader(phone.html('mm-list'))).toBe(2)
    expectHeaderIsSum(phone.html('mm-list'))
  })

  it('an older server (no needsYou) gets the same sum from the needs-you block and the pane\'s own meetings', async () => {
    const h = load({ answers: { status: status({ needsYou: undefined }) } })
    await h.open()
    const idx = h.html('mm-list')
    expect(needsHeader(idx)).toBe(4)
    expectHeaderIsSum(idx)
  })

  it('a part that cannot be read shows no total, never a guessed one', async () => {
    const nullPart = load({ answers: { status: status({ needsYou: { meetings: 2, decisions: null, quarantineBatch: 1, total: null } }) } })
    await nullPart.open()
    expect(needsHeader(nullPart.html('mm-list'))).toBeNull()
    expect(rowNumber(nullPart.html('mm-list'), 'who')).toBe('')
    expectHeaderIsSum(nullPart.html('mm-list'))
    // No needsYou and no needs-you block: nothing to add up.
    const none = load({ answers: { status: status({ needsYou: undefined, needs_you: undefined }) } })
    await none.open()
    expect(needsHeader(none.html('mm-list'))).toBeNull()
    expectHeaderIsSum(none.html('mm-list'))
    // The cue history unreadable and the server's meetings unknown: no total either.
    const cuesDown = load({ answers: { status: status({ needsYou: { meetings: null, decisions: 1, quarantineBatch: 1, total: null } }) },
      cues: cueRoutes({ week: () => { const e = new Error('down') as Error & { status?: number }; e.status = 500; throw e } }) })
    await cuesDown.open()
    expect(needsHeader(cuesDown.html('mm-list'))).toBeNull()
  })

  it('the seven-tab row, the counts line and the footer are gone', async () => {
    for (const wide of [false, true]) {
      const h = load({ wide })
      await h.open()
      const all = h.page()
      expect(all).not.toContain('mm-tabs')
      expect(all).not.toContain('mm-counts')
      expect(all).not.toContain('mm-foot')
      expect(all).not.toContain('data-mm="view"')
      expect(all).not.toContain('Recent learning')
      expect(all).not.toContain('To review (')
      expect(all).not.toContain('events in 90 days')
      expect(all).not.toContain('Stored on this Mac')
      expect(h.t.viewsHtml).toBeUndefined()
      expect(h.t.countsHtml).toBeUndefined()
    }
  })
})

describe('Memories C: a malformed needsYou', () => {
  it('a needsYou sent as an array is treated as absent, not as a count (Q1 minor, 18:29)', async () => {
    const h = load({ answers: { status: status({ needsYou: [2, 1, 1, 4] }) } })
    await h.open()
    const absent = load({ answers: { status: status({ needsYou: undefined }) } })
    await absent.open()
    expect(h.t.needsParts()).toEqual(absent.t.needsParts())
    expect(needsHeader(h.html('mm-list'))).toBe(4)
  })
})

describe('Memories C: the health line', () => {
  it('working: "recalled N times in 90 days", never "used", and Details ends with the Activity log', async () => {
    const h = load()
    await h.open()
    expect(h.t.healthState()).toBe('ok')
    const line = h.html('mm-health')
    expect(line).toContain('Working · recalled 30,886 times in 90 days')
    expect(line).not.toMatch(/used 30,886/)
    expect(line).toContain('>Details</button>')
    h.tap('health')
    const open = h.html('mm-health')
    expect(open).toContain('Working: recalled 30,886 times in 90 days, used in 76 answers this week, advanced search on, server 7.0.43.')
    expect(open).toMatch(/data-mm="log"[^>]*>Activity log</)
    expect(open).toContain('>Hide</button>')
  })

  it('not set up: no store configured says so and offers Set up memory', async () => {
    const h = load({ answers: { status: status({ contextScriptsDirectory: null }) } })
    await h.open()
    expect(h.t.healthState()).toBe('off')
    expect(h.html('mm-health')).toContain('Not set up. COS answers without what you taught it.')
    expect(h.html('mm-health')).toContain('Set up memory')
  })

  it('needs attention: each reason with what to do, counted in the line', async () => {
    const g = { ...(base()['graph.status'] as Record<string, unknown>), queue: { pending: 70, oldest_pending_age_s: Math.round(17.5 * 86400) }, processor: { state: 'none', plist: false } }
    const stale = { ...(base()['ws:learning_page'] as Record<string, any>) }
    stale.stores = { capture_ledger: { readable: true, count: 3, last_ts: new Date(NOW - 5 * 86400_000).toISOString() } }
    const h = load({ answers: { 'graph.status': g, 'ws:learning_page': stale },
      cues: cueRoutes({ week: () => history({ counts: { total: 376, rated: 0, unrated: 5 } }) }) })
    await h.open()
    expect(h.t.healthState()).toBe('warn')
    expect(h.html('mm-health')).toContain('Needs attention · 3 things')
    h.tap('health')
    const d = h.html('mm-health')
    expect(d).toContain('<b>Knowledge is behind.</b> 70 documents are waiting to be added, the oldest for 17.5 days. Adding them is not scheduled on this Mac.')
    expect(d).toMatch(/data-mm="health-queue"[^>]*>See what is waiting</)
    expect(d).toContain('<b>Cue ratings have stopped.</b> None of the 376 cues from the last 7 days is rated, so cues are not getting better.')
    expect(d).toMatch(/data-mm="job" data-arg="meetings"[^>]*>Rate the last meeting</)
    expect(d).toContain('<b>Nothing captured lately.</b>')
    // See what is waiting only opens the queue: no write, no ingest.
    const before = h.calls.length
    h.tap('health-queue'); await flush()
    expect(h.route().args).toEqual(['k', 'sources'])
    expect(h.calls.slice(before).map(c => c.op)).not.toContain('graph.ingest')
  })

  it('an unreadable status needs attention with the reason, and a single reason says "1 thing"', async () => {
    const h = load({ answers: { status: new Error('Your Mac did not answer.') } })
    await h.open()
    expect(h.t.healthState()).toBe('warn')
    expect(h.html('mm-health')).toContain('Needs attention · 1 thing')
    expect(h.t.healthReasons()[0]).toContain('Could not read this Mac')
  })
})

describe('Memories C: meetings to rate', () => {
  it('reads the week\'s unrated cues with limit 1000, groups them by meeting newest first, and pre-selects no verdict', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    expect(h.cueCalls.some(c => c.path === '/api/live-cues/history?days=7&unrated=1&limit=1000')).toBe(true)
    expect(h.cueCalls.some(c => c.path.includes('limit=200'))).toBe(false)
    const groups = h.t.meetingGroups()
    expect(groups.map((g: { sid: string }) => g.sid)).toEqual([MAC, G2])
    const job = h.html('mm-reader')
    // The newest meeting's card: from this Mac, its two cues, five verdicts each, none chosen.
    // No invented time (lead 18:30): with every cue unrated the subtitle says only how many fired.
    expect(job).toContain('On this Mac · 2 cues fired</p>')
    expect(job).not.toMatch(/about a minute|minutes?\b/)
    expect(job).toContain('Cue text cue-mac-0001')
    expect((job.match(/data-mm="cue-rate"/g) ?? []).length).toBe(10)
    expect(job).not.toContain('aria-pressed="true"')
    for (const v of ['Useful', 'Late', 'Repeat', 'Wrong', 'Obvious']) expect(job).toContain('>' + v + '</button>')
    // The list below names the glasses meeting by its title.
    expect(job).toContain('Pricing review')
    expect(job).toContain('On the glasses')
  })

  it('rating sends one cue at a time through the feedback route, and the cue keeps its place with its verdict', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    h.tap('cue-rate', { 'data-id': 'cue-mac-0001', 'data-arg': 'useful' }); await flush()
    const posts = h.cueCalls.filter(c => c.path === '/api/live-cues/feedback')
    expect(posts).toEqual([{ method: 'POST', path: '/api/live-cues/feedback', body: { sessionId: MAC, cueId: 'cue-mac-0001', verdict: 'useful' } }])
    const job = h.html('mm-reader')
    expect(job).toContain('Cue text cue-mac-0001')
    expect(job).toMatch(/data-id="cue-mac-0001" data-arg="useful" aria-label="Useful" aria-pressed="true"/)
  })

  it('Skip this meeting calls the skip route with the meeting, folds it with Undo, and Undo calls clear', async () => {
    const srv = skippingServer()
    const h = load({ answers: srv.answers, cues: srv.cues })
    await h.open(['i', 'meetings'])
    expect(rowNumber(h.html('mm-list'), 'meetings')).toBe('2')
    h.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip')).toEqual([{ method: 'POST', path: '/api/live-cues/skip', body: { sessionId: MAC } }])
    const job = h.html('mm-reader')
    expect(job).toMatch(/Skipped the [^<]+ meeting\. It no longer counts in Needs you\./)
    expect(job).toMatch(/data-mm="cue-meet-unskip" data-id="mac_[^"]+"[^>]*>Undo</)
    // The meeting leaves the list and the count; the next meeting follows on the card.
    expect(h.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([G2])
    expect(rowNumber(h.html('mm-list'), 'meetings')).toBe('1')
    expect(job).toContain('Cue text cue-g2-0001')
    // It never writes a cue verdict.
    expect(h.cueCalls.some(c => c.path === '/api/live-cues/feedback')).toBe(false)
    h.tap('cue-meet-unskip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip/clear')).toEqual([{ method: 'POST', path: '/api/live-cues/skip/clear', body: { sessionId: MAC } }])
    expect(h.html('mm-reader')).not.toContain('It no longer counts in Needs you')
    expect(rowNumber(h.html('mm-list'), 'meetings')).toBe('2')
  })

  it('a meeting the server already skipped is left out of the list and the count; a cue logged after the skip brings it back', async () => {
    const skipped = load({ answers: { status: status({ needsYou: { meetings: 1, decisions: 1, quarantineBatch: 1, total: 3 } }) }, cues: cueRoutes({ week: () => history({ skips: { [MAC]: NOW - 50 * MIN } }) }) })
    await skipped.open(['i', 'meetings'])
    expect(skipped.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([G2])
    expect(rowNumber(skipped.html('mm-list'), 'meetings')).toBe('1')
    expectHeaderIsSum(skipped.html('mm-list'))
    const back = load({ cues: cueRoutes({ week: () => history({ skips: { [MAC]: NOW - 105 * MIN } }) }) })
    await back.open(['i', 'meetings'])
    expect(back.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([MAC, G2])
  })

  it('the server\'s count wins over the pane\'s own grouping (the rail and Today read it), and a skip or a rating re-reads it', async () => {
    const h = load({ answers: { status: status({ needsYou: { meetings: 5, decisions: 1, quarantineBatch: 1, total: 7 } }) } })
    await h.open(['i', 'meetings'])
    expect(h.t.meetingGroups().length).toBe(2)                 // the pane itself sees two meetings
    expect(rowNumber(h.html('mm-list'), 'meetings')).toBe('5') // but shows the server's number
    expect(needsHeader(h.html('mm-list'))).toBe(7)
    const reads = () => h.calls.filter(c => c.op === 'status').length
    const before = reads()
    h.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(reads()).toBe(before + 1)
    const id = h.t.meetingGroups()[0].unrated[0].cueId
    h.tap('cue-rate', { 'data-id': id, 'data-arg': 'useful' }); await flush()
    expect(reads()).toBe(before + 2)
  })

  it('an older server (no skips in history, or a 404 on the route itself) hides Skip this meeting', async () => {
    const old = load({ cues: cueRoutes({ week: () => history({ noSkips: true }) }) })
    await old.open(['i', 'meetings'])
    expect(old.html('mm-reader')).not.toContain('Skip this meeting')
    const gone = load({ cues: cueRoutes({ skip: () => { const e = new Error('Not found') as Error & { status?: number }; e.status = 404; throw e } }) })
    await gone.open(['i', 'meetings'])
    expect(gone.html('mm-reader')).toContain('Skip this meeting')
    gone.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(gone.html('mm-reader')).not.toContain('Skip this meeting')
    expect(gone.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([MAC, G2])
    // The route's own "unknown meeting" 404 keeps the button and says why.
    const unknown = load({ cues: cueRoutes({ skip: () => { const e = new Error('no cue') as Error & { status?: number; code?: string }; e.status = 404; e.code = 'unknown_meeting'; throw e } }) })
    await unknown.open(['i', 'meetings'])
    unknown.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(unknown.html('mm-reader')).toContain('This meeting has no cue from the last 7 days any more.')
    expect(unknown.html('mm-reader')).toContain('Skip this meeting')
  })
})

describe('Memories C: Wrong on a memory, and its Undo', () => {
  it('in Used in answers: Wrong sends prune with wrong_in_use, the row says so, and Undo sends accept with the memory id', async () => {
    const h = load()
    await h.open(['i', 'used'])
    const list = h.html('mm-reader')
    expect(list).toMatch(/<button type="button" class="mm-link mm-wrong" data-mm="mem-wrong" data-id="mem_u" aria-label="Take this memory out of recall">Wrong<\/button>/)
    h.tap('mem-wrong', { 'data-id': 'mem_u' }); await flush()
    expect(h.calls.filter(c => c.op === 'memory.review')).toEqual([{ op: 'memory.review', args: { id: 'mem_u', decision: 'prune', note: 'wrong_in_use' } }])
    expect(h.html('mm-reader')).toContain('Removed from recall. COS will not use it again.')
    h.tap('mem-wrong-undo', { 'data-id': 'mem_u' }); await flush()
    expect(h.calls.filter(c => c.op === 'memory.review').slice(1)).toEqual([{ op: 'memory.review', args: { id: 'mem_u', decision: 'accept' } }])
    expect(h.html('mm-reader')).not.toContain('Removed from recall')
    expect(h.html('mm-reader')).toContain('data-mm="mem-wrong" data-id="mem_u"')
  })

  it('in Corrections too; Rules carry no action word', async () => {
    const h = load()
    await h.open(['i', 'corrections'])
    expect(h.html('mm-reader')).toContain('data-mm="mem-wrong" data-id="mem_c1"')
    // Filtered here by kind: the decision row is not listed under Corrections.
    expect(h.html('mm-reader')).not.toContain('mem_d1')
    h.tap('mem-wrong', { 'data-id': 'mem_c1' }); await flush()
    expect(h.calls.filter(c => c.op === 'memory.review').map(c => c.args)).toEqual([{ id: 'mem_c1', decision: 'prune', note: 'wrong_in_use' }])
    await h.open(['i', 'rules'])
    expect(h.html('mm-reader')).not.toContain('mem-wrong')
    expect(h.html('mm-reader')).toContain('data-mm="steward"')
  })
})

describe('Memories C: search runs on submit only, and opening never searches', () => {
  it('opening the pane and a memory job browse without a query; typing sends nothing; Enter sends one search', async () => {
    const h = load()
    await h.open()
    await h.open(['i', 'corrections'])
    const searches = () => h.calls.filter(c => c.op === 'memories.search' || (c.op === 'workspace.request' && c.args.action === 'memory_page' && c.args.q))
    expect(searches()).toEqual([])
    expect(h.html('mm-tools')).toContain('data-mm-form="mem-search"')
    const field = h.els.get('mm-mem-q')!
    for (const v of ['d', 'di', 'disc', 'discount']) { field.value = v; h.fire('input', { target: { id: 'mm-mem-q', value: v, getAttribute: () => null } }) }
    await flush()
    expect(searches()).toEqual([])
    h.fire('submit', { target: { getAttribute: (k: string) => (k === 'data-mm-form' ? 'mem-search' : null) }, preventDefault() {} }); await flush()
    expect(searches().map(c => c.args.q)).toEqual(['discount'])
    expect(h.html('mm-reader')).toContain('A match for discount')
  })
})

describe('Memories C: routes', () => {
  it('the old tab routes land on their job', async () => {
    const cases: Array<[string[], string[]]> = [
      [['t', 'recent'], ['i', 'corrections']], [['t', 'applied'], ['i', 'used']], [['t', 'memories'], ['i', 'corrections']],
      [['t', 'review'], ['i', 'who']], [['t', 'knowledge'], ['k', 'graph']], [['t', 'cues'], ['i', 'meetings']], [['t', 'rated'], ['i', 'rated']],
      [['view', 'review'], ['i', 'who']], [['view', 'applied'], ['i', 'used']], [['t', 'nonsense'], []],
    ]
    for (const [from, to] of cases) {
      const h = load()
      await h.open(from)
      expect(h.route().args, from.join('/')).toEqual(to)
    }
  })

  it('a phone opens on the index with no job beside it; a row drills into the job with its trail; Back goes to the index', async () => {
    const h = load({ wide: false })
    await h.open()
    expect(h.html('mm-reader')).toBe('')
    h.tap('job', { 'data-arg': 'who' }); await flush()
    expect(h.route().args).toEqual(['i', 'who'])
    expect(h.html('mm-tools')).toContain('<p class="mm-trail"><button type="button" class="mm-link" data-mm="index">Memories</button><span aria-hidden="true">/</span><span>Who said it is unclear</span></p>')
    expect(h.html('mm-reader')).toContain('Bradley wants the discount')
    expect(h.def.up(['i', 'who'])).toEqual([])
    h.tap('job', { 'data-arg': 'used' }); await flush()
    h.tap('open-e', { 'data-id': 'evt_u1' }); await flush()
    expect(h.def.up(['e', 'evt_u1'])).toEqual(['i', 'used'])
    expect(h.def.up([])).toBeNull()
  })
})

describe('Memories C: the meeting card keeps what the rating flow could do (lead, F1 review)', () => {
  const withBefore = () => history({ cues: [
    cue('cue-mac-0001', MAC, NOW - 110 * MIN, { before: 'We should price it per store, not per seat.', kind: 'challenge', gate: 0.91,
      sources: [{ id: 'S1', title: 'Pricing memo', kind: 'file', fileId: 'f1' }] }),
    cue('cue-mac-0002', MAC, NOW - 100 * MIN),
  ] })

  it('the line said just before shows under a cue that has one, and no line under one without it', async () => {
    const h = load({ cues: cueRoutes({ week: withBefore }) })
    await h.open(['i', 'meetings'])
    const job = h.html('mm-reader')
    expect((job.match(/class="mm-meet-before"/g) ?? []).length).toBe(1)
    expect(job).toMatch(/id="mm-cue-cue-mac-0001"[\s\S]*?<p class="mm-meet-before" title="We should price it per store, not per seat.">Just before: We should price it per store, not per seat.<\/p>/)
    const second = job.slice(job.indexOf('id="mm-cue-cue-mac-0002"'))
    expect(second).not.toContain('mm-meet-before')
  })

  it('kind, score, sources and the full line said before are inside the disclosure, not on the face', async () => {
    const h = load({ cues: cueRoutes({ week: withBefore }) })
    await h.open(['i', 'meetings'])
    const face = h.html('mm-reader')
    expect(face).not.toContain('<dt>Kind</dt>')
    expect(face).not.toContain('0.91')
    expect(face).not.toContain('Pricing memo')
    expect(face).not.toContain('What was said just before')
    expect(face).toMatch(/data-mm="cue-note-open" data-id="cue-mac-0001" aria-expanded="false"[^>]*>Note and details</)
    h.tap('cue-note-open', { 'data-id': 'cue-mac-0001' })
    const open = h.html('mm-reader')
    const details = open.slice(open.indexOf('id="mm-cue-details-cue-mac-0001"'))
    expect(details).toContain('<dt>Kind</dt><dd>Challenge</dd>')
    expect(details).toContain('<dt>Score</dt><dd class="mm-mono">0.91</dd>')
    expect(details).toContain('Pricing memo')
    expect(details).toContain('What was said just before</span><p>We should price it per store, not per seat.</p>')
    expect(details).toContain('What would have made it useful?')
    expect(open).toMatch(/aria-expanded="true"[^>]*>Hide note and details</)
    // Still nothing chosen.
    expect(open).not.toContain('aria-pressed="true"')
    h.tap('cue-note-open', { 'data-id': 'cue-mac-0001' })
    expect(h.html('mm-reader')).not.toContain('id="mm-cue-details-cue-mac-0001"')
  })

  it('keys 1 to 5 rate the focused cue, and S skips its meeting through the skip route', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    const key = (k: string, id: string, extra: Record<string, unknown> = {}) => ({ key: k, target: { id: 'mm-cue-' + id, getAttribute: (a: string) => (a === 'data-cue-card' ? id : null) }, ...extra })
    expect(h.t.cueKey(key('3', 'cue-mac-0002'))).toBe(true); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/feedback').map(c => c.body)).toEqual([{ sessionId: MAC, cueId: 'cue-mac-0002', verdict: 'repeat' }])
    expect(h.t.cueKey(key('s', 'cue-mac-0001', { ctrlKey: true }))).toBe(false)
    expect(h.cueCalls.some(c => c.path === '/api/live-cues/skip')).toBe(false)
    expect(h.t.cueKey(key('S', 'cue-mac-0001'))).toBe(true); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip')).toEqual([{ method: 'POST', path: '/api/live-cues/skip', body: { sessionId: MAC } }])
    expect(h.html('mm-reader')).toMatch(/Skipped the [^<]+ meeting\. It no longer counts in Needs you\./)
    // A server without skips: S does nothing and passes through.
    const old = load({ cues: cueRoutes({ week: () => history({ noSkips: true }) }) })
    await old.open(['i', 'meetings'])
    expect(old.t.cueKey(key('s', 'cue-mac-0001'))).toBe(false)
    expect(old.cueCalls.some(c => c.path === '/api/live-cues/skip')).toBe(false)
  })

  it('the meeting button reads Skip this meeting until a cue is rated, then Skip the rest; both call the same route', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    expect(h.html('mm-reader')).toMatch(/data-mm="cue-meet-skip" data-id="mac_[^"]+">Skip this meeting</)
    expect(h.html('mm-reader')).not.toContain('Skip the rest')
    h.tap('cue-rate', { 'data-id': 'cue-mac-0001', 'data-arg': 'useful' }); await flush()
    expect(h.html('mm-reader')).toMatch(/data-mm="cue-meet-skip" data-id="mac_[^"]+">Skip the rest \(1\)</)
    expect(h.html('mm-reader')).not.toContain('>Skip this meeting<')
    expect(h.html('mm-reader')).toContain('Keys 1 to 5 rate the cue in focus, N opens its note and details, S skips the rest of the meeting.')
    h.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip').map(c => c.body)).toEqual([{ sessionId: MAC }])
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/feedback')).toHaveLength(1)
  })
})

// Q1 on 338a95c2: tests owed for its surviving mutants (P3, P4, P15, P16, P17) and four small edges.
describe('Memories C: the meeting card escapes what it draws (Q1 P15, P16, P17)', () => {
  it('a cue\'s text is drawn as text, never as markup', async () => {
    const h = load({ cues: cueRoutes({ week: () => history({ cues: [cue('cue-mac-0001', MAC, NOW - 110 * MIN, { detail: '<img src=x onerror=alert(1)>' })] }) }) })
    await h.open(['i', 'meetings'])
    const card = h.html('mm-reader')
    expect(card).toContain('<p class="mm-meet-text">&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(card).not.toContain('<img')
  })

  it('the line said before is escaped in its title attribute and in its text', async () => {
    const before = '"><b>x</b><script>alert(1)</script>'
    const h = load({ cues: cueRoutes({ week: () => history({ cues: [cue('cue-mac-0001', MAC, NOW - 110 * MIN, { before })] }) }) })
    await h.open(['i', 'meetings'])
    const card = h.html('mm-reader')
    const safe = '&quot;&gt;&lt;b&gt;x&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
    expect(card).toContain('<p class="mm-meet-before" title="' + safe + '">')
    expect(card).toContain('>Just before: ' + safe + '</p>')
    expect(card).not.toContain('<b>x</b>')
    expect(card).not.toContain('<script>')
  })

  it('the meeting\'s title is escaped in the card\'s heading', async () => {
    const h = load({ cues: cueRoutes({ week: () => history({ cues: [cue('cue-mac-0001', MAC, NOW - 110 * MIN, { title: '<i>Board</i> review' })] }) }) })
    await h.open(['i', 'meetings'])
    const card = h.html('mm-reader')
    expect(card).toContain('<h3>&lt;i&gt;Board&lt;/i&gt; review</h3>')
    expect(card).not.toContain('<i>')
  })
})

describe('Memories C: Needs you after quarantining on the page (Q1 P3, P4)', () => {
  // Two memories ready to quarantine, both listed by the needs-you block and the review page, and one who-said-it item.
  const twoPrune = () => ({
    status: status({ needs_you: block({ count: 3, gates: { prune_ready: 2, attribution: 1 }, items: [
      needsItem({ lesson_id: 'mem_who', event_id: 'evt_who', title: 'decision: Bradley wants the discount as a percentage' }),
      needsItem({ gate: 'prune_ready', reason: 'never recalled', lesson_id: 'mem_old1', event_id: 'evt_pr1', title: 'Old memory one' }),
      needsItem({ gate: 'prune_ready', reason: 'never recalled', lesson_id: 'mem_old2', event_id: 'evt_pr2', title: 'Old memory two' }),
    ] }) }),
    'ws:review_page': { protocol: 1, matched_total: 2, next_cursor: null, items: [
      { event_id: 'evt_pr1', lesson_id: 'mem_old1', event_type: 'captured', store: 'bot_memory', category: 'Prune ready · never recalled', title: 'Old memory one', target: { kind: 'memory' }, source_refs: [], ts: '2026-05-07T01:37:36Z' },
      { event_id: 'evt_pr2', lesson_id: 'mem_old2', event_type: 'captured', store: 'bot_memory', category: 'Prune ready · never recalled', title: 'Old memory two', target: { kind: 'memory' }, source_refs: [], ts: '2026-05-08T01:37:36Z' },
    ] },
  })

  it('deciding a memory ready to quarantine leaves the decisions part alone', async () => {
    const h = load({ answers: twoPrune() })
    await h.open()
    expect(h.t.needsParts()).toMatchObject({ decisions: 1, quarantineBatch: 1, total: 4 })
    h.S.decisions.mem_old1 = 'pruned'; h.t.paint()
    expect(h.t.needsParts().decisions).toBe(1)
    expect(rowNumber(h.html('mm-list'), 'who')).toBe('1')
  })

  it('quarantining every memory in the batch on the page takes the batch to 0 and the header down by 1 before the next status read', async () => {
    const h = load({ answers: twoPrune() })
    await h.open(['i', 'quarantine'])
    expect(needsHeader(h.html('mm-list'))).toBe(4)
    h.tap('prune-all'); await flush()
    h.tap('prune-all'); await flush()
    expect(h.calls.filter(c => c.op === 'memory.review').map(c => c.args.id)).toEqual(['mem_old1', 'mem_old2'])
    // The status read after the writes still says one batch; the page knows better until the server catches up.
    expect(h.calls.filter(c => c.op === 'status').length).toBeGreaterThanOrEqual(2)
    expect(h.t.needsParts()).toMatchObject({ decisions: 1, quarantineBatch: 0 })
    expect(rowNumber(h.html('mm-list'), 'quarantine')).toBe('0')
    expect(needsHeader(h.html('mm-list'))).toBe(3)
    expectHeaderIsSum(h.html('mm-list'))
  })

  it('quarantining only some of the batch keeps it at 1', async () => {
    const h = load({ answers: twoPrune() })
    await h.open()
    h.S.decisions.mem_old1 = 'pruned'; h.S.decided.mem_old1 = 1; h.t.paint()
    expect(h.t.needsParts().quarantineBatch).toBe(1)
  })
})

describe('Memories C: optional learning setup and cached counts', () => {
  it('counts meetings alone and hides unavailable learning decisions when learning is not set up', async () => {
    const h = load({ answers: { status: status({ needsYou: { meetings: 2, decisions: null, quarantineBatch: null, total: 2, learning: 'not_set_up' } }) } })
    await h.open()
    expect(h.t.needsParts().total).toBe(2)
    const html = h.html('mm-list')
    expect(needsHeader(html)).toBe(2)
    expect(html).not.toContain('data-arg="who"')
    expect(html).not.toContain('data-arg="quarantine"')
    expectHeaderIsSum(html)
  })

  it('keeps unknown learning different from absent setup; an unknown part never becomes zero', async () => {
    const h = load({ answers: { status: status({ needsYou: { meetings: 2, decisions: null, quarantineBatch: null, total: null, learning: 'unknown' } }) } })
    await h.open()
    expect(h.t.needsParts().total).toBeNull()
    expect(h.html('mm-list')).toContain('data-arg="who"')
  })

  it('labels an older count without hiding it, and removes the label once fresh', async () => {
    const ny = { meetings: 2, decisions: 1, quarantineBatch: 1, total: 4, learning: 'read', ageSeconds: 181, fresh: false }
    const h = load({ answers: { status: status({ needsYou: ny }) } })
    await h.open()
    expect(needsHeader(h.html('mm-list'))).toBe(4)
    expect(h.html('mm-list')).toContain('Memory count last read 3 minutes ago.')
    h.S.status.needsYou.fresh = true
    h.t.paint()
    expect(h.html('mm-list')).not.toContain('Memory count last read')
  })
})

describe('Memories C: small edges (Q1)', () => {
  it('a cue logged at the skip\'s own time stays skipped; one a millisecond later brings the meeting back (the server\'s <=)', async () => {
    const at = NOW - 100 * MIN
    const exact = load({ cues: cueRoutes({ week: () => history({ skips: { [MAC]: at } }) }) })
    await exact.open(['i', 'meetings'])
    expect(exact.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([G2])
    const later = load({ cues: cueRoutes({ week: () => history({ skips: { [MAC]: at - 1 } }) }) })
    await later.open(['i', 'meetings'])
    expect(later.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([MAC, G2])
  })

  it('a truncated history read is never used as the meetings count', async () => {
    const h = load({ answers: { status: status({ needsYou: undefined }) }, cues: cueRoutes({ week: () => ({ ...history(), truncated: true }) }) })
    await h.open()
    expect(h.t.needsParts().meetings).toBeNull()
    expect(rowNumber(h.html('mm-list'), 'meetings')).toBe('')
    expect(needsHeader(h.html('mm-list'))).toBeNull()
    // The same read, whole, counts.
    const whole = load({ answers: { status: status({ needsYou: undefined }) } })
    await whole.open()
    expect(whole.t.needsParts().meetings).toBe(2)
  })

  it('Undo with no skip recorded does nothing and calls no route', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    h.tap('cue-meet-unskip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST')).toEqual([])
    expect(h.t.meetingGroups().map((g: { sid: string }) => g.sid)).toEqual([MAC, G2])
  })
})

// Lead 18:30, ruling (c): a long meeting (his average is 22 cues) shows its first five unrated cues, then one line that
// shows the rest in place. "Skip the rest" counts every unrated cue, shown or not. No time estimate anywhere.
describe('Memories C: a long meeting shows five cues, then the rest in place (lead 18:30)', () => {
  const LONG = Array.from({ length: 22 }, (_, i) => cue('cue-long-' + String(i + 1).padStart(2, '0'), MAC, NOW - 110 * MIN + i * MIN))
  const longLoad = () => load({ cues: cueRoutes({ week: () => history({ cues: LONG }) }) })
  const shownIds = (job: string) => [...job.matchAll(/data-mm="cue-rate" data-id="([^"]+)" data-arg="useful"/g)].map(m => m[1])

  it('draws the first five unrated cues and one line "17 more in this meeting", with no time estimate', async () => {
    const h = longLoad()
    await h.open(['i', 'meetings'])
    const job = h.html('mm-reader')
    expect(shownIds(job)).toEqual(['cue-long-01', 'cue-long-02', 'cue-long-03', 'cue-long-04', 'cue-long-05'])
    expect((job.match(/data-mm="cue-rate"/g) ?? []).length).toBe(25)
    expect(job).not.toContain('Cue text cue-long-06')
    expect(job).toMatch(/data-mm="cue-meet-more" data-id="mac_[^"]+">17 more in this meeting</)
    expect(job).toContain('22 cues fired</p>')
    expect(job).not.toMatch(/about a minute|minutes?\b/)
    expect(job).toMatch(/>Skip this meeting</)
  })

  it('after a rating the card keeps the same five cues in place, and Skip the rest counts the hidden ones too', async () => {
    const h = longLoad()
    await h.open(['i', 'meetings'])
    h.tap('cue-rate', { 'data-id': 'cue-long-01', 'data-arg': 'useful' }); await flush()
    let job = h.html('mm-reader')
    // The rated cue stays where it was with its verdict; cue 6 does not slide up under his thumb.
    expect(shownIds(job)).toEqual(['cue-long-01', 'cue-long-02', 'cue-long-03', 'cue-long-04', 'cue-long-05'])
    expect(job).toMatch(/data-id="cue-long-01" data-arg="useful" aria-label="Useful" aria-pressed="true"/)
    expect(job).not.toContain('Cue text cue-long-06')
    expect(job).toMatch(/>17 more in this meeting</)
    expect(job).toMatch(/data-mm="cue-meet-skip" data-id="mac_[^"]+">Skip the rest \(21\)</)
    // The subtitle does not change as he rates (a longer one wrapped at 382 and moved the next cue).
    expect(job).toContain('22 cues fired</p>')
    for (const id of ['cue-long-02', 'cue-long-03', 'cue-long-04', 'cue-long-05']) { h.tap('cue-rate', { 'data-id': id, 'data-arg': 'late' }); await flush() }
    job = h.html('mm-reader')
    expect(shownIds(job)).toEqual(['cue-long-01', 'cue-long-02', 'cue-long-03', 'cue-long-04', 'cue-long-05'])
    expect(job).toMatch(/>17 more in this meeting</)
    expect(job).toMatch(/>Skip the rest \(17\)</)
    h.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip').map(c => c.body)).toEqual([{ sessionId: MAC }])
  })

  it('the more line shows every cue in place, in order, and goes away; nothing is fetched for it', async () => {
    const h = longLoad()
    await h.open(['i', 'meetings'])
    h.tap('cue-rate', { 'data-id': 'cue-long-03', 'data-arg': 'repeat' }); await flush()
    const before = h.cueCalls.length
    h.tap('cue-meet-more', { 'data-id': MAC }); await flush()
    const job = h.html('mm-reader')
    expect(shownIds(job)).toEqual(LONG.map(c => c.cueId))
    expect(job).toMatch(/data-id="cue-long-03" data-arg="repeat" aria-label="Repeat" aria-pressed="true"/)
    expect(job).not.toContain('cue-meet-more')
    expect(job).not.toMatch(/more in this meeting/)
    expect(job).toMatch(/>Skip the rest \(21\)</)
    expect(h.cueCalls.length).toBe(before)
  })

  it('a meeting of five or fewer cues has no more line', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    expect(h.html('mm-reader')).not.toContain('cue-meet-more')
  })

  it('every verdict carries its full word as the accessible name', async () => {
    const h = longLoad()
    await h.open(['i', 'meetings'])
    const job = h.html('mm-reader')
    for (const v of ['Useful', 'Late', 'Repeat', 'Wrong', 'Obvious']) expect((job.match(new RegExp('aria-label="' + v + '"', 'g')) ?? []).length).toBe(5)
  })
})

describe('Memories C: a long meeting after the week is read again (lead 18:30)', () => {
  const LONG = Array.from({ length: 22 }, (_, i) => cue('cue-long-' + String(i + 1).padStart(2, '0'), MAC, NOW - 110 * MIN + i * MIN))
  const ids = (job: string) => [...job.matchAll(/data-mm="cue-rate" data-id="([^"]+)" data-arg="useful"/g)].map(m => m[1])
  const five = ['cue-long-01', 'cue-long-02', 'cue-long-03', 'cue-long-04', 'cue-long-05']

  it('Check again keeps the five rated cues in place with the more line; Refresh starts the card on the next five', async () => {
    let week = LONG
    const h = load({ cues: cueRoutes({ week: () => history({ cues: week }) }) })
    await h.open(['i', 'meetings'])
    for (const id of five) { h.tap('cue-rate', { 'data-id': id, 'data-arg': 'useful' }); await flush() }
    week = LONG.slice(5)
    h.tap('cue-check'); await flush()
    let job = h.html('mm-reader')
    expect(ids(job)).toEqual(five)
    expect(job).toMatch(/>17 more in this meeting</)
    h.tap('cue-meet-more', { 'data-id': MAC }); await flush()
    expect(ids(h.html('mm-reader'))).toHaveLength(22)
    h.tap('refresh'); await flush()
    job = h.html('mm-reader')
    expect(ids(job)).toEqual(['cue-long-06', 'cue-long-07', 'cue-long-08', 'cue-long-09', 'cue-long-10'])
    expect(job).toMatch(/>12 more in this meeting</)
  })
})

describe('Memories C: a meeting with every cue rated (lead 18:30)', () => {
  it('says All rated in the button\'s place and offers no skip, since nothing is left to skip', async () => {
    const h = load()
    await h.open(['i', 'meetings'])
    for (const id of ['cue-mac-0001', 'cue-mac-0002']) { h.tap('cue-rate', { 'data-id': id, 'data-arg': 'obvious' }); await flush() }
    const card = h.html('mm-reader').split('<section class="cx-card mm-meet"')[1] ?? ''
    expect(card).toContain('2 cues fired</p>')
    expect(card).not.toContain('cue-meet-skip')
    // The button's slot keeps its height with a quiet line, so the last rating does not move the cues below.
    expect(card).toContain('<p class="mm-meet-done">All rated</p>')
  })
})

describe('Memories C: the more line counts only unrated cues (lead 18:30)', () => {
  it('a hidden cue rated from elsewhere leaves the more line and the skip count both one lower', async () => {
    const LONG = Array.from({ length: 22 }, (_, i) => cue('cue-long-' + String(i + 1).padStart(2, '0'), MAC, NOW - 110 * MIN + i * MIN))
    const h = load({ cues: cueRoutes({ week: () => history({ cues: LONG }) }) })
    await h.open(['i', 'meetings'])
    h.tap('cue-rate', { 'data-id': 'cue-long-08', 'data-arg': 'wrong' }); await flush()
    const job = h.html('mm-reader')
    expect(job).not.toContain('Cue text cue-long-08')
    expect(job).toMatch(/>16 more in this meeting</)
    expect(job).toMatch(/>Skip the rest \(21\)</)
  })
})

// Lead 18:4x on Q1's owed P15 to P17: cue text, the line said just before and the meeting title are untrusted (a title
// can come from someone else's calendar invite; cue text is transcript). Each is drawn with hostile values and with
// benign ones of the same shape, through the REAL esc from app.js. The rendered markup must have exactly the same tags
// and attribute names either way (nothing the values carry becomes markup or a new attribute), and every value must
// decode back to exactly what was sent, wherever it is drawn: the card, its accessible name and title attribute, the
// note and details, the list row, the index, the after-skip line, the Rated cues job, and the long-meeting lines.
describe('Memories C: untrusted values never become markup, anywhere the pane draws them (lead, Q1 P15 to P17)', () => {
  const HOSTILE = {
    title: '<script>window.__xss=1</script>Board " onfocus="window.__xss=2" & review &amp; <b>bold</b>',
    detail: '<img src=x onerror="window.__xss=3"> said \' onmouseover=\'window.__xss=4\' &lt;i&gt;',
    before: '"><svg onload=window.__xss=5>&quot; it\'s & </p><p>',
  }
  const BENIGN = { title: 'Board review', detail: 'Plain cue text', before: 'Plain words before' }
  type V = typeof HOSTILE
  const mk = (v: V, id: string, at: number, o: Record<string, unknown> = {}) => cue(id, MAC, at, { title: v.title, meetingTitle: v.title, titleSource: 'saved', detail: v.detail, before: v.before, ...o })
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  // Tags and attribute NAMES in order. Values are escaped, so a value that broke out would add a tag or an attribute here.
  const skeleton = (html: string) => [...html.matchAll(/<(\/?[a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g)].map(m =>
    m[1] + '(' + [...m[2]!.matchAll(/\s([^\s="'<>\/]+)(?:="[^"]*")?/g)].map(a => a[1]).join(',') + ')').join(' ')
  const noMarkup = (html: string) => {
    // The template's own <b>, icons and buttons are in both renders; skeleton equality is what catches an added tag.
    expect(html).not.toMatch(/<(script|img|iframe|object)\b/i)
    expect(skeleton(html)).not.toMatch(/\b(on[a-z]+|data-x)\b/)
  }
  const render = async (v: V, step: (h: ReturnType<typeof load>) => Promise<string>) => {
    const week = [mk(v, 'cue-x-01', NOW - 110 * MIN), mk(v, 'cue-x-02', NOW - 109 * MIN)]
    const rated = [mk(v, 'cue-r-01', NOW - 2000 * MIN, { rating: { verdict: 'useful', note: null, vote: null, at: 1 } })]
    const h = load({ wide: true, cues: cueRoutes({ week: () => history({ cues: week }), rated: () => ({ v: 1, cues: rated, counts: { total: 1, rated: 1, unrated: 0, byVerdict: {} }, truncated: false }) }) })
    return step(h)
  }
  const both = async (step: (h: ReturnType<typeof load>) => Promise<string>) => ({ bad: await render(HOSTILE, step), ok: await render(BENIGN, step) })

  it('the meeting card: heading, accessible name, cue text, the "Just before" line and its title attribute', async () => {
    const { bad, ok } = await both(async h => { await h.open(['i', 'meetings']); return h.html('mm-reader') })
    expect(skeleton(bad)).toBe(skeleton(ok))
    noMarkup(bad)
    const card = bad.slice(bad.indexOf('<section class="cx-card mm-meet"'), bad.indexOf('</section>') + 10)
    expect(decode(/<section class="cx-card mm-meet" aria-label="([^"]*)"/.exec(card)![1]!)).toBe(HOSTILE.title)
    expect(decode(/<h3>([^<]*)<\/h3>/.exec(card)![1]!)).toBe(HOSTILE.title)
    expect(decode(/<p class="mm-meet-text">([^<]*)<\/p>/.exec(card)![1]!)).toBe(HOSTILE.detail)
    const b = /<p class="mm-meet-before" title="([^"]*)">Just before: ([^<]*)<\/p>/.exec(card)!
    expect(decode(b[1]!)).toBe(HOSTILE.before)
    expect(decode(b[2]!)).toBe(HOSTILE.before)
  })

  it('the note and details, opened: the line said before in full', async () => {
    const { bad, ok } = await both(async h => { await h.open(['i', 'meetings']); h.tap('cue-note-open', { 'data-id': 'cue-x-01' }); await flush(); return h.html('mm-reader') })
    expect(bad).toContain('mm-cue-before')
    expect(skeleton(bad)).toBe(skeleton(ok))
    noMarkup(bad)
    expect(decode(/<div class="mm-cue-before"><span class="mm-muted">What was said just before<\/span><p>([^<]*)<\/p>/.exec(bad)![1]!)).toBe(HOSTILE.before)
  })

  it('the list row under the card and the index', async () => {
    const { bad, ok } = await both(async h => { await h.open(['i', 'meetings']); return h.html('mm-reader') + '\n' + h.page() })
    expect(skeleton(bad)).toBe(skeleton(ok))
    noMarkup(bad)
    expect(decode(/<span class="mm-row-title">([^<]*)<\/span>/.exec(bad)![1]!)).toBe(HOSTILE.title)
    const idx = await render(HOSTILE, async h => { await h.open([]); return h.page() })
    const idxOk = await render(BENIGN, async h => { await h.open([]); return h.page() })
    expect(skeleton(idx)).toBe(skeleton(idxOk))
    noMarkup(idx)
  })

  it('the after-skip line draws only the time, never the title, and stays plain', async () => {
    const { bad, ok } = await both(async h => { await h.open(['i', 'meetings']); h.tap('cue-meet-skip', { 'data-id': MAC }); await flush(); return h.html('mm-reader') })
    const line = (x: string) => /<div class="mm-removed" role="status">[\s\S]*?<\/div>/.exec(x)![0]
    expect(line(bad)).toMatch(/Skipped the .* meeting\. It no longer counts in Needs you\./)
    expect(skeleton(line(bad))).toBe(skeleton(line(ok)))
    expect(line(bad)).toBe(line(ok))
    expect(skeleton(bad)).toBe(skeleton(ok))
    noMarkup(bad)
  })

  it('the Rated cues job: the title in the cue line and the cue text', async () => {
    const { bad, ok } = await both(async h => { await h.open(['i', 'rated']); return h.html('mm-reader') })
    expect(bad).toContain('mm-cue-row')
    expect(skeleton(bad)).toBe(skeleton(ok))
    noMarkup(bad)
    expect(decode(/<p class="mm-cue-meta"><b>([^<]*)<\/b>/.exec(bad)![1]!)).toBe(HOSTILE.title)
    expect(decode(/<p class="mm-cue-text small">([^<]*)<\/p>/.exec(bad)![1]!)).toBe(HOSTILE.detail)
  })

  it('a long hostile meeting: "N more in this meeting" and "Skip the rest (N)" stay plain, and so does every cue shown after More', async () => {
    const step = (v: V) => async (h: ReturnType<typeof load>) => h.html('mm-reader')
    const go = async (v: V) => {
      const long = Array.from({ length: 22 }, (_, i) => mk(v, 'cue-l-' + String(i + 1).padStart(2, '0'), NOW - 110 * MIN + i * MIN))
      const h = load({ cues: cueRoutes({ week: () => history({ cues: long }) }) })
      await h.open(['i', 'meetings'])
      h.tap('cue-rate', { 'data-id': 'cue-l-01', 'data-arg': 'useful' }); await flush()
      const collapsed = await step(v)(h)
      h.tap('cue-meet-more', { 'data-id': MAC }); await flush()
      return { collapsed, expanded: h.html('mm-reader') }
    }
    const bad = await go(HOSTILE), ok = await go(BENIGN)
    expect(bad.collapsed).toMatch(/data-mm="cue-meet-more" data-id="mac_[^"]+">17 more in this meeting<\/button>/)
    expect(bad.collapsed).toMatch(/data-mm="cue-meet-skip" data-id="mac_[^"]+">Skip the rest \(21\)<\/button>/)
    expect(skeleton(bad.collapsed)).toBe(skeleton(ok.collapsed))
    expect(skeleton(bad.expanded)).toBe(skeleton(ok.expanded))
    noMarkup(bad.collapsed); noMarkup(bad.expanded)
    expect([...bad.expanded.matchAll(/<p class="mm-meet-text">([^<]*)<\/p>/g)].map(m => decode(m[1]!))).toEqual(Array(22).fill(HOSTILE.detail))
  })

  it('the escape the pane uses is the page own esc: every special character, nothing more', () => {
    expect(APP_ESC('<a href="x">\'&amp;\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;amp;&#39;&lt;/a&gt;')
    expect(APP_ESC(null)).toBe('')
  })
})

describe('Memories C: a card first drawn with a cue already rated (Q1 C9, 18:53)', () => {
  it('picks its five from the cues still to rate, leaving the rated one out', async () => {
    const g2 = Array.from({ length: 8 }, (_, i) => cue('cue-g-' + (i + 1), G2, NOW - 290 * MIN + i * MIN, { title: 'Pricing review' }))
    const mac = [cue('cue-mac-0001', MAC, NOW - 110 * MIN), cue('cue-mac-0002', MAC, NOW - 100 * MIN)]
    const h = load({ cues: cueRoutes({ week: () => history({ cues: [...mac, ...g2] }) }) })
    await h.open(['i', 'meetings'])
    expect(h.html('mm-reader')).not.toContain('Cue text cue-g-1')
    h.tap('cue-rate', { 'data-id': 'cue-g-1', 'data-arg': 'repeat' }); await flush()
    h.tap('cue-meet', { 'data-id': G2 }); await flush()
    const job = h.html('mm-reader')
    expect([...job.matchAll(/data-mm="cue-rate" data-id="([^"]+)" data-arg="useful"/g)].map(m => m[1])).toEqual(['cue-g-2', 'cue-g-3', 'cue-g-4', 'cue-g-5', 'cue-g-6'])
    expect(job).toMatch(/>2 more in this meeting</)
    expect(job).toMatch(/>Skip the rest \(7\)</)
  })
})
