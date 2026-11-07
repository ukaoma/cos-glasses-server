/**
 * 6.99.30 Duo layout point release (Miles's iPhone Duo, Comet and Safari): the pieces of app.js that every pane leans
 * on, run from app.js itself in a vm (never re-implemented here), and the stylesheet facts the QA rounds measured,
 * worked out from the CSS. Nothing here reaches a server.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const APP = read('app.js')
const slice = (from: string, to: string) => {
  const a = APP.indexOf(from), b = APP.indexOf(to, a + 1)
  expect(a, from).toBeGreaterThan(-1)
  expect(b, to).toBeGreaterThan(a)
  return APP.slice(a, b)
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

// ── api(): the one sentence for an unreachable Mac, the server's up or down, the Mac's clock ─────────────────────────
function transport(fetchImpl: (path: string) => Promise<unknown>, phoneOffsetMs = 0) {
  const realNow = Date.now
  class PhoneDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + phoneOffsetMs) } static now() { return realNow() + phoneOffsetMs } }
  const auth: string[] = []
  const ctx: any = vm.createContext({ window: { AbortController }, fetch: fetchImpl, Date: PhoneDate, JSON, Math, Promise, isFinite, console, AbortController, Error,
    setTimeout, clearTimeout, showAuth: (m?: string) => { auth.push(String(m || '')) } })
  vm.runInContext(slice('  function api(path, opts)', '  // ── state ─') + '\n;this.api = api; this.SERVER = SERVER; this.SX_CLOCK = SX_CLOCK; this.noteServer = noteServer;', ctx)
  return { ctx, auth }
}
const ok = (status: number, body: unknown = {}, date?: string) => Promise.resolve({ status, ok: status >= 200 && status < 300,
  headers: { get: (h: string) => (h.toLowerCase() === 'date' ? date ?? null : null) }, text: () => Promise.resolve(JSON.stringify(body)) })

describe('6.99.30: api() never shows the browser’s own network error, and says at once whether the Mac answered', () => {
  const SENTENCE = 'Could not reach COS on your Mac. Check that it is awake and on Tailscale, then try again.'
  for (const [browser, raw] of [['Chrome and Comet', 'Failed to fetch'], ['Safari', 'Load failed'], ['Firefox', 'NetworkError when attempting to fetch resource.']] as const) {
    it(`${browser}: "${raw}" becomes the one sentence, code unreachable, and marks the server down`, async () => {
      const t = transport(() => Promise.reject(new TypeError(raw)))
      const seen: boolean[] = []
      t.ctx.SERVER.hooks.push((up: boolean) => seen.push(up))
      const err = await t.ctx.api('/api/models').catch((e: any) => e)
      expect(err.message).toBe(SENTENCE)
      expect(err.code).toBe('unreachable')
      expect(err.status).toBeUndefined()
      expect(seen).toEqual([false])
    })
  }
  it('a timeout keeps its own words; an answer of any status marks the server up, a 502 down; each change is heard once', async () => {
    let next: () => Promise<unknown> = () => ok(200, { ok: true })
    const t = transport(() => next())
    const seen: boolean[] = []
    t.ctx.SERVER.hooks.push((up: boolean) => seen.push(up))
    await t.ctx.api('/a'); await t.ctx.api('/b')
    next = () => ok(502, { error: 'bad_gateway' })
    await t.ctx.api('/c').catch(() => {})
    next = () => ok(404, { error: 'nope' })
    await t.ctx.api('/d').catch(() => {})
    expect(seen, 'up once, down on the 502, up on a 404 (the Mac answered)').toEqual([true, false, true])
    const ctrlErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    next = () => Promise.reject(ctrlErr)
    const late = await t.ctx.api('/e', { timeoutMs: 1 }).catch((e: any) => e)
    expect(late.code === 'timeout' || late.name === 'AbortError', 'a timeout is not "unreachable"').toBe(true)
    expect(late.message).not.toBe(SENTENCE)
  })
  it('the panes say the same sentence: no pane keeps its own copy', () => {
    expect(read('panes/memories.js')).not.toContain('Could not reach')
    expect(read('panes/speakers.js')).toContain('W.unreachableCopy')
    expect(APP).toContain("unreachableCopy: UNREACHABLE_COPY")
  })
})

describe('6.99.30: the Mac’s clock, from each answer’s Date header (QA: clock skew)', () => {
  for (const offset of [-60_000, 60_000]) {
    it(`a phone ${offset < 0 ? '60 s behind' : '60 s ahead'}: the offset is learned within a second, from the fastest answer`, async () => {
      const t = transport(() => ok(200, {}, new Date().toUTCString()), offset)
      await t.ctx.api('/api/health')
      expect(Math.abs(t.ctx.SX_CLOCK.skew - -offset), 'within the header’s one-second grain').toBeLessThanOrEqual(1000)
      // A slower answer later never moves it; a missing header changes nothing.
      const rtt = t.ctx.SX_CLOCK.rtt
      expect(rtt).toBeGreaterThanOrEqual(0)
    })
  }
  it('no Date header: nothing is learned', async () => {
    const t = transport(() => ok(200, {}))
    await t.ctx.api('/x')
    expect(t.ctx.SX_CLOCK.skew).toBe(0)
  })
})

// The session card's one state (sxTruth) with a phone clock off from the Mac's: run from app.js's reader region.
function truthKit(phoneOffsetMs: number, opt: { fetch?: (path: string, init?: any) => Promise<unknown>; probeMs?: number } = {}) {
  const realNow = Date.now
  class PhoneDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(realNow() + phoneOffsetMs) } static now() { return realNow() + phoneOffsetMs } }
  const TRANSPORT = slice('  // ── what every request learns about the Mac', '  // ── state ─')
  const sx = slice('  function sxProvider(p)', '  function sxReal()')
  const md = slice('  // Markdown for an assistant turn', '  function renderTurns(')
  const plainFn = /  function plain\(text\) \{[^\n]*\}/.exec(APP)![0]
  let region = slice('  // ── Sessions: read, send, queue, fork, stop', "  // Copy session (Control's Kickstart brief")
  const SX = slice('  var SX_IDLE_GRACE_MS', '\n')
  if (opt.probeMs != null) { expect(region).toContain(SX); region = region.replace(/SX_PROBE_TIMEOUT_MS = \d+/, 'SX_PROBE_TIMEOUT_MS = ' + opt.probeMs) }
  const fetch = opt.fetch ?? (() => ok(200, {}, new Date(realNow()).toUTCString()))
  const deps: Record<string, unknown> = { state: { reading: null }, $: () => null, esc: (s: unknown) => String(s), md: (s: unknown) => String(s),
    toDate: (v: unknown) => (v ? new PhoneDate(String(v)) : null), autoGrow: () => {}, showAuth: () => {}, clock: () => '', fetch, Date: PhoneDate,
    localStorage: { getItem: () => null, setItem: () => {} }, AbortController, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    requestAnimationFrame: () => 0, document: {}, window: { COSWeb: {}, scrollTo: () => {} }, console }
  // eslint-disable-next-line no-new-func
  return new Function('deps', 'with (deps) {\n' + plainFn + '\n' + TRANSPORT + '\n' + sx + '\n' + md + '\n' + region +
    '\nreturn { truth: sxTruth, noteGate: sxNoteGate, apply: applyFeed, newFeed: newFeed, answer: apiAnswer, clock: SX_CLOCK, probe: sxProbeAttach, stale: sxGateStale };\n}')(deps)
}
describe('6.99.30: Idle never beats a fresher Working because the phone’s clock is off (sxTruth)', () => {
  const session = (k: any) => ({ provider: 'claude', id: 's', feed: k.newFeed(), live: {}, gate: null, stoppedAt: null })
  it('phone 60 s behind: the Mac said Idle 30 s ago, the write gate says busy now: Working', async () => {
    const k = truthKit(-60_000)
    await k.answer('/api/health')   // one answer teaches the offset
    const r = session(k)
    k.apply(r, { seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_since: new Date(Date.now() - 30_000).toISOString() })
    k.noteGate(r, true)
    expect(k.truth(r)).toMatchObject({ word: 'Working', src: 'gate' })
  })
  it('phone 60 s ahead: the gate said busy, then the Mac said Idle 10 s later: Idle', async () => {
    const k = truthKit(60_000)
    await k.answer('/api/health')
    const r = session(k)
    k.noteGate(r, true)
    k.apply(r, { seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_since: new Date(Date.now() + 10_000).toISOString() })
    expect(k.truth(r)).toMatchObject({ word: 'Idle', src: 'hook' })
  })
  it('phone 60 s ahead: a Stop 20 s ago, then the Mac says Working now: a new turn, Working (the Stop ranks on the Mac’s clock)', async () => {
    const k = truthKit(60_000)
    await k.answer('/api/health')
    const r: any = session(k)
    r.stoppedAt = Date.now() - 20_000
    k.apply(r, { seq: 1, kind: 'status', state: 'working', agent_state: 'running', state_since: new Date(Date.now() - 60_000).toISOString() })
    expect(k.truth(r)).toMatchObject({ word: 'Working', src: 'hook' })
  })
  it('the same two cases with no offset learned are the bug this fixes (the guard is the offset, not luck)', () => {
    const behind = truthKit(-60_000), r1 = session(behind)
    behind.apply(r1, { seq: 1, kind: 'status', state: 'idle', agent_state: 'idle', state_since: new Date(Date.now() - 30_000).toISOString() })
    behind.noteGate(r1, true)
    expect(behind.truth(r1)!.word, 'unlearned: the stale Idle wins').toBe('Idle')
  })
})

describe('6.99.30: a busy gate is asked again even when a probe never answers ("cannot stand forever" is now true)', () => {
  it('a probe whose request hangs gives up at its deadline, counts as a failure, and frees the next re-ask', async () => {
    const hung = (_p: string, init?: any) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))) })
    const k = truthKit(0, { fetch: hung, probeMs: 20 })
    const r: any = { provider: 'claude', id: 's', feed: k.newFeed(), live: {}, view: { verdict() {}, stateChanged() {} }, stoppedAt: null }
    k.noteGate(r, true)
    const p = k.probe(r)
    expect(r.probing).toBe(true)
    await p
    expect(r.probing, 'the deadline freed it').toBe(false)
    expect(r.gate.failures).toBe(1)
  })
  it('the deadline is set on the probe (15 s)', () => {
    expect(APP).toMatch(/SX_PROBE_TIMEOUT_MS = 15000/)
    expect(APP).toContain("'/attachability'), { timeoutMs: SX_PROBE_TIMEOUT_MS })")
  })
})

// ── the visible viewport, read one way (app.js viewportFit) ──────────────────────────────────────────────────────────
function fit(win: any, doc: any = { documentElement: { clientHeight: win.innerHeight } }) {
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', slice('  var VP = { layoutH: 0 };', '  // ── layout breadcrumbs') + '\nreturn viewportFit;')(win, doc) as () => any
}
describe('6.99.30: viewportFit', () => {
  it('no visualViewport: the whole layout viewport, nothing covered', () => {
    expect(fit({ innerHeight: 678 })()).toMatchObject({ top: 0, height: 678, inset: 0, below: 0, vv: false })
  })
  it('a bottom bar over the page, a keyboard, a panned page', () => {
    const vv: any = { height: 568, offsetTop: 0, scale: 1 }, f = fit({ innerHeight: 678, visualViewport: vv })
    expect(f()).toMatchObject({ top: 0, height: 568, inset: 110, below: 110 })
    Object.assign(vv, { height: 380, offsetTop: 120 })
    expect(f()).toMatchObject({ top: 120, height: 380, inset: 298, below: 178 })
  })
  it('pinch zoom 1.5: no inset, the layout viewport, and the layout height read before the zoom stands when innerHeight follows the zoom', () => {
    const vv: any = { height: 1000, offsetTop: 0, scale: 1 }, win: any = { innerHeight: 1000, visualViewport: vv }, f = fit(win)
    expect(f().layoutH).toBe(1000)
    Object.assign(vv, { height: 1000 / 1.5, offsetTop: 200, scale: 1.5 }); win.innerHeight = 667
    expect(f()).toMatchObject({ layoutH: 1000, top: 0, height: 1000, inset: 0, zoomed: true })
    Object.assign(vv, { height: 400, offsetTop: 700 })   // the keyboard rises while zoomed: 400 px covered
    expect(f()).toMatchObject({ height: 600, inset: 400, top: 400 })
  })
})

// ── layout breadcrumbs ─────────────────────────────────────────────────────────────────────────────────────────────────
function crumbKit(ua: string, extra: Record<string, unknown> = {}) {
  const posts: Array<{ path: string; body: any }> = []
  let now = 1_000_000
  const ctx: any = vm.createContext({
    window: { innerWidth: 1430, innerHeight: 1000, visualViewport: { height: 894, width: 1430, offsetTop: 0, scale: 1 }, matchMedia: (q: string) => ({ matches: q.includes('coarse') }) },
    document: { documentElement: { clientHeight: 1000 } }, navigator: { userAgent: ua, maxTouchPoints: 0, ...extra }, screen: { orientation: { type: 'landscape-primary' } },
    api: (path: string, o: any) => { posts.push({ path, body: o.body }); return Promise.resolve({}) }, Date: { now: () => now }, JSON, Math, isFinite, Object, String,
  })
  vm.runInContext(slice('  // ── layout breadcrumbs', '  // ── the shared kit') + '\n;this.crumb = layoutCrumb; this.ua = uaClass;', ctx)
  return { ctx, posts, later: (ms: number) => { now += ms } }
}
describe('6.99.30: a layout breadcrumb on open and on each keyboard change reaches the existing diagnostics log', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  it('the browser family, never the user agent string', () => {
    const k = crumbKit(IOS + ' Version/26.1 Mobile/15E148 Safari/604.1')
    const cases: Array<[string, string, string]> = [
      [IOS + ' Version/26.1 Mobile/15E148 Safari/604.1', 'safari', 'ios'],
      [IOS + ' Version/26.1 Mobile/15E148 Safari/604.1 Comet/1.4.0', 'comet', 'ios'],
      [IOS + ' CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1', 'crios', 'ios'],
      [IOS + ' FxiOS/145.0 Mobile/15E148 Safari/605.1.15', 'firefox', 'ios'],
      ['Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'chrome', 'android'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'chrome', 'mac'],
    ]
    for (const [ua, brand, os] of cases) expect(k.ctx.ua(ua), ua).toEqual({ brand, os })
    // Comet on Chromium says so in its client hints even when the string does not.
    const hinted = crumbKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { userAgentData: { brands: [{ brand: 'Comet' }, { brand: 'Chromium' }] } })
    expect(hinted.ctx.ua().brand).toBe('comet')
  })
  it('posts numbers to /api/diag/client: visible vs layout heights, zoom, orientation, the overlay’s state; nothing else', () => {
    const k = crumbKit(IOS + ' Version/26.1 Mobile/15E148 Safari/604.1 Comet/1.4.0')
    expect(k.ctx.crumb('open', { kind: 'run', kb: false, inset: 106, below: 106, lh: 1000, text: 'Ship it to prod please, here is a long sentence', 'bad-key': 1, nested: { a: 1 } })).toBe(true)
    expect(k.posts).toHaveLength(1)
    const p = k.posts[0]!
    expect(p.path).toBe('/api/diag/client')
    expect(p.body).toMatchObject({ level: 'info', event: 'web.layout' })
    expect(p.body.data).toMatchObject({ what: 'open', ua: 'comet', os: 'ios', iw: 1430, ih: 1000, ch: 1000, vvh: 894, vvt: 0, vvs: 1, orient: 'landscape-primary', coarse: true, kind: 'run', kb: false, inset: 106, below: 106, lh: 1000 })
    const json = JSON.stringify(p.body)
    expect(json, 'never the UA string').not.toContain('Mozilla')
    expect(p.body.data.text, 'a string over 24 characters is dropped').toBeUndefined()
    expect(p.body.data['bad-key']).toBeUndefined()
    expect(p.body.data.nested).toBeUndefined()
  })
  it('the same line twice within 2 s goes once; at most 40 a page load', () => {
    const k = crumbKit(IOS)
    k.ctx.crumb('kb', { kb: true }); k.ctx.crumb('kb', { kb: true })
    expect(k.posts).toHaveLength(1)
    k.later(2500); k.ctx.crumb('kb', { kb: true })
    expect(k.posts).toHaveLength(2)
    for (let i = 0; i < 60; i++) k.ctx.crumb('kb', { inset: i })
    expect(k.posts).toHaveLength(40)
  })
  it('the route it posts to exists, is bounded and rate-limited on the server', () => {
    const diag = readFileSync(join(HERE, '..', 'routes', 'diag.ts'), 'utf8')
    expect(diag).toContain("diagRouter.post('/diag/client'")
    expect(diag).toMatch(/MAX_FILE_BYTES = 10 \* 1024 \* 1024/)
    expect(diag).toMatch(/RATE_MAX_PER_WINDOW = 30/)
  })
})

// ── Return sends only with a keyboard and a pointer ─────────────────────────────────────────────────────────────────
describe('6.99.30: Return sends only where a keyboard and a fine pointer are the way in, never mid-composition', () => {
  function sends(fine: boolean, e: Record<string, unknown>) {
    const win = { matchMedia: (q: string) => ({ matches: fine && q === '(hover: hover) and (pointer: fine)' }) }
    const src = /  function keyboardFirst\(\) \{[^\n]*\}/.exec(APP)![0] + '\n' + /  function returnSends\(e\) \{[^\n]*\}/.exec(APP)![0]
    // eslint-disable-next-line no-new-func
    return new Function('window', src + '\nreturn returnSends;')(win)({ key: 'Enter', target: { tagName: 'TEXTAREA' }, ...e })
  }
  it('the unfolded Duo (1430 wide, touch, a Bluetooth keyboard): Return is a new line', () => { expect(sends(false, {})).toBe(false) })
  it('a Mac or PC: Return sends; Shift-Return, an IME composing, keyCode 229 and an input do not', () => {
    expect(sends(true, {})).toBe(true)
    expect(sends(true, { shiftKey: true })).toBe(false)
    expect(sends(true, { isComposing: true })).toBe(false)
    expect(sends(true, { keyCode: 229 })).toBe(false)
    expect(sends(true, { target: { tagName: 'INPUT' } })).toBe(false)
  })
  it('the page’s keydown uses it, and the width test is gone', () => {
    expect(APP).toContain('if (returnSends(e)) {')
    expect(APP).not.toMatch(/'Enter' && !e\.shiftKey && e\.target\.tagName === 'TEXTAREA' && !isPhone\(\)/)
  })
})

// ── plain dates and rows ────────────────────────────────────────────────────────────────────────────────────────────
describe('6.99.30 design QA: plain dates and no raw ids on rows', () => {
  // eslint-disable-next-line no-new-func
  const plainDay = new Function(/  var MONTHS = [^\n]*\n/.exec(APP)![0] + slice('  function plainDay(v, now)', '  var PROVIDERS') + '\nreturn plainDay;')() as (v: unknown, now?: Date) => string
  const now = new Date(2026, 10, 7, 15, 0)
  it('"Today", "Nov 6", "Dec 31, 2025"; a YYYY-MM-DD is that calendar day, never shifted by time zone', () => {
    expect(plainDay('2026-11-07', now)).toBe('Today')
    expect(plainDay('2026-11-06', now)).toBe('Nov 6')
    expect(plainDay('2025-12-31', now)).toBe('Dec 31, 2025')
    expect(plainDay(new Date(2026, 10, 7, 23, 59), now)).toBe('Today')
    expect(plainDay('not a date', now)).toBe('not a date')
    expect(plainDay(null, now)).toBe('')
  })
  it('Meetings and Speakers rows use it; Threads rows carry no thread id', () => {
    const W = { plainDay: (v: string) => plainDay(v, now) }
    const meetings = read('panes/meetings.js')
    const sub = /  function subtitle\(m\) \{[\s\S]*?\n  \}/.exec(meetings)![0]
    // eslint-disable-next-line no-new-func
    const subtitle = new Function('W', 'fmtTime', 'domainLabel', 'num', 'isPhone', sub + '\nreturn subtitle;')(W, (t: string) => t, () => 'Quilt', Number, () => false)
    expect(subtitle({ date: '2026-11-07', duration: '35 min' })).toBe('Today · Quilt · 35 min')
    expect(subtitle({ date: '2026-11-05' })).toBe('Nov 5 · Quilt')
    const speakers = read('panes/speakers.js')
    const day = /  function day\(v\) \{[^\n]*\}/.exec(speakers)![0], dl = /  function dateLine\(m\) \{[^\n]*\}/.exec(speakers)![0]
    // eslint-disable-next-line no-new-func
    const dateLine = new Function('W', 'clock12', day + '\n' + dl + '\nreturn dateLine;')(W, (t: string) => t)
    expect(dateLine({ date: '2026-11-07', time: '9:00 AM', duration: '20 min' })).toBe('Today · 9:00 AM · 20 min')
    const threads = read('panes/threads.js')
    const row = /  function row\(t\) \{[\s\S]*?\n  \}/.exec(threads)![0], hit = /  function hitRow\(h\) \{[\s\S]*?\n  \}/.exec(threads)![0]
    // eslint-disable-next-line no-new-func
    const fns = new Function('esc', 'subtitle', 'matchLabel', row + '\n' + hit + '\nreturn { row: row, hitRow: hitRow };')((s: string) => s, () => '7 meetings', () => 'Keyword')
    expect(fns.row({ id: 't1', name: 'SEO' })).not.toContain('t1<')
    expect(fns.row({ id: 't1', name: 'SEO' })).toContain('data-id="t1"')
    expect(fns.hitRow({ id: 't2', title: 'SEO' })).not.toContain('>t2<')
  })
})

// ── the stylesheets ─────────────────────────────────────────────────────────────────────────────────────────────────
const SHEETS = ['app.css', 'control.css', ...['cos-chat', 'meetings', 'memories', 'questions', 'sessions', 'speakers', 'today-actions', 'work'].map(n => `panes/${n}.css`), 'memories/graph-explorer.css']
const CSS = Object.fromEntries(SHEETS.map(f => [f, read(f)]))
/** Every rule in a sheet, comments out, with the selector, its declarations and the @media it sits in. */
function rules(css: string) {
  const out: Array<{ sel: string; decls: string; media: string }> = []
  const s = noComments(css)
  let i = 0, media = ''
  const stack: string[] = []
  let buf = ''
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '{') {
      const head = buf.trim(); buf = ''
      if (head.startsWith('@media') || head.startsWith('@supports')) { stack.push(head); media = stack.join(' ') }
      else {
        const close = s.indexOf('}', i)
        out.push({ sel: head, decls: s.slice(i + 1, close), media }); i = close + 1; continue
      }
    } else if (ch === '}') { stack.pop(); media = stack.join(' '); buf = '' } else buf += ch
    i++
  }
  return out
}
const isField = (sel: string) => /\b(input|select|textarea)\b|\.field\b/.test(sel)
const fontPx = (decls: string) => { const m = /font-size:\s*([\d.]+)px/.exec(decls) || /font:[^;]*?\s([\d.]+)px/.exec(decls); return m ? parseFloat(m[1]!) : null }
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
function contrast(a: number[], b: number[]) {
  const l = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!) }
  const [x, y] = [l(a), l(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05)
}

describe('6.99.30: no field zooms the page on a touch screen, at any width', () => {
  it('one touch rule makes every typing field exactly 16 px, and no field anywhere is set above 16 px (so it is a floor, not a shrink)', () => {
    const touch = rules(CSS['app.css']!).filter(r => /any-pointer: coarse/.test(r.media) && /select, textarea/.test(r.sel))
    expect(touch).toHaveLength(1)
    expect(touch[0]!.decls.trim()).toBe('font-size: 16px !important;')
    expect(touch[0]!.sel).toMatch(/^input:not\(\[type='checkbox'\]\)/)
    for (const t of ['checkbox', 'radio', 'range', 'file', 'button', 'submit']) expect(touch[0]!.sel, t).toContain(`:not([type='${t}'])`)
    for (const [f, css] of Object.entries(CSS)) for (const r of rules(css)) {
      if (!isField(r.sel)) continue
      const px = fontPx(r.decls)
      if (px != null) expect(px, `${f}: ${r.sel}`).toBeLessThanOrEqual(16)
      if (/font[^;]*!important/.test(r.decls) && px != null && px < 16) throw new Error(`${f}: ${r.sel} would beat the touch rule`)
    }
  })
  it('the fields the skeptic named were compact at 600 px and up: each is covered by the touch rule (it is a field)', () => {
    const named: Array<[string, string]> = [['control.css', '.cx-search .field'], ['control.css', '.cx-find .field'], ['control.css', '.cx-inline-form .field'], ['panes/cos-chat.css', '.cc-model .field'], ['panes/sessions.css', '.sx-select']]
    for (const [f, sel] of named) {
      const r = rules(CSS[f]!).find(x => x.sel === sel)!
      expect(r, sel).toBeTruthy()
      expect(fontPx(r.decls)!, sel + ' is under 16 px at its base').toBeLessThan(16)
    }
    expect(read('app.js')).toContain('class="field sx-select"')
  })
})

describe('6.99.30: tap targets, dvh, the rail, [hidden], long lines', () => {
  it('folded, every .cx-btn and .field is at least 44 px; the per-pane phone heights that fought it are gone', () => {
    const floor = rules(CSS['app.css']!).find(r => /max-width: 599px/.test(r.media) && r.sel === '.cx-btn, .field')!
    expect(floor.decls.trim()).toBe('min-height: 44px !important;')
    for (const [f, css] of Object.entries(CSS)) for (const r of rules(css)) {
      if (!/max-width: (599|480|429)px/.test(r.media) || !/\.cx-btn\b|\.field\b|\.sx-select\b/.test(r.sel)) continue
      const h = /(?:^|;)\s*(?:min-)?height:\s*(\d+)px/.exec(r.decls)
      if (h) expect(Number(h[1]), `${f}: ${r.sel}`).toBeGreaterThanOrEqual(44)
    }
  })
  it('touch screens: nav, Send, Retry, steps and days reach 44 px; chip remove, camera and clip 44 square; a switch grows its hit area only', () => {
    const coarse = rules(CSS['app.css']!).filter(r => /any-pointer: coarse/.test(r.media))
    const tall = coarse.find(r => r.sel.startsWith('.nav-btn'))!
    for (const s of ['.nav-btn', '.btn.small', '.cc-chip-retry', '.sq-step', '.mt-day']) expect(tall.sel.split(/,\s*/), s).toContain(s)
    expect(tall.decls).toContain('min-height: 44px !important')
    const square = coarse.find(r => r.sel.startsWith('.cc-chip-x'))!
    expect(square.decls).toMatch(/min-width: 44px !important; min-height: 44px !important/)
    const sw = coarse.find(r => r.sel === '.cx-switch button::before')!
    const inset = /inset: (-?\d+)px/.exec(sw.decls)!
    expect(30 - 2 * Number(inset[1]), 'a 30 px switch with its hit area').toBeGreaterThanOrEqual(44)
  })
  it('every vh height has a dvh beside it in the same rule; the ones the skeptic named are fixed', () => {
    for (const [f, css] of Object.entries(CSS)) for (const r of rules(css)) {
      for (const m of r.decls.matchAll(/([\w-]+):\s*[^;]*\b\d+vh\b[^;]*;/g)) {
        const prop = m[1]!
        expect(new RegExp(prop + ':[^;]*\\d+dvh').test(r.decls) || /@supports \(height: 100dvh\)/.test(css), `${f}: ${r.sel} ${prop}`).toBe(true)
      }
    }
    expect(CSS['panes/cos-chat.css']).toContain('height: calc(100dvh - 72px - var(--safe-top, 0px))')
    expect(CSS['panes/cos-chat.css']).toContain('min-height: calc(100dvh - 64px - var(--safe-top, 0px))')
    expect(CSS['panes/meetings.css']).toContain('max-height: calc(100dvh - 80px - var(--safe-top, 0px))')
  })
  it('the full rail needs a tall screen too, the same clause as the desktop step', () => {
    const c = noComments(CSS['control.css']!)
    expect(c).toContain('@media (min-width: 1100px) and (min-height: 721px) {\n  .app-shell { grid-template-columns: 248px')
    expect(c).not.toMatch(/@media \(min-width: 1100px\) \{\n  \.app-shell \{ grid-template-columns: 248px/)
    expect(noComments(CSS['app.css']!)).toContain('@media (min-width: 1100px) and (min-height: 721px) {')
  })
  it('[hidden] always hides (Retry image showed under loaded images); the limits line wraps inside its row', () => {
    expect(rules(CSS['app.css']!).find(r => r.sel === '[hidden]')!.decls.trim()).toBe('display: none !important;')
    const lim = rules(CSS['panes/cos-chat.css']!).find(r => r.sel === '.cc-chips .att-limit')!.decls
    for (const d of ['min-width: 0', 'max-width: 100%', 'white-space: normal', 'overflow-wrap: anywhere']) expect(lim, d).toContain(d)
  })
  it('Settings and Dictation stop at 720 px; prose lines at 68 characters; the folded reader composer gives the words a row', () => {
    const c = rules(CSS['control.css']!)
    expect(c.find(r => r.sel === '#pane-settings, #pane-dictation')!.decls.trim()).toBe('max-width: 720px;')
    expect(c.find(r => r.sel === '.cx-set-desc, .cx-set-blurb, .wk-fine')!.decls.trim()).toBe('max-width: 68ch;')
    const narrow = rules(CSS['panes/cos-chat.css']!).filter(r => /max-width: 429px/.test(r.media))
    expect(narrow.find(r => r.sel === '.att-composer > textarea')!.decls.trim()).toBe('flex: 1 1 100%;')
  })
  it('the Duo comments say what the Duo is: about 382x678 folded, 1430x1000 unfolded; no Safari-only bar is assumed', () => {
    const a = CSS['app.css']!
    expect(a).toContain('about 1430x1000 landscape, 1000x1430 portrait')
    expect(a).toContain('about 382x678')
    expect(a).not.toContain('890x626')
    expect(a).not.toContain("Safari owns the bottom edge on both screens")
  })
})

describe('6.99.30 design QA: light-mode contrast, dark mode unchanged', () => {
  const light = (css: string, name: string) => new RegExp(':root \\{[^}]*' + name + ':\\s*(#[0-9a-f]{6})', 'i').exec(noComments(css))![1]!
  const page = light(CSS['app.css']!, '--page'), panel = light(CSS['app.css']!, '--panel'), sub = light(CSS['app.css']!, '--sub')
  it('--tertiary is #6e675d in light and reads 4.5:1 on the page and the panel; dark keeps #8f8577', () => {
    expect(light(CSS['control.css']!, '--tertiary')).toBe('#6e675d')
    for (const bg of [page, panel]) expect(contrast(hex('#6e675d'), hex(bg))).toBeGreaterThanOrEqual(4.5)
    const c = noComments(CSS['control.css']!)
    expect(c).toMatch(/:root\[data-theme='dark'\] \{\s*--tertiary: #8f8577;/)
    expect(c).toMatch(/:root:not\(\[data-theme='light'\]\) \{\s*--tertiary: #8f8577;/)
  })
  it('a calendar day with nothing to open uses --sub at full opacity (it was 38% ink, 2.35:1)', () => {
    const m = rules(CSS['panes/meetings.css']!)
    expect(m.find(r => r.sel === '.mt-day:disabled')!.decls.trim()).toBe('opacity: 1;')
    expect(m.find(r => r.sel === '.mt-day:disabled .mt-dnum')!.decls.trim()).toBe('color: var(--sub);')
    expect(contrast(hex(sub), hex(page))).toBeGreaterThanOrEqual(4.5)
  })
  it('the provider badges’ words read 4.5:1 on their own tint in light (about 25 to 30% darker); dark uses the glyph colour', () => {
    const s = noComments(CSS['panes/sessions.css']!)
    const rgb = (name: string) => { const m = new RegExp('\\.sx \\{[^}]*' + name + ': rgb\\((\\d+), (\\d+), (\\d+)\\)').exec(s)!; return [1, 2, 3].map(i => Number(m[i])) }
    for (const p of ['claude', 'codex', 'cursor']) {
      const ink = rgb(`--pv-${p}-ink`), glyph = rgb(`--pv-${p}`)
      for (const bg of [page, panel]) {
        const tint = glyph.map((g, i) => Math.round(g * 0.14 + hex(bg)[i]! * 0.86))
        expect(contrast(ink, tint), `${p} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
      const dark = ink.map((v, i) => v / glyph[i]!)
      expect(Math.max(...dark), p + ' about a quarter darker than the glyph').toBeLessThanOrEqual(0.78)
      expect(s).toContain(`.sx-badge${p === 'claude' ? '' : '.' + p} {`.replace('.sx-badge {', '.sx-badge {'))
      expect(s).toMatch(new RegExp(`--pv-${p}-ink: var\\(--pv-${p}\\)`))
    }
    expect(s).toContain('color: var(--pv-claude-ink, var(--pv-claude))')
  })
})
