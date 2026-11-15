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
    esc: (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
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
    expect(job).toContain('On this Mac · 2 cues fired · about a minute')
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
    expect(job).toMatch(/data-id="cue-mac-0001" data-arg="useful" aria-pressed="true"/)
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
    expect(h.html('mm-reader')).toMatch(/data-mm="cue-meet-skip" data-id="mac_[^"]+">Skip the rest</)
    expect(h.html('mm-reader')).not.toContain('>Skip this meeting<')
    expect(h.html('mm-reader')).toContain('Keys 1 to 5 rate the cue in focus, N opens its note and details, S skips the rest of the meeting.')
    h.tap('cue-meet-skip', { 'data-id': MAC }); await flush()
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/skip').map(c => c.body)).toEqual([{ sessionId: MAC }])
    expect(h.cueCalls.filter(c => c.path === '/api/live-cues/feedback')).toHaveLength(1)
  })
})
