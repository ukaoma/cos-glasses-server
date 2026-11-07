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
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const WORK = readFileSync(join(HERE, 'panes', 'work.js'), 'utf8')
const QUESTIONS = readFileSync(join(HERE, 'panes', 'questions.js'), 'utf8')
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)

// ── a small fake DOM ─────────────────────────────────────
class El {
  id = ''; innerHTML = ''; textContent = ''; value = ''; hidden = false; disabled = false; readOnly = false; isConnected = true
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
    return Promise.resolve({ status: out.status, text: () => Promise.resolve(JSON.stringify(out.body)) })
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
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0]
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

// ── the overlay, loaded for real ─────────────────────────
interface Opts {
  data?: Record<string, unknown>
  api?: Record<string, unknown | ((body: any, n: number) => unknown)>
  routes?: Routes
  questions?: number
  store?: Map<string, string>
  readerReading?: unknown
  webStore?: Map<string, string>
  styles?: Record<string, Record<string, string>>
  model?: unknown
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
  const history = { state: null as unknown, pushes: 0, backs: 0, replaces: 0, pushState(s: unknown) { this.state = s; this.pushes++ }, replaceState(s: unknown) { this.state = s; this.replaces++ }, back() { this.backs++ } }
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
  let unmounts = 0
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
      reloadIntake: () => { reloads++; return Promise.resolve() },
      refresh: () => { refreshed++ },
    },
    sessionKit: reader.kit,
    // Like questions.js mount(): it draws and calls back with the count before it returns.
    sessionQuestions: { mount: (_el: El, sid: string, onChange?: (n: number) => void) => { mounts.push(sid); if (onChange) onChange(o.questions || 0); return { count: () => o.questions || 0, unmount: () => { unmounts++ } } } },
  }
  const ctx = vm.createContext({
    window: { COSWeb: W, addEventListener: (t: string, fn: () => void) => { winListeners[t] = fn }, visualViewport: undefined },
    document, history, location, fetch, EventSource: FakeEventSource, AbortController, console, Date: VDate, JSON, Math, Promise, isFinite, encodeURIComponent,
    setTimeout: (fn: () => void, ms: number) => { (ctx as any).__timers.push({ fn, ms }); return 1 }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
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
  return { ta, els: elsAll, data, layerTap, webStore, later, now: () => realNow() + skew, posts, apiCalls, gone, calls, store, reader, streams, mounts, history, location, document, tap, opener, key, pop, route, runTimers,
    refreshed: () => refreshed, reloads: () => reloads, workChanged: () => workChanged, unmounts: () => unmounts, ctx }
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
  ['GET ' + P('?turns=6')]: { status: 200, body: { recent_turns: [{ role: 'user', text: 'Do the QA' }, { role: 'assistant', text: 'Ready to publish **6.99.24**.', at: '2026-11-07T05:36:00Z' }] } },
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
    expect(h.els['ta-verdict']!.innerHTML).toContain('Load failed')
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
      ['GET ' + CP('?turns=6')]: { status: 200, body: { recent_turns: [] } },
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
    const q = h.calls.filter(c => c.path === CP('/queued-turns'))
    expect(q).toHaveLength(1)
    expect(q[0]!.body).toMatchObject({ prompt: 'Also fix the footer' })
    expect(h.els['ta-status']!.textContent).toBe('The session is busy. Yours is #2 in line and sends on its own.')
    // Parked by this browser, so the reader offers Cancel on it.
    expect(JSON.parse(h.store.get('cos_web_parked')!)['codex|' + CID]).toEqual([q[0]!.body.clientTurnId])
    h.tap('close')
    expect(es.closed).toBe(true)
  })

  it('a refused stream says why and keeps the stored reply', async () => {
    const h = load({ data: { sessions: [ROW] }, routes: { ['GET ' + CP('?turns=6')]: { status: 200, body: { recent_turns: [{ role: 'assistant', text: 'Done with the build.' }] } } } })
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
    const ctx = vm.createContext({ window: { COSWeb: W }, document, fetch, console, Date, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
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
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: { [`GET /api/agent-sessions/codex/${CID}?turns=6`]: { status: 200, body: { recent_turns: [] } } } })
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
  sessionsState?: string; workState?: string }) {
  const start = APP.indexOf("  // The headline: COS Control's brief"), end = APP.indexOf('  function renderNext(w) {')
  expect(start, 'the headline block').toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0]
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
    window: { COSWeb: { setStory: (n: string, text: string, hot: boolean) => rail.push([n, text, hot]) } },
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + words + domains + plainFn + '\n' + helpers + '\n' + sx + '\n' + APP.slice(start, end) + '\npaintNeeds();\nreturn { renderRunning: renderRunning };\n}')(deps)
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
    expect(n.els['needs-list']!.innerHTML).toContain('Waiting for you. Paused until you answer.')
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
    const h = load({ data: { sessions: [ROW], working: [ROW] }, routes: { ['GET ' + CP('?turns=6')]: { status: 200, body: { recent_turns: [] } }, ['POST ' + CP('/cancel')]: cancel as any } })
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
    const ctx = vm.createContext({ window: { COSWeb: W }, document, fetch, console, Date: QDate, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
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
  const routes: Routes = { ['GET ' + QP('?turns=6')]: { status: 200, body: { recent_turns: [{ role: 'assistant', text: 'Which personas should I update first?' }] } },
    ['GET ' + QP('/attachability')]: { status: 200, body: { attachable: true, ownerCount: 0 } } }
  it('the Needs you row opens the waiting sheet: the question to answer, else the last message and a reply box; no peek, no Stop', async () => {
    const h = load({ data: { sessions: [QROW] }, routes, model, questions: 0 })
    h.ta.open('wait', 'claude|' + QSID, h.opener())
    await flush()
    expect(h.els['ta-title']!.textContent).toBe('Gong personas team update asked you a question')
    const meta = h.els['ta-meta']!.innerHTML
    expect(meta).toContain('Waiting for you. Paused until you answer.')
    expect(meta).toContain('Answer it in a reply below, or open the session.')
    expect(meta).not.toContain('Working')
    expect(h.streams, 'no live peek').toHaveLength(0)
    expect(h.els['ta-live']!.innerHTML).toBe('')
    expect(h.els['ta-last']!.innerHTML).toContain('Which personas should I update first?')
    expect(h.els['ta-foot']!.innerHTML).toContain('placeholder="Reply to this session"')
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
