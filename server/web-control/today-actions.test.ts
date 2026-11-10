/**
 * Today as a place to act (Miles 11/06): the overlay on Today (panes/today-actions.js). Runs the REAL pane in a vm
 * with a fake COSWeb, document and history, and drives it the way taps do. The reply and steer tests run the REAL
 * Sessions reader send path (app.js continueSession, parkTurn, apiAnswer, the binding store), sliced out of app.js
 * with its sessionKit export, against a fake fetch: the overlay must send through the reader's code and never touch
 * the reader's own page. Nothing here reaches a server.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const TA = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
// 6.99.30: what every request learns about the Mac (the unreachable sentence, its clock, whether it answers), shared by
// api() and the reader's apiAnswer(): it sits between api() and the state in app.js, so a slice of the reader gets it here.
const TRANSPORT = APP.slice(APP.indexOf('  // ── what every request learns about the Mac'), APP.indexOf('  // ── state ─'))
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const WORK = readFileSync(join(HERE, 'panes', 'work.js'), 'utf8')
const QUESTIONS = readFileSync(join(HERE, 'panes', 'questions.js'), 'utf8')
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)

// ── a small fake DOM ─────────────────────────────────────
class El {
  id = ''; innerHTML = ''; textContent = ''; value = ''; hidden = false; disabled = false; readOnly = false; isConnected = true; scrollTop = 0
  attrs: Record<string, string> = {}
  listeners: Record<string, Array<(e: unknown) => void>> = {}
  cls = new Set<string>()
  classList = { add: (c: string) => this.cls.add(c), remove: (c: string) => this.cls.delete(c), contains: (c: string) => this.cls.has(c), toggle: (c: string, on?: boolean) => (on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c) }
  props: Record<string, string> = {}
  style = { setProperty: (k: string, v: string) => { this.props[k] = v } }
  doc: { activeElement: unknown } | null = null
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k]! : null }
  hasAttribute(k: string) { return k in this.attrs }
  removeAttribute(k: string) { delete this.attrs[k] }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ??= []).push(fn) }
  focus() { if (this.doc) this.doc.activeElement = this }
  querySelector() { return null }
  querySelectorAll() { return [] }
  contains() { return false }
  remove() { this.isConnected = false }
  scrollIntoView() {}
}

// ── the real reader send path, from app.js ──────────────
type Reply = { status: number; body: unknown } | Error
type Routes = Record<string, Reply | ((body: any, n: number) => Reply)>
function fakeFetch(routes: Routes) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const fetch = (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const key = method + ' ' + path
    const n = calls.filter(c => c.method + ' ' + c.path === key).length
    const h = routes[key]
    const out = typeof h === 'function' ? h(body, n) : h ?? { status: 404, body: {} }
    if (out instanceof Error) return Promise.reject(out)
    return Promise.resolve({ status: out.status, ok: out.status >= 200 && out.status < 300, text: () => Promise.resolve(JSON.stringify(out.body)), json: () => Promise.resolve(out.body) })
  }
  return { fetch, calls }
}
function readerKit(fetch: unknown, store: Map<string, string>, readerReading: unknown = null) {
  const start = APP.indexOf('  // ── Sessions: read, send, queue, fork, stop')
  const end = APP.indexOf("  // Copy session (Control's Kickstart brief")
  const ks = APP.indexOf('  window.COSWeb.sessionKit = {'), ke = APP.indexOf('\n  };', ks)
  expect(start, 'the reader send region starts').toBeGreaterThan(0)
  expect(end, 'the reader send region ends').toBeGreaterThan(start)
  expect(ks, 'app.js exports the sessionKit').toBeGreaterThan(0)
  const kitExpr = APP.slice(ks, ke + 4).replace('  window.COSWeb.sessionKit = ', '').replace(/;\s*$/, '')
  // The reader's own session words and markdown, not stubs: sxProvider to sxStateLabel, sxInline to sxListBlock, plain.
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const mdRegion = APP.slice(APP.indexOf('  // Markdown for an assistant turn'), APP.indexOf('  function renderTurns('))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
  expect(sx).toContain('function sxStateLabel(')
  expect(mdRegion).toContain('function sxMd(')
  const touched: string[] = []
  const timers: Array<() => void> = []
  const deps: Record<string, unknown> = {
    state: { reading: readerReading, turnPoll: null },
    $: (id: string) => { touched.push(id); return null },
    esc, md: (s: unknown) => String(s), toDate: (v: unknown) => (v ? new Date(String(v)) : null), autoGrow: () => {}, showAuth: () => {},
    clock: (d: Date) => d.toISOString().slice(11, 16),
    fetch, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
    AbortController, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {}, requestAnimationFrame: () => 0, document: {}, window: { COSWeb: {}, scrollTo: () => {} },
  }
  // eslint-disable-next-line no-new-func
  const kit = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + sx + '\n' + mdRegion + '\n' + APP.slice(start, end) + '\nreturn ' + kitExpr + ';\n}')(deps)
  return { kit, touched, deps }
}

// The one confirm rule (app.js COSWeb.confirmReady), run from app.js itself on the test's clock.
function realConfirmReady(D: { now(): number }) {
  const m = /  var ARM_CONFIRM_MS = (\d+);\n[\s\S]*?  window\.COSWeb\.confirmReady = (function \(armedAt\) \{[^\n]*\});/.exec(APP)
  expect(m, 'app.js defines COSWeb.confirmReady').not.toBeNull()
  // eslint-disable-next-line no-new-func
  return new Function('Date', 'ARM_CONFIRM_MS', 'return ' + m![2])(D, Number(m![1])) as (at: unknown) => boolean
}

// The one reading of the visible viewport (app.js viewportFit, 6.99.30), run from app.js itself against a test's window.
function realViewportFit(win: any, doc: any): () => any {
  const a = APP.indexOf('  var VP = { layoutH: 0 };'), b = APP.indexOf('  // ── layout breadcrumbs')
  expect(a, 'app.js defines viewportFit').toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', APP.slice(a, b) + '\nreturn viewportFit;')(win, doc)
}

// ── the overlay, loaded for real ─────────────────────────
interface Opts {
  /** W13: what questions.js says of its last read ('unread', 'ok', 'failed'), and a later change of it. */
  qLoad?: { state: string }
  data?: Record<string, unknown>
  api?: Record<string, unknown | ((body: any, n: number) => unknown)>
  routes?: Routes
  questions?: number
  store?: Map<string, string>
  readerReading?: unknown
  webStore?: Map<string, string>
  styles?: Record<string, Record<string, string>>
  model?: unknown
  mac?: number
  pet?: unknown
  held?: unknown[]
  // 6.99.29: a visualViewport (the on-screen keyboard), the layout viewport's height, and frames run by hand
  vv?: { height: number; offsetTop?: number; scale?: number }
  innerHeight?: number
}
function load(o: Opts = {}) {
  const els: Record<string, El> = {}
  const docListeners: Record<string, Array<(e: any) => void>> = {}
  const winListeners: Record<string, (e?: unknown) => void> = {}
  const routeHooks: Array<(r: { pane: string }) => void> = []
  const panes: Record<string, any> = {}
  const posts: Array<{ path: string; body: any }> = []
  const apiCalls: string[] = []
  const gone: Array<[string, boolean]> = []
  let refreshed = 0, reloads = 0, workChanged = 0
  const document: any = {
    activeElement: null,
    body: { appendChild: (el: El) => { document.appended = el } },
    documentElement: new El(),
    createElement: () => { const e = new El(); e.doc = document; e.querySelector = ((sel: string) => (sel === '.ta-scrim' ? scrimEl : null)) as any; return e },
    getElementById: (id: string) => { if (!els[id]) { els[id] = new El(); els[id]!.id = id; els[id]!.doc = document } return els[id] },
    querySelector: (sel: string) => document.selectors?.[sel] ?? null,
    addEventListener: (t: string, fn: (e: any) => void) => { (docListeners[t] ??= []).push(fn) },
  }
  document.getElementById('ask-sheet').classList.add('hidden')
  const scrimEl = new El(); scrimEl.id = 'scrim'
  const history = { state: null as unknown, pushes: 0, backs: 0, replaces: 0, gos: [] as number[], pushState(s: unknown) { this.state = s; this.pushes++ }, replaceState(s: unknown) { this.state = s; this.replaces++ }, back() { this.backs++ }, go(n: number) { this.gos.push(n) } }
  const location = { hash: '#/today', replaced: [] as string[], replace(h: string) { this.replaced.push(h) } }
  const data: Record<string, unknown> = { needs: [], working: [], open: [], welcome: {}, offline: false, at: 1, sessions: [], intake: [], intakeCaps: { cardCreation: true, linkWrites: true }, intakeLoaded: true, ...(o.data || {}) }
  const answers = o.api || {}
  const api = (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push((opts?.method || 'GET') + ' ' + path)
    if (opts?.method === 'POST') posts.push({ path, body: opts.body })
    const n = apiCalls.filter(c => c === (opts?.method || 'GET') + ' ' + path).length
    const a = answers[(opts?.method || 'GET') + ' ' + path] ?? answers[path]
    const v = typeof a === 'function' ? (a as (b: unknown, n: number) => unknown)(opts?.body, n) : a
    if (v instanceof Error) return Promise.reject(v)
    if (v && typeof (v as Promise<unknown>).then === 'function') return v as Promise<unknown>
    return Promise.resolve(v ?? {})
  }
  const store = o.store ?? new Map<string, string>()
  const webStore = o.webStore ?? new Map<string, string>()
  const { fetch, calls } = fakeFetch(o.routes || {})
  const reader = readerKit(fetch, store, o.readerReading ?? null)
  const streams: any[] = []
  class FakeEventSource { url: string; closed = false; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; readyState = 1
    constructor(url: string) { this.url = url; streams.push(this) } close() { this.closed = true } }
  const mounts: string[] = []
  let unmounts = 0, nudges = 0, retries = 0
  const qChange: Array<(n: number, mac: number) => void> = []
  // The page's clock: real time plus whatever the test moves it on (later()).
  let skew = 0
  const realNow = Date.now
  class VDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + skew) } static now() { return realNow() + skew } }
  const W: Record<string, unknown> = {
    confirmReady: realConfirmReady(VDate),
    esc, api, go: (p: string, a: string[]) => { location.hash = '#/' + [p].concat(a || []).join('/') }, isPhone: () => true, autoGrow: () => {},
    parseRoute: () => ({ pane: (location as any).pane ?? 'today', args: [] }),
    readStore: (k: string) => { try { return JSON.parse(webStore.get(k) ?? '{}') } catch { return {} } },
    writeStore: (k: string, v: unknown) => { webStore.set(k, JSON.stringify(v)) },
    setStatus: (el: El | null, text: string, err: boolean) => { if (el) { el.textContent = text || ''; el.setAttribute('data-error', err ? '1' : '0') } },
    domainLabel: (d: string) => ({ personal: 'Personal', quilt: 'Quilt' } as Record<string, string>)[d] || d,
    ago: () => '3 h', clock: () => '9:00 PM', dayWord: () => 'tomorrow', toDate: (v: unknown) => (v ? new Date(String(v)) : null),
    onRoute: (fn: (r: { pane: string }) => void) => routeHooks.push(fn),
    registerPane: (n: string, def: unknown) => { panes[n] = def },
    pane: (n: string) => (n === 'work' ? { intakeChanged: () => { workChanged++ } } : panes[n] || null),
    today: {
      data: () => data,
      needWhy: (it: { progress?: { reported?: string } }) => (it.progress && it.progress.reported === 'needsInput' ? 'Waiting for your reply' : 'Needs a look'),
      sessionTitle: (s: { display_label?: string }) => s.display_label || 'Untitled session',
      badge: (p: string) => '<span class="badge ' + p + '">' + p + '</span>', span: () => '20 min',
      splitSessionId: (provider: string, id: string) => { const m = /^(claude|codex|cursor):(.+)$/.exec(String(id || '')); return m ? { provider: m[1], id: m[2] } : { provider: provider || 'claude', id: String(id || '') } },
      markGone: (id: string, g: boolean) => { gone.push([id, g]) },
      needs: () => o.model ?? null,
      petPlay: () => o.pet ?? { waiting: [], running: [], done: [] },
      reloadIntake: () => { reloads++; return Promise.resolve() },
      refresh: () => { refreshed++ },
    },
    sessionKit: reader.kit,
    // Like questions.js mount(): it draws and calls back with the count before it returns.
    sessionQuestions: { mount: (_el: El, sid: string, onChange?: (n: number, mac: number) => void) => { mounts.push(sid); if (onChange) { qChange.push(onChange); onChange(o.questions || 0, o.mac || 0) } return { count: () => o.questions || 0, unmount: () => { unmounts++ } } },
      ...(o.qLoad ? { loadState: () => o.qLoad!.state, retry: () => { retries++ } } : {}),
      itemsFor: (sid: string) => (sid ? (o.held || []).filter((i: any) => String(i.sessionId).toLowerCase() === String(sid).toLowerCase()) : (o.held || [])),
      nudge: () => { nudges++ } },
  }
  const vvListeners: Record<string, Array<() => void>> = {}
  const visualViewport = o.vv ? { offsetTop: 0, scale: 1, ...o.vv,
    addEventListener: (t: string, fn: () => void) => { (vvListeners[t] ??= []).push(fn) },
    removeEventListener: (t: string, fn: () => void) => { vvListeners[t] = (vvListeners[t] || []).filter(f => f !== fn) } } : undefined
  const frames: Array<() => void> = []
  const intervals: Array<{ fn: () => void; ms: number; cleared?: boolean }> = []
  const win: any = { COSWeb: W, addEventListener: (t: string, fn: () => void) => { winListeners[t] = fn }, visualViewport,
    ...(o.vv ? { innerHeight: o.innerHeight ?? 1000, requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length }, cancelAnimationFrame: (n: number) => { frames[n - 1] = () => {} } } : {}) }
  // app.js's own viewport reading and a breadcrumb recorder (6.99.30).
  const vf = realViewportFit(win, document)
  W.viewportFit = vf
  const crumbs: Array<{ what: string; data: Record<string, unknown> }> = []
  W.layoutCrumb = (what: string, data: Record<string, unknown>) => { crumbs.push({ what, data }); return true }
  const serverHooks: Array<(up: boolean) => void> = []
  W.onServer = (fn: (up: boolean) => void) => { serverHooks.push(fn) }
  const ctx = vm.createContext({
    window: win,
    document, history, location, fetch, EventSource: FakeEventSource, AbortController, console, Date: VDate, JSON, Math, Promise, isFinite, encodeURIComponent,
    setTimeout: (fn: () => void, ms: number) => { (ctx as any).__timers.push({ fn, ms }); return 1 }, clearTimeout: () => {},
    // Intervals are kept so a test can tick them (6.99.30: the clock and the turn watch skip a hidden page).
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval: (n: number) => { if (n && intervals[n - 1]) intervals[n - 1]!.cleared = true },
    getComputedStyle: (el: El) => (o.styles ? o.styles[el.id] : undefined),
  })
  ;(ctx as any).__timers = []
  vm.runInContext(TA, ctx)
  const ta = panes.todayActions
  expect(ta, 'the overlay registers as a lazy pane').toBeTruthy()
  // A tap that goes through the layer as the browser sends it: the capture guard first, then the overlay's handler.
  const layerTap = (what: string, id?: string) => {
    const b = { disabled: false, getAttribute: (a: string) => (a === 'data-ta' ? what : a === 'data-id' ? id ?? null : null), closest() { return this }, remove() {} }
    const fns = document.appended.listeners.click as Array<(e: unknown) => void>
    let stopped = false
    const ev = { target: b, stopPropagation() { stopped = true }, preventDefault() {} }
    fns[0]!(ev)
    if (!stopped) fns[1]!(ev)
    return !stopped
  }
  const tap = (what: string, id?: string) => {
    const b = { disabled: false, getAttribute: (a: string) => (a === 'data-ta' ? what : a === 'data-id' ? id ?? null : null), closest() { return this }, remove() {} }
    ta._onClick({ target: b })
  }
  const opener = () => { const e = new El(); e.doc = document; e.setAttribute('data-today', 'meeting'); return e }
  const key = (k: string) => (docListeners.keydown || []).forEach(fn => fn({ key: k, preventDefault() {} }))
  const pop = () => winListeners.popstate?.()
  const route = (pane: string) => routeHooks.forEach(fn => fn({ pane }))
  const runTimers = () => { const t = (ctx as any).__timers.splice(0); t.forEach((x: { fn: () => void }) => x.fn()) }
  const elsAll = new Proxy(els, { get: (_t, id: string) => document.getElementById(id) }) as Record<string, El>
  const later = (ms: number) => { skew += ms }
  // The keyboard (or a fold, a zoom, a pan): the visible viewport changes and fires as Safari does; frames run on runFrames.
  const viewport = (v: { height?: number; offsetTop?: number; scale?: number }, type: 'resize' | 'scroll' = 'resize') => {
    Object.assign(visualViewport!, v); (vvListeners[type] || []).slice().forEach(fn => fn())
  }
  const runFrames = () => { const f = frames.splice(0); f.forEach(fn => fn()); return f.length }
  const tick = () => intervals.filter(i => !i.cleared).forEach(i => i.fn())
  const server = (up: boolean) => serverHooks.forEach(fn => fn(up))
  return { server, viewport, runFrames, vvListeners, winListeners, crumbs, docListeners, intervals, tick, ta, els: elsAll, data, layerTap, webStore, later, now: () => realNow() + skew, posts, apiCalls, gone, calls, store, reader, streams, mounts, history, location, document, tap, opener, key, pop, route, runTimers,
    refreshed: () => refreshed, reloads: () => reloads, workChanged: () => workChanged, unmounts: () => unmounts, nudges: () => nudges, ctx,
    retries: () => retries, qChanged: () => qChange.forEach(fn => fn(o.questions || 0, o.mac || 0)) }
}

const MEETING = (title: string) => ({ domain: 'quilt', month: '2026-11', filename: '2026-11-06_' + title.replace(/\W+/g, '_') + '.md', recordId: 'ops:quilt:' + title, title })
const ITEM = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'ask', status: 'ask', text, owner: null, ownerIsMiles: false, meeting: MEETING('Surcharging Push'), ...extra })
const ID1 = 'wi_' + 'a'.repeat(32), ID2 = 'wi_' + 'b'.repeat(32), ID3 = 'wi_' + 'c'.repeat(32)
const resolved = (id: string, action: string, at = new Date().toISOString(), extra: Record<string, unknown> = {}) => ({ ok: true, item: { id, status: action === 'accept' ? 'accepted' : 'dismissed', resolution: { action, by: 'user', at, ...extra } } })
const codeError = (code: string, status = 409, message = 'refused') => Object.assign(new Error(message), { code, status })

describe('From today’s meetings: decide in the overlay, through Work’s own route', () => {
  it('Create task posts one resolve accept, moves the Today count at once, and tells Work to read again; a second tap sends nothing', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'Write the KB plan'), ITEM(ID2, 'Call Megan')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'accept', undefined, { taskId: 'abcdef123456' }), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    expect(h.els['ta-body']!.innerHTML).toContain('Write the KB plan')
    expect(h.els['ta-body']!.innerHTML).toContain('Create task')
    h.tap('create', ID1); h.tap('create', ID1); h.tap('dismiss', ID2)
    // While one decision is out, every decision button is disabled, as Control's busy ids do.
    expect(h.els['ta-body']!.innerHTML).toContain('Creating')
    expect((h.els['ta-body']!.innerHTML.match(/data-ta="(create|dismiss)"[^>]*disabled/g) || []).length).toBe(2)
    await flush()
    expect(h.posts).toEqual([{ path: `/api/work-intake/${ID1}/resolve`, body: { action: 'accept' } }])
    expect(h.gone).toEqual([[ID1, true]])
    expect(h.workChanged()).toBe(1)
    const html = h.els['ta-body']!.innerHTML
    expect(html).toContain('Created. It is in Work.')
    expect(html).toContain('data-ta="open-card" data-id="abcdef123456"')
    expect(html, 'no Undo on a server without the undo route').not.toContain('data-ta="undo"')
  })

  it('Dismiss collapses to Dismissed, then leaves after its window; Undo shows only where the undo route exists and sends that row’s own id', async () => {
    const at = '2026-11-07T05:00:00.000Z'
    const h = load({ data: { intake: [ITEM(ID1, 'Not a task')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss', at), '/api/work-intake/decisions': { decisions: [] }, 'POST /api/work-intake/undo': { ok: true } } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    await flush()   // the undo route answers: one tap dismisses
    // The decision is made at the server's time: pretend the tap happened then.
    h.ta._state.rows = {}
    const realNow = Date.now
    ;(h.ctx as any).Date.now = () => Date.parse(at)
    h.tap('dismiss', ID1)
    await flush()
    ;(h.ctx as any).Date.now = realNow
    expect(h.els['ta-body']!.innerHTML).toContain('Dismissed.')
    expect(h.els['ta-body']!.innerHTML).toContain('data-ta="undo" data-id="' + ID1 + '"')
    h.tap('undo', ID1)
    await flush()
    expect(h.posts[1]).toEqual({ path: '/api/work-intake/undo', body: { batchId: ID1 + ':' + at } })
    expect(h.gone).toEqual([[ID1, true], [ID1, false]])
    expect(h.reloads()).toBeGreaterThanOrEqual(2)
  })

  it('a dismissed line leaves once its eight seconds have passed', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'Not a task')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss'), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('dismiss', ID1); h.later(450); h.tap('dismiss', ID1)   // no Undo here: tap, then tap again a moment later
    await flush()
    expect(h.els['ta-body']!.innerHTML).toContain('Dismissed.')
    h.ta._state.rows[ID1].until = Date.now() - 1
    h.data.intake = []
    h.runTimers()
    expect(h.els['ta-body']!.innerHTML).not.toContain('Dismissed.')
  })

  it('a refusal says what happened in Work’s words, keeps the row, and Try again sends again', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'Same words as closed work')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: (_b: unknown, n: number) => (n === 1 ? codeError('intake_text_collision') : resolved(ID1, 'accept')), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('create', ID1)
    await flush()
    const html = h.els['ta-body']!.innerHTML
    expect(html).toContain('The same words are on closed or archived work.')
    expect(html).toContain('>Try again</button>')
    expect(html).toContain('data-ta="dismiss"')
    expect(h.gone).toEqual([])
    h.tap('create', ID1)
    await flush()
    expect(h.posts.map(p => p.body.action)).toEqual(['accept', 'accept'])
    expect(h.els['ta-body']!.innerHTML).toContain('Created. It is in Work.')
  })

  it('a timeout says it may have saved, and the retry is read as this tap, not as another screen', async () => {
    const asked = Date.now()
    const h = load({ data: { intake: [ITEM(ID1, 'Slow one')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: (_b: unknown, n: number) => (n === 1 ? codeError('timeout', 0, 'late') : resolved(ID1, 'accept', new Date(asked + 1000).toISOString())), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('create', ID1)
    await flush()
    expect(h.els['ta-body']!.innerHTML).toContain('It may still have saved it. Trying again is safe.')
    h.tap('create', ID1)
    await flush()
    expect(h.els['ta-body']!.innerHTML).toContain('Created. It is in Work.')
  })

  it('a retry minutes after a lost answer is still this tap: the server dated it at the first try, not on another screen', async () => {
    const t0 = Date.parse('2026-11-07T05:00:00.000Z')
    const realNow = Date.now
    const h = load({ data: { intake: [ITEM(ID1, 'Slow one')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: (_b: unknown, n: number) => (n === 1 ? codeError('timeout', 0, 'late') : resolved(ID1, 'accept', new Date(t0 + 500).toISOString())), '/api/work-intake/decisions': codeError('', 404) } })
    try {
      ;(h.ctx as any).Date.now = () => t0
      h.ta.open('meeting', 'Surcharging Push', h.opener())
      h.tap('create', ID1)
      await flush()
      ;(h.ctx as any).Date.now = () => t0 + 3 * 60000
      h.tap('create', ID1)
      await flush()
    } finally { (h.ctx as any).Date.now = realNow }
    expect(h.els['ta-body']!.innerHTML).toContain('Created. It is in Work.')
    expect(h.els['ta-body']!.innerHTML).not.toContain('another screen')
  })

  it('stale: decided the other way on another screen, or gone, reads as handled elsewhere and never crashes', async () => {
    const old = new Date(Date.now() - 10 * 60000).toISOString()
    const h = load({ data: { intake: [ITEM(ID1, 'One'), ITEM(ID2, 'Two'), ITEM(ID3, 'Three')] }, api: {
      [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss', old),
      [`POST /api/work-intake/${ID2}/resolve`]: codeError('intake_not_found', 404),
      [`POST /api/work-intake/${ID3}/resolve`]: resolved(ID3, 'accept', old),
      '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('create', ID1); await flush()
    h.tap('dismiss', ID2); h.later(450); h.tap('dismiss', ID2); await flush()
    h.tap('create', ID3); await flush()
    const html = h.els['ta-body']!.innerHTML
    expect(html).toContain('Already dismissed on another screen.')
    expect(html).toContain('This suggestion is gone. It was handled on another screen.')
    expect(html).toContain('Already in Work. It was decided on another screen.')
    expect(html, 'a stale row offers no decision').not.toMatch(/data-ta="(create|dismiss)" data-id="wi_/)
  })

  it('opening re-reads Intake: a suggestion decided elsewhere since Today loaded shows as handled, not as a phantom', async () => {
    let release: () => void = () => {}
    const h = load({ data: { intake: [ITEM(ID1, 'Still open'), ITEM(ID2, 'Decided on the Mac')] } })
    ;(h.ctx as any).window.COSWeb.today.reloadIntake = () => new Promise<void>(r => { release = () => { h.data.intake = [ITEM(ID1, 'Still open')]; r() } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    expect(h.els['ta-body']!.innerHTML).toContain('data-ta="create" data-id="' + ID2 + '"')
    release()
    await flush()
    const html = h.els['ta-body']!.innerHTML
    expect(html).toContain('Decided on the Mac')
    expect(html).toContain('This suggestion is gone. It was handled on another screen.')
    expect(html).not.toContain('data-ta="create" data-id="' + ID2 + '"')
  })

  it('offers what Control offers: Create task, Open in Work and Dismiss; a link has Link and Open card; no Create task when the server cannot make cards', () => {
    const link = { id: ID2, kind: 'link', status: 'suggested', task: { text: 'Existing KB card', workIdentity: '0123456789ab', domain: 'quilt' }, meeting: MEETING('Surcharging Push') }
    const h = load({ data: { intake: [ITEM(ID1, 'Mine', { ownerIsMiles: true }), link, ITEM(ID3, 'Andy asks', { owner: 'Andy Wheeler' })] } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    const html = h.els['ta-body']!.innerHTML
    expect(html).toContain('Yours, from Surcharging Push')
    expect(html).toContain('Andy Wheeler’s, from Surcharging Push')
    expect(html).toContain('Matches the Work card Existing KB card, from Surcharging Push')
    expect(html).toContain('data-ta="link" data-id="' + ID2 + '"')
    expect(html).toContain('data-ta="open-card" data-id="0123456789ab"')
    const off = load({ data: { intake: [ITEM(ID1, 'Mine')], intakeCaps: { cardCreation: false, linkWrites: false } } })
    off.ta.open('meeting', 'Surcharging Push', off.opener())
    expect(off.els['ta-body']!.innerHTML).not.toContain('data-ta="create"')
    expect(off.els['ta-body']!.innerHTML).toContain('Open in Work')
    expect(off.els['ta-body']!.innerHTML).toContain('data-ta="dismiss"')
  })

  it('Review opens every meeting’s suggestions, grouped; one meeting can widen to all', () => {
    const other = ITEM(ID3, 'Thrift template', { meeting: MEETING('Seasonal Release') })
    const h = load({ data: { intake: [ITEM(ID1, 'One'), other] } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    expect(h.els['ta-body']!.innerHTML).not.toContain('Thrift template')
    expect(h.els['ta-body']!.innerHTML).toContain('Show all 2 from today')
    h.tap('show-all')
    expect(h.els['ta-body']!.innerHTML).toContain('Thrift template')
    const all = load({ data: { intake: [ITEM(ID1, 'One'), other] } })
    all.ta.open('intake', '', all.opener())
    expect(all.els['ta-title']!.textContent).toBe('From today’s meetings')
    expect(all.els['ta-body']!.innerHTML).toContain('<h3 class="ta-group">Seasonal Release</h3>')
  })
})

describe('the overlay itself: Back, Escape, focus, the page behind', () => {
  it('opening holds one history entry; X or Escape closes and pops it once; the popstate that follows is ignored', () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    const opener = h.opener()
    opener.isConnected = true
    h.ta.open('meeting', 'Surcharging Push', opener)
    expect(h.history.pushes).toBe(1)
    expect(h.els['app-shell']!.hasAttribute('inert')).toBe(true)
    expect(h.document.documentElement.cls.has('ta-open')).toBe(true)
    expect(h.document.activeElement).toBe(h.els['ta-sheet'])
    h.key('Escape')
    expect(h.ta.isOpen()).toBe(false)
    expect(h.history.backs).toBe(1)
    expect(h.els['app-shell']!.hasAttribute('inert')).toBe(false)
    expect(h.document.documentElement.cls.has('ta-open')).toBe(false)
    expect(h.document.activeElement, 'focus returns to the row').toBe(opener)
    // back() is asynchronous: its popstate can land after the next overlay has opened, and must not close it.
    h.ta.open('meeting', 'Surcharging Push', opener)
    expect(h.history.pushes).toBe(2)
    h.pop()   // the back() from the Escape above
    expect(h.ta.isOpen(), 'a late popstate never closes the next overlay').toBe(true)
    h.tap('close')
    expect(h.history.backs).toBe(2)
  })

  it('Back on the phone closes the overlay and never navigates the page', () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.pop()
    expect(h.ta.isOpen()).toBe(false)
    expect(h.history.backs, 'Back already popped the entry').toBe(0)
    expect(h.location.replaced).toEqual([])
    expect(h.location.hash).toBe('#/today')
  })

  it('Escape while the Ask sheet is open over it leaves the overlay open; leaving Today closes it without touching history', () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.els['ask-sheet']!.classList.remove('hidden')
    h.key('Escape')
    expect(h.ta.isOpen()).toBe(true)
    h.route('sessions')
    expect(h.ta.isOpen()).toBe(false)
    expect(h.history.backs).toBe(0)
  })

  it('a link inside goes to its tab by replacing the overlay’s entry, so Back from there lands on Today', () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('open-work')
    expect(h.location.replaced).toEqual(['#/work/sort'])
    expect(h.history.backs).toBe(0)
    expect(h.ta.isOpen()).toBe(false)
  })

  it('closing after a decision refreshes Today once', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'accept'), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('create', ID1)
    await flush()
    h.tap('close')
    expect(h.refreshed()).toBe(1)
  })
})

const SID = '56627115-dbce-4c1a-9a00-000000000001'
const NEED = { id: 'act-1', workId: 'task:personal:0123456789ab', domain: 'personal', status: 'delivered', provider: 'claude', sessionId: 'claude:' + SID,
  sessionTitle: 'COS Glasses - QA review before publish', title: 'Speaker Diarization for mac meeting', workIdentity: '0123456789ab',
  progress: { reported: 'needsInput', evidence: 'The install is ready. Should I publish?', paused: false } }
const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
const OK_ROUTES: Routes = {
  ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [{ role: 'user', text: 'Do the QA' }, { role: 'assistant', text: 'Ready to publish **6.99.24**.', at: '2026-11-07T05:36:00Z' }] } },
  ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: '', reasonCopy: '', ownerCount: 0 } },
  ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } },
  ['POST /api/agent-sessions/bindings/b1/turns']: { status: 202, body: { outcome: 'queued' } },
}

describe('Needs you: see what the session waits on and reply, through the reader’s own send path', () => {
  it('shows the session’s line, the last reply and the composer; mounts this session’s question cards', async () => {
    const waitingRow = { session_id: SID, provider: 'claude', display_label: 'COS Glasses - QA review before publish', alive: true, running: true,
      agent_state: 'waiting', state_source: 'hook', waiting_kind: 'permission', waiting_detail: 'Bash git push' }
    const h = load({ data: { needs: [NEED], sessions: [waitingRow] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } }, questions: 1 })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    expect(h.els['ta-title']!.textContent).toBe('COS Glasses - QA review before publish')
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('Waiting for your reply in Personal, 3 h ago')
    expect(meta).toContain('Work card: Speaker Diarization for mac meeting')
    expect(meta).toContain('The install is ready. Should I publish?')
    expect(meta).toContain('It is asking you this now. Answer here.')
    expect(meta).toContain('data-ta="open-session"')
    expect(h.mounts).toEqual([SID])
    // The reader's own markdown (sxMd), not a stub.
    expect(h.els['ta-last']!.innerHTML).toContain('<p>Ready to publish <strong>6.99.24</strong>.</p>')
    // The session's state in the reader's words (sxState, sxStateLabel), read from a real waiting row.
    expect(meta).toContain('Waiting for you: Permission: Bash git push')
    expect(h.els['ta-foot']!.innerHTML).toContain('id="ta-input"')
  })

  it('Reply: attach, then one turn under one key; a double tap sends once; the reader’s page is never touched', async () => {
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Yes, publish it'
    h.tap('send'); h.tap('send')
    expect(h.els['ta-send']!.disabled, 'Send is disabled while it is out').toBe(true)
    await flush()
    const attach = h.calls.filter(c => c.method === 'POST' && c.path.endsWith('/attach'))
    const turns = h.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')
    expect(attach).toHaveLength(1)
    expect(attach[0]!.body.cosSessionId).toMatch(/^web-[a-z0-9]{8,24}$/)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.body).toMatchObject({ prompt: 'Yes, publish it', epoch: 3, targetKey: '6:claude:' + SID.length + ':' + SID })
    expect(turns[0]!.body.clientTurnId).toMatch(/^ct[a-z0-9]+$/)
    expect(h.els['ta-input']!.value, 'the sent words leave the box').toBe('')
    expect(h.els['ta-status']!.textContent).toBe('Sent. Watching for the reply.')
    expect(h.els['ta-send']!.disabled).toBe(false)
    expect(h.reader.touched.filter(id => /^session-/.test(id)), 'no reader DOM').toEqual([])
    // The binding is the reader's, kept per browser: the reader reuses it.
    expect(JSON.parse(h.store.get('cos_web_bindings')!)['claude|' + SID]).toMatchObject({ bindingId: 'b1', epoch: 3 })
  })

  it('the overlay keeps its own draft key, never the Sessions reader\u2019s, even with the same words', async () => {
    const readerDraft = { text: 'Yes, publish it', key: 'ctREADERKEY0000' }
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } },
      readerReading: { provider: 'claude', id: SID, draft: readerDraft, held: [] } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Yes, publish it'
    h.tap('send')
    await flush()
    const turns = h.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')
    expect(turns).toHaveLength(1)
    expect(turns[0]!.body.clientTurnId).not.toBe('ctREADERKEY0000')
    expect(readerDraft.key, 'the reader\u2019s draft is untouched').toBe('ctREADERKEY0000')
  })

  it('a lost answer says so and Try again resends the same key, so nothing can post twice', async () => {
    const routes: Routes = { ...OK_ROUTES, ['POST /api/agent-sessions/bindings/b1/turns']: (_b, n) => (n === 1 ? new TypeError('Load failed') : { status: 202, body: { outcome: 'queued', replayed: false } }) }
    const h = load({ data: { needs: [NEED] }, routes, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Ship it'
    h.tap('send')
    await flush()
    // 6.99.30: the browser's own "Load failed" never reaches the page (app.js apiAnswer, code 'unreachable').
    expect(h.els['ta-verdict']!.innerHTML).toContain('Could not reach COS on your Mac. Check that it is awake and on Tailscale, then try again.')
    expect(h.els['ta-verdict']!.innerHTML).not.toContain('Load failed')
    expect(h.els['ta-verdict']!.innerHTML).toContain('data-ta="retry"')
    expect(h.els['ta-input']!.value, 'the words stay').toBe('Ship it')
    h.tap('retry')
    await flush()
    const turns = h.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')
    expect(turns).toHaveLength(2)
    expect(turns[1]!.body.clientTurnId).toBe(turns[0]!.body.clientTurnId)
    expect(h.calls.filter(c => c.path.endsWith('/attach')), 'the binding is reused').toHaveLength(1)
    expect(h.els['ta-status']!.textContent).toBe('Sent. Watching for the reply.')
  })

  it('another app holds the session: the first Send asks first and sends nothing until Send anyway', async () => {
    const routes: Routes = { ...OK_ROUTES, ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: '', reasonCopy: '', ownerCount: 1 } } }
    const h = load({ data: { needs: [NEED] }, routes, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Go'
    h.tap('send')
    await flush()
    expect(h.els['ta-verdict']!.innerHTML).toContain('Send into an open session?')
    expect(h.calls.some(c => c.method === 'POST')).toBe(false)
    h.tap('caution-send')   // the second half of the Send double tap: too soon, ignored
    await flush()
    expect(h.calls.some(c => c.method === 'POST')).toBe(false)
    h.later(450)
    h.tap('caution-send')
    await flush()
    expect(h.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')).toHaveLength(1)
  })

  it('a changed session offers Continue anyway, which sends the revision the server named', async () => {
    const routes: Routes = { ...OK_ROUTES, ['POST /api/agent-sessions/bindings/b1/turns']: (_b, n) => (n === 1 ? { status: 409, body: { outcome: 'refused', reason: 'native_thread_changed', revision: 'rev9', reasonCopy: 'This session changed on your Mac since you opened it.' } } : { status: 202, body: { outcome: 'queued' } }) }
    const h = load({ data: { needs: [NEED] }, routes, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Go on'
    h.tap('send')
    await flush()
    expect(h.els['ta-verdict']!.innerHTML).toContain('This session changed on your Mac since you opened it.')
    h.tap('send-anyway')
    await flush()
    const turns = h.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')
    expect(turns[1]!.body.acknowledgedRevision).toBe('rev9')
  })

  it('a handoff no longer waiting reads as handled elsewhere', async () => {
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('This is no longer waiting on you. It was handled on another screen.')
    const missing = load({ data: { needs: [] } })
    missing.ta.open('need', 'act-gone', missing.opener())
    expect(missing.els['ta-meta']!.innerHTML).toContain('This is no longer waiting on you.')
    expect(missing.els['ta-foot']!.innerHTML, 'nothing to reply to').toBe('')
  })
})

describe('Running: a peek at what the session does now, and a note on the same path', () => {
  const CID = '019a0000-1111-2222-3333-444455556666'
  const CP = (tail: string) => `/api/agent-sessions/codex/${encodeURIComponent(CID)}${tail}`
  const ROW = { session_id: CID, provider: 'codex', display_label: 'COS Product Work (CODEX)', running: true, running_active: true, agent_state: 'running', state_source: 'hook' }
  it('reads the live stream with the reader’s reducer; a busy session parks the note in its queue under one key; closing stops the stream', async () => {
    const routes: Routes = {
      ['GET ' + CP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
      ['GET ' + CP('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
      ['POST ' + CP('/attach')]: { status: 409, body: { attached: false, reason: 'native_thread_working', reasonCopy: 'Working right now.' } },
      ['POST ' + CP('/queued-turns')]: { status: 200, body: { queued: true, position: 1 } },
    }
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes })
    h.ta.open('run', 'codex|' + CID, h.opener())
    await flush()
    expect(h.els['ta-title']!.textContent).toBe('COS Product Work (CODEX)')
    expect(h.els['ta-meta']!.innerHTML, 'the reader\u2019s sxState reads a hook-backed running row').toContain('Working now, for 20 min')
    expect(h.streams).toHaveLength(1)
    expect(h.streams[0].url).toBe(CP('/stream?seed=turn'))
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_since: new Date().toISOString() }) })
    es.onmessage({ data: JSON.stringify({ seq: 2, kind: 'prompt', text: 'Build the Today overlay' }) })
    es.onmessage({ data: JSON.stringify({ seq: 3, kind: 'tool', verb: 'read', target: 'app.js' }) })
    const live = h.els['ta-live']!.innerHTML
    expect(live).toContain('<strong>Working</strong>')
    expect(live).toContain('Working on: Build the Today overlay')
    expect(live).toContain('Read app.js')
    expect(h.els['ta-verdict']!.innerHTML).toContain('joins the Codex app’s queue')
    h.els['ta-input']!.value = 'Also fix the footer'
    h.tap('send')
    await flush()
    // The sheet also reads the queue for refused messages (6.99.30 loadNotSent, a GET): the note is the one POST.
    const q = h.calls.filter(c => c.path === CP('/queued-turns') && c.method === 'POST')
    expect(q).toHaveLength(1)
    expect(q[0]!.body).toMatchObject({ prompt: 'Also fix the footer' })
    expect(h.els['ta-status']!.textContent).toBe('The session is busy. Yours is #2 in line and sends on its own.')
    // Parked by this browser, so the reader offers Cancel on it.
    expect(JSON.parse(h.store.get('cos_web_parked')!)['codex|' + CID]).toEqual([q[0]!.body.clientTurnId])
    h.tap('close')
    expect(es.closed).toBe(true)
  })

  it('a refused stream says why and keeps the stored reply', async () => {
    const h = load({ data: { sessions: [ROW] }, routes: { ['GET ' + CP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [{ role: 'assistant', text: 'Done with the build.' }] } } } })
    h.ta.open('run', 'codex|' + CID, h.opener())
    await flush()
    const es = h.streams[0]
    es.readyState = 2
    ;(h.ctx as any).fetch = (h.ctx as any).fetch
    es.onerror()
    await flush()
    expect(h.els['ta-live']!.innerHTML).toContain('No live feed for this session')
    expect(h.els['ta-last']!.innerHTML).toContain('Done with the build.')
  })
})

describe('the reader keeps its own page: the seam changes nothing for Sessions', () => {
  it('a send from the reader (no view) still writes the reader’s status line and turn list', async () => {
    const store = new Map<string, string>()
    const { fetch } = fakeFetch(OK_ROUTES)
    const r: any = { provider: 'claude', id: SID, draft: null, held: [], verdict: null, refusal: null }
    const { kit, touched } = readerKit(fetch, store, r)
    const out = await kit.send(r, 'From the reader', {})
    expect(out).toBe('sent')
    expect(touched).toEqual(expect.arrayContaining(['session-status', 'session-turns', 'session-input']))
  })
})

describe('what COS is told when Miles asks from Today', () => {
  it('summary: Needs you, Running, today’s suggestions by meeting and Up next, in plain words, with no ids', () => {
    const h = load({ data: {
      needs: [NEED],
      working: [{ session_id: 'codex:019a', provider: 'codex', display_label: 'COS Product Work (CODEX)' }], open: [{}, {}, {}],
      intake: [ITEM(ID1, 'Write the KB plan', { owner: 'Andy Wheeler' }), ITEM(ID2, 'Call Megan', { ownerIsMiles: true }), ITEM(ID3, 'Thrift template', { meeting: MEETING('Seasonal Release') })],
      welcome: { nextEvent: { title: 'Quilt leadership sync', time: '2026-11-07T15:00:00Z' } },
    } })
    const s = h.ta.summary()
    expect(s).toContain('Needs you (1):')
    expect(s).toContain('- COS Glasses - QA review before publish. Waiting for your reply in Personal, 3 h ago. Work card: Speaker Diarization for mac meeting. The session said: "The install is ready. Should I publish?"')
    expect(s).toContain('Running: 1 working, 3 more open and quiet:')
    expect(s).toContain('- Codex: COS Product Work (CODEX), working for 20 min.')
    expect(s).toContain('From today’s meetings: 3 suggestions waiting for a decision')
    expect(s).toContain('- Surcharging Push (2): "Write the KB plan" (Andy Wheeler’s); "Call Megan".')
    expect(s).toContain('- Seasonal Release (1): "Thrift template".')
    expect(s).toContain('Next up: Quilt leadership sync at 9:00 PM tomorrow.')
    expect(s).not.toContain(SID)
    expect(s).not.toContain(ID1)
    expect(s).not.toMatch(/—|->|→/)
  })

  it('never stacks a full stop on a title that already ends one', () => {
    const h = load({ data: { needs: [{ ...NEED, title: 'Speaker Diarization for mac meeting\u2026' }] } })
    expect(h.ta.summary()).toContain('Work card: Speaker Diarization for mac meeting\u2026 The session said')
    expect(h.ta.summary()).not.toContain('\u2026.')
  })

  it('never passes its cap, the left-out marker included, even when the text lands right at the edge', () => {
    const max = load().ta.summaryMax as number
    expect(max).toBe(4000)
    let nearest = 0, marked = 0
    // Suggestion lengths that walk the last line across the cap: some land within the marker's 34 characters of it.
    for (let len = 40; len <= 140; len++) {
      const items = Array.from({ length: 48 }, (_, i) => ITEM('wi_' + String(i).padStart(32, '0'), ('word '.repeat(40)).slice(0, len) + i, { meeting: MEETING('Meeting ' + (i % 12)) }))
      const out = load({ data: { intake: items, needs: [NEED] } }).ta.summary() as string
      expect(out.length, 'suggestions of ' + len + ' characters').toBeLessThanOrEqual(max)
      if (out.endsWith('[More is on Today than fits here.]')) { marked++; nearest = Math.max(nearest, out.length) }
    }
    expect(marked, 'the fixture really overflows').toBeGreaterThan(20)
    expect(nearest, 'and some run ends within the marker\u2019s length of the cap').toBeGreaterThan(max - 34)
  })

  it('stays under its bound however much Today holds, and is empty before Today has loaded', () => {
    const many = Array.from({ length: 300 }, (_, i) => ITEM('wi_' + String(i).padStart(32, '0'), 'A long suggestion '.repeat(20), { meeting: MEETING('Meeting ' + (i % 40)) }))
    const h = load({ data: { intake: many, needs: Array.from({ length: 40 }, () => NEED) } })
    expect(h.ta.summary().length).toBeLessThanOrEqual(h.ta.summaryMax)
    expect(load({ data: { at: 0 } }).ta.summary()).toBe('')
  })
})

// ── the Ask carries it (app.js askCos and panes/cos-chat.js) ─────────────
function askCos(pane: string, chat: unknown) {
  const start = APP.indexOf('  var TODAY_REFERENCE'), end = APP.indexOf('  // ── Usage ──')
  expect(start).toBeGreaterThan(0)
  const posts: any[] = [], ensured: string[] = []
  const deps = {
    state: { pane }, PANES: {}, toast: () => {}, setStatus: () => {}, webJobId: () => '11111111-2222-4333-8444-555555555555',
    ensurePane: (n: string) => { ensured.push(n); return Promise.resolve({ summary: () => 'Needs you (1): QA review.' }) },
    api: (path: string, o: { body: unknown }) => { posts.push({ path, body: o.body }); return Promise.resolve({}) },
    window: { COSWeb: { cosChat: chat } }, setTimeout: () => 0,
  }
  // eslint-disable-next-line no-new-func
  if (start < 0 || end < 0 || end < start) throw new Error('askCos markers moved in app.js')
  const fn = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn askCos;\n}')(deps)
  return { fn, posts, ensured }
}
describe('Ask from Today carries the summary as the Ask’s reference', () => {
  it('askCos on Today sends it; on any other pane it sends nothing extra and loads nothing', async () => {
    const t = askCos('today', null)
    await t.fn('What first?', null)
    expect(t.posts[0].body.reference).toEqual({ query: 'What Today in COS Control shows right now', response: 'Needs you (1): QA review.' })
    expect(t.ensured).toEqual(['todayActions'])
    const w = askCos('work', null)
    await w.fn('What first?', null)
    expect(w.posts[0].body).not.toHaveProperty('reference')
    expect(w.ensured).toEqual([])
    const seen: unknown[] = []
    const c = askCos('today', { askFromSheet: (q: string, extra: unknown) => { seen.push([q, extra]); return Promise.resolve(['cos']) } })
    await c.fn('Help me sort', null)
    expect(seen).toEqual([['Help me sort', { context: 'Needs you (1): QA review.' }]])
  })

  function chat(answers: Record<string, unknown>) {
    const calls: Array<{ path: string; body: any }> = []
    const W: Record<string, unknown> = {
      $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
      toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {}, parseRoute: () => ({ pane: 'today', args: [] }), go: () => {},
      api: (path: string, o?: { body?: unknown }) => { calls.push({ path, body: o?.body }); return Promise.resolve(answers[path] ?? {}) },
    }
    const document = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => ({ value: '', focus() {} }), activeElement: null, hidden: false,
      body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
    const ctx = vm.createContext({ window: { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } },
      document, setTimeout: () => 0, clearTimeout, console, Date, JSON, Math, Promise, localStorage: { getItem: () => null, setItem: () => {} }, crypto: globalThis.crypto })
    vm.runInContext(CHAT, ctx)
    const c = W.cosChat as any
    c._state.caps = { dropIt: true, jobs: true, steer: false, thread: true, dropFiles: 0 }
    return { c, calls }
  }
  const thread = (next: Record<string, unknown>) => ({ protocol: 1, thread: { id: 't', asks: 2, sessionId: 'sess1' }, next })
  it('the COS chat puts it in the reference, after a carried thread summary, and only on that Ask', async () => {
    const cont = chat({ '/api/cos-thread': thread({ mode: 'continue', sessionId: 'sess1' }), '/api/query-jobs': { job: { jobId: 'j1', sessionId: 'sess1', status: 'queued' } } })
    await cont.c.askFromSheet('What first?', { context: 'Needs you (1).' })
    await flush()
    const job = cont.calls.filter(x => x.path === '/api/query-jobs')[0]!.body
    expect(job.sessionId).toBe('sess1')
    expect(job.reference).toEqual({ query: 'What Today in COS Control shows right now', response: 'Needs you (1).' })
    const fresh = chat({ '/api/cos-thread': thread({ mode: 'fresh', sessionId: null, digest: 'Earlier: you asked x.' }), '/api/query-jobs': { job: { jobId: 'j2', sessionId: 'sess2', status: 'queued' } } })
    await fresh.c.askFromSheet('What first?', { context: 'Needs you (1).' })
    await flush()
    expect(fresh.calls.filter(x => x.path === '/api/query-jobs')[0]!.body.reference).toEqual({
      query: 'Summary carried over from earlier in this COS thread, then what Today in COS Control shows right now', response: 'Earlier: you asked x.\n\nNeeds you (1).' })
    const plain = chat({ '/api/cos-thread': thread({ mode: 'continue', sessionId: 'sess1' }), '/api/query-jobs': { job: { jobId: 'j3', sessionId: 'sess1', status: 'queued' } } })
    await plain.c.askFromSheet('Elsewhere')
    await flush()
    expect(plain.calls.filter(x => x.path === '/api/query-jobs')[0]!.body).not.toHaveProperty('reference')
  })
})

// ── questions.js: the same cards, drawn into the overlay ────────────────
describe('session question cards drawn into the overlay (questions.js mount)', () => {
  it('draws only this session’s cards, answers through the same route and id, and stops drawing once unmounted', async () => {
    const mk = () => ({ hidden: true, innerHTML: '', isConnected: true, listeners: {} as Record<string, (e: unknown) => void>,
      addEventListener(t: string, fn: (e: unknown) => void) { this.listeners[t] = fn }, querySelector: () => null, querySelectorAll: () => [], contains: () => false })
    const host = mk(), mine = mk()
    const posts: Array<{ path: string; body: any }> = []
    let onShell: (() => void) | null = null
    const at = (ms: number) => new Date(Date.now() + ms).toISOString()
    const item = (id: string, sid: string) => ({ id, sessionId: sid, provider: 'claude', kind: 'approval', tool: 'Bash', createdAt: at(-5000), deadlineAt: at(115000), answerable: true, awayHold: false, waitingAtMac: false, approval: { tool: 'Bash', summary: 'npm publish', detail: 'npm publish' } })
    const items = [item('pq_' + 'a'.repeat(24), 'sess-a'), item('pq_' + 'b'.repeat(24), 'sess-b')]
    const W = { esc, toast: () => {}, showAuth: () => {}, onShell: (fn: () => void) => { onShell = fn },
      api: (path: string, o?: { method?: string; body?: unknown }) => {
        if (o?.method === 'POST') { posts.push({ path, body: o.body }); return Promise.resolve({ ok: true }) }
        return Promise.resolve(path === '/api/models' ? { capabilities: { sessionQuestions: { enabled: true, webClient: true } } } : {})
      } }
    const fetch = () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ enabled: true, items }) })
    const document = { getElementById: (id: string) => (id === 'sq-host' ? host : id === 'app-shell' ? { classList: { contains: () => false } } : null), addEventListener: () => {}, hidden: false, activeElement: null }
    const ctx = vm.createContext({ window: { COSWeb: W, addEventListener: () => {} }, document, fetch, console, Date, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
      setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} })
    vm.runInContext(QUESTIONS, ctx)
    onShell!()
    await flush()
    const Qs = (W as any).sessionQuestions
    const changes: number[] = []
    const m = Qs.mount(mine, 'SESS-A', (n: number) => changes.push(n))
    expect(mine.innerHTML).toContain(items[0]!.id)
    expect(mine.innerHTML).not.toContain(items[1]!.id)
    expect(host.innerHTML, 'the page keeps every card').toContain(items[1]!.id)
    expect(m.count()).toBe(1)
    expect(changes).toEqual([1])
    const allow = { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'allow' : a === 'data-sq-id' ? items[0]!.id : null) }) }
    mine.listeners.click!({ target: allow })
    expect(posts).toEqual([])
    mine.listeners.click!({ target: allow })
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.path).toBe(`/api/session-questions/${items[0]!.id}/answer`)
    expect(posts[0]!.body).toMatchObject({ decision: 'allow' })
    expect(posts[0]!.body.clientAnswerId).toMatch(/^gw_[0-9a-f]{24}$/)
    expect(mine.innerHTML, 'answered: it leaves the overlay too').not.toContain(items[0]!.id)
    m.unmount()
    mine.innerHTML = 'kept'
    Qs._take([])
    expect(host.innerHTML, 'the page itself redrew').toBe('')
    expect(mine.innerHTML, 'an unmounted overlay is never drawn into again').toBe('kept')
  })
})

// ── the server already takes it: the query-jobs `reference` field ────────
describe('the server takes the Today summary through the existing reference field (no server change)', () => {
  it('parseQueryJobRequest keeps the reference as built by askCos and the COS chat, under its limits', async () => {
    const { parseQueryJobRequest } = await import('../lib/query-job-types.js')
    const h = load({ data: { intake: Array.from({ length: 300 }, (_, i) => ITEM('wi_' + String(i).padStart(32, '0'), 'A long suggestion '.repeat(20), { meeting: MEETING('Meeting ' + (i % 40)) })), needs: [NEED] } })
    const summary = h.ta.summary()
    const parsed = parseQueryJobRequest({ clientJobId: '11111111-2222-4333-8444-555555555555', generation: 1, query: 'What first?', sessionId: 'sess0042',
      reference: { query: 'What Today in COS Control shows right now', response: summary } })
    expect(parsed.reference).toEqual({ query: 'What Today in COS Control shows right now', response: summary })
  })
})

// ── app.js: the Today card moves the moment a decision lands ─────────────
describe('the Today card (app.js loadTodayIntake, paintTodayIntake, COSWeb.today.markGone)', () => {
  function todayCard(reads: Array<unknown>) {
    const start = APP.indexOf("  // From today's meetings: Work's suggestions"), end = APP.indexOf('  function setBadge(')
    const ts = APP.indexOf('  window.COSWeb.today = {'), te = APP.indexOf('\n  };', ts)
    expect(start).toBeGreaterThan(0); expect(ts).toBeGreaterThan(0)
    const els: Record<string, El> = {}
    const $ = (id: string) => (els[id] ??= new El())
    let n = 0
    const deps = { $, esc, api: () => Promise.resolve(reads[Math.min(n++, reads.length - 1)]), state: { pane: 'today', sessions: [] }, loadToday: () => {},
      needWhy: () => '', sessionTitle: () => '', badge: () => '', span: () => '', splitSessionId: () => ({}), ensurePane: () => Promise.reject(new Error('x')), go: () => {},
      window: { COSWeb: {} as Record<string, any> } }
    // eslint-disable-next-line no-new-func
    new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\n' + APP.slice(ts, te + 4) + '\n; window.COSWeb._load = loadTodayIntake; }')(deps)
    return { els, today: deps.window.COSWeb.today, load: deps.window.COSWeb._load as () => Promise<void> }
  }
  const today = new Date(), day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
  const row = (id: string, title: string) => ({ id, status: 'ask', kind: 'ask', text: 'x', meeting: { title, filename: day + '_m.md' } })
  it('a decision hides its row and drops the count at once; a stale read from before it never brings it back; the next real read ends the hiding', async () => {
    const both = { items: [row(ID1, 'Surcharging Push'), row(ID2, 'Surcharging Push')], capabilities: { cardCreation: true } }
    const after = { items: [row(ID2, 'Surcharging Push')], capabilities: { cardCreation: true } }
    const h = todayCard([both, both, after, both])
    await h.load()
    expect(h.els['intake-count']!.textContent).toBe('2')
    expect(h.els['intake-body']!.innerHTML).toContain('data-today="meeting" data-key="Surcharging Push"')
    h.today.markGone(ID1, true)
    expect(h.els['intake-count']!.textContent, 'at once, before any read').toBe('1')
    await h.load()   // a read that left before the decision landed still lists it
    expect(h.els['intake-count']!.textContent).toBe('1')
    await h.load()
    expect(h.els['intake-count']!.textContent).toBe('1')
    expect(h.today.data().intake.map((x: { id: string }) => x.id)).toEqual([ID2])
    await h.load()   // undone on the Mac: once a read has dropped it, a later read that lists it shows it again
    expect(h.els['intake-count']!.textContent).toBe('2')
    h.today.markGone(ID1, true)
    h.today.markGone(ID2, true)
    expect(h.els['intake-card']!.cls.has('hidden'), 'the card leaves when nothing is left').toBe(true)
  })
})

// ── QA round 2 (6.99.25) ───────────────────────────────────────────────
describe('the overlay’s refusal words are Work’s own', () => {
  it('REFUSALS in today-actions.js equals INTAKE_REFUSALS in work.js, code for code and word for word', () => {
    const pick = (src: string, name: string) => {
      const i = src.indexOf('var ' + name + ' = {'), open = src.indexOf('{', i), close = src.indexOf('};', open)
      expect(i, name).toBeGreaterThan(0)
      // eslint-disable-next-line no-new-func
      return new Function('return ' + src.slice(open, close + 1))() as Record<string, string>
    }
    expect(pick(TA, 'REFUSALS')).toEqual(pick(WORK, 'INTAKE_REFUSALS'))
  })
})

describe('a bug while opening never leaves a half-drawn overlay', () => {
  it('open() that throws takes the sheet down, frees the page, keeps its history entry for the fallback to replace, and rethrows', () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    ;(h.ctx as any).window.COSWeb.today.data = () => { throw new Error('boom') }
    expect(() => h.ta.open('meeting', 'Surcharging Push', h.opener())).toThrow('boom')
    expect(h.ta.isOpen()).toBe(false)
    expect(h.document.appended.hidden).toBe(true)
    expect(h.els['app-shell']!.hasAttribute('inert')).toBe(false)
    expect(h.document.documentElement.cls.has('ta-open')).toBe(false)
    expect(h.history.backs, 'no back(): it would race the fallback navigation').toBe(0)
    expect((h.history.state as any).cosTodayOverlay).toBe(1)
  })
})

describe('a reload with the overlay open', () => {
  it('opens the same thing again on its own entry, so the first Back closes it', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One')] } })
    const entry = { cosTodayOverlay: 1, kind: 'meeting', key: 'Surcharging Push' }
    h.history.state = entry
    expect(await h.ta.restore(entry)).toBe(true)
    expect(h.ta.isOpen()).toBe(true)
    expect(h.els['ta-title']!.textContent).toBe('Surcharging Push')
    expect(h.history.pushes, 'no second entry').toBe(0)
    h.pop()
    expect(h.ta.isOpen(), 'Back closes it').toBe(false)
    expect(h.history.backs).toBe(0)
  })

  it('waits for Today to load before opening, and pushes nothing', async () => {
    const h = load({ data: { at: 0, intake: [ITEM(ID1, 'One')] } })
    const done = h.ta.restore({ cosTodayOverlay: 1, kind: 'meeting', key: 'Surcharging Push' })
    h.runTimers()
    expect(h.ta.isOpen()).toBe(false)
    h.data.at = 5
    h.runTimers()
    expect(await done).toBe(true)
    expect(h.ta.isOpen()).toBe(true)
    expect(h.history.pushes).toBe(0)
  })

  it('an entry it cannot reopen, or a reload that left Today, only loses its mark', async () => {
    const bad = load()
    expect(await bad.ta.restore({ cosTodayOverlay: 1, kind: 'nonsense' })).toBe(false)
    expect(bad.history.state).toBeNull()
    expect(bad.ta.isOpen()).toBe(false)
    const away = load({ data: { intake: [ITEM(ID1, 'One')] } })
    ;(away.location as any).pane = 'work'
    expect(await away.ta.restore({ cosTodayOverlay: 1, kind: 'meeting', key: 'Surcharging Push' })).toBe(false)
    expect(away.ta.isOpen()).toBe(false)
    expect(away.history.replaces).toBe(1)
  })
})

// app.js: openTodayAction and loadTodayIntake, run from the Today region of app.js.
function todayRegion(over: Record<string, unknown> = {}) {
  const start = APP.indexOf("  // From today's meetings: Work's suggestions"), end = APP.indexOf('  function setBadge(')
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const seen = { toasts: [] as string[], errors: [] as unknown[][], gone: [] as Array<[string, string[]]>, replaced: [] as string[] }
  const els: Record<string, El> = {}
  const deps: Record<string, unknown> = {
    $: (id: string) => (els[id] ??= new El()), esc, api: () => Promise.resolve({}), state: { pane: 'today', sessions: [] }, loadToday: () => {},
    toast: (t: string) => seen.toasts.push(t), go: (p: string, a: string[]) => seen.gone.push([p, a]),
    console: { error: (...a: unknown[]) => seen.errors.push(a) },
    history: { state: null }, location: { replace: (h: string) => seen.replaced.push(h) },
    ensurePane: () => Promise.reject(new Error('unset')), ...over,
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { openTodayAction: openTodayAction };\n}')(deps)
  const tap = (attrs: Record<string, string>) => fns.openTodayAction({ getAttribute: (n: string) => attrs[n] ?? null })
  return { tap, seen, deps }
}
describe('a Today tap whose overlay fails says so, logs it, and goes where it went before', () => {
  it('a load failure: a toast, a console error with the cause, then Sort in Work', async () => {
    const cause = new Error('Could not load the todayActions section.')
    const t = todayRegion({ ensurePane: () => Promise.reject(cause) })
    t.tap({ 'data-today': 'meeting', 'data-key': 'Surcharging Push' })
    await flush()
    expect(t.seen.toasts).toEqual(['Could not open that here. Opening it in Work.'])
    expect(t.seen.errors).toHaveLength(1)
    expect(t.seen.errors[0]![1]).toBe(cause)
    expect(t.seen.gone).toEqual([['work', ['sort']]])
  })

  it('an exception inside open(): the same toast and log; the half-open overlay’s entry is replaced, not stacked', async () => {
    const boom = new Error('open broke')
    const t = todayRegion({ ensurePane: () => Promise.resolve({ open: () => { throw boom } }), history: { state: { cosTodayOverlay: 1 } } })
    t.tap({ 'data-today': 'run', 'data-key': 'claude|abc-123' })
    await flush()
    expect(t.seen.toasts).toEqual(['Could not open that here. Opening the session.'])
    expect(t.seen.errors[0]![1]).toBe(boom)
    expect(t.seen.replaced).toEqual(['#/sessions/claude/abc-123'])
    expect(t.seen.gone).toEqual([])
  })

  it('a pane that never registered falls back too; a working overlay shows no toast and logs nothing', async () => {
    const t = todayRegion({ ensurePane: () => Promise.resolve(null) })
    t.tap({ 'data-today': 'need', 'data-key': 'act-1', 'data-session-key': 'codex|thr-9' })
    await flush()
    expect(t.seen.gone).toEqual([['sessions', ['codex', 'thr-9']]])
    expect(t.seen.toasts).toHaveLength(1)
    const opened: unknown[] = []
    const ok = todayRegion({ ensurePane: () => Promise.resolve({ open: (...a: unknown[]) => opened.push(a) }) })
    ok.tap({ 'data-today': 'intake' })
    await flush()
    expect(opened).toHaveLength(1)
    expect(ok.seen.toasts).toEqual([])
    expect(ok.seen.errors).toEqual([])
  })
})

describe('Ask from Today never fails because of the summary', () => {
  it('a summary that throws: the Ask goes without it, and the console says why', async () => {
    const start = APP.indexOf('  var TODAY_REFERENCE'), end = APP.indexOf('  // ── Usage ──')
    if (start < 0 || end < 0 || end < start) throw new Error('askCos markers moved in app.js')
    const posts: any[] = [], errors: unknown[][] = []
    const deps = { state: { pane: 'today' }, PANES: {}, toast: () => {}, setStatus: () => {}, webJobId: () => '11111111-2222-4333-8444-555555555555',
      ensurePane: () => Promise.resolve({ summary: () => { throw new Error('summary broke') } }),
      api: (path: string, o: { body: unknown }) => { posts.push({ path, body: o.body }); return Promise.resolve({}) },
      window: { COSWeb: { cosChat: null } }, setTimeout: () => 0, console: { error: (...a: unknown[]) => errors.push(a) } }
    // eslint-disable-next-line no-new-func
    const askCos = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn askCos;\n}')(deps)
    await askCos('What first?', null)
    expect(posts).toHaveLength(1)
    expect(posts[0].body.query).toBe('What first?')
    expect(posts[0].body).not.toHaveProperty('reference')
    expect(String(errors[0]![0])).toContain('Today summary failed')
  })
})

// panes/work.js in a vm: Today's Create task, then its Open card.
function workPane(boards: unknown[]) {
  const defs: Record<string, any> = {}
  const calls: string[] = []
  let route = { pane: 'work', args: [] as string[] }
  let reads = 0
  const pane: any = { html: '', get innerHTML() { return this.html }, set innerHTML(v: string) { this.html = v },
    querySelector: (sel: string) => (sel === '.wk' && /class="cx wk"/.test(pane.html) ? {} : null), querySelectorAll: () => [], addEventListener() {}, contains: () => false }
  const W: Record<string, unknown> = {
    $: (id: string) => (id === 'pane-work' ? pane : null), esc, md: (x: unknown) => esc(x), plain: (x: unknown) => String(x), toast: () => {},
    skeletonRows: () => '<div class="skel"></div>', toDate: (v: unknown) => (v ? new Date(String(v)) : null), readStore: () => ({}), writeStore: () => {},
    registerPane: (n: string, d: unknown) => { defs[n] = d }, parseRoute: () => route, go: () => {}, goBack: () => {}, setCrumb: () => {},
    copyText: () => Promise.resolve(), domainLabel: (d: string) => d, sessionList: () => Promise.resolve({ sessions: [] }), isPhone: () => false,
    api: (path: string) => {
      calls.push(path)
      if (path === '/api/work-board') return Promise.resolve(boards[Math.min(reads++, boards.length - 1)])
      if (path === '/api/work-intake') return Promise.resolve({ items: [], capabilities: {} })
      if (path === '/api/work-board/activity/open') return Promise.resolve({ items: [], available: true })
      if (path === '/api/domains') return Promise.resolve({ domains: [] })
      return Promise.resolve({})
    },
  }
  const document = { addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null, hidden: false }
  const window = { COSWeb: W, matchMedia: () => ({ matches: true, addEventListener() {} }), scrollTo: () => {}, scrollBy: () => {}, scrollY: 0, innerHeight: 800,
    addEventListener: () => {}, navigator: { platform: 'MacIntel', userAgent: 'test' } }
  const ctx = vm.createContext({ window, document, navigator: window.navigator, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    console, Date, JSON, Math, Promise, Array, Object, String, Number, Set, Map, Error, RegExp, isNaN, encodeURIComponent, decodeURIComponent, crypto: globalThis.crypto,
    CSS: { escape: (x: string) => x }, location: { replace: () => {} } })
  vm.runInContext(WORK, ctx)
  return { def: defs.work, pane, calls, boardReads: () => reads, go: (args: string[]) => { route = { pane: 'work', args }; defs.work.load(args) } }
}
describe('Work after a decision on Today (work.js intakeChanged)', () => {
  const A = { id: 'aaaaaaaaaaaa', workIdentity: 'aaaaaaaaaaaa', domain: 'quilt', text: 'An older card', workStage: 'planned', workRevision: 'f'.repeat(64), meetingRefs: [] }
  const B = { id: 'bbbbbbbbbbbb', workIdentity: 'bbbbbbbbbbbb', domain: 'quilt', text: 'Write the KB plan', workStage: 'mentioned', workRevision: 'e'.repeat(64), meetingRefs: [] }
  it('Open card straight after Create task reads the board again and shows the new card, not "not currently available"', async () => {
    const w = workPane([{ tasks: [A], capabilities: {}, complete: true }, { tasks: [A, B], capabilities: {}, complete: true }])
    w.go([])
    await flush()
    expect(w.boardReads()).toBe(1)
    w.def.intakeChanged()            // Today's Create task landed
    w.go([B.workIdentity])           // Today's Open card
    await flush()
    expect(w.boardReads(), 'the card route read the board again').toBe(2)
    expect(w.calls.filter(c => c === '/api/work-intake').length, 'and Intake after it').toBeGreaterThanOrEqual(1)
    expect(w.pane.html).toContain('Write the KB plan')
    expect(w.pane.html).not.toContain('This work is not currently available')
  })
  it('without a decision on Today the card route keeps the board it has', async () => {
    const w = workPane([{ tasks: [A], capabilities: {}, complete: true }])
    w.go([])
    await flush()
    w.go([A.workIdentity])
    await flush()
    expect(w.boardReads()).toBe(1)
  })
})

// app.js route(): a lazy pane whose wait ran out but which still finishes loading.
function routeRegion() {
  const start = APP.indexOf('  var lazyList = null;'), end = APP.indexOf('  function runHooks(')
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const timers: Array<{ fn: () => void; ms: number }> = []
  const scripts: any[] = []
  const mk = () => { const n: any = { cls: new Set<string>(), attrs: {} as Record<string, string>, waits: [] as any[], textContent: '' }
    n.classList = { toggle: () => {}, remove: () => {}, add: () => {} }
    n.getAttribute = (k: string) => n.attrs[k] ?? null; n.setAttribute = (k: string, v: string) => { n.attrs[k] = v }
    n.querySelector = (sel: string) => (sel === '.lazy-wait' ? n.waits[0] ?? null : null)
    n.querySelectorAll = (sel: string) => (sel === '.lazy-wait' ? n.waits.slice() : [])
    n.insertAdjacentHTML = (_p: string, html: string) => { const w = { html, remove: () => { n.waits = n.waits.filter((x: unknown) => x !== w) } }; n.waits.unshift(w) }
    return n }
  const els: Record<string, any> = {}
  const PANES: Record<string, any> = {}
  const deps: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'lazy-panes' ? { textContent: JSON.stringify({ work: '/control/panes/work.js' }) } : null),
      createElement: () => { const s: any = {}; scripts.push(s); s.remove = () => {}; return s }, body: { appendChild: () => {} },
      querySelector: () => null, querySelectorAll: () => [] },
    $: (id: string) => (els[id] ??= mk()), state: { pane: 'today', lastLoad: {}, sessions: [] }, PANES, TITLES: { work: 'Work', today: 'Today' }, ROOT_PANES: ['today', 'work'],
    closeMenu: () => {}, onScroll: () => {}, skeletonRows: () => '<i>loading</i>', esc, runHooks: () => {}, loadToday: () => {},
    // route() releases reader output images on every navigation (readerMedia merge, 6.99.28).
    readerImagesStop: () => {},
    location: { hash: '#/work' }, window: { scrollTo: () => {} }, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: () => {},
    console,
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { route: route };\n}')(deps)
  return { fns, timers, scripts, els, PANES }
}
describe('a lazy pane that loads after its 15 s wait ran out clears its own error card (app.js route)', () => {
  it('the card says it is taking too long; when the script finally loads, the card goes and the pane loads', async () => {
    const r = routeRegion()
    r.fns.route()
    expect(r.scripts).toHaveLength(1)
    r.timers.find(t => t.ms === 15000)!.fn()
    await flush()
    expect(r.els['pane-work'].waits[0].html).toContain('taking too long')
    const loads: unknown[] = []
    r.PANES.work = { load: (...a: unknown[]) => loads.push(a) }
    r.scripts[0].onload()
    await flush()
    expect(r.els['pane-work'].waits, 'the error card cleared itself').toEqual([])
    expect(r.els['pane-work'].attrs['data-lazy-ready']).toBe('1')
    expect(loads).toEqual([[[], { changed: true }]])
  })
  it('a script that fails after the wait leaves the card and its Try again alone', async () => {
    const r = routeRegion()
    r.fns.route()
    r.timers.find(t => t.ms === 15000)!.fn()
    await flush()
    r.scripts[0].onerror()
    await flush()
    expect(r.els['pane-work'].waits).toHaveLength(1)
    expect(r.els['pane-work'].waits[0].html).toContain('Try again')
  })
})

describe('the page hands a reloaded overlay entry to the overlay (app.js showShell)', () => {
  function shell(state: unknown, ensure: (n: string) => Promise<unknown>) {
    const start = APP.indexOf('  function showShell(info) {'), end = APP.indexOf('\n  }\n', start)
    expect(start).toBeGreaterThan(0)
    const seen = { ensured: [] as string[], replaced: [] as unknown[] }
    const el = () => ({ classList: { add() {}, remove() {} }, textContent: '' })
    const deps = { $: () => el(), state: {}, loadTailnetUrl: () => {}, runHooks: () => {}, shellHooks: [], route: () => {}, setTimeout: () => 0, prefetchPanes: () => {},
      ensurePane: (n: string) => { seen.ensured.push(n); return ensure(n) },
      history: { state, replaceState: (s: unknown) => seen.replaced.push(s) } }
    // eslint-disable-next-line no-new-func
    new Function('deps', 'with (deps) {\n' + APP.slice(start, end + 4) + '\nshowShell({});\n}')(deps)
    return seen
  }
  it('reopens it through restore(); a page without the overlay loads nothing extra; a failed load only clears the mark', async () => {
    const entry = { cosTodayOverlay: 1, kind: 'run', key: 'claude|x' }
    const got: unknown[] = []
    const a = shell(entry, () => Promise.resolve({ restore: (s: unknown) => got.push(s) }))
    await flush()
    expect(a.ensured).toEqual(['todayActions'])
    expect(got).toEqual([entry])
    const b = shell(null, () => Promise.resolve({}))
    await flush()
    expect(b.ensured).toEqual([])
    const c = shell(entry, () => Promise.reject(new Error('offline')))
    await flush()
    expect(c.replaced).toEqual([null])
  })
})

// ── qa2-user B1 and W1: a double tap that opened the sheet ─────────────
describe('a quick second tap after opening lands on nothing (qa2-user B1, W1)', () => {
  it('taps inside the sheet are dropped until the open animation has settled, then count', async () => {
    const t0 = Date.parse('2026-11-07T06:00:00.000Z'), realNow = Date.now
    const h = load({ data: { intake: [ITEM(ID1, 'Never read')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss'), '/api/work-intake/decisions': codeError('', 404) } })
    try {
      ;(h.ctx as any).Date.now = () => t0
      h.ta.open('meeting', 'Surcharging Push', h.opener())
      const settle = h.ta._state.settleAt - t0
      expect(settle, 'the CSS default (220 ms) and a double tap\u2019s second half').toBe(500)
      ;(h.ctx as any).Date.now = () => t0 + 100   // the second tap of a double tap, 100 ms later
      expect(h.layerTap('dismiss', ID1)).toBe(false)
      expect(h.layerTap('dismiss', ID1)).toBe(false)
      expect(h.layerTap('open-work')).toBe(false)
      expect(h.layerTap('close')).toBe(false)
      expect(h.ta.isOpen()).toBe(true)
      expect(h.location.replaced, 'never left Today').toEqual([])
      ;(h.ctx as any).Date.now = () => t0 + 417   // W1-r2: the folded Duo's slow second tap
      expect(h.layerTap('open-work')).toBe(false)
      expect(h.layerTap('dismiss', ID1)).toBe(false)
      ;(h.ctx as any).Date.now = () => t0 + 520
      expect(h.layerTap('dismiss', ID1)).toBe(true)
    } finally { (h.ctx as any).Date.now = realNow }
    await flush()
    expect(h.posts, 'a single tap after settling only arms Dismiss').toEqual([])
    expect(h.els['ta-body']!.innerHTML).toContain('Tap again to dismiss')
  })

  it('with no Undo on the server, Dismiss takes a second tap; another tap in between disarms it', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One'), ITEM(ID2, 'Two')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss'), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    await flush()
    h.tap('dismiss', ID1)
    expect(h.posts).toEqual([])
    expect(h.els['ta-body']!.innerHTML).toContain('aria-label="Tap again to dismiss: One"')
    h.tap('show-all')                     // anything else disarms it
    expect(h.els['ta-body']!.innerHTML).not.toContain('Tap again to dismiss')
    h.tap('dismiss', ID2); h.later(450); h.tap('dismiss', ID1)   // arming one row never confirms another
    expect(h.posts).toEqual([])
    h.tap('dismiss', ID1)   // a bounce right after arming: still only armed
    expect(h.posts).toEqual([])
    h.later(450)
    h.tap('dismiss', ID1)
    await flush()
    expect(h.posts).toEqual([{ path: `/api/work-intake/${ID1}/resolve`, body: { action: 'dismiss' } }])
  })

  it('a refused decision gives the meeting its count back (qa2-user N4)', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'One'), ITEM(ID2, 'Two')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: codeError('task_bridge_unavailable', 503), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    expect(h.els['ta-body']!.innerHTML).toContain('2 from this meeting')
    h.tap('create', ID1)
    await flush()
    expect(h.els['ta-body']!.innerHTML).toContain('The task bridge didn’t answer.')
    expect(h.els['ta-body']!.innerHTML).toContain('2 from this meeting')
  })
})

describe('a reply keeps its words and its key across close and reopen (skeptic W3, qa2-user N1)', () => {
  it('a lost answer, the overlay closed and reopened: the box still has the words, and Send uses the same key', async () => {
    const webStore = new Map<string, string>(), store = new Map<string, string>()
    let turnPosts = 0   // counted across both pages: the first answer is lost, the next one lands
    const routes: Routes = { ...OK_ROUTES, ['POST /api/agent-sessions/bindings/b1/turns']: () => (++turnPosts === 1 ? new TypeError('Load failed') : { status: 202, body: { outcome: 'queued' } }) }
    const first = load({ data: { needs: [NEED] }, routes, webStore, store, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    first.ta.open('need', 'act-1', first.opener())
    await flush()
    first.els['ta-input']!.value = 'Ship it'
    first.tap('send')
    await flush()
    const key1 = first.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')[0]!.body.clientTurnId
    first.tap('close')
    // A new page (a reload) on the same browser storage, with the same routes still answering.
    const again = load({ data: { needs: [NEED] }, routes, webStore, store, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    again.ta.open('need', 'act-1', again.opener())
    await flush()
    expect(again.els['ta-input']!.value).toBe('Ship it')
    again.tap('send')
    await flush()
    const resent = again.calls.filter(c => c.path === '/api/agent-sessions/bindings/b1/turns')
    expect(resent).toHaveLength(1)
    expect(resent[0]!.body.clientTurnId, 'the same key, so it cannot post twice').toBe(key1)
    expect(again.els['ta-input']!.value).toBe('')
    expect(JSON.parse(webStore.get('cos.web.today.drafts')!)['claude|' + SID], 'settled: nothing kept').toBeUndefined()
  })

  it('typed words alone come back after a close; a different session has its own', async () => {
    const webStore = new Map<string, string>()
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, webStore, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Half a thought'
    ;(h.document.appended.listeners.input as Array<(e: unknown) => void>)[0]!({ target: h.els['ta-input'] })
    h.key('Escape')
    h.els['ta-input']!.value = ''
    h.ta.open('need', 'act-1', h.opener())
    expect(h.els['ta-input']!.value).toBe('Half a thought')
    const stored = JSON.parse(webStore.get('cos.web.today.drafts')!)
    expect(Object.keys(stored)).toEqual(['claude|' + SID])
    expect(stored['claude|' + SID].unsettled).toBeNull()
  })
})

describe('the sheet never contradicts itself (qa2-user N3)', () => {
  it('a stale Need says only that it is gone, and Today drops the row', async () => {
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('This is no longer waiting on you.')
    expect(meta).not.toContain('Waiting for your reply')
    expect(h.refreshed(), 'Today reads again, so the row goes').toBe(1)
  })

  it('the Running header follows the live feed, and an unknown tool reads as "Used <tool>"', async () => {
    const CID = '019a0000-1111-2222-3333-444455556666'
    const ROW = { session_id: CID, provider: 'codex', display_label: 'Codex work', running: true, running_active: true, agent_state: 'running', state_source: 'hook' }
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: { [`GET /api/agent-sessions/codex/${CID}?turns=6&cards=1`]: { status: 200, body: { recent_turns: [] } } } })
    h.ta.open('run', 'codex|' + CID, h.opener())
    await flush()
    expect(h.els['ta-run-state']!.textContent, 'before the feed: the session list').toBe('Working now, for 20 min')
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_since: new Date(Date.now() - 42000).toISOString() }) })
    es.onmessage({ data: JSON.stringify({ seq: 2, kind: 'tool', verb: 'other', target: 'SendMessage' }) })
    expect(h.els['ta-run-state']!.textContent).toMatch(/^Idle for 4\ds$/)
    expect(h.els['ta-live']!.innerHTML).toContain('<strong>Idle</strong>')
    expect(h.els['ta-live']!.innerHTML).toContain('Used SendMessage')
    expect(h.els['ta-live']!.innerHTML).not.toContain('Other SendMessage')
  })
})

// ── Parity B2: Needs you counts every source, and says what it could not read ──
function needsRegion(opts: { at: string; sessions?: unknown[]; needs?: unknown[]; voices?: { state: string; groups: unknown[] }; memories?: { state: string; n: number };
  sessionsState?: string; workState?: string; qs?: unknown }) {
  const start = APP.indexOf("  // The headline: COS Control's brief"), end = APP.indexOf('  function renderNext(w) {')
  expect(start, 'the headline block').toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
  const helpers = ['countWord', 'plural', 'ago', 'dayWord', 'splitSessionId', 'domainLabel'].map(n => {
    const m = new RegExp('  function ' + n + '\\(').exec(APP)!
    const i = m.index, j = APP.indexOf('\n  function ', i + 5)
    return APP.slice(i, j)
  }).join('\n')
  const words = /  var WORDS = [^\n]*\n/.exec(APP)![0], domains = /  var DOMAINS = [^\n]*\n/.exec(APP)![0]
  const els: Record<string, El> = {}
  const t = Date.parse(opts.at)
  class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(t) } static now() { return t } }
  const rail: Array<[string, string, boolean]> = [], badges: Array<[string, boolean]> = []
  const TODAY = { needs: opts.needs ?? [], working: [], open: [], welcome: {}, offline: false, at: 1, recording: false, model: null, showAllNeeds: false, showLater: false,
    sessionsState: opts.sessionsState ?? 'answered', workState: opts.workState ?? 'answered',
    voices: opts.voices ?? { state: 'answered', groups: [] }, memories: opts.memories ?? { state: 'answered', n: 0 } }
  const deps: Record<string, unknown> = {
    $: (id: string) => (els[id] ??= new El()), esc, toDate: (v: unknown) => (v ? new FakeDate(String(v)) : null), clock: () => '9:00 AM', Date: FakeDate,
    state: { sessions: opts.sessions ?? [], serverName: 'Mac' }, TODAY, setBadge: (n: string, on: boolean) => badges.push([n, on]),
    usualProject: () => '', badge: () => '', span: () => '5 min', sessionTitle: (s: any) => s.display_label || 'Session',
    window: { COSWeb: { setStory: (n: string, text: string, hot: boolean) => rail.push([n, text, hot]), ...(opts.qs ? { sessionQuestions: opts.qs } : {}) } },
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + words + domains + plainFn + '\n' + helpers + '\n' + sx + '\n' + APP.slice(start, end) + '\npaintNeeds();\nreturn { renderRunning: renderRunning, needsModel: needsModel };\n}')(deps)
  return { els, rail, badges, TODAY: TODAY as any, fns }
}
const WAIT = { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', provider: 'claude', display_label: 'Release QA', alive: true, running: true,
  agent_state: 'waiting', state_source: 'hook', waiting_kind: 'permission', waiting_detail: 'Bash npm publish', state_since: '2026-11-04T19:00:00Z' }
const HANDOFF = (id: string, sid: string) => ({ id, provider: 'claude', sessionId: 'claude:' + sid, sessionTitle: 'Handoff ' + id, domain: 'quilt', progress: { reported: 'needsInput' }, updatedAt: '2026-11-04T18:00:00Z' })
const WED_2PM = '2026-11-04T20:00:00Z'   // 2 PM Central on a Wednesday; the fake clock reads this instant
describe('Needs you lists every source, and the headline, count and rail agree (parity B2)', () => {
  it('a waiting session, a Work handoff, voices and memories each show; a handoff for the waiting session is that session’s row', () => {
    const n = needsRegion({ at: WED_2PM, sessions: [WAIT], needs: [HANDOFF('h1', 'bbbbbbbb-2222-4222-8222-222222222222'), HANDOFF('h2', WAIT.session_id)],
      voices: { state: 'answered', groups: [{ id: 'g1', suggestion: { name: 'Gina' } }, { id: 'g2' }] }, memories: { state: 'answered', n: 3 } })
    const list = n.els['needs-list']!.innerHTML
    expect(list).toContain('Release QA wants your permission')
    expect(list).toContain('Wants to run Bash npm publish')
    expect(list).toContain('data-today="wait" data-key="claude|' + WAIT.session_id + '"')
    expect(list).toContain('Handoff h1')
    expect(list, 'deduped into the session row').not.toContain('Handoff h2')
    expect(list).toContain('Name 2 held voices')
    expect(list).toContain('One sounds like Gina.')
    expect(list).toContain('data-goto="speakers"')
    expect(list).toContain('Review 3 memories')
    expect(list).toContain('data-goto="memories/view/review"')
    expect(n.els['needs-count']!.textContent).toBe('4')
    expect(n.els['today-story']!.textContent).toMatch(/^One session is waiting on you\. No agents are running\.$/)
    expect(n.rail).toEqual([['today', '4 need you', true]])
    expect(n.badges).toContainEqual(['today', true])
  })

  it('a bare tool name is never the reason line (Control\u2019s tool-name guard)', () => {
    const asking = { ...WAIT, waiting_kind: 'question', waiting_detail: 'AskUserQuestion', display_label: 'Gong personas' }
    const n = needsRegion({ at: WED_2PM, sessions: [asking] })
    expect(n.els['needs-list']!.innerHTML).toContain('Gong personas asked you a question')
    expect(n.els['needs-list']!.innerHTML).not.toContain('AskUserQuestion')
    expect(n.els['needs-list']!.innerHTML).toContain('Waiting for your answer')
  })

  it('a waiting session with no title reads "A session", never its folder or id (Control\u2019s TodayHome)', () => {
    const bare = { ...WAIT, waiting_kind: 'question', display_label: '', custom_title: '', project: '-Users-ukaoma-Documents-GitHub-secret-project' }
    const n = needsRegion({ at: WED_2PM, sessions: [bare] })
    const list = n.els['needs-list']!.innerHTML
    expect(list).toContain('A session asked you a question')
    expect(list).not.toContain('secret-project')
    // Ids may sit in data- attributes (Open session needs them); never in the words.
    expect(list.replace(/ data-[a-z-]+="[^"]*"/g, '')).not.toContain(WAIT.session_id)
  })

  it('never says clear while a source failed: it names it, with Try again', () => {
    const n = needsRegion({ at: WED_2PM, memories: { state: 'failed', n: 0 } })
    expect(n.els['needs-list']!.innerHTML).not.toContain('Nothing is waiting')
    expect(n.els['needs-list']!.innerHTML).toContain('Couldn’t read memories. Try again')
    expect(n.els['today-story']!.textContent).toContain('Couldn’t read memories, so this may not be everything.')
    expect(n.els['today-story']!.textContent).not.toContain('Nothing is waiting')
    expect(n.rail[0]![1]).toBe('Couldn’t read memories')
  })

  it('6.99.30 design QA: every source unread is one row, "Your Mac is not answering", with no empty line above it; two are one row naming both', () => {
    const all = needsRegion({ at: WED_2PM, sessionsState: 'failed', workState: 'failed', voices: { state: 'failed', groups: [] }, memories: { state: 'failed', n: 0 } })
    const html = all.els['needs-list']!.innerHTML
    expect(html.match(/need-failed/g) || [], 'one retry row').toHaveLength(1)
    expect(html).toContain('data-today-needs="retry">Your Mac is not answering. Try again.</button>')
    expect(html, 'no empty line above it (the 45 px gap)').not.toContain('card-empty')
    expect(html).not.toContain('Couldn’t read')
    const two = needsRegion({ at: WED_2PM, voices: { state: 'failed', groups: [] }, memories: { state: 'failed', n: 0 } })
    expect(two.els['needs-list']!.innerHTML.match(/need-failed/g) || []).toHaveLength(1)
    expect(two.els['needs-list']!.innerHTML).toContain('Couldn’t read voices and memories. Try again')
  })

  it('while a source is still reading it says so; once every source answered empty, and only then, Nothing is waiting on you', () => {
    const reading = needsRegion({ at: WED_2PM, voices: { state: 'pending', groups: [] } })
    expect(reading.els['needs-list']!.innerHTML).toContain('Reading sessions, Work, voices and memories.')
    expect(reading.els['today-story']!.textContent).toContain('Still reading what needs you.')
    expect(reading.els['today-story']!.textContent).not.toContain('Nothing is waiting')
    const work = needsRegion({ at: WED_2PM, workState: 'failed' })
    expect(work.els['needs-list']!.innerHTML).toContain('Couldn’t read Work. Try again')
    const clear = needsRegion({ at: WED_2PM })
    expect(clear.els['needs-list']!.innerHTML).toContain('Nothing is waiting on you.')
    expect(clear.els['today-story']!.textContent).toMatch(/^Nothing is waiting on you\./)
    expect(clear.rail[0]![1]).toBe('Nothing needs you')
    expect(clear.els['needs-count']!.textContent).toBe('')
  })

  it('quiet hours fold everything but a waiting session, with the count and the line saying the same', () => {
    const SAT = '2026-11-07T16:00:00Z'
    const n = needsRegion({ at: SAT, sessions: [WAIT], needs: [HANDOFF('h1', 'bbbbbbbb-2222-4222-8222-222222222222')], memories: { state: 'answered', n: 2 } })
    expect(n.els['needs-count']!.textContent).toBe('1')
    expect(n.els['needs-list']!.innerHTML).toContain('2 things can wait until tomorrow. Show')
    expect(n.els['needs-list']!.innerHTML).not.toContain('Handoff h1')
    expect(n.rail[0]![1]).toBe('1 needs you')
    const later = needsRegion({ at: SAT, needs: [HANDOFF('h1', 'bbbbbbbb-2222-4222-8222-222222222222')] })
    expect(later.els['today-story']!.textContent).toMatch(/^One thing can wait until tomorrow\./)
    expect(later.rail[0]![1]).toBe('1 can wait until tomorrow')
  })

  it('more than six rows: the first six and "Show N more"; the count is every row', () => {
    const many = Array.from({ length: 9 }, (_, i) => HANDOFF('h' + i, 'cccccccc-3333-4333-8333-33333333333' + i))
    const n = needsRegion({ at: WED_2PM, needs: many })
    expect((n.els['needs-list']!.innerHTML.match(/class="need-row"/g) || []).length).toBe(6)
    expect(n.els['needs-list']!.innerHTML).toContain('Show 3 more')
    expect(n.els['needs-count']!.textContent).toBe('9')
    expect(n.els['today-story']!.textContent).toMatch(/^Nine things need you\./)
  })
})

describe('Stop on the Running peek (parity gap 4)', () => {
  const CID = '019a0000-1111-2222-3333-444455556666'
  const CP = (tail: string) => `/api/agent-sessions/codex/${encodeURIComponent(CID)}${tail}`
  const ROW = { session_id: CID, provider: 'codex', display_label: 'Codex work', running: true, running_active: true, agent_state: 'running', state_source: 'hook' }
  function peek(cancel: Reply | ((b: any, n: number) => Reply)) {
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: { ['GET ' + CP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['POST ' + CP('/cancel')]: cancel as any } })
    h.ta.open('run', 'codex|' + CID, h.opener())
    return h
  }
  it('a tap arms it, the second sends the reader’s cancel with one id; the server’s words say what happened', async () => {
    const h = peek({ status: 200, body: { cancelled: true, reasonCopy: 'Stopped. The turn ended.' } })
    await flush()
    expect(h.els['ta-live']!.innerHTML).toContain('data-ta="stop"')
    h.tap('stop')
    expect(h.calls.filter(c => c.path === CP('/cancel'))).toHaveLength(0)
    expect(h.els['ta-live']!.innerHTML).toContain('Tap again to stop')
    h.tap('stop')   // 110 ms later in W2-r2: too soon, ignored
    expect(h.calls.filter(c => c.path === CP('/cancel'))).toHaveLength(0)
    h.later(450)
    h.tap('stop')
    h.tap('stop'); h.later(450); h.tap('stop')   // armed and confirmed again while the first is still out: nothing more is sent
    await flush()
    const sent = h.calls.filter(c => c.path === CP('/cancel'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.clientCancelId).toMatch(/^ct[a-z0-9]+$/)
    expect(h.els['ta-status']!.textContent).toBe('Stopped. The turn ended.')
    expect(h.els['ta-live']!.innerHTML, 'no Stop once it stopped').not.toContain('data-ta="stop"')
  })
  it('a refusal shows the server’s reason; a lost answer says so and the retry reuses the id', async () => {
    const no = peek({ status: 409, body: { cancelled: false, reason: 'cancel_unsupported', reasonCopy: 'COS did not start this turn, so it cannot stop it here.' } })
    await flush()
    no.tap('stop'); no.later(450); no.tap('stop'); await flush()
    expect(no.els['ta-status']!.textContent).toBe('COS did not start this turn, so it cannot stop it here.')
    expect(no.els['ta-status']!.getAttribute('data-error')).toBe('1')
    no.tap('stop'); no.later(450); no.tap('stop'); await flush()   // a new Stop after an answer is a new request, not a replay
    const tries = no.calls.filter(c => c.path === CP('/cancel')).map(c => c.body.clientCancelId)
    expect(tries).toHaveLength(2)
    expect(tries[1]).not.toBe(tries[0])
    let calls = 0
    const lost = peek(() => (++calls === 1 ? new TypeError('Load failed') : { status: 200, body: { cancelled: true } }))
    await flush()
    lost.tap('stop'); lost.later(450); lost.tap('stop'); await flush()
    expect(lost.els['ta-status']!.textContent).toContain('Stopping again is safe')
    lost.tap('stop'); lost.later(450); lost.tap('stop'); await flush()
    const ids = lost.calls.filter(c => c.path === CP('/cancel')).map(c => c.body.clientCancelId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(lost.els['ta-status']!.textContent).toBe('Stopped.')
  })
})

describe('Weather sits under the date, not in Next up (Miles 11/07)', () => {
  const load = () => {
    const start = APP.indexOf('  function renderWeather(w) {'), end = APP.indexOf("  // From today's meetings: Work's suggestions")
    const els: Record<string, El> = {}
    const deps = { $: (id: string) => (els[id] ??= new El()), esc, toDate: (v: unknown) => (v ? new Date(String(v)) : null), clock: () => '9:15 AM', dayWord: () => 'tomorrow',
      TODAY: { offline: true, welcome: {} }, window: {}, go: () => {}, toast: () => {} }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { renderWeather: renderWeather, renderNext: renderNext };\n}')(deps)
    return { els, fns }
  }
  const weather = { temp: '67°F', desc: 'Mostly clear', location: 'Cedar Park-Liberty Hill, TX' }
  it('the line under the date carries the weather, even with no meeting next', () => {
    const html = readFileSync(join(HERE, 'index.html'), 'utf8')
    expect(html.indexOf('id="today-weather"')).toBeGreaterThan(html.indexOf('id="today-date"'))
    const { els, fns } = load()
    fns.renderWeather({ weather })
    expect(els['today-weather']!.textContent).toBe('67°F and mostly clear in Cedar Park-Liberty Hill')
    expect(els['today-weather']!.cls.has('hidden')).toBe(false)
    fns.renderWeather({})
    expect(els['today-weather']!.textContent).toBe('')
    expect(els['today-weather']!.cls.has('hidden')).toBe(true)
  })
  it('Next up no longer repeats it', () => {
    const { els, fns } = load()
    fns.renderNext({ nextEvent: { title: 'New Event', time: '2026-11-08T15:15:00Z' }, weather })
    expect(els['next-body']!.innerHTML).toContain('Tomorrow')
    expect(els['next-body']!.innerHTML).not.toContain('67°F')
    expect(els['next-body']!.innerHTML).not.toContain('Now ')
  })
  it('Today paints the weather on the same read as Next up', () => {
    expect(APP).toContain('      renderWeather(welcome);\n      renderNext(welcome);\n')
  })
})

describe('Next up: Prep me and Open meeting (parity gap 9)', () => {
  it('the card is called Next up and offers both', () => {
    const html = readFileSync(join(HERE, 'index.html'), 'utf8')
    expect(html).toContain('<h2 id="next-title" class="panel-title">Next up</h2>')
    expect(html).not.toContain('Up next')
    const start = APP.indexOf('  function renderNext(w) {'), end = APP.indexOf("  // From today's meetings: Work's suggestions")
    const els: Record<string, El> = {}
    const deps = { $: (id: string) => (els[id] ??= new El()), esc, toDate: (v: unknown) => (v ? new Date(String(v)) : null), clock: () => '3:00 PM', dayWord: () => 'today',
      TODAY: { offline: false, welcome: {} }, window: { COSWeb: { cosChat: { prepFor: () => Promise.resolve('prep') } } }, go: () => {}, toast: () => {} }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { renderNext: renderNext, prepNext: prepNext };\n}')(deps)
    fns.renderNext({ nextEvent: { title: 'Quilt leadership sync', time: '2026-11-07T21:00:00Z' } })
    expect(els['next-actions']!.innerHTML).toContain('data-today-next="prep">Prep me</button>')
    expect(els['next-actions']!.innerHTML).toContain('data-goto="meetings">Open meeting</button>')
  })
  it('Prep me goes to the COS chat and asks cos-chat for this meeting’s Prep, by title and start', async () => {
    const start = APP.indexOf('  function renderNext(w) {'), end = APP.indexOf("  // From today's meetings: Work's suggestions")
    const went: unknown[] = [], asked: unknown[] = []
    const deps = { $: () => new El(), esc, toDate: (v: unknown) => (v ? new Date(String(v)) : null), clock: () => '', dayWord: () => 'today', toast: () => {},
      TODAY: { offline: false, welcome: { nextEvent: { title: 'Quilt leadership sync', time: '2026-11-07T21:00:00Z' } } },
      window: { COSWeb: { cosChat: { prepFor: (t: string, at: string) => { asked.push([t, at]); return Promise.resolve('prep') } } } }, go: (p: string, a: string[]) => went.push([p, a]) }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { prepNext: prepNext };\n}')(deps)
    fns.prepNext()
    expect(went).toEqual([['messages', ['cos']]])
    expect(asked).toEqual([['Quilt leadership sync', '2026-11-07T21:00:00.000Z']])
  })
  it('cos-chat prepFor: the Prep composer where Prep is on, else the plain Ask "Prep me for <title>"', async () => {
    const calls: Array<{ path: string; body: any }> = []
    const W: Record<string, unknown> = { $: () => null, esc, toast: () => {}, autoGrow: () => {}, md: (x: unknown) => String(x), skeletonRows: () => '', toDate: (x: string) => new Date(x),
      readStore: () => ({}), writeStore: () => {}, parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {},
      api: (path: string, o?: { body?: unknown }) => { calls.push({ path, body: o?.body }); return Promise.resolve(path === '/api/query-jobs' ? { job: { jobId: 'j1', status: 'queued' } } : {}) } }
    const document = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => ({ value: '', focus() {} }), activeElement: null, hidden: false,
      body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
    const ctx = vm.createContext({ window: { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } },
      document, setTimeout: () => 0, clearTimeout, console, Date, JSON, Math, Promise, localStorage: { getItem: () => null, setItem: () => {} }, crypto: globalThis.crypto })
    vm.runInContext(CHAT, ctx)
    const c = W.cosChat as any
    c._state.caps = { dropIt: false, jobs: true, steer: false, thread: false, dropFiles: 0 }
    expect(await c.prepFor('Quilt leadership sync', '2026-11-07T21:00:00.000Z')).toBe('ask')
    await flush()
    expect(calls.filter(x => x.path === '/api/query-jobs')[0]!.body.query).toBe('Prep me for Quilt leadership sync')
  })
})

describe('⌘K files a task to the Work inbox (parity gap 7)', () => {
  function sheet(domainList: unknown[] = [{ name: 'hermit_crabs', label: 'Hermit Crabs' }, { name: 'quilt', label: 'Quilt' }]) {
    const start = APP.indexOf("  // ⌘K's File to Work inbox"), end = APP.indexOf('  function openAsk(prefill) {')
    expect(start).toBeGreaterThan(0)
    const posts: any[] = [], statuses: Array<[string, boolean]> = [], toasts: string[] = []
    let capture: () => Promise<unknown> = () => Promise.resolve({ ok: true })
    const workPane = { changed: 0, intakeChanged() { this.changed++ } }
    const askQ = { value: 'Book the venue for the Thrift summit' }
    const deps: Record<string, unknown> = {
      $: (id: string) => (id === 'ask-q' ? askQ : null), PANES: { work: workPane }, toast: (t: string) => toasts.push(t), renderAsk: () => {}, esc,
      setStatus: (_el: unknown, t: string, err: boolean) => statuses.push([t, !!err]), webJobId: (() => { let n = 0; return () => 'id-' + (++n) })(),
      domainLabel: (d: string) => ({ quilt: 'Quilt' } as Record<string, string>)[d] || d, document: { querySelector: () => null },
      api: (path: string, o?: { method?: string; body?: unknown }) => {
        if (path === '/api/domains') return Promise.resolve({ domains: domainList })
        posts.push({ path, body: o?.body }); return capture()
      },
    }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { fileToInbox: fileToInbox, fileDomainLabel: fileDomainLabel, noteHtml: fileNoteHtml, get state() { return ASK_FILE } };\n}')(deps)
    return { fns, posts, statuses, toasts, workPane, askQ, setCapture: (f: () => Promise<unknown>) => { capture = f } }
  }
  it('files the words into the first domain’s inbox through Work’s own route; a second tap while it is out sends nothing', async () => {
    const s = sheet()
    s.fns.fileToInbox('Book the venue for the Thrift summit')
    s.fns.fileToInbox('Book the venue for the Thrift summit')
    await flush()
    expect(s.posts).toEqual([{ path: '/api/tasks/capture', body: { domain: 'quilt', text: 'Book the venue for the Thrift summit', section: 'inbox', captureId: 'id-1' } }])
    expect(s.toasts).toEqual(['Filed to the Work inbox.'])
    expect(s.askQ.value, 'the box clears, as Control clears its draft').toBe('')
    expect(s.workPane.changed, 'Work reads its board again').toBe(1)
    expect(s.fns.fileDomainLabel(), 'quilt when the server has it, as Control keeps it').toBe('Quilt')
    const other = sheet([{ name: 'personal', label: 'Personal' }, { name: 'sprocket_rocket', label: 'Sprocket Rocket' }])
    other.fns.fileToInbox('Renew the passport')
    await flush()
    expect(other.posts[0]!.body.domain, 'else the first domain the server lists').toBe('personal')
  })
  it('a failure says so and the retry files under the same id, so it lands once', async () => {
    const s = sheet()
    let n = 0
    s.setCapture(() => (++n === 1 ? Promise.reject(Object.assign(new Error('The task bridge did not answer.'), { status: 503 })) : Promise.resolve({ ok: true })))
    s.fns.fileToInbox('Call Megan about surcharging')
    await flush()
    // W5-r2: the result is on the row and in a toast, never only in a status line under the sheet.
    expect(s.toasts).toEqual(['Not filed: The task bridge did not answer. Filing again is safe.'])
    expect(s.fns.state.note).toEqual({ text: 'Call Megan about surcharging', line: 'Not filed: The task bridge did not answer. Filing again is safe.', error: true })
    expect(s.fns.noteHtml('Call Megan about surcharging')).toContain('class="note file-error" role="alert">Not filed: The task bridge did not answer.')
    expect(s.fns.noteHtml('Something else'), 'only for the words it was about').toContain('As a task in Quilt')
    expect(s.statuses, 'nothing goes to the status line under the sheet').toEqual([])
    s.fns.fileToInbox('Call Megan about surcharging')
    await flush()
    expect(s.posts.map(p => p.body.captureId)).toEqual(['id-1', 'id-1'])
    expect(s.toasts).toEqual(['Not filed: The task bridge did not answer. Filing again is safe.', 'Filed to the Work inbox.'])
    expect(s.fns.state.note).toBeNull()
  })
})

describe('the decision words live in one place (wording item 14)', () => {
  it('Create task and Dismiss come from their constants', () => {
    expect(TA).toContain("var CREATE_LABEL = 'Create task', DISMISS_LABEL = 'Dismiss';")
    expect((TA.match(/'Create task'/g) || []).length, 'only the constant spells it').toBe(1)
    expect((TA.match(/'Dismiss'/g) || []).length, 'only the constant spells it').toBe(1)
  })
})

// ── User QA round 2 (qa2-user-r2.md) ───────────────────────────────────
describe('W1-r2: the settle window covers the folded bottom sheet’s real open time', () => {
  it('derives it from the sheet’s and the backdrop’s computed animation and transition, the longer one, plus margin; never under 500 ms', () => {
    const at = (styles?: Record<string, Record<string, string>>) => {
      const h = load({ data: { intake: [ITEM(ID1, 'One')] }, styles })
      const t0 = h.now()
      h.ta.open('meeting', 'Surcharging Push', h.opener())
      return h.ta._state.settleAt - t0
    }
    const folded = { 'ta-sheet': { animationDuration: '0.22s', animationDelay: '0s', transitionDuration: '0s', transitionDelay: '0s' },
      scrim: { animationDuration: '0.16s', animationDelay: '0s', transitionDuration: '0s', transitionDelay: '0s' } }
    expect(at(folded), 'the bottom sheet: 220 ms and the margin').toBeGreaterThanOrEqual(500)
    expect(at(folded)).toBeLessThan(510)
    const slowBackdrop = { ...folded, scrim: { animationDuration: '0.16s', animationDelay: '0s', transitionDuration: '0.2s, 0.4s', transitionDelay: '0s, 0.05s' } }
    expect(at(slowBackdrop), 'the backdrop’s longer transition, delay included, wins').toBeGreaterThanOrEqual(730)
    expect(at(slowBackdrop)).toBeLessThan(740)
    const reduced = { 'ta-sheet': { animationDuration: '1e-05s', animationDelay: '0s', transitionDuration: '0s', transitionDelay: '0s' }, scrim: { animationDuration: '1e-05s' } }
    expect(at(reduced), 'reduced motion keeps the double-tap protection').toBeGreaterThanOrEqual(500)
  })
})

describe('W2-r2: a confirm needs its first tap on screen a moment', () => {
  it('question cards: Allow twice within the moment arms only; after it, the second Allow posts (the shared app.js rule)', async () => {
    const mk = () => ({ hidden: true, innerHTML: '', isConnected: true, listeners: {} as Record<string, (e: unknown) => void>,
      addEventListener(t: string, fn: (e: unknown) => void) { this.listeners[t] = fn }, querySelector: () => null, querySelectorAll: () => [], contains: () => false })
    const host = mk()
    const posts: Array<{ path: string; body: any }> = []
    let onShell: (() => void) | null = null, skew = 0
    const realNow = Date.now
    class QDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + skew) } static now() { return realNow() + skew } }
    const iso = (ms: number) => new Date(realNow() + ms).toISOString()
    const item = { id: 'pq_' + 'a'.repeat(24), sessionId: 's1', provider: 'claude', kind: 'approval', tool: 'Bash', createdAt: iso(-5000), deadlineAt: iso(600000), answerable: true, awayHold: false, waitingAtMac: false, approval: { tool: 'Bash', summary: 'npm publish', detail: 'npm publish' } }
    const W = { esc, toast: () => {}, showAuth: () => {}, onShell: (fn: () => void) => { onShell = fn }, confirmReady: realConfirmReady(QDate),
      api: (path: string, o?: { method?: string; body?: unknown }) => {
        if (o?.method === 'POST') { posts.push({ path, body: o.body }); return Promise.resolve({ ok: true }) }
        return Promise.resolve(path === '/api/models' ? { capabilities: { sessionQuestions: { enabled: true, webClient: true } } } : {})
      } }
    const fetch = () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ enabled: true, items: [item] }) })
    const document = { getElementById: (id: string) => (id === 'sq-host' ? host : id === 'app-shell' ? { classList: { contains: () => false } } : null), addEventListener: () => {}, hidden: false, activeElement: null }
    const ctx = vm.createContext({ window: { COSWeb: W, addEventListener: () => {} }, document, fetch, console, Date: QDate, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
      setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} })
    vm.runInContext(QUESTIONS, ctx)
    onShell!()
    await flush()
    const allow = { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'allow' : a === 'data-sq-id' ? item.id : null) }) }
    host.listeners.click!({ target: allow })
    skew += 110
    host.listeners.click!({ target: allow })
    await flush()
    expect(posts, 'a double tap 110 ms apart never allows').toEqual([])
    skew += 400
    host.listeners.click!({ target: allow })
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toMatchObject({ decision: 'allow' })
  })

  it('a triple tap on a meeting row (open, then two taps 460 ms apart) arms Dismiss and never sends it at the folded size', async () => {
    const h = load({ data: { intake: [ITEM(ID1, 'Roundtable branding')] }, api: { [`POST /api/work-intake/${ID1}/resolve`]: resolved(ID1, 'dismiss'), '/api/work-intake/decisions': codeError('', 404) } })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    await flush()
    h.later(460); expect(h.layerTap('dismiss', ID1), '460 ms: still inside the settle window').toBe(false)
    h.later(80); h.layerTap('dismiss', ID1)        // 540 ms: past the settle window, arms
    h.later(100); h.layerTap('dismiss', ID1)       // the bounce 100 ms later: ignored
    await flush()
    expect(h.posts).toEqual([])
    expect(h.els['ta-body']!.innerHTML).toContain('Tap again to dismiss')
  })
})

describe('W3-r2: Today never states an absence it did not observe', () => {
  it('sessions unread: the story says so, the Running card offers Try again, and nothing says "Nothing running"', () => {
    const n = needsRegion({ at: WED_2PM, sessionsState: 'failed' })
    const story = n.els['today-story']!.textContent
    expect(story).toContain('Couldn’t read your sessions.')
    expect(story).not.toContain('No agents are running')
    expect(story).not.toContain('Nothing is waiting on you')
    n.fns.renderRunning([], [])
    const card = n.els['run-list']!.innerHTML
    expect(card).toContain('data-today-needs="retry">Couldn’t read sessions. Try again</button>')
    expect(card).not.toContain('Nothing running')
    const ok = needsRegion({ at: WED_2PM })
    ok.fns.renderRunning([], [])
    expect(ok.els['run-list']!.innerHTML, 'a list that was read and is empty may say so').toContain('Nothing running')
  })

  it('the pet hides instead of saying "Nothing running" (app.js renderPet)', () => {
    const start = APP.indexOf('  function renderPet(sessions) {'), end = APP.indexOf('\n  }\n', start)
    expect(start).toBeGreaterThan(0)
    const box = new El(), calls: string[] = []
    const deps = { $: () => box, placePet: () => {}, petPrefs: () => ({ show: true, pet: 'default' }), petStop: () => calls.push('stop'), PET: { pose: 'idle' },
      state: { sessionsUnread: true }, api: () => { calls.push('api'); return Promise.resolve({}) } }
    // eslint-disable-next-line no-new-func
    new Function('deps', 'with (deps) {\n' + APP.slice(start, end + 4) + '\nrenderPet([]);\n}')(deps)
    expect(box.cls.has('hidden')).toBe(true)
    expect(calls).toEqual(['stop'])
  })
})

describe('W4-r2: a session waiting on a question opens as waiting, never as working', () => {
  const QSID = 'dddddddd-4444-4444-8444-444444444444'
  const QROW = { session_id: QSID, provider: 'claude', display_label: 'Gong personas team update', alive: true, running: true, running_active: false,
    agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
  const QP = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(QSID)}${tail}`
  const model = { rows: [{ kind: 'session', key: 'claude|' + QSID, title: 'Gong personas team update asked you a question', why: 'Waiting for you. Paused until you answer.' }], now: [], later: [], failed: [], settled: true }
  const routes: Routes = { ['GET ' + QP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [{ role: 'assistant', text: 'Which personas should I update first?' }] } },
    ['GET ' + QP('/attachability')]: { status: 200, body: { attachable: true, ownerCount: 0 } } }
  it('the Needs you row opens the waiting sheet: the question to answer, else the last message; no peek, no Stop', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model, questions: 0 })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-title']!.textContent).toBe('Gong personas team update asked you a question')
    const meta = h.els['ta-meta']!.innerHTML
    // W1 A5: said once. The head says the state; the line under it says where.
    expect(meta).toContain('Waiting for your answer')
    expect(meta).not.toContain('Paused until you answer')
    // 6.99.26: a Claude session's question that this page does not hold is at the Mac's own prompt: said so, read-only.
    expect(meta).toContain('Answer this at your Mac&#39;s prompt. A message sent from here does not answer it; it waits until the question is answered at the Mac.')
    expect(meta).not.toContain('Answer it in a reply below')
    expect(meta).not.toContain('Working')
    expect(h.streams, 'no live peek').toHaveLength(0)
    expect(h.els['ta-live']!.innerHTML).toBe('')
    expect(h.els['ta-last']!.innerHTML).toContain('Which personas should I update first?')
    expect(h.els['ta-foot']!.hidden, 'no reply box offered as an answer to a prompt').toBe(true)
    expect(h.mounts).toEqual([QSID])
    const held = load({ data: { sessions: [QROW] }, routes, model, questions: 1 })
    held.ta.open('wait', 'claude|' + QSID, held.opener())
    await flush()
    expect(held.els['ta-meta']!.innerHTML).toContain('It is asking you this now. Answer here.')
  })

  it('a session the list calls active but waiting on you opens with no Stop, before the stream says anything', async () => {
    const busy = { ...QROW, running_active: true }
    const h = load({ data: { sessions: [busy] }, routes })
    h.ta.open('run', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-run-state']!.textContent).toMatch(/^Waiting for you/)
    expect(h.els['ta-live']!.innerHTML).not.toContain('data-ta="stop"')
    expect(h.els['ta-live']!.innerHTML).not.toContain('<strong>Working</strong>')
  })

  it('a peek of that session from Running says Waiting, and a stream that says the process is up still shows no Stop', async () => {
    const h = load({ data: { sessions: [QROW] }, routes })
    h.ta.open('run', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-run-state']!.textContent).toMatch(/^Waiting for you/)
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'waiting', waiting_kind: 'question', state_since: new Date(Date.now() - 3600000).toISOString() }) })
    expect(h.els['ta-run-state']!.textContent).toMatch(/^Waiting for you/)
    expect(h.els['ta-live']!.innerHTML).toContain('<strong>Waiting</strong>')
    expect(h.els['ta-live']!.innerHTML).not.toContain('data-ta="stop"')
    expect(h.els['ta-live']!.innerHTML).not.toContain('Working')
  })
})

describe('W13 (QA week of 11/01-11/08): a question with no card keeps its words, and a failed questions read says so', () => {
  const QSID = 'eeeeeeee-5555-4555-8555-555555555555'
  const QROW = { session_id: QSID, provider: 'claude', display_label: 'Pricing page review', alive: true, running: true, running_active: false,
    agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
  const QP = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(QSID)}${tail}`
  const routes: Routes = { ['GET ' + QP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['GET ' + QP('/attachability')]: { status: 200, body: { attachable: true, ownerCount: 0 } } }
  const ASK = 'Ship the pricing page today or wait for Brad?'
  const model = (ask: string) => ({ rows: [{ kind: 'session', key: 'claude|' + QSID, title: 'Pricing page review asked you a question', why: 'Waiting for you. Paused until you answer.', where: 'mac', ask }], now: [], later: [], failed: [], settled: true })
  const MAC = 'Answer this at your Mac&#39;s prompt. A message sent from here does not answer it; it waits until the question is answered at the Mac.'
  const FAILED = 'Couldn&#39;t load this session&#39;s questions, so one may be waiting here.'.replace(/&#39;/g, '\u2019')

  it('at the Mac with no card drawn: the words Today showed stay, read-only, above the Mac line; the reply box stays hidden', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 0, mac: 0, qLoad: { state: 'ok' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('<blockquote class="ta-quote ta-mac-ask">' + esc(ASK) + '</blockquote>')
    expect(meta).toContain(MAC)
    expect(meta.indexOf(esc(ASK))).toBeLessThan(meta.indexOf(MAC))
    expect(meta).not.toContain('data-ta="q-retry"')
    expect(h.els['ta-foot']!.hidden).toBe(true)
  })

  it('never twice: no quote when the Mac card draws it, or when the line above already reads exactly those words', async () => {
    const card = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 0, mac: 1, qLoad: { state: 'ok' } })
    card.ta.open('wait', 'claude|' + QSID, card.opener())
    await flush()
    expect(card.els['ta-meta']!.innerHTML).not.toContain('ta-mac-ask')
    const same = { ...model(ASK), rows: [{ ...model(ASK).rows[0]!, why: ASK }] }
    const h = load({ data: { sessions: [QROW] }, routes, model: same, questions: 0, mac: 0, qLoad: { state: 'ok' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML.split(esc(ASK)).length - 1).toBe(1)
  })

  // W1 A5 (Miles 11/09): the Mac-prompt card says the state once, says where once, is honest when it has no words, and
  // offers nothing that pretends to answer. "Open session" stays the only action.
  it('W1 A5: words known: head, words, one Mac line, Open session only', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 0, mac: 0, qLoad: { state: 'ok' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('<span>Waiting for your answer</span>')
    expect(meta).not.toContain('Paused until you answer')
    expect(meta.split("Mac&#39;s prompt").length - 1).toBe(1)
    expect(meta).not.toContain('ta-mac-nowords')
    expect(meta.match(/<button/g)).toEqual(['<button'])
    expect(meta).toContain('data-ta="open-session">Open session</button>')
  })
  it('W1 A5: no words anywhere (a question that went straight to the Mac): says COS cannot read them, once', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model: model(''), questions: 0, mac: 0, qLoad: { state: 'ok' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('<p class="ta-sub ta-mac-nowords">COS cannot read this question&#39;s words from here. They show at the Mac&#39;s prompt.</p>')
    expect(meta).toContain(MAC)
    expect(meta).not.toContain('ta-mac-ask')
    expect(meta.match(/<button/g)).toEqual(['<button'])
  })
  it('W1 A5: words already in the head line: no "cannot read" line', async () => {
    const m = { ...model(''), rows: [{ ...model('').rows[0]!, why: ASK }] }
    const h = load({ data: { sessions: [QROW] }, routes, model: m, questions: 0, mac: 0, qLoad: { state: 'ok' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('<span>' + esc(ASK) + '</span>')
    expect(h.els['ta-meta']!.innerHTML).not.toContain('ta-mac-nowords')
  })

  it('a failed questions read never says "at the Mac": it says so, keeps the words, and Retry reads again', async () => {
    const q = { state: 'failed' }
    const h = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 0, mac: 0, qLoad: q })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    let meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain(FAILED)
    expect(meta).toContain('data-ta="q-retry">Retry</button>')
    expect(meta).not.toContain(MAC)
    expect(meta).toContain(esc(ASK))
    expect(meta).not.toMatch(/[—–]/)
    // A Claude prompt is not answered by a reply, failed read or not.
    expect(h.els['ta-foot']!.hidden).toBe(true)
    h.tap('q-retry')
    expect(h.retries()).toBe(1)
    // The read lands: questions.js tells the sheet (onChange) and the Mac line comes back.
    q.state = 'ok'
    h.qChanged()
    meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain(MAC)
    expect(meta).not.toContain('q-retry')
  })

  it('a failed read for a Codex session keeps its reply box, since a reply can answer it', async () => {
    const row = { ...QROW, provider: 'codex' }
    const key = 'codex|' + QSID
    const P = (tail: string) => `/api/agent-sessions/codex/${encodeURIComponent(QSID)}${tail}`
    const r2: Routes = { ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, ownerCount: 0 } } }
    const m = { rows: [{ kind: 'session', key, title: 'Codex asked', why: 'Waiting for you', where: '', ask: '' }], now: [], later: [], failed: [], settled: true }
    const h = load({ data: { sessions: [row] }, routes: r2, model: m, questions: 0, mac: 0, qLoad: { state: 'failed' } })
    h.ta.open('wait', key, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('data-ta="q-retry"')
    expect(h.els['ta-foot']!.hidden).toBe(false)
  })

  it('a Mac card drawn from an earlier read stays the answer when a later read fails', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 0, mac: 1, qLoad: { state: 'failed' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).not.toContain('q-retry')
  })

  it('a held card on screen wins over a failed later read: the cards are the truth', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model: model(ASK), questions: 1, mac: 0, qLoad: { state: 'failed' } })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('It is asking you this now. Answer here.')
    expect(meta).not.toContain('q-retry')
    expect(meta).not.toContain('ta-mac-ask')
  })
})

// ═════════════ 6.99.26: questions on Control Web (Miles 11/07) ═════════════
// questions.js in a vm with the page's own clocks (wall and monotonic, moved apart), the document's touch listeners,
// and a poll whose answer the test sets. Nothing reaches a server.
const MAC_WORDS = 'Answer this at your Mac&#39;s prompt. A message sent from here does not answer it; it waits until the question is answered at the Mac.'
function loadQ(body: () => unknown, opt: { perf?: boolean; post?: (path: string, body: any) => Promise<unknown>; reduced?: boolean; fetch?: (url: string) => Promise<unknown> | null; models?: (n: number) => Promise<unknown> | null; vv?: { height: number; offsetTop: number }; innerHeight?: number; session?: Map<string, string> } = {}) {
  const mk = () => ({ hidden: true, innerHTML: '', isConnected: true, listeners: {} as Record<string, (e: unknown) => void>,
    style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v } },
    addEventListener(t: string, fn: (e: unknown) => void) { this.listeners[t] = fn }, querySelector: () => null, querySelectorAll: () => [], contains: () => false })
  const vvListeners: Record<string, Array<() => void>> = {}
  const visualViewport = opt.vv ? { ...opt.vv, addEventListener: (t: string, fn: () => void) => { (vvListeners[t] ??= []).push(fn) } } : undefined
  const host = mk()
  const docListeners: Record<string, Array<(e: unknown) => void>> = {}
  const fetches: string[] = [], timers: Array<{ fn: () => void; ms: number }> = [], posts: Array<{ path: string; body: any }> = []
  let wall = 0, mono = 0, changed = 0, refreshed = 0, onShell: (() => void) | null = null, modelReads = 0
  const routeHooks: Array<(r: { pane: string }) => void> = []
  const realNow = Date.now
  class QDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + wall) } static now() { return realNow() + wall } }
  const W: Record<string, unknown> = { esc, toast: () => {}, showAuth: () => {}, onShell: (fn: () => void) => { onShell = fn }, confirmReady: realConfirmReady(QDate),
    today: { questionsChanged: () => { changed++ }, refresh: () => { refreshed++ } },
    onRoute: (fn: (r: { pane: string }) => void) => { routeHooks.push(fn) },
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      if (o?.method === 'POST') { posts.push({ path, body: o.body }); return opt.post ? opt.post(path, o.body) : Promise.resolve({ ok: true }) }
      if (path === '/api/models') { modelReads++; const own = opt.models ? opt.models(modelReads) : null; if (own) return own }
      return Promise.resolve(path === '/api/models' ? { capabilities: { sessionQuestions: { enabled: true, webClient: true } } } : {})
    } }
  const document: any = { getElementById: (id: string) => (id === 'sq-host' ? host : id === 'app-shell' ? { classList: { contains: () => false } } : null),
    addEventListener: (t: string, fn: (e: unknown) => void) => { (docListeners[t] ??= []).push(fn) }, hidden: false, activeElement: null }
  const fetch = (url: string) => { fetches.push(url); const own = opt.fetch ? opt.fetch(url) : null; return own || Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body()) }) }
  const qWinListeners: Record<string, Array<() => void>> = {}
  // 6.99.30: this tab's sessionStorage (picks kept across a reload) and the server's up or down (app.js noteServer).
  const session = opt.session ?? new Map<string, string>()
  const server = { up: null as boolean | null, hooks: [] as Array<(up: boolean) => void> }
  W.serverUp = () => server.up
  W.onServer = (fn: (up: boolean) => void) => { server.hooks.push(fn) }
  const qWin: any = { COSWeb: W, sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) } }, ...(opt.reduced === undefined ? {} : { matchMedia: (q: string) => ({ matches: !!opt.reduced && q.includes('reduce') }) }),
    ...(visualViewport ? { visualViewport, innerHeight: opt.innerHeight ?? 800 } : {}),
    addEventListener: (t: string, fn: () => void) => { (qWinListeners[t] ??= []).push(fn) } }
  W.viewportFit = realViewportFit(qWin, document)
  const ctx = vm.createContext({ window: qWin,
    document, fetch, console, Date: QDate, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
    performance: opt.perf === false ? undefined : { now: () => 5_000 + mono },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} })
  vm.runInContext(QUESTIONS, ctx)
  const touch = (type = 'pointerdown', trusted = true) => (docListeners[type] || []).forEach(fn => fn({ isTrusted: trusted }))
  const visible = (on: boolean) => { document.hidden = !on; (docListeners.visibilitychange || []).forEach(fn => fn({})) }
  const route = (pane: string) => routeHooks.forEach(fn => fn({ pane }))
  const viewport = (height: number, offsetTop = 0) => { visualViewport!.height = height; visualViewport!.offsetTop = offsetTop; (vvListeners.resize || []).forEach(fn => fn()) }
  const setServer = (up: boolean) => { server.up = up; server.hooks.forEach(fn => fn(up)) }
  return { qWin, qWinListeners, session, setServer, Qs: (W as any).sessionQuestions, host, mk, fetches, timers, posts, touch, document, W, visible, route, viewport, vvListeners, modelReads: () => modelReads,
    start: async () => { onShell!(); await flush() }, later: (wallMs: number, monoMs = wallMs) => { wall += wallMs; mono += monoMs }, changed: () => changed, refreshed: () => refreshed }
}
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString()
const HELD = (id: string, sid: string, question: string) => ({ id, sessionId: sid, provider: 'claude', kind: 'question', tool: 'AskUserQuestion', createdAt: isoIn(-5_000), deadlineAt: isoIn(600_000),
  answerable: true, awayHold: true, waitingAtMac: false,
  questions: [{ question, header: '', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] })
const AT_MAC = (id: string, sid: string, extra: Record<string, unknown> = {}) => ({ id, sessionId: sid, provider: 'claude', kind: 'question', tool: 'AskUserQuestion', createdAt: isoIn(-60_000),
  deadlineAt: isoIn(500_000), settledAt: isoIn(-1_000), resolution: 'handed_to_desk', answerable: false, awayHold: true, waitingAtMac: true, ...extra })
/** Text a person reads: the markup with its tags and attributes taken out. */
const words = (html: string) => html.replace(/<[^>]*>/g, ' ')

describe('6.99.26: the page tells the Mac when it was last touched, for the away hold only', () => {
  it('polls with hold=1 always; after a real touch, with how long ago it was', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }))
    await h.start()
    expect(h.fetches).toEqual(['/api/session-questions?client=web&hold=1'])
    h.touch()
    h.later(1_500)
    h.Qs.poll(); await flush()
    // The real clock moves a few ms under the test's: read the number, not the exact text.
    const age = (url: string) => Number((/^\/api\/session-questions\?client=web&hold=1&presenceAgeMs=(\d+)$/.exec(url) || [])[1])
    expect(age(h.fetches[1]!)).toBeGreaterThanOrEqual(1500)
    expect(age(h.fetches[1]!)).toBeLessThan(1600)
    h.touch('keydown')
    h.Qs.poll(); await flush()
    expect(age(h.fetches[2]!)).toBeGreaterThanOrEqual(0)
    expect(age(h.fetches[2]!)).toBeLessThan(100)
  })

  it('only a real touch or key in a visible tab counts', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }))
    h.touch('pointerdown', false)
    expect(h.Qs._presenceAge(), 'a script-made event').toBeNull()
    h.document.hidden = true
    h.touch()
    expect(h.Qs._presenceAge(), 'a hidden tab').toBeNull()
    h.document.hidden = false
    h.touch('touchstart')
    expect(Math.abs((h.Qs._presenceAge()) - 0)).toBeLessThan(50)
    const scroll = loadQ(() => ({}))
    scroll.touch('wheel'); scroll.touch('mousemove')
    expect(scroll.Qs._presenceAge(), 'a wheel or a passing pointer is not a touch').toBeNull()
  })

  it('never younger than it is: the larger of the two clocks; past 24 hours, none at all', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }))
    h.touch()
    h.later(3_600_000, 1_000)          // the phone slept an hour: the monotonic clock barely moved
    expect(Math.abs((h.Qs._presenceAge()) - 3_600_000)).toBeLessThan(50)
    h.later(-7_200_000, 4_000)         // the wall clock stepped back two hours: the monotonic clock still counts
    expect(h.Qs._presenceAge()).toBe(5_000)
    h.later(86_400_001 + 7_200_000 - 3_600_000, 0)
    expect(h.Qs._presenceAge()).toBeNull()
    expect(h.Qs._pollUrl()).toBe('/api/session-questions?client=web&hold=1')
    const noPerf = loadQ(() => ({}), { perf: false })
    noPerf.touch(); noPerf.later(2_000)
    expect(Math.abs(noPerf.Qs._presenceAge() - 2_000), 'without performance.now the wall clock alone').toBeLessThan(50)
  })

  // QA 6.99.27 (N4): the touch's read goes through nudge, so it keeps the 1 s gap (it was a flat 250 ms).
  it('the first touch in a while reaches the Mac at once, not at the next poll, within the 1 s gap', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }))
    await h.start()
    const before = h.timers.length
    h.touch()
    const first = h.timers.slice(before).map(t => t.ms)
    expect(first, 'a read went out a moment ago: at the end of the second').toHaveLength(1)
    expect(first[0]).toBeGreaterThan(900)
    expect(first[0]).toBeLessThanOrEqual(1000)
    h.later(5_000)
    h.touch()
    expect(h.timers.slice(before), 'a touch soon after waits for the next poll').toHaveLength(1)
    h.later(61_000)
    h.touch()
    expect(h.timers.slice(before).map(t => t.ms)[1], 'long after the last read: at once').toBe(0)
  })
})

describe('W13: questions.js says whether its last read was the server\u2019s answer, and tells the mounted sheets when that changes', () => {
  it('unread, then failed on no answer, a non-OK status or a cut body; ok on an answer; each change reaches onChange once', async () => {
    let mode: 'reject' | '500' | 'body' | 'ok' = 'reject'
    const h = loadQ(() => ({ enabled: true, items: [] }), {
      fetch: () => mode === 'reject' ? Promise.reject(new TypeError('Load failed'))
        : mode === '500' ? Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
        : mode === 'body' ? Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new Error('cut')) })
        : null,
    })
    expect(h.Qs.loadState()).toBe('unread')
    const mine = h.mk(), calls: Array<[number, number]> = []
    h.Qs.mount(mine, 'sess-a', (n: number, mac: number) => calls.push([n, mac]))
    const drawn = calls.length
    await h.start()
    expect(h.Qs.loadState()).toBe('failed')
    expect(calls.length, 'the failure reached the sheet').toBe(drawn + 1)
    h.Qs.poll(); await flush()
    expect(h.Qs.loadState()).toBe('failed')
    expect(calls.length, 'no change, no call').toBe(drawn + 1)
    mode = 'ok'; h.Qs.poll(); await flush()
    expect(h.Qs.loadState()).toBe('ok')
    expect(calls.length).toBeGreaterThan(drawn + 1)
    mode = '500'; h.Qs.poll(); await flush()
    expect(h.Qs.loadState(), 'a non-OK status').toBe('failed')
    mode = 'ok'; h.Qs.poll(); await flush()
    expect(h.Qs.loadState()).toBe('ok')
    const afterOk = calls.length
    mode = 'body'; h.Qs.poll(); await flush()
    expect(h.Qs.loadState()).toBe('failed')
    expect(calls.length).toBe(afterOk + 1)
  })

  it('an unreadable capability is a failed read; a server that says questions are off is an answer', async () => {
    const down = loadQ(() => ({ enabled: true, items: [] }), { models: () => Promise.reject(new Error('down')) })
    await down.start()
    expect(down.Qs.loadState()).toBe('failed')
    const off = loadQ(() => ({ enabled: false, items: [] }))
    await off.start()
    expect(off.Qs.loadState()).toBe('ok')
    const older = loadQ(() => ({ enabled: true, items: [] }), { models: () => Promise.resolve({ capabilities: {} }) })
    await older.start()
    expect(older.Qs.loadState(), 'a server without the capability answered').toBe('ok')
  })

  it('a read that throws before it is sent is a failed read too', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }), { fetch: () => { throw new TypeError('blocked') } })
    await h.start()
    expect(h.Qs.loadState()).toBe('failed')
  })

  it('retry() reads again through nudge: one read, never a second one on the wire', async () => {
    const h = loadQ(() => ({ enabled: true, items: [] }), { fetch: () => Promise.reject(new TypeError('Load failed')) })
    await h.start()
    expect(h.Qs.loadState()).toBe('failed')
    h.later(5_000)
    const before = h.timers.length
    h.Qs.retry()
    expect(h.timers.slice(before).map(t => t.ms)).toEqual([0])
  })
})

describe('6.99.26: a question at the Mac shows read-only, with its words when the page saw them', () => {
  it('draws it in the session’s cards only, with Miles’s words and no way to answer, and never an id', async () => {
    let body: unknown = { enabled: true, items: [], settled: [AT_MAC('pq_' + 'm'.repeat(24), 'sess-a'), AT_MAC('pq_' + 'n'.repeat(24), 'sess-a', { waitingAtMac: false })] }
    const h = loadQ(() => body)
    await h.start()
    const mine = h.mk(), calls: Array<[number, number]> = []
    h.Qs.mount(mine, 'SESS-A', (n: number, mac: number) => calls.push([n, mac]))
    expect(mine.hidden).toBe(false)
    expect(mine.innerHTML).toContain(MAC_WORDS)
    expect(mine.innerHTML).toContain('Claude has a question')
    expect(mine.innerHTML, 'no buttons').not.toContain('data-sq=')
    expect(mine.innerHTML.match(/data-sq-mac=/g), 'one card: a settled one the Mac no longer waits on is not drawn').toHaveLength(1)
    expect(words(mine.innerHTML)).not.toContain('pq_')
    expect(words(mine.innerHTML)).not.toContain('sess-a')
    expect(calls).toEqual([[0, 1]])
    expect(h.host.innerHTML, 'the top of every pane keeps to what can be answered').toBe('')
    expect(h.Qs.mount(h.mk(), 'sess-b', null).count()).toBe(0)
    body = { enabled: true, items: [], settled: [] }
    h.Qs.poll(); await flush()
    expect(mine.innerHTML).toBe('')
    expect(calls.at(-1)).toEqual([0, 0])
  })

  it('a held question that goes back to the Mac keeps its words here; once the Mac stops waiting, they go', async () => {
    const id = 'pq_' + 'q'.repeat(24)
    let body: unknown = { enabled: true, items: [HELD(id, 'sess-a', 'Ship the release notes now?')], settled: [] }
    const h = loadQ(() => body)
    await h.start()
    const mine = h.mk()
    h.Qs.mount(mine, 'sess-a')
    expect(mine.innerHTML).toContain('data-sq="send"')
    body = { enabled: true, items: [], settled: [AT_MAC(id, 'sess-a')] }
    h.Qs.poll(); await flush()
    expect(mine.innerHTML).toContain('Ship the release notes now?')
    expect(mine.innerHTML).toContain(MAC_WORDS)
    expect(mine.innerHTML).not.toContain('data-sq="send"')
    expect(h.Qs.wordsOf(id)).toEqual({ questions: ['Ship the release notes now?'], summary: '' })
    body = { enabled: true, items: [], settled: [] }
    h.Qs.poll(); await flush()
    expect(h.Qs.wordsOf(id)).toBeNull()
  })

  it('an approval at the Mac names its tool and command when seen; Today hears each change once', async () => {
    const id = 'pq_' + 'p'.repeat(24)
    const held = { ...HELD(id, 'sess-a', ''), kind: 'approval', tool: 'Bash', questions: undefined, approval: { tool: 'Bash', summary: 'npm publish', detail: 'npm publish' } }
    let body: unknown = { enabled: true, items: [held], settled: [] }
    const h = loadQ(() => body)
    await h.start()
    expect(h.changed()).toBe(1)
    h.Qs.poll(); await flush()
    expect(h.changed(), 'the same lists again: no repaint').toBe(1)
    body = { enabled: true, items: [], settled: [AT_MAC(id, 'sess-a', { kind: 'approval', tool: 'Bash' })] }
    h.Qs.poll(); await flush()
    expect(h.changed()).toBe(2)
    const mine = h.mk()
    h.Qs.mount(mine, 'sess-a')
    expect(mine.innerHTML).toContain('Claude wants to use Bash')
    expect(mine.innerHTML).toContain('npm publish')
    expect(mine.innerHTML).toContain(MAC_WORDS)
  })
})

describe('6.99.26: Needs you says where each waiting session can be answered', () => {
  const S1 = 'aaaaaaaa-1111-4111-8111-111111111111', S2 = 'bbbbbbbb-2222-4222-8222-222222222222'
  const row = (sid: string, label: string, extra: Record<string, unknown> = {}) => ({ ...WAIT, session_id: sid, display_label: label, waiting_kind: 'question', waiting_detail: 'AskUserQuestion', ...extra })
  async function held(items: unknown[], settled: unknown[] = []) { const q = loadQ(() => ({ enabled: true, items, settled })); await q.start(); return q.Qs }

  it('two waiting sessions with held questions: two rows, each answerable here, each with its own question', async () => {
    const qs = await held([HELD('pq_' + 'a'.repeat(24), S1, 'Publish to npm next?'), HELD('pq_' + 'b'.repeat(24), S2, 'Which brand goes first?')])
    const n = needsRegion({ at: WED_2PM, sessions: [row(S1, 'Release QA'), row(S2, 'Persona refresh')], qs })
    const list = n.els['needs-list']!.innerHTML
    expect(list.match(/data-today="wait"/g)).toHaveLength(2)
    expect(list).toContain('data-key="claude|' + S1 + '"')
    expect(list).toContain('data-key="claude|' + S2 + '"')
    expect(list).toContain('Publish to npm next?')
    expect(list).toContain('Which brand goes first?')
    expect(list.match(/data-where="here">Answer it here\.</g)).toHaveLength(2)
    expect(list).not.toContain('Mac&#39;s prompt')
    expect(n.els['needs-count']!.textContent).toBe('2')
  })

  it('a Claude question the page does not hold is at the Mac’s prompt; a Codex one is answered by a reply', async () => {
    const qs = await held([])
    const n = needsRegion({ at: WED_2PM, sessions: [row(S1, 'Release QA'), row(S2, 'Codex fix', { provider: 'codex' })], qs })
    const list = n.els['needs-list']!.innerHTML
    expect(list.match(/data-where="mac"/g)).toHaveLength(1)
    expect(list).toContain(MAC_WORDS)
    expect(list).toContain('Codex fix is waiting for your reply')
    const codexRow = list.slice(list.indexOf('Codex fix'))
    expect(codexRow.slice(0, codexRow.indexOf('</button>'))).not.toContain('need-where')
    // A Codex approval the broker handed back to the Mac is at the Mac too.
    const q2 = loadQ(() => ({ enabled: true, items: [], settled: [AT_MAC('pq_' + 'k'.repeat(24), S2, { provider: 'codex', kind: 'approval', tool: 'Bash' })] }))
    await q2.start()
    const codexMac = needsRegion({ at: WED_2PM, sessions: [row(S2, 'Codex fix', { provider: 'codex' })], qs: q2.Qs }).els['needs-list']!.innerHTML
    expect(codexMac).toContain('data-where="mac"')
    // Before questions.js has an answer, the same: no claim that it can be answered here.
    const none = needsRegion({ at: WED_2PM, sessions: [row(S1, 'Release QA')] })
    expect(none.els['needs-list']!.innerHTML).not.toContain('Answer it here.')
  })

  it('a question that went back to the Mac shows its words with the Mac line', async () => {
    const id = 'pq_' + 'c'.repeat(24)
    const q = loadQ(() => body)
    let body: unknown = { enabled: true, items: [HELD(id, S1, 'Merge the hotfix branch?')], settled: [] }
    await q.start()
    body = { enabled: true, items: [], settled: [AT_MAC(id, S1)] }
    q.Qs.poll(); await flush()
    const list = needsRegion({ at: WED_2PM, sessions: [row(S1, 'Release QA')], qs: q.Qs }).els['needs-list']!.innerHTML
    expect(list).toContain('Merge the hotfix branch?')
    expect(list).toContain(MAC_WORDS)
  })

  it('a held question whose session the list has not shown waiting yet still gets its row', async () => {
    const qs = await held([HELD('pq_' + 'd'.repeat(24), S2, 'Rename the export file?')])
    const n = needsRegion({ at: WED_2PM, sessions: [row(S1, 'Release QA')], qs })
    const list = n.els['needs-list']!.innerHTML
    expect(list.match(/data-today="wait"/g)).toHaveLength(2)
    expect(list).toContain('data-key="claude|' + S2 + '"')
    expect(list).toContain('A session asked you a question')
    expect(list).toContain('Rename the export file?')
    // The summary COS reads carries the rows' titles and reasons, never a held question's own words.
    const m = n.fns.needsModel()
    expect(m.rows.map((r: { why: string }) => r.why).join(' ')).not.toContain('Rename the export file?')
    const o = load({ model: m })
    const text = o.ta.summary()
    expect(text).toContain('A session asked you a question. Waiting for you. Paused until you answer. It can be answered from Today.')
    expect(text).toContain('Release QA asked you a question. Waiting for your answer. It waits on the Mac’s own prompt.')
    expect(text).not.toContain('Rename the export file?')
  })
})

describe('6.99.26: the waiting sheet offers only an answer that can reach the session', () => {
  const SID = 'eeeeeeee-5555-4555-8555-555555555555'
  const ROW = { session_id: SID, provider: 'claude', display_label: 'Release QA', alive: true, running: true, running_active: false, agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
  const P = (prov: string, tail: string) => `/api/agent-sessions/${prov}/${encodeURIComponent(SID)}${tail}`
  const routesFor = (prov: string): Routes => ({ ['GET ' + P(prov, '?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['GET ' + P(prov, '/attachability')]: { status: 200, body: { attachable: true, ownerCount: 0 } } })
  const modelFor = (prov: string, where: string) => ({ rows: [{ kind: 'session', key: prov + '|' + SID, title: 'Release QA asked you a question', why: 'Waiting for you. Paused until you answer.', where }], now: [], later: [], failed: [], settled: true })

  it('a Mac card in the sheet says it itself: the line is not repeated, and there is no reply box', async () => {
    const h = load({ data: { sessions: [ROW] }, routes: routesFor('claude'), model: modelFor('claude', 'mac'), questions: 0, mac: 1 })
    h.ta.open('wait', 'claude|' + SID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).not.toContain('Mac&#39;s prompt')
    expect(h.els['ta-foot']!.hidden).toBe(true)
  })

  it('a question held for this page: answer it here, and still no reply box', async () => {
    const h = load({ data: { sessions: [ROW] }, routes: routesFor('claude'), model: modelFor('claude', 'here'), questions: 1 })
    h.ta.open('wait', 'claude|' + SID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('It is asking you this now. Answer here.')
    expect(h.els['ta-meta']!.innerHTML).not.toContain('Mac&#39;s prompt')
    expect(h.els['ta-foot']!.hidden).toBe(true)
  })

  it('a Codex session waiting for words: the reply box is the answer', async () => {
    const codex = { ...ROW, provider: 'codex' }
    const h = load({ data: { sessions: [codex] }, routes: routesFor('codex'), model: modelFor('codex', ''), questions: 0 })
    h.ta.open('wait', 'codex|' + SID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('Answer it in a reply below, or open the session.')
    expect(h.els['ta-meta']!.innerHTML).not.toContain('Mac&#39;s prompt')
    expect(h.els['ta-foot']!.hidden).toBe(false)
    expect(h.els['ta-foot']!.innerHTML).toContain('placeholder="Reply to this session"')
  })
})

describe('6.99.26: two held questions in Needs you, each answered in place (real questions.js in the overlay)', () => {
  const S1 = 'aaaaaaaa-1111-4111-8111-111111111111', S2 = 'bbbbbbbb-2222-4222-8222-222222222222'
  const Q1ID = 'pq_' + '1'.repeat(24), Q2ID = 'pq_' + '2'.repeat(24)
  const sess = (sid: string, label: string) => ({ session_id: sid, provider: 'claude', display_label: label, alive: true, running: true, running_active: false, agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' })
  const P = (sid: string, tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(sid)}${tail}`
  it('opens each from its row, draws only its card, and sends each answer once, after the settle window and the confirm', async () => {
    const pending = [HELD(Q1ID, S1, 'Publish to npm next?'), HELD(Q2ID, S2, 'Which brand goes first?')]
    const routes: Routes = {
      'GET /api/session-questions?client=web&hold=1': () => ({ status: 200, body: { enabled: true, items: pending.slice(), settled: [], pollIntervalMs: 3_000 } }),
      ['GET ' + P(S1, '?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['GET ' + P(S2, '?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
      ['GET ' + P(S1, '/attachability')]: { status: 200, body: { attachable: true } }, ['GET ' + P(S2, '/attachability')]: { status: 200, body: { attachable: true } },
    }
    const model = { rows: [S1, S2].map((sid, i) => ({ kind: 'session', key: 'claude|' + sid, title: (i ? 'Persona refresh' : 'Release QA') + ' asked you a question', why: 'Waiting for you. Paused until you answer.', where: 'here' })), now: [], later: [], failed: [], settled: true }
    const h = load({ data: { sessions: [sess(S1, 'Release QA'), sess(S2, 'Persona refresh')] }, routes, model,
      api: { '/api/models': { capabilities: { sessionQuestions: { enabled: true, webClient: true } } }, [`POST /api/session-questions/${Q1ID}/answer`]: { ok: true }, [`POST /api/session-questions/${Q2ID}/answer`]: { ok: true } } })
    // The real questions.js, in the overlay's own page, replacing the stand-in mount.
    const W = (h.ctx as any).window.COSWeb
    let onShell: (() => void) | null = null
    W.onShell = (fn: () => void) => { onShell = fn }; W.toast = () => {}
    ;(h.ctx as any).crypto = globalThis.crypto
    vm.runInContext(QUESTIONS, h.ctx)
    onShell!()
    await flush()
    expect(W.sessionQuestions.itemsFor('').map((i: { id: string }) => i.id)).toEqual([Q1ID, Q2ID])
    // A tap as the browser delivers it: the layer's capture guard, then the card's own listener on #ta-q.
    const cardTap = (what: string, id: string) => {
      const b = { disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? what : a === 'data-sq-id' ? id : null) }
      const ev = { target: { closest: (sel: string) => (sel === '[data-sq]' ? b : null) }, stopPropagation() { this.stopped = true }, preventDefault() {}, stopped: false }
      ;(h.document.appended.listeners.click as Array<(e: unknown) => void>)[0]!(ev)
      if (!ev.stopped) for (const fn of h.els['ta-q']!.listeners.click || []) fn(ev)
      return !ev.stopped
    }
    const pick = (id: string) => { for (const fn of h.els['ta-q']!.listeners.change || []) fn({ target: { hasAttribute: (a: string) => a === 'data-sq-pick', getAttribute: (a: string) => (({ 'data-sq-id': id, 'data-q': '0', 'data-o': '0' }) as Record<string, string>)[a], checked: true } }) }
    const answer = async (sid: string, id: string, mine: string, other: string) => {
      h.ta.open('wait', 'claude|' + sid, h.opener())
      await flush()
      const q = h.els['ta-q']!
      expect(q.hidden).toBe(false)
      expect(q.innerHTML).toContain(mine)
      expect(q.innerHTML, 'only this session’s card').not.toContain(other)
      pick(id)
      h.later(120)
      expect(cardTap('send', id), 'inside the settle window the tap lands on nothing').toBe(false)
      h.later(420)
      expect(cardTap('send', id)).toBe(true)
      expect(q.innerHTML).toContain('Tap again to submit')
      h.later(150)
      cardTap('send', id)
      await flush()
      expect(h.posts.filter(p => p.path.includes(id)), 'a second tap 150 ms later never sends').toEqual([])
      h.later(300)
      cardTap('send', id)
      await flush()
      const sent = h.posts.filter(p => p.path.includes(id))
      expect(sent).toHaveLength(1)
      expect(sent[0]!.path).toBe(`/api/session-questions/${id}/answer`)
      expect(sent[0]!.body.answers).toEqual([{ labels: ['Yes'] }])
      pending.splice(pending.findIndex(p => p.id === id), 1)
      h.ta.close('user')
    }
    await answer(S1, Q1ID, 'Publish to npm next?', 'Which brand goes first?')
    await answer(S2, Q2ID, 'Which brand goes first?', 'Publish to npm next?')
    expect(h.posts.map(p => p.path)).toEqual([`/api/session-questions/${Q1ID}/answer`, `/api/session-questions/${Q2ID}/answer`])
  })
})

describe('6.99.26: the pet opens what matters (Miles 11/07)', () => {
  const PET_START = APP.indexOf('  // ── the session pet (Today) ─'), PET_END = APP.indexOf('  // ── Today ──')
  function petKit(sessions: unknown[], now = '2026-11-07T15:00:00', questions: unknown[] = []) {
    const opened: Array<[string, string]> = []
    const t = new Date(now).getTime()
    class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(t) } static now() { return t } }
    const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
    const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
    const split = /  function splitSessionId\(provider, id\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]
    const deps = {
      $: () => null, esc, api: () => Promise.resolve(null), readStore: () => ({}), writeStore: () => {}, Date: FakeDate,
      toDate: (v: unknown) => (v ? new FakeDate(String(v)) : null), state: { pane: 'today', sessions },
      openTodayAction: (_t: unknown, kind: string, key: string) => { opened.push([kind, key]) },
      document: { querySelector: () => null, hidden: false },
      window: { matchMedia: () => ({ matches: true, addEventListener() {} }), COSWeb: { sessionQuestions: { itemsFor: (sid: string) => (sid ? [] : questions) } } },
      Image: class {}, setTimeout, clearTimeout, Promise,
    }
    // eslint-disable-next-line no-new-func
    const kit = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + split + '\n' + sx + '\n' + APP.slice(PET_START, PET_END) +
      '\nreturn { petPose: petPose, petPlay: petPlay, petTap: petTap, petButtonState: petButtonState, petCaption: petCaption, petQuestions: petQuestions, petPoseIn: petPoseIn };\n}')(deps)
    return { kit, opened }
  }
  const s = (id: string, extra: Record<string, unknown>) => ({ session_id: id, provider: 'claude', alive: true, display_label: 'S ' + id, ...extra })
  const WAITS = s('w1', { agent_state: 'waiting', state_source: 'hook', running: true })
  const RUNS = s('r1', { running_active: true, running: true, agent_state: 'running', state_source: 'hook' })
  const BUSY_WAITING = s('r2', { running_active: true, running: true, agent_state: 'waiting', state_source: 'hook' })
  const DONE = s('d1', { agent_state: 'idle', state_source: 'hook', running: true, last_activity_at: '2026-11-07T13:00:00' })
  const ENDED = s('d2', { agent_state: 'ended', state_source: 'hook', last_activity_at: '2026-11-07T09:00:00' })
  const YESTERDAY = s('d3', { agent_state: 'idle', state_source: 'hook', last_activity_at: '2026-11-06T13:00:00' })
  const QUIET_UP = s('q1', { agent_state: 'running', state_source: 'hook', running: true })   // the server says running, no recent activity
  const WARM = s('k1', { agent_state: 'idle', state_source: 'hook', running: true, display_label: 'ready', first_prompt: 'ready', last_activity_at: '2026-11-07T14:00:00' })

  it('the list counts what the caption counts', () => {
    const all = [WAITS, RUNS, BUSY_WAITING, DONE, ENDED, YESTERDAY, QUIET_UP, WARM]
    const { kit } = petKit(all)
    const pose = kit.petPose(all), play = kit.petPlay(all)
    expect([play.waiting.length, play.running.length]).toEqual([pose.waiting, pose.working])
    expect(play.waiting.map((x: { session_id: string }) => x.session_id)).toEqual(['w1'])
    expect(play.running.map((x: { session_id: string }) => x.session_id)).toEqual(['r1', 'r2'])
    expect(play.done.map((x: { session_id: string }) => x.session_id), 'finished today only, never a readiness check').toEqual(['d1', 'd2'])
  })

  it('one in play opens its own sheet; several open the list; none does nothing', () => {
    const cases: Array<[unknown[], Array<[string, string]>]> = [
      [[], []],
      [[DONE, YESTERDAY], []],
      [[WAITS, DONE], [['wait', 'claude|w1']]],
      [[RUNS, DONE], [['run', 'claude|r1']]],
      [[BUSY_WAITING], [['wait', 'claude|r2']]],
      [[WAITS, RUNS], [['pet', '']]],
    ]
    for (const [sessions, want] of cases) {
      const { kit, opened } = petKit(sessions)
      kit.petTap({})
      expect(opened, JSON.stringify((sessions as Array<{ session_id: string }>).map(x => x.session_id))).toEqual(want)
    }
  })

  it('the pet is a Today button, not a link to Sessions; Change pet stays; with nothing in play it says it does nothing', () => {
    const pet = APP.slice(PET_START, PET_END)
    expect(pet.match(/class="pet-btn" data-today="pet"/g)).toHaveLength(2)
    expect(pet).not.toContain('class="pet-btn" data-goto="sessions"')
    expect(pet).toContain('data-goto="settings/pet">Change pet</button>')
    expect(APP).toContain("if (t.hasAttribute('data-today')) return t.getAttribute('data-today') === 'pet' ? petTap(t) : openTodayAction(t);")
    const { kit } = petKit([])
    const btn = new El(), box = { querySelector: () => btn }
    kit.petButtonState(box, { working: 0, waiting: 0 }, 'Nothing running')
    expect([btn.getAttribute('aria-disabled'), btn.getAttribute('aria-label')]).toEqual(['true', 'Nothing running'])
    kit.petButtonState(box, { working: 1, waiting: 1 }, '1 running, 1 waiting on you')
    expect([btn.getAttribute('aria-disabled'), btn.getAttribute('aria-label')]).toEqual(['false', '1 running, 1 waiting on you. Open'])
  })

  it('the list: waiting on you, then running, then done today; a row opens its own sheet in place, after the settle window', async () => {
    const pet = { waiting: [WAITS], running: [RUNS, BUSY_WAITING], done: [DONE, ENDED] }
    const h = load({ data: { sessions: [WAITS, RUNS, BUSY_WAITING, DONE, ENDED] }, pet })
    h.ta.open('pet', '', h.opener())
    await flush()
    expect(h.els['ta-title']!.textContent).toBe('Sessions')
    const body = h.els['ta-body']!.innerHTML
    const at = (t: string) => body.indexOf(t)
    expect(at('Waiting on you')).toBeGreaterThan(-1)
    expect(at('Waiting on you')).toBeLessThan(at('>Running<'))
    expect(at('>Running<')).toBeLessThan(at('Done today'))
    expect(body).toContain('data-kind="wait" data-id="claude|w1"')
    expect(body).toContain('data-kind="run" data-id="claude|r1"')
    expect(body, 'running by the caption’s count, but paused on you: it opens as waiting').toContain('data-kind="wait" data-id="claude|r2"')
    expect(body).toContain('data-kind="run" data-id="claude|d1"')
    expect(body).toContain('data-ta="open-sessions"')
    const rowTap = (kind: string, id: string) => {
      const b = { disabled: false, getAttribute: (a: string) => (({ 'data-ta': 'pet-open', 'data-kind': kind, 'data-id': id }) as Record<string, string>)[a] ?? null, closest() { return this } }
      const ev = { target: b, stopPropagation() { this.stopped = true }, preventDefault() {}, stopped: false }
      const fns = h.document.appended.listeners.click as Array<(e: unknown) => void>
      fns[0]!(ev); if (!ev.stopped) fns[1]!(ev)
      return !ev.stopped
    }
    expect(rowTap('wait', 'claude|w1'), 'the second half of the tap that opened the list').toBe(false)
    h.later(600)
    expect(rowTap('wait', 'claude|w1')).toBe(true)
    await flush()
    expect(h.ta._state.open).toMatchObject({ kind: 'wait', key: 'claude|w1' })
    expect(h.history.pushes, 'the list’s entry, then the session’s: Back returns to the list (6.99.27)').toBe(2)
    expect(h.history.state).toMatchObject({ cosTodayOverlay: 1, kind: 'wait', key: 'claude|w1', from: 'pet' })
  })

  it('6.99.27 (Miles’s iPhone): a session opened from the list has Back to sessions, to the list where it was scrolled; the phone’s Back does the same; X still closes', async () => {
    const pet = { waiting: [WAITS], running: [RUNS], done: [DONE] }
    const h = load({ data: { sessions: [WAITS, RUNS, DONE] }, pet })
    h.ta.open('pet', '', h.opener())
    await flush()
    expect(h.els['ta-back']!.hidden, 'the list itself has no Back').toBe(true)
    const rowOpen = async (kind: string, id: string) => {
      h.els['ta-body']!.scrollTop = 240
      h.later(600)
      const b = { disabled: false, getAttribute: (a: string) => (({ 'data-ta': 'pet-open', 'data-kind': kind, 'data-id': id }) as Record<string, string>)[a] ?? null, closest() { return this } }
      h.ta._onClick({ target: b })
      await flush()
      h.els['ta-body']!.scrollTop = 0   // the session's sheet starts at its top
    }
    // Back to sessions.
    await rowOpen('run', 'claude|r1')
    expect(h.ta._state.open).toMatchObject({ kind: 'run', key: 'claude|r1' })
    expect(h.els['ta-back']!.hidden).toBe(false)
    expect(h.els['ta-title']!.textContent).not.toBe('Sessions')
    expect([h.history.pushes, h.history.state]).toEqual([2, expect.objectContaining({ kind: 'run', from: 'pet' })])
    h.tap('back')
    await flush()
    expect(h.ta._state.open).toMatchObject({ kind: 'pet' })
    expect(h.els['ta-title']!.textContent).toBe('Sessions')
    expect(h.els['ta-body']!.scrollTop, 'where the list was').toBe(240)
    expect(h.els['ta-back']!.hidden).toBe(true)
    expect(h.history.backs, 'the session’s entry is taken off').toBe(1)
    h.pop()   // that back()'s own popstate
    expect(h.ta._state.open, 'and its popstate leaves the list open').toMatchObject({ kind: 'pet' })
    // The phone's Back.
    await rowOpen('wait', 'claude|w1')
    expect(h.history.pushes).toBe(3)
    h.pop()
    await flush()
    expect(h.ta._state.open).toMatchObject({ kind: 'pet' })
    expect(h.els['ta-body']!.scrollTop).toBe(240)
    expect(h.history.backs, 'the browser already went back').toBe(1)
    h.pop()
    expect(h.ta._state.open, 'Back again from the list closes the overlay').toBeNull()
    // X from a session opened off the list closes the overlay and takes both entries off at once.
    h.ta.open('pet', '', h.opener())
    await flush()
    await rowOpen('run', 'claude|r1')
    h.tap('close')
    expect(h.ta._state.open).toBeNull()
    expect(h.history.gos).toEqual([-2])
    h.pop()   // go(-2)'s popstate
    expect(h.ta._state.open).toBeNull()
    // A session opened from Today (not from the list) has no Back to sessions, and X takes one entry off as before.
    const backs = h.history.backs
    h.ta.open('run', 'claude|r1', h.opener())
    await flush()
    expect(h.els['ta-back']!.hidden).toBe(true)
    h.tap('close')
    expect([h.history.backs, h.history.gos]).toEqual([backs + 1, [-2]])
  })

  it('6.99.27: a reload on a session opened from the list keeps Back to sessions', async () => {
    const h = load({ data: { sessions: [RUNS] }, pet: { waiting: [], running: [RUNS], done: [] } })
    expect(await h.ta.restore({ cosTodayOverlay: 1, kind: 'run', key: 'claude|r1', from: 'pet' })).toBe(true)
    expect(h.els['ta-back']!.hidden).toBe(false)
    expect(h.history.pushes, 'the reloaded entry is reused').toBe(0)
    h.tap('back')
    await flush()
    expect(h.ta._state.open).toMatchObject({ kind: 'pet' })
    expect(h.history.backs).toBe(1)
  })

  it('with nothing in play the list says so (a reload onto it, say), and a reload reopens the list', async () => {
    const h = load({ pet: { waiting: [], running: [], done: [DONE] } })
    expect(await h.ta.restore({ cosTodayOverlay: 1, kind: 'pet', key: '' })).toBe(true)
    expect(h.ta._state.open).toMatchObject({ kind: 'pet' })
    expect(h.els['ta-body']!.innerHTML).toContain('Nothing is running or waiting on you now.')
    expect(h.els['ta-body']!.innerHTML).toContain('Done today')
  })

  it('a pet tap whose overlay fails opens Sessions and says so', () => {
    const start = APP.indexOf('  function openTodayAction('), end = APP.indexOf('  function setBadge(')
    const toasts: string[] = [], went: string[][] = []
    const deps = { ensurePane: () => Promise.reject(new Error('no overlay')), toast: (t: string) => toasts.push(t), go: (p: string, a: string[]) => went.push([p, ...a]),
      history: { state: null }, location: { replace: () => {} }, console: { error: () => {} } }
    // eslint-disable-next-line no-new-func
    const fn = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn openTodayAction;\n}')(deps)
    fn({ getAttribute: () => null }, 'pet', '')
    return flush().then(() => {
      expect(toasts).toEqual(['Could not open that here. Opening Sessions.'])
      expect(went).toEqual([['sessions']])
    })
  })

  // ── 6.99.27 (Miles 11/07 09:29, "there wasn't an option for the pet to interact with the questions") ──
  const QW = (id: string, sid: string, q = 'Ship it?') => HELD(id, sid, q)
  it('6.99.27: a question waiting here leads the caption, and its session is not counted again as waiting on you', () => {
    const one = petKit([WAITS, RUNS], undefined, [QW('pq_1', 'w1')])
    expect(one.kit.petCaption(one.kit.petPose([WAITS, RUNS], one.kit.petQuestions()))).toBe('1 question for you, 1 running')
    const other = petKit([WAITS, RUNS], undefined, [QW('pq_1', 'x9')])
    expect(other.kit.petCaption(other.kit.petPose([WAITS, RUNS], other.kit.petQuestions())), 'another session still waits on you').toBe('1 question for you, 1 running, 1 waiting on you')
    const two = petKit([], undefined, [QW('pq_1', 'w1'), QW('pq_2', 'x9')])
    expect(two.kit.petCaption(two.kit.petPose([], two.kit.petQuestions()))).toBe('2 questions for you')
    const nosid = petKit([WAITS, RUNS], undefined, [{ ...QW('pq_1', 'w1'), sessionId: '' }])
    expect(nosid.kit.petQuestions(), 'a held item with no session is not one the pet can open').toEqual([])
    const none = petKit([WAITS, RUNS])
    expect(none.kit.petCaption(none.kit.petPose([WAITS, RUNS], none.kit.petQuestions())), 'no question: the caption as before').toBe('1 running, 1 waiting on you')
    // QA 6.99.27 (User 6): a permission request is an approval, never a question.
    const AP = (id: string, sid: string) => ({ ...QW(id, sid), kind: 'approval', tool: 'Bash', questions: undefined, approval: { tool: 'Bash', summary: 'npm test', detail: 'npm test' } })
    const ap = petKit([WAITS, RUNS], undefined, [AP('pq_3', 'w1')])
    expect(ap.kit.petCaption(ap.kit.petPose([WAITS, RUNS], ap.kit.petQuestions()))).toBe('1 approval for you, 1 running')
    const both = petKit([], undefined, [QW('pq_1', 'w1'), AP('pq_3', 'x9')])
    expect(both.kit.petCaption(both.kit.petPose([], both.kit.petQuestions()))).toBe('1 question and 1 approval for you')
    const many = petKit([], undefined, [QW('pq_1', 'w1'), QW('pq_2', 'x9'), AP('pq_3', 'y1'), AP('pq_4', 'y2')])
    expect(many.kit.petCaption(many.kit.petPose([], many.kit.petQuestions()))).toBe('2 questions and 2 approvals for you')
    const pose = ap.kit.petPose([], ap.kit.petQuestions())
    expect([pose.pose, pose.questions, pose.approvals], 'an approval still takes the attention pose').toEqual(['attention', 0, 1])
    const btn = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v } }
    ap.kit.petButtonState({ querySelector: () => btn }, pose, '1 approval for you')
    expect(btn.attrs['aria-disabled'], 'a tap opens it').toBe('false')
    expect(none.kit.petCaption(none.kit.petPose([], []))).toBe('Nothing running')
  })

  it('6.99.27: a question waiting here is the attention pose, over every count (COS Control’s rule), with Control’s fallbacks', () => {
    const many = [RUNS, BUSY_WAITING, s('r3', { running_active: true }), s('r4', { running_active: true })]
    const { kit } = petKit(many, undefined, [QW('pq_1', 'w1')])
    expect(kit.petPose(many, kit.petQuestions()).pose).toBe('attention')
    expect(kit.petPose(many, []).pose, 'no question: the count pose').toBe('swarm')
    expect(kit.petPose([WAITS], []).pose).toBe('waiting')
    const poses = (names: string[]) => Object.fromEntries(names.map(n => [n, {}]))
    expect(kit.petPoseIn(poses(['idle', 'waiting', 'error', 'attention']), 'attention')).toBe('attention')
    expect(kit.petPoseIn(poses(['idle', 'waiting', 'error']), 'attention')).toBe('error')
    expect(kit.petPoseIn(poses(['idle', 'waiting']), 'attention')).toBe('waiting')
    expect(kit.petPoseIn(poses(['working', 'idle']), 'attention')).toBe('idle')
    expect(kit.petPoseIn(poses(['working']), 'attention'), 'a pack with none of the chain: its first pose').toBe('working')
    expect(kit.petPoseIn(poses(['working', 'idle']), 'swarm'), 'the count poses fall back as before').toBe('working')
    expect(kit.petPoseIn(poses(['working', 'idle']), 'done'), 'a pose with no chain: idle, as before').toBe('idle')
  })

  it('6.99.27: a tap with one session’s question opens its card; questions from several sessions open the list', () => {
    const cases: Array<[unknown[], unknown[], Array<[string, string]>]> = [
      [[WAITS, RUNS], [QW('pq_1', 'w1')], [['wait', 'claude|w1']]],
      [[RUNS], [QW('pq_1', 'q9'), QW('pq_2', 'q9', 'And this?')], [['wait', 'claude|q9']]],
      [[], [QW('pq_1', 'w1'), QW('pq_2', 'x9')], [['pet', '']]],
      [[RUNS], [], [['run', 'claude|r1']]],
      [[], [], []],
    ]
    for (const [sessions, questions, want] of cases) {
      const { kit, opened } = petKit(sessions, undefined, questions)
      kit.petTap({})
      expect(opened, JSON.stringify((questions as Array<{ id: string }>).map(q => q.id))).toEqual(want)
    }
  })

  it('6.99.27: with only a question waiting the pet is a live button', () => {
    const { kit } = petKit([])
    const btn = new El(), box = { querySelector: () => btn }
    kit.petButtonState(box, { working: 0, waiting: 0, questions: 1 }, '1 question for you')
    expect([btn.getAttribute('aria-disabled'), btn.getAttribute('aria-label')]).toEqual(['false', '1 question for you. Open'])
  })

  it('6.99.27: the list puts the questions first, one row per session opening its cards, and does not list that session again', async () => {
    const pet = { waiting: [WAITS], running: [RUNS, BUSY_WAITING], done: [DONE] }
    const held = [HELD('pq_1', 'w1', 'Publish to npm next?'), HELD('pq_2', 'w1', 'And the Hub?'), HELD('pq_3', 'n2', 'Which brand goes first?'), HELD('pq_4', 'r2', 'Merge it?')]
    const h = load({ data: { sessions: [WAITS, RUNS, BUSY_WAITING, DONE] }, pet, held })
    h.ta.open('pet', '', h.opener())
    await flush()
    const body = h.els['ta-body']!.innerHTML
    expect(body.indexOf('Questions for you')).toBeGreaterThan(-1)
    expect(body.indexOf('Questions for you')).toBeLessThan(body.indexOf('>Running<'))
    expect(body.match(/data-kind="wait" data-id="claude\|w1"/g), 'the session with the question once, as a question row').toHaveLength(1)
    expect(body.match(/data-id="claude\|r2"/g), 'a running session with a question: once, as a question row').toHaveLength(1)
    expect(body.indexOf('data-id="claude|r2"')).toBeLessThan(body.indexOf('>Running<'))
    expect(body).toContain('data-kind="run" data-id="claude|r1"')
    expect(body.indexOf('data-id="claude|w1"')).toBeLessThan(body.indexOf('data-id="claude|n2"'))
    expect(body).toContain('2 questions. Publish to npm next?')
    expect(body).toContain('Which brand goes first?')
    expect(body).toContain('A session asked you a question')
    expect(body, 'no session waits on you that is not a question row').not.toContain('Waiting on you')
    const one = load({ data: { sessions: [] }, pet: { waiting: [], running: [], done: [] }, held: [HELD('pq_9', 'n2', 'Ok?')] })
    one.ta.open('pet', '', one.opener())
    await flush()
    expect(one.els['ta-body']!.innerHTML).toContain('A question for you')
    expect(one.els['ta-body']!.innerHTML, 'a question is not nothing').not.toContain('Nothing is running')
    const none = load({ data: { sessions: [WAITS] }, pet: { waiting: [WAITS], running: [], done: [] } })
    none.ta.open('pet', '', none.opener())
    await flush()
    expect(none.els['ta-body']!.innerHTML, 'no question: the list as before').not.toContain('uestion')
    expect(none.els['ta-body']!.innerHTML).toContain('Waiting on you')
  })

  it('6.99.27: a change in the held questions repaints the pet as well as Needs you', () => {
    const m = /    questionsChanged: (function \(\) \{[^\n]*\})/.exec(APP)
    expect(m, 'COSWeb.today.questionsChanged').not.toBeNull()
    const run = (pane: string, at: number, offline = false) => {
      const did: string[] = []
      // eslint-disable-next-line no-new-func
      const fn = new Function('TODAY', 'state', 'paintNeeds', 'renderPet', 'return ' + m![1])({ at, offline }, { pane, sessions: [] }, () => did.push('needs'), () => did.push('pet'))
      fn()
      return did
    }
    expect(run('today', 1)).toEqual(['needs', 'pet'])
    expect(run('sessions', 1), 'off Today the pet is not drawn').toEqual(['needs'])
    expect(run('today', 1, true), 'an offline Today hides the pet').toEqual(['needs'])
    expect(run('today', 0), 'Today not read yet').toEqual([])
  })
})

describe('6.99.26: just answered, the row says so instead of pointing at the Mac', () => {
  const S1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const row = { ...WAIT, session_id: S1, display_label: 'Release QA', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
  it('answered here: the row and the sheet say Answered, never the Mac line, until a new question comes', async () => {
    const id = 'pq_' + 'e'.repeat(24)
    let body: unknown = { enabled: true, items: [HELD(id, S1, 'Ship it?')], settled: [] }
    const q = loadQ(() => body)
    await q.start()
    const mine = q.mk()
    q.Qs.mount(mine, S1)
    const fire = (t: string, target: unknown) => mine.listeners[t]!({ target })
    fire('change', { hasAttribute: (a: string) => a === 'data-sq-pick', getAttribute: (a: string) => (({ 'data-sq-id': id, 'data-q': '0', 'data-o': '0' }) as Record<string, string>)[a], checked: true })
    const send = { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'send' : a === 'data-sq-id' ? id : null) }) }
    fire('click', send); q.later(450); fire('click', send)
    await flush()
    expect(q.posts).toHaveLength(1)
    expect(q.Qs.answeredFor(S1)).toBe(true)
    const list = needsRegion({ at: WED_2PM, sessions: [row], qs: q.Qs }).els['needs-list']!.innerHTML
    expect(list).toContain('data-where="answered">Answered. The session carries on.<')
    expect(list).not.toContain('Mac&#39;s prompt')
    // The next question for the same session is held here: not "answered" any more.
    body = { enabled: true, items: [HELD('pq_' + 'h'.repeat(24), S1, 'And the changelog?')], settled: [] }
    q.Qs.poll(); await flush()
    expect(q.Qs.answeredFor(S1)).toBe(false)
    // A newer question at the Mac for the same session wins again.
    body = { enabled: true, items: [], settled: [AT_MAC('pq_' + 'f'.repeat(24), S1, { settledAt: new Date(Date.now() + 60_000).toISOString() })] }
    q.Qs.poll(); await flush()
    expect(q.Qs.answeredFor(S1)).toBe(false)
    expect(needsRegion({ at: WED_2PM, sessions: [row], qs: q.Qs }).els['needs-list']!.innerHTML).toContain(MAC_WORDS)
  })

  it('answered on another screen (settled answered), for two minutes only', async () => {
    const answered = { ...AT_MAC('pq_' + 'g'.repeat(24), S1), resolution: 'answered', waitingAtMac: false, settledAt: new Date().toISOString() }
    const q = loadQ(() => ({ enabled: true, items: [], settled: [answered] }))
    await q.start()
    expect(q.Qs.answeredFor(S1)).toBe(true)
    expect(q.Qs.answeredFor('someone-else')).toBe(false)
    q.later(121_000)
    expect(q.Qs.answeredFor(S1)).toBe(false)
  })

  it('the sheet: Answered, no Mac line, no reply box', async () => {
    const SID = 'eeeeeeee-5555-4555-8555-555555555555'
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release QA', alive: true, running: true, running_active: false, agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
    const h = load({ data: { sessions: [ROW] }, routes: { [`GET /api/agent-sessions/claude/${SID}?turns=6&cards=1`]: { status: 200, body: { recent_turns: [] } } }, questions: 0 })
    ;(h.ctx as any).window.COSWeb.sessionQuestions.answeredFor = (id: string) => id === SID
    ;(h.ctx as any).window.COSWeb.sessionQuestions.answeredLine = 'Answered. The session carries on.'
    h.ta.open('wait', 'claude|' + SID, h.opener())
    await flush()
    expect(h.els['ta-meta']!.innerHTML).toContain('Answered. The session carries on.')
    expect(h.els['ta-meta']!.innerHTML).not.toContain('Mac&#39;s prompt')
    expect(h.els['ta-foot']!.hidden).toBe(true)
  })
})

describe('6.99.26: a held question reads like the terminal, and Submit sends one answer (Miles 11/07)', () => {
  const ID = 'pq_' + 't'.repeat(24)
  const ITEM2 = { ...HELD(ID, 'sess-t', ''), questions: [
    { question: 'What should a pet tap open?', header: 'Pet tap', multiSelect: false, options: [
      { label: 'The Sessions tab', description: 'As today.' }, { label: 'Open what matters', description: 'One session: its sheet. Several: a short list.' }] },
    { question: 'Which steps should run?', header: 'Publish', multiSelect: true, options: [
      { label: 'Bump', description: 'Version touchpoints.' }, { label: 'Test', description: '' }, { label: 'Publish', description: 'npm next.' }] },
  ] }
  async function card() {
    const q = loadQ(() => ({ enabled: true, items: [ITEM2], settled: [] }))
    await q.start()
    const el = q.mk()
    q.Qs.mount(el, 'sess-t')
    const block = (qi: number, focus?: () => void) => ({ getAttribute: (a: string) => (a === 'data-sq-id' ? ID : a === 'data-sq-qblock' ? String(qi) : null), querySelector: (sel: string) => (sel.includes('data-sq-other') ? { focus: focus ?? (() => {}) } : null) })
    const key = (k: string, qi: number, opts: { other?: boolean; meta?: boolean; focus?: () => void } = {}) => {
      let prevented = false
      el.listeners.keydown!({ key: k, metaKey: !!opts.meta, ctrlKey: false, altKey: false, preventDefault: () => { prevented = true },
        target: { hasAttribute: (a: string) => !!opts.other && a === 'data-sq-other', closest: (sel: string) => (sel === '[data-sq-qblock]' ? block(qi, opts.focus) : null) } })
      return prevented
    }
    const pick = (qi: number, oi: number, checked = true) => el.listeners.change!({ target: { hasAttribute: (a: string) => a === 'data-sq-pick', getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': String(qi), 'data-o': String(oi) }) as Record<string, string>)[a], checked } })
    const other = (qi: number, value: string) => el.listeners.input!({ target: { value, hasAttribute: (a: string) => a === 'data-sq-other', getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': String(qi) }) as Record<string, string>)[a] } })
    const submit = () => el.listeners.click!({ target: { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'send' : a === 'data-sq-id' ? ID : null) }) } })
    return { q, el, key, pick, other, submit }
  }

  it('draws the strip, bold questions, numbered options with descriptions, Other as the last number, and the review', async () => {
    const { el } = await card()
    const html = el.innerHTML
    expect(html).toContain('<nav class="sq-steps" aria-label="Questions">')
    expect(words(html)).toContain('☐ Pet tap')
    expect(words(html)).toContain('☐ Publish')
    expect(words(html)).toContain('✓ Submit')
    expect(html).toContain('<legend class="sq-q-text">What should a pet tap open?</legend>')
    expect(html.match(/<span class="sq-num" aria-hidden="true">(\d+)\.<\/span>/g)!.map(x => x.replace(/<[^>]*>/g, '')), 'numbered from 1, Other last').toEqual(['1.', '2.', '3.', '1.', '2.', '3.', '4.'])
    expect(html).toContain('<span class="sq-num" aria-hidden="true">3.</span><input class="field sq-other"')   // Other is 3 for the two-option question
    expect(html).toContain('<span class="sq-num" aria-hidden="true">4.</span><input class="field sq-other"')   // and 4 for the three-option one
    expect(html).toContain('<span class="sq-option-desc">One session: its sheet. Several: a short list.</span>')
    expect(html).toContain('type="checkbox"')
    // 6.99.27: what each question needs, honestly (the broker takes no empty multi-select answer).
    expect(html).toContain('<p class="sq-need" data-sq-need="0" data-state="todo">Pick one.</p>')
    expect(html).toContain('<p class="sq-need" data-sq-need="1" data-state="todo">Pick one or more.</p>')
    expect(html).not.toContain('Pick any that apply')
    expect(words(html)).toContain('Your answers')
    expect(words(html)).toContain('Not answered yet')
    // The footer: progress, and an answer button that is never greyed out for a missing answer.
    expect(html).toContain('<div class="sq-foot" data-sq-foot="')
    expect(html).toContain('role="status">0 of 2 answered</p>')
    expect(html).toMatch(/data-sq="send" data-sq-id="[^"]+">Review and submit</)
  })

  it('answered by tap, number key and Other, reviewed, then one POST with the answer body questions.js always sent', async () => {
    const { q, el, key, pick, other, submit } = await card()
    expect(key('2', 0), 'key 2 picks the second option').toBe(true)
    pick(1, 0)                       // tap Bump
    expect(key('3', 1)).toBe(true)   // key 3 adds Publish (multi-select)
    expect(key('2', 1, { other: true }), 'typing in Other is never a pick').toBe(false)
    expect(key('1', 1, { meta: true }), 'a shortcut with a modifier is left alone').toBe(false)
    expect(key('9', 1), 'past the last number').toBe(false)
    let focused = 0
    expect(key('4', 1, { focus: () => { focused++ } }), 'the last number goes to Other').toBe(true)
    expect(focused).toBe(1)
    other(1, 'Notarize first')
    const html = el.innerHTML
    expect(words(html)).toContain('☒ Pet tap')
    expect(words(html)).toContain('☒ Publish')
    expect(words(html)).toContain('Open what matters')
    expect(words(html)).toContain('Bump, Publish, Notarize first')
    expect(words(html)).not.toContain('Not answered yet')
    submit()
    expect(el.innerHTML).toContain('Tap again to submit')
    expect(q.posts).toEqual([])
    q.later(450)
    submit()
    await flush()
    expect(q.posts).toHaveLength(1)
    expect(q.posts[0]!.path).toBe(`/api/session-questions/${ID}/answer`)
    expect(q.posts[0]!.body.answers).toEqual([{ labels: ['Open what matters'] }, { labels: ['Bump', 'Publish'], other: 'Notarize first' }])
    expect(q.posts[0]!.body.clientAnswerId).toMatch(/^gw_[0-9a-f]{24}$/)
  })

  it('a change after Submit is armed takes the arm back; a double submit sends once', async () => {
    const { q, el, key, pick, submit } = await card()
    key('1', 0); pick(1, 1)
    submit()
    expect(el.innerHTML).toContain('Tap again to submit')
    key('2', 0)                       // changed their mind while armed
    expect(el.innerHTML).not.toContain('Tap again to submit')
    q.later(450); submit()
    expect(q.posts, 'the tap after a change only arms again').toEqual([])
    q.later(450)
    submit(); submit(); submit()      // a bounce on the confirming tap
    await flush()
    expect(q.posts).toHaveLength(1)
    expect(q.posts[0]!.body.answers).toEqual([{ labels: ['Open what matters'] }, { labels: ['Test'] }])
    submit(); q.later(450); submit()
    await flush()
    expect(q.posts, 'answered: nothing left to send').toHaveLength(1)
  })

  it('a pick or a key while sending changes nothing', async () => {
    const { q, key, pick, submit } = await card()
    key('1', 0); pick(1, 0)
    submit(); q.later(450); submit()
    // The POST is out: Q.sending holds until it answers.
    expect(key('2', 0)).toBe(false)
    pick(1, 2)
    expect(q.Qs._state.picks[ID][1].labels, 'a tap while sending changes nothing').toEqual(['Bump'])
    await flush()
    expect(q.posts[0]!.body.answers).toEqual([{ labels: ['The Sessions tab'] }, { labels: ['Bump'] }])
  })

  it('a number key toggles a multi-select option; a single question has no strip and no review', async () => {
    const { q, key } = await card()
    key('1', 1); key('3', 1); key('1', 1)
    expect(q.Qs._state.picks[ID][1].labels).toEqual(['Publish'])
    key('1', 0); key('2', 0)
    expect(q.Qs._state.picks[ID][0].labels, 'single choice: the last number wins').toEqual(['Open what matters'])
    const one = loadQ(() => ({ enabled: true, items: [HELD('pq_' + 'u'.repeat(24), 'sess-u', 'Ship it?')], settled: [] }))
    await one.start()
    const el = one.mk()
    one.Qs.mount(el, 'sess-u')
    expect(el.innerHTML).not.toContain('sq-steps')
    expect(el.innerHTML).not.toContain('sq-review')
    expect(el.innerHTML).toContain('<span class="sq-num" aria-hidden="true">3.</span><input class="field sq-other"')
  })

  it('the drawn card follows each pick in place: the strip, the boxes, the answers and Submit', async () => {
    const { q, el, pick } = await card()
    const fake = (attrs: Record<string, string>) => ({ attrs, textContent: '', innerHTML: '', checked: false, disabled: false, getAttribute: (a: string) => attrs[a] ?? null })
    const steps = [fake({ 'data-sq-step': '0' }), fake({ 'data-sq-step': '1' }), fake({ 'data-sq-step': 'submit' })]
    steps[2]!.textContent = 'kept'
    const send = fake({}), review = fake({}), progress = fake({})
    const needs = [fake({ 'data-sq-need': '0' }), fake({ 'data-sq-need': '1' })]
    for (const x of [progress, ...needs]) { (x as any).setAttribute = (k: string, v: string) => { x.attrs[k] = v }; (x as any).removeAttribute = (k: string) => { delete x.attrs[k] } }
    const radios = [0, 1].map(o => fake({ 'data-o': String(o) }))
    const cardEl = { querySelector: (sel: string) => (sel === '[data-sq="send"]' ? send : sel === '[data-sq-review] .sq-review-list' ? review : sel === '[data-sq-progress]' ? progress : null),
      querySelectorAll: (sel: string) => (sel === '[data-sq-step]' ? steps : sel === '[data-sq-need]' ? needs : []) }
    ;(el as any).querySelector = (sel: string) => (sel === `[data-sq-card="${ID}"]` ? cardEl : null)
    ;(el as any).querySelectorAll = (sel: string) => (sel === `[data-sq-pick][data-sq-id="${ID}"][data-q="0"]` ? radios : [])
    const before = el.innerHTML
    pick(0, 1)
    expect(el.innerHTML, 'patched in place, never redrawn').toBe(before)
    expect(steps.map(x => x.textContent)).toEqual(['☒ Pet tap', '☐ Publish', 'kept'])
    expect(radios.map(x => x.checked)).toEqual([false, true])
    expect(review.innerHTML).toContain('Open what matters')
    expect(review.innerHTML).toContain('Not answered yet')
    expect([send.textContent, send.disabled], 'never greyed out for a missing answer').toEqual(['Review and submit', false])
    expect(progress.textContent).toBe('1 of 2 answered')
    expect(needs.map(x => x.attrs['data-state'])).toEqual(['done', 'todo'])
    // Submit with Publish empty: the footer says so in place, flagged.
    el.listeners.click!({ target: { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'send' : a === 'data-sq-id' ? ID : null) }) } })
    expect([progress.textContent, progress.attrs['data-alert']]).toEqual(['Publish still needs an answer. Pick one or more.', '1'])
    pick(1, 0)
    expect(progress.attrs['data-alert'], 'a pick clears the flag').toBeUndefined()
    expect([send.textContent, send.disabled]).toEqual(['Review and submit', false])
    expect(progress.textContent).toBe('2 of 2 answered')
    expect(needs.map(x => x.attrs['data-state'])).toEqual(['done', 'done'])
    void q
  })

  it('the strip jumps to a question, or to the answers with Submit focused', async () => {
    const { el } = await card()
    const calls: string[] = []
    const input = { focus: () => calls.push('focus input'), disabled: false }
    const block = { scrollIntoView: () => calls.push('scroll q1'), querySelector: () => input }
    const reviewEl = { scrollIntoView: () => calls.push('scroll review'), querySelector: () => null }
    const sendEl = { focus: () => calls.push('focus submit'), disabled: false }
    const cardEl = { querySelector: (sel: string) => (sel === '[data-sq-qblock="1"]' ? block : sel === '[data-sq-review]' ? reviewEl : sel === '[data-sq="send"]' ? sendEl : null) }
    const step = (n: string) => el.listeners.click!({ target: { closest: () => ({ disabled: false, closest: (sel: string) => (sel === '.sq-card' ? cardEl : null),
      getAttribute: (a: string) => (a === 'data-sq' ? 'step' : a === 'data-sq-id' ? ID : a === 'data-sq-step' ? n : null) }) } })
    step('1'); step('submit')
    expect(calls).toEqual(['scroll q1', 'focus input', 'scroll review', 'focus submit'])
  })
})

describe('QA round 1 (6.99.26): after an answer, and when the Mac cannot be reached', () => {
  const ID = 'pq_' + 'v'.repeat(24), SID = 'sess-v'
  const tap = (el: any, what: string) => el.listeners.click!({ target: { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? what : a === 'data-sq-id' ? ID : null) }) } })
  const pickFirst = (el: any) => el.listeners.change!({ target: { hasAttribute: (a: string) => a === 'data-sq-pick', getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': '0', 'data-o': '0' }) as Record<string, string>)[a], checked: true } })
  async function sent(post: (path: string, body: any) => Promise<unknown>, item: Record<string, unknown> = HELD(ID, SID, 'Ship it?'), what = 'send') {
    const q = loadQ(() => ({ enabled: true, items: [item], settled: [] }), { post })
    await q.start()
    const el = q.mk(), seen: boolean[] = []
    q.Qs.mount(el, SID, () => { seen.push(q.Qs.answeredFor(SID)) })
    if (what === 'send') pickFirst(el)
    tap(el, what); q.later(450); tap(el, what)
    await flush()
    return { q, el, seen }
  }
  it('a successful answer: the waiting sheet already reads Answered as it redraws, and Today reads its lists again', async () => {
    const { q, seen } = await sent(() => Promise.resolve({ ok: true }))
    expect(q.posts).toHaveLength(1)
    expect(seen.at(-1), 'the sheet repaints with the answer already recorded').toBe(true)
    expect(q.refreshed()).toBe(1)
    expect(q.changed()).toBeGreaterThanOrEqual(2)
  })
  it('already answered on another screen: recorded as answered, Today told and refreshed', async () => {
    const refused = Object.assign(new Error('refused'), { status: 409, code: 'already_answered' })
    const { q, seen } = await sent(() => Promise.reject(refused))
    expect(q.Qs.answeredFor(SID)).toBe(true)
    expect(seen.at(-1)).toBe(true)
    expect(q.refreshed()).toBe(1)
  })
  it('another refusal is not an answer: no Answered, no refresh', async () => {
    const refused = Object.assign(new Error('refused'), { status: 409, code: 'expired' })
    const { q } = await sent(() => Promise.reject(refused))
    expect(q.Qs.answeredFor(SID)).toBe(false)
    expect(q.refreshed()).toBe(0)
  })
  it('no status at all (offline, a timeout): "Could not reach your Mac", naming the button to tap', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'))
    const a = await sent(offline)
    expect(a.el.innerHTML).toContain('Could not reach your Mac. Tap Submit to retry.')
    expect(a.q.Qs.answeredFor(SID)).toBe(false)
    const approval = { ...HELD(ID, SID, ''), kind: 'approval', tool: 'Bash', questions: undefined, approval: { tool: 'Bash', summary: 'npm test', detail: 'npm test' } }
    expect((await sent(offline, approval, 'allow')).el.innerHTML).toContain('Could not reach your Mac. Tap Allow once to retry.')
    expect((await sent(offline, approval, 'deny')).el.innerHTML).toContain('Could not reach your Mac. Tap Deny to retry.')
    const late = Object.assign(new Error('Your Mac did not answer in 20 seconds.'), { code: 'timeout' })
    expect((await sent(() => Promise.reject(late))).el.innerHTML).toContain('Could not reach your Mac. Tap Submit to retry.')
    const leave = loadQ(() => ({ enabled: true, items: [HELD(ID, SID, 'Ship it?')], settled: [] }), { post: offline })
    await leave.start()
    const el = leave.mk(); leave.Qs.mount(el, SID); tap(el, 'leave'); await flush()
    expect(el.innerHTML).toContain('Could not reach your Mac. Tap Leave for the Mac to retry.')
    // A server that answered with an error is not "could not reach".
    const broken = await sent(() => Promise.reject(Object.assign(new Error('The server answered 500.'), { status: 500 })))
    expect(broken.el.innerHTML).toContain('Not sent: The server answered 500. Tap again to retry.')
    // The retry goes under the same clientAnswerId.
    tap(a.el, 'send'); a.q.later(450); tap(a.el, 'send'); await flush()
    expect(a.q.posts.map(p => p.body.clientAnswerId)).toEqual([a.q.posts[0]!.body.clientAnswerId, a.q.posts[0]!.body.clientAnswerId])
  })
})

describe('QA round 1 (6.99.26): a sheet after a waiting sheet shows its foot again (openIntake)', () => {
  it('Open Sort in Work is visible after a Claude waiting sheet hid the reply box', async () => {
    const SID = 'eeeeeeee-5555-4555-8555-555555555555'
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release QA', alive: true, running: true, running_active: false, agent_state: 'waiting', state_source: 'hook', waiting_kind: 'question', waiting_detail: 'AskUserQuestion' }
    const h = load({ data: { sessions: [ROW], intake: [ITEM(ID1, 'Roundtable branding')] }, routes: { [`GET /api/agent-sessions/claude/${SID}?turns=6&cards=1`]: { status: 200, body: { recent_turns: [] } } }, questions: 0 })
    h.ta.open('wait', 'claude|' + SID, h.opener())
    await flush()
    expect(h.els['ta-foot']!.hidden).toBe(true)
    h.ta.close('user')
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    await flush()
    expect(h.els['ta-foot']!.innerHTML).toContain('Open Sort in Work')
    expect(h.els['ta-foot']!.hidden).toBe(false)
  })
})

describe('6.99.27: the card answers on a phone (Miles 11/07 09:32, "It’s not allowing me to answer the Qs")', () => {
  const ID = 'pq_' + 'w'.repeat(24), SID = 'sess-w'
  const TWO = { ...HELD(ID, SID, ''), questions: [
    { question: 'Where should it show first?', header: 'Where', multiSelect: false, options: [{ label: 'On the phone, Today', description: '' }, { label: 'Sessions', description: '' }] },
    { question: 'Which parts look right?', header: 'Card check', multiSelect: true, options: [{ label: 'Numbered options', description: '' }, { label: 'Descriptions', description: '' }] },
  ] }
  // A drawn card as the browser has it: each question block, the answers to review and Submit, recording what is
  // scrolled into view and focused.
  function cardDom() {
    const calls: string[] = []
    const input = (name: string) => ({ disabled: false, focus: () => calls.push('focus ' + name) })
    const blocks = [0, 1].map(qi => ({ scrollIntoView: (o: { block: string; behavior: string }) => calls.push(`scroll q${qi} ${o.block} ${o.behavior}`), querySelector: () => input('q' + qi) }))
    const review = { scrollIntoView: (o: { block: string; behavior: string }) => calls.push(`scroll review ${o.block} ${o.behavior}`) }
    const send = { disabled: false, focus: () => calls.push('focus submit') }
    const card = { querySelector: (sel: string) => (sel === '[data-sq-qblock="0"]' ? blocks[0] : sel === '[data-sq-qblock="1"]' ? blocks[1] : sel === '[data-sq-review]' ? review : sel === '[data-sq="send"]' ? send : null) }
    return { card, calls }
  }
  async function setup(opt: { reduced?: boolean; item?: unknown; post?: (path: string, body: any) => Promise<unknown> } = {}) {
    const q = loadQ(() => ({ enabled: true, items: [opt.item ?? TWO], settled: [] }), { reduced: opt.reduced, post: opt.post })
    await q.start()
    const el = q.mk()
    q.Qs.mount(el, SID)
    const dom = cardDom()
    const pick = (qi: number, oi: number, checked = true) => el.listeners.change!({ target: { closest: (sel: string) => (sel === '.sq-card' ? dom.card : null), hasAttribute: (a: string) => a === 'data-sq-pick',
      getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': String(qi), 'data-o': String(oi) }) as Record<string, string>)[a], checked } })
    const tap = (what: string, extra: Record<string, string> = {}) => el.listeners.click!({ target: { closest: () => ({ disabled: false, closest: (sel: string) => (sel === '.sq-card' ? dom.card : null),
      getAttribute: (a: string) => (a === 'data-sq' ? what : a === 'data-sq-id' ? ID : extra[a] ?? null) }) } })
    const runAdvance = () => { const due = q.timers.filter(t => t.ms === q.Qs._advanceMs); q.timers.splice(0, q.timers.length, ...q.timers.filter(t => t.ms !== q.Qs._advanceMs)); due.forEach(t => t.fn()) }
    return { q, el, dom, pick, tap, runAdvance }
  }

  it('his state, Q1 picked and Q2 empty: Submit says what is missing and goes to it, never a dead button', async () => {
    const { q, el, dom, pick, tap, runAdvance } = await setup()
    pick(0, 0); runAdvance(); dom.calls.length = 0
    expect(el.innerHTML).toMatch(/data-sq="send" data-sq-id="[^"]+">Review and submit</)
    tap('send')
    expect(q.posts).toEqual([])
    expect(el.innerHTML).toContain('data-alert="1">Card check still needs an answer. Pick one or more.</p>')
    expect(el.innerHTML, 'not armed: nothing to confirm yet').not.toContain('Tap again to submit')
    expect(dom.calls).toEqual(['scroll q1 start smooth', 'focus q1'])
    pick(1, 0)
    expect(el.innerHTML).not.toContain('data-alert')
    expect(el.innerHTML).toContain('role="status">2 of 2 answered</p>')
    dom.calls.length = 0
    tap('send')
    expect(el.innerHTML).toContain('Tap again to submit')
    expect(dom.calls, 'the first tap is the review').toEqual(['scroll review nearest smooth', 'focus submit'])
    q.later(450); tap('send'); await flush()
    expect(q.posts).toHaveLength(1)
    expect(q.posts[0]!.body.answers).toEqual([{ labels: ['On the phone, Today'] }, { labels: ['Numbered options'] }])
  })

  it('a pick on a single-choice question moves on to the next unanswered one, then to Submit; a multi-select pick stays', async () => {
    const { dom, pick, runAdvance } = await setup()
    pick(0, 1)
    expect(dom.calls, 'not before the pick has shown').toEqual([])
    runAdvance()
    expect(dom.calls).toEqual(['scroll q1 start smooth', 'focus q1'])
    dom.calls.length = 0
    pick(1, 0); runAdvance()
    expect(dom.calls, 'multi-select: more may follow, so it stays').toEqual([])
    pick(0, 0); runAdvance()
    expect(dom.calls, 'everything answered: on to the review and Submit').toEqual(['scroll review nearest smooth', 'focus submit'])
  })

  it('a number key on a single-choice question advances too; reduced motion jumps instead of gliding', async () => {
    const { q, dom, el, runAdvance } = await setup({ reduced: true })
    const block = { getAttribute: (a: string) => (a === 'data-sq-id' ? ID : a === 'data-sq-qblock' ? '0' : null), querySelector: () => null, closest: (sel: string) => (sel === '.sq-card' ? dom.card : null) }
    el.listeners.keydown!({ key: '1', preventDefault() {}, target: { hasAttribute: () => false, closest: (sel: string) => (sel === '[data-sq-qblock]' ? block : null) } })
    runAdvance()
    expect(dom.calls).toEqual(['scroll q1 start auto', 'focus q1'])
    void q
  })

  it('the strip brings a question to the top, or the review and Submit into view', async () => {
    const { dom, tap } = await setup()
    tap('step', { 'data-sq-step': '1' })
    tap('step', { 'data-sq-step': 'submit' })
    expect(dom.calls).toEqual(['scroll q1 start smooth', 'focus q1', 'scroll review nearest smooth', 'focus submit'])
  })

  it('one question: no advance, "Not answered yet. Pick one." then "Ready to submit.", and a plain Submit', async () => {
    const { el, dom, pick, runAdvance } = await setup({ item: HELD(ID, SID, 'Ship it?') })
    expect(el.innerHTML).toContain('role="status">Not answered yet. Pick one.</p>')
    expect(el.innerHTML).toMatch(/data-sq="send" data-sq-id="[^"]+">Submit</)
    pick(0, 0); runAdvance()
    expect(dom.calls).toEqual([])
    expect(el.innerHTML).toContain('role="status">Ready to submit.</p>')
  })

  // QA 6.99.27 (User 7): the retry named "Submit" while the button read "Review and submit".
  it('a card of two questions that cannot reach the Mac names its own button: Review and submit', async () => {
    const { q, el, pick, tap, runAdvance } = await setup({ post: () => Promise.reject(new TypeError('Failed to fetch')) })
    pick(0, 0); runAdvance(); pick(1, 0); runAdvance()
    tap('send'); q.later(450); tap('send'); await flush()
    expect(q.posts).toHaveLength(1)
    expect(el.innerHTML).toContain('Could not reach your Mac. Tap Review and submit to retry.')
    expect(el.innerHTML).toMatch(/data-sq="send" data-sq-id="[^"]+">Review and submit</)
  })

  // QA 6.99.27 (User 2): Today's own card put its sticky footer under the iOS keyboard. The page now lifts it by the
  // keyboard's height, read from visualViewport; the overlay's footer sits at the sheet's bottom.
  it('the page card’s footer rides above the keyboard (visualViewport); the overlay’s sits at the bottom of the sheet', async () => {
    const q = loadQ(() => ({ enabled: true, items: [], settled: [] }), { vv: { height: 800, offsetTop: 0 }, innerHeight: 800 })
    await q.start()
    expect(q.vvListeners.resize?.length, 'it listens to the visible viewport').toBe(1)
    expect(q.vvListeners.scroll?.length).toBe(1)
    q.viewport(464)                     // the keyboard takes 336 px
    expect(q.host.style.props['--sq-kb']).toBe('336px')
    q.viewport(464, 120)                // scrolled while it is up: the visible part moved down
    expect(q.host.style.props['--sq-kb']).toBe('216px')
    q.viewport(800)                     // the keyboard went away
    expect(q.host.style.props['--sq-kb']).toBe('0px')
    q.viewport(900)                     // never below zero
    expect(q.host.style.props['--sq-kb']).toBe('0px')
    // 6.99.30: a pinch zoom alone lifts nothing (app.js viewportFit): at 2x the visible part is half the height.
    Object.assign(q.qWin.visualViewport, { scale: 2 }); q.viewport(400, 0)
    expect(q.host.style.props['--sq-kb'], 'zoomed, no keyboard').toBe('0px')
    Object.assign(q.qWin.visualViewport, { scale: 1 })
    const css = readFileSync(join(HERE, 'panes', 'questions.css'), 'utf8')
    expect(css).toContain('.sq-host .sq-foot { bottom: max(var(--safe-bottom, 0px), var(--sq-kb, 0px)); }')
    expect(css).toContain('.ta-q .sq-foot { bottom: 0; }')
    // No visualViewport (an older browser): nothing breaks and nothing is set.
    const old = loadQ(() => ({ enabled: true, items: [], settled: [] }))
    await old.start()
    expect(old.host.style.props).toEqual({})
  })

  it('the footer is sticky inside the card and the questions clear the top bar and the footer (questions.css)', () => {
    const css = readFileSync(join(HERE, 'panes', 'questions.css'), 'utf8')
    expect(css).toMatch(/\.sq-foot \{ position: sticky; bottom: var\(--safe-bottom, 0px\);/)
    expect(css).toMatch(/\.sq-q \{ scroll-margin-top: calc\(var\(--topbar-h, 48px\) \+ var\(--safe-top, 0px\) \+ 12px\); scroll-margin-bottom: 150px; \}/)
  })

  it('typing your own answer also clears the "still needs an answer" line', async () => {
    const { el, tap } = await setup()
    tap('send')
    expect(el.innerHTML).toContain('data-alert="1">Where still needs an answer. Pick one.</p>')
    el.listeners.input!({ target: { value: 'Both screens', hasAttribute: (a: string) => a === 'data-sq-other', getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': '0' }) as Record<string, string>)[a] } })
    expect(el.innerHTML).not.toContain('data-alert')
    expect(el.innerHTML).toContain('role="status">1 of 2 answered</p>')
  })

  it('the missing line goes once that question is answered, even while another is still open', async () => {
    const { el, tap, pick, runAdvance } = await setup()
    tap('send')
    expect(el.innerHTML).toContain('data-alert="1">Where still needs an answer. Pick one.</p>')
    pick(0, 0); runAdvance()
    expect(el.innerHTML).not.toContain('data-alert')
    expect(el.innerHTML).toContain('role="status">1 of 2 answered</p>')
    tap('send')
    expect(el.innerHTML, 'the next tap names the next one').toContain('data-alert="1">Card check still needs an answer. Pick one or more.</p>')
  })
})


describe('6.99.27: a question reaches Today in 3 s, not 10 (Miles 11/07 09:29, "a big delay to see the questions on the homepage")', () => {
  const last = (h: ReturnType<typeof loadQ>) => h.timers[h.timers.length - 1]!
  const idle = () => ({ enabled: true, items: [], settled: [], pollIntervalMs: 10_000 })

  it('on Today it reads every 3 s; elsewhere at the server’s idle pace; hidden it reads nothing', async () => {
    const h = loadQ(idle)
    h.W.state = { pane: 'sessions' }
    await h.start()
    expect(h.Qs._todayPollMs).toBe(3000)
    expect(last(h).ms, 'off Today, idle: the server’s 10 s').toBe(10_000)
    h.W.state = { pane: 'today' }
    h.Qs.poll(); await flush()
    expect(last(h).ms, 'on Today, idle: 3 s').toBe(3000)
    // The server's own pace is never slowed: a faster one wins.
    const fast = loadQ(() => ({ ...idle(), pollIntervalMs: 2000 }))
    fast.W.state = { pane: 'today' }
    await fast.start()
    expect(last(fast).ms).toBe(2000)
    // While one waits it is 3 s anywhere, as before.
    const held = loadQ(() => ({ enabled: true, items: [HELD('pq_1', 'aaaa', 'Ok?')], settled: [], pollIntervalMs: 3000 }))
    held.W.state = { pane: 'work' }
    await held.start()
    expect(last(held).ms).toBe(3000)
    // Hidden: no read, and the timer that fires finds a hidden page and reads nothing.
    const n = h.fetches.length
    h.visible(false)
    last(h).fn(); await flush()
    expect(h.fetches.length).toBe(n)
  })

  // QA 6.99.27 (N4): coming back goes through nudge: at once, unless a read went out under a second ago.
  it('visible again: one read at once, never within a second of the last', async () => {
    const h = loadQ(idle)
    h.W.state = { pane: 'today' }
    await h.start()
    h.visible(false)
    const n = h.fetches.length
    h.visible(true)
    expect(last(h).ms, 'back within the second: at its end').toBeGreaterThan(900)
    expect(last(h).ms).toBeLessThanOrEqual(1000)
    h.visible(false)
    h.later(5_000)
    h.visible(true)
    expect(last(h).ms, 'back later: at once').toBe(0)
    last(h).fn(); await flush()
    expect(h.fetches.length).toBe(n + 1)
  })

  // QA 6.99.27 (N4): a mount read at once whatever the gap; now it goes through nudge.
  it('drawing cards into the overlay asks for a read through the 1 s gap, never a second one on the wire', async () => {
    const h = loadQ(idle)
    h.W.state = { pane: 'today' }
    await h.start()
    h.Qs.mount(h.mk(), 'sess-a')
    expect(last(h).ms, 'a read went out a moment ago').toBeGreaterThan(900)
    expect(last(h).ms).toBeLessThanOrEqual(1000)
    h.later(2_000)
    h.Qs.mount(h.mk(), 'sess-b')
    expect(last(h).ms).toBe(0)
  })

  it('coming to Today reads at once, never more often than once a second', async () => {
    const h = loadQ(idle)
    h.W.state = { pane: 'work' }
    await h.start()
    h.W.state = { pane: 'today' }
    h.route('today')
    expect(last(h).ms, 'a read went out a moment ago: at the end of the second').toBeGreaterThan(900)
    expect(last(h).ms).toBeLessThanOrEqual(1000)
    h.later(5000)
    h.route('today')
    expect(last(h).ms, 'five seconds on: at once').toBe(0)
    const n = h.timers.length
    h.route('work')
    expect(h.timers.length, 'going elsewhere asks for nothing').toBe(n)
  })

  it('a nudge while a read is out: one more read when it lands, never two on the wire', async () => {
    const gates: Array<() => void> = []
    const h = loadQ(idle, { fetch: () => new Promise(res => gates.push(() => res({ status: 200, ok: true, json: () => Promise.resolve(idle()) }))) })
    h.W.state = { pane: 'today' }
    await h.start()
    expect(h.fetches).toHaveLength(1)
    h.Qs.nudge(); h.Qs.nudge(); h.Qs.poll()
    await flush()
    expect(h.fetches, 'still one on the wire').toHaveLength(1)
    gates.shift()!(); await flush()
    // QA 6.99.27 (N4): the asked-for read goes through nudge, so it waits out the 1 s gap from the read that just landed.
    expect(last(h).ms, 'the asked-for read, at the end of the second').toBeGreaterThan(900)
    expect(last(h).ms).toBeLessThanOrEqual(1000)
    h.later(1_000)
    last(h).fn(); await flush()
    expect(h.fetches).toHaveLength(2)
    gates.shift()!(); await flush()
    expect(last(h).ms, 'then back to every 3 s').toBe(3000)
    // A nudge alone while a read is out (a session went to waiting mid-read) still gets its read.
    last(h).fn(); await flush()
    expect(h.fetches).toHaveLength(3)
    h.later(1_000)
    h.Qs.nudge()
    gates.shift()!(); await flush()
    expect(last(h).ms, 'the nudge’s read, at once when the last went out a second ago').toBe(0)
    // Hidden: a nudge reads nothing.
    h.later(5000)
    h.visible(false)
    const t = h.timers.length
    h.Qs.nudge()
    expect(h.timers.length, 'no read scheduled while hidden').toBe(t)
    // A failed read lets the next one out too.
    const bad = loadQ(idle, { fetch: () => Promise.reject(new Error('offline')) })
    await bad.start()
    bad.Qs.nudge(); bad.later(2000); bad.Qs.nudge()
    expect(last(bad).ms).toBe(0)
    last(bad).fn(); await flush()
    expect(bad.fetches).toHaveLength(2)
  })

  it('once the server has said yes, a poll never waits on /api/models again (it refreshes alongside)', async () => {
    const h = loadQ(idle, { models: (n) => (n > 1 ? new Promise(() => {}) : null) })
    await h.start()
    expect([h.modelReads(), h.fetches.length]).toEqual([1, 1])
    h.later(6 * 60_000)
    h.Qs.poll(); await flush()
    expect(h.modelReads(), 'the old capability is read again').toBe(2)
    expect(h.fetches.length, 'and the questions are read without waiting for it').toBe(2)
    // A page that has never heard yes still waits: an older server is never polled.
    const first = loadQ(idle, { models: () => new Promise(() => {}) })
    await first.start()
    expect(first.fetches).toEqual([])
  })

  it('a session that goes to waiting in the shared session list reads the questions at once', async () => {
    const start = APP.indexOf('  // ── one session list for every pane'), end = APP.indexOf('  // ── the session pet (Today) ─')
    expect(start).toBeGreaterThan(0)
    const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
    const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
    const split = /  function splitSessionId\(provider, id\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]
    let reply: unknown = null, nudges = 0
    const deps = { api: () => Promise.resolve(reply), window: { COSWeb: { sessionQuestions: { nudge: () => { nudges++ } } } }, Date, toDate: (v: unknown) => (v ? new Date(String(v)) : null) }
    // eslint-disable-next-line no-new-func
    const kit = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + split + '\n' + sx + '\n' + APP.slice(start, end) + '\nreturn { sessionList: sessionList };\n}')(deps)
    const row = (id: string, agent_state: string) => ({ session_id: id, provider: 'claude', alive: true, agent_state, state_source: 'hook' })
    const read = async (rows: unknown[]) => { reply = { sessions: rows }; await kit.sessionList(0) }
    await read([row('a', 'running')])
    expect(nudges).toBe(0)
    await read([row('a', 'waiting')])
    expect(nudges, 'a went to waiting').toBe(1)
    await read([row('a', 'waiting')])
    expect(nudges, 'still waiting: nothing new').toBe(1)
    await read([row('a', 'waiting'), row('b', 'waiting')])
    expect(nudges, 'b went to waiting').toBe(2)
    await read([row('a', 'running'), row('b', 'waiting')])
    await read([row('a', 'waiting'), row('b', 'waiting')])
    expect(nudges, 'a went to waiting again').toBe(3)
  })

  it('the Sessions reader’s stream going to waiting reads the questions at once, once per flip', () => {
    const start = APP.indexOf('  function watchSession(provider, id) {'), end = APP.indexOf('  function setLive(patch) {')
    expect(start).toBeGreaterThan(0)
    const streams: any[] = []
    let nudges = 0
    const r = { id: 'a', feed: {} }
    const deps = {
      state: { reading: r, stream: null }, sessionPath: () => '/s', applyFeed: () => {}, $: () => null, setLive: () => {}, refreshTurns: () => {}, replyEnded: () => {},
      paintActivity: () => {}, sxProbeStream: () => {}, questionsNudge: () => { nudges++ }, Date,
      EventSource: class { constructor() { streams.push(this) } },
    }
    // eslint-disable-next-line no-new-func
    const watch = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn watchSession;\n}')(deps)
    watch('claude', 'a')
    const say = (e: Record<string, unknown>) => streams[0].onmessage({ data: JSON.stringify({ kind: 'status', ...e }) })
    say({ state: 'working', agent_state: 'running' })
    expect(nudges).toBe(0)
    say({ state: 'idle', agent_state: 'waiting' })
    expect(nudges).toBe(1)
    say({ state: 'idle', agent_state: 'waiting' })
    expect(nudges, 'still waiting').toBe(1)
    say({ state: 'working', agent_state: 'running' })
    say({ state: 'needs_input' })
    expect(nudges, 'waiting again').toBe(2)
  })

  it('Today’s sheet stream going to waiting reads the questions at once, once per flip', async () => {
    const SID = 'eeeeeeee-5555-4555-8555-555555555555'
    const busy = { session_id: SID, provider: 'claude', display_label: 'Release QA', alive: true, running: true, running_active: true, agent_state: 'running', state_source: 'hook' }
    const h = load({ data: { sessions: [busy] }, routes: {} })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const say = (e: Record<string, unknown>) => h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', ...e }) })
    say({ state: 'working', agent_state: 'running' })
    expect(h.nudges()).toBe(0)
    say({ state: 'working', agent_state: 'waiting' })
    expect(h.nudges()).toBe(1)
    say({ state: 'working', agent_state: 'waiting' })
    expect(h.nudges(), 'still waiting').toBe(1)
    say({ state: 'working', agent_state: 'running' })
    say({ state: 'idle', agent_state: 'waiting' })
    expect(h.nudges()).toBe(2)
    say({ state: 'working', agent_state: 'running' })
    say({ state: 'waiting', agent_state: 'running' })
    expect(h.nudges(), 'the agent’s own state wins: running is not waiting').toBe(2)
  })
})

// ── 6.99.29: one state for the session card (Miles 11/07 11:01) ─────────────────────────────────
// His screenshot showed, at once, "Idle 40s", "Working on: Yes install and proceed", "Working right now. A message
// you send waits and lands when this turn ends." and "The session is busy. Yours sends next, on its own." while the
// session ran. Every piece now reads app.js sxTruth, and the freshest signal wins.
describe('one state for the session card: the freshest signal wins, and every piece agrees', () => {
  const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
  const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const busyGate: Routes = {
    ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
    ['GET ' + P('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
    ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'native_thread_working', reasonCopy: 'Working right now.' } },
    ['POST ' + P('/queued-turns')]: { status: 202, body: { queued: true, position: 0 } },
  }
  const freeGate: Routes = { ...busyGate, ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: null, reasonCopy: '', ownerCount: 0 } } }
  /** The four pieces the screenshot showed, read off the card. */
  function card(h: ReturnType<typeof load>) {
    const live = h.els['ta-live']!.innerHTML
    const badge = /<strong>([^<]*)<\/strong>/.exec(live)?.[1] ?? null
    return {
      badge,
      header: h.els['ta-run-state']!.textContent,
      prompt: /class="ta-act-prompt">([^<]*)</.exec(live)?.[1] ?? null,
      stop: live.includes('data-ta="stop"'),
      parkNote: h.els['ta-verdict']!.innerHTML.includes('Working right now'),
    }
  }
  function consistent(c: ReturnType<typeof card>, word: 'Working' | 'Idle') {
    expect(c.badge, 'the badge').toBe(word)
    if (word === 'Working') {
      expect(c.header, 'the header').toMatch(/^Working now/)
      expect(c.prompt, 'the prompt line').toMatch(/^Working on: /)
      expect(c.stop, 'Stop').toBe(true)
      expect(c.parkNote, 'the composer note').toBe(true)
    } else {
      expect(c.header, 'the header').toMatch(/^Idle/)
      expect(c.prompt ?? 'Last asked: ', 'the prompt line').toMatch(/^Last asked: /)
      expect(c.stop, 'Stop').toBe(false)
      expect(c.parkNote, 'the composer note').toBe(false)
    }
  }

  it('the stream says working, the list says idle: Working everywhere', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(120_000), alive: true }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ago(30_000) }) })
    es.onmessage({ data: JSON.stringify({ seq: 2, kind: 'prompt', text: 'Yes install and proceed' }) })
    consistent(card(h), 'Working')
    expect(card(h).prompt).toBe('Working on: Yes install and proceed')
  })

  it('the screenshot: the hooks say idle since 40 s ago, the write gate says working now: Working everywhere, and the busy send note agrees', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(40_000), alive: true }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: ago(40_000) }) })
    es.onmessage({ data: JSON.stringify({ seq: 2, kind: 'prompt', text: 'Yes install and proceed' }) })
    consistent(card(h), 'Working')
    h.els['ta-input']!.value = 'install 6.99.28'
    h.tap('send')
    await flush()
    expect(h.els['ta-status']!.textContent).toBe('The session is busy. Yours sends next, on its own.')
    consistent(card(h), 'Working')
  })

  it('steer mid-turn: the server says the session takes it mid-turn, so the note and the send line say next step', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(40_000), alive: true }
    const midTurn: Routes = {
      ...busyGate,
      ['GET ' + P('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0, midTurn: { available: true, mode: 'peer_inbox' } } },
      ['POST ' + P('/queued-turns')]: { status: 202, body: { queued: true, position: 0, landsAt: 'next_step' } },
    }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: midTurn })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ago(5_000) }) })
    expect(h.els['ta-verdict']!.innerHTML).toContain('Working right now. Your message lands at its next step.')
    expect(h.els['ta-verdict']!.innerHTML).not.toContain('lands when this turn ends')
    h.els['ta-input']!.value = 'also check the footer'
    h.tap('send')
    await flush()
    expect(h.els['ta-status']!.textContent).toBe('The session is busy. Yours lands at its next step.')
  })

  it('steer mid-turn: not available (a held prompt, Codex, the switch off) keeps the turn-end lines', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(40_000), alive: true }
    const noMidTurn: Routes = {
      ...busyGate,
      ['GET ' + P('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0, midTurn: { available: false, reason: 'permission_pending' } } },
      ['POST ' + P('/queued-turns')]: { status: 202, body: { queued: true, position: 0, landsAt: 'turn_end' } },
    }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: noMidTurn })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ago(5_000) }) })
    expect(h.els['ta-verdict']!.innerHTML).toContain('Working right now. A message you send waits and lands when this turn ends.')
    h.els['ta-input']!.value = 'also check the footer'
    h.tap('send')
    await flush()
    expect(h.els['ta-status']!.textContent).toBe('The session is busy. Yours sends next, on its own.')
  })

  it('a fresher idle beats an older busy answer: Idle everywhere, and the prompt line says what was last asked', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: ago(300_000), last_activity_at: ago(60_000), alive: true }
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: busyGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    await new Promise(r => setTimeout(r, 15))
    const es = h.streams[0]
    es.onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: new Date().toISOString() }) })
    es.onmessage({ data: JSON.stringify({ seq: 2, kind: 'prompt', text: 'Yes install and proceed' }) })
    consistent(card(h), 'Idle')
    expect(card(h).prompt).toBe('Last asked: Yes install and proceed')
  })

  it('a busy file within five seconds of the Stop is the flush that trails it: still Idle', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(1_000), alive: true }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: ago(1_000) }) })
    consistent(card(h), 'Idle')
  })

  it('a question stays a question: a busy write gate never turns Waiting into Working', async () => {
    // QA 6.99.29: the row and the stream carry the SAME state_since in production (session-state-derive.ts), so
    // the test pins one timestamp for both: two ago() calls a millisecond apart decided the order, and the test flaked.
    const SINCE = ago(60_000)
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'waiting', state_source: 'hook', state_since: SINCE, alive: true }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'waiting', state_source: 'hook', state_since: SINCE, waiting_kind: 'permission' }) })
    const c = card(h)
    expect(c.badge).toBe('Waiting')
    expect(c.header).toMatch(/^Waiting for you/)
    expect(c.parkNote, 'no "Working right now" beside "Waiting"').toBe(false)
  })

  it('QA 6.99.29: the row and the hook at the same time, a busy gate after both: Waiting, Failed and Done hold, the hook wins the tie, in either order', () => {
    const h = load({ data: { sessions: [], working: [] }, routes: {} })
    const F = h.reader.kit.feed
    const SINCE = ago(60_000)
    const row = (agent_state: string) => ({ session_id: SID, provider: 'claude', running: true, running_active: false, agent_state, state_source: 'hook', state_since: SINCE, alive: true })
    const hook = (agent_state: string) => ({ seq: 1, kind: 'status', state: 'working', agent_state, state_source: 'hook', state_since: SINCE, waiting_kind: 'permission' })
    for (const order of ['list first', 'hook first'] as const) {
      // The row says waiting with the hook: the card is Waiting from the hook (its detail), and the gate never unseats it.
      const r = h.reader.kit.session('claude', SID, {})
      if (order === 'list first') { F.noteList(r, row('waiting')); F.apply(r, hook('waiting')) } else { F.apply(r, hook('waiting')); F.noteList(r, row('waiting')) }
      expect(F.truth(r), order).toMatchObject({ word: 'Waiting', src: 'hook' })
      F.noteGate(r, true)
      expect(F.truth(r), order + ': a busy gate after both').toMatchObject({ word: 'Waiting', src: 'hook' })
      // The row alone (a stream with no derived state rides along): its Waiting holds against the gate and the stream.
      const q = h.reader.kit.session('claude', SID, {})
      F.noteList(q, row('waiting'))
      F.apply(q, { seq: 1, kind: 'status', state: 'working' })
      F.noteGate(q, true)
      expect(F.truth(q), order + ': the row alone').toMatchObject({ word: 'Waiting', src: 'list' })
      // The hook's own failed and ended hold too, with the row beside them at the same time.
      for (const [state, word] of [['failed', 'Failed'], ['ended', 'Done']] as const) {
        const d = h.reader.kit.session('claude', SID, {})
        if (order === 'list first') { F.noteList(d, row('idle')); F.apply(d, hook(state)) } else { F.apply(d, hook(state)); F.noteList(d, row('idle')) }
        F.noteGate(d, true)
        expect(F.truth(d), order + ' ' + state).toMatchObject({ word, src: 'hook' })
      }
      // A newer hook running is the question answered: it still wins.
      F.apply(r, { seq: 2, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString() })
      expect(F.truth(r)!.word, order + ': answered').toBe('Working')
    }
  })

  it('a message delivered live into the open session: the card reads Working, not done', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(40_000), alive: true }
    const routes: Routes = { ...freeGate,
      ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } },
      ['POST /api/agent-sessions/bindings/b1/turns']: { status: 200, body: { outcome: 'completed', via: 'live', deliveryState: 'delivered' } } }
    const h = load({ data: { sessions: [ROW], working: [] }, routes })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: ago(40_000) }) })
    expect(card(h).badge).toBe('Idle')
    h.els['ta-input']!.value = 'Yes install and proceed'
    h.tap('send')
    await flush()
    expect(card(h).badge).toBe('Working')
    expect(card(h).stop).toBe(true)
    expect(card(h).header).toMatch(/^Working now/)
  })

  it('the gate goes free: an earlier busy answer no longer counts', async () => {
    const ROW = { session_id: SID, provider: 'claude', display_label: 'Release', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', state_since: ago(40_000), alive: true }
    const h = load({ data: { sessions: [ROW], working: [] }, routes: freeGate })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: ago(40_000) }) })
    consistent(card(h), 'Idle')
    // The reducer itself: busy, then free, on one session.
    const F = h.reader.kit.feed, r = h.reader.kit.session('claude', SID, {})
    F.apply(r, { seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: ago(40_000) })
    F.noteGate(r, true)
    expect(F.truth(r)).toMatchObject({ word: 'Working', src: 'gate' })
    F.noteGate(r, false)
    expect(F.truth(r)).toMatchObject({ word: 'Idle', src: 'hook' })
    // A Stop is idle as of then, and the stream's working echo in the next eight seconds does not reopen it.
    F.noteGate(r, true); r.stoppedAt = Date.now() + 1
    expect(F.truth(r)).toMatchObject({ word: 'Idle', src: 'stop' })
    F.apply(r, { seq: 2, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: new Date(Date.now() + 2).toISOString() })
    expect(F.truth(r)!.word, 'the echo of the Stop').toBe('Idle')
    // QA 6.99.29: the window is the page's own clock (when the page SAW the signal), never the signal's server time.
    // A Mac clock 10 s ahead stamps the Stop's own echo 10 s "after" it: seen now, it is still the echo.
    F.apply(r, { seq: 3, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: new Date(Date.now() + 10_000).toISOString() })
    expect(F.truth(r)!.word, 'an echo stamped late by the server, seen inside the window').toBe('Idle')
    // The Stop was 9 s ago on this page; a turn the server stamps 2 s after it, first seen now, is real work.
    const s2 = h.reader.kit.session('claude', SID, {})
    s2.stoppedAt = Date.now() - 9_000
    F.apply(s2, { seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: new Date(s2.stoppedAt + 2_000).toISOString() })
    expect(F.truth(s2)!.word, 'a turn that arrives after the echo window').toBe('Working')
    // An echo stamped late by a Mac clock that runs ahead, seen inside the window, stays the echo when a reconnect
    // (a reseed, seq 1) repeats it 10 s later: the page first saw it inside the window. (Moving the Stop and the
    // arrival back 10 s together is the page's clock moving on 10 s.)
    const s3 = h.reader.kit.session('claude', SID, {})
    const ahead = new Date(Date.now() + 10_000).toISOString()
    s3.stoppedAt = Date.now() - 1
    F.apply(s3, { seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ahead })
    expect(F.truth(s3)!.word, 'the echo, seen inside the window').toBe('Idle')
    s3.stoppedAt -= 10_000; s3.feed.seenMemo.hook.seen -= 10_000; s3.feed.seenMemo.stream.seen -= 10_000
    F.apply(s3, { seq: 2, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ahead })
    expect(F.truth(s3)!.word, 'the same echo repeated 10 s later').toBe('Idle')
    F.apply(s3, { seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_source: 'hook', state_since: ahead })
    expect(F.truth(s3)!.word, 'the same echo after a reseed').toBe('Idle')
    // The same for the session row: a re-read of a row first seen inside the window is not a new working signal.
    const s4 = h.reader.kit.session('claude', SID, {})
    const busyRow = { session_id: SID, provider: 'claude', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: ahead, last_activity_at: ahead, alive: true }
    s4.stoppedAt = Date.now() - 1
    F.noteList(s4, busyRow)
    expect(F.truth(s4)!.word, 'the row, seen inside the window').toBe('Idle')
    s4.stoppedAt -= 10_000; s4.list.seen -= 10_000
    F.noteList(s4, busyRow)
    expect(F.truth(s4)!.word, 'the same row, read again 10 s later').toBe('Idle')
    // A different row (new activity) seen now, past the window, is real work.
    F.noteList(s4, { ...busyRow, last_activity_at: new Date(Date.now() + 11_000).toISOString() })
    expect(F.truth(s4)!.word, 'new activity after the window').toBe('Working')
  })
})

// ── 6.99.30: the sheet is the visible part of the page, in any browser (Miles's Duo: Comet as well as Safari) ─────────
// The layer's box, the backdrop's reach and the reply box's place are worked out here from the stylesheet itself and the
// variables the page set (app.js viewportFit, today-actions.js applyFit), never by matching a string of CSS to itself.
// Each case says what the person can really see (`vis`, between the browser's own bars and the keyboard), lets the
// browser report it through visualViewport as browsers do, and checks the reply box lands inside what is visible and
// the backdrop reaches the physical bottom of the screen.
const TA_CSS = readFileSync(join(HERE, 'panes', 'today-actions.css'), 'utf8')
const TA_NC = TA_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
function taRule(sel: string) {
  const i = TA_NC.indexOf('\n' + sel + ' {')
  expect(i, sel).toBeGreaterThan(-1)
  const open = TA_NC.indexOf('{', i), close = TA_NC.indexOf('}', open)
  return TA_NC.slice(open + 1, close)
}
function taDecls(sel: string) {
  const out: Record<string, string> = {}
  for (const d of taRule(sel).split(';')) { const c = d.indexOf(':'); if (c > 0) out[d.slice(0, c).trim()] = d.slice(c + 1).trim() }
  return out
}
/** Top-level space-separated parts of a shorthand ("10px var(--gutter) calc(a + b)"). */
function parts(v: string) { const out: string[] = []; let depth = 0, cur = ''; for (const ch of v) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ' ' && !depth) { if (cur) out.push(cur); cur = '' } else cur += ch } if (cur) out.push(cur); return out }
/** A length in px: var() from the page's variables (then the environment, then the fallback), calc() sums, dvh/vh. */
function px(v: string, vars: Record<string, string>, viewportH: number): number {
  let r = v, guard = 0
  while (/var\(/.test(r) && guard++ < 10) r = r.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/, (_m, name: string, fb?: string) => vars[name] ?? (fb ?? '').trim())
  r = r.replace(/(\d+(?:\.\d+)?)d?vh/g, (_m, n: string) => String((parseFloat(n) / 100) * viewportH) + 'px')
  r = r.replace(/calc\(/g, '(').replace(/\bmin\(/g, 'Math.min(')
  const expr = r.replace(/px/g, '').trim()
  expect(expr, 'a length this model can add: ' + v).toMatch(/^(?:[\d.()+\-\s,]|Math\.min)+$/)
  // eslint-disable-next-line no-new-func
  return Number(new Function('return (' + expr + ')')())
}
const COMPOSER_H = 58   // the reply box: a 44 px textarea in its bordered row
type Box = { top: number; bottom: number }
/** The layer, the reply box, the dim and the sheet's colour below it, in layout px, from the stylesheet. */
function geometry(L: El, layoutH: number, env: { safeBottom: number; wide: boolean }) {
  const d = taDecls('.ta-layer')
  // The layer's own custom properties (--ta-bleed), then what the page set, then the environment.
  const own = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('--')))
  const vars = { ...own, ...L.props, '--safe-bottom': env.safeBottom + 'px', '--gutter': '16px' }
  const top = px(d.top!, vars, layoutH), height = px(d.height!, vars, layoutH)
  const layer: Box = { top, bottom: top + height }
  const kb = L.cls.has('ta-kb'), strip = L.cls.has('ta-kb-strip')
  let pad: string
  if (kb) pad = taDecls('.ta-layer.ta-kb .ta-foot')['padding-bottom']!
  else if (strip) pad = taDecls('.ta-layer.ta-kb-strip .ta-foot')['padding-bottom']!
  else if (env.wide) pad = /\.ta-foot \{ padding-bottom: ([^;]+);/.exec(TA_NC.slice(TA_NC.indexOf('@media (min-width: 600px) {\n  .ta-sheet {')))![1]!
  else { const p = parts(taDecls('.ta-foot').padding!); pad = p[2] ?? p[0]! }
  const sheetBottom = px((kb ? taDecls('.ta-layer.ta-kb .ta-sheet').bottom : taDecls('.ta-sheet').bottom)!, vars, layoutH)
  const cBottom = layer.bottom - sheetBottom - px(pad, vars, layoutH)
  const composer: Box = { top: cBottom - COMPOSER_H, bottom: cBottom }
  const dimBottom = layer.bottom + px(taDecls('.ta-layer::before').height!, vars, layoutH)
  const colourBottom = layer.bottom + px(taDecls('.ta-layer .ta-sheet::after').height!, vars, layoutH)
  return { layer, composer, dimBottom, colourBottom }
}

/** The reply foot with `files` attached: the chips scroll inside their capped box (today-actions.css), one chip a row at
 *  a phone's or a side sheet's width (52 px each, 8 px apart) plus the limits line; the words and Send under them. */
function footWithFiles(L: El, layoutH: number, files: number) {
  const cap = L.cls.has('ta-kb') ? taDecls('.ta-layer.ta-kb .ta-composer .ta-files')['max-height']! : taDecls('.ta-composer .ta-files')['max-height']!
  const content = files ? files * 52 + (files - 1) * 8 + 8 + 20 : 0
  const chips = Math.min(content, px(cap, {}, layoutH))
  const pad = L.cls.has('ta-kb') ? 8 + 8 : 10 + 14
  return { chips, foot: pad + chips + (files ? 6 : 0) + COMPOSER_H }
}

describe('6.99.30: the sheet is the visible part of the page, in any browser (Comet, Safari, Chrome)', () => {
  const SID = 'b5c3c5ee-f51d-4c19-9b22-d90b129d2a8e'
  const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
  const ROW = { session_id: SID, provider: 'claude', display_label: 'General COS research to bring more value to users', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString(), alive: true }
  const routes: Routes = {
    ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
    ['GET ' + P('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
  }
  const layerOf = (h: ReturnType<typeof load>) => h.document.appended as El
  /** Focus a field in the sheet (the reply box), as a tap on it does. */
  function focusReply(h: ReturnType<typeof load>) {
    const L = layerOf(h), input = h.els['ta-input']!
    ;(input as any).tagName = 'TEXTAREA'
    L.contains = ((x: unknown) => x === input) as any
    h.document.activeElement = input
    ;(L.listeners.focusin || []).forEach(fn => fn({ target: input }))
  }
  function blurReply(h: ReturnType<typeof load>) {
    const L = layerOf(h)
    h.document.activeElement = h.document.body
    ;(L.listeners.focusout || []).forEach(fn => fn({ target: h.els['ta-input'] }))
  }
  async function opened(innerHeight: number, vv: { height: number; offsetTop?: number; scale?: number }) {
    const h = load({ data: { sessions: [ROW], working: [] }, routes, vv, innerHeight })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    return h
  }
  const inside = (b: Box, vis: Box) => b.top >= vis.top - 0.5 && b.bottom <= vis.bottom + 0.5

  // Each browser and size: the screen's physical height (`screen`), the layout viewport the browser gives the page
  // (`layout`), and what is visible (`vis`). The browser reports `vis` through visualViewport.
  const CASES: Array<{ name: string; wide: boolean; screen: number; layout: number; vis: Box; safeBottom: number; focus?: boolean; kb?: 'none' | 'strip' | 'kb' }> = [
    // Safari: its bars sit outside the layout viewport (or collapse), the page sees all of it.
    { name: 'Safari, unfolded 1430x1000', wide: true, screen: 1000, layout: 1000, vis: { top: 0, bottom: 1000 }, safeBottom: 20 },
    { name: 'Safari, folded 382x678', wide: false, screen: 678, layout: 678, vis: { top: 0, bottom: 678 }, safeBottom: 34 },
    // Chrome on iOS (CriOS): its bottom toolbar shortens the layout viewport itself.
    { name: 'Chrome iOS, unfolded, 56 px toolbar', wide: true, screen: 1000, layout: 944, vis: { top: 0, bottom: 944 }, safeBottom: 0 },
    { name: 'Chrome iOS, folded, 56 px toolbar', wide: false, screen: 678, layout: 622, vis: { top: 0, bottom: 622 }, safeBottom: 0 },
    // Comet: a bottom bar over the page. The layout viewport runs under it; only visualViewport says it is covered.
    { name: 'Comet, unfolded, 56 px bar', wide: true, screen: 1000, layout: 1000, vis: { top: 0, bottom: 944 }, safeBottom: 0 },
    { name: 'Comet, unfolded, 106 px bar (IMG_0503)', wide: true, screen: 1000, layout: 1000, vis: { top: 0, bottom: 894 }, safeBottom: 0 },
    { name: 'Comet, folded, 110 px bar', wide: false, screen: 678, layout: 678, vis: { top: 0, bottom: 568 }, safeBottom: 0 },
    { name: 'Comet, folded, 56 px bar', wide: false, screen: 678, layout: 678, vis: { top: 0, bottom: 622 }, safeBottom: 0 },
    // A hardware keyboard's strip, the reply box focused.
    { name: 'Safari, unfolded, 60 px hardware keyboard strip, reply focused', wide: true, screen: 1000, layout: 1000, vis: { top: 0, bottom: 940 }, safeBottom: 20, focus: true, kb: 'strip' },
    { name: 'Comet, folded, 56 px bar plus a 60 px strip, reply focused', wide: false, screen: 678, layout: 678, vis: { top: 0, bottom: 562 }, safeBottom: 0, focus: true, kb: 'strip' },
    // The on-screen keyboard, focused, and with the page panned to the box.
    { name: 'on-screen keyboard, unfolded', wide: true, screen: 1000, layout: 1000, vis: { top: 0, bottom: 470 }, safeBottom: 20, focus: true, kb: 'kb' },
    { name: 'on-screen keyboard, folded, page panned 120 px', wide: false, screen: 678, layout: 678, vis: { top: 120, bottom: 120 + 380 }, safeBottom: 34, focus: true, kb: 'kb' },
  ]
  for (const c of CASES) {
    it(`${c.name}: the reply box is inside what is visible, and the backdrop reaches the bottom of the screen`, async () => {
      const h = await opened(c.layout, { height: c.layout })
      const L = layerOf(h)
      if (c.focus) focusReply(h)
      h.viewport({ height: c.vis.bottom - c.vis.top, offsetTop: c.vis.top }); h.runFrames()
      const g = geometry(L, c.layout, { safeBottom: c.safeBottom, wide: c.wide })
      expect(g.layer, 'the layer is what the browser says is visible').toEqual(c.vis)
      expect(inside(g.composer, c.vis), `the reply box ${JSON.stringify(g.composer)} inside ${JSON.stringify(c.vis)}`).toBe(true)
      expect(g.dimBottom, 'the dim reaches the physical bottom').toBeGreaterThanOrEqual(c.screen)
      expect(g.colourBottom, 'the sheet colour reaches it too').toBeGreaterThanOrEqual(c.screen)
      expect(L.cls.has('ta-kb'), 'compact layout').toBe(c.kb === 'kb')
      expect(L.cls.has('ta-kb-strip'), 'strip layout').toBe(c.kb === 'strip')
      // The breadcrumb for this change (or for the open, when nothing changed) carries the browser's numbers.
      const last = h.crumbs[h.crumbs.length - 1]!
      expect(['open', 'kb']).toContain(last.what)
      expect(h.crumbs[0]!.what, 'the open is reported').toBe('open')
      if (c.kb === 'kb' || c.kb === 'strip') expect(last).toMatchObject({ what: 'kb', data: { focus: true, inset: c.layout - (c.vis.bottom - c.vis.top) } })
      // A strip or a keyboard covers the home indicator: the reply box sits 8 px above what covers it, never the inset more.
      if (c.kb) expect(g.layer.bottom - g.composer.bottom, 'no home indicator inset under a keyboard or strip').toBe(8)
    })
  }

  // 7.0.2 (A3, the Duo audit): a web view that shrinks innerHeight itself with the keyboard (real WebKit's RS model). The
  // layout height was re-read every frame, so the inset read 0, ta-kb never came and Send sat under the keyboard.
  const RS: Array<{ name: string; wide: boolean; layout: number; visible: number }> = [
    { name: 'folded 382x557, 291 px keyboard', wide: false, layout: 557, visible: 266 },
    { name: 'folded turned 557x382, 200 px keyboard', wide: true, layout: 382, visible: 182 },
    { name: 'unfolded 951x539, 330 px keyboard', wide: true, layout: 539, visible: 209 },
  ]
  for (const c of RS) {
    it(`7.0.2: ${c.name}, the web view shrinks with the keyboard: ta-kb comes on, the reply box is in view, and a kb breadcrumb is sent`, async () => {
      const h = await opened(c.layout, { height: c.layout })
      const L = layerOf(h), win = (h.ctx as any).window
      focusReply(h)
      win.innerHeight = c.visible
      h.viewport({ height: c.visible }); h.runFrames()
      expect(L.cls.has('ta-kb'), 'the keyboard is seen though innerHeight shrank').toBe(true)
      const g = geometry(L, c.visible, { safeBottom: 0, wide: c.wide })
      expect(inside(g.composer, { top: 0, bottom: c.visible }), `reply box ${JSON.stringify(g.composer)} inside 0..${c.visible}`).toBe(true)
      expect(h.crumbs[h.crumbs.length - 1]).toMatchObject({ what: 'kb', data: { kb: true, focus: true, inset: c.layout - c.visible, lh: c.layout } })
      // The keyboard closes: the field loses focus and the web view grows back. The sheet fills it again, ta-kb off.
      blurReply(h); win.innerHeight = c.layout
      h.viewport({ height: c.layout }); h.runFrames()
      expect(L.cls.has('ta-kb')).toBe(false)
      expect(L.props['--ta-vh']).toBe(c.layout + 'px')
      expect(h.crumbs[h.crumbs.length - 1]).toMatchObject({ what: 'kb', data: { kb: false, inset: 0 } })
    })
  }
  it('7.0.2 (A1): the sheet sends a kb breadcrumb on every keyboard open and close, even when ta-kb was already on', async () => {
    const h = await opened(678, { height: 678 })
    const L = layerOf(h)
    // Something 130 px tall already covers the bottom with nothing focused: ta-kb on, no keyboard.
    h.viewport({ height: 548 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    const before = h.crumbs.filter(x => x.what === 'kb').length
    focusReply(h)
    h.viewport({ height: 548 }, 'scroll'); h.runFrames()
    expect(h.crumbs.filter(x => x.what === 'kb').length, 'the keyboard opening on a sheet already in ta-kb is reported').toBe(before + 1)
    blurReply(h); h.runFrames()
    expect(h.crumbs.filter(x => x.what === 'kb').length, 'and its closing').toBe(before + 2)
  })

  // Canary BLOCKER: five files pushed the reply box and Send off the sheet at every size, keyboard up or down.
  for (const c of CASES.filter(x => /Safari, folded|Comet, folded, 110|on-screen keyboard|60 px hardware/.test(x.name))) {
    it(`${c.name}, five files attached: the chips scroll in their box and the words and Send stay on screen`, async () => {
      const h = await opened(c.layout, { height: c.layout })
      const L = layerOf(h)
      if (c.focus) focusReply(h)
      h.viewport({ height: c.vis.bottom - c.vis.top, offsetTop: c.vis.top }); h.runFrames()
      const g = geometry(L, c.layout, { safeBottom: c.safeBottom, wide: c.wide })
      const { chips, foot } = footWithFiles(L, c.layout, 5)
      const head = L.cls.has('ta-kb') ? 48 : 100
      expect(chips, 'the five chips are capped, not all shown').toBeLessThan(5 * 52)
      expect(head + foot, `header ${head} + foot ${foot} fit the sheet (${g.layer.bottom - g.layer.top} visible)`).toBeLessThanOrEqual(g.layer.bottom - g.layer.top)
      expect(inside(g.composer, c.vis)).toBe(true)
    })
  }

  it('the 106 px reading with nothing focused is a bar, not a keyboard: the header stays and only the backdrop goes below it', async () => {
    const h = await opened(1000, { height: 894 })
    const L = layerOf(h)
    expect(L.cls.has('ta-kb')).toBe(false)
    expect(L.cls.has('ta-kb-strip')).toBe(false)
    expect(L.props['--ta-below'], 'the backdrop reaches over the bar').toBe('106px')
    expect(h.crumbs[0]).toMatchObject({ what: 'open', data: { kind: 'run', kb: false, focus: false, inset: 106, below: 106, lh: 1000, h: 894 } })
  })

  it('the strip needs focus: a 60 px strip with nothing focused changes nothing; focused it is the light layout; blurred it goes', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    h.viewport({ height: 940 }); h.runFrames()
    expect(L.cls.has('ta-kb-strip'), 'no focus').toBe(false)
    focusReply(h); h.runFrames()
    expect(L.cls.has('ta-kb-strip'), 'focused: the refit came from focusin, no viewport event').toBe(true)
    expect(L.cls.has('ta-kb'), 'the header stays full').toBe(false)
    blurReply(h); h.runFrames()
    expect(L.cls.has('ta-kb-strip'), 'focus left: the refit came from focusout').toBe(false)
  })

  // 6.99.32 (QA 6.99.30 canary W2): the keyboard rises AFTER the focus, so the 250 ms scroll can land too early.
  it('a question card’s Other field focused first, then the keyboard rises: it is scrolled into view on the next frame', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const other: any = Object.assign(new El(), { tagName: 'INPUT', type: 'text' })
    const scrolls: string[] = []
    other.scrollIntoView = (o: { block: string }) => scrolls.push('other ' + o.block)
    L.contains = ((x: unknown) => x === other) as any
    h.document.activeElement = other
    h.viewport({ height: 1000 }); h.runFrames()
    expect(scrolls, 'no keyboard yet: nothing to reveal').toEqual([])
    h.viewport({ height: 580 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    expect(scrolls, 'asked for, not done inside the layout frame').toEqual([])
    h.runFrames()
    expect(scrolls).toEqual(['other nearest'])
    h.viewport({ height: 600 }); h.runFrames(); h.runFrames()
    h.viewport({ height: 600 }); h.runFrames(); h.runFrames()
    expect(scrolls, 'a shrinking or unchanged cover never reveals').toEqual(['other nearest'])
    h.viewport({ height: 560 }); h.runFrames(); h.runFrames()
    expect(scrolls, 'the cover growing again (a suggestion bar) reveals again').toEqual(['other nearest', 'other nearest'])
    h.viewport({ height: 1000 }); h.runFrames(); h.runFrames()
    h.document.activeElement = h.document.body
    h.viewport({ height: 580 }); h.runFrames(); h.runFrames()
    expect(scrolls, 'nothing focused: nothing scrolled').toEqual(['other nearest', 'other nearest'])
    h.viewport({ height: 1000 }); h.runFrames(); h.runFrames()
    h.document.activeElement = other
    h.viewport({ height: 580 }); h.runFrames()
    h.document.activeElement = h.document.body   // focus left before the reveal's frame
    ;(h.document.body as any).scrollIntoView = () => scrolls.push('body')
    h.runFrames()
    expect(scrolls, 'focus gone by the next frame: nothing scrolled').toEqual(['other nearest', 'other nearest'])
  })
  it('desktop zoom rounding (under 24 px) with a field focused never scrolls: no keyboard layout, no reveal', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const other: any = Object.assign(new El(), { tagName: 'INPUT', type: 'text' })
    const scrolls: number[] = []
    other.scrollIntoView = () => scrolls.push(1)
    L.contains = ((x: unknown) => x === other) as any
    h.document.activeElement = other
    for (const inset of [4, 9, 17, 23]) { h.viewport({ height: 1000 - inset }); h.runFrames(); h.runFrames() }
    expect(L.cls.has('ta-kb') || L.cls.has('ta-kb-strip')).toBe(false)
    expect(scrolls).toEqual([])
  })
  // Codex root regression on 98f3cde: a keyboard animating up in 20 px frames, and a bar already holding ta-kb.
  for (const [label, from, to] of [['a keyboard animating 0 to 420 px in 20 px frames', 0, 420], ['a 130 px bar, then 150 to 430 px in 20 px frames', 130, 430]] as const) {
    it(`${label}: the focused Other field is revealed`, async () => {
      const h = await opened(1000, { height: 1000 })
      const L = layerOf(h)
      const other: any = Object.assign(new El(), { tagName: 'INPUT', type: 'text' })
      const scrolls: number[] = []
      L.contains = ((x: unknown) => x === other) as any
      h.viewport({ height: 1000 - from }); h.runFrames(); h.runFrames()
      h.document.activeElement = other
      other.scrollIntoView = () => scrolls.push(1)
      let beforeLast = 0
      for (let inset = from + 20; inset <= to; inset += 20) { if (inset === to) beforeLast = scrolls.length; h.viewport({ height: 1000 - inset }); h.runFrames(); h.runFrames() }
      expect(L.cls.has('ta-kb')).toBe(true)
      expect(scrolls.length, 'the last frame of the rise reveals, so the field ends in view').toBe(beforeLast + 1)
    })
  }
  it('the reply box reveals its whole form; a strip rise reveals too; a closed sheet and a focus change by the frame are honoured', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const form: any = h.els['ta-form']!
    const scrolls: string[] = []
    form.scrollIntoView = (o: { block: string }) => scrolls.push('form ' + o.block)
    focusReply(h)
    h.runFrames()
    h.viewport({ height: 940 }); h.runFrames()                 // a hardware keyboard's 60 px strip, reply focused
    expect(L.cls.has('ta-kb-strip')).toBe(true)
    h.runFrames()
    expect(scrolls, 'the strip rise reveals the reply form, not the bare textarea').toEqual(['form nearest'])
    const input: any = h.els['ta-input']!
    input.scrollIntoView = () => scrolls.push('input')
    h.viewport({ height: 1000 }); h.runFrames(); h.runFrames()
    h.viewport({ height: 580 }); h.runFrames()                 // the on-screen keyboard rises
    h.ta.close('user')
    h.document.activeElement = input                           // even if focus is still on the (now hidden) reply box
    h.runFrames()
    expect(scrolls, 'closed before the frame: nothing scrolled').toEqual(['form nearest'])
  })
  it('the frame scrolls what has focus then, and a 120 px bar already holding the keyboard layout still reveals when the keyboard rises', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const mk = (name: string, scrolls: string[]) => { const e: any = Object.assign(new El(), { tagName: 'INPUT', type: 'text' }); e.scrollIntoView = () => scrolls.push(name); return e }
    const scrolls: string[] = []
    const a = mk('a', scrolls), b = mk('b', scrolls)
    L.contains = ((x: unknown) => x === a || x === b) as any
    h.document.activeElement = a
    h.viewport({ height: 580 }); h.runFrames()
    h.document.activeElement = b                               // focus moved within that frame
    h.runFrames()
    expect(scrolls).toEqual(['b'])
    h.viewport({ height: 1000 }); h.runFrames(); h.runFrames()
    h.viewport({ height: 870 }); h.runFrames(); h.runFrames()  // a 130 px bar: ta-kb on with no keyboard
    expect(L.cls.has('ta-kb')).toBe(true)
    const before = scrolls.length
    h.viewport({ height: 450 }); h.runFrames(); h.runFrames()  // the keyboard rises on top of it
    expect(scrolls.length, 'a rise is the cover growing, not a class flip').toBe(before + 1)
  })

  it('desktop zoom or a scrollbar (1 to 23 px of rounding) never reads as a strip; 24 px does (QA 6.99.30)', async () => {
    for (const [inset, want] of [[1, false], [17, false], [23, false], [24, true]] as const) {
      const h = await opened(1000, { height: 1000 })
      const L = layerOf(h)
      h.viewport({ height: 1000 - inset }); focusReply(h); h.runFrames()
      expect(L.cls.has('ta-kb-strip'), inset + ' px').toBe(want)
      expect(L.cls.has('ta-kb'), inset + ' px never folds the header').toBe(false)
    }
  })

  it('focus in a question card’s Other field counts as typing too (a strip is known by focus)', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    h.viewport({ height: 940 }); h.runFrames()
    expect(L.cls.has('ta-kb-strip')).toBe(false)
    const other: any = Object.assign(new El(), { tagName: 'INPUT', type: 'text' })
    L.contains = ((x: unknown) => x === other) as any
    h.document.activeElement = other
    ;(L.listeners.focusin || []).forEach(fn => fn({ target: other }))
    expect(h.runFrames(), 'focusin asked for a frame').toBe(1)
    expect(L.cls.has('ta-kb-strip')).toBe(true)
    const radio: any = Object.assign(new El(), { tagName: 'INPUT', type: 'radio' })
    L.contains = ((x: unknown) => x === radio) as any
    ;(L.listeners.focusout || []).forEach(fn => fn({ target: other }))   // focus leaves Other first, as browsers do
    h.document.activeElement = radio
    ;(L.listeners.focusin || []).forEach(fn => fn({ target: radio }))
    h.runFrames()
    expect(L.cls.has('ta-kb-strip'), 'a radio does not type').toBe(false)
  })

  it('a turned screen read only through resize (no orientationchange) still measures the room again', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h), win = (h.ctx as any).window
    win.innerWidth = 1430
    ;(h.els['ta-head'] as any).offsetHeight = 48; (h.els['ta-foot'] as any).offsetHeight = 230
    focusReply(h)
    h.viewport({ height: 340 }); h.runFrames()
    expect(L.cls.has('ta-kb-tight')).toBe(true)
    win.innerWidth = 1000; win.innerHeight = 1430
    Object.assign(h.ctx.window.visualViewport, { height: 760 })
    h.winListeners.resize!(); h.runFrames()
    expect(L.cls.has('ta-kb'), 'the keyboard is still up').toBe(true)
    expect(L.cls.has('ta-kb-tight'), 'the width changed: measured again').toBe(false)
  })

  it('pinch zoom 1.5: a zoomed page is no inset and the layer keeps the layout viewport; with the keyboard up it is the layout less the keyboard', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    h.viewport({ height: 1000 / 1.5, offsetTop: 200, scale: 1.5 }); h.runFrames()
    expect(L.cls.has('ta-kb'), 'zoom is not a keyboard').toBe(false)
    let g = geometry(L, 1000, { safeBottom: 20, wide: true })
    expect(g.layer, 'the sheet is laid out on the whole layout viewport, the zoom only magnifies it').toEqual({ top: 0, bottom: 1000 })
    // Some browsers report the zoomed size as innerHeight: the layout height read before the zoom stands.
    ;(h.ctx as any).window.innerHeight = 667; h.viewport({ offsetTop: 150 }, 'scroll'); h.runFrames()
    g = geometry(L, 1000, { safeBottom: 20, wide: true })
    expect(g.layer).toEqual({ top: 0, bottom: 1000 })
    // The keyboard rises while zoomed: 400 px of the screen are covered.
    focusReply(h)
    h.viewport({ height: 600 / 1.5, offsetTop: 300 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    g = geometry(L, 1000, { safeBottom: 20, wide: true })
    expect(g.layer.bottom - g.layer.top, 'layout less the keyboard').toBe(600)
    expect(g.composer.bottom).toBeLessThanOrEqual(g.layer.bottom)
    expect(g.layer.top, 'never pans past the keyboard').toBeLessThanOrEqual(400)
  })

  it('rotation with the keyboard up: tight in landscape is measured again in portrait, and the layer follows each', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h), win = (h.ctx as any).window
    win.innerWidth = 1430
    ;(h.els['ta-head'] as any).offsetHeight = 48; (h.els['ta-foot'] as any).offsetHeight = 230
    focusReply(h)
    h.viewport({ height: 340 }); h.runFrames()
    expect(L.cls.has('ta-kb-tight'), 'landscape: 62 px left').toBe(true)
    // Portrait: taller, the keyboard still up, and the same reply box. orientationchange alone refits.
    win.innerWidth = 1000; win.innerHeight = 1430
    Object.assign(h.ctx.window.visualViewport, { height: 760 })
    h.winListeners.orientationchange!()
    h.runFrames()
    expect(L.cls.has('ta-kb-tight'), 'portrait: 482 px left, the note comes back').toBe(false)
    expect(geometry(L, 1430, { safeBottom: 20, wide: true }).layer).toEqual({ top: 0, bottom: 760 })
    // A window resize alone (no visualViewport event) refits too.
    win.innerWidth = 1430; win.innerHeight = 1000; Object.assign(h.ctx.window.visualViewport, { height: 1000 })
    blurReply(h); h.runFrames()
    h.winListeners.resize!(); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(false)
    expect(geometry(L, 1000, { safeBottom: 20, wide: true }).layer).toEqual({ top: 0, bottom: 1000 })
  })

  it('pageshow and coming back into view refit; a bfcache restore opens the stream again and reads the session again', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const streams = h.streams.length
    Object.assign(h.ctx.window.visualViewport, { height: 894 })
    h.winListeners.pageshow!({ persisted: false }); h.runFrames()
    expect(L.props['--ta-vh'], 'pageshow refits').toBe('894px')
    expect(h.streams.length, 'a plain pageshow keeps the stream').toBe(streams)
    Object.assign(h.ctx.window.visualViewport, { height: 1000 })
    ;(h.document as any).hidden = false
    ;(h.docListeners.visibilitychange || []).forEach(fn => fn({}))
    h.runFrames()
    expect(L.props['--ta-vh'], 'back in view refits').toBe('1000px')
    const turnsBefore = h.calls.filter(c => c.path === P('?turns=6&cards=1')).length
    h.winListeners.pageshow!({ persisted: true })
    await flush()
    expect(h.streams.length, 'a new stream').toBe(streams + 1)
    expect(h.streams[streams - 1].closed, 'the old one closed').toBe(true)
    expect(h.calls.filter(c => c.path === P('?turns=6&cards=1')).length, 'the last reply read again').toBeGreaterThan(turnsBefore)
    // Closed: none of these do anything.
    h.ta.close('user')
    h.winListeners.pageshow!({ persisted: true })
    expect(h.streams.length).toBe(streams + 1)
  })

  it('listens to visualViewport only while open; the window and page listeners are no-ops while closed', () => {
    const h = load({ vv: { height: 1000 }, innerHeight: 1000 })
    const count = () => (h.vvListeners.resize || []).length + (h.vvListeners.scroll || []).length
    expect(count()).toBe(0)
    h.winListeners.resize!(); h.winListeners.orientationchange!()
    expect(h.runFrames(), 'closed: no frame asked for').toBe(0)
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    expect(count()).toBe(2)
    h.ta.open('pet', '', h.opener())
    expect(count(), 'not twice').toBe(2)
    h.ta.close('user')
    expect(count()).toBe(0)
  })

  it('the stylesheet: the layer is the visible viewport with a dvh fallback; the dim and the sheet colour reach on below it; the page card waits while the sheet is open', () => {
    const d = taDecls('.ta-layer')
    expect([d.top, d.height]).toEqual(['var(--ta-vt, 0px)', 'var(--ta-vh, 100vh)'])
    expect(TA_NC).toContain('@supports (height: 100dvh) { .ta-layer { height: var(--ta-vh, 100dvh); } }')
    expect(d.inset, 'no inset: 0 left to undo the height').toBeUndefined()
    expect(TA_NC, 'no keyboard-only placement of the layer').not.toMatch(/\n\.ta-layer\.ta-kb \{/)
    // Nothing that places the layer, the dim or the sheet subtracts the home indicator.
    for (const sel of ['.ta-layer', '.ta-scrim', '.ta-sheet']) expect(taRule(sel), sel).not.toContain('safe-bottom')
    expect(taDecls('.ta-scrim').inset).toBe('0')
    expect(taDecls('.ta-layer::before').background).toBe(taDecls('.ta-scrim').background)
    expect(taDecls('.ta-layer .ta-sheet::after').background).toBe('var(--page)')
    expect(parseFloat(taDecls('.ta-layer')['--ta-bleed']!), 'more than the 106 px band').toBeGreaterThan(106)
    // The compact layout with the keyboard up.
    expect(taRule('.ta-layer.ta-kb .ta-sheet')).toMatch(/top: 0;.*bottom: 0;.*max-height: none;.*overflow: hidden/)
    expect(taRule('.ta-layer.ta-kb .ta-title')).toMatch(/white-space: nowrap;.*text-overflow: ellipsis/)
    expect(taDecls('.ta-layer.ta-kb .ta-x').height).toBe('36px')
    expect(taRule('.ta-layer.ta-kb-tight .ta-foot .sx-park')).toContain('display: none')
    // No reply box: the sheet keeps the indicator strip only with no keyboard and no strip.
    expect(taDecls('.ta-layer:not(.ta-kb):not(.ta-kb-strip) .ta-sheet:has(> .ta-foot:empty), .ta-layer:not(.ta-kb):not(.ta-kb-strip) .ta-sheet:has(> .ta-foot[hidden])')['padding-bottom']).toBe('var(--safe-bottom)')
    // Design QA: the card on the page under the sheet does not show twice.
    expect(taDecls('html.ta-open #sq-host').display).toBe('none')
    // 8: no variable is set that nothing reads.
    const ta = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
    for (const name of ta.match(/setProperty\('(--ta-[\w-]+)'/g)!.map(m => /'(--ta-[\w-]+)'/.exec(m)![1]!)) expect(TA_CSS, name + ' is read').toContain('var(' + name)
    expect(ta).not.toContain("'--ta-kb'")
  })

  it('QA 6.99.29: a tap on the bleed band below the visible part does not close the sheet; a tap on the dim still does', async () => {
    const h = await opened(1000, { height: 1000 })
    const L = layerOf(h)
    const onLayer = { target: Object.assign(L, { closest: (sel: string) => (sel === '[data-ta]' && L.hasAttribute('data-ta') ? L : null) }) }
    h.ta._onClick(onLayer)
    expect(L.hidden, 'a tap on the band').toBe(false)
    let held = false
    ;(L.listeners.touchmove || []).forEach(fn => fn({ target: L, preventDefault() { held = true } }))
    expect(held, 'a drag on the band does not scroll Today').toBe(true)
    h.tap('close')
    expect(L.hidden, 'the dim inside the screen still closes').toBe(true)
  })

  it('the 6.99.28 image preview covers the whole screen above the overlay and keeps its own insets once', () => {
    const MEDIA = readFileSync(join(HERE, 'panes', 'reader-media.js'), 'utf8')
    const css = /\.rm-view\{([^}]*)\}/.exec(MEDIA)![1]!
    expect(css).toContain('position:fixed;inset:0')
    expect(Number(/z-index:(\d+)/.exec(css)![1]), 'above the overlay').toBeGreaterThan(Number(taDecls('.ta-layer')['z-index']))
    expect((css.match(/safe-area-inset-bottom/g) || []).length).toBe(1)
  })
})

// The keyboard tests from 6.99.29, on the 6.99.30 layer (always the visible viewport).
describe('6.99.29: the on-screen keyboard over the session sheet, wide and narrow (Miles’s unfolded Duo, 11/07 11:50)', () => {
  const SID = 'b5c3c5ee-f51d-4c19-9b22-d90b129d2a8e'
  const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
  const ROW = { session_id: SID, provider: 'claude', display_label: 'General COS research to bring more value to users', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString(), alive: true }
  const busyGate: Routes = {
    ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
    ['GET ' + P('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
  }
  const layerOf = (h: ReturnType<typeof load>) => h.document.appended as El
  const height = (el: El, px: number) => { (el as any).offsetHeight = px }
  function sizes(h: ReturnType<typeof load>, head: number, foot: number) { height(h.els['ta-head']!, head); height(h.els['ta-foot']!, foot) }

  for (const [label, innerHeight, kbVisible, head, foot] of [
    ['wide (1430x1000, unfolded)', 1000, 470, 48, 170],
    ['narrow (382x678, folded)', 678, 330, 48, 150],
  ] as const) {
    it(`${label}: the keyboard marks the sheet ta-kb and sizes it to the visible viewport; closing it restores the layout`, async () => {
      const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate, vv: { height: innerHeight }, innerHeight })
      h.ta.open('run', 'claude|' + SID, h.opener())
      await flush()
      const L = layerOf(h)
      expect(L.props['--ta-vh'], 'open: the whole viewport').toBe(innerHeight + 'px')
      expect(L.props['--ta-below']).toBe('0px')
      expect(L.cls.has('ta-kb')).toBe(false)
      sizes(h, head, foot)
      h.viewport({ height: kbVisible }); h.viewport({ height: kbVisible, offsetTop: 12 }, 'scroll'); h.viewport({ height: kbVisible, offsetTop: 0 })
      expect(L.cls.has('ta-kb'), 'nothing before the frame').toBe(false)
      expect(h.runFrames(), 'one frame for the burst').toBe(1)
      expect(L.cls.has('ta-kb')).toBe(true)
      expect(L.cls.has('ta-kb-tight'), 'room for the conversation: the note stays').toBe(false)
      expect(L.props['--ta-vh']).toBe(kbVisible + 'px')
      expect(L.props['--ta-vt']).toBe('0px')
      expect(L.props['--ta-below']).toBe(innerHeight - kbVisible + 'px')
      h.viewport({ height: innerHeight }); h.runFrames()
      expect(L.cls.has('ta-kb')).toBe(false)
      expect(L.cls.has('ta-kb-tight')).toBe(false)
      expect(L.props['--ta-vh']).toBe(innerHeight + 'px')
      expect(L.props['--ta-below']).toBe('0px')
    })
  }

  it('with nothing focused, a form bar or a strip is not a keyboard; a pinch zoom is not either; a panned keyboard still is', () => {
    const h = load({ vv: { height: 1000 }, innerHeight: 1000 })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    const L = layerOf(h)
    h.viewport({ height: 1000 - 70 }); h.runFrames()
    expect(L.cls.has('ta-kb'), 'a 70 px strip').toBe(false)
    expect(L.cls.has('ta-kb-strip'), 'and no focus').toBe(false)
    expect(L.props['--ta-vh'], 'the layer still ends above it').toBe('930px')
    h.viewport({ height: 500, scale: 2 }); h.runFrames()
    expect(L.cls.has('ta-kb'), 'zoomed to 2x: half the height, all of the page').toBe(false)
    h.viewport({ height: 480, scale: 1, offsetTop: 220 }); h.runFrames()
    expect(L.cls.has('ta-kb'), 'the keyboard, with the page panned down to the box').toBe(true)
    expect(L.props['--ta-vt']).toBe('220px')
    expect(L.props['--ta-below']).toBe('300px')
  })

  it('under three lines left for the conversation hides the note while typing, and it stays hidden until the keyboard closes', async () => {
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate, vv: { height: 1000 }, innerHeight: 1000 })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const L = layerOf(h)
    sizes(h, 48, 230)
    h.viewport({ height: 340 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    expect(L.cls.has('ta-kb-tight')).toBe(true)
    sizes(h, 48, 180)
    h.viewport({ height: 340 }, 'scroll'); h.runFrames()
    expect(L.cls.has('ta-kb-tight'), 'no flicker').toBe(true)
    h.viewport({ height: 1000 }); h.runFrames()
    expect(L.cls.has('ta-kb-tight')).toBe(false)
    sizes(h, 48, 150)
    h.viewport({ height: 470 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    expect(L.cls.has('ta-kb-tight')).toBe(false)
  })

  it('the reply box growing while typing (a note or a refusal drawn) measures the room again', async () => {
    const h = load({ data: { sessions: [ROW], working: [] }, routes: busyGate, vv: { height: 1000 }, innerHeight: 1000 })
    h.ta.open('run', 'claude|' + SID, h.opener())
    await flush()
    const L = layerOf(h)
    sizes(h, 48, 120)
    h.viewport({ height: 340 }); h.runFrames()
    expect(L.cls.has('ta-kb-tight')).toBe(false)
    sizes(h, 48, 240)
    h.ta._paintVerdict()
    expect(h.runFrames(), 'a frame was asked for').toBe(1)
    expect(L.cls.has('ta-kb-tight')).toBe(true)
    h.els['ta-input']!.value = ''
    h.tap('send')
    expect(h.els['ta-status']!.textContent).toBe('Write a message first.')
    expect(h.runFrames(), 'a frame for the status line').toBe(1)
  })

  it('a frame due after close changes nothing', () => {
    const h = load({ vv: { height: 1000 }, innerHeight: 1000 })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    const L = layerOf(h)
    h.viewport({ height: 480 }); h.runFrames()
    expect(L.cls.has('ta-kb')).toBe(true)
    h.viewport({ height: 470 })
    h.ta.close('user')
    expect(L.cls.has('ta-kb'), 'close restores the layout').toBe(false)
    h.runFrames()
    expect(L.cls.has('ta-kb'), 'the cancelled frame did nothing').toBe(false)
  })

  it('a keyboard on a page whose stylesheet is not read yet still has a box: --ta-vh is set on open', () => {
    const h = load({ vv: { height: 678 }, innerHeight: 678 })
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    const L = layerOf(h)
    expect([L.props['--ta-vt'], L.props['--ta-vh'], L.props['--ta-below']]).toEqual(['0px', '678px', '0px'])
  })
})

// ── QA 6.99.29 final (11/07): the Sessions reader's own paths, run from app.js ─────────────────────
// The reader region of app.js (watchSession, watchTurn, flushHeld, continueSession, paintActivity, sxProbeAttach,
// loadQueue) with a page clock the test moves, fake timers and intervals, and a fake fetch. Nothing reaches a server.
function readerPage(routes: Routes) {
  const start = APP.indexOf('  // ── Sessions: read, send, queue, fork, stop')
  const end = APP.indexOf("  // Copy session (Control's Kickstart brief")
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const mdRegion = APP.slice(APP.indexOf('  // Markdown for an assistant turn'), APP.indexOf('  function renderTurns('))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
  const { fetch, calls } = fakeFetch(routes)
  const els: Record<string, El> = {}
  const shown = new Set(['session-live', 'session-queue', 'session-state', 'session-status', 'session-verdict'])
  const $ = (id: string) => (shown.has(id) ? (els[id] ??= Object.assign(new El(), { id })) : null)
  // A frozen page clock: it moves only when the test says (later()).
  let skew = 0
  const base = Date.now()
  const realNow = () => base
  class PageDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + skew) } static now() { return realNow() + skew } }
  const timers: Array<{ fn: () => void; ms: number; done?: boolean }> = []
  const intervals: Array<{ fn: () => void; ms: number; cleared?: boolean }> = []
  const streams: any[] = []
  const store = new Map<string, string>()
  const state: any = { reading: null, turnPoll: null, stream: null }
  const deps: Record<string, unknown> = {
    // The page's own Date, so app.js's `instanceof Date` holds for what toDate returns.
    state, $, esc, md: (s: unknown) => String(s), toDate: (v: unknown) => (v ? new PageDate(String(v)) : null), autoGrow: () => {}, showAuth: () => {},
    clock: (d: Date) => d.toISOString().slice(11, 16), fetch,
    api: (path: string) => fetch(path).then((res: any) => res.json()),
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
    AbortController, Date: PageDate,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: (n: number) => { if (timers[n - 1]) timers[n - 1]!.done = true },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval: (n: number) => { if (n && intervals[n - 1]) intervals[n - 1]!.cleared = true },
    requestAnimationFrame: () => 0, document: { querySelector: () => null, createElement: () => new El(), documentElement: { scrollHeight: 0 } },
    window: { COSWeb: {}, scrollTo: () => {} },
    EventSource: class { url: string; onmessage: any = null; onerror: any = null; readyState = 1; constructor(url: string) { this.url = url; streams.push(this) } close() {} },
  }
  // eslint-disable-next-line no-new-func
  const kit = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + sx + '\n' + mdRegion + '\n' + APP.slice(start, end) +
    '\nreturn { newFeed: newFeed, watchSession: watchSession, watchTurn: watchTurn, flushHeld: flushHeld, replyEnded: replyEnded, paintActivity: paintActivity,' +
    ' probe: sxProbeAttach, gateStale: sxGateStale, noteGate: sxNoteGate, truth: sxTruth, loadQueue: loadQueue, applyFeed: applyFeed };\n}')(deps)
  /** Runs the timers due by now (the page's own clock moved with later()). */
  const runTimers = () => { for (const t of timers) if (!t.done) { t.done = true; t.fn() } }
  const tick = () => intervals.filter(i => !i.cleared).forEach(i => i.fn())
  const live = () => els['session-live']?.innerHTML ?? ''
  return { kit, state, calls, streams, timers, intervals, runTimers, tick, live, els, store, later: (ms: number) => { skew += ms }, now: () => realNow() + skew }
}

describe('QA 6.99.29 final: the Sessions reader', () => {
  const SID = 'c6d4d6ff-a62d-4e2a-9c33-e01b2c3d4e5f'
  const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
  const session = (pg: ReturnType<typeof readerPage>) => {
    const r: any = { provider: 'claude', id: SID, draft: null, held: [], verdict: null, refusal: null, feed: pg.kit.newFeed(), live: null, queued: 0 }
    pg.state.reading = r
    return r
  }
  const flushAll = async (pg: ReturnType<typeof readerPage>) => { for (let i = 0; i < 4; i++) { await flush(); pg.runTimers() } await flush() }

  it('a held follow-up sent 800 ms after the end shows Working, with Stop, for its whole run', async () => {
    let turnPolls = 0
    const pg = readerPage({
      ['GET ' + P('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
      ['GET ' + P('/queued-turns')]: { status: 200, body: { turns: [] } },
      ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: null, reasonCopy: '', ownerCount: 0 } },
      ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b9', epoch: 2 } },
      ['POST /api/agent-sessions/bindings/b9/turns']: { status: 202, body: { outcome: 'queued' } },
      ['GET /api/agent-sessions/bindings/b1/turns/ctFirst0001']: () => { turnPolls++; return { status: 200, body: { outcome: 'completed', via: 'resume' } } },
      ['GET /api/agent-sessions/bindings/b9/turns/ctHeld00001']: { status: 200, body: { outcome: 'queued' } },
    })
    const r = session(pg)
    pg.kit.watchSession('claude', SID)
    const say = (seq: number, e: Record<string, unknown>) => pg.streams[0].onmessage({ data: JSON.stringify({ seq, kind: 'status', state_source: 'hook', ...e }) })
    const startedAt = pg.now() - 20_000
    say(1, { state: 'working', agent_state: 'running', state_since: new Date(startedAt).toISOString() })
    expect(pg.live()).toContain('data-action="stop-session"')
    // A follow-up typed while COS answers is held on the page.
    r.held.push({ text: 'and add the test', key: 'ctHeld00001', since: pg.now(), ids: [] })
    // COS's own turn finishes: the watch says completed (a resume child, not live), which is the end of the work.
    pg.kit.watchTurn('b1', 'ctFirst0001', 'claude', SID)
    pg.intervals[pg.intervals.length - 1]!.fn()
    await flush()
    expect(turnPolls).toBe(1)
    const endedAt = pg.now()
    say(2, { state: 'idle', agent_state: 'idle', state_since: new Date(endedAt).toISOString() })
    expect(pg.live()).not.toContain('data-action="stop-session"')
    // 800 ms later the held message goes.
    pg.later(800)
    await flushAll(pg)
    expect(pg.calls.some(c => c.method === 'POST' && c.path === '/api/agent-sessions/bindings/b9/turns' && c.body.prompt === 'and add the test')).toBe(true)
    // The session starts on it: Working with Stop, and still so at every status of the run, inside and past 8 s.
    pg.later(400)
    say(3, { state: 'working', agent_state: 'running', state_since: new Date(endedAt + 1_000).toISOString() })
    for (const [i, ms] of [[4, 2_000], [5, 4_000], [6, 9_000], [7, 30_000]] as const) {
      expect(pg.live(), 'Working at ' + (pg.now() - endedAt) + ' ms').toContain('<strong>Working</strong>')
      expect(pg.live(), 'Stop at ' + (pg.now() - endedAt) + ' ms').toContain('data-action="stop-session"')
      pg.later(ms)
      pg.streams[0].onmessage({ data: JSON.stringify({ seq: i, kind: 'tool', verb: 'read', target: 'app.js' }) })
    }
    expect(pg.live()).toContain('<strong>Working</strong>')
    expect(pg.live()).toContain('data-action="stop-session"')
  })

  it('the probe that re-asks a busy gate stamps every attempt and backs off after a failure; an answer resets it', async () => {
    let mode: 'fail' | 'throw' | 'busy' = 'fail'
    const pg = readerPage({
      ['GET ' + P('/attachability')]: () => mode === 'throw' ? new Error('offline') : mode === 'fail' ? { status: 500, body: {} } : { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
    })
    const r = session(pg)
    r.view = { verdict: () => {}, stateChanged: () => {} }
    pg.kit.applyFeed(r, { seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_source: 'hook', state_since: new Date(pg.now() - 60_000).toISOString() })
    pg.kit.noteGate(r, true)
    expect(pg.kit.truth(r)).toMatchObject({ word: 'Working', src: 'gate' })
    const askedAfter = async (ms: number) => { pg.later(ms); return pg.kit.gateStale(r) }
    expect(await askedAfter(19_000), 'a fresh answer is not re-asked').toBe(false)
    expect(await askedAfter(2_000), '20 s on').toBe(true)
    await pg.kit.probe(r); await flush()
    expect(r.gate.failures).toBe(1)
    expect(r.gate.triedAt).toBe(pg.now())
    expect(await askedAfter(1_000), 'not every second after a failure').toBe(false)
    expect(await askedAfter(30_000), 'one failure: 40 s').toBe(false)
    expect(await askedAfter(10_000)).toBe(true)
    mode = 'throw'
    await pg.kit.probe(r); await flush()
    expect(r.gate.failures, 'a request that never answered is a failure too').toBe(2)
    expect(await askedAfter(79_000), 'two failures: 80 s').toBe(false)
    expect(await askedAfter(2_000)).toBe(true)
    for (let i = 0; i < 4; i++) { await pg.kit.probe(r); await flush() }
    expect(await askedAfter(319_000), 'capped at 16 times: 320 s').toBe(false)
    expect(await askedAfter(2_000)).toBe(true)
    mode = 'busy'
    await pg.kit.probe(r); await flush()
    expect(r.gate.failures ?? 0, 'an answer resets the backoff').toBe(0)
    expect(await askedAfter(19_000)).toBe(false)
    expect(await askedAfter(2_000)).toBe(true)
  })

  it('a Working only the write gate says is re-asked even when the live feed never connected', async () => {
    const pg = readerPage({ ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: null, reasonCopy: '', ownerCount: 0 } } })
    const r = session(pg)
    r.feed.fallback = 'http_404'
    pg.kit.noteGate(r, true)
    r.live = { working: true }
    pg.kit.paintActivity(r)
    expect(pg.live()).toContain('<strong>Working</strong>')
    const live = pg.intervals.filter(i => !i.cleared)
    expect(live.length, 'the recheck timer runs with no feed').toBe(1)
    pg.later(21_000)
    pg.tick()
    await flush()
    expect(pg.calls.filter(c => c.path === P('/attachability')).length, 'the gate was asked again').toBe(1)
    expect(pg.kit.truth(r), 'a free answer clears it').toBeNull()
  })

  it('a refused or expired queued message stays in the line with its reason; it does not vanish', async () => {
    const pg = readerPage({
      ['GET ' + P('/queued-turns')]: { status: 200, body: { turns: [
        { clientTurnId: 'ctWait000001', status: 'waiting', position: 0, preview: 'next one', owner: 'cos' },
        { clientTurnId: 'ctRef0000001', status: 'refused', position: -1, preview: 'the video one', owner: 'cos', reason: 'queued_turn_tampered', reasonCopy: 'Not sent: its words, files or session changed.' },
        { clientTurnId: 'ctExp0000001', status: 'expired', position: -1, preview: 'old one', owner: 'cos', reason: 'queued_turn_expired' },
        { clientTurnId: 'ctDone000001', status: 'delivered', position: -1, preview: 'sent one', owner: 'cos' },
      ] } },
    })
    session(pg)
    pg.kit.loadQueue('claude', SID)
    await flush()
    const html = pg.els['session-queue']!.innerHTML
    expect(html).toContain('1 follow-up queued.')
    expect(html).toContain('the video one')
    expect(html).toContain('Not sent: its words, files or session changed.')
    expect(html).toContain('old one')
    expect(html).toContain('Not sent: the thread stayed busy too long.')
    expect(html, 'a delivered row is not a refusal').not.toContain('sent one')
    expect((html.match(/sx-queue-refused/g) || []).length).toBe(2)
    expect(html).not.toMatch(/[—→]/)
    // 6.99.30: the same read marks the session for its Sessions row chip (app.js noteNotSent), the last line kept.
    const mark = JSON.parse(pg.store.get('cos_web_not_sent') || '{}')['claude|' + SID]
    expect(mark).toMatchObject({ n: 2, line: 'Not sent: the thread stayed busy too long.' })
  })

  it('steer mid-turn: a row COS cannot tell went in has its own label, never "Not sent"', async () => {
    const pg = readerPage({ ['GET ' + P('/queued-turns')]: { status: 200, body: { turns: [
      { clientTurnId: 'ctRef0000003', status: 'refused', position: -1, preview: 'tampered', owner: 'cos', reason: 'queued_turn_tampered', reasonCopy: 'Not sent: its words, files or session changed.' },
      { clientTurnId: 'ctUnk0000001', status: 'refused', position: -1, preview: 'steer this', owner: 'cos', reason: 'steer_unverified', deliveryState: 'unknown', reasonCopy: 'May not have been sent. Read it, then say it again.' },
    ] } } })
    session(pg)
    pg.kit.loadQueue('claude', SID)
    await flush()
    const rows = pg.els['session-queue']!.innerHTML.split('sx-queue-row').slice(1)
    const unknown = rows.find(r => r.includes('steer this'))!
    expect(unknown).toContain('<span class="sx-queue-state">May have been sent</span>')
    expect(unknown).toContain('May not have been sent. Read it, then say it again.')
    expect(unknown).not.toMatch(/Not sent/)
    // A message refused for tampering still reads "Not sent".
    const refused = rows.find(r => r.includes('tampered'))!
    expect(refused).toContain('<span class="sx-queue-state">Not sent</span>')
    expect(refused).toContain('Not sent: its words, files or session changed.')
    // The Sessions row chip takes the last row's label and line.
    const mark = JSON.parse(pg.store.get('cos_web_not_sent') || '{}')['claude|' + SID]
    expect(mark).toMatchObject({ n: 2, label: 'May have been sent', line: 'May not have been sent. Read it, then say it again.' })
  })

  it('only refused rows: they still show, with no "queued" head', async () => {
    const pg = readerPage({ ['GET ' + P('/queued-turns')]: { status: 200, body: { turns: [{ clientTurnId: 'ctRef0000002', status: 'refused', position: -1, preview: 'gone?', owner: 'cos', reason: 'turn_id_in_use', reasonCopy: 'Not sent: its id belongs to another message.' }] } } })
    session(pg)
    pg.kit.loadQueue('claude', SID)
    await flush()
    const html = pg.els['session-queue']!.innerHTML
    expect(html).toContain('Not sent: its id belongs to another message.')
    expect(html).not.toContain('queued.')
  })
})

// ── 6.99.30: history, hidden timers, the Mac going away, refused queued messages, question cards ──────────────────────
describe('6.99.30: Back never lands on a dead entry, and our own Back steps cannot swallow a real one', () => {
  const SID2 = 'b5c3c5ee-f51d-4c19-9b22-d90b129d2a8e'
  const ROW = { session_id: SID2, provider: 'claude', display_label: 'Release QA', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString(), alive: true }
  const routes: Routes = { [`GET /api/agent-sessions/claude/${SID2}?turns=6&cards=1`]: { status: 200, body: { recent_turns: [] } } }

  it('leaving for a tab from a session opened off the pet’s list takes the list’s entry off first, then replaces the overlay’s', async () => {
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes, pet: { waiting: [], running: [ROW], done: [] } })
    h.ta.open('pet', '', h.opener())
    h.ta.open('run', 'claude|' + SID2, h.opener(), { from: { scroll: 0 } })
    await flush()
    expect(h.history.pushes, 'two entries: the list and the session').toBe(2)
    const backs = h.history.backs
    h.tap('open-session')
    expect(h.history.backs, 'the list’s entry comes off').toBe(backs + 1)
    expect(h.location.replaced, 'nothing replaced until that Back lands').toEqual([])
    h.pop()
    expect(h.location.replaced).toEqual(['#/sessions/claude/' + SID2])
    expect(h.ta._state.pops, 'nothing left waiting').toEqual([])
  })

  it('if our Back never arrives, the tab is still opened and the wait lapses', async () => {
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes })
    h.ta.open('pet', '', h.opener())
    h.ta.open('run', 'claude|' + SID2, h.opener(), { from: { scroll: 0 } })
    await flush()
    h.tap('open-session')
    expect(h.location.replaced).toEqual([])
    h.runTimers()
    expect(h.location.replaced, 'replaced after the wait').toEqual(['#/sessions/claude/' + SID2])
    expect(h.ta._state.ignorePops).toBe(0)
  })

  it('X closes with a Back step; when that popstate never comes, the next real Back is not swallowed', () => {
    const h = load()
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('close')
    expect(h.ta._state.ignorePops, 'waiting for our own popstate').toBe(1)
    h.runTimers()   // it never came (a browser that dropped it)
    expect(h.ta._state.ignorePops, 'the wait lapsed').toBe(0)
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.pop()         // the phone's Back
    expect(h.document.appended.hidden, 'the real Back closed the overlay').toBe(true)
  })

  it('X’s own popstate, when it does come, is still ignored once', () => {
    const h = load()
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.tap('close')
    h.pop()
    expect(h.ta._state.ignorePops).toBe(0)
    h.runTimers()   // the lapsed timer of a wait that already ended does nothing
    h.ta.open('meeting', 'Surcharging Push', h.opener())
    h.pop()
    expect(h.document.appended.hidden).toBe(true)
  })
})

describe('6.99.30: a hidden page spends nothing; the Mac going away shows at once', () => {
  const SID2 = 'b5c3c5ee-f51d-4c19-9b22-d90b129d2a8e'
  const PP = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID2)}${tail}`
  const ROW = { session_id: SID2, provider: 'claude', display_label: 'Release QA', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString(), alive: true }
  const busy: Routes = {
    ['GET ' + PP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } },
    ['GET ' + PP('/attachability')]: { status: 200, body: { attachable: false, reason: 'native_thread_working', reasonCopy: 'Working right now.', ownerCount: 0 } },
  }
  it('the live clock’s tick re-asks a stale gate only while the page is visible', async () => {
    const old = new Date(Date.now() - 600_000).toISOString()
    const OLD = { ...ROW, state_since: old, last_activity_at: old }
    const h = load({ data: { sessions: [OLD], working: [OLD] }, routes: busy })
    h.ta.open('run', 'claude|' + SID2, h.opener())
    await flush()
    // The hook's word is ten minutes old; the gate's busy answer on opening is the freshest: the card stands on the gate.
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_since: new Date(Date.now() - 600_000).toISOString() }) })
    const probes = () => h.calls.filter(c => c.path === PP('/attachability')).length
    await flush()
    const before = probes()
    // A minute on (the reader's code reads the real clock): the busy answer is stale.
    const g = h.ta._state.r.gate
    expect(g, 'the card stands on the gate').toMatchObject({ busy: true })
    g.at -= 60_000; g.triedAt = (g.triedAt || g.at) - 60_000
    expect(h.reader.kit.feed.gateStale(h.ta._state.r), 'stale').toBe(true)
    ;(h.document as any).hidden = true
    h.tick(); await flush()
    expect(probes(), 'hidden: no read').toBe(before)
    ;(h.document as any).hidden = false
    h.tick(); await flush()
    expect(probes(), 'visible: the stale gate is asked again').toBe(before + 1)
  })

  it('the turn watch reads only while visible, and its three minutes count only visible time', async () => {
    const SID3 = SID
    const routes: Routes = { ...OK_ROUTES, ['POST /api/agent-sessions/bindings/b1/turns']: { status: 202, body: { outcome: 'queued' } } }
    const h = load({ data: { needs: [NEED] }, routes, api: { '/api/work-board/your-move': { available: true, items: [NEED] } } })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    h.els['ta-input']!.value = 'Ship it'
    h.tap('send')
    await flush()
    const polls = () => h.calls.filter(c => /\/bindings\/b1\/turns\/./.test(c.path)).length
    const live = h.intervals.filter(i => !i.cleared && i.ms === 3000)
    expect(live.length, 'a turn watch runs').toBe(1)
    const before = polls()
    ;(h.document as any).hidden = true
    for (let i = 0; i < 100; i++) { h.later(3000); live[0]!.fn() }
    await flush()
    expect(polls(), 'five hidden minutes: no reads').toBe(before)
    expect(live[0]!.cleared, 'and the watch is still on').toBeFalsy()
    ;(h.document as any).hidden = false
    live[0]!.fn(); await flush()
    expect(polls(), 'visible: it reads').toBe(before + 1)
    void SID3
  })

  it('the Mac going away marks the open sheet at once; coming back opens the stream again', async () => {
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: busy })
    h.ta.open('run', 'claude|' + SID2, h.opener())
    await flush()
    h.streams[0].onmessage({ data: JSON.stringify({ seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_since: new Date().toISOString() }) })
    expect(h.els['ta-live']!.innerHTML).toContain('<strong>Working</strong>')
    h.server(false)
    expect(h.els['ta-live']!.innerHTML, 'at once, not when the stream gives up').toContain('Your Mac is not answering. This is the last state it sent.')
    expect(h.els['ta-live']!.innerHTML, 'no Stop for a Mac that cannot hear it').not.toContain('data-ta="stop"')
    const n = h.streams.length
    h.server(true)
    await flush()
    expect(h.streams.length, 'back up: a new stream').toBe(n + 1)
    h.ta.close('user')
    h.server(false)   // closed: nothing to mark
  })
})

describe('6.99.30: a queued message the server refused, in Today’s sheet and on the Sessions row', () => {
  const SID2 = 'b5c3c5ee-f51d-4c19-9b22-d90b129d2a8e'
  const PP = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID2)}${tail}`
  const ROW = { session_id: SID2, provider: 'claude', display_label: 'Release QA', running: true, running_active: true, agent_state: 'running', state_source: 'hook', state_since: new Date().toISOString(), alive: true }
  it('the sheet says "Not sent: <reason>" for that session, and the mark the Sessions list reads is set and cleared from the server’s queue', async () => {
    let turns: unknown[] = [{ clientTurnId: 'ct1', status: 'refused', preview: 'Also fix the footer', reasonCopy: 'The thread changed on your Mac.' }, { clientTurnId: 'ct2', status: 'queued', preview: 'Later' }]
    const routes: Routes = { ['GET ' + PP('?turns=6&cards=1')]: { status: 200, body: { recent_turns: [] } }, ['GET ' + PP('/queued-turns')]: () => ({ status: 200, body: { turns } }) }
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes })
    h.ta.open('run', 'claude|' + SID2, h.opener())
    await flush()
    const box = h.els['ta-notsent']!.innerHTML
    expect(box).toContain('Also fix the footer')
    expect(box).toContain('Not sent: the thread changed on your Mac.')
    expect(box, 'a queued one is not a refusal').not.toContain('Later')
    expect(h.reader.kit.notSent.get('claude', SID2)).toMatchObject({ n: 1, line: 'Not sent: the thread changed on your Mac.' })
    // The server drops it: the next read clears the mark.
    turns = []
    h.ta.close('user'); h.ta.open('run', 'claude|' + SID2, h.opener()); await flush()
    expect(h.els['ta-notsent']!.innerHTML).toBe('')
    expect(h.reader.kit.notSent.get('claude', SID2)).toBeNull()
    // An expired one, without the server's words.
    turns = [{ clientTurnId: 'ct3', status: 'expired', preview: 'Ping' }]
    h.ta.close('user'); h.ta.open('run', 'claude|' + SID2, h.opener()); await flush()
    expect(h.els['ta-notsent']!.innerHTML).toContain('Not sent: the thread stayed busy too long.')
  })
})

describe('6.99.30: question cards keep one answer across copies and across a reload; folded they are one line; offline they wait', () => {
  const ID = 'pq_' + 'z'.repeat(24), SID2 = 'sess-z'
  const TWO = { ...HELD(ID, SID2, ''), questions: [
    { question: 'Where should it show first?', header: 'Where', multiSelect: false, options: [{ label: 'On the phone, Today', description: '' }, { label: 'Sessions', description: '' }] },
    { question: 'Which parts look right?', header: 'Card check', multiSelect: true, options: [{ label: 'Numbered options', description: '' }, { label: 'Descriptions', description: '' }] },
  ] }
  const otherTarget = (value: string, qi = 0) => ({ value, hasAttribute: (a: string) => a === 'data-sq-other', getAttribute: (a: string) => (({ 'data-sq-id': ID, 'data-q': String(qi) }) as Record<string, string>)[a] })

  it('typed Other words go into every copy of the card (the page’s and the sheet’s)', async () => {
    const q = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }))
    await q.start()
    const sheet = q.mk()
    q.Qs.mount(sheet, SID2)
    const pageBox = { value: '' }, sheetBox = { value: '' }
    q.host.querySelectorAll = ((sel: string) => (sel.includes('data-sq-other') ? [pageBox] : [])) as any
    sheet.querySelectorAll = ((sel: string) => (sel.includes('data-sq-other') ? [sheetBox] : [])) as any
    const typed = Object.assign(sheetBox, otherTarget('Both screens'))
    sheet.querySelectorAll = ((sel: string) => (sel.includes('data-sq-other') ? [typed] : [])) as any
    sheet.listeners.input!({ target: typed })
    expect(pageBox.value, 'the page’s copy').toBe('Both screens')
    expect(q.Qs._state.picks[ID][0].other).toBe('Both screens')
  })

  it('picks and Other words survive a reload of the tab, onto the same question only', async () => {
    const session = new Map<string, string>()
    const a = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }), { session })
    await a.start()
    a.host.listeners.change!({ target: { closest: () => null, hasAttribute: (x: string) => x === 'data-sq-pick', getAttribute: (x: string) => (({ 'data-sq-id': ID, 'data-q': '1', 'data-o': '1' }) as Record<string, string>)[x], checked: true } })
    a.host.listeners.input!({ target: otherTarget('Phone first') })
    expect(JSON.parse(session.get('cos.web.questions.picks')!)[ID]).toEqual([{ labels: [], other: 'Phone first' }, { labels: ['Descriptions'], other: '' }])
    // The reload: a new page, the same tab.
    const b = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }), { session })
    await b.start()
    expect(b.Qs._state.picks[ID]).toEqual([{ labels: [], other: 'Phone first' }, { labels: ['Descriptions'], other: '' }])
    expect(b.host.innerHTML).toContain('value="Phone first"')
    // A different question under the same id (one part) does not take them, and an answered one is forgotten.
    const c = loadQ(() => ({ enabled: true, items: [{ ...TWO, questions: TWO.questions.slice(0, 1) }], settled: [] }), { session })
    await c.start()
    expect(c.Qs._state.picks[ID]).toEqual([{ labels: [], other: '' }])
    const d = loadQ(() => ({ enabled: true, items: [], settled: [] }), { session })
    await d.start()
    expect(JSON.parse(session.get('cos.web.questions.picks')!)[ID], 'gone once nothing holds it').toBeUndefined()
  })

  it('the page host draws a one-line banner over the cards that a tap opens; the sheet’s copy has none', async () => {
    const q = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }))
    await q.start()
    expect(q.host.innerHTML).toContain('<span class="sq-banner-text">1 question for you.</span><span class="sq-banner-act">Answer</span>')
    expect(q.host.innerHTML).toContain('<div class="sq-cards" id="sq-cards">')
    q.host.listeners.click!({ target: { closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? 'banner' : null) }) } })
    expect(q.host.innerHTML).toContain('<div class="sq-cards open" id="sq-cards">')
    expect(q.host.innerHTML).toContain('aria-expanded="true"')
    expect(q.host.innerHTML).toContain('>Hide</span>')
    const sheet = q.mk(); q.Qs.mount(sheet, SID2)
    expect(sheet.innerHTML).not.toContain('sq-banner')
    const css = readFileSync(join(HERE, 'panes', 'questions.css'), 'utf8')
    const folded = css.slice(css.indexOf('@media (max-width: 599px) {\n  .sq-host .sq-banner'))
    expect(folded.slice(0, folded.indexOf('\n}'))).toContain('.sq-host .sq-cards:not(.open) { display: none; }')
    expect(css).toMatch(/^\.sq-banner \{ display: none; \}$/m)
  })

  it('with the Mac not answering, Submit and Leave wait and say why; back up, they answer again', async () => {
    const q = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }))
    await q.start()
    expect(q.host.innerHTML).not.toContain('sq-offline')
    q.setServer(false)
    expect(q.host.innerHTML).toContain('Your Mac is not answering. You can answer here once it is back.')
    expect(q.host.innerHTML).toMatch(/data-sq="send" data-sq-id="[^"]+" disabled>/)
    q.setServer(true)
    expect(q.host.innerHTML).not.toContain('sq-offline')
    expect(q.host.innerHTML).not.toMatch(/data-sq="send" data-sq-id="[^"]+" disabled>/)
  })

  it('a keyboard up on the page unsticks the card’s footer', async () => {
    const q = loadQ(() => ({ enabled: true, items: [TWO], settled: [] }), { vv: { height: 1430, offsetTop: 0 }, innerHeight: 1430 })
    const cls = new Set<string>()
    ;(q.host as any).classList = { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) }
    await q.start()
    q.viewport(900)
    expect(cls.has('sq-kb-up'), '530 px covered').toBe(true)
    q.viewport(1430 - 60)
    expect(cls.has('sq-kb-up'), 'a 60 px strip with nothing in the card focused').toBe(false)
    q.viewport(1430)
    expect(cls.has('sq-kb-up')).toBe(false)
    expect(readFileSync(join(HERE, 'panes', 'questions.css'), 'utf8')).toContain('.sq-host.sq-kb-up .sq-foot { position: static; }')
  })
})
