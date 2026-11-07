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
  box(ui?: unknown): { atts: Array<Record<string, any>>; signedOut: boolean }
  add(box: unknown, files: unknown): string[]; remove(box: unknown, id: string): void; retry(box: unknown, id: string): boolean; clear(box: unknown): void
  pending(box: unknown): boolean; failed(box: unknown): boolean; ids(box: unknown): string[]; sent(box: unknown): unknown[]
  chipsHtml(box: unknown, attr?: string): string; clipHtml(attr: string): string
  pasted(e: unknown): unknown; dragged(e: unknown, zone: unknown): unknown; turnFiles(): number; askOn(): boolean; ensureCaps(): Promise<unknown>
}
function loadChat(health: Record<string, unknown> = { threadTurnAttachments: 5, features: { durableQueryJobs: true } }, answers: Record<string, unknown> = {}) {
  FakeXHR.sent = []
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
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} }, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1' } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto, XMLHttpRequest: FakeXHR, encodeURIComponent })
  vm.runInContext(CHAT, ctx)
  const chat = W.cosChat as Record<string, any>
  if (health) chat.fromHealth(health)
  return { chat, kit: chat.attach as Kit, posts, W }
}
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

  it('a failed upload blocks Send with words that say what to do; Retry, then it sends', async () => {
    const { h, pick, chip, turns } = await overlay()
    pick(PDF()); xhr().fail(); await flush()
    expect(h.els['ta-send']!.disabled).toBe(true)
    h.els['ta-input']!.value = 'Look at this'
    h.tap('send'); await flush()
    expect(turns()).toHaveLength(0)
    expect(h.els['ta-status']!.textContent).toBe('A file did not upload. Retry it or remove it, then send.')
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
