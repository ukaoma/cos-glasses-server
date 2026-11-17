/**
 * 7.0.35, the blank open from the Home Screen (Miles 21:20: "a blank screen. The server never ends up loading";
 * W1_blank_open_scope.md). These run theme.js and app.js's own text against fakes. The browser proof, with a server that
 * holds back or stalls a named file, is W1_evidence/7035_blank_open/blank_open_check.cjs.
 *  A  opens that never finish are counted (cos_open_try / cos_open_lost) and reported once (open-lost).
 *  B  the stylesheets no longer hold the first paint; boot waits for them as well as the scripts.
 *  C  a deadline: past it the slow-load card; a script-free line when theme.js never ran. Only a tap reloads.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const STYLES = JSON.parse(/<script type="application\/json" id="boot-styles">([^<]*)<\/script>/.exec(HTML)![1]!) as string[]
const SCRIPTS = JSON.parse(/<script type="application\/json" id="boot-scripts">([^<]*)<\/script>/.exec(HTML)![1]!) as string[]

function el(tag: string): any {
  const n: any = { tagName: tag.toUpperCase(), children: [] as any[], style: {} as any, attrs: {} as Record<string, string>, listeners: {} as Record<string, Array<() => void>>, parentNode: null as any, textContent: '' }
  n.setAttribute = (k: string, v: string) => { n.attrs[k] = v; if (k === 'id') n.id = v }
  n.appendChild = (c: any) => { c.parentNode = n; n.children.push(c); return c }
  n.removeChild = (c: any) => { n.children = n.children.filter((x: any) => x !== c); c.parentNode = null }
  n.addEventListener = (ev: string, fn: () => void) => { (n.listeners[ev] ??= []).push(fn) }
  return n
}
function boot(opts: { store?: Record<string, string>; readyState?: string; source?: string; amberHref?: string } = {}) {
  const store: Record<string, string> = { ...(opts.store || {}) }
  const localStorage = { getItem: (k: string) => (k in store ? store[k]! : null), setItem: (k: string, v: string) => { store[k] = String(v) }, removeItem: (k: string) => { delete store[k] } }
  const listeners: Record<string, Array<() => void>> = {}, timers: Array<{ fn: () => void; ms: number; id: number }> = []
  const head = el('head'), body = el('body'), classes: string[] = [], attrs: Record<string, string> = {}
  const byId = (id: string): any => {
    if (id === 'amber-style') return { textContent: JSON.stringify(opts.amberHref ?? JSON.parse(/id="amber-style">([^<]*)<\/script>/.exec(HTML)![1]!)) }
    if (id === 'boot-styles') return { textContent: JSON.stringify(STYLES) }
    if (id === 'boot-scripts') return { textContent: JSON.stringify(SCRIPTS) }
    const find = (n: any): any => n.id === id ? n : n.children.map(find).find(Boolean)
    return find(body) || null
  }
  const document: any = {
    readyState: opts.readyState ?? 'loading', head, body,
    documentElement: { setAttribute(k: string, v: string) { attrs[k] = v }, getAttribute(k: string) { return attrs[k] ?? null }, hasAttribute(k: string) { return Object.hasOwn(attrs, k) }, removeAttribute(k: string) { delete attrs[k] }, classList: { add: (c: string) => classes.push(c), remove() {} } },
    addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn) },
    getElementById: byId, createElement: (t: string) => el(t), querySelectorAll: () => [],
  }
  let reloads = 0, tid = 0; const replaced: string[] = []
  const window: any = { matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame: () => {}, addEventListener() {} }
  const location: any = { href: 'http://mac.ts.net:3141/control/?code=AB12CD34#/today', search: '?code=AB12CD34', reload: () => { reloads++ }, replace: (u: string) => { replaced.push(u) } }
  const setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms, id: ++tid }); return tid }
  const clearTimeout = (id: number) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'sessionStorage', 'setTimeout', 'clearTimeout', 'location', 'history', 'URL', opts.source ?? THEME)(window, document, localStorage, localStorage, setTimeout, clearTimeout, location, undefined, URL)
  const sheets = () => head.children.filter((c: any) => c.rel === 'stylesheet')
  const scripts = () => body.children.filter((c: any) => c.tagName === 'SCRIPT')
  const loadScripts = () => { (listeners.DOMContentLoaded ?? []).forEach(f => f()); for (const t of timers.filter(t => t.ms <= 50).slice()) { clearTimeout(t.id); t.fn() } ; for (const t of timers.filter(t => t.ms === 0).slice()) { clearTimeout(t.id); t.fn() } }
  const fire = (ms: number) => { const t = timers.find(x => x.ms === ms); if (t) { clearTimeout(t.id); t.fn() } return !!t }
  const card = () => byId('cos-slow-card')
  return { window, store, classes, sheets, scripts, loadScripts, fire, card, timers, reloads: () => reloads + replaced.length, replaced, booted: () => { let ran = false; window.CosBoot.after(() => { ran = true }); return ran } }
}

describe('B: the stylesheets do not hold the first paint, and boot waits for them', () => {
  it('index.html: the list is quoted and absolute (the server stamps each ?v=), before theme.js; the noscript copy is the same list', () => {
    expect(STYLES).toHaveLength(10)
    expect(STYLES.every(s => s.startsWith('/control/') && s.endsWith('.css'))).toBe(true)
    expect(HTML.indexOf('id="boot-styles"')).toBeLessThan(HTML.indexOf('<script src="/control/theme.js"></script>'))
    const nos = /<noscript>([\s\S]*?)<\/noscript>/.exec(HTML.slice(0, HTML.indexOf('</head>')))![1]!
    expect([...nos.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1])).toEqual(STYLES)
    expect(HTML.slice(0, HTML.indexOf('<noscript>')), 'no stylesheet link left in the head outside noscript').not.toMatch(/<link rel="stylesheet"/)
  })
  it('theme.js adds them at once, in order, as print (never render-blocking); each turns on when it arrives', () => {
    const b = boot()
    expect(b.sheets().map((s: any) => s.href)).toEqual(STYLES)
    expect(b.sheets().every((s: any) => s.media === 'print')).toBe(true)
    b.sheets()[0].onload()
    expect(b.sheets()[0].media).toBe('all')
    b.sheets()[1].onerror()
    expect(b.sheets()[1].media, 'a failed one stays off; the restyle check asks for it again').toBe('print')
  })
  it('boot waits for the scripts AND the stylesheets, a failed one counting as settled', () => {
    const b = boot()
    b.loadScripts(); b.scripts().forEach((s: any) => s.onload())
    expect(b.booted(), 'scripts in, stylesheets not: no boot').toBe(false)
    b.sheets().slice(0, 9).forEach((s: any) => s.onload())
    expect(b.booted()).toBe(false)
    b.sheets()[9].onerror()
    expect(b.booted(), 'every one settled').toBe(true)
  })
  it('the other way round too: stylesheets first, then the last script', () => {
    const b = boot()
    b.sheets().forEach((s: any) => s.onload())
    b.loadScripts(); const sc = b.scripts()
    sc.slice(0, -1).forEach((s: any) => s.onload())
    expect(b.booted()).toBe(false)
    sc[sc.length - 1].onerror()
    expect(b.booted()).toBe(true)
  })
})

describe('Amber alone adds a final stylesheet without changing the default open', () => {
  it('default and invalid preferences keep exactly the original requests; an unconditional-load mutant fails', () => {
    const assertDefault = (source: string) => {
      for (const value of [undefined, 'default', 'Amber', '__proto__']) {
        const b = boot({ source, store: value == null ? {} : { cos_web_look: value } })
        expect(b.sheets().map((s: any) => s.href)).toEqual(STYLES)
      }
    }
    assertDefault(THEME)
    const mutant = THEME.replace("window.CosLook && window.CosLook.choice() === 'amber'", 'true')
    expect(mutant).not.toBe(THEME)
    expect(() => assertDefault(mutant)).toThrow()
  })
  it('amber is appended last, including the server-stamped version, and boot waits for it to settle', () => {
    for (const href of ['/control/amber.css', '/control/amber.css?v=deadbeef']) for (const outcome of ['onload', 'onerror']) {
      const b = boot({ store: { cos_web_look: 'amber' }, amberHref: href })
      const sheets = b.sheets()
      expect(sheets).toHaveLength(STYLES.length + 1)
      expect(sheets.map((s: any) => s.href)).toEqual([...STYLES, href])
      b.loadScripts(); b.scripts().forEach((s: any) => s.onload())
      sheets.slice(0, -1).forEach((s: any) => s.onload())
      expect(b.booted(), 'amber still pending').toBe(false)
      sheets[sheets.length - 1][outcome]()
      expect(b.booted(), 'all sheets settled').toBe(true)
    }
  })
})

describe('C: a deadline, and never an empty page', () => {
  it('the deadline is made of the restyle check\'s steps, not typed: three of its asks', () => {
    const b = boot()
    const L = b.window.CosLoad
    expect(L.DEADLINE_MS).toBe(L.STEPS[0] + L.STEPS[1] + L.STEPS[2])
    expect(b.timers.map(t => t.ms)).toContain(L.DEADLINE_MS)
    expect(THEME).toMatch(/DEADLINE_MS = STEPS\[0\] \+ STEPS\[1\] \+ STEPS\[2\]/)
  })
  it('past the deadline with boot not run: the card under the mark, with Try again; only a tap reloads', () => {
    const b = boot()
    expect(b.fire(b.window.CosLoad.DEADLINE_MS)).toBe(true)
    const card = b.card()
    expect(card, 'the card').toBeTruthy()
    expect(card.attrs.role).toBe('status')
    const btn = card.children.find((c: any) => c.tagName === 'BUTTON')
    expect(btn.textContent).toBe('Try again')
    expect(b.reloads(), 'never by itself').toBe(0)
    btn.listeners.click.forEach((f: () => void) => f())
    expect(b.reloads()).toBe(1)
    // A fresh address (the cache keeps the files already here), the rest of it kept: a sign-in link's code, the hash.
    expect(b.replaced).toHaveLength(1)
    expect(b.replaced[0]).toMatch(/^\/control\/\?code=AB12CD34&r=\d+#\/today$/)
  })
  it('the files then arrive: boot runs, and the card goes when the page shows', () => {
    const b = boot()
    b.fire(b.window.CosLoad.DEADLINE_MS)
    expect(b.card()).toBeTruthy()
    b.sheets().forEach((s: any) => s.onload()); b.loadScripts(); b.scripts().forEach((s: any) => s.onload())
    expect(b.booted()).toBe(true)
    expect(b.card(), 'booted is not shown yet').toBeTruthy()
    b.window.CosLoad.shown()
    expect(b.card(), 'the card is gone').toBeNull()
  })
  it('a page that showed in time never shows the card, and its deadline is cleared', () => {
    const b = boot()
    b.sheets().forEach((s: any) => s.onload()); b.loadScripts(); b.scripts().forEach((s: any) => s.onload())
    expect(b.timers.some(t => t.ms === b.window.CosLoad.DEADLINE_MS), 'booted alone keeps the deadline').toBe(true)
    b.window.CosLoad.shown()
    expect(b.timers.some(t => t.ms === b.window.CosLoad.DEADLINE_MS), 'deadline cleared').toBe(false)
    expect(b.card()).toBeNull()
  })
  it('Q1 22:30: every file FAILS (a refused connection, a 5xx): boot settles at once, and the card still comes at the deadline', () => {
    const b = boot()
    b.sheets().forEach((s: any) => s.onerror()); b.loadScripts(); b.scripts().forEach((s: any) => s.onerror())
    expect(b.booted(), 'settled: failed files count').toBe(true)
    expect(b.fire(b.window.CosLoad.DEADLINE_MS), 'the deadline is still set').toBe(true)
    expect(b.card(), 'the card, not an empty page').toBeTruthy()
  })
  it('theme.js marks the page (cos-js), and index.html\'s script-free line shows after the same deadline unless it did', () => {
    const b = boot()
    expect(b.classes).toContain('cos-js')
    const delay = /html:not\(\.cos-js\) \.fp-lost \{[^}]*animation: fp-lost-show 1ms linear (\d+)s forwards/.exec(HTML)
    expect(delay, 'the delayed line').not.toBeNull()
    expect(Number(delay![1]) * 1000).toBe(b.window.CosLoad.DEADLINE_MS)
    expect(HTML).toMatch(/<div id="fp-lost" class="fp-lost"><p>[^<]+<a href="\/control\/">Try again<\/a><\/p><\/div>/)
    expect(HTML.slice(0, HTML.indexOf('</head>')), 'hidden with JavaScript off').toMatch(/<noscript>[\s\S]*\.fp-lost \{ display: none !important; \}[\s\S]*<\/noscript>/)
  })
})

describe('A: count the opens that never finish', () => {
  it('an open writes its mark; a later open counts the earlier one as lost, with its stage and time', () => {
    const b1 = boot()
    expect(JSON.parse(b1.store.cos_open_try!).stage).toBe('html')
    b1.sheets().forEach((s: any) => s.onload())
    expect(JSON.parse(b1.store.cos_open_try!).stage).toBe('css')
    const t = JSON.parse(b1.store.cos_open_try!).t
    const b2 = boot({ store: b1.store })
    const lost = JSON.parse(b2.store.cos_open_lost!)
    expect(lost).toEqual({ n: 1, t, stage: 'css' })
    const b3 = boot({ store: b2.store })
    expect(JSON.parse(b3.store.cos_open_lost!).n).toBe(2)
  })
  it('stages: js when the scripts settle first, scripts when both have', () => {
    const b = boot()
    b.loadScripts(); b.scripts().forEach((s: any) => s.onload())
    expect(JSON.parse(b.store.cos_open_try!).stage).toBe('js')
    b.sheets().forEach((s: any) => s.onload())
    expect(JSON.parse(b.store.cos_open_try!).stage).toBe('scripts')
  })
  it('CosOpen.done() takes this open\'s mark away and hands back what was counted, once', () => {
    const b1 = boot(), b2 = boot({ store: b1.store })
    const got = b2.window.CosOpen.done()
    expect(got.n).toBe(1)
    expect(b2.store.cos_open_try).toBeUndefined()
    expect(b2.store.cos_open_lost).toBeUndefined()
    expect(b2.window.CosOpen.done()).toBeNull()
  })
  it('app.js firstPaintDone sends one open-lost row, numbers only, when opens were lost', () => {
    const i = APP.indexOf('  var FIRST_PAINT = { done: false };'), j = APP.indexOf('  function showAuth(message) {')
    const rows: Array<[string, any]> = []
    let shownCalls = 0
    const run = (lost: any) => {
      rows.length = 0
      const window: any = { performance: { getEntriesByName: () => [], now: () => 1, getEntriesByType: () => [] }, CosOpen: { done: () => lost }, CosLoad: { shown: () => { shownCalls++ } } }
      // eslint-disable-next-line no-new-func
      new Function('window', 'document', 'layoutCrumb', 'Date', APP.slice(i, j) + '\nfirstPaintDone("app");')(window, { documentElement: { classList: { remove() {} } } }, (w: string, d: any) => rows.push([w, d]), { now: () => 10000 })
      return rows.filter(r => r[0] === 'open-lost').map(r => r[1])
    }
    expect(run({ n: 2, t: 4000, stage: 'css' })).toEqual([{ lost: 2, ago: 6000, stage: 'css' }])
    expect(run(null)).toEqual([])
    expect(run({ n: 0, t: 1, stage: 'html' })).toEqual([])
    // Q1 22:30: each first paint tells theme.js the page showed, so its slow-load card goes and never comes after.
    expect(shownCalls, 'CosLoad.shown once per first paint').toBe(3)
  })
})
