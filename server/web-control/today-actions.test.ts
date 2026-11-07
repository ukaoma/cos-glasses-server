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
  const touched: string[] = []
  const timers: Array<() => void> = []
  const deps: Record<string, unknown> = {
    state: { reading: readerReading, turnPoll: null },
    $: (id: string) => { touched.push(id); return null },
    esc, md: (s: unknown) => String(s), toDate: (v: unknown) => (v ? new Date(String(v)) : null), autoGrow: () => {}, showAuth: () => {},
    sxProvider: (p: string) => (p === 'codex' || p === 'cursor' ? p : 'claude'),
    sxProviderLabel: (p: string) => (p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude'),
    sxTitle: (s: { display_label?: string }) => s.display_label || 'Session', sxState: () => 'recent', sxStateLabel: () => '', sxMd: (s: string) => esc(s),
    fetch, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
    AbortController, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {}, requestAnimationFrame: () => 0, document: {}, window: { COSWeb: {}, scrollTo: () => {} },
  }
  // eslint-disable-next-line no-new-func
  const kit = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn ' + kitExpr + ';\n}')(deps)
  return { kit, touched, deps }
}

// ── the overlay, loaded for real ─────────────────────────
interface Opts {
  data?: Record<string, unknown>
  api?: Record<string, unknown | ((body: any, n: number) => unknown)>
  routes?: Routes
  questions?: number
  store?: Map<string, string>
  readerReading?: unknown
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
    createElement: () => { const e = new El(); e.doc = document; return e },
    getElementById: (id: string) => { if (!els[id]) { els[id] = new El(); els[id]!.id = id; els[id]!.doc = document } return els[id] },
    querySelector: (sel: string) => document.selectors?.[sel] ?? null,
    addEventListener: (t: string, fn: (e: any) => void) => { (docListeners[t] ??= []).push(fn) },
  }
  document.getElementById('ask-sheet').classList.add('hidden')
  const history = { state: null as unknown, pushes: 0, backs: 0, pushState(s: unknown) { this.state = s; this.pushes++ }, back() { this.backs++ } }
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
  const { fetch, calls } = fakeFetch(o.routes || {})
  const reader = readerKit(fetch, store, o.readerReading ?? null)
  const streams: any[] = []
  class FakeEventSource { url: string; closed = false; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; readyState = 1
    constructor(url: string) { this.url = url; streams.push(this) } close() { this.closed = true } }
  const mounts: string[] = []
  let unmounts = 0
  const W: Record<string, unknown> = {
    esc, api, go: (p: string, a: string[]) => { location.hash = '#/' + [p].concat(a || []).join('/') }, isPhone: () => true, autoGrow: () => {},
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
      reloadIntake: () => { reloads++; return Promise.resolve() },
      refresh: () => { refreshed++ },
    },
    sessionKit: reader.kit,
    sessionQuestions: { mount: (_el: El, sid: string) => { mounts.push(sid); return { count: () => o.questions || 0, unmount: () => { unmounts++ } } } },
  }
  const ctx = vm.createContext({
    window: { COSWeb: W, addEventListener: (t: string, fn: () => void) => { winListeners[t] = fn }, visualViewport: undefined },
    document, history, location, fetch, EventSource: FakeEventSource, AbortController, console, Date, JSON, Math, Promise, isFinite, encodeURIComponent,
    setTimeout: (fn: () => void, ms: number) => { (ctx as any).__timers.push({ fn, ms }); return 1 }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
  })
  ;(ctx as any).__timers = []
  vm.runInContext(TA, ctx)
  const ta = panes.todayActions
  expect(ta, 'the overlay registers as a lazy pane').toBeTruthy()
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
  return { ta, els: elsAll, data, posts, apiCalls, gone, calls, store, reader, streams, mounts, history, location, document, tap, opener, key, pop, route, runTimers,
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
    h.tap('dismiss', ID1)
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
    h.tap('dismiss', ID2); await flush()
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
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } }, questions: 1 })
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
    expect(h.els['ta-last']!.innerHTML).toContain('Ready to publish **6.99.24**.')
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
    expect(s).toContain('Up next: Quilt leadership sync at 9:00 PM tomorrow.')
    expect(s).not.toContain(SID)
    expect(s).not.toContain(ID1)
    expect(s).not.toMatch(/—|->|→/)
  })

  it('never stacks a full stop on a title that already ends one', () => {
    const h = load({ data: { needs: [{ ...NEED, title: 'Speaker Diarization for mac meeting\u2026' }] } })
    expect(h.ta.summary()).toContain('Work card: Speaker Diarization for mac meeting\u2026 The session said')
    expect(h.ta.summary()).not.toContain('\u2026.')
  })

  it('stays under its bound however much Today holds, and is empty before Today has loaded', () => {
    const many = Array.from({ length: 300 }, (_, i) => ITEM('wi_' + String(i).padStart(32, '0'), 'A long suggestion '.repeat(20), { meeting: MEETING('Meeting ' + (i % 40)) }))
    const h = load({ data: { intake: many, needs: Array.from({ length: 40 }, () => NEED) } })
    expect(h.ta.summary().length).toBeLessThanOrEqual(4000)
    expect(load({ data: { at: 0 } }).ta.summary()).toBe('')
  })
})

// ── the Ask carries it (app.js askCos and panes/cos-chat.js) ─────────────
function askCos(pane: string, chat: unknown) {
  const start = APP.indexOf('  var TODAY_REFERENCE'), end = APP.indexOf('  // ── Memories (the native page, hosted)')
  expect(start).toBeGreaterThan(0)
  const posts: any[] = [], ensured: string[] = []
  const deps = {
    state: { pane }, PANES: {}, toast: () => {}, setStatus: () => {}, webJobId: () => '11111111-2222-4333-8444-555555555555',
    ensurePane: (n: string) => { ensured.push(n); return Promise.resolve({ summary: () => 'Needs you (1): QA review.' }) },
    api: (path: string, o: { body: unknown }) => { posts.push({ path, body: o.body }); return Promise.resolve({}) },
    window: { COSWeb: { cosChat: chat } }, setTimeout: () => 0,
  }
  // eslint-disable-next-line no-new-func
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
    const { parseQueryJobRequest, QUERY_JOB_LIMITS } = await import('../lib/query-job-types.js')
    const h = load({ data: { intake: Array.from({ length: 300 }, (_, i) => ITEM('wi_' + String(i).padStart(32, '0'), 'A long suggestion '.repeat(20), { meeting: MEETING('Meeting ' + (i % 40)) })), needs: [NEED] } })
    const summary = h.ta.summary()
    const parsed = parseQueryJobRequest({ clientJobId: '11111111-2222-4333-8444-555555555555', generation: 1, query: 'What first?', sessionId: 'sess0042',
      reference: { query: 'What Today in COS Control shows right now', response: summary } })
    expect(parsed.reference).toEqual({ query: 'What Today in COS Control shows right now', response: summary })
    expect(summary.length).toBeLessThan(QUERY_JOB_LIMITS.referenceResponseChars)
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
