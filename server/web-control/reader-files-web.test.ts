/**
 * 6.99.35 hotfix: files a Claude session sent (SendUserFile) render in the Sessions reader and Today's session sheet.
 * The real reader-media.js and the real app.js DTO filter run in a vm on fake elements. No network.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const APP = read('./app.js'), TODAY = read('./panes/today-actions.js'), MEDIA = read('./panes/reader-media.js')
const FID = (c: string) => 'af_' + c.repeat(64)
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const region = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  if (a < 0 || b <= a) throw new Error('Production region missing: ' + from)
  return src.slice(a, b)
}

class El {
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  className = ''; id = ''; hidden = false; disabled = false; type = ''; src = ''; alt = ''; href = ''; download = ''; target = ''; rel = ''; title = ''; srcdoc = ''
  isConnected = true; words = ''; clicked = 0
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
  click() { this.clicked++; if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({ target: this }) }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]) }
  querySelectorAll(sel: string): El[] {
    const m = /^\[([a-z-]+)\]$/.exec(sel)
    return this.all().filter(c => (m ? m[1] in c.attrs : c.tag === sel))
  }
}
function load(responses: Record<string, () => any> = {}) {
  const document: any = { activeElement: null }
  document.createElement = (tag: string) => new El(tag, document)
  document.head = document.createElement('head'); document.body = document.createElement('body')
  document.documentElement = document.createElement('html')
  const calls: string[] = [], blobs: Array<{ type: string; parts: unknown[]; size: number }> = [], opened: any[] = []
  const W: any = { registerPane() {}, api: async (path: string, opts: any) => {
    calls.push(path); expect(opts.responseType).toBe('blob')
    const id = /output-files\/([^/]+)\/content/.exec(path)?.[1] ?? ''
    const r = responses[id]; if (!r) { const e: any = new Error('nope'); e.status = 404; throw e }
    return r()
  } }
  class FakeBlob { size: number; type: string; parts: unknown[]
    constructor(parts: unknown[], o?: { type?: string }) { this.parts = parts; this.type = o?.type ?? ''; this.size = parts.reduce<number>((n, p: any) => n + (typeof p === 'string' ? p.length : p.size ?? 0), 0); blobs.push(this) }
    slice() { return this }
    async text() { return this.parts.map((p: any) => typeof p === 'string' ? p : '').join('') }
  }
  const window: any = { COSWeb: W, addEventListener() {}, open: () => { const w = { closed: false, location: { href: '' }, close() { this.closed = true } }; opened.push(w); return w } }
  const URL = { createObjectURL: (b: any) => 'blob:cos/' + blobs.indexOf(b), revokeObjectURL() {} }
  vm.runInContext(MEDIA, vm.createContext({ window, document, URL, Blob: FakeBlob, setTimeout: () => 0, Promise, JSON, Map, Array, String, Math, Number }))
  const host: El = document.createElement('div')
  const slot = (files: unknown[]) => { const s = document.createElement('div'); s.setAttribute('data-reader-files', JSON.stringify(files)); host.appendChild(s); return s }
  return { W, host, slot, calls, blobs, opened, document, body: document.body as El, Blob: FakeBlob }
}
const pdf = { id: FID('a'), name: 'report.pdf', kind: 'pdf', type: 'PDF', size: 1536, state: 'available' }
const html = { id: FID('b'), name: 'page.html', kind: 'html', type: 'HTML page', size: 40, state: 'available' }
const md = { id: FID('c'), name: 'notes.md', kind: 'text', type: 'Markdown', size: 7, state: 'available' }
const docx = { id: FID('d'), name: 'plan.docx', kind: 'file', type: 'Word document', size: 3 * 1024 * 1024, state: 'available' }
const named = (root: El, text: string) => root.querySelectorAll('button').find(b => b.textContent === text)!

describe('file cards (reader-media.js)', () => {
  it('a card per file: name, type and size, and the right action; the route is the per-session output-files route', () => {
    const t = load(); t.slot([pdf, html, md, docx])
    t.W.readerMedia.mount(t.host, 'claude', 'sess/1')
    const cards = t.host.all().filter(e => e.className.split(' ')[0] === 'rm-file')
    expect(cards.map(c => c.children[1].textContent)).toEqual(['report.pdf', 'page.html', 'notes.md', 'plan.docx'])
    expect(cards.map(c => c.children[2].textContent)).toEqual(['PDF · 2 KB', 'HTML page · 40 B', 'Markdown · 7 B', 'Word document · 3.0 MB'])
    expect(cards.map(c => c.querySelectorAll('button').map(b => b.textContent))).toEqual([['Open', 'Download'], ['Preview', 'Download'], ['Open'], ['Download']])
    expect(t.calls, 'nothing is fetched until asked').toEqual([])
  })
  it('a secret file card says why it is hidden and offers no file action', () => {
    const t = load(); t.slot([{ ...pdf, state: 'unavailable', reason: 'secret_file', size: undefined }])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    expect(t.calls).toEqual([])
    expect(t.host.textContent).toContain('Not shown: this file may hold secrets.')
    expect(t.host.querySelectorAll('button')).toHaveLength(0)
  })
  it('missing or outside the workspace: "Not available on this Mac", no button, no request', () => {
    const t = load()
    t.slot([{ ...pdf, state: 'unavailable', reason: 'missing', size: undefined }, { ...html, state: 'unavailable', reason: 'outside_workspace' }])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    expect(t.host.textContent).toContain('PDF · Not available on this Mac')
    expect(t.host.textContent).toContain('HTML page · Not available on this Mac')
    expect(t.host.querySelectorAll('button')).toEqual([])
  })
  // QA 7.0.0 (Codex root-user W3): a passing lookup failure said "Retry in a moment" on a card with no Retry, and a
  // mounted card is never re-read. It says the step that works instead, and still asks for nothing.
  it('unavailable for now: no Retry promised without a Retry button; it says to reopen the session', () => {
    const t = load()
    t.slot([{ ...pdf, state: 'unavailable', reason: 'unavailable' }])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    expect(t.host.textContent).toContain('PDF · Not available right now. Reopen the session to check again.')
    expect(t.host.textContent).not.toMatch(/retry/i)
    expect(t.host.querySelectorAll('button')).toEqual([])
    expect(t.calls).toEqual([])
  })
  it('junk DTOs never become cards', () => {
    const t = load(); t.slot([{ ...pdf, id: 'ai_' + 'a'.repeat(64) }, { ...pdf, id: '../x' }, { ...pdf, state: 'ok' }, null])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    expect(t.host.querySelectorAll('button')).toEqual([])
  })
  it('PDF: the tab opens on the tap, then shows the bytes retyped as application/pdf', async () => {
    const t = load({ [pdf.id]: () => new t.Blob(['%PDF'], { type: 'text/html' }) }); t.slot([pdf])
    t.W.readerMedia.mount(t.host, 'claude', 'sess/1')
    named(t.host, 'Open').click()
    expect(t.opened).toHaveLength(1)
    await flush()
    expect(t.calls).toEqual(['/api/agent-sessions/claude/sess%2F1/output-files/' + pdf.id + '/content'])
    const shown = t.blobs[Number(t.opened[0].location.href.split('/').pop())]
    expect(shown.type).toBe('application/pdf')
  })
  it('HTML preview: a sandboxed frame with no allow tokens, from srcdoc; never a blob URL of this origin', async () => {
    const t = load({ [html.id]: () => new t.Blob(['<script>x()</script><h1>Hi</h1>'], { type: 'text/html' }) }); t.slot([html])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    named(t.host, 'Preview').click(); await flush()
    const frame = t.body.all().find(e => e.tag === 'iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).toBe('<script>x()</script><h1>Hi</h1>')
    expect(frame.src).toBe('')
    expect(t.blobs.filter(b => /html/.test(b.type)).length, 'only the fetched blob itself is HTML-typed').toBe(1)
  })
  it('Download is always typed application/octet-stream and named after the file', async () => {
    const t = load({ [html.id]: () => new t.Blob(['<h1>x</h1>'], { type: 'text/html' }), [docx.id]: () => new t.Blob(['PK'], { type: '' }) }); t.slot([html, docx])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    t.host.querySelectorAll('button').filter(b => b.textContent === 'Download').forEach(b => b.click()); await flush()
    const anchors = t.body.all().filter(e => e.tag === 'a')
    expect(anchors, 'the anchors are removed after the click').toEqual([])
    const saved = t.blobs.filter(b => b.type === 'application/octet-stream')
    expect(saved).toHaveLength(2)
  })
  it('text opens as words in a pre, never as markup', async () => {
    const t = load({ [md.id]: () => new t.Blob(['# Notes <img src=x onerror=y>'], { type: 'text/plain' }) }); t.slot([md])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    named(t.host, 'Open').click(); await flush()
    const pre = t.body.all().find(e => e.tag === 'pre')!
    expect(pre.textContent).toBe('# Notes <img src=x onerror=y>')
    expect(pre.children).toEqual([])
  })
  it('previews turned off in Settings while the page was open: the card says so', async () => {
    const t = load({ [docx.id]: () => { const e: any = new Error('off'); e.status = 403; throw e } }); t.slot([docx])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    named(t.host, 'Download').click(); await flush()
    expect(t.host.textContent).toContain('Previews are off. Turn them on in Settings, Privacy.')
  })
  it('a failed open says why in words; a 413 says it is too large', async () => {
    const t = load({ [docx.id]: () => { const e: any = new Error('big'); e.status = 413; throw e } }); t.slot([docx])
    t.W.readerMedia.mount(t.host, 'claude', 's')
    named(t.host, 'Download').click(); await flush()
    expect(t.host.textContent).toContain('Too large to open here.')
  })
})

describe('the reader and Today hand file DTOs to the viewer', () => {
  const ctx: any = vm.createContext({ JSON, String, Array })
  vm.runInContext('var esc = ' + esc.toString() + ';' + region(APP, '  function readerImagesHtml(turn)', '  function readerImagesStop(host)') + ';this.html = readerImagesHtml;', ctx)
  it('only well-formed file DTOs pass, with no field beyond the contract', () => {
    const out = ctx.html({ outputFiles: [{ ...pdf, path: '/Users/x/secret.pdf' }, { ...pdf, id: 'bad' }, { ...md, kind: 'evil' }] })
    const m = /data-reader-files="([^"]*)"/.exec(out)!
    const dto = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    expect(dto).toEqual([
      { id: pdf.id, name: 'report.pdf', kind: 'pdf', type: 'PDF', size: 1536, state: 'available' },
      { id: md.id, name: 'notes.md', kind: 'file', type: 'Markdown', size: 7, state: 'available' },
    ])
    expect(out).not.toContain('secret')
    expect(ctx.html({ outputFiles: [] })).toBe('')
  })
  it('a turn with only files still mounts the viewer; Today keeps the files of its last reply', () => {
    // 11/08: tool-result image slots mount the viewer too.
    expect(APP).toContain("if (!host.querySelectorAll('[data-reader-images]').length && !host.querySelectorAll('[data-reader-files]').length && !host.querySelectorAll('[data-reader-tools]').length) { readerImagesStop(host); return; }")
    expect(TODAY).toContain('outputImages: lastA.outputImages, outputFiles: lastA.outputFiles,')
  })
})
