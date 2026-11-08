/**
 * 11/08: images a session looked at (a Read of a PNG, a browser screenshot) and a prompt's attached images, in the
 * Sessions reader and Today's session sheet. The real production viewer (panes/reader-media.js), the real app transport
 * and the real render hooks, over a small fake DOM. No network, no providers.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const APP = read('./app.js'), TODAY = read('./panes/today-actions.js'), MEDIA = read('./panes/reader-media.js')
const tid = (ch: string) => 'ti_' + ch.repeat(64)
const SID = 'session-one'
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
function region(source: string, from: string, to: string) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length)
  if (a < 0 || b <= a) throw new Error('Production region missing: ' + from)
  return source.slice(a, b)
}
const SLOTS = ['data-reader-images', 'data-reader-files', 'data-reader-tools']
class El {
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  className = ''; id = ''; hidden = false; disabled = false; type = ''; src = ''; alt = ''; title = ''; isConnected = true; scrollTop = 0; value = ''
  private words = ''; private markup = ''
  classes = new Set<string>(); classList = { add: (s: string) => this.classes.add(s), remove: (s: string) => this.classes.delete(s), contains: (s: string) => this.classes.has(s), toggle: (s: string, on: boolean) => on ? this.classes.add(s) : this.classes.delete(s) }
  constructor(public tag: string, public doc: any) {}
  get parentElement(): El | null { return this.parent && this.parent.tag !== '#root' ? this.parent : null }
  set textContent(v: string) { this.words = String(v); this.children = [] }
  get textContent(): string { return [this.words, ...this.children.map(c => c.textContent)].filter(Boolean).join(' ') }
  set innerHTML(v: string) {
    this.markup = v; this.children = []; this.words = ''
    // Keep the relevant nodes in markup order so ordering assertions exercise the rendered sheet.
    for (const m of v.matchAll(/<(\w+)\b([^>]*)>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[2]), slot = /\b(data-reader-(?:images|files|tools))="([^"]*)"/.exec(m[2])
      if (!id && !slot) continue
      const e = new El(m[1], this.doc)
      if (id) { e.id = id[1]; this.doc.ids.set(e.id, e) }
      if (slot) e.attrs[slot[1]] = decode(slot[2])
      this.appendChild(e)
    }
  }
  get innerHTML() { return this.markup + this.children.map(c => c.dump()).join('') }
  dump(): string { return '<' + this.tag + ' ' + JSON.stringify(this.attrs) + ' ' + this.className + ' ' + this.alt + ' ' + this.src + ' ' + this.title + '>' + this.words + this.children.map(c => c.dump()).join('') + '</' + this.tag + '>' }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  appendChild(e: El) { e.parent = this; this.children.push(e); return e }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f) }
  focus() { this.doc.activeElement = this }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  querySelectorAll(sel: string): El[] {
    const hit = (c: El) => sel === 'button' ? c.tag === 'button' : sel === 'img' ? c.tag === 'img' : SLOTS.some(s => sel === '[' + s + ']' && s in c.attrs)
    return this.children.flatMap(c => [hit(c) ? c : null, ...c.querySelectorAll(sel)]).filter(Boolean) as El[]
  }
}
function load(responses: any[] = [], opts: { io?: boolean } = {}) {
  const listeners: Record<string, Function[]> = {}, document: any = { ids: new Map(), activeElement: null }
  document.createElement = (tag: string) => new El(tag, document)
  const root = new El('#root', document)
  document.head = root.appendChild(document.createElement('head')); document.body = root.appendChild(document.createElement('body')); document.documentElement = document.createElement('html')
  document.querySelectorAll = () => []; document.getElementById = (id: string) => document.ids.get(id) ?? null
  document.addEventListener = (name: string, fn: Function) => { (listeners['doc:' + name] ??= []).push(fn) }
  const made: string[] = [], revoked: string[] = [], calls: any[] = [], panes: any = {}, observed: El[] = [], scrolled: number[][] = []
  const fire = (name: string, e: any = {}) => { for (const fn of listeners[name] ?? []) fn(e); return e }
  const entries: any[] = [{ app: 1 }]; let at = 0
  const history = {
    get state() { return entries[at] },
    pushState: (st: any) => { entries.splice(at + 1); entries.push(st); at++ },
    back: () => { if (at > 0) { at--; Promise.resolve().then(() => fire('popstate', {})) } },
  }
  const W: any = { esc, registerPane: (name: string, kit: any) => { panes[name] = kit }, setCrumb() {}, toDate: () => null, clock: () => '' }
  const window: any = { COSWeb: W, AbortController, scrollX: 0, scrollY: 0, addEventListener: (name: string, fn: Function) => { (listeners[name] ??= []).push(fn) },
    scrollTo: (x: number, y: number) => { scrolled.push([x, y]); window.scrollX = x; window.scrollY = y } }
  let ioCallback: Function | null = null
  if (opts.io !== false) window.IntersectionObserver = class { constructor(cb: Function) { ioCallback = cb } observe(el: El) { observed.push(el) } unobserve(el: El) { const i = observed.indexOf(el); if (i >= 0) observed.splice(i, 1) } disconnect() { observed.length = 0 } }
  const fetch = async (path: string, options: any) => {
    calls.push({ path, options }); const result = responses.length ? responses.shift() : new Blob(['image'], { type: 'image/png' })
    const answer = await (typeof result === 'function' ? result(options) : result)
    if (answer instanceof Blob) return { status: 200, ok: true, blob: async () => answer, text: async () => '' }
    return { status: answer?.status ?? 200, ok: !answer?.status || answer.status < 400, text: async () => JSON.stringify(answer?.data ?? {}) }
  }
  const ctx = vm.createContext({ window, document, history, console, fetch, AbortController, Blob, URL: {
    createObjectURL: () => { const url = 'blob:tool-' + made.length; made.push(url); return url }, revokeObjectURL: (url: string) => revoked.push(url),
  }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, showAuth() {} })
  vm.runInContext(region(APP, '  function api(path, opts)', '  // ── state'), ctx)
  W.api = vm.runInContext('api', ctx)
  vm.runInContext(MEDIA, ctx)
  const deps = { window, document, esc, ensurePane: (name: string) => Promise.resolve(panes[name]) }
  const hooks = new Function('deps', 'with(deps){' + region(APP, '  // Output previews are separate', "  // Copy session (Control's Kickstart brief") + 'return {html:readerImagesHtml,mount:readerImagesMount,stop:readerImagesStop};}')(deps)
  const host = document.createElement('section'); document.body.appendChild(host)
  const mount = async (turn: any) => { host.innerHTML = hooks.html(turn); hooks.mount(host, { provider: 'claude', id: SID }); await flush() }
  const intersect = async (els: El[]) => { ioCallback!(els.map(target => ({ target, isIntersecting: true }))); await flush() }
  const key = (name: string) => { let stopped = false; const e = { key: name, preventDefault() {}, stopImmediatePropagation() { stopped = true } }; for (const fn of listeners.keydown ?? []) { if (!stopped) fn(e) } }
  return { W, window, document, history, entries: () => entries, at: () => at, host, hooks, mount, calls, made, revoked, observed, intersect, key, fire, scrolled }
}
const shot = (ch: string, extra: Record<string, unknown> = {}) => ({ id: tid(ch), tool: 'Screenshot', index: 2, total: 2, state: 'available', ...extra })
const readImg = (ch: string, extra: Record<string, unknown> = {}) => ({ id: tid(ch), tool: 'Read', index: 1, total: 2, state: 'available', ...extra })
const thumbs = (host: El): El[] => host.querySelectorAll('button').filter((b: El) => b.className === 'rm-tool-thumb')
const slotDto = (html: string) => [...html.matchAll(/data-reader-tools="([^"]*)"/g)].map(m => JSON.parse(decode(m[1])))

describe('the render hooks hand only checked DTO fields to the viewer', () => {
  it('no path, no data URI, no URL, no extra field; a bad id is dropped and an unknown tool reads Image', () => {
    const t = load()
    const html = t.hooks.html({ toolImages: [readImg('a', { path: '/Users/miles/secret.png', data: 'data:image/png;base64,AAAA', url: 'https://evil.invalid/x.png' }),
      { ...shot('b'), id: 'ai_' + 'b'.repeat(64) }, shot('c', { tool: '<script>' }), { ...shot('d'), reason: '/Users/x' }], toolImagesMore: 2 })
    expect(html).not.toContain('/Users/'); expect(html).not.toContain('data:image'); expect(html).not.toContain('evil')
    expect(slotDto(html)).toEqual([{ items: [
      { id: tid('a'), tool: 'Read', index: 1, total: 2, state: 'available' },
      { id: tid('c'), tool: 'Image', index: 2, total: 2, state: 'available' },
      { id: tid('d'), tool: 'Screenshot', index: 2, total: 2, state: 'available' },
    ], more: 2, before: false }])
  })
  it('the reader puts a before step above the words, the rest below; a YOU turn shows only its attached images', () => {
    const t = load()
    const render = new Function('deps', 'with(deps){' + region(APP, '  function renderTurns(', '  // A refresh never rebuilds') + 'return {render:renderTurns,sig:sxTurnSig};}')({
      esc, readerImagesHtml: t.hooks.html, toDate: () => null, sxMd: (s: string) => '<p>' + esc(s) + '</p>', clock: () => '', sxShortDate: () => '',
    })
    const html = render.render([{ role: 'assistant', text: 'Words', toolImages: [readImg('a', { before: true }), shot('b')] }], {})
    const [before, after] = slotDto(html)
    expect(before).toMatchObject({ before: true, items: [{ id: tid('a') }] }); expect(after).toMatchObject({ before: false, items: [{ id: tid('b') }] })
    expect(html.indexOf('data-reader-tools')).toBeLessThan(html.indexOf('<p>Words</p>'))
    expect(html.lastIndexOf('data-reader-tools')).toBeGreaterThan(html.indexOf('<p>Words</p>'))
    const user = render.render([{ role: 'user', text: 'Look', toolImages: [{ ...readImg('c'), tool: 'Attached', index: 1, total: 1 }], outputImages: [{ id: 'ai_' + 'a'.repeat(64), label: 'x', state: 'available' }] }], {})
    expect(slotDto(user)).toMatchObject([{ items: [{ id: tid('c'), tool: 'Attached' }] }]); expect(user).not.toContain('<div data-reader-images=')
    expect(render.render([{ role: 'user', text: 'Look', previewsOff: true }], {})).toContain('Previews are off')
    // A refresh tells a turn whose step gained an image from the same words.
    expect(render.sig({ role: 'assistant', text: 'Words' })).not.toBe(render.sig({ role: 'assistant', text: 'Words', toolImages: [shot('b')] }))
  })
  it('the count of more rides on the last strip shown, and alone when no thumbnail was given an id', () => {
    const t = load()
    expect(slotDto(t.hooks.html({ toolImages: [readImg('a', { before: true })], toolImagesMore: 4 }))).toMatchObject([{ before: true, more: 4 }])
    expect(slotDto(t.hooks.html({ toolImages: [readImg('a', { before: true }), shot('b')], toolImagesMore: 4 })).map(s => s.more)).toEqual([0, 4])
    expect(slotDto(t.hooks.html({ toolImagesMore: 3 }))).toEqual([{ items: [], more: 3, before: false }])
  })
})

describe('the viewer: lazy thumbnails labelled like the Claude app, tap to enlarge', () => {
  it('nothing is fetched until a thumbnail nears the screen; then only those, through the authenticated tool-image route', async () => {
    const t = load()
    await t.mount({ toolImages: 'abcdef01'.split('').map((ch, i) => ({ id: tid(ch), tool: i % 2 ? 'Screenshot' : 'Read', index: i + 1, total: 8, state: 'available' })) })
    expect(t.calls).toEqual([]); expect(t.observed).toHaveLength(8)
    await t.intersect(thumbs(t.host).slice(0, 2))
    expect(t.calls.map(c => c.path)).toEqual([
      '/api/agent-sessions/claude/session-one/tool-images/' + tid('a') + '/content',
      '/api/agent-sessions/claude/session-one/tool-images/' + tid('b') + '/content',
    ])
    expect(t.calls[0].options).toMatchObject({ credentials: 'same-origin', headers: { 'X-COS-Web': '1' } })
    expect(t.host.textContent).toContain('Read'); expect(t.host.textContent).toContain('1 of 8'); expect(t.host.textContent).toContain('Screenshot')
    expect(thumbs(t.host)[0].attrs['aria-label']).toBe('Open image: Read, 1 of 8')
    expect(t.host.querySelectorAll('img').map((i: El) => i.src)).toEqual(['blob:tool-0', 'blob:tool-1'])
  })
  it('the viewer checks a hand-built slot again: a bad id never becomes a request', async () => {
    const t = load()
    t.host.innerHTML = '<div data-reader-tools="' + esc(JSON.stringify({ items: [{ id: '../../../etc/passwd', tool: 'Read', index: 1, total: 2, state: 'available' }, readImg('a')], more: 0 })) + '">'
    t.hooks.mount(t.host, { provider: 'claude', id: SID }); await flush(); await t.intersect(thumbs(t.host))
    expect(thumbs(t.host)).toHaveLength(1); expect(t.calls.map(c => c.path)).toEqual(['/api/agent-sessions/claude/session-one/tool-images/' + tid('a') + '/content'])
  })
  it('without IntersectionObserver the thumbnails load as output images do', async () => {
    const t = load([], { io: false }); await t.mount({ toolImages: [readImg('a'), shot('b')] })
    expect(t.calls).toHaveLength(2)
  })
  it('+N more is shown and fetches nothing', async () => {
    const t = load(); await t.mount({ toolImages: [readImg('a')], toolImagesMore: 3 })
    expect(t.host.textContent).toContain('+3 more'); await t.intersect(thumbs(t.host)); expect(t.calls).toHaveLength(1)
  })
  it('too large, outside the workspace, missing bytes: honest words, no fetch, no broken image; a passing failure keeps Retry', async () => {
    const t = load()
    await t.mount({ toolImages: [readImg('a', { state: 'unavailable', reason: 'too_large' }), readImg('b', { state: 'unavailable', reason: 'outside_workspace' }),
      readImg('c', { state: 'unavailable', reason: 'missing' }), readImg('d', { state: 'unavailable', reason: 'unavailable' })] })
    expect(t.calls).toEqual([]); expect(t.observed).toEqual([]); expect(t.host.querySelectorAll('img')).toEqual([])
    expect(t.host.textContent).toContain('Too large to show here.'); expect(t.host.textContent).toContain('Not available on this Mac.')
    const retries = t.host.querySelectorAll('button').filter((b: El) => b.textContent === 'Retry image')
    expect(retries.map((b: El) => b.hidden)).toEqual([true, true, true, false])
  })
  it('previews off (403), auth refused (401), too large (413) and gone (404) say so and do not retry; no path reaches the DOM', async () => {
    for (const [status, words] of [[403, 'Previews are off. Turn them on in Settings, Privacy.'], [413, 'Too large to show here.'], [404, 'Reopen the session']] as const) {
      const t = load([{ status, data: { error: 'x', path: '/Users/miles/a.png' } }]); await t.mount({ toolImages: [readImg('a')] }); await t.intersect(thumbs(t.host))
      expect(t.host.textContent, String(status)).toContain(words)
      expect(t.host.querySelectorAll('button').find((b: El) => b.textContent === 'Retry image')!.hidden).toBe(true)
      expect(t.host.innerHTML + t.host.textContent).not.toContain('/Users/')
    }
    const t = load([{ status: 401, data: {} }]); await t.mount({ toolImages: [readImg('a')] }); await t.intersect(thumbs(t.host))
    expect(t.host.textContent).toContain('Signed out')
  })
  it('a served non-image is never shown as one', async () => {
    const t = load([new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' })]); await t.mount({ toolImages: [readImg('a')] }); await t.intersect(thumbs(t.host))
    expect(t.made).toEqual([]); expect(t.host.querySelectorAll('img')).toEqual([])
  })
})

describe('enlarge, then Back or Escape: the same session, the same scroll spot, the half-typed note kept', () => {
  async function opened() {
    const t = load(); const box = t.document.createElement('div'); t.document.body.appendChild(box); box.appendChild(t.host)
    const note = t.document.createElement('textarea'); note.value = 'half typed reply'; t.document.body.appendChild(note)
    await t.mount({ toolImages: [readImg('a'), shot('b')] }); await t.intersect(thumbs(t.host))
    t.window.scrollY = 1240; box.scrollTop = 310
    const thumb = thumbs(t.host)[1]; thumb.click(); await flush()
    // The browser may move the page while the viewer is fixed over it.
    t.window.scrollY = 0; box.scrollTop = 0
    return { t, box, note, thumb }
  }
  it('tap opens the full-size image from the same route, with its tool and place as the title', async () => {
    const { t } = await opened()
    expect(t.W.readerMedia.isOpen()).toBe(true)
    expect(t.calls[2].path).toBe('/api/agent-sessions/claude/session-one/tool-images/' + tid('b') + '/content')
    expect(t.document.body.textContent).toContain('Screenshot, 2 of 2')
  })
  it('Escape closes it, takes its history entry back off, restores both scroll spots and focus; the note is untouched', async () => {
    const { t, box, note, thumb } = await opened()
    expect(t.entries()).toHaveLength(2); expect(t.history.state).toMatchObject({ app: 1, cosImageViewer: 1 })
    t.key('Escape'); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(false)
    expect(t.at()).toBe(0); expect(t.history.state).toEqual({ app: 1 })
    expect(t.window.scrollY).toBe(1240); expect(box.scrollTop).toBe(310)
    expect(t.document.activeElement).toBe(thumb); expect(note.value).toBe('half typed reply')
  })
  it('the phone Back closes only the image: its own popstate is consumed, the next Back is a real one', async () => {
    const { t, box, note } = await opened()
    t.history.back(); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(false); expect(t.window.scrollY).toBe(1240); expect(box.scrollTop).toBe(310); expect(note.value).toBe('half typed reply')
    expect(t.W.readerMedia.popIsMine({})).toBe(false)
  })
  it("Today's sheet ignores the image's Back (whichever listener runs first) and still closes on the next real Back", async () => {
    const { t } = await opened()
    const closes: string[] = []
    const O: any = { open: { kind: 'run', key: 'claude:session-one' }, pops: [], back: null }
    new Function('deps', 'with(deps){' + region(TODAY, '  // Back from an enlarged image', "  // The pet's list again") + '}')({
      W: t.W, O, window: t.window, history: t.history, clearTimeout() {}, close: (why: string) => closes.push(why), backToList: () => closes.push('list'),
    })
    // Today's listener registered after the viewer's here; the event the viewer marked is skipped.
    t.history.back(); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(false); expect(closes).toEqual([])
    // Before the viewer's listener, with the viewer still open, it is skipped too.
    const e: any = {}; thumbs(t.host)[0].click(); await flush()
    expect(t.W.readerMedia.popIsMine(e)).toBe(true)
    t.key('Escape'); await flush(); expect(closes).toEqual([])
    t.fire('popstate', {}); expect(closes).toEqual(['pop'])
  })
})

describe("Today's session sheet orders tool steps around its last reply", () => {
  it.each(['Looked at it.', ''])('keeps before and after image nodes on the correct side of prose %j', async text => {
    const t = load(), box = t.document.createElement('section'); t.document.ids.set('ta-last', box); t.document.body.appendChild(box)
    const O: any = { r: { provider: 'claude', id: SID }, row: {}, open: { kind: 'run' } }
    const K = { answer: async () => ({ status: 200, body: { recent_turns: [
      { role: 'assistant', text: 'Previous reply' },
      { role: 'assistant', text, toolImages: [readImg('a', { before: true }), shot('b')] },
    ] } }), path: () => '/session', markdown: esc, imageHtml: t.hooks.html, imagesMount: t.hooks.mount, imagesStop: t.hooks.stop }
    await new Function('deps', 'with(deps){' + region(TODAY, '  function loadLast(r)', '  // Running: the same live stream') + 'return loadLast(O.r);}')({
      O, K, W: t.W, esc, lower: (s: string) => s.toLowerCase(), $: t.document.getElementById, paintMeta() {}, setHead() {},
    })
    await flush()
    expect(O.last.text).toBe(text)
    const slots = box.children.filter((e: El) => e.getAttribute('data-reader-tools') !== null)
    expect(slots).toHaveLength(2)
    expect(JSON.parse(slots[0].getAttribute('data-reader-tools')!)).toMatchObject({ before: true, items: [{ id: tid('a') }] })
    expect(JSON.parse(slots[1].getAttribute('data-reader-tools')!)).toMatchObject({ before: false, items: [{ id: tid('b') }] })
    const prose = t.document.getElementById('ta-last-text')
    expect(box.children.indexOf(slots[0])).toBeLessThan(box.children.indexOf(prose))
    expect(box.children.indexOf(slots[1])).toBeGreaterThan(box.children.indexOf(prose))
    expect(thumbs(box)).toHaveLength(2)
    expect(t.calls).toEqual([])
  })
  it('loadLast keeps the tool images and the count of more; the sheet mounts them lazily', async () => {
    const t = load(), box = t.document.createElement('section'); t.document.ids.set('ta-last', box); t.document.body.appendChild(box)
    const O: any = { r: { provider: 'claude', id: SID }, row: {}, open: { kind: 'run' } }
    const K = { answer: async () => ({ status: 200, body: { recent_turns: [
      { role: 'user', text: 'Check the render' }, { role: 'assistant', text: 'Looked at it.', toolImages: [readImg('a'), shot('b')], toolImagesMore: 1 },
    ] } }), path: () => '/session', markdown: esc, imageHtml: t.hooks.html, imagesMount: t.hooks.mount, imagesStop: t.hooks.stop }
    await new Function('deps', 'with(deps){' + region(TODAY, '  function loadLast(r)', '  // Running: the same live stream') + 'return loadLast(O.r);}')({
      O, K, W: t.W, esc, lower: (s: string) => s.toLowerCase(), $: t.document.getElementById, paintMeta() {}, setHead() {},
    })
    await flush()
    expect(O.last.toolImages).toHaveLength(2); expect(O.last.toolImagesMore).toBe(1)
    expect(box.textContent).toContain('+1 more'); expect(t.calls).toEqual([])
    await t.intersect(thumbs(box)); expect(t.calls.map(c => c.path.split('/tool-images/')[1])).toEqual([tid('a') + '/content', tid('b') + '/content'])
    expect(box.innerHTML).not.toContain('/Users/')
  })
})
