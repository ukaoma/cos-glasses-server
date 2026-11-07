/**
 * COS Control Web: the native Memories pane (panes/memories.js). Runs the REAL pane in a vm with a fake COSWeb, document
 * and bridge, the way web-parity.test.ts and cos-thread-web.test.ts do, and drives it with the same act() a tap runs.
 * Every write here goes to the fake bridge; nothing reaches a live server.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildWebAssetTable } from '../lib/web-control-static.js'
import { MUTATING_MEMORY_WEB_OPS, isMemoryWebOpReadOnly } from '../lib/web-memories-bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'panes', 'memories.js'), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

type Answer = unknown | ((args: any) => unknown)
interface FakeEl { id: string; innerHTML: string; value: string; classList: { toggle: (c: string, on?: boolean) => void; add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean }; [k: string]: any }

type CueAnswer = (path: string, body?: any) => unknown
function load(opts: { answers?: Record<string, Answer>; wide?: boolean; noRandomUUID?: boolean; cues?: CueAnswer } = {}) {
  const answers: Record<string, Answer> = { ...base(), ...(opts.answers ?? {}) }
  const calls: Array<{ op: string; args: any }> = []
  // The cue review talks to /api/live-cues/* directly, as Control's store does; anything else is the Memories bridge.
  const cueCalls: Array<{ method: string; path: string; body: any }> = []
  const cueAnswer: CueAnswer = opts.cues ?? (() => { const e = new Error('Not found') as Error & { status?: number }; e.status = 404; throw e })
  const toasts: string[] = []
  const copies: string[] = []
  const els = new Map<string, FakeEl>()
  const make = (id: string): FakeEl => {
    const cls = new Set<string>()
    let html = ''
    const node: FakeEl = {
      id, value: '', disabled: false,
      get innerHTML() { return html },
      set innerHTML(v: string) { html = String(v); for (const m of html.matchAll(/\sid="([^"]+)"/g)) if (!els.has(m[1]!)) els.set(m[1]!, make(m[1]!)) },
      classList: { toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c) }, add: c => { cls.add(c) }, remove: c => { cls.delete(c) }, contains: c => cls.has(c) },
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) },
      querySelector: () => null, querySelectorAll: () => [], contains: () => false, focus() {}, blur() {}, select() {}, getAttribute: () => null,
    }
    return node
  }
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const pane = make('pane-memories'); els.set('pane-memories', pane)
  let route = { pane: 'memories', args: [] as string[] }
  let def: any = null
  const W = {
    $: (id: string) => els.get(id) ?? null,
    esc: (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
    toast: (t: string) => { toasts.push(t) }, readStore: () => ({}), writeStore: () => {},
    skeletonRows: () => '<div class="list"><div class="skel-row"></div></div>',
    copyText: (t: string) => { copies.push(t); return Promise.resolve() },
    parseRoute: () => route,
    go: (p: string, args: string[] = []) => { route = { pane: p, args }; def.load(args) },
    goBack: () => { route = { pane: 'memories', args: [] }; def.load([]) },
    setCrumb: () => {}, crumb: () => '',
    registerPane: (name: string, d: unknown) => { if (name === 'memories') def = d },
    api: (path: string, o: { method?: string; body: any } = { body: undefined }) => {
      if (path.startsWith('/api/live-cues/')) {
        cueCalls.push({ method: o.method ?? 'GET', path, body: o.body })
        try { return Promise.resolve(cueAnswer(path, o.body)) } catch (e) { return Promise.reject(e) }
      }
      expect(path).toBe('/api/web-bridge/memories')
      expect(o.method).toBe('POST')
      const { op, args } = o.body
      calls.push({ op, args })
      const key = op === 'workspace.request' ? 'ws:' + args.action : op
      const a = answers[key]
      let v: unknown
      try { v = typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a } catch (e) { return Promise.resolve({ ok: false, message: (e as Error).message, details: {} }) }
      // A TypeError is the browser's own failure (no HTTP status): the request never reached COS.
      if (v instanceof TypeError) return Promise.reject(v)
      if (v instanceof Error) return Promise.resolve({ ok: false, message: v.message, details: {} })
      return Promise.resolve({ ok: true, message: '', details: v ?? {} })
    },
  }
  const body = { classList: make('body').classList, appendChild: () => {} }
  const document = {
    getElementById: (id: string) => els.get(id) ?? null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners['doc:' + type] ??= []).push(fn) },
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild: () => {} }, body, activeElement: null,
  }
  const media = { matches: !!opts.wide, addEventListener: () => {} }
  const crypto = opts.noRandomUUID ? { getRandomValues: (b: Uint8Array) => globalThis.crypto.getRandomValues(b) } : globalThis.crypto
  // Waits up to 3 s (polls, debounces) run at once; the 6 s disarm of a two-tap button never fires here.
  const held: Array<() => void> = []
  const timeout = (fn: () => void, ms?: number) => { if ((ms ?? 0) >= 6000) { held.push(fn); return 0 } return setTimeout(fn, 0) }
  const window = { COSWeb: W, matchMedia: () => media, crypto, localStorage: { getItem: () => null, setItem: () => {} } }
  const location = { replace: (h: string) => { route = { pane: 'memories', args: h.replace(/^#\/memories\/?/, '').split('/').filter(Boolean) } } }
  const ctx = vm.createContext({ window, document, location, crypto, console, Date, JSON, Math, Promise, Object, Array, String, Number, RegExp, Error, Uint8Array, URL,
    setTimeout: timeout, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} })
  vm.runInContext(SOURCE, ctx)
  const t = def._t
  const tap = (name: string, attrs: Record<string, string> = {}) => t.act(name, { getAttribute: (k: string) => attrs[k] ?? null, disabled: false }, null)
  const open = async (args: string[] = []) => { route = { pane: 'memories', args }; def.load(args); await flush() }
  const writes = () => calls.filter(c => !isMemoryWebOpReadOnly(c.op, c.args ?? {}))
  return { def, t, S: t.S, calls, cueCalls, writes, toasts, copies, tap, open, els, answers, held, listeners, setRoute: (args: string[]) => { route = { pane: 'memories', args } } }
}

// ── fixtures, shaped like the live bridge answered on 11/06 ──
const needsItem = (o: Record<string, unknown>) => ({ gate: 'attribution', rank: 0, reason: "names bradley near 'wants' with no attribution field", store: 'bot_memory', category: 'decision', ts: '2026-11-06T17:20:31Z', ...o })
function base(): Record<string, Answer> {
  return {
    status: { runtimeState: 'ready', installedVersion: '6.99.23', ownerName: 'Miles Ukaoma', contextScriptsDirectory: '/x', learningRewardEnabled: true, learningToReview: 2,
      needs_you: { count: 62, limit: 7, items: [
        needsItem({ lesson_id: 'mem_1', event_id: 'evt_need_mem', title: 'decision: Frame the discount as a percentage' }),
        needsItem({ gate: 'low_confidence', reason: 'promotable at confidence 0.52 (< 0.8)', lesson_id: 'ptn_1', event_id: 'evt_pattern', store: null, title: 'Confirm npm is polling' }),
      ] } },
    'ws:learning_page': { protocol: 1, matched_total: 34195, next_cursor: 'snap:50', coverage: { used: { state: 'legacy' } }, counts_by_type: { retrieved: 3 }, stores: {}, complete: false,
      items: [
        { event_id: 'evt_r1', lesson_id: 'mem_9', event_type: 'retrieved', store: 'memory_trace', title: 'Included in context 39 times · context_emitted', scope: 'unknown', engine: 'unknown', target: { kind: 'memory', id: 'mem_9' }, source_refs: [], ts: '2026-11-07T05:12:46Z' },
        { event_id: 'evt_c1', lesson_id: 'ptn_2', event_type: 'checked', store: 'eval_scores', title: 'Run passed', outcome: { result: 'pass', name: 'suite' }, source_refs: [{ kind: 'eval_scores', id: 'r1', excerpt: 'All green' }], ts: '2026-11-06T05:12:46Z' },
      ] },
    'ws:review_page': { protocol: 1, matched_total: 76, next_cursor: null, items: [
      { event_id: 'evt_pattern', lesson_id: 'ptn_1', event_type: 'promotable', store: 'correction_journal', title: 'Confirm npm is polling', target: { kind: 'pattern', id: 'ptn_1' }, source_refs: [{ kind: 'occurrence', id: 'o1', excerpt: 'cost two expired sign-ins' }], applies_to: [], ts: '2026-10-21T13:49:23Z' },
      { event_id: 'evt_prop', lesson_id: 'siq_1', event_type: 'proposed', store: 'self_improvement_queue', title: 'daily-reflect: repair graph queries', target: { kind: 'task-proposal', id: 'siq_1' }, source_refs: [], ts: '2026-10-14T05:00:00Z' },
      { event_id: 'evt_pr1', lesson_id: 'mem_old1', event_type: 'captured', store: 'bot_memory', category: 'Prune ready · never recalled, older than 180 days', title: 'Old memory one', target: { kind: 'memory' }, source_refs: [], ts: '2026-05-07T01:37:36Z' },
      { event_id: 'evt_pr2', lesson_id: 'mem_old2', event_type: 'captured', store: 'bot_memory', category: 'Prune ready · rarely retrieved', title: 'Old memory two', target: { kind: 'memory' }, source_refs: [], ts: '2026-05-08T01:37:36Z' },
    ] },
    'cues.summary': { available: false, unrated: 447 },
    'graph.status': { engine: 'lightrag', entities: 50490, relationships: 115596, index_state: 'fresh', source: { owner_state: 'owner', owner_host: 'Ukaoma-Mac-Studio.local', is_owner: true }, queue: { pending: 155 }, budget: { used: 0, cap: 1500 }, lock: { state: 'free' }, processor: { state: 'none' } },
    'graph.search': { items: [{ id: 'Miles Ukaoma', type: 'person' }] },
    'learning.event': (a: { id: string }) => ({ event_id: a.id, detail: { content: 'detail for ' + a.id } }),
    'memory.detail': (a: { id: string }) => ({ id: a.id, summary: 'Summary of ' + a.id, content: 'Content of ' + a.id, type: 'decision', created_at: '2026-11-06T10:00:00' }),
    'ws:memory_page': { protocol: 1, matched_total: 15838, next_cursor: null, items: [{ id: 'mem_a', type: 'decision', created_at: '2026-11-06T23:10:59', summary: 'A saved memory', content: 'A saved memory, in full' }] },
    'learning.list': { events: [{ event_id: 'evt_u1', lesson_id: 'mem_u', event_type: 'used', store: 'memory_trace', title: 'Applied 3 times · deterministic_check', source_refs: [{ kind: 'assistant_turn', id: 'x', excerpt: 'The login page is shown by the browser that is not signed in.' }], ts: '2026-11-07T03:08:09Z' }], total: 1, nextCursor: null, coverage: { used: { state: 'legacy' } } },
    'ws:policy_get': { policy: { capture_enabled: true, review_required: true, revision: 1 }, writable: false, state: 'adoption_required', protocol: 1 },
    'memory.guardrails': { guardrails: { min_words: 6, min_distinct_chars: 8, max_repeat_ratio: 0.5, banned_patterns: ['^lorem'], llm_review: { enabled: false, model: 'haiku', max_per_run: 20 } }, philosophy_rubric_lines: 23 },
    'profile.owner': { owner_name: 'Miles Ukaoma' },
    'graph.setup': { ready: true, checks: [{ id: 'sdk', ok: true, detail: 'ok' }], owner: { is_owner: true, this_host: 'Ukaoma-Mac-Studio.local' }, sources: [], queue: { pending: 155 }, graph: { entities: 50490 }, budget: { used: 0, cap: 1500 }, schedule: { installed: false }, sample: { candidates: [] }, lock: { state: 'free' }, embedding: { ready: true, preference: { local_only: false }, providers: [] }, extraction: { tiers: [] }, ask_ready: true },
  }
}

describe('Control Web Memories: opening and reading never writes', () => {
  it('a first open reads status, recent learning, the review page, cues and the graph, and nothing else', async () => {
    const h = load()
    await h.open()
    const ops = h.calls.map(c => c.op === 'workspace.request' ? 'ws:' + c.args.action : c.op)
    for (const op of ['status', 'ws:learning_page', 'ws:review_page', 'graph.status']) expect(ops).toContain(op)
    expect(h.cueCalls).toEqual([{ method: 'GET', path: '/api/live-cues/history?days=7&unrated=1&limit=200', body: undefined }])
    expect(h.writes()).toEqual([])
  })

  it('every view, the reader, Knowledge, setup, Memory settings and the activity log stay read-only', async () => {
    const h = load()
    await h.open()
    for (const v of ['recent', 'applied', 'memories', 'review', 'knowledge']) { h.tap('view', { 'data-arg': v }); await flush() }
    await h.open(['e', 'evt_pattern'])
    await h.open(['e', 'evt_need_mem'])
    await h.open(['m', 'mem_a'])
    await h.open(['k', 'sources'])
    await h.open(['k', 'setup'])
    h.tap('settings'); await flush()
    h.tap('steward'); await flush()
    h.tap('log'); await flush()
    h.tap('copy-open', { 'data-id': 'evt_pattern' }); await flush()
    expect(h.calls.length).toBeGreaterThan(10)
    expect(h.writes()).toEqual([])
    expect(h.calls.some(c => MUTATING_MEMORY_WEB_OPS.has(c.op))).toBe(false)
  })

  it('the pane names the same read-only ops the bridge does (its read timeouts depend on it)', () => {
    const h = load()
    for (const op of ['status', 'learning.event', 'graph.ask', 'graph.duplicates', 'memory.detail']) expect(h.t.isRead(op, {})).toBe(true)
    for (const op of MUTATING_MEMORY_WEB_OPS) expect(h.t.isRead(op, {}), op).toBe(false)
    expect(h.t.isRead('workspace.request', { action: 'review_page' })).toBe(true)
    expect(h.t.isRead('workspace.request', { action: 'review_memory' })).toBe(false)
  })
})

describe('Control Web Memories: To review', () => {
  it('the count is the needs-you list, never the review page total, and that list shows first with plain reasons', async () => {
    const h = load()
    await h.open()
    expect(h.t.needsCount()).toBe(2)
    expect(h.t.viewsHtml()).toContain('To review (2)')
    expect(h.t.viewsHtml()).not.toContain('76')
    h.tap('view', { 'data-arg': 'review' }); await flush()
    const html: string = h.t.listHtml()
    expect(html.indexOf('Needs you now')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Needs you now')).toBeLessThan(html.indexOf('Proposed changes'))
    // The pattern is in both lists; it shows once, in Needs you now.
    expect(html.split('data-id="evt_pattern"').length - 1).toBe(1)
    expect(html).toContain('Mentions Bradley near &quot;wants&quot; without saying who said it')
    expect(html).toContain('Confidence 0.52, under the 0.8 bar for a rule')
    expect(html).toContain('Ready to quarantine')
  })

  it('a saved memory that needs you is read from the memory store, not the learning index', async () => {
    const h = load({ answers: { 'learning.event': () => new Error('learning_unavailable') } })
    await h.open()
    await h.open(['e', 'evt_need_mem'])
    expect(h.calls.filter(c => c.op === 'learning.event' && c.args.id === 'evt_need_mem')).toEqual([])
    expect(h.calls.some(c => c.op === 'memory.detail' && c.args.id === 'mem_1')).toBe(true)
    const reader: string = h.t.readerHtml({ pane: 'memories', args: ['e', 'evt_need_mem'] })
    expect(reader).toContain('Content of mem_1')
    expect(reader).toContain('data-mm="memory-review"')
    expect(reader).not.toContain('could not be read on your Mac')
  })

  it('Quarantine needs a second tap; Accept and Restore go as accept; the count drops after a decision', async () => {
    const h = load({ answers: { 'memory.review': (a: any) => ({ decision: { decision: a.decision === 'prune' ? 'pruned' : 'accepted' } }) } })
    await h.open()
    h.tap('memory-review', { 'data-id': 'mem_1', 'data-arg': 'prune' }); await flush()
    expect(h.writes()).toEqual([])
    expect(h.t.readerHtml({ pane: 'memories', args: ['e', 'evt_need_mem'] })).toContain('Tap again to quarantine')
    h.tap('memory-review', { 'data-id': 'mem_1', 'data-arg': 'prune' }); await flush()
    expect(h.writes()).toEqual([{ op: 'memory.review', args: { id: 'mem_1', decision: 'prune' } }])
    expect(h.toasts).toContain('Memory quarantined.')
    h.tap('memory-review', { 'data-id': 'mem_old1', 'data-arg': 'restore' }); await flush()
    expect(h.writes()[1]).toEqual({ op: 'memory.review', args: { id: 'mem_old1', decision: 'accept' } })
    // The decided item leaves the needs-you count, even after the status read that follows the write still lists it,
    // and stays in the list so its reader can offer Restore.
    expect(h.calls.filter(c => c.op === 'status').length).toBeGreaterThanOrEqual(2)
    expect(h.t.needsCount()).toBe(1)
    expect(h.t.readerHtml({ pane: 'memories', args: ['e', 'evt_need_mem'] })).toContain('Restore to recall')
  })

  it('Quarantine all asks twice, sends one review per memory in order, and stops at the first failure', async () => {
    let n = 0
    const h = load({ answers: { 'memory.review': () => (++n === 2 ? new Error('Server is updating.') : { decision: { decision: 'pruned' } }) } })
    await h.open()
    h.tap('view', { 'data-arg': 'review' }); await flush()
    h.tap('prune-all'); await flush()
    expect(h.writes()).toEqual([])
    expect(h.t.listHtml()).toContain('Tap again to quarantine 2')
    h.tap('prune-all'); await flush()
    expect(h.writes().map(c => c.args)).toEqual([{ id: 'mem_old1', decision: 'prune', note: 'prune ready' }, { id: 'mem_old2', decision: 'prune', note: 'prune ready' }])
    expect(h.toasts.some(t => /^Stopped after 1 of 2: Server is updating\./.test(t))).toBe(true)
  })

  it('Dismiss and Restore suggestion post learning.decide with the lesson id', async () => {
    const h = load({ answers: { 'learning.decide': {} } })
    await h.open()
    h.tap('decide', { 'data-id': 'evt_prop', 'data-arg': 'dismissed' }); await flush()
    expect(h.writes()).toEqual([{ op: 'learning.decide', args: { id: 'siq_1', decision: 'dismissed' } }])
    h.tap('decide', { 'data-id': 'evt_prop', 'data-arg': 'reopened' }); await flush()
    expect(h.writes()[1]).toEqual({ op: 'learning.decide', args: { id: 'siq_1', decision: 'reopened' } })
  })

  it('Forget permanently needs a second tap, and a retry sends the same request with the same key (no crypto.randomUUID needed)', async () => {
    let n = 0
    const h = load({ noRandomUUID: true, answers: {
      'ws:review_page': { protocol: 1, matched_total: 1, next_cursor: null, items: [{ event_id: 'evt_g', lesson_id: 'mem_g', event_type: 'captured', store: 'memory_journal', governance: 'active', title: 'Governed', source_refs: [], ts: '2026-11-01T00:00:00Z' }] },
      'ws:get_memory': { item: { payload: { content: 'governed text' }, state: 'active', revision: 4 } },
      'ws:review_memory': () => (++n === 1 ? new Error('Server is updating.') : { status: 'forgotten' }),
    } })
    await h.open()
    await h.open(['e', 'evt_g'])
    h.tap('governed', { 'data-id': 'mem_g', 'data-arg': 'forget' }); await flush()
    expect(h.writes()).toEqual([])
    h.tap('governed', { 'data-id': 'mem_g', 'data-arg': 'forget' }); await flush()
    h.tap('governed', { 'data-id': 'mem_g', 'data-arg': 'forget' }); await flush()
    const sent = h.writes()
    expect(sent).toHaveLength(2)
    expect(sent[0]!.args).toMatchObject({ action: 'review_memory', id: 'mem_g', decision: 'forget', expected_revision: 4 })
    expect(sent[0]!.args.idempotency_key).toMatch(/^review_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent[1]!.args).toEqual(sent[0]!.args)
  })
})

describe('Control Web Memories: views', () => {
  it('Applied fails closed: a server that ignored kind=used leaves it empty with the reason', async () => {
    const h = load({ answers: { 'learning.list': { events: [{ event_id: 'e1', event_type: 'retrieved', title: 'x' }], total: 1 } } })
    await h.open()
    h.tap('view', { 'data-arg': 'applied' }); await flush()
    expect(h.S.applied.rows).toEqual([])
    expect(h.t.listHtml()).toContain('Applied stays empty rather than mislabel them')
    expect(h.calls.find(c => c.op === 'learning.list')!.args).toMatchObject({ kind: 'used', days: 7 })
  })

  it('Applied names each lesson from its memory and keeps the count from the title', async () => {
    const h = load()
    await h.open()
    h.tap('view', { 'data-arg': 'applied' }); await flush()
    expect(h.t.listHtml()).toContain('Summary of mem_u')
    h.S.view = 'applied'
    const r: string = h.t.readerHtml({ pane: 'memories', args: ['e', 'evt_u1'] })
    expect(r).toContain('Recorded 3 times since first use')
    expect(r).toContain('ranks ahead of unused memories')
  })

  it('a recall row is titled by its memory, with the trace word dropped from what happened', async () => {
    const h = load()
    await h.open()
    const html: string = h.t.listHtml()
    expect(html).toContain('Summary of mem_9')
    expect(html).toContain('Included in context 39 times')
    expect(html).not.toContain('context_emitted')
    expect(h.t.cleanTitle('Retrieved 414 times by the startup hook · retrieval_log')).toBe('Retrieved 414 times by the startup hook')
  })

  it('on a wide screen the reader shows the first row with no route; narrow, the reader stays empty', async () => {
    const wide = load({ wide: true })
    await wide.open()
    expect(wide.t.readerHtml({ pane: 'memories', args: [] })).toContain('mm-timeline')
    const narrow = load({ wide: false })
    await narrow.open()
    expect(narrow.t.readerHtml({ pane: 'memories', args: [] })).toBe('')
  })

  it('#/memories/view/review opens that view and leaves the list address', async () => {
    const h = load()
    await h.open(['view', 'review'])
    expect(h.S.view).toBe('review')
  })

  it('a reader that cannot be found says so and offers the list', async () => {
    const h = load({ answers: { 'learning.event': () => new Error('learning_unavailable') } })
    await h.open()
    await h.open(['e', 'evt_gone'])
    await flush()
    expect(h.t.readerHtml({ pane: 'memories', args: ['e', 'evt_gone'] })).toContain('This item is not in the list any more.')
  })
})

describe('Control Web Memories: Copy context and settings', () => {
  it('Copy context copies the quoted record with its id, sources on by default and off on request', async () => {
    const h = load()
    await h.open()
    await h.open(['e', 'evt_pattern'])
    h.tap('copy-open', { 'data-id': 'evt_pattern' })
    h.tap('copy-now'); await flush()
    expect(h.copies[0]).toMatch(/^Learning evt_pattern \(/)
    expect(h.copies[0]).toContain('"""\nConfirm npm is polling')
    expect(h.copies[0]).toContain('Sources:\n- occurrence o1: cost two expired sign-ins')
    h.S.copyOpts.sources = false
    h.tap('copy-open', { 'data-id': 'evt_pattern' })
    h.tap('copy-now'); await flush()
    expect(h.copies[1]).not.toContain('Sources:')
    expect(h.writes()).toEqual([])
  })

  it('a read-only memory policy shows disabled switches and says why in plain words', async () => {
    const h = load()
    await h.open()
    h.tap('settings'); await flush()
    const html: string = h.t.modalHtml()
    expect(html.match(/role="switch"[^>]*disabled/g)).toHaveLength(2)
    expect(html).toContain('Read-only: the memory workspace on your Mac is not set up yet.')
    expect(html).not.toContain('adoption_required')
  })

  it('a writable policy sends policy_set with the flipped value, its revision and a fresh key', async () => {
    const h = load({ answers: { 'ws:policy_get': { policy: { capture_enabled: true, review_required: true, revision: 3 }, writable: true, state: 'available', protocol: 1 }, 'ws:policy_set': { policy: { capture_enabled: false, review_required: true, revision: 4 } } } })
    await h.open()
    h.tap('settings'); await flush()
    h.tap('policy', { 'data-arg': 'capture_enabled' }); await flush()
    expect(h.writes()).toHaveLength(1)
    expect(h.writes()[0]!.args).toMatchObject({ action: 'policy_set', changes: { capture_enabled: false }, expected_revision: 3 })
    expect(h.writes()[0]!.args.idempotency_key).toMatch(/^policy_/)
  })

  it('Review the next batch and quarantine matches asks twice before guardrails.run with apply', async () => {
    const h = load({ answers: { 'memory.guardrails.run': (a: any) => ({ run: { scanned: 4, days: 30, flagged: 1, kept: 3, applied: !!a.apply, pruned: a.apply ? 1 : 0 }, verdicts: [{ id: 'mem_x', verdict: 'prune', applied: !!a.apply, reasons: ['too short'] }] }) } })
    await h.open()
    h.tap('settings'); await flush()
    h.tap('guard-run'); await flush()
    expect(h.calls.filter(c => c.op === 'memory.guardrails.run').map(c => c.args)).toEqual([{ days: 30, apply: false }])
    h.tap('guard-apply'); await flush()
    expect(h.writes()).toEqual([])
    h.tap('guard-apply'); await flush()
    expect(h.writes()).toEqual([{ op: 'memory.guardrails.run', args: { days: 30, apply: true } }])
  })
})

describe('Control Web Memories: Knowledge', () => {
  it('a merge from the graph previews first; Cancel changes nothing and tells the explorer no', async () => {
    const h = load({ answers: { 'graph.merge.preview': { source: { found: true, id: 'Miles', degree: 4 }, target: { found: true, id: 'Miles Ukaoma', degree: 6646 }, effect: { moved: 4 }, warnings: [] }, 'ws:identity_status': { writable: true, same_identity: false, revision: 1 } } })
    await h.open()
    const result = h.t.mergeFlow('Miles', 'Miles Ukaoma', null)
    await flush()
    expect(h.t.modalHtml()).toContain('Merge on this Mac')
    h.tap('merge-cancel')
    expect(await result).toBe(false)
    expect(h.toasts).toContain('Nothing was changed.')
    expect(h.writes()).toEqual([])
  })

  it('a large merge asks twice, then sends graph.merge with confirm and resolves when the receipt says done', async () => {
    let polls = 0
    const h = load({ answers: {
      'graph.merge.preview': { source: { found: true, id: 'Miles', degree: 900 }, target: { found: true, id: 'Miles Ukaoma', degree: 6646 }, effect: { moved: 900, embeddings: 900 }, warnings: [{ code: 'large_merge', text: 'Large.' }] },
      'ws:identity_status': { writable: false },
      'graph.merge': { receipt: { state: 'running', step: 'merging' } },
      'graph.merge.status': () => (++polls < 2 ? { running: true, receipt: { state: 'running', step: 'indexing' } } : { running: false, receipt: { state: 'done', after: { target: 6650 } } }),
    } })
    await h.open()
    const result = h.t.mergeFlow('Miles', 'Miles Ukaoma', null)
    await flush()
    h.tap('merge-go'); await flush()
    expect(h.writes()).toEqual([])
    expect(h.t.modalHtml()).toContain('Tap again to confirm')
    h.tap('merge-go'); await flush(30)
    expect(h.writes()).toEqual([{ op: 'graph.merge', args: { source: 'Miles', target: 'Miles Ukaoma', confirm: true } }])
    expect(await result).toBe(true)
    expect(h.toasts.some(t => /^Merged Miles into Miles Ukaoma · 6,650 connections now\./.test(t))).toBe(true)
  })

  it('Make this Mac the owner and Remove a folder each need a second tap', async () => {
    const h = load({ answers: { 'graph.setup.owner': {}, 'graph.setup.sources': {} } })
    await h.open(['k', 'setup'])
    h.tap('claim-owner'); await flush()
    expect(h.writes()).toEqual([])
    h.tap('claim-owner'); await flush()
    expect(h.writes()).toEqual([{ op: 'graph.setup.owner', args: {} }])
    h.tap('source-remove', { 'data-arg': '/Users/x/Notes' }); await flush()
    expect(h.writes()).toHaveLength(1)
    h.tap('source-remove', { 'data-arg': '/Users/x/Notes' }); await flush()
    expect(h.writes()[1]).toEqual({ op: 'graph.setup.sources', args: { action: 'remove', path: '/Users/x/Notes' } })
  })

  it('Ask the graph sends one question, shows the answer with its sources, and looks up the people it names', async () => {
    const answer = '## Miles Ukaoma\n**Niranjan Reddy** reports to Miles [S1].\n\nEvidence references:\n[S1] Weekly sync · 2026-10-20 · line 4 · resolved'
    const h = load({ answers: {
      'graph.ask': { answer, mode: 'hybrid', elapsed_s: 52, investigation: { status: 'ready', nodes: [], links: [] } },
      'graph.search': (a: any) => ({ items: [{ id: a.q, type: 'person' }] }),
      'graph.entity': (a: any) => ({ found: true, id: a.id, type: 'person', degree: 3, description: 'About ' + a.id, edges: [] }),
    } })
    await h.open(['k', 'graph'])
    h.t.ask('Show me the relation between Miles Ukaoma and Niranjan Reddy'); await flush(20)
    expect(h.calls.filter(c => c.op === 'graph.ask').map(c => c.args)).toEqual([{ q: 'Show me the relation between Miles Ukaoma and Niranjan Reddy' }])
    const html: string = h.t.readerHtml({ pane: 'memories', args: ['k', 'graph'] })
    expect(html).toContain('<strong>Niranjan Reddy</strong> reports to Miles')
    expect(html).toContain('Weekly sync')
    expect(html).toContain('Open Ask the graph to see these points in the graph.')
    expect(h.calls.filter(c => c.op === 'graph.entity').map(c => c.args.id).sort()).toEqual(['Miles Ukaoma', 'Niranjan Reddy'])
    expect(html).toContain('data-mm="copy-entity" data-id="Niranjan Reddy"')
    expect(h.writes()).toEqual([])
  })

  it('a model answer is escaped before any markdown is applied', () => {
    const h = load()
    const html: string = h.t.renderMarkdown('**Bold** <img src=x onerror=alert(1)>\n- item')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })
})

describe('Control Web Memories: page rules', () => {
  it('no inline handlers, no em dashes or arrows in the copy, and no crypto.randomUUID (a tailnet page over http has none)', () => {
    expect(SOURCE).not.toMatch(/\son[a-z]+=\\?["']/)
    expect(SOURCE).not.toMatch(/[—→←↔]/)
    expect(SOURCE.replace(/typeof window\.crypto\.randomUUID[^\n]*/g, '').replace(/\/\/[^\n]*randomUUID[^\n]*/g, '')).not.toMatch(/crypto\.randomUUID\(/)
  })

  it('index.html loads the pane on demand, versions the graph explorer files, and no longer frames the old page', () => {
    const table = buildWebAssetTable(HERE)
    const html = table.get('/index.html')!.body.toString()
    expect(html).not.toContain('memories-frame')
    expect(html).toMatch(/href="\/control\/panes\/memories\.css\?v=[0-9a-f]{16}"/)
    const block = html.match(/<script type="application\/json" id="memories-graph-assets">([\s\S]*?)<\/script>/)
    expect(block).not.toBeNull()
    const assets = JSON.parse(block![1]!) as Record<string, string>
    expect(Object.keys(assets).sort()).toEqual(['css', 'd3', 'explorer', 'workspace'])
    for (const url of Object.values(assets)) {
      const m = url.match(/^\/control(\/memories\/[a-z0-9.-]+\.(?:js|css))\?v=([0-9a-f]{16})$/)
      expect(m, url).not.toBeNull()
      expect(table.get(m![1]!)!.hash).toBe(m![2])
    }
  })
})

// ── Cues to rate and Rated cues (Control's CueReviewPane), on fakes shaped like the live history on 11/07 ──
const HOUR = 3600_000
const cueRow = (o: Record<string, unknown>) => ({ v: 1, sessionId: 'meeting_1793728868236_emvdsb', meetingTitle: 'G2 Recording 2026-11-03 1201', kind: 'challenge',
  headline: '', detail: 'A cue', gate: 0.95, sources: [], before: '', title: 'Payroll roadmap review', titleSource: 'saved', rating: null, ...o })
function cueServer(opts: { rows?: any[]; counts?: any; feedback?: (body: any) => unknown; history?: (path: string) => unknown } = {}) {
  const now = Date.now()
  const rows = opts.rows ?? [
    cueRow({ cueId: 'c-new', createdAt: now - 1 * HOUR, detail: 'Newest unrated cue', headline: 'Newest' }),
    cueRow({ cueId: 'c-old', createdAt: now - 30 * HOUR, armedAt: now - 30 * HOUR - 7 * 60_000, detail: 'Oldest unrated cue', before: 'what was said',
      sources: [{ id: 'S1', title: 'Reuters', kind: 'web', url: 'https://www.reuters.com/a' }, { id: 'S2', title: 'Old note', kind: 'memory', memoryId: 'mem_src' },
        { id: 'S3', title: 'Board deck', kind: 'file', fileId: 'f1' }] }),
    cueRow({ cueId: 'c-mid', createdAt: now - 10 * HOUR, detail: 'Middle unrated cue', kind: 'followUp' }),
    cueRow({ cueId: 'c-rated', createdAt: now - 5 * HOUR, detail: 'A rated cue', rating: { verdict: 'useful', note: 'spot on', at: now } }),
  ]
  const counts = opts.counts ?? { total: 4, rated: 1, unrated: 3, byVerdict: { useful: 1, late: 0, repeat: 0, wrong: 0, obvious: 0 } }
  return (path: string, body?: any) => {
    if (path.startsWith('/api/live-cues/feedback')) return opts.feedback ? opts.feedback(body) : { ok: true, cueId: body.cueId, verdict: body.verdict === 'clear' ? null : body.verdict, vote: null }
    if (opts.history) return opts.history(path)
    const unrated = /unrated=1/.test(path)
    return { v: 1, cues: rows.filter(r => !unrated || !r.rating?.verdict), counts, truncated: false, skipped: 0, maxCuesPerMeeting: 30 }
  }
}
const httpError = (status: number, code?: string) => Object.assign(new Error('HTTP ' + status), { status, code })
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: { id: 'mm-cue-card', getAttribute: (a: string) => (a === 'data-cue' ? (extra.cue as string) ?? 'c-old' : null) }, ...extra })

describe('Control Web Memories: Cues to rate and Rated cues', () => {
  it('a server without the cue history (404) keeps both cue views hidden; one with it shows them with the unrated count', async () => {
    const off = load()
    await off.open()
    expect(off.S.cue.available).toBe(false)
    expect(off.t.viewsHtml()).not.toContain('Cues to rate')
    const on = load({ cues: cueServer({ counts: { total: 457, rated: 10, unrated: 447, byVerdict: {} } }) })
    await on.open()
    expect(on.S.cue.available).toBe(true)
    expect(on.t.viewsHtml()).toContain('Cues to rate (447)')
    expect(on.t.viewsHtml()).toContain('data-arg="rated"')
    expect(on.cueCalls.filter(c => c.method === 'POST')).toEqual([])
  })

  it('the queue is oldest first, one card at a time, with Control\'s card: title, when, kind, score, left, sources, what was said, five verdicts', async () => {
    const h = load({ cues: cueServer() })
    await h.open(['view', 'cues'])
    await h.open()
    expect(h.S.cue.queue.map((c: any) => c.cueId)).toEqual(['c-old', 'c-mid', 'c-new'])
    const html: string = h.t.listHtml()
    expect(html).toContain('Payroll roadmap review')
    expect(html).toMatch(/, 7 min in</)
    expect(html).toContain('Challenge')
    expect(html).toContain('score 0.95')
    expect(html).toContain('3 left')
    expect(html).toContain('Oldest unrated cue')
    expect(html).not.toContain('Newest unrated cue')
    expect(html).toContain('<a href="https://www.reuters.com/a" target="_blank" rel="noopener noreferrer">Reuters (reuters.com)</a>')
    expect(html).toContain('data-mm="cue-memory" data-id="mem_src"')
    expect(html).toContain('<li class="mm-muted">Board deck</li>')
    expect(html).toContain('What was said just before')
    expect(html.match(/data-mm="cue-rate"/g)).toHaveLength(5)
    expect(html).toContain('What would have made it useful?')
    expect(html).toContain('Next up: ')
    expect(html).toContain('Middle unrated cue')
    expect(html).toContain('Ratings in the last 7 days: 1 of 4.')
  })

  it('a verdict posts the cue with its normalized note, then the next cue shows and the counts move', async () => {
    const h = load({ cues: cueServer() })
    await h.open(['view', 'cues'])
    await h.open()
    h.S.cue.notes['c-old'] = '  after   the\npoint  '
    h.tap('cue-rate', { 'data-id': 'c-old', 'data-arg': 'late' }); await flush()
    const posts = h.cueCalls.filter(c => c.method === 'POST')
    expect(posts).toEqual([{ method: 'POST', path: '/api/live-cues/feedback', body: { sessionId: 'meeting_1793728868236_emvdsb', cueId: 'c-old', verdict: 'late', note: 'after the point' } }])
    expect(h.S.cue.queue.map((c: any) => c.cueId)).toEqual(['c-mid', 'c-new'])
    expect(h.S.cue.counts).toMatchObject({ rated: 2, unrated: 2, byVerdict: { late: 1 } })
    expect(h.t.viewsHtml()).toContain('Cues to rate (2)')
    expect(h.t.listHtml()).toContain('Middle unrated cue')
    expect(h.writes()).toEqual([])
  })

  it('keys 1 to 5 rate, N goes to the note and S skips, only on the focused card and never with a modifier', async () => {
    const h = load({ cues: cueServer() })
    await h.open(['view', 'cues'])
    await h.open()
    expect(h.t.cueKey(key('2', { metaKey: true }))).toBe(false)
    expect(h.t.cueKey({ key: '2', target: { id: 'mm-cue-note', getAttribute: () => 'c-old' } })).toBe(false)
    expect(h.cueCalls.filter(c => c.method === 'POST')).toEqual([])
    expect(h.t.cueKey(key('s'))).toBe(true)
    expect(h.S.cue.queue.map((c: any) => c.cueId)).toEqual(['c-mid', 'c-new', 'c-old'])
    expect(h.cueCalls.filter(c => c.method === 'POST')).toEqual([])
    expect(h.t.cueKey(key('5', { cue: 'c-mid' }))).toBe(true); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ sessionId: 'meeting_1793728868236_emvdsb', cueId: 'c-mid', verdict: 'obvious' }])
    expect(h.t.cueKey(key('n', { cue: 'c-new' }))).toBe(true)
  })

  it('one rating per cue at a time: a second tap while the first saves sends nothing', async () => {
    let release: (v: unknown) => void = () => {}
    const h = load({ cues: cueServer({ feedback: () => new Promise(r => { release = r }) }) })
    await h.open(['view', 'cues'])
    await h.open()
    h.tap('cue-rate', { 'data-id': 'c-old', 'data-arg': 'useful' })
    h.tap('cue-rate', { 'data-id': 'c-old', 'data-arg': 'wrong' }); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(h.t.listHtml()).toContain('Saving…')
    release({ ok: true, cueId: 'c-old', verdict: 'useful', vote: null }); await flush()
    expect(h.S.cue.queue[0].cueId).toBe('c-mid')
  })

  it('a rating that did not save says why in Control\'s words and keeps the cue', async () => {
    const cases: Array<[unknown, string]> = [
      [httpError(404, 'unknown_cue'), 'This cue is older than 30 days and was removed.'],
      [httpError(409, 'cue_session_mismatch'), 'The server files this cue under another meeting. The rating was not saved.'],
      [httpError(503, 'verdicts_unreadable'), 'The server\'s ratings file cannot be read. The rating was not saved.'],
      [httpError(503), 'Server is updating. Rating not saved, try again.'],
      [new Error('Load failed'), 'Your Mac did not answer. The rating was not saved; try again.'],
      [httpError(400, 'invalid_request'), 'The server did not accept this rating.'],
    ]
    for (const [err, line] of cases) {
      const h = load({ cues: cueServer({ feedback: () => { throw err } }) })
      await h.open(['view', 'cues'])
      await h.open()
      h.tap('cue-rate', { 'data-id': 'c-old', 'data-arg': 'useful' }); await flush()
      expect(h.S.cue.queue[0].cueId).toBe('c-old')
      expect(h.t.listHtml()).toContain(line.replace(/'/g, '&#39;'))
    }
  })

  it('Rated cues reads the whole week newest first; a new verdict keeps the note, the same verdict sends nothing, Clear sends it back to the queue', async () => {
    const h = load({ cues: cueServer() })
    await h.open(['view', 'rated'])
    await h.open()
    expect(h.cueCalls.some(c => c.path === '/api/live-cues/history?days=7&limit=1000')).toBe(true)
    const html: string = h.t.listHtml()
    expect(html).toContain('Rated Useful · “spot on”')
    expect(html).toMatch(/data-arg="useful" aria-pressed="true"/)
    h.tap('cue-rate', { 'data-id': 'c-rated', 'data-arg': 'useful' }); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST')).toEqual([])
    h.tap('cue-rate', { 'data-id': 'c-rated', 'data-arg': 'repeat' }); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ sessionId: 'meeting_1793728868236_emvdsb', cueId: 'c-rated', verdict: 'repeat', note: 'spot on' }])
    h.tap('cue-clear', { 'data-id': 'c-rated' }); await flush()
    expect(h.cueCalls.filter(c => c.method === 'POST').map(c => c.body)[1]).toEqual({ sessionId: 'meeting_1793728868236_emvdsb', cueId: 'c-rated', verdict: 'clear' })
    expect(h.S.cue.rated).toEqual([])
    expect(h.S.cue.queue.map((c: any) => c.cueId)).toContain('c-rated')
  })

  it('a history read that fails says why, with Check again except while loading or on an older server', async () => {
    const storage = load({ cues: () => { throw httpError(503, 'verdicts_unreadable') } })
    storage.S.view = 'cues'
    await storage.open()
    expect(storage.t.listHtml()).toContain('ratings file cannot be read, so cues cannot be listed')
    expect(storage.t.listHtml()).toContain('data-mm="cue-check"')
    const odd = load({ cues: () => ({ cues: [] }) })
    odd.S.view = 'cues'
    await odd.open()
    expect(odd.t.listHtml()).toContain('was not readable')
    const older = load()
    older.S.view = 'cues'
    await older.open()
    expect(older.S.view).toBe('recent')
  })

  it('a memory source opens in All memories; notes are cut to 200 UTF-16 units on a character; only public https pages open', async () => {
    const h = load({ cues: cueServer() })
    await h.open(['view', 'cues'])
    await h.open()
    h.tap('cue-memory', { 'data-id': 'mem_src' }); await flush()
    expect(h.S.view).toBe('memories')
    expect(h.t.cueNote('a  b\n c')).toBe('a b c')
    const emoji = '\u{1F600}'.repeat(150)
    expect(h.t.cueNote(emoji)).toHaveLength(200)
    expect(h.t.cueNote('x' + emoji)).toHaveLength(199)
    for (const bad of ['http://reuters.com', 'https://localhost/x', 'https://10.0.0.1/', 'https://mac.local/', 'https://intranet/', 'https://u:p@reuters.com/', 'https://reuters.com:8443/', 'https://a.internal/'])
      expect(h.t.cueHttps(bad), bad).toBeNull()
    expect(h.t.cueHttps('https://www.reuters.com/a')).not.toBeNull()
  })
})

describe('Control Web Memories: QA fixes (6.99.26)', () => {
  it('a request that never reached the Mac says so in plain words, never the browser\'s "Failed to fetch"', async () => {
    const h = load({ answers: { 'ws:learning_page': new TypeError('Failed to fetch'), 'learning.list': new TypeError('Failed to fetch') } })
    await h.open()
    const html: string = h.t.listHtml()
    expect(html).toContain('Could not reach COS on your Mac. Check that the Mac is awake and on Tailscale, then try again.')
    expect(html).not.toContain('Failed to fetch')
  })

  it('the events count says it could not be counted when the first read fails, and keeps its last value when a refresh fails', async () => {
    const failing = load({ answers: { 'ws:learning_page': new TypeError('Failed to fetch'), 'learning.list': new TypeError('Failed to fetch') } })
    await failing.open()
    expect(failing.t.countsHtml()).toContain('Events in 90 days could not be counted')
    let fail = false
    const page = base()['ws:learning_page']
    const h = load({ answers: { 'ws:learning_page': () => (fail ? new TypeError('Failed to fetch') : page), 'learning.list': () => (fail ? new TypeError('Failed to fetch') : { events: [] }) } })
    await h.open()
    expect(h.t.countsHtml()).toContain('<b>34,195</b> events in 90 days')
    fail = true
    h.tap('refresh'); await flush()
    expect(h.t.countsHtml()).toContain('<b>34,195</b> events in 90 days')
  })

  it('Recent learning keeps one order across reads: newest first, ties by event id', async () => {
    const ts = '2026-11-07T05:12:46Z'
    const row = (id: string, t = ts) => ({ event_id: id, lesson_id: 'mem_' + id, event_type: 'retrieved', store: 'memory_trace', title: 'Included in context 1 time', source_refs: [], ts: t })
    let n = 0
    const reads = [[row('evt_b'), row('evt_c'), row('evt_a'), row('evt_old', '2026-11-01T00:00:00Z')], [row('evt_old', '2026-11-01T00:00:00Z'), row('evt_c'), row('evt_a'), row('evt_b')]]
    const h = load({ answers: { 'ws:learning_page': () => ({ protocol: 1, matched_total: 4, next_cursor: null, coverage: {}, items: reads[n++ % 2] }) } })
    await h.open()
    const first = h.S.recent.rows.map((r: any) => r.event_id)
    h.tap('refresh'); await flush()
    expect(first).toEqual(['evt_a', 'evt_b', 'evt_c', 'evt_old'])
    expect(h.S.recent.rows.map((r: any) => r.event_id)).toEqual(first)
  })

  it('Find points has no inline handler (the page CSP blocks those); the pane runs it by its data-role', () => {
    const workspace = readFileSync(join(HERE, 'memories', 'memory-workspace.js'), 'utf8')
    for (const f of ['memory-workspace.js', 'graph-explorer.js']) expect(readFileSync(join(HERE, 'memories', f), 'utf8'), f).not.toMatch(/\son[a-z]+="/)
    expect(workspace).toContain('data-role="find-points"')
    expect(SOURCE).toContain(`closest('.memory-investigation [data-role="find-points"]')`)
  })
})
