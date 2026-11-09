/**
 * Prep on every Next up row (Miles typed 2026-11-09 13:00 CST): "inline options to prep for a given meeting which starts
 * the gotCOS ask and gives us the ability to add in more context for the prep."
 *
 * Runs the REAL app.js block (renderNext, loadCalendarLater, paintCalendarLater, the inline panel and startNextPrep)
 * against a small fake DOM, and the REAL panes/cos-chat.js prepStart in a vm with a fake fetch for the /api/prep routes
 * and a fake XMLHttpRequest for the media upload, so the requests the server would get are the ones checked. Nothing
 * reaches a Mac or a model.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)

// ── a small DOM: an element whose innerHTML may hold the panel's box; each write makes a NEW box (a real re-render) ──
class Box {
  value = ''; selectionStart = 0; selectionEnd = 0; style = {}
  constructor(private doc: { activeElement: unknown }) {}
  hasAttribute(a: string) { return a === 'data-next-prep-steer' }
  focus() { this.doc.activeElement = this }
  setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b }
}
class El {
  hidden = true; writes = 0; box: Box | null = null; cosPrepHtml?: string; hiddenAtWrite = true; private html = ''
  constructor(private doc: { activeElement: unknown }) {}
  classList = { add: (c: string) => { if (c === 'hidden') this.hidden = true }, remove: (c: string) => { if (c === 'hidden') this.hidden = false },
    toggle: (c: string, on: boolean) => { if (c === 'hidden') this.hidden = on } }
  get innerHTML() { return this.html }
  set innerHTML(v: string) { this.html = v; this.writes++; this.hiddenAtWrite = this.hidden; this.box = v.includes('data-next-prep-steer') ? new Box(this.doc) : null }
  querySelector(sel: string) { return sel === '[data-next-prep-steer]' ? this.box : null }
  contains(x: unknown) { return !!x && x === this.box }
}

const NEXT = { title: 'Weatherford - CatchUp', time: '2026-11-09T19:00:00Z' }
const row = (title: string, start: string, extra: Record<string, unknown> = {}) => ({ title, start, end: null, allDay: false, calendar: 'Work', meetingUrl: null, hold: false, ...extra })
const LATER = [row('Weatherford - CatchUp', NEXT.time), row('Pipeline review', '2026-11-09T20:00:00Z'), row('Blocked', '2026-11-09T20:30:00Z', { hold: true }),
  row('1:1 Gina', '2026-11-09T21:00:00Z'), row('Jewel360 board', '2026-11-09T22:00:00Z'), row('Standup', '2026-11-09T23:00:00Z')]

type Mode = 'prep' | 'ask' | 'none'
function today(opts: { mode?: Mode; known?: boolean; offline?: boolean; calendar?: unknown; next?: unknown } = {}) {
  const start = APP.indexOf('  function renderNext(w) {'), end = APP.indexOf('  function prepNext() {')
  expect(start, 'renderNext').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const doc: { activeElement: unknown; querySelector: (s: string) => unknown } = { activeElement: null, querySelector: () => null }
  const els: Record<string, El> = {}
  const $ = (id: string) => (els[id] ??= new El(doc))
  doc.querySelector = (sel: string) => (sel === '[data-next-prep-form] [data-next-prep-steer]' ? Object.values(els).map(e => e.box).find(Boolean) ?? null : null)
  const mode = opts.mode ?? 'prep'
  const started: Array<{ title: string; at: string; extra: { steer: string; files: unknown[] } }> = []
  let answer: Promise<string> = Promise.resolve(mode === 'ask' ? 'ask' : 'prep')
  let caps = opts.known !== false
  const cosChat = {
    known: () => caps, ensureCaps: () => { caps = true; return Promise.resolve({}) },
    prepCaps: () => (mode === 'prep' ? { maxFiles: 10, steerChars: 4000 } : null), askOn: () => mode !== 'none', prepAccept: 'application/pdf,.pdf',
    classify: (f: { type?: string }) => (/^video\//.test(f.type || '') ? { kind: 'video' } : { kind: 'file' }),
    prepFor: () => Promise.resolve('prep'),
    prepStart: (title: string, at: string, extra: { steer: string; files: unknown[] }) => { started.push({ title, at, extra }); return answer },
  }
  let calendar: unknown = opts.calendar ?? { connected: true, stale: false, asOf: null, remainingCount: 6, next: LATER }
  const went: unknown[] = [], toasts: string[] = []
  const TODAY: any = { gen: 1, offline: !!opts.offline, welcome: { nextEvent: opts.next ?? NEXT } }
  const deps: Record<string, unknown> = {
    $, esc, TODAY, document: doc, window: { COSWeb: { cosChat } },
    toDate: (v: unknown) => (v ? new Date(String(v)) : null),
    clock: (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`, dayWord: () => 'today',
    api: () => Promise.resolve(calendar), autoGrow: () => {}, go: (p: string, a: unknown) => went.push([p, a]), toast: (t: string) => toasts.push(t),
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) +
    '\nreturn { renderNext: renderNext, loadCalendarLater: loadCalendarLater, toggleNextPrep: toggleNextPrep, closeNextPrep: closeNextPrep, nextPrepInput: nextPrepInput,' +
    ' addNextPrepFiles: addNextPrepFiles, startNextPrep: startNextPrep, NEXT_PREP: NEXT_PREP };\n}')(deps)
  // One Today paint, as loadToday does it: renderNext, then the rest of today.
  const paint = async () => {
    fns.renderNext(TODAY.welcome)
    const n = TODAY.welcome.nextEvent
    fns.loadCalendarLater(n, n && new Date(n.time))
    await flush()
  }
  const later = () => els['next-later']!
  const prepKeys = () => [...later().innerHTML.matchAll(/data-next-prep="([^"]+)"/g)].map(m => m[1]!.replace(/&amp;/g, '&'))
  const panels = () => Object.values(els).reduce((n, e) => n + (e.innerHTML.match(/data-next-prep-form/g) || []).length, 0)
  return { els, $, doc, fns, paint, later, prepKeys, panels, started, went, toasts, TODAY,
    setCalendar: (c: unknown) => { calendar = c }, setAnswer: (p: Promise<string>) => { answer = p } }
}
const keyOf = (title: string, iso: string) => title + '|' + new Date(iso).toISOString()

describe('Prep on every Next up row (app.js)', () => {
  it('the markup has the first row’s panel slot under its buttons, hidden until opened', () => {
    expect(HTML).toContain('<div id="next-actions" class="next-actions"></div>\n            <div id="next-first-prep" class="next-first-prep hidden"></div>')
  })

  it('rows 2 to 5 each get a quiet Prep; the first row keeps Prep me and Open meeting and gains Add context', async () => {
    const t = today()
    await t.paint()
    // Four later rows (the event above is not repeated), one of them the Blocked hold.
    expect(t.later().innerHTML.match(/class="later-row"/g)).toHaveLength(4)
    expect(t.prepKeys()).toEqual([keyOf('Pipeline review', '2026-11-09T20:00:00Z'), keyOf('1:1 Gina', '2026-11-09T21:00:00Z'), keyOf('Jewel360 board', '2026-11-09T22:00:00Z')])
    expect(t.later().innerHTML).toContain('class="link-btn later-prep"')
    expect(t.later().innerHTML).toMatch(/>Prep<\/button><\/div>/)
    const acts = t.$('next-actions').innerHTML
    expect(acts).toContain('data-today-next="prep">Prep me</button>')
    expect(acts).toContain(`data-next-prep="${esc(keyOf(NEXT.title, NEXT.time))}" aria-expanded="false">Add context</button>`)
    expect(acts).toContain('data-goto="meetings">Open meeting</button>')
    // The same row count and "+N more today" as round 2: 6 left today, 5 on screen.
    expect(t.later().innerHTML).toContain('+1 more today')
  })

  it('no Prep on a "Blocked" hold, and no Add context when the event above is a hold (Prep me stays as it was)', async () => {
    const t = today({ next: { title: 'Busy', time: NEXT.time, hold: true } })
    await t.paint()
    const blocked = t.later().innerHTML.split('class="later-row"').find(r => r.includes('>Blocked<'))!
    expect(blocked).toBeTruthy()
    expect(blocked).not.toContain('data-next-prep')
    expect(t.$('next-actions').innerHTML).not.toContain('Add context')
    expect(t.$('next-actions').innerHTML).toContain('Prep me')
  })

  it('the panel opens under the tapped row; only one is open at a time, across the first row and the later rows', async () => {
    const t = today()
    await t.paint()
    const [pipeline, gina] = t.prepKeys()
    t.fns.toggleNextPrep(pipeline)
    expect(t.panels()).toBe(1)
    const html = t.later().innerHTML
    // Directly under its own row, before the next row.
    expect(html.indexOf('data-next-prep-form')).toBeGreaterThan(html.indexOf('>Pipeline review<'))
    expect(html.indexOf('data-next-prep-form')).toBeLessThan(html.indexOf('>1:1 Gina<'))
    expect(html).toContain('placeholder="Add context for this prep (goals, people, what you want out of it)"')
    expect(html).toContain('<span>Add files</span>')
    expect(html).toContain('>Start prep</button>')
    expect(html).toContain('data-next-prep-cancel>Cancel</button>')
    expect(html).toContain(`data-next-prep="${esc(pipeline)}" aria-expanded="true">Prep</button>`)
    // The box has focus, and the block was shown before it was written (autoGrow measures it).
    expect(t.doc.activeElement).toBe(t.later().box)
    expect(t.later().hiddenAtWrite).toBe(false)
    t.fns.toggleNextPrep(gina)
    expect(t.panels()).toBe(1)
    expect(t.later().innerHTML.indexOf('data-next-prep-form')).toBeGreaterThan(t.later().innerHTML.indexOf('>1:1 Gina<'))
    // Add context on the first row: its panel sits in its own slot, and the later row's closes.
    t.fns.toggleNextPrep(keyOf(NEXT.title, NEXT.time))
    expect(t.panels()).toBe(1)
    expect(t.$('next-first-prep').innerHTML).toContain('data-next-prep-form')
    expect(t.$('next-first-prep').hidden).toBe(false)
    // Shown BEFORE the panel is written, so autoGrow measures a laid-out box (the 382 px render clipped the words).
    expect(t.$('next-first-prep').hiddenAtWrite).toBe(false)
    expect(t.later().innerHTML).not.toContain('data-next-prep-form')
    // Tapping the open one again closes it.
    t.fns.toggleNextPrep(keyOf(NEXT.title, NEXT.time))
    expect(t.panels()).toBe(0)
    expect(t.$('next-first-prep').hidden).toBe(true)
  })

  it('Escape closes the panel and keeps the words; Cancel closes it and drops them', async () => {
    const t = today()
    await t.paint()
    const k = t.prepKeys()[0]!
    t.fns.toggleNextPrep(k)
    t.later().box!.value = 'Ask about the Q4 budget'; t.fns.nextPrepInput(t.later().box)
    expect(t.fns.closeNextPrep(false)).toBe(true)
    expect(t.panels()).toBe(0)
    t.fns.toggleNextPrep(k)
    expect(t.later().box!.value).toBe('Ask about the Q4 budget')
    t.fns.closeNextPrep(true)
    t.fns.toggleNextPrep(k)
    expect(t.later().box!.value).toBe('')
    // Nothing open: Escape is not taken.
    t.fns.closeNextPrep(true)
    expect(t.fns.closeNextPrep(false)).toBe(false)
    // The page's keydown sends Escape here, after the Ask sheet and the menu.
    expect(APP).toContain("if (e.key === 'Escape' && NEXT_PREP.open && closeNextPrep(false)) { e.preventDefault(); return; }")
  })

  it('the typed context survives the page’s poll: an unchanged read writes nothing, a changed one puts back the words, focus and caret', async () => {
    const t = today()
    await t.paint()
    const k = t.prepKeys()[1]!
    t.fns.toggleNextPrep(k)
    const box = t.later().box!
    box.value = 'Goals: agree the Jewel360 renewal'; t.fns.nextPrepInput(box)
    box.focus(); box.selectionStart = 6; box.selectionEnd = 6
    const writes = t.later().writes
    // The same calendar again (Today polls): nothing is written, the box is the same box.
    await t.paint()
    expect(t.later().writes).toBe(writes)
    expect(t.later().box).toBe(box)
    // The calendar changed (a row moved): written again, with the words, the focus and the caret back.
    t.setCalendar({ connected: true, stale: false, asOf: null, remainingCount: 7, next: [...LATER, row('Late call', '2026-11-10T00:00:00Z')] })
    await t.paint()
    expect(t.later().writes).toBe(writes + 1)
    const again = t.later().box!
    expect(again).not.toBe(box)
    expect(again.value).toBe('Goals: agree the Jewel360 renewal')
    expect(t.doc.activeElement).toBe(again)
    expect([again.selectionStart, again.selectionEnd]).toEqual([6, 6])
    // The calendar stops answering, then answers again with the same rows: the rows and the open panel come back,
    // written into a shown block, with the words.
    t.setCalendar({ connected: false, next: [] })
    await t.paint()
    expect(t.later().hidden).toBe(true)
    expect(t.later().innerHTML).toBe('')
    t.setCalendar({ connected: true, stale: false, asOf: null, remainingCount: 7, next: [...LATER, row('Late call', '2026-11-10T00:00:00Z')] })
    await t.paint()
    expect(t.later().hidden).toBe(false)
    expect(t.later().hiddenAtWrite).toBe(false)
    expect(t.later().innerHTML).toContain('>1:1 Gina<')
    expect(t.later().box!.value).toBe('Goals: agree the Jewel360 renewal')
    // The first row's panel survives renderNext the same way.
    t.fns.toggleNextPrep(keyOf(NEXT.title, NEXT.time))
    const first = t.$('next-first-prep')
    first.box!.value = 'People: Luke and Silas'; t.fns.nextPrepInput(first.box)
    t.TODAY.welcome = { nextEvent: { ...NEXT } }
    await t.paint()
    expect(first.box!.value).toBe('People: Luke and Silas')
  })

  it('Start prep goes to Messages, then COS, and starts that meeting’s Prep with its title, start, the context and the files', async () => {
    const t = today()
    await t.paint()
    const k = t.prepKeys()[0]!
    t.fns.toggleNextPrep(k)
    t.later().box!.value = '  Goals: close the pricing question. People: Luke.  '; t.fns.nextPrepInput(t.later().box)
    const pdf = { name: 'Q4 pricing.pdf', type: 'application/pdf', size: 10 }
    t.fns.addNextPrepFiles([pdf, { name: 'clip.mov', type: 'video/quicktime', size: 10 }])
    expect(t.later().innerHTML).toContain('<span class="next-prep-file">Q4 pricing.pdf</span>')
    expect(t.toasts[0]).toMatch(/clip\.mov is a video/)
    t.fns.startNextPrep()
    expect(t.went).toEqual([['messages', ['cos']]])
    expect(t.started).toEqual([{ title: 'Pipeline review', at: '2026-11-09T20:00:00.000Z', extra: { steer: 'Goals: close the pricing question. People: Luke.', files: [pdf] } }])
    expect(t.panels()).toBe(0)
    await flush()
    // On its way: the words and files are dropped; the row opens empty next time.
    t.fns.toggleNextPrep(k)
    expect(t.later().box!.value).toBe('')
    expect(t.later().innerHTML).not.toContain('Q4 pricing.pdf')
  })

  it('a Start prep that fails keeps the words and says so', async () => {
    const t = today()
    await t.paint()
    const k = t.prepKeys()[0]!
    t.fns.toggleNextPrep(k)
    t.later().box!.value = 'Keep me'; t.fns.nextPrepInput(t.later().box)
    t.setAnswer(Promise.reject(new Error('Prep did not start. Your context is still under the meeting on Today.')))
    t.fns.startNextPrep()
    await flush()
    expect(t.toasts).toEqual(['Prep did not start. Your context is still under the meeting on Today.'])
    t.fns.toggleNextPrep(k)
    expect(t.later().box!.value).toBe('Keep me')
  })

  it('Prep off but Ask on: the same Prep on each row, no Add files, and Start prep sends the context with no files', async () => {
    const t = today({ mode: 'ask' })
    await t.paint()
    expect(t.prepKeys()).toHaveLength(3)
    const k = t.prepKeys()[2]!
    t.fns.toggleNextPrep(k)
    expect(t.later().innerHTML).not.toContain('Add files')
    expect(t.later().innerHTML).toContain('maxlength="2000"')
    t.later().box!.value = 'What does the board want?'; t.fns.nextPrepInput(t.later().box)
    t.fns.startNextPrep()
    expect(t.started).toEqual([{ title: 'Jewel360 board', at: '2026-11-09T22:00:00.000Z', extra: { steer: 'What does the board want?', files: [] } }])
  })

  it('neither Prep nor Ask on the Mac, or the Mac not answering: no Prep on any row and no Add context', async () => {
    for (const opts of [{ mode: 'none' as Mode }, { offline: true }]) {
      const t = today(opts)
      await t.paint()
      expect(t.later().innerHTML).toContain('Pipeline review')
      expect(t.later().innerHTML).not.toContain('data-next-prep')
      expect(t.$('next-actions').innerHTML).not.toContain('Add context')
    }
  })

  it('before the chat has read the Mac’s capabilities nothing is offered; once it has, the rows paint again with Prep', async () => {
    const t = today({ known: false })
    // The first paint, before the chat's health read answers: no Add context.
    t.fns.renderNext(t.TODAY.welcome)
    expect(t.$('next-actions').innerHTML).toContain('Prep me')
    expect(t.$('next-actions').innerHTML).not.toContain('Add context')
    // It answers: Next up paints again by itself, now with Add context; the rows read next have Prep.
    await flush()
    expect(t.$('next-actions').innerHTML).toContain('Add context')
    await t.paint()
    expect(t.prepKeys()).toHaveLength(3)
  })

  it('the page wires the panel: taps, Start prep on submit, Return through returnSends, typing, files', () => {
    expect(APP).toContain("var t = e.target.closest('[data-today-next],[data-next-prep],[data-next-prep-cancel],[data-next-prep-remove],")
    expect(APP).toContain("if (t.hasAttribute('data-next-prep')) return toggleNextPrep(t.getAttribute('data-next-prep'));")
    expect(APP).toContain("if (t.hasAttribute('data-next-prep-cancel')) return closeNextPrep(true);")
    expect(APP).toContain("else if (f.hasAttribute && f.hasAttribute('data-next-prep-form')) startNextPrep();")
    expect(APP).toContain("if (e.target.hasAttribute && e.target.hasAttribute('data-next-prep-steer')) nextPrepInput(e.target);")
    expect(APP).toContain("if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-next-prep-file')) { addNextPrepFiles(e.target.files); e.target.value = ''; }")
  })

  it('copy: no em dashes in what the panel says', async () => {
    const t = today()
    await t.paint()
    t.fns.toggleNextPrep(t.prepKeys()[0])
    expect(t.later().innerHTML + t.$('next-actions').innerHTML).not.toMatch(/—|–/)
  })
})

// ── panes/cos-chat.js prepStart ──────────────────────────
const DRAFT_ID = 'prep_' + 'D'.repeat(26)
const PREP_CAPS = { protocol: 1, maxFiles: 10, steerChars: 4000, bind: true, suggest: true, serverInstanceId: 'inst-A' }
class FakeXHR {
  static all: FakeXHR[] = []
  method = ''; path = ''; headers: Record<string, string> = {}; body: unknown = null; status = 0; responseText = ''
  upload: { onprogress?: (e: unknown) => void } = {}
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, path: string) { this.method = method; this.path = path }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body }
  abort() { this.onabort?.() }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}
const pdfFile = (name = 'Q4 pricing.pdf', text = 'Q4 price list.') => {
  const bytes = new TextEncoder().encode(text)
  return { name, size: bytes.length, type: 'application/pdf', lastModified: 0, arrayBuffer: async () => bytes.buffer.slice(0) }
}
function chat(opts: { prep?: boolean; jobs?: boolean; steer?: string; filesStatus?: number } = {}) {
  FakeXHR.all = []
  const calls: Array<{ method: string; path: string; body: any }> = []
  const posts: Array<{ path: string; body: any }> = []
  const draft: any = { id: DRAFT_ID, clientDraftId: '', revision: 1, title: '', startsAt: null, steer: opts.steer ?? '', files: [], runs: [], bindings: [], conversation: { sessionId: null }, state: 'active' }
  const answer = (status: number, body: unknown) => Promise.resolve({ status, text: async () => JSON.stringify(body) })
  const fetch = (path: string, o: { method?: string; body?: string } = {}) => {
    const method = o.method ?? 'GET', body = o.body ? JSON.parse(o.body) : undefined, p = new URL(path, 'http://x').pathname
    calls.push({ method, path: p, body })
    if (p === '/api/prep/drafts') { Object.assign(draft, { clientDraftId: body.clientDraftId, title: body.title, startsAt: body.startsAt ?? null }); return answer(201, { draft }) }
    if (p === `/api/prep/drafts/${DRAFT_ID}` && method === 'GET') return answer(200, { draft })
    if (p === `/api/prep/drafts/${DRAFT_ID}` && method === 'PATCH') { draft.steer = body.steer; draft.revision++; return answer(200, { draft }) }
    if (p.endsWith('/files')) {
      if (opts.filesStatus) return answer(opts.filesStatus, { error: 'prep_file_limit' })
      for (const m of body.media) draft.files.push({ id: 'pf_' + m.id.slice(-8), name: m.name, status: 'ready', bytes: 10 })
      draft.revision++; return answer(200, { draft })
    }
    if (p.endsWith('/run')) {
      const run = { clientRequestId: body.clientRequestId, clientJobId: 'cj-run', jobId: 'job_1' }
      return answer(202, { job: { jobId: 'job_1', clientJobId: 'cj-run', status: 'queued' }, run, draft })
    }
    return answer(404, { error: 'not_found' })
  }
  const store = new Map<string, unknown>()
  const W: Record<string, unknown> = {
    $: () => null, esc, toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => (s ? new Date(s) : null), clock: (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    readStore: (k: string) => JSON.parse(JSON.stringify(store.get(k) ?? {})), writeStore: (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))) },
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {},
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      if (o?.method === 'POST') posts.push({ path, body: o.body })
      if (path === '/api/health') return Promise.resolve({ status: 'ok', capabilities: { durableQueryJobs: opts.jobs !== false, ...(opts.prep ? { prep: PREP_CAPS } : {}) } })
      if (path === '/api/query-jobs') return Promise.resolve({ job: { jobId: 'j1', status: 'queued' } })
      return Promise.resolve({})
    },
  }
  const document = { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, activeElement: null, hidden: false,
    body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const window = { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} }, navigator: { userAgent: 'Chrome' } }
  const ctx = vm.createContext({ window, document, navigator: window.navigator, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Math, Promise,
    localStorage: window.localStorage, crypto: globalThis.crypto, fetch, XMLHttpRequest: FakeXHR, AbortController, URL, isFinite, encodeURIComponent })
  vm.runInContext(CHAT, ctx)
  return { api: W.cosChat as any, calls, posts, draft }
}
const STARTS = '2026-11-09T20:00:00.000Z'

describe('prepStart (panes/cos-chat.js)', () => {
  it('Prep on: opens that meeting’s draft, the context becomes its notes, the file goes up the composer’s path, then Prep me runs', async () => {
    const h = chat({ prep: true })
    const how = h.api.prepStart('Pipeline review', STARTS, { steer: 'Goals: close pricing.', files: [pdfFile()] })
    await flush()
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/prep/drafts', body: { title: 'Pipeline review', startsAt: STARTS } })
    // Not run while the file is uploading.
    expect(h.calls.some(c => c.path.endsWith('/run'))).toBe(false)
    expect(FakeXHR.all.at(-1)!.path).toBe('/api/media/file')
    FakeXHR.all.at(-1)!.respond(200, { attachment: { id: 'm_' + 'a'.repeat(24) } })
    await flush(16)
    expect(await how).toBe('prep')
    expect(h.calls.map(c => c.method + ' ' + c.path.replace(DRAFT_ID, 'D'))).toEqual(['POST /api/prep/drafts', 'POST /api/prep/drafts/D/files', 'PATCH /api/prep/drafts/D', 'POST /api/prep/drafts/D/run'])
    expect(h.calls.find(c => c.path.endsWith('/files'))!.body.media[0].name).toBe('Q4 pricing.pdf')
    expect(h.calls.find(c => c.method === 'PATCH')!.body.steer).toBe('Goals: close pricing.')
    expect(h.calls.find(c => c.path.endsWith('/run'))!.body.revision).toBe(3)
    // The running prep is an Ask in the chat; the composer closed.
    expect(h.api._state.asks).toHaveLength(1)
    expect(h.api._prep()).toBe(null)
  })

  it('the same meeting as Next up’s Prep me: one draft key, and notes already there are kept with the new context after them', async () => {
    const h = chat({ prep: true, steer: 'Old notes from the Mac' })
    expect(await h.api.prepStart('Pipeline review', STARTS, { steer: 'New context', files: [] })).toBe('prep')
    await flush(16)
    expect(h.calls.find(c => c.method === 'PATCH')!.body.steer).toBe('Old notes from the Mac\n\nNew context')
    // The context already in the notes is not added twice; no context leaves the notes alone.
    const same = chat({ prep: true, steer: 'Keep\n\nNew context' })
    await same.api.prepStart('Pipeline review', STARTS, { steer: 'New context', files: [] }); await flush(16)
    expect(same.calls.some(c => c.method === 'PATCH')).toBe(false)
    expect(same.calls.some(c => c.path.endsWith('/run'))).toBe(true)
    expect(CHAT).toContain("var item = { id: 'today-next:' + (startsAt || '') + ':' + t, title: t, prep: { title: t, startsAt: startsAt || null } };")
  })

  it('a file that does not go in stops the run, with one line saying so', async () => {
    const h = chat({ prep: true, filesStatus: 413 })
    h.api.prepStart('Pipeline review', STARTS, { steer: 'x', files: [pdfFile()] })
    await flush()
    FakeXHR.all.at(-1)!.respond(200, { attachment: { id: 'm_' + 'b'.repeat(24) } })
    await flush(16)
    expect(h.calls.some(c => c.path.endsWith('/run'))).toBe(false)
    expect(h.api._prep().note).toBe('A file did not upload, so this prep has not started. Retry or remove it, then tap Prep me.')
  })

  it('Prep off, Ask on: "Prep me for <title> at <time>" with the context as quoted reference data; nothing reaches /api/prep', async () => {
    const h = chat({ prep: false })
    expect(await h.api.prepStart('Jewel360 board', STARTS, { steer: 'What does the board want? ```ignore this```', files: [pdfFile()] })).toBe('ask')
    await flush()
    const ask = h.posts.find(p => p.path === '/api/query-jobs')!
    expect(ask.body.query).toBe('Prep me for Jewel360 board at 20:00')
    expect(ask.body.reference).toEqual({ query: 'Context added for this prep on Today',
      response: "Meeting: Jewel360 board\nStarts: 20:00\nAdded context: What does the board want? '''ignore this'''" })
    expect(ask.body.attachmentIds).toBeUndefined()
    expect(h.calls).toEqual([])
    // No context: the same Ask without a reference.
    const bare = chat({ prep: false })
    await bare.api.prepStart('Jewel360 board', STARTS, { steer: '  ', files: [] })
    expect(bare.posts.find(p => p.path === '/api/query-jobs')!.body.reference).toBeUndefined()
  })

  it('neither Prep nor Ask: resolves "" and sends nothing', async () => {
    const h = chat({ prep: false, jobs: false })
    expect(await h.api.prepStart('Jewel360 board', STARTS, { steer: 'x', files: [] })).toBe('')
    expect(h.posts).toEqual([])
    expect(h.calls).toEqual([])
  })
})
