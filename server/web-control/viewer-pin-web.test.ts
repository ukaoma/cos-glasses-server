/**
 * 7.0.5 (Miles's Duo, 11/08 IMG_0541 and IMG_0543): the shared viewer (panes/reader-media.js .rm-view) opened with only
 * its bottom edge on screen, because position:fixed inset 0 is the LAYOUT viewport and the browser had panned the visible
 * part. pinViewer gives the viewer the visible box (COSWeb.viewportFit) and follows it until the viewer closes.
 * The real reader-media.js runs in a vm on fake elements; viewportFit and visualViewport are fakes.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const MEDIA = readFileSync(new URL('./panes/reader-media.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }

class El {
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  className = ''; hidden = false; disabled = false; type = ''; src = ''; alt = ''; href = ''; download = ''; srcdoc = ''; words = ''
  style: Record<string, string> = {}; isConnected = true
  classList = { add() {}, remove() {}, contains: () => false }
  constructor(public tag: string, public doc: any) {}
  set textContent(v: string) { this.words = String(v); this.children = [] }
  get textContent(): string { return [this.words, ...this.children.map(c => c.textContent)].filter(Boolean).join(' ') }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  hasAttribute(k: string) { return k in this.attrs }
  appendChild(e: El) { e.parent = this; e.isConnected = true; this.children.push(e); return e }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f) }
  focus() { this.doc.activeElement = this }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]) }
  querySelectorAll(sel: string): El[] { const m = /^\[([a-z-]+)\]$/.exec(sel); return this.all().filter(c => (m ? m[1] in c.attrs : c.tag === sel)) }
}
class Target {
  on: Record<string, Function[]> = {}
  addEventListener(t: string, f: Function) { (this.on[t] ??= []).push(f) }
  removeEventListener(t: string, f: Function) { this.on[t] = (this.on[t] ?? []).filter(g => g !== f) }
  fire(t: string) { for (const f of [...(this.on[t] ?? [])]) f({}) }
  count() { return Object.values(this.on).reduce((n, l) => n + l.length, 0) }
}
function load() {
  const document: any = { activeElement: null }
  document.createElement = (tag: string) => new El(tag, document)
  document.head = document.createElement('head'); document.body = document.createElement('body'); document.documentElement = document.createElement('html')
  let box: any = { vv: true, top: 300, height: 350, inset: 319 }
  const crumbs: Array<{ what: string; extra: any }> = [], frames: Function[] = []
  const W: any = { registerPane() {}, viewportFit: () => box, layoutCrumb: (what: string, extra: any) => crumbs.push({ what, extra }),
    api: async () => new FakeBlob(['<h1>Hi</h1>'], { type: 'text/html' }) }
  class FakeBlob { size: number; type: string; parts: unknown[]
    constructor(parts: unknown[], o?: { type?: string }) { this.parts = parts; this.type = o?.type ?? ''; this.size = 11 }
    slice() { return this }
    async text() { return this.parts.join('') } }
  const vv = new Target(), win = new Target()
  const window: any = Object.assign(win, { COSWeb: W, visualViewport: vv, scrollY: 0, open: () => null,
    requestAnimationFrame: (f: Function) => { frames.push(f); return frames.length }, cancelAnimationFrame() {} })
  vm.runInContext(MEDIA, vm.createContext({ window, document, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: FakeBlob, setTimeout: () => 0, Promise, JSON, Map, Array, String, Math, Number }))
  const host: El = document.createElement('div')
  const s = document.createElement('div')
  s.setAttribute('data-reader-files', JSON.stringify([{ id: 'af_' + 'b'.repeat(64), name: 'page.html', kind: 'html', type: 'HTML page', size: 11, state: 'available' }]))
  host.appendChild(s)
  W.readerMedia.mount(host, 'claude', 's')
  const view = () => (document.body as El).all().find(e => e.className === 'rm-view')
  const runFrames = () => { while (frames.length) frames.shift()!() }
  return { host, view, vv, win, crumbs, runFrames, setBox: (b: any) => { box = b } }
}
const named = (root: El, text: string) => root.querySelectorAll('button').find(b => b.textContent === text)!

describe('the viewer takes the visible box (7.0.5, Duo off-screen viewer)', () => {
  it('opens on the visible box, not the layout viewport, and records where', async () => {
    const t = load()
    named(t.host, 'Preview').click(); await flush()
    const v = t.view()!
    expect(v.style.top).toBe('300px'); expect(v.style.height).toBe('350px'); expect(v.style.bottom).toBe('auto')
    expect(t.crumbs[0]).toMatchObject({ what: 'viewer-open', extra: { boxTop: 300, boxH: 350 } })
  })
  it('follows the box while open (a keyboard closing, a bar returning), once a frame', async () => {
    const t = load()
    named(t.host, 'Preview').click(); await flush()
    t.setBox({ vv: true, top: 0, height: 669, inset: 0 })
    t.vv.fire('scroll'); t.vv.fire('resize'); t.win.fire('resize')
    expect(t.view()!.style.top).toBe('300px') // nothing moves until the frame
    t.runFrames()
    expect(t.view()!.style.top).toBe('0px'); expect(t.view()!.style.height).toBe('669px')
    expect(t.crumbs.map(c => c.what)).toEqual(['viewer-open', 'viewer-move'])
  })
  it('a browser with no visual viewport keeps the stylesheet box (inset 0)', async () => {
    const t = load(); t.setBox({ vv: false, top: 0, height: 669 })
    named(t.host, 'Preview').click(); await flush()
    expect(t.view()!.style.top).toBe(''); expect(t.view()!.style.height).toBe('')
  })
  it('closing stops following: every listener it added is gone', async () => {
    const t = load()
    const before = t.vv.count() + t.win.count()
    named(t.host, 'Preview').click(); await flush()
    expect(t.vv.count() + t.win.count()).toBe(before + 3)
    named(t.view()!, 'Close').click()
    expect(t.view()).toBeUndefined()
    expect(t.vv.count() + t.win.count()).toBe(before)
  })
})
