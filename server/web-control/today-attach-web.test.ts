/**
 * Files from Today (Miles 11/07 08:53: "we should have the ability to 'attach' files and images from the dashboard view
 * as well. Sometimes I need to pass context via a screenshot, photo or file").
 *
 * Runs the REAL attach kit (panes/cos-chat.js, W.cosChat.attach) with a fake XMLHttpRequest, the REAL Today overlay
 * (panes/today-actions.js) with the REAL Sessions reader send path sliced out of app.js (the harness is the one
 * today-actions.test.ts uses), and the REAL Ask sheet code sliced out of app.js. Nothing here reaches a server: every
 * request is answered by a fake.
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
  mac?: number
  pet?: unknown
  cosChat?: unknown
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
      petPlay: () => o.pet ?? { waiting: [], running: [], done: [] },
      reloadIntake: () => { reloads++; return Promise.resolve() },
      refresh: () => { refreshed++ },
    },
    sessionKit: reader.kit,
    cosChat: o.cosChat,
    // Like questions.js mount(): it draws and calls back with the count before it returns.
    sessionQuestions: { mount: (_el: El, sid: string, onChange?: (n: number, mac: number) => void) => { mounts.push(sid); if (onChange) onChange(o.questions || 0, o.mac || 0); return { count: () => o.questions || 0, unmount: () => { unmounts++ } } } },
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
// ── the real attach kit, with a fake XMLHttpRequest ──────
class FakeXHR {
  static sent: FakeXHR[] = []
  method = ''; url = ''; headers: Record<string, string> = {}; body: unknown = null; status = 0; responseText = ''; aborted = false
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  open(m: string, u: string) { this.method = m; this.url = u }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(b: unknown) { this.body = b; FakeXHR.sent.push(this) }
  abort() { this.aborted = true; if (this.onabort) this.onabort() }
  progress(loaded: number, total: number) { if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded, total }) }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); if (this.onload) this.onload() }
  fail() { if (this.onerror) this.onerror() }
}
type Kit = {
  max: number; accept: string
  box(ui?: unknown, opts?: { anyBytes?: number }): { atts: Array<Record<string, any>>; signedOut: boolean; anyBytes: number }
  turnFileBytes(): number; limitLine(box: unknown): string; cameraHtml(attr: string): string
  add(box: unknown, files: unknown): string[]; remove(box: unknown, id: string): void; retry(box: unknown, id: string): boolean; clear(box: unknown): void
  pending(box: unknown): boolean; failed(box: unknown): boolean; ids(box: unknown): string[]; sent(box: unknown): unknown[]
  chipsHtml(box: unknown, attr?: string): string; clipHtml(attr: string, opts?: { any?: number }): string
  pasted(e: unknown): unknown; dragged(e: unknown, zone: unknown): unknown; turnFiles(): number; askOn(): boolean; ensureCaps(): Promise<unknown>
}
function loadChat(health: Record<string, unknown> = { threadTurnAttachments: 5, features: { durableQueryJobs: true } }, answers: Record<string, unknown> = {}, o: { coarse?: boolean; ua?: string; touchPoints?: number; clock?: boolean } = {}) {
  FakeXHR.sent = []
  revoked.length = 0
  const posts: Array<{ path: string; body: any }> = []
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!),
    toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '', toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'today', args: [] }), go: () => {},
    api: (path: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === 'POST') posts.push({ path, body: opts.body })
      const a = answers[(opts?.method || 'GET') + ' ' + path]
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? (path === '/api/health' ? health : {}))
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const coarse = { matches: true, addEventListener: () => {} }
  const docListeners: Record<string, Array<(e: unknown) => void>> = {}
  const document = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { (docListeners[t] ??= []).push(fn) },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { docListeners[t] = (docListeners[t] || []).filter(x => x !== fn) },
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: (q: string) => (o.coarse && q === '(pointer: coarse)' ? coarse : media), scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: o.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1', maxTouchPoints: o.touchPoints ?? 0 } }
  // o.clock: timers the test runs by hand (the upload's stall watch), so a minute passes at once.
  let timerSeq = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const fakeSet = (fn: () => void, ms: number) => { timers.set(++timerSeq, { fn, ms }); return timerSeq }
  const fakeClear = (id: number) => { timers.delete(id) }
  const ctx = vm.createContext({ window, document, setTimeout: o.clock ? fakeSet : setTimeout, clearTimeout: o.clock ? fakeClear : clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto, XMLHttpRequest: FakeXHR, encodeURIComponent, URL: { createObjectURL: (f: { name: string }) => 'blob:fake/' + f.name, revokeObjectURL: (u: string) => { revoked.push(u) } } })
  vm.runInContext(CHAT, ctx)
  const chat = W.cosChat as Record<string, any>
  if (health) chat.fromHealth(health)
  const visibility = (hidden: boolean) => { document.hidden = hidden; (docListeners.visibilitychange || []).forEach(fn => fn({})) }
  /** Runs every pending timer of at least `ms` (a minute of no progress). */
  const elapse = (ms: number) => { for (const [id, t] of [...timers]) if (t.ms <= ms) { timers.delete(id); t.fn() } }
  return { chat, kit: chat.attach as Kit, posts, W, document, visibility, elapse, timers, docListeners }
}
const revoked: string[] = []
const MB = 1048576
const file = (name: string, type: string, size = 2048) => ({ name, type, size, lastModified: Date.UTC(2026, 10, 7, 14) })
const PDF = () => file('notes.pdf', 'application/pdf', 300 * 1024)
const CSV = () => file('pacing.csv', 'text/csv', 4 * 1024)
const mediaId = (c: string) => 'm_' + c.repeat(24)
/** The newest upload still waiting for an answer, or the one at `i`. */
const xhr = (i = -1) => FakeXHR.sent.at(i)!
const ok = (x: FakeXHR, id: string) => x.respond(200, { attachment: { id, kind: 'user_document', mime: 'application/pdf' } })

describe('the attach kit: one copy of the chat’s clip, limits and upload, for every place that sends files', async () => {
  it('takes what the chat takes, refuses the rest in words, and uploads each file the chat’s way', async () => {
    const { kit } = loadChat()
    const box = kit.box()
    const refusals = kit.add(box, [PDF(), file('big.pdf', 'application/pdf', 65 * MB), file('movie.mov', 'video/quicktime', 101 * MB), file('a.zip', 'application/zip')])
    expect(refusals).toEqual([
      'big.pdf is 65 MB. The largest file COS takes is 64 MB.',
      'movie.mov is 101 MB. The largest video COS takes is 100 MB.',
      'a.zip cannot be attached. COS takes photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4 and MOV.',
    ])
    expect(box.atts.map(t => t.name)).toEqual(['notes.pdf'])
    expect(FakeXHR.sent).toHaveLength(1)
    expect(xhr()).toMatchObject({ method: 'POST', url: '/api/media/file', headers: { 'X-COS-Web': '1', 'Content-Type': 'application/pdf', 'X-COS-Filename': 'notes.pdf' } })
  })

  it('five at most: the sixth is refused by name and never uploaded', async () => {
    const { kit } = loadChat()
    const box = kit.box()
    expect(kit.add(box, [1, 2, 3, 4, 5, 6].map(i => file('f' + i + '.csv', 'text/csv')))).toEqual(['Up to 5 attachments per message. f6.csv was not added.'])
    expect(box.atts).toHaveLength(5)
    expect(FakeXHR.sent).toHaveLength(5)
    expect(kit.add(box, [CSV()])).toEqual(['Up to 5 attachments per message. pacing.csv was not added.'])
  })

  it('pending until the Mac keeps it; ids only for kept files; a failure is failed until retried', async () => {
    const { kit } = loadChat()
    const changes: number[] = []
    const box = kit.box({ changed: () => changes.push(1) })
    kit.add(box, [PDF(), CSV()])
    expect(kit.pending(box)).toBe(true)
    expect(kit.ids(box)).toEqual([])
    ok(xhr(0), mediaId('a')); await flush()
    expect(kit.pending(box)).toBe(true)
    expect(kit.ids(box)).toEqual([mediaId('a')])
    xhr(1).fail(); await flush()
    expect(kit.pending(box)).toBe(false)
    expect(kit.failed(box)).toBe(true)
    expect(box.atts[1]!.error).toBe('The Mac did not answer. Retry when it is awake.')
    expect(kit.retry(box, box.atts[1]!.id as string)).toBe(true)
    expect(FakeXHR.sent).toHaveLength(3)
    expect(kit.failed(box)).toBe(false)
    ok(xhr(2), mediaId('b')); await flush()
    expect(kit.ids(box)).toEqual([mediaId('a'), mediaId('b')])
    expect(kit.sent(box)).toEqual([{ name: 'notes.pdf', kind: 'doc', thumb: '' }, { name: 'pacing.csv', kind: 'doc', thumb: '' }])
    expect(changes.length).toBeGreaterThan(3)
  })

  it('Remove stops an upload in flight, and its late answer brings nothing back', async () => {
    const { kit } = loadChat()
    const removed: number[] = []
    const box = kit.box({ removed: () => removed.push(1) })
    kit.add(box, [PDF()])
    const x = xhr()
    kit.remove(box, box.atts[0]!.id as string)
    expect(x.aborted).toBe(true)
    expect(box.atts).toEqual([])
    expect(removed).toEqual([1])
    x.respond(200, { attachment: { id: mediaId('z') } }); await flush()
    expect(kit.ids(box)).toEqual([])
  })

  it('signed out mid-upload: the chip says so and the box is told, nothing is thrown away', async () => {
    const { kit } = loadChat()
    const told: number[] = []
    const box = kit.box({ signedOut: () => told.push(1) })
    kit.add(box, [PDF()])
    xhr().respond(401, { error: 'unauthorized' }); await flush()
    expect(told).toEqual([1])
    expect(box.signedOut).toBe(true)
    expect(box.atts[0]).toMatchObject({ state: 'failed', error: 'Signed out', name: 'notes.pdf' })
  })

  it('chips answer to the box’s own attribute, never the chat’s; the clip has no capture attribute (iOS offers library, camera and files)', async () => {
    const { kit } = loadChat()
    const box = kit.box()
    kit.add(box, [PDF()]); xhr().fail(); await flush()
    const html = kit.chipsHtml(box, 'data-ta')
    expect(html).toContain('data-ta="att-remove"')
    expect(html).toContain('data-ta="att-retry"')
    expect(html).not.toContain('data-cos=')
    const clip = kit.clipHtml('data-ta-file')
    expect(clip).toContain('type="file"')
    expect(clip).toContain(' multiple ')
    expect(clip).toContain('data-ta-file')
    expect(clip).not.toMatch(/capture/)
    expect(clip).toContain('accept="' + kit.accept + '"')
    expect(kit.accept).toContain('image/*')
    expect(kit.accept).toContain('application/pdf')
  })

  it('turnFiles reads threadTurnAttachments: 5 on a Mac that takes files, 0 on an older one or with attach off', async () => {
    expect(loadChat({ threadTurnAttachments: 5 }).kit.turnFiles()).toBe(5)
    expect(loadChat({ threadTurnAttachments: 0 }).kit.turnFiles()).toBe(0)
    expect(loadChat({}).kit.turnFiles()).toBe(0)
    expect(loadChat({ threadTurnAttachments: '5' }).kit.turnFiles()).toBe(0)
  })
})

// ── Today's reply and note boxes ─────────────────────────
const SID = '56627115-dbce-4c1a-9a00-000000000001'
const NEED = { id: 'act-1', workId: 'task:personal:0123456789ab', domain: 'personal', status: 'delivered', provider: 'claude', sessionId: 'claude:' + SID,
  sessionTitle: 'COS Glasses - QA review before publish', title: 'Speaker Diarization for mac meeting', workIdentity: '0123456789ab',
  progress: { reported: 'needsInput', evidence: 'The install is ready. Should I publish?', paused: false } }
const P = (tail: string) => `/api/agent-sessions/claude/${encodeURIComponent(SID)}${tail}`
const TURNS = '/api/agent-sessions/bindings/b1/turns'
const OK_ROUTES: Routes = {
  ['GET ' + P('?turns=6')]: { status: 200, body: { recent_turns: [{ role: 'assistant', text: 'Ready.', at: '2026-11-07T05:36:00Z' }] } },
  ['GET ' + P('/attachability')]: { status: 200, body: { attachable: true, reason: '', reasonCopy: '', ownerCount: 0 } },
  ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } },
  ['POST ' + TURNS]: { status: 202, body: { outcome: 'queued' } },
}
async function overlay(o: { health?: Record<string, unknown>; routes?: Routes; webStore?: Map<string, string> } = {}) {
  const c = loadChat(o.health ?? { threadTurnAttachments: 5, features: { durableQueryJobs: true } })
  const h = load({ data: { needs: [NEED] }, routes: o.routes ?? OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } }, cosChat: c.chat, webStore: o.webStore })
  h.ta.open('need', 'act-1', h.opener())
  await flush()
  const pick = (...files: unknown[]) => (h.document.appended.listeners.change as Array<(e: unknown) => void>)[0]!({ target: { hasAttribute: (a: string) => a === 'data-ta-file', files, value: 'C:\\fakepath\\x' } })
  const chip = (what: string, att: string) => h.ta._onClick({ target: { disabled: false, getAttribute: (a: string) => (a === 'data-ta' ? what : a === 'data-att' ? att : null), closest() { return this } } })
  const turns = () => h.calls.filter(c2 => c2.method === 'POST' && c2.path === TURNS)
  return { h, c, pick, chip, turns }
}

describe('Today: files with a reply or a note, through the reader’s own send path', async () => {
  it('the clip shows only where the Mac takes files on a session turn', async () => {
    expect((await overlay()).h.els['ta-clip']!.innerHTML).toContain('data-ta-file')
    expect((await overlay({ health: { threadTurnAttachments: 0 } })).h.els['ta-clip']!.innerHTML).toBe('')
    expect((await overlay({ health: {} })).h.els['ta-clip']!.innerHTML).toBe('')
  })

  it('an older server: a picked file is ignored, so words never go out claiming files they lack', async () => {
    const { h, pick, turns } = await overlay({ health: {} })
    pick(PDF())
    expect(FakeXHR.sent).toEqual([])
    h.els['ta-input']!.value = 'Words only'
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(1)
    expect('attachmentIds' in turns()[0]!.body).toBe(false)
  })

  it('one tap on Send never sends before the uploads finish; then one turn carries the words and the file ids', async () => {
    const { h, pick, turns } = await overlay()
    pick(PDF(), CSV())
    expect(h.els['ta-files']!.innerHTML).toContain('notes.pdf')
    expect(h.els['ta-files']!.innerHTML).toContain('data-ta="att-remove"')
    expect(h.els['ta-send']!.disabled).toBe(true)
    expect(h.els['ta-send']!.textContent).toBe('Uploading')
    h.els['ta-input']!.value = 'What is wrong in this screenshot?'
    h.tap('send'); await flush()
    expect(turns(), 'nothing is sent while a file uploads').toHaveLength(0)
    expect(h.calls.filter(c => c.method === 'POST'), 'not even the attach').toHaveLength(0)
    expect(h.els['ta-status']!.textContent).toBe('A file is still uploading. Send when it finishes.')
    ok(xhr(0), mediaId('a')); await flush(); ok(xhr(1), mediaId('b')); await flush()
    expect(h.els['ta-send']!.disabled).toBe(false)
    expect(h.els['ta-send']!.textContent).toBe('Send')
    h.tap('send'); h.tap('send')
    await flush()
    expect(turns(), 'a double tap sends once').toHaveLength(1)
    expect(turns()[0]!.body).toMatchObject({ prompt: 'What is wrong in this screenshot?', attachmentIds: [mediaId('a'), mediaId('b')], epoch: 3 })
    expect(h.els['ta-status']!.textContent).toBe('Sent. Watching for the reply.')
    expect(h.els['ta-files']!.innerHTML, 'the sent files leave the box with the words').toBe('')
    expect(h.els['ta-input']!.value).toBe('')
  })

  // QA 6.99.27 (User 1): a failed upload greyed Send out with no reason. Now Send stays tappable and a tap says why.
  it('a failed upload leaves Send tappable; a tap sends nothing and says what to do; Retry, then it sends', async () => {
    const { h, pick, chip, turns } = await overlay()
    pick(PDF()); xhr().fail(); await flush()
    expect(h.els['ta-send']!.disabled, 'never greyed out for a failed file').toBe(false)
    expect(h.els['ta-send']!.textContent).toBe('Send')
    h.els['ta-input']!.value = 'Look at this'
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(0)
    expect(h.els['ta-status']!.textContent).toBe('A file did not upload. Retry it or remove it.')
    expect(h.els['ta-files']!.innerHTML).toContain('Retry')
    const id = h.els['ta-files']!.innerHTML.match(/data-att="([^"]+)"/)![1]!
    chip('att-retry', id)
    expect(FakeXHR.sent).toHaveLength(2)
    ok(xhr(), mediaId('c')); await flush()
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(1)
    expect(turns()[0]!.body.attachmentIds).toEqual([mediaId('c')])
  })

  it('Remove takes the file out before sending: the turn goes with words only', async () => {
    const { h, pick, chip, turns } = await overlay()
    pick(PDF())
    const id = h.els['ta-files']!.innerHTML.match(/data-att="([^"]+)"/)![1]!
    chip('att-remove', id)
    expect(xhr().aborted).toBe(true)
    expect(h.els['ta-files']!.innerHTML).toBe('')
    h.els['ta-input']!.value = 'Never mind the file'
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(1)
    expect('attachmentIds' in turns()[0]!.body).toBe(false)
  })

  it('the files are part of the key: a retry after a lost answer reuses it; other files are another message', async () => {
    const routes: Routes = { ...OK_ROUTES, ['POST ' + TURNS]: (_b, n) => (n === 1 ? new TypeError('Load failed') : { status: 202, body: { outcome: 'queued' } }) }
    const { h, pick, turns } = await overlay({ routes })
    pick(PDF()); ok(xhr(), mediaId('a')); await flush()
    h.els['ta-input']!.value = 'Same words'
    h.tap('send'); await flush()
    h.tap('retry'); await flush()
    expect(turns()).toHaveLength(2)
    expect(turns()[1]!.body.clientTurnId, 'a retry is the same message').toBe(turns()[0]!.body.clientTurnId)
    expect(turns()[1]!.body.attachmentIds).toEqual([mediaId('a')])
    // The same words with another file are a new message, never the old one's replay.
    pick(CSV()); ok(xhr(), mediaId('b')); await flush()
    h.els['ta-input']!.value = 'Same words'
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(3)
    expect(turns()[2]!.body.attachmentIds).toEqual([mediaId('b')])
    expect(turns()[2]!.body.clientTurnId).not.toBe(turns()[0]!.body.clientTurnId)
  })

  it('a lost answer, then other files with the same words: a new key, so the new files are never answered by a replay', async () => {
    const routes: Routes = { ...OK_ROUTES, ['POST ' + TURNS]: (_b, n) => (n === 1 ? new TypeError('Load failed') : { status: 202, body: { outcome: 'queued' } }) }
    const { h, pick, chip, turns } = await overlay({ routes })
    pick(PDF()); ok(xhr(), mediaId('a')); await flush()
    h.els['ta-input']!.value = 'Same words'
    h.tap('send'); await flush()
    // The first may or may not have landed. The PDF comes out and a CSV goes in; the words stay.
    chip('att-remove', h.els['ta-files']!.innerHTML.match(/data-att="([^"]+)"/)![1]!)
    pick(CSV()); ok(xhr(), mediaId('b')); await flush()
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(2)
    expect(turns()[1]!.body.attachmentIds).toEqual([mediaId('b')])
    expect(turns()[1]!.body.clientTurnId).not.toBe(turns()[0]!.body.clientTurnId)
  })

  it('a busy session: the parked turn carries the files to the queue', async () => {
    const routes: Routes = { ...OK_ROUTES,
      ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'native_thread_working', reasonCopy: 'Busy.' } },
      ['POST ' + P('/queued-turns')]: { status: 202, body: { queued: true, position: 0 } } }
    const { h, pick } = await overlay({ routes })
    pick(PDF()); ok(xhr(), mediaId('a')); await flush()
    h.els['ta-input']!.value = 'When you are free, read this'
    h.tap('send'); await flush()
    const parked = h.calls.filter(c => c.method === 'POST' && c.path === P('/queued-turns'))
    expect(parked).toHaveLength(1)
    expect(parked[0]!.body).toMatchObject({ prompt: 'When you are free, read this', attachmentIds: [mediaId('a')] })
    expect(h.els['ta-files']!.innerHTML).toBe('')
  })

  it('a file the Mac no longer has: the server’s words, the files stay for Remove and attach again', async () => {
    const routes: Routes = { ...OK_ROUTES, ['POST ' + TURNS]: { status: 400, body: { outcome: 'refused', reason: 'invalid_request', attachmentError: 'media_expired', reasonCopy: 'A file you attached was kept for 4 hours and has gone. Remove it, attach it again, then send.' } } }
    const { h, pick } = await overlay({ routes })
    pick(PDF()); ok(xhr(), mediaId('a')); await flush()
    h.els['ta-input']!.value = 'Old screenshot'
    h.tap('send'); await flush()
    expect(h.els['ta-status']!.textContent).toBe('A file you attached was kept for 4 hours and has gone. Remove it, attach it again, then send. It is still in the box.')
    expect(h.els['ta-files']!.innerHTML).toContain('notes.pdf')
  })

  it('a send with files cut off by a reload goes again with the same files under the same key, and says so', async () => {
    const first = await overlay({ routes: { ...OK_ROUTES, ['POST ' + TURNS]: () => new TypeError('Load failed') } })
    first.pick(PDF()); ok(xhr(), mediaId('a')); await flush()
    first.h.els['ta-input']!.value = 'Read this file'
    first.h.tap('send'); await flush()
    const key = first.turns()[0]!.body.clientTurnId
    // Reload: a new page with the same browser storage, and no chips.
    const again = await overlay({ webStore: first.h.webStore })
    expect(again.h.els['ta-files']!.innerHTML).toBe('')
    expect(again.h.els['ta-status']!.textContent).toBe('Your last message did not finish sending. Send sends it again with the file you attached.')
    again.h.els['ta-input']!.value = 'Read this file'
    again.h.tap('send'); await flush()
    expect(again.turns()[0]!.body).toMatchObject({ clientTurnId: key, prompt: 'Read this file', attachmentIds: [mediaId('a')] })
  })
})

// ── the Ask sheet (⌘K, Ask on Today) ─────────────────────
// The sheet's file code, sliced out of app.js and run with the real kit; askCos is a fake that records each call.
function sheet(o: { pane?: string; askCos?: (q: string, el: unknown, files: unknown) => Promise<unknown> } = {}) {
  const start = APP.indexOf('  // ── files with Ask COS (11/07')
  const end = APP.indexOf('  function openAsk(prefill) {')
  expect(start, 'app.js has the sheet’s file code').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const c = loadChat()
  const els: Record<string, El> = {}
  const $ = (id: string) => { if (!els[id]) { els[id] = new El(); els[id]!.id = id } return els[id]! }
  const row = new El(); const note = new El()
  row.querySelector = ((sel: string) => (sel === '.note' ? note : null)) as any
  const asked: Array<{ q: string; files: any }> = []
  let closed = 0
  const went: string[] = []
  const deps: Record<string, unknown> = {
    $, esc, state: { pane: o.pane ?? 'today' },
    setStatus: (el: El | null, text: string, err?: boolean) => { if (el) { el.textContent = text || ''; el.setAttribute('data-error', err ? '1' : '0') } },
    askCos: (q: string, el: unknown, files: unknown) => { asked.push({ q, files }); return o.askCos ? o.askCos(q, el, files) : Promise.resolve(['cos']) },
    closeAsk: () => { closed++ }, go: (p: string) => { went.push(p) },
    document: { querySelector: (sel: string) => (sel === '#ask-results [data-action="ask-cos"]' ? row : null) },
    window: { COSWeb: { cosChat: c.chat } },
  }
  // eslint-disable-next-line no-new-func
  const api = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { addAskFiles: addAskFiles, askSheetSend: askSheetSend, paintAskFiles: paintAskFiles, box: function () { return ASK_FILES; } };\n}')(deps)
  return { ...api, els, $, row, note, asked, closed: () => closed, went, kit: c.kit }
}

describe('Ask COS from Today with files: the chat’s clip in the Ask sheet', () => {
  it('chips with Remove, and the Ask row says what goes with it', async () => {
    const s = sheet()
    s.addAskFiles([PDF()])
    expect(s.$('ask-files').innerHTML).toContain('notes.pdf')
    expect(s.$('ask-files').innerHTML).toContain('data-action="att-remove"')
    expect(s.$('ask-files').innerHTML).toContain('Uploading. Ask COS waits for it.')
    expect(s.$('ask-clip').innerHTML).toContain('data-ask-file')
    expect(s.row.disabled).toBe(true)
    expect(s.note.textContent).toBe('Waiting for the upload')
    ok(xhr(), mediaId('a')); await flush()
    expect(s.row.disabled).toBe(false)
    expect(s.$('ask-files').innerHTML).toContain('This file goes with Ask COS.')
  })

  it('never asks before the uploads finish or with one that failed; then once, with the ids, and the files leave', async () => {
    const s = sheet()
    s.addAskFiles([PDF(), CSV()])
    s.askSheetSend('What do these say?')
    expect(s.asked).toEqual([])
    expect(s.$('ask-status').textContent).toBe('A file is still uploading. Ask COS when it finishes.')
    ok(xhr(0), mediaId('a')); await flush()
    xhr(1).fail(); await flush()
    s.askSheetSend('What do these say?')
    expect(s.asked).toEqual([])
    expect(s.$('ask-status').textContent).toBe('A file did not upload. Retry it or remove it, then Ask COS.')
    s.kit.retry(s.box(), s.box().atts[1]!.id as string)
    ok(xhr(), mediaId('b')); await flush()
    s.askSheetSend('What do these say?'); s.askSheetSend('What do these say?')
    expect(s.asked, 'a double tap asks once').toHaveLength(1)
    expect(s.asked[0]).toEqual({ q: 'What do these say?', files: { attachmentIds: [mediaId('a'), mediaId('b')], atts: [{ name: 'notes.pdf', kind: 'doc', thumb: '' }, { name: 'pacing.csv', kind: 'doc', thumb: '' }] } })
    await flush()
    expect(s.box().atts).toEqual([])
    expect(s.closed()).toBe(1)
    expect(s.went).toEqual(['messages'])
  })

  it('no files: the Ask is exactly as before (no files argument)', async () => {
    const s = sheet()
    s.askSheetSend('Plain question')
    expect(s.asked).toEqual([{ q: 'Plain question', files: null }])
  })

  it('an Ask that did not go keeps the files for the next try', async () => {
    const s = sheet({ askCos: () => Promise.reject(new Error('Not sent.')) })
    s.addAskFiles([PDF()]); ok(xhr(), mediaId('a')); await flush()
    s.askSheetSend('Q')
    await flush()
    expect(s.box().atts.map((t: Record<string, any>) => t.mediaId)).toEqual([mediaId('a')])
    expect(s.closed()).toBe(0)
    expect(s.row.disabled).toBe(false)
  })

  it('refusals are said in the sheet, and the sixth file is not added', () => {
    const s = sheet()
    s.addAskFiles([1, 2, 3, 4, 5, 6].map(i => file('f' + i + '.csv', 'text/csv')))
    expect(s.$('ask-status').textContent).toBe('Up to 5 attachments per message. f6.csv was not added.')
    expect(s.box().atts).toHaveLength(5)
  })
})

describe('the Ask carries the files into the query job (askCos, then the chat’s askFromSheet)', () => {
  function askCosKit(pane: string, summary = 'Today, Saturday. Needs you: nothing.') {
    const start = APP.indexOf('  function webJobId() {')
    const end = APP.indexOf('  // ── Usage ──')
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const calls: Array<{ text: string; extra: unknown }> = []
    const deps: Record<string, unknown> = {
      state: { pane }, crypto: globalThis.crypto,
      ensurePane: () => Promise.resolve({ summary: () => summary, summaryMax: 4000 }),
      briefShown: () => null, setStatus: () => {}, api: () => Promise.resolve({}), toast: () => {}, PANES: {},
      window: { COSWeb: { cosChat: { askFromSheet: (text: string, extra: unknown) => { calls.push({ text, extra }); return Promise.resolve(['cos']) } } } },
    }
    // eslint-disable-next-line no-new-func
    const askCos = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn askCos;\n}')(deps)
    return { askCos, calls }
  }
  const files = { attachmentIds: [mediaId('a')], atts: [{ name: 'notes.pdf', kind: 'doc', thumb: '' }] }

  it('from Today: the files and what Today shows; from elsewhere: the files alone; without files: as before', async () => {
    const t = askCosKit('today')
    await t.askCos('Q', null, files)
    expect(t.calls[0]!.extra).toEqual({ attachmentIds: [mediaId('a')], atts: files.atts, context: 'Today, Saturday. Needs you: nothing.' })
    const w = askCosKit('work')
    await w.askCos('Q', null, files)
    expect(w.calls[0]!.extra).toEqual({ attachmentIds: [mediaId('a')], atts: files.atts })
    const plain = askCosKit('work')
    await plain.askCos('Q', null)
    expect(plain.calls[0]!.extra).toBeUndefined()
    const todayPlain = askCosKit('today')
    await todayPlain.askCos('Q', null)
    expect(todayPlain.calls[0]!.extra).toEqual({ context: 'Today, Saturday. Needs you: nothing.' })
  })

  it('askFromSheet puts the ids on POST /api/query-jobs, at most five, beside the Today reference', async () => {
    const c = loadChat({ threadTurnAttachments: 5, features: { durableQueryJobs: true } }, { 'POST /api/query-jobs': { job: { jobId: 'j1', status: 'queued' } } })
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(mediaId)
    await c.chat.askFromSheet('What is this?', { attachmentIds: six, atts: [], context: 'Today: nothing.' })
    const job = c.posts.find(p => p.path === '/api/query-jobs')!
    expect(job.body).toMatchObject({ query: 'What is this?', source: 'web', attachmentIds: six.slice(0, 5), reference: { query: 'What Today in COS Control shows right now', response: 'Today: nothing.' } })
    const c2 = loadChat({ threadTurnAttachments: 5, features: { durableQueryJobs: true } }, { 'POST /api/query-jobs': { job: { jobId: 'j2', status: 'queued' } } })
    await c2.chat.askFromSheet('Words only', { context: 'x' })
    expect('attachmentIds' in c2.posts.find(p => p.path === '/api/query-jobs')!.body).toBe(false)
  })
})

// ── 6.99.27: any file for a session, Take photo, and the Sessions reader ──
const H27 = { threadTurnAttachments: 5, threadTurnFileBytes: 64 * MB, features: { durableQueryJobs: true } }

describe('6.99.27: a session box takes any file, as it is, and says the limits in plain words', () => {
  it('a .zip, a .docx and a HEIC go as they are, marked for a session turn; the chat’s own box still refuses them', async () => {
    const { kit } = loadChat(H27)
    expect(kit.turnFileBytes()).toBe(64 * MB)
    const box = kit.box({}, { anyBytes: kit.turnFileBytes() })
    expect(kit.add(box, [file('logs.zip', 'application/zip'), file('brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), file('IMG_2041.HEIC', 'image/heic', 3 * MB)])).toEqual([])
    expect(box.atts.map(t => [t.name, t.kind, t.mime])).toEqual([
      ['logs.zip', 'file', 'application/zip'],
      ['brief.docx', 'file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['IMG_2041.HEIC', 'photo', 'image/heic'],
    ])
    // Every one is the file itself to /api/media/file, never a resized JPEG, and says it is for a session turn.
    expect(FakeXHR.sent.map(x => [x.url, x.headers['X-COS-Purpose'], x.headers['Content-Type'], (x.body as { name: string }).name])).toEqual([
      ['/api/media/file', 'session-turn', 'application/zip', 'logs.zip'],
      ['/api/media/file', 'session-turn', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'brief.docx'],
      ['/api/media/file', 'session-turn', 'image/heic', 'IMG_2041.HEIC'],
    ])
    const chat = kit.box()
    expect(kit.add(chat, [file('logs.zip', 'application/zip')])).toEqual(['logs.zip cannot be attached. COS takes photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4 and MOV.'])
    kit.add(chat, [PDF()])
    expect(xhr().headers['X-COS-Purpose'], 'the chat never asks for a turn file').toBeUndefined()
  })

  it('the caps in plain words: 64 MB a file, 100 MB a video, nothing empty', () => {
    const { kit } = loadChat(H27)
    const box = kit.box({}, { anyBytes: 64 * MB })
    expect(kit.add(box, [file('dump.bin', 'application/octet-stream', 65 * MB), file('walk.mov', 'video/quicktime', 101 * MB), file('blank.txt', 'text/plain', 0)])).toEqual([
      'dump.bin is 65 MB. A session takes a file up to 64 MB.',
      'walk.mov is 101 MB. A session takes a video up to 100 MB.',
      'blank.txt is empty.',
    ])
    expect(kit.limitLine(box)).toBe('Up to 5 files, 64 MB each (videos up to 100 MB). The session gets where each one is on your Mac.')
  })

  it('a photo shows its own thumbnail, and Remove lets it go', () => {
    const { kit } = loadChat(H27)
    const box = kit.box({}, { anyBytes: 64 * MB })
    kit.add(box, [file('Screenshot.png', 'image/png', 900 * 1024)])
    expect(box.atts[0]!.thumb).toBe('blob:fake/Screenshot.png')
    kit.remove(box, box.atts[0]!.id as string)
    expect(revoked).toEqual(['blob:fake/Screenshot.png'])
  })

  it('threadTurnFileBytes: a whole number of bytes, never above the 64 MB the kit knows', () => {
    expect(loadChat({ threadTurnAttachments: 5, threadTurnFileBytes: '67108864' }).kit.turnFileBytes()).toBe(0)
    expect(loadChat({ threadTurnAttachments: 5, threadTurnFileBytes: 1.5 }).kit.turnFileBytes()).toBe(0)
    expect(loadChat({ threadTurnAttachments: 5, threadTurnFileBytes: 512 * MB }).kit.turnFileBytes()).toBe(64 * MB)
    expect(loadChat({ threadTurnAttachments: 5, threadTurnFileBytes: 10 * MB }).kit.turnFileBytes()).toBe(10 * MB)
  })

  it('an older Mac (no threadTurnFileBytes) keeps the chat’s list for a session box', () => {
    const { kit } = loadChat({ threadTurnAttachments: 5 })
    expect(kit.turnFileBytes()).toBe(0)
    expect(kit.turnFileBytes.call(null)).toBe(0)
    expect(loadChat({ threadTurnAttachments: 0, threadTurnFileBytes: 64 * MB }).kit.turnFileBytes(), 'no files on turns at all').toBe(0)
  })

  it('the clip: no accept list for a session (any file), the chat’s list elsewhere, which includes image/*', () => {
    const { kit } = loadChat(H27)
    const any = kit.clipHtml('data-sx-file', { any: 64 * MB })
    expect(any).not.toContain('accept=')
    expect(any).toContain('aria-label="Attach photos or files, up to 5, 64 MB each"')
    expect(any).not.toMatch(/capture/)
    const narrow = kit.clipHtml('data-ask-file')
    expect(narrow).toMatch(/accept="image\/\*,/)
  })

  it('Take photo: on a phone, the camera itself (image/*, capture environment); on a desktop, not drawn', () => {
    const phone = loadChat(H27, {}, { coarse: true }).kit.cameraHtml('data-sx-file')
    expect(phone).toContain('<input type="file" class="cc-file" accept="image/*" capture="environment" data-sx-file aria-label="Take photo">')
    expect(phone).toContain('#i-camera')
    expect(loadChat(H27).kit.cameraHtml('data-sx-file')).toBe('')
  })

  it('the chat’s own composer has Take photo beside the clip on a phone', () => {
    const c = loadChat(H27, {}, { coarse: true })
    expect(CHAT).toContain("cameraHtml('data-cos-file') + clipHtml('data-cos-file')")
    expect(c.kit.cameraHtml('data-cos-file')).toContain('capture="environment"')
  })
})

// ── QA 6.99.27 (User 3, User 8, Skeptic W3) ──
describe('QA 6.99.27: HEIC on any iPhone or iPad browser, the video cap, and an upload that stops', () => {
  const STANDALONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148'
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  const heic = () => file('IMG_2041.HEIC', 'image/heic', 3 * MB)

  it('a HEIC photo from the Home Screen app (no "Safari" in its user agent) or iPad Chrome is taken and shows its thumbnail', () => {
    for (const [ua, touch] of [[STANDALONE, 5], [IPAD_DESKTOP, 5]] as const) {
      const { kit } = loadChat(undefined, {}, { ua, touchPoints: touch })
      const chat = kit.box()
      expect(kit.add(chat, [heic()]), ua).toEqual([])
      const session = kit.box(undefined, { anyBytes: 64 * MB })
      expect(kit.add(session, [heic()])).toEqual([])
      expect(session.atts[0]!.thumb, 'shown, so decodable').toBe('blob:fake/IMG_2041.HEIC')
    }
    // A Mac browser that is not Safari still cannot read one: refused in the chat, no thumbnail in a session box.
    const { kit } = loadChat(undefined, {}, { ua: MAC_CHROME })
    expect(kit.add(kit.box(), [heic()])[0]).toMatch(/HEIC photo, which only Safari can read/)
    const session = kit.box(undefined, { anyBytes: 64 * MB })
    expect(kit.add(session, [heic()])).toEqual([])
    expect(session.atts[0]!.thumb).toBe('')
  })

  it('100 MB only for video/mp4 and video/quicktime; any other video is a file, 64 MB', () => {
    const { kit } = loadChat()
    const box = kit.box(undefined, { anyBytes: 64 * MB })
    const refusals = kit.add(box, [
      file('clip.mp4', 'video/webm', 80 * MB),          // named mp4, but the browser says WebM
      file('take.mkv', 'video/x-matroska', 80 * MB),
      file('screen.webm', 'video/webm', 63 * MB),
      file('trip.mov', 'video/quicktime', 99 * MB),
      file('demo.mp4', '', 99 * MB),                     // no type: the name decides
    ])
    expect(refusals).toEqual([
      'clip.mp4 is 80 MB. A session takes a file up to 64 MB.',
      'take.mkv is 80 MB. A session takes a file up to 64 MB.',
    ])
    expect(box.atts.map(t => [t.name, t.kind])).toEqual([['screen.webm', 'file'], ['trip.mov', 'video'], ['demo.mp4', 'video']])
  })

  it('no progress for a minute: the upload stops and says so, without blaming the Mac', async () => {
    const { kit, elapse } = loadChat(undefined, {}, { clock: true })
    const box = kit.box()
    kit.add(box, [PDF()])
    const x = xhr()
    x.progress(10, 100)
    elapse(59_999)
    expect(box.atts[0]!.state, 'progress keeps it alive').toBe('uploading')
    elapse(60_000); await flush()
    expect(x.aborted).toBe(true)
    expect(box.atts[0]).toMatchObject({ state: 'failed', error: 'The upload stopped. Nothing moved for a minute. Retry it.' })
    expect(kit.failed(box)).toBe(true)
  })

  it('stopped while the phone was locked: says so, whether it timed out or the connection dropped', async () => {
    const a = loadChat(undefined, {}, { clock: true })
    const boxA = a.kit.box()
    a.kit.add(boxA, [PDF()])
    a.visibility(true); a.visibility(false)
    xhr().fail(); await flush()
    expect(boxA.atts[0]!.error).toBe('The upload stopped while the phone was locked. Retry it.')
    const b = loadChat(undefined, {}, { clock: true })
    const boxB = b.kit.box()
    b.kit.add(boxB, [PDF()])
    b.visibility(true)
    b.elapse(60_000); await flush()
    expect(boxB.atts[0]!.error).toBe('The upload stopped while the phone was locked. Retry it.')
    // Visible the whole time, the connection dropped: the Mac's words, as before.
    const c = loadChat(undefined, {}, { clock: true })
    const boxC = c.kit.box()
    const before = (c.docListeners.visibilitychange ?? []).length
    c.kit.add(boxC, [PDF()])
    expect((c.docListeners.visibilitychange ?? []).length).toBe(before + 1)
    xhr().fail(); await flush()
    expect(boxC.atts[0]!.error).toBe('The Mac did not answer. Retry when it is awake.')
    expect((c.docListeners.visibilitychange ?? []).length, 'the upload stops listening once it ends').toBe(before)
    expect(c.timers.size, 'and its stall watch is gone').toBe(0)
  })

  it('all bytes sent: the Mac reading a big file is not a stall; Remove is still a Remove', async () => {
    const { kit, elapse } = loadChat(undefined, {}, { clock: true })
    const box = kit.box()
    kit.add(box, [PDF(), CSV()])
    xhr(0).progress(100, 100)
    elapse(10 * 60_000); await flush()
    expect(box.atts[0]!.state).toBe('uploading')
    ok(xhr(0), mediaId('a')); await flush()
    expect(box.atts[0]!.state).toBe('ready')
    kit.remove(box, box.atts[1]!.id as string); await flush()
    expect(box.atts.map(t => t.name)).toEqual(['notes.pdf'])
  })
})

describe('6.99.27: Today’s reply box takes any file and says the limits', () => {
  it('a .zip from Today goes as a turn file and its id goes with the words', async () => {
    const c = loadChat(H27)
    const h = load({ data: { needs: [NEED] }, routes: OK_ROUTES, api: { '/api/work-board/your-move': { available: true, items: [NEED] } }, cosChat: c.chat })
    h.ta.open('need', 'act-1', h.opener())
    await flush()
    expect(h.els['ta-clip']!.innerHTML).not.toContain('accept=')
    ;(h.document.appended.listeners.change as Array<(e: unknown) => void>)[0]!({ target: { hasAttribute: (a: string) => a === 'data-ta-file', files: [file('trace.zip', 'application/zip')], value: '' } })
    expect(xhr().headers['X-COS-Purpose']).toBe('session-turn')
    expect(h.els['ta-files']!.innerHTML).toContain('Up to 5 files, 64 MB each')
    xhr().respond(200, { attachment: { id: mediaId('d'), kind: 'session_file' } }); await flush()
    h.els['ta-input']!.value = 'The trace is attached'
    h.tap('send'); await flush()
    const turns = h.calls.filter(x => x.method === 'POST' && x.path === TURNS)
    expect(turns[0]!.body).toMatchObject({ prompt: 'The trace is attached', attachmentIds: [mediaId('d')] })
  })
})

// ── the Sessions reader’s box (Fork and Send) ───────────
function readerPage(o: { routes?: Routes; health?: Record<string, unknown> } = {}) {
  const start = APP.indexOf('  // ── Sessions: read, send, queue, fork, stop')
  const end = APP.indexOf("  // Copy session (Control's Kickstart brief")
  const sx = APP.slice(APP.indexOf('  function sxProvider(p)'), APP.indexOf('  function sxReal()'))
  const mdRegion = APP.slice(APP.indexOf('  // Markdown for an assistant turn'), APP.indexOf('  function renderTurns('))
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0] + '\n' + TRANSPORT
  const c = loadChat(o.health ?? H27, {}, { coarse: true })
  const { fetch, calls } = fakeFetch(o.routes ?? READER_ROUTES)
  const els: Record<string, El> = {}
  const $ = (id: string) => { if (!els[id]) { els[id] = new El(); els[id]!.id = id } return els[id]! }
  for (const id of ['session-form', 'session-input', 'session-files', 'session-clip', 'session-send', 'session-status', 'session-verdict']) $(id)
  ;($('session-turns') as unknown as { appendChild: (e: unknown) => void }).appendChild = () => {}
  const store = new Map<string, string>()
  const r = { provider: 'claude', id: SID, draft: null, held: [], view: null, verdict: null, refusal: null, cautionAck: false, feed: null, live: null, queued: 0 }
  const deps: Record<string, unknown> = {
    state: { reading: r, turnPoll: null, pane: 'sessions' }, $, esc, md: (s: unknown) => String(s), toDate: (v: unknown) => (v ? new Date(String(v)) : null), autoGrow: () => {}, showAuth: () => {},
    clock: () => '9:00', fetch, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
    AbortController, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, requestAnimationFrame: () => 0,
    document: { querySelector: () => null, createElement: () => new El(), documentElement: { scrollHeight: 0 } }, window: { COSWeb: { cosChat: c.chat }, scrollTo: () => {} }, loadSessions: () => {},
  }
  // eslint-disable-next-line no-new-func
  const page = new Function('deps', 'with (deps) {\n' + plainFn + '\n' + sx + '\n' + mdRegion + '\n' + APP.slice(start, end) +
    '\nreturn { send: sendSessionTurn, add: addReaderFiles, paint: paintReaderFiles, box: function () { return readerBox(state.reading); }, dropHeld: dropHeld, flushHeld: function () { flushHeld(state.reading); } };\n}')(deps)
  return { page, els, calls, r, store, kit: c.kit, status: () => els['session-status']?.innerHTML ?? '' }
}
const READER_ROUTES: Routes = {
  ['POST ' + P('/attach')]: { status: 201, body: { attached: true, bindingId: 'b1', epoch: 3 } },
  ['POST ' + TURNS]: { status: 202, body: { outcome: 'queued' } },
  ['POST ' + P('/fork')]: { status: 200, body: { forked: true, forkRef: 'claude:copy' } },
}

describe('6.99.27: the Sessions reader’s box (Fork and Send) takes photos and files', () => {
  it('draws Take photo and the clip (any file); a file waits on Send and Fork, then one turn carries it', async () => {
    const t = readerPage()
    t.page.paint()
    expect(t.els['session-clip']!.innerHTML).toContain('capture="environment"')
    expect(t.els['session-clip']!.innerHTML).toContain('data-sx-file')
    expect(t.els['session-clip']!.innerHTML.match(/accept=/g)).toEqual(['accept='])   // the camera's image/* only
    t.page.add([file('build-log.txt.gz', 'application/gzip')])
    expect(t.els['session-files']!.innerHTML).toContain('build-log.txt.gz')
    expect(t.els['session-files']!.innerHTML).toContain('data-action="att-remove"')
    expect(t.els['session-files']!.innerHTML).toContain('Up to 5 files, 64 MB each')
    expect(t.els['session-send']!.disabled).toBe(true)
    expect(t.els['session-send']!.textContent).toBe('Uploading')
    t.els['session-input']!.value = 'Why did the build fail?'
    t.page.send(false); t.page.send(true); await flush()
    expect(t.calls.filter(x => x.method === 'POST'), 'neither Send nor Fork goes before the upload').toEqual([])
    expect(t.status()).toBe('A file is still uploading. Fork when it finishes.')
    xhr().respond(200, { attachment: { id: mediaId('e'), kind: 'session_file' } }); await flush()
    expect(t.els['session-send']!.disabled).toBe(false)
    t.page.send(false); t.page.send(false); await flush()
    const turns = t.calls.filter(x => x.method === 'POST' && x.path === TURNS)
    expect(turns, 'one turn for a double tap').toHaveLength(1)
    expect(turns[0]!.body).toMatchObject({ prompt: 'Why did the build fail?', attachmentIds: [mediaId('e')] })
    expect(t.page.box().atts, 'the sent file leaves the box').toEqual([])
  })

  it('a failed upload leaves Send and Fork tappable; a tap says why and sends nothing; Remove sends the words alone', async () => {
    const t = readerPage()
    t.page.paint()
    t.page.add([PDF()]); xhr().fail(); await flush()
    expect(t.els['session-send']!.disabled, 'QA 6.99.27: never greyed out for a failed file').toBe(false)
    t.els['session-input']!.value = 'Words'
    t.page.send(true); await flush()
    expect(t.status()).toBe('A file did not upload. Retry it or remove it.')
    t.page.send(false); await flush()
    expect(t.status()).toBe('A file did not upload. Retry it or remove it.')
    expect(t.calls.filter(x => x.method === 'POST')).toEqual([])
    t.kit.remove(t.page.box(), t.page.box().atts[0]!.id as string)
    t.page.send(false); await flush()
    const turns = t.calls.filter(x => x.method === 'POST' && x.path === TURNS)
    expect(turns).toHaveLength(1)
    expect('attachmentIds' in turns[0]!.body).toBe(false)
  })

  it('Fork carries the files to the copy’s first turn; other files are another fork', async () => {
    const t = readerPage()
    t.page.paint()
    t.page.add([CSV()]); ok(xhr(), mediaId('f')); await flush()
    t.els['session-input']!.value = 'Try the other approach in a copy'
    t.page.send(true); await flush()
    const forks = t.calls.filter(x => x.method === 'POST' && x.path === P('/fork'))
    expect(forks).toHaveLength(1)
    expect(forks[0]!.body).toMatchObject({ prompt: 'Try the other approach in a copy', attachmentIds: [mediaId('f')] })
    expect(forks[0]!.body.clientForkId).toMatch(/^fk/)
    expect(t.page.box().atts, 'a made fork took its files').toEqual([])
  })

  it('a fork that did not answer keeps its key for the same words and files, and takes a new one for other files', async () => {
    const routes: Routes = { ...READER_ROUTES, ['POST ' + P('/fork')]: { status: 500, body: {} } }
    const t = readerPage({ routes })
    t.page.paint()
    t.page.add([CSV()]); ok(xhr(), mediaId('a')); await flush()
    t.els['session-input']!.value = 'Copy it'
    t.page.send(true); await flush()
    t.page.send(true); await flush()
    t.kit.remove(t.page.box(), t.page.box().atts[0]!.id as string)
    t.page.add([PDF()]); ok(xhr(), mediaId('b')); await flush()
    t.page.send(true); await flush()
    const forks = t.calls.filter(x => x.method === 'POST' && x.path === P('/fork'))
    expect(forks).toHaveLength(3)
    expect(forks[1]!.body.clientForkId).toBe(forks[0]!.body.clientForkId)
    expect(forks[2]!.body.clientForkId).not.toBe(forks[0]!.body.clientForkId)
    expect(forks[2]!.body.attachmentIds).toEqual([mediaId('b')])
  })

  it('a busy session: the parked message carries the files, and they leave the box', async () => {
    const routes: Routes = { ...READER_ROUTES,
      ['POST ' + P('/attach')]: { status: 409, body: { attached: false, reason: 'native_thread_working', reasonCopy: 'Busy.' } },
      ['POST ' + P('/queued-turns')]: { status: 202, body: { queued: true, position: 0 } } }
    const t = readerPage({ routes })
    t.page.paint()
    t.page.add([PDF()]); ok(xhr(), mediaId('c')); await flush()
    t.els['session-input']!.value = 'When you are free'
    t.page.send(false); await flush()
    const parked = t.calls.filter(x => x.method === 'POST' && x.path === P('/queued-turns'))
    expect(parked[0]!.body).toMatchObject({ prompt: 'When you are free', attachmentIds: [mediaId('c')] })
    expect(t.page.box().atts).toEqual([])
  })

  // QA 6.99.27: a message held until COS's reply ends. Its files leave the box when it is held (they went with it), but
  // taking them was a Remove, and a Remove clears the status line, so the held message lost its Don't send. And a held
  // message that did not go came back as words alone: its files were gone from the box and from what it remembered.
  const HELD_ROUTES = (second: Reply): Routes => ({ ...READER_ROUTES,
    ['POST ' + TURNS]: (_b: unknown, n: number) => n === 1 ? { status: 409, body: { outcome: 'refused', reason: 'native_turn_in_progress' } } : second })
  async function heldWithFile(t: ReturnType<typeof readerPage>, words: string) {
    t.page.paint()
    t.page.add([file('trace.zip', 'application/zip')]); xhr().respond(200, { attachment: { id: mediaId('h'), kind: 'session_file' } }); await flush()
    t.els['session-input']!.value = words
    t.page.send(false); await flush()
  }

  it('held until the reply ends: the files go with it, and the status keeps Don’t send', async () => {
    const t = readerPage({ routes: HELD_ROUTES({ status: 202, body: { outcome: 'queued' } }) })
    await heldWithFile(t, 'Look at the trace after this')
    expect(t.r.held, 'the message is held with its file').toMatchObject([{ text: 'Look at the trace after this', ids: [mediaId('h')] }])
    expect(t.page.box().atts, 'the file went with the held message').toEqual([])
    expect(t.status()).toContain('COS is still answering.')
    expect(t.status(), 'taking the files is not a Remove: Don’t send stays').toContain('data-action="drop-after"')
  })

  it('Don’t send: the words and the file come back, the file as a kept chip that sends with the next message', async () => {
    const t = readerPage({ routes: HELD_ROUTES({ status: 202, body: { outcome: 'queued' } }) })
    await heldWithFile(t, 'Look at the trace after this')
    const saved = JSON.parse(t.store.get('cos_web_held') || '{}')[`claude|${SID}`]
    expect(saved, 'a reload keeps what the files were, too').toMatchObject([{ ids: [mediaId('h')], files: [{ mediaId: mediaId('h'), name: 'trace.zip' }] }])
    t.page.dropHeld(); await flush()
    expect(t.els['session-input']!.value).toBe('Look at the trace after this')
    expect(t.status()).toBe('Not sent. Your message is back in the box. Its file is attached again.')
    expect(t.page.box().atts).toMatchObject([{ name: 'trace.zip', state: 'ready', mediaId: mediaId('h') }])
    expect(t.els['session-files']!.innerHTML).toContain('trace.zip')
    t.page.send(false); await flush()
    const turns = t.calls.filter(x => x.method === 'POST' && x.path === TURNS)
    expect(turns).toHaveLength(2)
    expect(turns[1]!.body).toMatchObject({ prompt: 'Look at the trace after this', attachmentIds: [mediaId('h')] })
  })

  it('a held message the session refuses comes back with its file and the session’s words', async () => {
    const t = readerPage({ routes: HELD_ROUTES({ status: 409, body: { outcome: 'refused', reason: 'thread_closed', reasonCopy: 'This session was closed on your Mac.' } }) })
    await heldWithFile(t, 'After this one')
    t.page.flushHeld(); await flush()
    expect(t.r.held).toEqual([])
    expect(t.status()).toBe('This session was closed on your Mac. Your message is back in the box. Its file is attached again.')
    expect(t.page.box().atts).toMatchObject([{ state: 'ready', mediaId: mediaId('h') }])
  })

  it('a file the Mac no longer keeps (past its 4 hours) is not put back; the status says so plainly', async () => {
    const t = readerPage({ routes: HELD_ROUTES({ status: 202, body: { outcome: 'queued' } }) })
    await heldWithFile(t, 'Later')
    ;(t.r.held[0] as unknown as { files: Array<{ keptAt: number }> }).files[0]!.keptAt -= 4 * 60 * 60_000
    t.page.dropHeld(); await flush()
    expect(t.page.box().atts).toEqual([])
    expect(t.status()).toBe('Not sent. Your message is back in the box. The file it carried was kept for 4 hours and has gone. Attach it again.')
  })

  it('five at most when they come back: what does not fit is said, never dropped quietly', async () => {
    const t = readerPage({ routes: HELD_ROUTES({ status: 202, body: { outcome: 'queued' } }) })
    t.page.paint()
    t.page.add([file('a.zip', 'application/zip'), file('b.zip', 'application/zip')])
    xhr(-2).respond(200, { attachment: { id: mediaId('a'), kind: 'session_file' } }); xhr(-1).respond(200, { attachment: { id: mediaId('b'), kind: 'session_file' } }); await flush()
    t.els['session-input']!.value = 'Both after this'
    t.page.send(false); await flush()
    expect(t.page.box().atts).toEqual([])
    t.page.add([CSV(), CSV(), CSV(), CSV()])
    for (const [i, c] of ['1', '2', '3', '4'].entries()) xhr(i - 4).respond(200, { attachment: { id: mediaId(c), kind: 'user_document' } })
    await flush()
    t.page.dropHeld(); await flush()
    expect(t.page.box().atts.map((a: { mediaId: string }) => a.mediaId)).toEqual([mediaId('1'), mediaId('2'), mediaId('3'), mediaId('4'), mediaId('a')])
    expect(t.status()).toContain('1 of its files is attached again. A file it carried did not come back. Attach it again.')
  })

  it('a Mac that takes no files on a turn: no clip, no camera, and a send is words only', async () => {
    const t = readerPage({ health: { features: { durableQueryJobs: true } } })
    t.page.paint()
    expect(t.els['session-clip']!.innerHTML).toBe('')
    t.page.add([PDF()])
    expect(FakeXHR.sent).toEqual([])
  })
})
