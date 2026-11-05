/**
 * 6.99.14, COS Control Web's live meeting view (Miles 11/05: "It keeps CLS jumping when the new transcription lines come
 * in", no files, no voice histogram). Runs the REAL panes/cos-chat.js and panes/meetings.js in a vm with a small fake DOM
 * that lays the transcript out (each turn's height from its words, the box's scrollTop clamped like a browser's), so the
 * follow and anchor rules execute against geometry, not against a re-implementation of them.
 *
 * What is pinned:
 *  - the transcript scrolls in its own box: following pins the box to its newest line and never scrolls the page;
 *    reading holds the first line on screen while new turns arrive and while turns above it are rewritten;
 *  - the header never carries what changes height while it records (files, stop line, buttons);
 *  - the recording bar: the red dot, the clock (ticks in place, the row is not rebuilt), the level strip from the live
 *    read's `levels`, Add file, and Stop and save behind a confirm (glasses), or where to stop it (Mac, iPhone);
 *  - Add file, paste and drop: the media upload, then POST /api/meeting-ask/files/media; a file is never pasted as text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHAT_SOURCE = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const MEET_SOURCE = readFileSync(join(HERE, 'panes', 'meetings.js'), 'utf8')
const SID = 'meeting_1762349349000_g2demo'
const MAC = 'mac_0a1b2c3d-1111-2222-3333-444455556666'
const PHONE = 'phone_0a1b2c3d-1111-2222-3333-444455556666'
const START = Date.now() - 15 * 60_000 - 9_000
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

// ── a fake DOM with just enough layout ──────────────────────────────────────────────────────────────────────────────
const BOX_CLIENT = 400, PAD_TOP = 16, PAD_BOTTOM = 14, GAP = 22
class El {
  id = ''; tagName = 'DIV'; className = ''; hidden = false; parentNode: El | null = null; children: El[] = []
  attrs: Record<string, string> = {}; style: Record<string, string> = {}; listeners: Record<string, Function[]> = {}
  textContent = ''; private html = ''; private top = 0; __cosHtml?: string; files?: unknown[]; value = ''; clicks = 0; writes = 0
  isConnected = true; width = 0; height = 0; cssW = 0; cssH = 0; drawn: string[] = []
  constructor(private dom: Dom, tag = 'div') { this.tagName = tag.toUpperCase() }
  get innerHTML() { return this.html }
  set innerHTML(v: string) {
    this.html = String(v); this.writes++
    this.children.forEach(c => { c.isConnected = false })
    this.children = []
    // Every element with an id in the markup becomes reachable through $(id), as the browser's would.
    for (const m of this.html.matchAll(/<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>([^<]*)/g)) {
      const el = this.dom.make(m[1], m[3])
      const attrs = m[2] + ' ' + m[4]
      const cls = /class="([^"]*)"/.exec(attrs); if (cls) el.className = cls[1]
      el.hidden = /\shidden(\s|$|>)/.test(' ' + attrs + ' ')
      el.textContent = m[5]
      el.parentNode = this
    }
    if (this.html.includes('mt-lempty')) { const p = new El(this.dom, 'p'); p.className = 'mt-lempty'; this.append(p) }
  }
  get classList() {
    const self = this
    const list = () => self.className.split(/\s+/).filter(Boolean)
    return {
      add: (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(' ') },
      remove: (c: string) => { self.className = list().filter(x => x !== c).join(' ') },
      contains: (c: string) => list().includes(c),
      toggle: (c: string, on?: boolean) => { const has = list().includes(c); const want = on === undefined ? !has : on; if (want && !has) self.classList.add(c); if (!want && has) self.classList.remove(c); return want },
    }
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  hasAttribute(k: string) { return k in this.attrs }
  addEventListener(type: string, fn: Function) { (this.listeners[type] ??= []).push(fn) }
  append(c: El) { c.parentNode = this; c.isConnected = true; this.children.push(c) }
  insertBefore(c: El, ref: El | null) {
    this.children = this.children.filter(x => x !== c)
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c)
    c.parentNode = this; c.isConnected = true
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.isConnected = false }
  get firstChild() { return this.children[0] ?? null }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null }
  get nextSibling() { const k = this.parentNode?.children ?? []; return k[k.indexOf(this) + 1] ?? null }
  // A tap target in these tests is a plain object standing in for a button inside the pane.
  contains(x: unknown) { return x === this || this.children.includes(x as El) || !(x instanceof El) }
  querySelector(sel: string) { if (sel === '.mt-lempty') return this.children.find(c => c.className === 'mt-lempty') ?? null; return null }
  querySelectorAll() { return [] as El[] }
  click() { this.clicks++ }
  focus() {}
  // Layout: a turn is its header line plus 24 px per 44 characters of words.
  get offsetHeight() { if (this.className === 'mt-lempty') return 60; const words = (this.__cosHtml ?? this.html).replace(/<[^>]+>/g, ''); return 28 + 24 * Math.max(1, Math.ceil(words.length / 44)) }
  get offsetTop() { const k = this.parentNode!.children; let y = PAD_TOP; for (const c of k) { if (c === this) return y; y += c.offsetHeight + GAP } return y }
  get scrollHeight() { const k = this.children; if (!k.length) return BOX_CLIENT; const last = k[k.length - 1]; return Math.max(BOX_CLIENT, last.offsetTop + last.offsetHeight + PAD_BOTTOM) }
  get clientHeight() { return this.cssH || BOX_CLIENT }
  get clientWidth() { return this.cssW }
  get scrollTop() { return this.top }
  set scrollTop(v: number) { this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); this.dom.boxWrites++ }
  getContext() { const d = this.drawn; return { setTransform() {}, clearRect() {}, fillRect: (x: number, _y: number, w: number, h: number) => d.push(`bar ${x.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`), beginPath() {}, arc: (x: number) => d.push(`dot ${x.toFixed(1)}`), fill() {}, set fillStyle(_v: string) {}, set globalAlpha(_v: number) {} } }
}
class Dom {
  ids = new Map<string, El>(); boxWrites = 0
  make(tag: string, id: string) { const el = new El(this, tag); el.id = id; if (id === 'mt-meter') { el.cssW = 200; el.cssH = 22 } this.ids.set(id, el); return el }
}

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''; path = ''; headers: Record<string, string> = {}; body: unknown = null; status = 0; responseText = ''
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, path: string) { this.method = method; this.path = path }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body }
  abort() { this.onabort?.() }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}

interface Chunk { i: number; elapsedMs: number; speaker: string; text: string }
function chunk(i: number, speaker = i % 2 ? 'Gina' : 'Miles', words = 'The Liquor pacing is ahead of plan for the month and the call-in volume is up about a third.') {
  return { i, elapsedMs: i * 40_000, speaker, text: `${words} (${i})` }
}

function load(opts: { sid?: string; reduceMotion?: boolean } = {}) {
  const sid = opts.sid ?? SID
  const dom = new Dom()
  FakeXHR.all = []
  const pane = dom.make('div', 'pane-meetings')
  const server = {
    chunks: [] as Chunk[], levels: [] as Array<{ i: number; level: number; speechSec: number | null }>, rev: 0, ended: false,
    files: [] as Array<Record<string, unknown>>, attach: [] as Array<{ status: number; body: unknown }>, posts: [] as Array<{ path: string; body: any }>,
    configs: 0, instance: 'inst-1', start: START,
  }
  const read = (since: number, knownRev: string | null) => ({
    sessionId: sid, ended: server.ended, unchanged: false, stamp: String(server.chunks.length) + '.' + server.rev, startTime: server.start, lastActivityAt: Date.now(),
    maxIndex: server.chunks.length - 1, settledThrough: server.chunks.length - 1, speakerRevision: server.rev,
    // As readLiveTranscriptSession: a reader that does not know this speaker revision gets every turn.
    fullSnapshot: knownRev !== String(server.rev),
    turns: server.chunks.filter(c => knownRev !== String(server.rev) || c.i > since), levels: server.levels,
  })
  const fetch = async (path: string, o: { method?: string; body?: string } = {}) => {
    const url = new URL(path, 'http://x')
    let status = 200, body: unknown = {}
    if (url.pathname === '/api/meetings/live-chunks') {
      const r: any = read(Number(url.searchParams.get('since') ?? -1), url.searchParams.get('speakerRevision'))
      body = { sessions: server.ended ? [] : [{ sessionId: sid, mtimeMs: Date.now(), stamp: r.stamp }], read: r }
    } else if (url.pathname === '/api/meeting-ask/files/media') {
      const b = JSON.parse(o.body ?? '{}'); server.posts.push({ path: url.pathname, body: b })
      const next = server.attach.shift()
      if (next) { status = next.status; body = next.body }
      else { for (const m of b.media) server.files.push({ id: 'phone_' + m.id, revision: 'r1', name: m.name, status: 'ready', text: 'x', origin: 'phone' }); body = { files: server.files } }
    } else if (/\/stop-request$/.test(url.pathname)) {
      server.posts.push({ path: url.pathname, body: JSON.parse(o.body ?? '{}') }); status = 202; body = { requestId: 'stop-1', claimWindowMs: 10_000 }
    } else if (url.pathname.endsWith('/status')) body = { state: 'active' }
    return { status, text: async () => JSON.stringify(body) }
  }
  const api = (path: string) => {
    if (path === '/api/meeting-ask/config') { server.configs++; return Promise.resolve({ protocolVersion: 2, serverInstanceId: server.instance, selected: { engine: 'claude', model: 'opus' }, models: [{ engine: 'claude', model: 'opus', available: true }], capabilities: {} }) }
    if (path.startsWith('/api/meeting-ask/history')) return Promise.resolve({ exchanges: [], nextOffset: null, files: server.files })
    if (path.startsWith('/api/meetings/live-chunks')) return fetch(path).then(r => r.text()).then(t => JSON.parse(t))
    if (path.startsWith('/api/live-cues/history')) return Promise.resolve({ cues: [] })
    return Promise.resolve({})
  }
  let pageScrolls = 0
  const W: Record<string, unknown> = {
    $: (id: string) => dom.ids.get(id) ?? null,
    esc: (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    api, toast: () => {}, setCrumb: () => {}, crumb: () => '', go: () => {}, parseRoute: () => ({ pane: 'meetings', args: ['live', sid] }),
    copyText: () => Promise.resolve(), readStore: () => ({}), writeStore: () => {}, skeletonRows: () => '', showAuth: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s),
    toDate: (s: string) => new Date(s),
    registerPane: (name: string, def: unknown) => { (W as any).panes = { ...((W as any).panes || {}), [name]: def } },
  }
  const media = (q: string) => ({ matches: q.includes('reduce') ? !!opts.reduceMotion : false, addEventListener: () => {} })
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: (id: string) => dom.ids.get(id) ?? null,
    activeElement: null, hidden: false, body: { appendChild() {} }, documentElement: {},
    createElement: (tag: string) => {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,' + 'A'.repeat(400) }
      return new El(dom, tag)
    },
  }
  class FakeImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; naturalWidth = 2000; naturalHeight = 1000; set src(_v: string) { setTimeout(() => this.onload?.(), 0) } }
  const window = {
    COSWeb: W, matchMedia: media, devicePixelRatio: 2, getSelection: () => ({ isCollapsed: true }), localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' },
    addEventListener: () => {}, scrollBy: () => { pageScrolls++ }, scrollTo: () => { pageScrolls++ }, innerHeight: 844,
  }
  const ctx = vm.createContext({
    window, document, navigator: window.navigator, localStorage: window.localStorage, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Math, Promise, Number, Array, Object, String, RegExp, Blob, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    URLSearchParams, Image: FakeImage, crypto: globalThis.crypto, XMLHttpRequest: FakeXHR, fetch, AbortController, encodeURIComponent, decodeURIComponent, isFinite,
    getComputedStyle: () => ({ getPropertyValue: () => '', overflowY: 'auto' }),
  })
  vm.runInContext(CHAT_SOURCE, ctx)
  vm.runInContext(MEET_SOURCE, ctx)
  const live = (W as any).meetingsLive
  const pane$ = (W as any).panes.meetings
  const $ = (id: string) => dom.ids.get(id)!
  const fire = (type: string, ev: Record<string, unknown>) => { let prevented = false; const e = { type, preventDefault: () => { prevented = true }, ...ev }; for (const fn of pane.listeners[type] ?? []) fn(e); return prevented }
  const tap = (act: string, extra: Record<string, string> = {}) => {
    const attrs: Record<string, string> = { 'data-mt': act, ...extra }
    const t = { disabled: false, getAttribute: (k: string) => attrs[k] ?? null }
    fire('click', { target: { closest: () => t } })
  }
  const poll = async () => { live._livePoll(); await flush() }
  return { dom, pane, server, live, pane$, $, fire, tap, poll, sid, W, pageScrolls: () => pageScrolls }
}
async function openWith(n: number, opts: { sid?: string; reduceMotion?: boolean } = {}) {
  const t = load(opts)
  for (let i = 0; i < n; i++) t.server.chunks.push(chunk(i))
  t.pane$.load(['live', t.sid])
  await flush(10)
  return t
}
const turnIds = (box: El) => box.children.map(c => c.getAttribute('data-turn'))

describe('the transcript box: new lines never move the page', () => {
  it('following: a new line lands in the box and the box shows its newest line; the page is never scrolled', async () => {
    const t = await openWith(30)
    const box = t.$('mt-turns')
    expect(box.children.length).toBe(30)
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
    const head = t.$('mt-lhead').writes
    for (let i = 30; i < 40; i++) { t.server.chunks.push(chunk(i)); await t.poll() }
    expect(box.children.length).toBe(40)
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
    expect(t.pageScrolls()).toBe(0)
    // The header is not rewritten by a new line: the clock and the strip live in the bar.
    expect(t.$('mt-lhead').writes).toBe(head)
    expect(t.$('mt-jump').hidden).toBe(true)
  })

  it('reading: scrolled up, new lines arrive below and the reader does not move; Jump to live shows and returns to the end', async () => {
    const t = await openWith(30)
    const box = t.$('mt-turns')
    box.scrollTop = 600
    t.fire('scroll', { target: box })
    expect(t.live._state.follow).toBe(false)
    expect(t.$('mt-jump').hidden).toBe(false)
    const writes = t.dom.boxWrites
    for (let i = 30; i < 36; i++) { t.server.chunks.push(chunk(i)); await t.poll() }
    expect(box.scrollTop).toBe(600)
    // Nothing above the reader changed, so the box was not written at all (a write during an iOS fling stops it).
    expect(t.dom.boxWrites).toBe(writes)
    t.tap('jump')
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
    expect(t.live._state.follow).toBe(true)
    expect(t.$('mt-jump').hidden).toBe(true)
  })

  it('reading: turns ABOVE the reader are rewritten longer (a full snapshot), and the first line on screen holds still', async () => {
    const t = await openWith(30)
    const box = t.$('mt-turns')
    box.scrollTop = 900
    t.fire('scroll', { target: box })
    const first = box.children.find(c => c.offsetTop + c.offsetHeight > box.scrollTop)!
    const before = first.offsetTop - box.scrollTop
    for (let i = 0; i < 8; i++) t.server.chunks[i] = { ...t.server.chunks[i], text: t.server.chunks[i].text + ' Corrected after the speaker pass with many more words than it had before.' }
    t.server.rev = 1
    await t.poll()
    expect(first.isConnected).toBe(true)
    expect(first.offsetTop - box.scrollTop).toBe(before)
    expect(box.scrollTop).toBeGreaterThan(900)
  })

  it('back at the end by hand: following resumes and the next line is shown', async () => {
    const t = await openWith(30)
    const box = t.$('mt-turns')
    box.scrollTop = 100; t.fire('scroll', { target: box })
    box.scrollTop = box.scrollHeight; t.fire('scroll', { target: box })
    expect(t.live._state.follow).toBe(true)
    t.server.chunks.push(chunk(30)); await t.poll()
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
    expect(turnIds(box).at(-1)).toBe('30')
  })
})

describe('the header and the recording bar', () => {
  it('the header holds title, status and notes only; the bar has the dot, the clock, the strip, Add file and Stop and save', async () => {
    const t = await openWith(5)
    const head = t.$('mt-lhead').innerHTML, bar = t.$('mt-lbar').innerHTML
    expect(head).not.toMatch(/Stop and save|mt-files|mt-stopline|mt-bar/)
    expect(bar).toMatch(/class="mt-livedot on"/)
    expect(bar).toMatch(/id="mt-ltime"/)
    expect(bar).toMatch(/<canvas class="mt-meter" id="mt-meter"/)
    expect(bar).toMatch(/data-mt="add-file"[^>]*aria-label="Add file"/)
    expect(bar).toMatch(/data-mt="stop-ask"[^>]*>Stop and save</)
    expect(t.$('mt-lfoot').innerHTML).toMatch(/data-mt="live-copy"[^>]*>Copy transcript<\/button>.*data-mt="live-context">Copy full context</)
  })

  it('the clock: m:ss, then h:mm:ss; it ticks in place and the row is not rebuilt', async () => {
    const t = await openWith(3)
    expect(t.live._elapsedLabel(0)).toBe('0:00')
    expect(t.live._elapsedLabel(909_000)).toBe('15:09')
    expect(t.live._elapsedLabel(3_725_000)).toBe('1:02:05')
    expect(t.live._elapsedLabel(-5)).toBe('0:00')
    const clock = t.$('mt-ltime'), writes = t.$('mt-lbar').writes
    clock.textContent = 'stale'
    t.live._tickClock()
    expect(clock.textContent).toMatch(/^15:\d\d$/)
    // The clock's text changes between polls (the start moves 2 s each time): the row still is not rebuilt.
    t.server.start -= 2000; await t.poll()
    t.server.start -= 2000; await t.poll()
    expect(t.$('mt-lbar').writes).toBe(writes)
  })

  it('Stop and save asks first and sends nothing until confirmed; then it asks the glasses', async () => {
    const t = await openWith(3)
    t.tap('stop-ask', { 'data-sid': SID })
    expect(t.$('mt-lbar').innerHTML).toMatch(/Stop and save this glasses meeting\?/)
    expect(t.server.posts.filter(p => /stop-request/.test(p.path))).toHaveLength(0)
    t.tap('confirm-no')
    expect(t.$('mt-lbar').innerHTML).not.toMatch(/Stop and save this glasses meeting\?/)
    t.tap('stop-ask', { 'data-sid': SID })
    t.tap('stop-yes', { 'data-sid': SID })
    await flush()
    expect(t.server.posts.filter(p => /stop-request/.test(p.path))).toEqual([{ path: `/api/meeting/sessions/${SID}/stop-request`, body: { source: 'web' } }])
  })

  it('a Mac recording and an iPhone recording say where to stop them; neither has a stop button here', async () => {
    const mac = await openWith(2, { sid: MAC })
    expect(mac.$('mt-lbar').innerHTML).toMatch(/Stop on your Mac/)
    expect(mac.$('mt-lbar').innerHTML).not.toMatch(/data-mt="stop-ask"/)
    const phone = await openWith(2, { sid: PHONE })
    expect(phone.$('mt-lbar').innerHTML).toMatch(/Stop on iPhone/)
    expect(phone.$('mt-lbar').innerHTML).not.toMatch(/data-mt="stop-ask"/)
  })

  it('once it ends, the bar is the handoff line: no clock, no Add file', async () => {
    const t = await openWith(3)
    t.server.ended = true
    await t.poll()
    const bar = t.$('mt-lbar').innerHTML
    expect(bar).toMatch(/mt-handoff/)
    expect(bar).not.toMatch(/mt-ltime|add-file/)
  })
})

describe('the level strip', () => {
  const L = (i: number, level: number, speechSec: number | null) => ({ i, level, speechSec })
  it('keeps well-formed levels in index order, one per index, the newest 120', async () => {
    const t = await openWith(1)
    const raw = [L(3, 0.5, 2), L(1, 0.2, null), { i: -1, level: 0.5, speechSec: 1 }, { i: 2, level: 1.5, speechSec: 1 }, { i: 4, level: 0.5, speechSec: -1 }, L(1, 0.9, 1), 'x']
    expect(t.live._cleanLevels(raw)).toEqual([L(1, 0.2, null), L(3, 0.5, 2)])
    expect(t.live._cleanLevels(null)).toBe(null)
    expect(t.live._cleanLevels(Array.from({ length: 130 }, (_, i) => L(i, 0.5, 1))).map((l: { i: number }) => l.i)[0]).toBe(10)
  })
  it('quiet is under 0.5 speech seconds, or level 0.27 and under without them (the server gate)', async () => {
    const t = await openWith(1)
    expect(t.live._levelSilent(L(0, 0.9, 0.49))).toBe(true)
    expect(t.live._levelSilent(L(0, 0.1, 0.5))).toBe(false)
    expect(t.live._levelSilent(L(0, 0.27, null))).toBe(true)
    expect(t.live._levelSilent(L(0, 0.28, null))).toBe(false)
  })
  it('draws a bar per chunk with speech and a dot per quiet chunk, newest at the right, oldest clipped first', async () => {
    const t = await openWith(2)
    expect(t.live._visibleLevels([L(0, 1, 1), L(1, 1, 1), L(2, 1, 1)], 10).map((l: { i: number }) => l.i)).toEqual([1, 2])
    t.server.levels = [L(0, 0.5, 2), L(1, 0.1, 0.1), L(2, 1, 3)]
    t.server.chunks.push(chunk(2)); await t.poll()
    const meter = t.$('mt-meter')
    expect(meter.drawn.slice(-3)).toEqual(['bar 196.0 3.0 22.0', 'dot 192.5', 'bar 186.0 3.0 11.0'])
    expect(meter.getAttribute('aria-label')).toBe('Audio level, a few seconds behind: speech')
  })
  it('Reduce Motion: one still bar for the newest chunk, not a strip', async () => {
    const t = await openWith(2, { reduceMotion: true })
    t.server.levels = [L(0, 0.5, 2), L(1, 0.25, 3)]
    t.server.chunks.push(chunk(2)); await t.poll()
    const drawn = t.$('mt-meter').drawn
    expect(drawn.filter(d => d.startsWith('dot'))).toEqual([])
    expect(drawn.slice(-2)).toEqual(['bar 0.0 200.0 4.0', 'bar 0.0 50.0 4.0'])
  })
})

describe('files during a live meeting', () => {
  const pdf = (name = 'Q4 pricing.pdf') => ({ name, size: 2048, type: 'application/pdf', lastModified: Date.UTC(2026, 10, 5, 13) })
  const png = (name = 'Screenshot.png') => ({ name, size: 90_000, type: 'image/png', lastModified: Date.UTC(2026, 10, 5, 13) })
  const finishUpload = (body: unknown) => { const x = FakeXHR.all.at(-1)!; x.respond(200, body) }

  it('the Files row is reserved from the start, so files that arrive with the Ask history move nothing', async () => {
    const t = load()
    t.server.files = [{ id: 'phone_m_seed', revision: 'r1', name: 'Board deck.pdf', status: 'ready', text: 'x', origin: 'phone' }]
    t.server.chunks.push(chunk(0))
    t.pane$.load(['live', SID])
    // Before the history read lands: one row, saying how to add.
    expect(t.$('mt-lfiles').innerHTML).toMatch(/No files yet\. Add file, paste or drop one here\./)
    await flush(10)
    expect(t.$('mt-lfiles').innerHTML).toMatch(/Files · 1/)
    expect(t.$('mt-lhead').innerHTML).not.toMatch(/Files/)
  })

  it('Add file opens the picker; a chosen PDF goes to /api/media/file, then joins the meeting through files/media', async () => {
    const t = await openWith(3)
    t.tap('add-file')
    expect(t.$('mt-lpick').clicks).toBe(1)
    const pick = t.$('mt-lpick'); pick.files = [pdf()]
    for (const fn of t.pane.listeners.change ?? []) fn({ target: { id: 'mt-lpick', files: pick.files, value: 'C:\\fakepath\\Q4 pricing.pdf', set v(_x: string) {} } })
    const x = FakeXHR.all.at(-1)!
    expect(x.method).toBe('POST'); expect(x.path).toBe('/api/media/file')
    expect(x.headers).toMatchObject({ 'X-COS-Web': '1', 'Content-Type': 'application/pdf', 'X-COS-Filename': 'Q4%20pricing.pdf' })
    expect(t.$('mt-lfiles').innerHTML).toMatch(/Q4 pricing\.pdf/)
    finishUpload({ attachment: { id: 'm_' + 'a'.repeat(24) } })
    await flush(10)
    expect(t.server.posts.filter(p => p.path === '/api/meeting-ask/files/media')).toEqual([{ path: '/api/meeting-ask/files/media', body: { sessionId: SID, serverInstanceId: 'inst-1', media: [{ id: 'm_' + 'a'.repeat(24), name: 'Q4 pricing.pdf' }] } }])
    const files = t.$('mt-lfiles').innerHTML
    expect(files).toMatch(/Files · 1/)
    expect(files).toMatch(/<span class="mt-files-name">Q4 pricing\.pdf<\/span>/)
    expect(files).not.toMatch(/data-up=/)
    expect(t.live._uploads().items).toEqual([])
  })

  it('a pasted screenshot is taken as a file (never as text): resized to a JPEG, posted to /api/media, added to the meeting', async () => {
    const t = await openWith(3)
    const prevented = t.fire('paste', { clipboardData: { types: ['Files'], files: [png()], getData: () => '' } })
    expect(prevented).toBe(true)
    await flush()
    const x = FakeXHR.all.at(-1)!
    expect(x.path).toBe('/api/media')
    const body = JSON.parse(String(x.body))
    expect(body.kind).toBe('user_photo'); expect(body.images[0].label).toBe('Screenshot.png'); expect(body.images[0].data).toMatch(/^A+$/)
    finishUpload({ attachments: [{ id: 'm_' + 'b'.repeat(24) }] })
    await flush(10)
    expect(t.server.posts.at(-1)!.body.media).toEqual([{ id: 'm_' + 'b'.repeat(24), name: 'Screenshot.png' }])
  })

  it('a paste or drop that holds a file the browser will not hand over is refused out loud, never inserted as its path', async () => {
    const t = await openWith(3)
    expect(t.fire('paste', { clipboardData: { types: ['Files'], files: [], getData: () => '' } })).toBe(true)
    expect(t.$('mt-lfiles').innerHTML).toMatch(/This browser did not hand over the file\. Use Add file to choose it\./)
    const uri = { types: ['text/uri-list', 'text/plain'], files: [], getData: (k: string) => (k === 'text/uri-list' ? 'file:///Users/miles/Desktop/Q4%20pricing.pdf' : '/Users/miles/Desktop/Q4 pricing.pdf') }
    expect(t.fire('paste', { clipboardData: uri })).toBe(true)
    expect(t.fire('drop', { dataTransfer: uri })).toBe(true)
    expect(FakeXHR.all).toHaveLength(0)
    // Words are words: a plain text paste goes into the box as usual.
    expect(t.fire('paste', { clipboardData: { types: ['text/plain'], files: [], getData: () => 'pricing' } })).toBe(false)
    expect(t.fire('paste', { clipboardData: { types: ['text/uri-list'], files: [], getData: () => 'https://bottlepos.com/pricing' } })).toBe(false)
  })

  it('drag and drop: a file drag is outlined and taken; a drop adds the file', async () => {
    const t = await openWith(3)
    const dt = { types: ['Files'], files: [pdf('Agenda.pdf')], getData: () => '', dropEffect: '' }
    expect(t.fire('dragover', { dataTransfer: dt })).toBe(true)
    expect(t.$('mt-lmain').classList.contains('dropping')).toBe(true)
    expect(t.fire('drop', { dataTransfer: dt })).toBe(true)
    expect(t.$('mt-lmain').classList.contains('dropping')).toBe(false)
    expect(FakeXHR.all.at(-1)!.headers['X-COS-Filename']).toBe('Agenda.pdf')
  })

  it('outside the live view a paste is left alone', async () => {
    const t = await openWith(3)
    t.pane$.leave()
    expect(t.fire('paste', { clipboardData: { types: ['Files'], files: [pdf()], getData: () => '' } })).toBe(false)
  })

  it('a video is refused with what to attach instead; nothing is uploaded', async () => {
    const t = await openWith(3)
    t.live._addLiveFiles([{ name: 'clip.mov', size: 1000, type: 'video/quicktime', lastModified: 0 }])
    expect(FakeXHR.all).toHaveLength(0)
    expect(t.$('mt-lfiles').innerHTML).toMatch(/clip\.mov is a video\. Meeting Ask reads documents and the text in images, so attach a PDF, a text file or a screenshot\./)
  })

  it('a restarted server (server_instance_mismatch) is read again once, and the file is added', async () => {
    const t = await openWith(3)
    t.server.attach.push({ status: 409, body: { error: 'server_instance_mismatch' } })
    t.server.instance = 'inst-2'
    t.live._addLiveFiles([pdf()])
    finishUpload({ attachment: { id: 'm_' + 'c'.repeat(24) } })
    await flush(12)
    const attaches = t.server.posts.filter(p => p.path === '/api/meeting-ask/files/media')
    expect(attaches.map(p => p.body.serverInstanceId)).toEqual(['inst-1', 'inst-2'])
    expect(t.$('mt-lfiles').innerHTML).toMatch(/Files · 1/)
  })

  it('a refusal says what happened and what to do; Retry adds the kept upload without sending the bytes again', async () => {
    const t = await openWith(3)
    t.server.attach.push({ status: 413, body: { error: 'file_context_limit' } })
    t.live._addLiveFiles([pdf()])
    finishUpload({ attachment: { id: 'm_' + 'd'.repeat(24) } })
    await flush(10)
    const html = t.$('mt-lfiles').innerHTML
    expect(html).toMatch(/This meeting holds as many files as Meeting Ask reads\. Remove one in COS Control on your Mac, then retry\./)
    expect(html).toMatch(/1 did not upload/)
    const id = t.live._uploads().items[0].id
    const uploads = FakeXHR.all.length
    t.tap('up-retry', { 'data-up': id })
    await flush(10)
    expect(FakeXHR.all.length).toBe(uploads)
    expect(t.server.posts.filter(p => p.path === '/api/meeting-ask/files/media')).toHaveLength(2)
    expect(t.$('mt-lfiles').innerHTML).toMatch(/Files · 1/)
  })

  it('an ended recording takes no files and says so', async () => {
    const t = await openWith(3)
    t.server.ended = true
    await t.poll()
    t.live._addLiveFiles([pdf()])
    expect(FakeXHR.all).toHaveLength(0)
    expect(t.$('mt-lfiles').innerHTML).toMatch(/This recording has ended\. Files can be added while it records\./)
  })
})

describe('copy rules on the new live view strings', () => {
  it('no em dashes, no arrows, in the live view code', () => {
    const live = MEET_SOURCE.slice(MEET_SOURCE.indexOf('// ── the recording bar'), MEET_SOURCE.indexOf('  function paintTurns('))
    expect(live.length).toBeGreaterThan(2000)
    expect(live).not.toMatch(/[\u2014\u2192\u2190]/)
  })
})
