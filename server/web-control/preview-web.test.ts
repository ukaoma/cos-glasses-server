/**
 * 7.0.5 preview engine phase 1, the web side: panes/preview.js (link cards and the shared viewer), the reply renderer's
 * card markers (app.js sxInline / sxMd.linksAttr) and the Settings extra-folders list (panes/settings.js). The real files
 * run in a vm on fake elements. No network: every request is answered by the test.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { partsFor } from '../routes/session-preview.js'
import { previewKind } from '../lib/session-links.js'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const PREVIEW = read('./panes/preview.js'), APP = read('./app.js'), SETTINGS = read('./panes/settings.js')
const LID = (c: string) => 'al_' + c.repeat(64)
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const region = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  if (a < 0 || b <= a) throw new Error('Production region missing: ' + from)
  return src.slice(a, b)
}

class El {
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  className = ''; id = ''; hidden = false; disabled = false; type = ''; src = ''; alt = ''; href = ''; target = ''; rel = ''; title = ''
  value = ''; min = ''; inputMode = ''; placeholder = ''; isConnected = true; words = ''; scrolled = 0; innerHTMLSet = ''
  classList = { add: (c: string) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim() },
    remove: (c: string) => { this.className = this.className.split(' ').filter(x => x !== c).join(' ') },
    contains: (c: string) => this.className.split(' ').includes(c) }
  constructor(public tag: string) {}
  set textContent(v: string) { this.words = String(v); this.children = [] }
  get textContent(): string { return [this.words, ...this.children.map(c => c.textContent)].filter(Boolean).join(' ') }
  set innerHTML(v: string) { this.innerHTMLSet = String(v); this.words = ''; this.children = [] }
  get innerHTML(): string { return this.innerHTMLSet }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  appendChild(e: El) { e.parent = this; this.children.push(e); return e }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f) }
  scrollIntoView() { this.scrolled++ }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({ target: this, preventDefault() {} }) }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]) }
  find(pred: (e: El) => boolean) { return this.all().find(pred) }
}

function load(opts: { phone?: boolean; coarse?: boolean; md?: (s: string) => string } = {}) {
  const document: any = { createElement: (t: string) => new El(t) }
  document.head = new El('head'); document.body = new El('body')
  const W: any = { registerPane() {}, isPhone: () => !!opts.phone, sessionKit: { markdown: opts.md ?? ((s: string) => '<p>' + esc(s) + '</p>') } }
  const window: any = { COSWeb: W, matchMedia: (q: string) => ({ matches: !!opts.coarse && q.includes('coarse') }) }
  vm.runInContext(PREVIEW, vm.createContext({ window, document, JSON, Math, Number, String, Array }))
  return { W, P: W.preview, document }
}
/** The viewer shell reader-media.js hands preview.js: a body, and a request that the test answers by part. */
function shell(answers: Record<string, (q: string) => unknown>) {
  const body = new El('div'), acts = new El('div'), asked: string[] = []
  const v = {
    body, acts, alive: () => true, url: () => '', setUrl() {},
    request: async (u: string, _fg: boolean, type: string) => {
      asked.push(u)
      const part = /[?&]part=([a-z-]+)/.exec(u)![1]
      const a = answers[part]
      if (!a) { const e: any = new Error('no'); e.status = 404; throw e }
      const r = a(u)
      if (r instanceof Error) throw r
      expect(type, part).toBe(part === 'text' || part === 'table' ? 'json' : 'blob')
      return r
    },
  }
  return { v, body, asked }
}
const scope = { provider: 'claude', id: 'sess/1' }
const card = (over: Record<string, unknown> = {}) => ({ id: LID('a'), name: 'PLAN.md', label: 'the plan', kind: 'markdown', type: 'Markdown', size: 2048, state: 'available', ...over })

describe('clean(): a card trusts only the fields it expects', () => {
  const { P } = load()
  it('refuses an id that is not al_ or af_, and a state that is not available or unavailable', () => {
    expect(P.clean(card({ id: 'ai_' + 'a'.repeat(64) }))).toBeNull()
    expect(P.clean(card({ id: '../etc' }))).toBeNull()
    expect(P.clean(card({ state: 'maybe' }))).toBeNull()
    expect(P.clean(card({ id: 'af_' + 'b'.repeat(64) }))).not.toBeNull()
  })
  it('an unknown kind falls back to the name; an unknown reason is "unavailable"; names and labels are capped', () => {
    expect(P.clean(card({ kind: '<script>', name: 'a.csv' })).kind).toBe('table')
    expect(P.clean(card({ state: 'unavailable', reason: 'whatever' })).reason).toBe('unavailable')
    expect(P.clean(card({ name: 'x'.repeat(500) })).name).toHaveLength(120)
    expect(P.clean(card({ line: -4 })).line).toBeNull()
    expect(P.clean(card({ line: 42.9 })).line).toBe(42)
  })
})

describe('parts(): the web asks only for parts the server says the kind has', () => {
  const { P } = load()
  for (const name of ['a.md', 'b.ts', 'c.txt', 'd.csv', 'e.tsv', 'f.html', 'g.pdf', 'h.png', 'i.gif', 'j.docx', 'k.pptx', 'l.xlsx', 'm.zip', 'n.mp4', 'o.json', 'p.svg']) {
    it(name + ' matches routes/session-preview.ts partsFor', () => {
      const { kind } = previewKind(name)
      expect(P.parts({ kind, name, state: 'available' }), name).toEqual(partsFor(kind, name))
    })
  }
  it('an unavailable card and a folder have no parts', () => {
    expect(P.parts({ kind: 'markdown', name: 'a.md', state: 'unavailable' })).toEqual([])
    expect(P.parts({ kind: 'folder', name: 'wk45', state: 'available' })).toEqual([])
  })
  it('a URL names the provider, session and id only, each encoded', () => {
    expect(P.url(scope, LID('a'), 'text', '&offset=0')).toBe('/api/preview/agent-sessions/claude/sess%2F1/' + LID('a') + '/content?part=text&offset=0')
  })
})

describe('chip(): the card where a link sits', () => {
  it('an available file is a 44 px button labelled with the link words, its type, size and line', () => {
    const { P } = load()
    let opened: any = null
    const c = P.chip(scope, card({ line: 3 }), 'the plan', (f: any) => { opened = f })
    expect(c.el.tag).toBe('button')
    expect(c.el.attrs['aria-label']).toBe('Open Markdown: PLAN.md, line 3')
    expect(c.el.textContent).toContain('the plan')
    expect(c.el.textContent).toContain('Markdown · 2 KB · line 3')
    c.el.click()
    expect(opened.id).toBe(LID('a'))
  })
  it('a secret, an outside or missing file, and a folder are words, never a button and never a retry', () => {
    const { P } = load()
    const secret = P.chip(scope, card({ name: '.env', kind: 'file', type: 'File', state: 'unavailable', reason: 'secret_file' }), '.env', () => {})
    expect(secret.el.tag).toBe('span')
    expect(secret.el.textContent).toContain('Not shown: this file may hold secrets.')
    expect(secret.el.textContent).not.toMatch(/Retry/)
    const outside = P.chip(scope, card({ state: 'unavailable', reason: 'outside_workspace' }), 'x', () => {})
    expect(outside.el.tag).toBe('span')
    expect(outside.el.textContent).toContain('Not available on this Mac')
    const folder = P.chip(scope, card({ kind: 'folder', name: 'wk45_2026', type: 'Folder' }), 'week', () => {})
    expect(folder.el.tag).toBe('span')
    expect(folder.el.textContent).toContain('Folder · Open it on your Mac')
  })
  it('a PDF card gets a thumbnail slot; nothing is fetched by making the card', () => {
    const { P } = load()
    const c = P.chip(scope, card({ name: 'r.pdf', kind: 'pdf', type: 'PDF' }), 'report', () => {})
    expect(c.thumb).toBeTruthy()
    expect(c.el.className).toContain('has-thumb')
  })
})

describe('failWords(): every refusal says what happened in words', () => {
  const { P } = load()
  const err = (status: number, code?: string) => Object.assign(new Error('x'), { status, code })
  it('secret, previews off, gone, too large, not text, offline', () => {
    expect(P.failWords(err(403, 'secret_file_denied'))).toBe('Not shown: this file may hold secrets.')
    expect(P.failWords(err(403, 'previews_off'))).toBe('Previews are off. Turn them on in Settings, Privacy.')
    expect(P.failWords(err(404))).toMatch(/no longer in the recent turns/)
    expect(P.failWords(err(413))).toMatch(/Too large/)
    expect(P.failWords(err(415))).toMatch(/not text/)
    expect(P.failWords(err(503))).toMatch(/Mac is awake/)
  })
})

describe('the viewer renderers', () => {
  it('code: numbered lines, and it jumps to the line the link named', async () => {
    const { P } = load()
    const s = shell({ text: () => ({ text: 'one\ntwo\nthree\nfour\n', offset: 0, end: 19, size: 19, more: false }) })
    P.render(s.v, scope, card({ name: 'server.ts', kind: 'code', type: 'TypeScript', line: 3 }))
    await flush()
    const rows = s.body.all().filter(e => e.className.split(' ')[0] === 'pv-line')
    expect(rows.map(r => r.attrs['data-line'])).toEqual(['1', '2', '3', '4'])
    expect(rows[2].className).toContain('hit')
    expect(rows[2].scrolled).toBe(1)
    expect(s.body.textContent).toContain('Line 3')
    expect(s.asked[0]).toContain('part=text&offset=0')
  })
  it('code: "Show more" asks for the next window from where the last one ended', async () => {
    const { P } = load()
    const s = shell({ text: (u: string) => /offset=0/.test(u) ? { text: 'a\nb', offset: 0, end: 3, size: 6, more: true } : { text: '\nc\n', offset: 3, end: 6, size: 6, more: false } })
    P.render(s.v, scope, card({ name: 'x.txt', kind: 'text', type: 'Text' }))
    await flush()
    const more = s.body.find(e => e.tag === 'button' && e.textContent === 'Show more')!
    more.click(); await flush()
    expect(s.asked[1]).toContain('offset=3')
    expect(s.body.all().filter(e => e.className === 'pv-line').map(r => r.children[1].textContent)).toEqual(['a', 'b', 'c'])
  })
  it('markdown: drawn by the reply renderer (escaped first), never as raw HTML from the file', async () => {
    const seen: string[] = []
    const { P } = load({ md: s => { seen.push(s); return '<p>' + esc(s) + '</p>' } })
    const s = shell({ text: () => ({ text: '# Plan\n<img src=x onerror=alert(1)>', offset: 0, end: 30, size: 30, more: false }) })
    P.render(s.v, scope, card())
    await flush()
    expect(seen).toEqual(['# Plan\n<img src=x onerror=alert(1)>'])
    const md = s.body.find(e => e.className.includes('pv-md'))!
    expect(md.innerHTML).toContain('&lt;img')
  })
  it('table: a header row, numbered rows, "Show 200 more rows", and the caps said in words', async () => {
    const { P } = load()
    const s = shell({ table: (u: string) => /offset=0/.test(u)
      ? { header: ['a', 'b'], rows: [['1', '2']], offset: 0, next: 1, more: true, capped: false, columnsCut: true }
      : { header: ['a', 'b'], rows: [['3', '4']], offset: 1, next: 2, more: false, capped: true, columnsCut: false } })
    P.render(s.v, scope, card({ name: 'd.csv', kind: 'table', type: 'CSV' }))
    await flush()
    expect(s.body.all().filter(e => e.tag === 'th').map(e => e.textContent)).toEqual(['#', 'a', 'b'])
    expect(s.body.textContent).toContain('Only the first 50 columns are shown')
    s.body.find(e => e.tag === 'button' && e.textContent === 'Show 200 more rows')!.click(); await flush()
    expect(s.asked[1]).toContain('part=table&offset=1')
    expect(s.body.all().filter(e => e.tag === 'td' && e.className === 'pv-rn').map(e => e.textContent)).toEqual(['1', '2'])
    expect(s.body.textContent).toContain('The preview stops at 5,000 rows')
  })
  it('html: scripts off by default (sandbox with no tokens, the html part); Run scripts is per open, never same-origin', async () => {
    const { P } = load()
    const s = shell({})
    P.render(s.v, scope, card({ name: 'r.html', kind: 'html', type: 'HTML page' }))
    const frame = () => s.body.find(e => e.tag === 'iframe')!
    expect(frame().attrs.sandbox).toBe('')
    expect(frame().src).toMatch(/part=html$/)
    expect(frame().attrs.referrerpolicy).toBe('no-referrer')
    expect(s.body.textContent).toContain('Scripts are off. Nothing on this page loads from the internet.')
    const run = s.body.find(e => e.tag === 'button' && e.textContent === 'Run scripts')!
    run.click()
    expect(frame().attrs.sandbox).toBe('allow-scripts')
    expect(frame().src).toMatch(/part=html-run$/)
    expect(run.attrs['aria-pressed']).toBe('true')
    expect(s.body.textContent).toContain('Scripts are on for this view only. They cannot fetch data or read COS.')
    expect(s.body.all().filter(e => e.tag === 'iframe')).toHaveLength(1)
    run.click()
    expect(frame().attrs.sandbox).toBe('')
    expect(PREVIEW.match(/setAttribute\('sandbox',[^)]*\)/g), 'the one place a sandbox is written, with no other token').toEqual(["setAttribute('sandbox', on ? 'allow-scripts' : '')"])
    expect(s.asked, 'the page is a frame, never fetched into this document').toEqual([])
  })
  it('pdf: inline in a frame on a desktop; a new-tab link on a phone and on any touch-first screen (the unfolded Duo)', () => {
    const desk = load(), sd = shell({})
    desk.P.render(sd.v, scope, card({ name: 'r.pdf', kind: 'pdf', type: 'PDF' }))
    expect(sd.body.find(e => e.tag === 'iframe')!.src).toMatch(/part=inline$/)
    for (const o of [{ phone: true }, { coarse: true }]) {
      const ph = load(o), sp = shell({})
      expect(ph.P.isPhone()).toBe(true)
      ph.P.render(sp.v, scope, card({ name: 'r.pdf', kind: 'pdf', type: 'PDF' }))
      expect(sp.body.find(e => e.tag === 'iframe')).toBeUndefined()
      const a = sp.body.find(e => e.tag === 'a')!
      expect(a.href).toMatch(/part=inline$/)
      expect(a.target).toBe('_blank')
      expect(a.rel).toBe('noopener')
    }
  })
  it('a refused part says why and offers nothing it cannot do', async () => {
    const { P } = load()
    const s = shell({ text: () => Object.assign(new Error('x'), { status: 403, code: 'secret_file_denied' }) })
    P.render(s.v, scope, card({ name: 'a.ts', kind: 'code', type: 'TypeScript' }))
    await flush()
    expect(s.body.textContent).toBe('Not shown: this file may hold secrets.')
  })
})

describe('the reply renderer: card markers (app.js)', () => {
  const ctx: any = vm.createContext({ JSON, String, Array, Math, Number })
  vm.runInContext('var esc = ' + esc.toString() + ';' + region(APP, '  function sxInline(s)', '  // Nested lists by indent') + ';this.md = sxMd;', ctx)
  const links = [card({ id: LID('a') }), card({ id: LID('b'), name: 'x.ts' })]
  it('a marker becomes a slot only inside a turn that has that many cards; the words are escaped', () => {
    const html = ctx.md('See [the <b>plan</b>](cos-file:0) and [x](cos-file:1) and [y](cos-file:7).', links)
    expect(html).toContain('<span class="rm-link-slot" data-reader-link="0">the &lt;b&gt;plan&lt;/b&gt;</span>')
    expect(html).toContain('<span class="rm-link-slot" data-reader-link="1">x</span>')
    expect(html).toContain(' and y.')
    expect(html).not.toContain('cos-file')
  })
  it('without cards (previews off, a file in the viewer) a marker is just its words', () => {
    expect(ctx.md('See [the plan](cos-file:0).')).toBe('<p>See the plan.</p>')
  })
  it('linksAttr carries only checked fields, and drops a bad id', () => {
    const attr: string = ctx.md.linksAttr({ outputLinks: [card({ path: '/Users/x/PLAN.md' }), { id: 'evil', state: 'available' }] })
    const json = JSON.parse(attr.replace(/^ data-reader-links="/, '').replace(/"$/, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    expect(json[0]).toMatchObject({ id: LID('a'), name: 'PLAN.md', state: 'available' })
    expect(json[0]).not.toHaveProperty('path')
    expect(json[1]).toEqual({ id: '', state: 'invalid' })
    expect(ctx.md.linksAttr({})).toBe('')
  })
})

describe('Settings, Privacy: the extra folders list (decision 2b)', () => {
  function rows(pf: unknown) {
    const src = region(SETTINGS, '  function row(name, desc, control)', '  function onMac(names)') + region(SETTINGS, '  function sessionFilesGroup(d)', '  function savePreviewFolders(')
    const c: any = vm.createContext({ esc })
    vm.runInContext(src + ';this.g = sessionFilesGroup; this.f = previewFoldersRows;', c)
    return { group: (sf: unknown) => c.g({ sf, pf }), folders: () => c.f(pf) }
  }
  it('off by default: no folders, it says sessions open only their own folder, and an Add field', () => {
    const html = rows({ folders: [], source: 'default' }).folders()
    expect(html).toContain('None. Sessions open files only from their own project folder.')
    expect(html).toContain('id="pf-add"')
    expect(html).not.toContain('data-set="pf-remove"')
  })
  it('each folder is listed by name with its own Remove; names are escaped', () => {
    const html = rows({ folders: ['~/cos-worktrees', '~/a<b>'], source: 'settings' }).folders()
    expect(html).toContain('~/cos-worktrees')
    expect(html).toContain('~/a&lt;b&gt;')
    expect(html.match(/data-set="pf-remove"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Remove ~/cos-worktrees"')
  })
  it('a damaged saved list says no extra folder counts; 20 folders hides Add', () => {
    expect(rows({ folders: [], source: 'damaged' }).folders()).toContain('Couldn’t read the saved list, so no extra folder counts.')
    expect(rows({ folders: Array.from({ length: 20 }, (_, i) => '~/f' + i), source: 'settings' }).folders()).not.toContain('id="pf-add"')
  })
  it('it sits under the session files switch, and a server without the route shows nothing for it', () => {
    expect(rows({ folders: ['~/x'], source: 'settings' }).group({ enabled: true, source: 'default' })).toContain('Extra folders')
    expect(rows(undefined).group({ enabled: true, source: 'default' })).not.toContain('Extra folders')
  })
  it('saving posts the whole list; a refusal is said in the server’s words', () => {
    const save = region(SETTINGS, '  function savePreviewFolders(next, done)', '  function categoryBody(cat)')
    expect(save).toContain("api('/api/preview-folders/settings', { method: 'POST', body: { folders: next } })")
    expect(save).toContain("say((err && err.message) || 'That folder was not saved.', true)")
  })
})

describe('the viewer is readable on its dark overlay (7.0.5 render finding)', () => {
  it('every panel names its own ink; no undefined --text; the line field is 16 px so iOS does not zoom', () => {
    expect(PREVIEW).not.toContain('var(--text')
    expect(PREVIEW).toMatch(/\.pv-scroll\{[^}]*color:var\(--ink\)/)
    expect(PREVIEW).toMatch(/\.pv-jump input\{[^}]*color:var\(--ink\)[^}]*font:16px/)
    expect(read('./panes/reader-media.js')).toMatch(/\.rm-text\{[^}]*color:var\(--ink\)/)
  })
})
