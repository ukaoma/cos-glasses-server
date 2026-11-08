/** Real image module, authenticated app transport, and production reader/Today render hooks. No network or providers. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const APP = read('./app.js'), TODAY = read('./panes/today-actions.js'), MEDIA = read('./panes/reader-media.js')
const ID = 'ai_' + 'a'.repeat(64), SID = 'native/session?one'
const DTO = { id: ID, label: 'Result.png', state: 'available' }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
function region(source: string, from: string, to: string) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length)
  if (a < 0 || b <= a) throw new Error('Production region missing: ' + from)
  return source.slice(a, b)
}
class El {
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  className = ''; id = ''; hidden = false; disabled = false; type = ''; src = ''; alt = ''; isConnected = true; private words = ''; private markup = ''
  classes = new Set<string>(); classList = { add: (s: string) => this.classes.add(s), remove: (s: string) => this.classes.delete(s), contains: (s: string) => this.classes.has(s), toggle: (s: string, on: boolean) => on ? this.classes.add(s) : this.classes.delete(s) }
  constructor(public tag: string, public doc: any) {}
  set textContent(v: string) { this.words = String(v); this.children = [] }
  get textContent(): string { return this.words + this.children.map(c => c.textContent).join(' ') }
  set innerHTML(v: string) {
    this.markup = v; this.children = []; this.words = ''
    for (const m of v.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const e = new El(m[1], this.doc); e.id = m[3]; this.doc.ids.set(e.id, e); this.appendChild(e)
    }
    for (const m of v.matchAll(/<div data-reader-images="([^"]*)">/g)) {
      const e = new El('div', this.doc); e.attrs['data-reader-images'] = decode(m[1]); (v.includes('id="session-turns"') ? this.doc.ids.get('session-turns') : this).appendChild(e)
    }
  }
  get innerHTML() { return this.markup }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  appendChild(e: El) { e.parent = this; this.children.push(e); return e }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f) }
  focus() { this.doc.activeElement = this }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  querySelectorAll(sel: string): El[] {
    return this.children.flatMap(c => [(sel === 'button' ? c.tag === 'button' : sel === 'img' ? c.tag === 'img' : sel === '[data-reader-images]' ? 'data-reader-images' in c.attrs : false) ? c : null, ...c.querySelectorAll(sel)]).filter(Boolean) as El[]
  }
}
function load(responses: any[] = []) {
  const listeners: Record<string, Function[]> = {}, document: any = { ids: new Map(), activeElement: null }
  document.createElement = (tag: string) => new El(tag, document)
  document.head = document.createElement('head'); document.body = document.createElement('body'); document.documentElement = document.createElement('html')
  document.querySelectorAll = () => []; document.getElementById = (id: string) => document.ids.get(id) ?? null
  document.addEventListener = (name: string, fn: Function) => { (listeners['doc:' + name] ??= []).push(fn) }
  const made: string[] = [], revoked: string[] = [], calls: any[] = [], panes: any = {}
  const timers = new Map<number, Function>(); let timerId = 0
  let auth = 0
  const W: any = { esc, registerPane: (name: string, kit: any) => { panes[name] = kit }, setCrumb() {}, toDate: () => null, clock: () => '' }
  const window: any = { COSWeb: W, AbortController, addEventListener: (name: string, fn: Function) => { (listeners[name] ??= []).push(fn) }, scrollTo() {} }
  const fetch = async (path: string, options: any) => {
    calls.push({ path, options }); const result = responses.length ? responses.shift() : new Blob(['image'], { type: 'image/png' })
    const answer = await (typeof result === 'function' ? result(options) : result)
    if (answer instanceof Error) throw answer
    if (typeof answer?.blob === 'function') return answer
    if (answer instanceof Blob) return { status: 200, ok: true, blob: async () => answer, text: async () => { throw new Error('Blob passed through JSON') } }
    return { status: answer?.status ?? 200, ok: !answer?.status || answer.status < 400, text: async () => JSON.stringify(answer?.data ?? {}) }
  }
  const ctx = vm.createContext({ window, document, console, fetch, AbortController, Blob, URL: {
    createObjectURL: () => { const url = 'blob:output-' + made.length; made.push(url); return url }, revokeObjectURL: (url: string) => revoked.push(url),
  }, setTimeout: (fn: Function) => { timers.set(++timerId, fn); return timerId }, clearTimeout: (id: number) => timers.delete(id), setInterval: () => 1, clearInterval() {}, showAuth: () => { auth++ } })
  vm.runInContext(region(APP, '  function api(path, opts)', '  // ── state'), ctx)
  W.api = vm.runInContext('api', ctx)
  vm.runInContext(MEDIA, ctx)
  const ensureCalls: string[] = []
  const deps = { window, document, esc, ensurePane: (name: string) => { ensureCalls.push(name); return Promise.resolve(panes[name]) } }
  const hooks = new Function('deps', 'with(deps){' + region(APP, '  // Output previews are separate', "  // Copy session (Control's Kickstart brief") + 'return {html:readerImagesHtml,mount:readerImagesMount,stop:readerImagesStop};}')(deps)
  const host = document.createElement('section'); document.body.appendChild(host)
  const mount = async (dtos: any[] = [DTO]) => { host.innerHTML = hooks.html({ outputImages: dtos }); hooks.mount(host, { provider: 'codex', id: SID }); await flush() }
  const key = (name: string, shiftKey = false) => {
    let stopped = false; const e = { key: name, shiftKey, preventDefault() {}, stopImmediatePropagation() { stopped = true } }
    for (const fn of listeners.keydown ?? []) { if (!stopped) fn(e) }
    for (const fn of listeners['doc:keydown'] ?? []) { if (!stopped) fn(e) }
  }
  return { W, ctx, window, document, host, hooks, mount, calls, made, revoked, key, panes, ensureCalls, timers, expireTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } }, auth: () => auth }
}
function named(host: El, name: string) { return host.querySelectorAll('button').find(e => e.textContent === name)! }
function thumbnail(host: El) { return host.querySelectorAll('button').find(e => e.className === 'cx-thumb')! }

describe('native output images through the real viewer and app transport', () => {
  it('loads a thumbnail and fullscreen image using only authenticated opaque content URLs, then releases both', async () => {
    const t = load(); await t.mount([{ ...DTO, url: 'https://attacker.invalid/image', path: '/private/output.png' }])
    expect(t.calls[0].path).toBe('/api/agent-sessions/codex/native%2Fsession%3Fone/output-images/' + ID + '/content?variant=thumb')
    expect(t.calls[0].options).toMatchObject({ credentials: 'same-origin', headers: { 'X-COS-Web': '1' }, method: 'GET' })
    expect(t.host.innerHTML).not.toContain('attacker'); expect(t.host.innerHTML).not.toContain('/private/')
    expect(t.host.querySelectorAll('img')[0].src).toBe('blob:output-0')
    thumbnail(t.host).focus(); thumbnail(t.host).click(); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(true)
    expect(t.calls[1].path).toBe(t.calls[0].path.replace('thumb', 'phone'))
    t.key('Escape'); expect(t.W.readerMedia.isOpen()).toBe(false)
    expect(t.revoked).toEqual(['blob:output-1']); expect(t.document.activeElement).toBe(thumbnail(t.host))
    t.hooks.stop(t.host); expect(t.revoked).toEqual(['blob:output-1', 'blob:output-0'])
  })
  it('preserves default JSON and 401 auth semantics for blob calls', async () => {
    const t = load([{ data: { ok: true } }, { status: 401, data: { error: 'unauthorized' } }])
    expect(await t.W.api('/api/test')).toEqual({ ok: true })
    await expect(t.W.api('/api/image', { responseType: 'blob' })).rejects.toMatchObject({ status: 401 })
    expect(t.auth()).toBe(1); expect(t.made).toEqual([])
  })
  it('keeps blob deadlines through stalled bodies and releases both queue slots on timeout', async () => {
    const stalled = (options: any) => ({ status: 200, ok: true, blob: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted body'), { name: 'AbortError' })))
    }) })
    const t = load([stalled, stalled, new Blob(['third'], { type: 'image/png' })])
    await t.mount(['a', 'b', 'c'].map(ch => ({ ...DTO, id: 'ai_' + ch.repeat(64) })))
    expect(t.calls).toHaveLength(2); expect(t.timers.size).toBe(2)
    t.expireTimers(); await flush()
    expect(t.calls.slice(0, 2).every(c => c.options.signal.aborted)).toBe(true)
    expect(t.calls).toHaveLength(3); expect(t.made).toHaveLength(1); expect(t.timers.size).toBe(0)
    expect(t.host.querySelectorAll('button').filter((b: { textContent: string; hidden: boolean }) => b.textContent === 'Retry image' && !b.hidden)).toHaveLength(2)
    const api = load([stalled]); const result = api.W.api('/api/image', { responseType: 'blob' }).catch((e: any) => e)
    await flush(); api.expireTimers(); expect(await result).toMatchObject({ code: 'timeout' })
  })
  it('showing the auth gate releases open reader images and the fullscreen viewer', async () => {
    const t = load(); await t.mount(); thumbnail(t.host).click(); await flush()
    t.document.ids.set('session-turns', t.host)
    for (const id of ['auth-gate', 'app-shell', 'auth-error']) t.document.ids.set(id, t.document.createElement('div'))
    t.document.ids.get('auth-gate').classList.add('hidden')
    new Function('deps', 'with(deps){' + region(APP, '  function showAuth(message)', '  function showShell(info)') + 'showAuth();}')({
      $: t.document.getElementById, readerImagesStop: t.hooks.stop, setStatus() {},
    })
    expect(t.W.readerMedia.isOpen()).toBe(false); expect(t.revoked.sort()).toEqual(t.made.sort())
    expect(t.document.ids.get('auth-gate').classList.contains('hidden')).toBe(false)
  })
  it('says loading, supports transient retry, and never interprets unsupported bytes as an image', async () => {
    let finish: (v: unknown) => void = () => {}
    const t = load([new Promise(r => { finish = r }), new Blob(['bad'], { type: 'text/html' }), new Blob(['ok'], { type: 'image/png' })])
    const pending = t.mount(); await flush(); expect(t.host.textContent).toContain('Loading image')
    finish({ status: 503, data: { error: 'image_unavailable' } }); await pending; await flush()
    expect(t.host.textContent).toContain('could not load'); expect(named(t.host, 'Retry image').hidden).toBe(false)
    named(t.host, 'Retry image').click(); await flush(); expect(t.made).toEqual([])
    named(t.host, 'Retry image').click(); await flush(); expect(t.made).toHaveLength(1)
  })
  it('shows unavailable descriptors honestly; forbidden/unsupported images never fetch and transient ones retry', async () => {
    const t = load(); await t.mount([{ ...DTO, state: 'unavailable', reason: 'outside_workspace' }])
    expect(t.calls).toEqual([]); expect(t.host.textContent).toContain('Not available on this Mac.'); expect(named(t.host, 'Retry image').hidden).toBe(true)
    // 6.99.35: an image a session sent that is gone from disk reads the same, with no Retry.
    t.hooks.stop(t.host); await t.mount([{ ...DTO, state: 'unavailable', reason: 'missing' }])
    expect(t.calls).toEqual([]); expect(t.host.textContent).toContain('Not available on this Mac.'); expect(named(t.host, 'Retry image').hidden).toBe(true)
    t.hooks.stop(t.host); await t.mount([{ ...DTO, state: 'unavailable', reason: 'unavailable' }])
    // A failed workspace lookup is temporary, never worded as outside the workspace, and keeps Retry.
    expect(t.host.textContent).toContain('temporarily unavailable'); expect(t.host.textContent).not.toContain('Not available on this Mac')
    expect(named(t.host, 'Retry image').hidden).toBe(false)
    expect(t.calls).toEqual([]); named(t.host, 'Retry image').click(); await flush(); expect(t.calls).toHaveLength(1)
  })
  it('404 requires a refreshed session, not an endless retry of an expired id', async () => {
    const t = load([{ status: 404, data: { error: 'image_not_found' } }]); await t.mount()
    expect(t.host.textContent).toContain('Reopen the session'); expect(named(t.host, 'Retry image').hidden).toBe(true)
  })
  it('6.99.35: previews turned off in Settings (403 previews_off) says so and offers no Retry', async () => {
    const t = load([{ status: 403, data: { error: 'previews_off' } }]); await t.mount()
    expect(t.host.textContent).toContain('Previews are off. Turn them on in Settings, Privacy.'); expect(named(t.host, 'Retry image').hidden).toBe(true)
  })
  it('disposal fences delayed blobs, and a refresh of the same slots never duplicates requests or revokes the viewer', async () => {
    let finish: (v: unknown) => void = () => {}
    const t = load([new Promise(r => { finish = r })]); await t.mount()
    t.hooks.stop(t.host); finish(new Blob(['late'], { type: 'image/png' })); await flush(); expect(t.made).toEqual([])
    const next = load(); await next.mount(); thumbnail(next.host).click(); await flush()
    next.hooks.mount(next.host, { provider: 'codex', id: SID }); await flush()
    expect(next.calls).toHaveLength(2); expect(next.revoked).toEqual([]); expect(next.W.readerMedia.isOpen()).toBe(true)
    next.hooks.stop(next.host); expect(next.W.readerMedia.isOpen()).toBe(false); expect(next.revoked.sort()).toEqual(next.made.sort())
  })
  it('at most two image requests run at once, and queued images are discarded on leave', async () => {
    const finish: Array<(v: unknown) => void> = []
    const responses = Array.from({ length: 4 }, () => new Promise(r => { finish.push(r) }))
    const t = load(responses)
    await t.mount(['a', 'b', 'c', 'd'].map(ch => ({ ...DTO, id: 'ai_' + ch.repeat(64) })))
    expect(t.calls).toHaveLength(2)
    finish[0](new Blob(['first'], { type: 'image/png' })); await flush(); expect(t.calls).toHaveLength(3)
    t.hooks.stop(t.host)
    finish[1](new Blob(['late'], { type: 'image/png' })); finish[2](new Blob(['late'], { type: 'image/png' })); await flush()
    expect(t.calls).toHaveLength(3); expect(t.made).toHaveLength(1); expect(t.revoked).toEqual(t.made)
  })
  it('a refresh with no image slots releases previews too', async () => {
    const t = load(); await t.mount(); t.host.innerHTML = 'No output images'
    t.hooks.mount(t.host, { provider: 'codex', id: SID }); await flush(); expect(t.revoked).toEqual(t.made)
  })
  it('keyboard focus stays in the viewer; a closed viewer discards its in-flight phone response', async () => {
    let finish: (v: unknown) => void = () => {}
    const t = load([new Blob(['thumb'], { type: 'image/png' }), new Promise(r => { finish = r })]); await t.mount()
    thumbnail(t.host).click(); t.key('Tab'); expect(t.document.activeElement.textContent).toBe('Close image')
    t.key('Escape'); finish(new Blob(['late'], { type: 'image/png' })); await flush(); expect(t.made).toHaveLength(1)
  })
})

const renderRegion = region(APP, '  function renderTurns(', '  // A refresh never rebuilds')
function turnRenderer(t: ReturnType<typeof load>) {
  return new Function('deps', 'with(deps){' + renderRegion + 'return {render:renderTurns,sig:sxTurnSig};}')({
    esc, readerImagesHtml: t.hooks.html, toDate: () => null, sxMd: esc, clock: () => '', sxShortDate: () => '',
  })
}
describe('production reader and Today hook coverage', () => {
  it('full Sessions open runs its actual renderer and mounts image-only assistant output; text and user turns remain separate', async () => {
    const t = load(), render = turnRenderer(t), reader = t.document.createElement('section'); t.document.ids.set('session-reader', reader)
    const turns = [{ role: 'user', text: 'Make an image' }, { role: 'assistant', text: '', outputImages: [DTO] }]
    const noop = () => {}, state: any = {}
    const deps = { window: t.window, document: t.document, state, $: t.document.getElementById, clearInterval: noop, readStore: () => ({}), HELD_KEY: 'held',
      newFeed: () => ({}), SX: { view: 'sessions', rows: [] }, sxSave: noop, paintSessionsHero: noop, sxSame: () => false, sxKey: () => '',
      skeletonRows: () => '', api: async () => ({ recent_turns: turns }), sessionPath: () => '/session', SX_TURNS: 40, sxTitle: () => 'Images', sxTruncNote: () => '',
      sxBadge: () => '', sxFullButton: () => '', esc, sxSubtitle: () => '', renderTurns: render.render, readerImagesStop: t.hooks.stop, readerImagesMount: t.hooks.mount,
      setLive: noop, sxNoteList: noop, paintReaderFiles: noop, readerKit: () => null, renderHeld: noop, loadQueue: noop, sxProbeAttach: noop, requestAnimationFrame: noop, watchSession: noop, sxEmpty: (s: string) => s,
    }
    new Function('deps', 'with(deps){' + region(APP, '  function openSession(provider, id)', '  // ACTIVITY') + 'openSession("codex", "session-one");}')(deps)
    await flush()
    expect(reader.innerHTML).toContain('data-reader-images'); expect(reader.innerHTML).toContain('Make an image')
    expect(t.calls[0]?.path).toContain('/codex/session-one/output-images/')
    expect(render.render([{ role: 'user', text: 'Input', outputImages: [DTO] }], {})).not.toContain('<div data-reader-images=')
    expect(render.render([{ role: 'assistant', text: '![remote](https://x/image.png)' }], {})).not.toContain('data-reader-images')
    expect(render.sig(turns[1])).not.toBe(render.sig({ ...turns[1], outputImages: [{ ...DTO, state: 'unavailable' }] }))
  })
  it('Today selects the image-only last reply, mounts previews, and Escape closes only the image', async () => {
    const t = load(), box = t.document.createElement('section'); t.document.ids.set('ta-last', box); t.document.body.appendChild(box)
    const O: any = { r: { provider: 'codex', id: SID }, row: {}, open: { kind: 'run' } }
    const K = { answer: async () => ({ status: 200, body: { recent_turns: [
      { role: 'assistant', text: 'Earlier prose' }, { role: 'assistant', outputImages: [DTO] }, { role: 'user', text: 'Thanks' },
    ] } }), path: () => '/session', markdown: esc, imageHtml: t.hooks.html, imagesMount: t.hooks.mount, imagesStop: t.hooks.stop }
    const deps = { O, K, W: t.W, esc, lower: (s: string) => s.toLowerCase(), $: t.document.getElementById, paintMeta() {}, setHead() {} }
    await new Function('deps', 'with(deps){' + region(TODAY, '  function loadLast(r)', '  // Running: the same live stream') + 'return loadLast(O.r);}')(deps)
    await flush(); expect(O.last.text).toBe(''); expect(box.innerHTML).not.toContain('Earlier prose'); expect(t.calls).toHaveLength(1)
    let closed = 0
    new Function('deps', 'with(deps){' + region(TODAY, "  document.addEventListener('keydown'", '  // Every tap-then-tap-again') + '}')({ document: t.document, O, W: t.W, $: () => null, close: () => { closed++ } })
    thumbnail(box).click(); await flush(); t.key('Escape'); expect(closed).toBe(0); expect(O.open.kind).toBe('run')
    t.key('Escape'); expect(closed).toBe(1)
    new Function('deps', 'with(deps){' + region(TODAY, '  function stopSession()', '  // The Needs you list') + 'stopSession();}')({ O, K, $: t.document.getElementById, clearInterval() {} })
    expect(t.revoked.sort()).toEqual(t.made.sort())
  })
  it('Today refresh retains the fullscreen image while loading, unchanged, or failed; only a changed reply disposes it', async () => {
    const t = load(), box = t.document.createElement('section'); t.document.ids.set('ta-last', box); t.document.body.appendChild(box)
    const O: any = { r: { provider: 'codex', id: SID }, row: {}, open: { kind: 'run' } }
    const replies: any[] = []
    const K = { answer: () => Promise.resolve(replies.shift()), path: () => '/session', markdown: esc,
      imageHtml: t.hooks.html, imagesMount: t.hooks.mount, imagesStop: t.hooks.stop }
    const readLast = new Function('deps', 'with(deps){' + region(TODAY, '  function loadLast(r)', '  // Running: the same live stream') + 'return loadLast;}')({
      O, K, W: t.W, esc, lower: (s: string) => s.toLowerCase(), $: t.document.getElementById, paintMeta() {}, setHead() {},
    })
    const answer = (text = '') => ({ status: 200, body: { recent_turns: [{ role: 'assistant', text, outputImages: [DTO] }] } })
    replies.push(answer()); await readLast(O.r); await flush(); thumbnail(box).click(); await flush()
    const firstThumb = thumbnail(box), urls = [...t.made]
    let finish!: (v: unknown) => void; replies.push(new Promise(r => { finish = r }))
    const pending = readLast(O.r); expect(t.W.readerMedia.isOpen()).toBe(true); expect(t.revoked).toEqual([])
    finish(answer()); await pending; await flush(); expect(thumbnail(box)).toBe(firstThumb); expect(t.calls).toHaveLength(2)
    replies.push({ status: 503 }); await readLast(O.r)
    expect(t.W.readerMedia.isOpen()).toBe(true); expect(t.revoked).toEqual([])
    expect(t.document.ids.get('ta-last-refresh')?.textContent).toContain('previous reply')
    replies.push(Promise.reject(new Error('offline'))); await readLast(O.r)
    expect(t.W.readerMedia.isOpen()).toBe(true); expect(t.revoked).toEqual([])
    replies.push(answer('A changed reply')); await readLast(O.r); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(false); expect(t.revoked.sort()).toEqual(urls.sort())
    expect(box.innerHTML).toContain('A changed reply'); expect(t.calls).toHaveLength(3)
    // An earlier request finishing last must not replace a newer successful reply.
    let finishOlder!: (v: unknown) => void; replies.push(new Promise(r => { finishOlder = r }))
    const older = readLast(O.r); replies.push(answer('Newest reply')); await readLast(O.r); await flush()
    const newestThumb = thumbnail(box); finishOlder(answer('Stale reply')); await older; await flush()
    expect(box.innerHTML).toContain('Newest reply'); expect(thumbnail(box)).toBe(newestThumb)
  })
  it('the existing lazy loader shares one script request between simultaneous readers', async () => {
    const scripts: any[] = [], PANES: any = {}
    const deps = { PANES, LAZY: () => ({ readerMedia: '/control/panes/reader-media.js?v=hash' }), TITLES: {},
      document: { createElement: () => ({}), body: { appendChild: (s: unknown) => scripts.push(s) } }, setTimeout: () => 1, clearTimeout() {},
    }
    const ensure = new Function('deps', 'with(deps){' + region(APP, '  var lazyLoads = {};', '  function prefetchPanes()') + 'return ensurePane;}')(deps)
    const first = ensure('readerMedia', 4000), second = ensure('readerMedia', 4000)
    expect(scripts).toHaveLength(1); expect(scripts[0].src).toBe('/control/panes/reader-media.js?v=hash')
    PANES.readerMedia = { mount() {} }; scripts[0].onload()
    expect(await first).toBe(PANES.readerMedia); expect(await second).toBe(PANES.readerMedia)
  })
  it('lazy helper is versioned through the existing manifest and a failed helper never erases reply prose', async () => {
    const manifest = /id="lazy-panes">([\s\S]*?)<\/script>/.exec(read('./index.html'))![1]
    expect(JSON.parse(manifest).readerMedia).toBe('/control/panes/reader-media.js')
    const t = load(); delete t.panes.readerMedia
    t.host.innerHTML = 'Keep the reply' + t.hooks.html({ outputImages: [DTO] }); t.hooks.mount(t.host, { provider: 'codex', id: SID }); await flush()
    expect(t.host.innerHTML).toContain('Keep the reply'); expect(t.host.textContent).toContain('Image previews could not load')
    t.panes.readerMedia = t.W.readerMedia; named(t.host, 'Retry images').click(); await flush(); expect(t.calls).toHaveLength(1)
  })
})
