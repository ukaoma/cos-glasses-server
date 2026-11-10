/**
 * The first open, part two (lead 14:55; Miles's phone 13:49: first paint 520 ms, the app 592 ms, so the mark led by
 * only 72 ms). The six scripts held the first paint. Now index.html lists them as data and theme.js loads them one frame
 * after the page is drawn, in the same order, and runs boot only once all of them have run (W1_first_open_speed.md,
 * variant D). The open-time report splits the time (dcl, boot, rtt), and the device and focus reports say whether the
 * page is wider than the screen (cw, dw, scw, wide). These run theme.js and app.js's own text against fakes.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')
function slice(text: string, startMark: string, endMark: string): string {
  const a = text.indexOf(startMark), b = text.indexOf(endMark, a + startMark.length)
  expect(a, startMark).toBeGreaterThan(-1)
  expect(b, endMark).toBeGreaterThan(a)
  return text.slice(a, b)
}
const LIST = ['/control/vendor/qrcode-encoder.js', '/control/memory-review.js', '/control/app.js', '/control/shell.js', '/control/panes/cos-chat.js', '/control/panes/questions.js']

describe('index.html: the six scripts are a list, in the order they always ran', () => {
  it('the list, quoted and absolute (so the static server stamps each with its ?v= hash and it stays cached)', () => {
    const m = /<script type="application\/json" id="boot-scripts">([^<]*)<\/script>/.exec(HTML)
    expect(m, 'the list').not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual(LIST)
  })
  it('each of them is preloaded in the head, in the same order, so a first open downloads them while the page parses', () => {
    const head = HTML.slice(0, HTML.indexOf('</head>'))
    const pre = [...head.matchAll(/<link rel="preload" href="([^"]+)" as="script">/g)].map(m => m[1])
    expect(pre).toEqual(LIST)
  })
  it('no script tag but theme.js, so nothing runs before the first paint; the list comes before the lazy panes', () => {
    expect(HTML.match(/<script src=/g)?.length).toBe(1)
    expect(HTML).toContain('<script src="/control/theme.js"></script>')
    expect(HTML.indexOf('id="boot-scripts"')).toBeLessThan(HTML.indexOf('id="lazy-panes"'))
  })
})

describe('theme.js: load the list one frame after the page is drawn, in order, then run boot', () => {
  function run(opts: { readyState?: string; list?: unknown; rafFires?: boolean } = {}) {
    const listeners: Record<string, Array<() => void>> = {}, timers: Array<{ fn: () => void; ms: number }> = [], frames: Array<() => void> = []
    const added: Array<{ src: string; async: boolean; onload?: () => void; onerror?: () => void }> = []
    const document: any = {
      readyState: opts.readyState ?? 'loading',
      documentElement: { setAttribute() {}, classList: { add() {} } },
      addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn) },
      getElementById: (id: string) => id === 'boot-scripts' ? (opts.list === undefined ? { textContent: JSON.stringify(LIST) } : opts.list) : null,
      createElement: () => ({ src: '', async: true }),
      body: { appendChild: (el: any) => { added.push(el) } },
    }
    const window: any = { matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame: (fn: () => void) => { frames.push(fn) } }
    const setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }) }
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'localStorage', 'setTimeout', THEME)(window, document, { getItem: () => null }, setTimeout)
    const runTimers = (max = 1000) => { for (let i = 0; i < 20; i++) { const t = timers.findIndex(x => x.ms <= max); if (t < 0) break; timers.splice(t, 1)[0]!.fn() } }
    return { listeners, timers, frames, added, window, runTimers, fire: (ev: string) => (listeners[ev] ?? []).forEach(f => f()), frame: () => frames.splice(0).forEach(f => f()) }
  }
  it('while the page is still arriving, nothing loads; after DOMContentLoaded it waits for one frame, then adds all six in order', () => {
    const h = run()
    expect(h.added).toHaveLength(0)
    expect(h.frames.length + h.timers.length, 'nothing is even scheduled while the page is arriving').toBe(0)
    h.fire('DOMContentLoaded')
    expect(h.added, 'not before a frame').toHaveLength(0)
    expect(h.frames, 'one frame is asked for').toHaveLength(1)
    expect(h.timers.map(t => t.ms), 'and only the 50 ms fallback, no immediate load').toEqual([50])
    h.frame(); h.runTimers(0)
    expect(h.added.map(s => s.src)).toEqual(LIST)
    expect(h.added.every(s => s.async === false), 'async=false keeps the order').toBe(true)
  })
  it('no frame comes (a page in the background): the 50 ms fallback loads them, once', () => {
    const h = run()
    h.fire('DOMContentLoaded')
    expect(h.timers.map(t => t.ms)).toContain(50)
    h.runTimers()
    expect(h.added.map(s => s.src)).toEqual(LIST)
    h.frame(); h.runTimers()
    expect(h.added, 'a late frame does not load them twice').toHaveLength(6)
  })
  it('boot runs only after every script has settled, a failed one counting; a later caller runs at once, once', () => {
    const h = run({ readyState: 'interactive' })
    const ran: string[] = []
    h.window.CosBoot.after(() => ran.push('boot'))
    h.frame(); h.runTimers(0)
    h.added.slice(0, 5).forEach((s, i) => (i === 2 ? s.onerror! : s.onload!)())
    expect(ran, 'one script still loading').toEqual([])
    h.added[5]!.onload!()
    expect(ran).toEqual(['boot'])
    h.window.CosBoot.after(() => ran.push('late'))
    expect(ran).toEqual(['boot', 'late'])
  })
  it('only same-origin /control/ scripts; a missing or broken list loads nothing and lets boot through', () => {
    const odd = run({ readyState: 'interactive', list: { textContent: JSON.stringify(['/control/app.js', 'https://elsewhere.example/x.js', '//evil/x.js', 42]) } })
    odd.frame(); odd.runTimers(0)
    expect(odd.added.map(s => s.src)).toEqual(['/control/app.js'])
    for (const list of [null, { textContent: 'not json' }]) {
      const h = run({ readyState: 'interactive', list })
      const ran: string[] = []
      h.window.CosBoot.after(() => ran.push('boot'))
      h.frame(); h.runTimers(0)
      expect(h.added).toHaveLength(0)
      expect(ran).toEqual(['boot'])
    }
  })
})

describe('app.js: boot waits for the loader; without one, as before', () => {
  const SRC = slice(APP, "  if (document.readyState === 'loading' && !cosBootAfter()) document.addEventListener('DOMContentLoaded', boot);", "  // The scripts come from theme.js's loader") +
    '\n' + slice(APP, '  function cosBootAfter() {', '\n') + '\n'
  function run(readyState: string, withLoader: boolean) {
    const calls: string[] = []
    const deps = {
      document: { readyState, addEventListener: (ev: string) => calls.push('listen:' + ev) },
      window: withLoader ? { CosBoot: { after: (fn: () => void) => { calls.push('after'); void fn } } } : {},
      boot: () => calls.push('boot'),
    }
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${SRC}\n}`)(deps)
    return calls
  }
  it('with the loader, boot goes to CosBoot.after and is not run now', () => {
    expect(run('interactive', true)).toEqual(['after'])
    expect(run('complete', true)).toEqual(['after'])
  })
  it('without it: on DOMContentLoaded while loading, at once otherwise (a page from before the loader)', () => {
    expect(run('loading', false)).toEqual(['listen:DOMContentLoaded'])
    expect(run('interactive', false)).toEqual(['boot'])
  })
})

describe('the open-time report splits the time: dcl, boot, rtt', () => {
  const BOOT = slice(APP, '  function boot() {', "  if (document.readyState === 'loading' && !cosBootAfter())")
  function run(answer: 'ok' | 'fail', clock: number[]) {
    let i = 0
    const FIRST_PAINT: Record<string, unknown> = { done: false }
    let settle!: () => void
    const done = new Promise<void>(r => { settle = r })
    const deps = {
      performance: { now: () => clock[Math.min(i++, clock.length - 1)]! },
      FIRST_PAINT, location: { search: '', pathname: '/control/', hash: '' }, URLSearchParams, history: { replaceState() {} }, document: { title: '', addEventListener() {}, hidden: false },
      api: () => answer === 'ok' ? Promise.resolve({ authenticated: true }) : Promise.reject(Object.assign(new Error('x'), { status: 0 })),
      // boot's own bootAnswer and bootFail come with the slice; they end in showShell or showAuth.
      showShell: () => { settle() }, showAuth: () => { settle() }, $: () => null, signinKnown: () => null, setStatus() {},
    }
    // eslint-disable-next-line no-new-func
    const boot = new Function('deps', `with (deps) {\n${BOOT}\nreturn boot;\n}`)(deps) as () => void
    boot()
    return done.then(() => FIRST_PAINT)
  }
  it('boot records when it started (every script had run) and the sign-in round trip, answered or failed', async () => {
    expect(await run('ok', [301.6, 301.6, 372.4])).toMatchObject({ boot: 302, rtt: 71 })
    expect(await run('fail', [290, 290, 500])).toMatchObject({ boot: 290, rtt: 210 })
  })
  it('firstPaintDone reports them with the browser’s DOMContentLoaded; -1 when unknown', () => {
    const SRC = slice(APP, '  var FIRST_PAINT = { done: false };', '  function showAuth(message) {')
    const crumbs: Array<Record<string, unknown>> = []
    const deps = {
      document: { documentElement: { classList: { remove() {} } } },
      window: { performance: { now: () => 640.2, getEntriesByName: () => [{ startTime: 180.4 }], getEntriesByType: (t: string) => t === 'navigation' ? [{ domContentLoadedEventStart: 175.6 }] : [] } },
      layoutCrumb: (_w: string, extra: Record<string, unknown>) => { crumbs.push(extra); return true },
    }
    // eslint-disable-next-line no-new-func
    const fp = new Function('deps', `with (deps) {\n${SRC}\nFIRST_PAINT.boot = 452; FIRST_PAINT.rtt = 70;\nreturn firstPaintDone;\n}`)(deps) as (v: string) => boolean
    fp('shell')
    expect(crumbs).toEqual([{ fcp: 180, shown: 640, via: 'shell', dcl: 176, boot: 452, rtt: 70 }])
  })
})

describe('the device and focus reports: our overflow or a setting, and what sticks out (Q1 15:20)', () => {
  const SRC = slice(APP, "  var LR_WIDE = { key: '', out: null };", '  function lrDevice() {')
  type Node = { tag: string; id?: string; cls?: string; right: number; kids?: Node[] }
  // A page as the browser lays it out: html > body > div#app-shell > main > ..., each with its right edge.
  function page(o: { cw: number; scw: number; dw: number; tree: Node }) {
    const flat: any[] = []
    const make = (n: Node, parent: any) => {
      const el: any = { tagName: n.tag.toUpperCase(), id: n.id ?? '', className: n.cls ?? '', parentElement: parent, getBoundingClientRect: () => ({ right: n.right, width: 10 }) }
      flat.push(el); (n.kids ?? []).forEach(k => make(k, el))
    }
    const body: any = { getBoundingClientRect: () => ({ right: o.cw, width: o.cw }) }
    make(o.tree, body)
    let scans = 0
    body.getElementsByTagName = () => { scans++; return flat }
    const deps = {
      document: { documentElement: { clientWidth: o.cw }, scrollingElement: { scrollWidth: o.scw }, body },
      window: { visualViewport: { width: o.dw, scale: 1 }, innerWidth: o.dw, scrollX: 0 },
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('deps', `with (deps) {\n${SRC}\nreturn lrWide;\n}`)(deps) as () => Record<string, unknown>
    return { fn, scans: () => scans }
  }
  const shell = (w: number, inner: Node[]): Node => ({ tag: 'div', id: 'app-shell', right: w, kids: [{ tag: 'main', cls: 'workspace', right: w, kids: inner }] })
  it('our overflow: the layout stays at the device width, a table is wider; the table is named, never its stretched containers', () => {
    const h = page({ cw: 382, scw: 449, dw: 382, tree: shell(382, [{ tag: 'section', right: 382 }, { tag: 'table', cls: 'wk-grid big', right: 449, kids: [{ tag: 'td', right: 449 }] }]) })
    expect(h.fn()).toEqual({ cw: 382, dw: 382, scw: 449, wide: 'table.wk-grid' })
  })
  it('a setting: the layout viewport itself is 449 and every container stretches to it; nothing named, nothing scanned', () => {
    const h = page({ cw: 449, scw: 449, dw: 382, tree: shell(449, [{ tag: 'section', right: 449 }, { tag: 'table', cls: 'wk-grid', right: 449 }]) })
    expect(h.fn()).toEqual({ cw: 449, dw: 382, scw: 449, wide: '' })
    expect(h.scans()).toBe(0)
  })
  it('the page fits: nothing named, nothing scanned', () => {
    const h = page({ cw: 382, scw: 382, dw: 382, tree: shell(382, [{ tag: 'table', right: 382 }]) })
    expect(h.fn().wide).toBe('')
    expect(h.scans()).toBe(0)
  })
  it('one scan per layout: a second report with the same widths reuses the answer', () => {
    const h = page({ cw: 382, scw: 449, dw: 382, tree: shell(382, [{ tag: 'pre', id: 'log', right: 449 }]) })
    expect(h.fn().wide).toBe('pre#log'); expect(h.fn().wide).toBe('pre#log')
    expect(h.scans()).toBe(1)
  })
  it('an id wins over a class; the label is at most 24 characters; no width is ever undefined', () => {
    const h = page({ cw: 382, scw: 449, dw: 382, tree: shell(382, [{ tag: 'section', id: 'a-very-long-identifier-name-here', cls: 'c', right: 449 }]) })
    expect(h.fn().wide).toBe('section#a-very-long-iden')
    // eslint-disable-next-line no-new-func
    const bare = new Function('deps', `with (deps) {\n${SRC}\nreturn lrWide;\n}`)({ document: { documentElement: {}, scrollingElement: {}, body: null }, window: {} }) as () => Record<string, unknown>
    expect(Object.values(bare()).every(v => v === null || typeof v === 'string' || typeof v === 'number')).toBe(true)
  })
  it('both reports carry the numbers; a focus past its budget never scans', () => {
    expect(APP).toContain('phone: isPhone(), cw: w.cw, dw: w.dw, scw: w.scw, wide: w.wide });')
    expect(APP).toContain("n: ++LR.focusN, cw: w.cw, dw: w.dw, wide: w.wide });")
    expect(APP).toContain("var w = typeof crumbs === 'object' && crumbs && crumbs.focus >= LAYOUT_FOCUS_MAX ? { cw: null, dw: null, wide: '' } : lrWide();")
  })
})
