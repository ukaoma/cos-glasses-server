/**
 * 7.0.45 (Miles 19:29): a response's images open as one set in the viewer. Runs the real panes/reader-media.js with the
 * real app transport and reader render hooks (the harness of reader-media-web.test.ts), with fetch answered by path.
 * Order and opening on the tapped image, Previous and Next, the arrow keys, the ends, the counter and its name, swipe
 * (horizontal moves, vertical and two fingers do not), a tap on the dark area closes, close restores focus and scroll,
 * the one-image case, a failed and an unavailable image, preload of the next image only, and every blob released.
 */
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
  get parentElement() { return this.parent }
  get previousElementSibling(): El | null { const p = this.parent; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1]! : null }
  compareDocumentPosition(other: El): number {
    const path = (e: El) => { const out: number[] = []; for (let x: El | null = e; x && x.parent; x = x.parent) out.unshift(x.parent.children.indexOf(x)); return out }
    const a = path(this), b = path(other)
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? 4 : 2
    return a.length < b.length ? 20 : 10
  }
  closest(sel: string): El | null { const want = sel.replace(/^\./, ''); for (let e: El | null = this; e; e = e.parent) if (e.className.split(' ').includes(want) || e.classes.has(want)) return e; return null }
  querySelectorAll(sel: string): El[] {
    return this.children.flatMap(c => [(sel === 'button' ? c.tag === 'button' : sel === 'img' ? c.tag === 'img' : sel === '[data-reader-images]' ? 'data-reader-images' in c.attrs : false) ? c : null, ...c.querySelectorAll(sel)]).filter(Boolean) as El[]
  }
}

function load(fail: (path: string) => boolean = () => false, hold: (path: string) => boolean = () => false) {
  const listeners: Record<string, Function[]> = {}, document: any = { ids: new Map(), activeElement: null }
  document.createElement = (tag: string) => new El(tag, document)
  document.head = document.createElement('head'); document.body = document.createElement('body'); document.documentElement = document.createElement('html')
  document.querySelectorAll = () => []; document.getElementById = (id: string) => document.ids.get(id) ?? null
  document.addEventListener = (name: string, fn: Function) => { (listeners['doc:' + name] ??= []).push(fn) }
  const made: string[] = [], revoked: string[] = [], calls: string[] = [], panes: any = {}
  const hist = { pushes: 0, backs: 0 }
  const history: any = { state: null, pushState() { hist.pushes++ }, back() { hist.backs++; for (const fn of listeners.popstate ?? []) fn({}) } }
  const W: any = { esc, registerPane: (name: string, kit: any) => { panes[name] = kit }, setCrumb() {}, toDate: () => null, clock: () => '' }
  const window: any = { COSWeb: W, AbortController, addEventListener: (name: string, fn: Function) => { (listeners[name] ??= []).push(fn) }, scrollTo() {} }
  const held: Array<() => void> = []
  const fetch = async (path: string) => {
    calls.push(path)
    if (hold(path)) await new Promise<void>(r => held.push(r))
    if (fail(path)) return { status: 500, ok: false, text: async () => JSON.stringify({ error: 'boom' }) }
    const blob = new Blob(['image'], { type: 'image/png' })
    return { status: 200, ok: true, blob: async () => blob, text: async () => { throw new Error('Blob passed through JSON') } }
  }
  const ctx = vm.createContext({ window, document, console, fetch, AbortController, Blob, URL: {
    createObjectURL: () => { const url = 'blob:o-' + made.length; made.push(url); return url }, revokeObjectURL: (url: string) => revoked.push(url),
  }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, showAuth() {}, history })
  vm.runInContext(region(APP, '  function api(path, opts)', '  // ── state'), ctx)
  W.api = vm.runInContext('api', ctx)
  vm.runInContext(MEDIA, ctx)
  const deps = { window, document, esc, ensurePane: (name: string) => Promise.resolve(panes[name]) }
  const hooks = new Function('deps', 'with(deps){' + region(APP, '  // Output previews are separate', "  // Copy session (Control's Kickstart brief") + 'return {html:readerImagesHtml,mount:readerImagesMount,stop:readerImagesStop};}')(deps)
  const host = document.createElement('section'); document.body.appendChild(host)
  const mount = async (dtos: any[]) => { host.innerHTML = hooks.html({ outputImages: dtos }); hooks.mount(host, { provider: 'codex', id: SID }); await flush() }
  const key = (name: string) => {
    let stopped = false; const e = { key: name, shiftKey: false, preventDefault() {}, stopImmediatePropagation() { stopped = true } }
    for (const fn of listeners.keydown ?? []) { if (!stopped) fn(e) }
  }
  const view = () => document.body.children.find((c: El) => c.className === 'rm-view') as El | undefined
  const viewBody = () => view()!.children.find((c: El) => c.className === 'rm-view-body')!
  const label = () => view()!.children[0]!.children[0]!.textContent
  const counter = () => { const nav = view()!.children.find((c: El) => c.className === 'rm-view-nav'); return nav ? nav.children[1]! : null }
  const step = (name: string) => view()!.children.find((c: El) => c.className === 'rm-view-nav')!.children.find((c: El) => c.attrs['aria-label'] === name)!
  const thumbs = () => host.querySelectorAll('button').filter((b: El) => b.className === 'cx-thumb')
  const touch = (type: string, points: Array<[number, number]>, ended: Array<[number, number]> = []) => {
    const e = { touches: points.map(([x, y]) => ({ clientX: x, clientY: y })), changedTouches: ended.map(([x, y]) => ({ clientX: x, clientY: y })) }
    for (const fn of viewBody().listeners[type] ?? []) fn(e)
  }
  // A reader with turns: [role, images[]] in order; each assistant turn's images are its own slot, as the reader draws them.
  const mountTurns = async (turns: Array<[string, any[]]>) => {
    host.children = []
    for (const [role, imgs] of turns) {
      const t = new El('div', document); t.className = 'turn ' + role + ' sx-turn'; for (const c of t.className.split(' ')) t.classes.add(c); host.appendChild(t)
      if (imgs.length) { const slot = new El('div', document); slot.attrs['data-reader-images'] = JSON.stringify(imgs); t.appendChild(slot) }
    }
    hooks.mount(host, { provider: 'codex', id: SID }); await flush()
  }
  const back = () => { for (const fn of listeners.popstate ?? []) fn({}) }
  const release = async () => { for (const r of held.splice(0)) r(); await flush() }
  return { W, document, host, mount, mountTurns, calls, made, revoked, key, view, viewBody, label, counter, step, thumbs, touch, hist, back, release, held }
}
const IDS = ['a', 'b', 'c'].map(ch => 'ai_' + ch.repeat(64))
const THREE = IDS.map((id, i) => ({ id, label: ['First.png', 'Second.png', 'Third.png'][i], state: 'available' }))
const phone = (calls: string[]) => calls.filter(c => c.includes('variant=phone')).map(c => IDS.findIndex(id => c.includes(id)))

describe('a response\'s images open as one set (7.0.45)', () => {
  it('opens on the tapped image, with the set in the order shown and a counter named "Image 2 of 3"', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[1]!.click(); await flush()
    expect(t.W.readerMedia.isOpen()).toBe(true)
    expect(t.label()).toBe('Second.png')
    expect(t.counter()!.textContent).toBe('2 of 3')
    expect(t.counter()!.attrs['aria-label']).toBe('Image 2 of 3')
    expect(t.viewBody().children[0]!.tag).toBe('img')
    expect(phone(t.calls), 'the tapped one, then only the next preloaded').toEqual([1, 2])
  })
  it('Next, Previous and the arrow keys move through the set; the ends do not wrap and the end arrow is disabled', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    expect(t.step('Previous image').disabled).toBe(true); expect(t.step('Next image').disabled).toBe(false)
    t.step('Previous image').click(); await flush(); expect(t.counter()!.textContent).toBe('1 of 3')
    t.key('ArrowLeft'); await flush(); expect(t.counter()!.textContent, 'no wrap at the start').toBe('1 of 3')
    t.step('Next image').click(); await flush(); expect(t.label()).toBe('Second.png')
    t.key('ArrowRight'); await flush(); expect(t.label()).toBe('Third.png'); expect(t.counter()!.textContent).toBe('3 of 3')
    expect(t.step('Next image').disabled).toBe(true)
    t.key('ArrowRight'); await flush(); expect(t.counter()!.textContent, 'no wrap at the end').toBe('3 of 3')
    t.key('ArrowLeft'); await flush(); expect(t.counter()!.textContent).toBe('2 of 3')
  })
  it('an arrow that goes quiet at an end hands focus to the other arrow', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[1]!.click(); await flush()
    const next = t.step('Next image'); next.focus(); next.click(); await flush()
    expect(next.disabled).toBe(true)
    expect(t.document.activeElement).toBe(t.step('Previous image'))
  })
  it('a horizontal swipe moves; a vertical drag, a short drag and two fingers do not', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[1]!.click(); await flush()
    t.touch('touchstart', [[200, 300]]); t.touch('touchend', [], [[130, 310]]); await flush()
    expect(t.counter()!.textContent, 'swipe left: next').toBe('3 of 3')
    t.touch('touchstart', [[100, 300]]); t.touch('touchend', [], [[170, 290]]); await flush()
    expect(t.counter()!.textContent, 'swipe right: previous').toBe('2 of 3')
    t.touch('touchstart', [[200, 100]]); t.touch('touchend', [], [[150, 300]]); await flush()
    expect(t.counter()!.textContent, 'mostly vertical').toBe('2 of 3')
    t.touch('touchstart', [[200, 300]]); t.touch('touchend', [], [[175, 300]]); await flush()
    expect(t.counter()!.textContent, 'under 40 px').toBe('2 of 3')
    t.touch('touchstart', [[200, 300]]); t.touch('touchstart', [[200, 300], [260, 320]]); t.touch('touchend', [[260, 320]], [[100, 300]]); t.touch('touchend', [], [[100, 300]]); await flush()
    expect(t.counter()!.textContent, 'a pinch is never a swipe').toBe('2 of 3')
  })
  it('a tap on the dark area closes; a tap on the image does not', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    for (const fn of t.viewBody().listeners.click ?? []) fn({ target: t.viewBody().children[0] })
    expect(t.W.readerMedia.isOpen()).toBe(true)
    for (const fn of t.viewBody().listeners.click ?? []) fn({ target: t.viewBody() })
    expect(t.W.readerMedia.isOpen()).toBe(false)
  })
  it('closing lands on the thumbnail he opened, with the scroll he left, and releases every image it loaded', async () => {
    const t = load(); await t.mount(THREE)
    t.host.scrollTop = 120
    const opened = t.thumbs()[0]!; opened.focus(); opened.click(); await flush()
    t.key('ArrowRight'); await flush(); t.key('ArrowRight'); await flush()
    t.host.scrollTop = 0
    const loaded = t.made.slice(3)
    t.key('Escape')
    expect(t.W.readerMedia.isOpen()).toBe(false)
    expect(t.document.activeElement).toBe(opened)
    expect(t.host.scrollTop).toBe(120)
    for (const url of loaded) expect(t.revoked, url).toContain(url)
  })
  it('one image: no arrows, no counter, and the arrow keys do nothing', async () => {
    const t = load(); await t.mount([THREE[0]])
    t.thumbs()[0]!.click(); await flush()
    expect(t.counter()).toBeNull()
    t.key('ArrowRight'); await flush()
    expect(t.label()).toBe('First.png')
  })
  it('a failed image says so, with Retry, and he can still move on', async () => {
    const t = load(p => p.includes(IDS[1]!) && p.includes('variant=phone')); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    t.key('ArrowRight'); await flush()
    expect(t.viewBody().textContent).toContain('The image could not load.')
    expect(t.viewBody().children.some((c: El) => c.textContent === 'Retry image')).toBe(true)
    t.key('ArrowRight'); await flush()
    expect(t.label()).toBe('Third.png'); expect(t.viewBody().children[0]!.tag).toBe('img')
  })
  it('an unavailable image is in the set with its reason, and nothing is fetched for it', async () => {
    const t = load(); await t.mount([THREE[0], { id: IDS[1], label: 'Gone.png', state: 'unavailable', reason: 'missing' }, THREE[2]])
    t.thumbs()[0]!.click(); await flush()
    t.key('ArrowRight'); await flush()
    expect(t.label()).toBe('Gone.png')
    expect(t.viewBody().textContent).toContain('Not available on this Mac.')
    expect(t.calls.some(c => c.includes(IDS[1]!))).toBe(false)
    t.key('ArrowRight'); await flush()
    expect(t.label()).toBe('Third.png')
  })
  it('his real case: three images from one call, and images from two separate calls, both open as one set in the order drawn', async () => {
    const t = load()
    const img = (n: number, label: string) => ({ id: 'ai_' + String(n).repeat(64), label, state: 'available' })
    await t.mountTurns([['user', []], ['assistant', [img(1, 'One.png'), img(2, 'Two.png'), img(3, 'Three.png')]], ['user', []],
      ['assistant', [img(4, 'Four.png')]], ['assistant', []], ['assistant', [img(5, 'Five.png'), img(6, 'Six.png')]], ['user', []], ['assistant', [img(7, 'Seven.png')]]])
    const thumbs = t.thumbs()
    thumbs[1]!.click(); await flush()
    expect(t.label()).toBe('Two.png'); expect(t.counter()!.textContent, 'one call: its three').toBe('2 of 3')
    t.key('Escape')
    thumbs[3]!.click(); await flush()
    expect(t.label()).toBe('Four.png'); expect(t.counter()!.textContent, 'two calls, one response: three in the order drawn').toBe('1 of 3')
    t.key('ArrowRight'); await flush(); expect(t.label()).toBe('Five.png')
    t.key('ArrowRight'); await flush(); expect(t.label()).toBe('Six.png')
    t.key('ArrowRight'); await flush(); expect(t.label(), 'never into the next response').toBe('Six.png')
    t.key('Escape')
    thumbs[6]!.click(); await flush()
    expect(t.counter(), 'the next response alone: one image, no counter').toBeNull()
  })
  it('a step\'s looked-at images stay their own set, apart from the output images', () => {
    expect(MEDIA).toContain("var record = { items: [], kind: 'tools' };")
    expect(MEDIA).toContain("if (home && home.kind === 'output') {")
  })
  it('a touch that moved 10 px or more never closes, even when the browser sends a click on the dark area after it', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    t.touch('touchstart', [[200, 300]]); t.touch('touchend', [], [[212, 300]])
    for (const fn of t.viewBody().listeners.click ?? []) fn({ target: t.viewBody() })
    expect(t.W.readerMedia.isOpen()).toBe(true)
    t.touch('touchstart', [[200, 300]]); t.touch('touchend', [], [[204, 303]])
  })
  it('moving between images adds no history entry, and Back closes the viewer once', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    expect(t.hist.pushes).toBe(1)
    t.key('ArrowRight'); await flush(); t.key('ArrowRight'); await flush(); t.key('ArrowLeft'); await flush()
    expect(t.hist.pushes, 'moving adds nothing').toBe(1)
    t.back()
    expect(t.W.readerMedia.isOpen()).toBe(false)
    expect(t.hist.backs, 'the viewer does not go back again on its own').toBe(0)
  })
  it('an image temporarily unavailable that loads on its Retry opens and fetches like any other (Q1 20:13)', async () => {
    const t = load(); await t.mount([THREE[0], { id: IDS[1], label: 'Later.png', state: 'unavailable', reason: 'unavailable' }, THREE[2]])
    expect(t.calls.some(c => c.includes(IDS[1]!)), 'nothing fetched while unavailable').toBe(false)
    const retry = t.host.querySelectorAll('button').find((b: El) => b.textContent === 'Retry image' && !b.hidden)!
    retry.click(); await flush()
    expect(t.calls.some(c => c.includes(IDS[1]!) && c.includes('variant=thumb')), 'Retry loaded the thumbnail').toBe(true)
    t.thumbs()[0]!.click(); await flush()
    t.key('ArrowRight'); await flush()
    expect(t.label()).toBe('Later.png')
    expect(t.viewBody().textContent).not.toContain('temporarily unavailable')
    expect(t.viewBody().children[0]!.tag).toBe('img')
    expect(t.calls.some(c => c.includes(IDS[1]!) && c.includes('variant=phone')), 'the viewer fetched it').toBe(true)
  })
  // Q1 20:15, its seven survivors (qa/q1_image_swipe_165a40a9_mutants.py), one test each.
  it('Q1 S20: stepping onto an image whose preload is still in flight does not fetch it again', async () => {
    const t = load(() => false, p => p.includes(IDS[1]!) && p.includes('variant=phone')); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    expect(phone(t.calls)).toEqual([0, 1])
    t.key('ArrowRight')            // the preload of 1 is still held
    await t.release()
    expect(phone(t.calls).filter(i => i === 1).length, 'one fetch for image 2').toBe(1)
    expect(t.viewBody().children[0]!.tag).toBe('img')
  })
  it('Q1 S6: the next image stays kept, so back then forward does not fetch it again', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    t.key('ArrowRight'); await flush(); t.key('ArrowLeft'); await flush(); t.key('ArrowRight'); await flush()
    expect(phone(t.calls).filter(i => i === 1).length, 'image 2 fetched once').toBe(1)
  })
  it('Q1 S12: a preload that failed is not fetched again on every draw, only when he gets to it', async () => {
    const t = load(p => p.includes(IDS[1]!) && p.includes('variant=phone')); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()                 // preload of 2 fails (fetch 1)
    t.key('ArrowRight'); await flush()                    // shown: tried again (fetch 2)
    t.key('ArrowLeft'); await flush()                     // image 1 drawn again: 2 is not preloaded a third time
    expect(phone(t.calls).filter(i => i === 1).length).toBe(2)
  })
  it('Q1 S1: the preload waits its turn behind other images (a background request)', async () => {
    const big = ['c', 'd', 'e', 'f'].map(ch => ({ id: 'ai_' + ch.repeat(64), label: ch + '.png', state: 'available' }))
    const held = (p: string) => big.some(x => p.includes(x.id))
    const t = load(() => false, held)
    await t.mountTurns([['user', []], ['assistant', [THREE[0], THREE[1]]], ['user', []], ['assistant', big]])
    // Thumbnails: 1 and 2 load; c and d are held in both slots; e and f wait in the queue.
    t.thumbs()[0]!.click(); await flush()                 // image 1 full size waits at the front of the queue
    const before = t.calls.length
    await t.release()                                     // c, d land: image 1 and e run; image 1 lands; e is held
    expect(t.calls.slice(before).some(c => c.includes(IDS[0]!) && c.includes('variant=phone'))).toBe(true)
    const preloadAt = t.calls.findIndex(c => c.includes(IDS[1]!) && c.includes('variant=phone'))
    const fAt = t.calls.findIndex(c => c.includes(big[3]!.id))
    expect(fAt, 'the waiting thumbnail f ran').toBeGreaterThan(-1)
    expect(preloadAt === -1 || preloadAt > fAt, 'the preload went behind f, not in front of it').toBe(true)
    await t.release()
  })
  it('Q1 S8: the set follows the order drawn, not the order the slots were mounted', async () => {
    const t = load()
    const img = (n: number, label: string) => ({ id: 'ai_' + String(n).repeat(64), label, state: 'available' })
    await t.mountTurns([['user', []], ['assistant', [img(2, 'Later.png')]]])
    // A turn drawn BEFORE the existing one, mounted after it (an older page of the same response loading in).
    const turn = new El('div', t.document); turn.className = 'turn assistant sx-turn'; for (const c of turn.className.split(' ')) turn.classes.add(c)
    const slot = new El('div', t.document); slot.attrs['data-reader-images'] = JSON.stringify([img(1, 'Earlier.png')]); turn.appendChild(slot)
    turn.parent = t.host; t.host.children.splice(1, 0, turn)
    t.W.readerMedia.mount(t.host, 'codex', SID); await flush()
    const later = t.thumbs().find((b: El) => b.attrs['aria-label'] === 'Open image: Later.png')!
    later.click(); await flush()
    expect(t.label()).toBe('Later.png'); expect(t.counter()!.textContent, 'Earlier is first, as drawn').toBe('2 of 2')
  })
  it('Q1 S9: a slot no longer in the page is not in the set', async () => {
    const t = load()
    const img = (n: number, label: string) => ({ id: 'ai_' + String(n).repeat(64), label, state: 'available' })
    await t.mountTurns([['user', []], ['assistant', [img(1, 'One.png')]], ['assistant', [img(2, 'Two.png')]]])
    const two = t.host.children[2]!.children[0]!; two.isConnected = false   // the redraw replaced it; not re-mounted yet
    t.thumbs()[0]!.click(); await flush()
    expect(t.counter(), 'only One.png is left: no counter').toBeNull()
  })
  it('only the shown image and the next one are kept; moving on releases the one left behind', async () => {
    const t = load(); await t.mount(THREE)
    t.thumbs()[0]!.click(); await flush()
    expect(phone(t.calls)).toEqual([0, 1])
    t.key('ArrowRight'); await flush()
    expect(phone(t.calls), 'the preloaded second is reused; the third preloads').toEqual([0, 1, 2])
    t.key('ArrowRight'); await flush()
    expect(t.revoked.length, 'the first one, two steps back, is released').toBeGreaterThan(0)
  })
})
