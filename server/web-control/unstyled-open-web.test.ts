/**
 * 7.0.28 (Miles 19:28, the Home Screen web app): "Connect this browser" with NO styling, the COS mark drawn twice at full
 * size, when the phone opened the page before it could reach the Mac. The HTML drew; the 10 stylesheets (and at times
 * app.js) failed, and nothing asked for them again. These pin the three parts of the fix: index.html's inline critical
 * CSS (copies of app.css, so it can never disagree with it), a size on every mark, and theme.js's restyle check, run here
 * against fakes. The layout itself is checked in WebKit with the files really blocked and then unblocked:
 * W1_evidence/two_column/unstyled_check.cjs (64c45ed fails 88 of 120; the fix passes 120).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const APP_CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

const crit = (() => { const m = HTML.match(/<style id="critical-css">([\s\S]*?)<\/style>/); expect(m, 'index.html has the critical style').toBeTruthy(); return m![1]! })()
const critLines = crit.split('\n').map(l => l.trim()).filter(Boolean)
const tokenBlock = (css: string, sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThan(-1); return css.slice(i, css.indexOf('}', i)) }
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(m => [m[1], norm(m[2]!)]))

describe('the inline critical CSS (index.html)', () => {
  it('comes before the first external stylesheet, and the page has no inline script (the CSP allows none)', () => {
    expect(HTML.indexOf('<style id="critical-css">')).toBeLessThan(HTML.indexOf('<link rel="stylesheet"'))
    expect(HTML).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/)
  })
  it('every rule is a word-for-word copy of app.css, so the stylesheets change nothing when they arrive', () => {
    const rules = critLines.filter(l => !l.startsWith(':root') && !l.startsWith('@media (prefers-color-scheme'))
    expect(rules.length).toBeGreaterThan(20)
    const app = norm(APP_CSS)
    const missing = rules.filter(r => !app.includes(norm(r)))
    expect(missing).toEqual([])
  })
  it('its tokens are app.css values, light and dark, and the dark set also follows the system before theme.js runs', () => {
    const light = tokens(critLines.find(l => l.startsWith(':root {'))!), dark = tokens(critLines.find(l => l.startsWith(":root[data-theme='dark'] {"))!)
    const appLight = tokens(tokenBlock(APP_CSS, ':root')), appDark = tokens(tokenBlock(APP_CSS, ":root[data-theme='dark']"))
    expect(Object.keys(light).length).toBeGreaterThan(10)
    for (const [k, v] of Object.entries(light)) expect(v, k).toBe(appLight[k])
    for (const [k, v] of Object.entries(dark)) expect(v, k).toBe(appDark[k])
    const sys = critLines.find(l => l.startsWith('@media (prefers-color-scheme: dark) { :root:not([data-theme]) {'))!
    expect(tokens(sys)).toEqual(dark)
  })
  it('hides what is hidden, and draws the first paint and the card', () => {
    expect(crit).toContain('.hidden { display: none !important; }')
    for (const sel of ['.first-paint { display: none; }', '.auth-gate {', '.auth-card .mark {', '.btn.primary {', '.field {']) expect(crit, sel).toContain(sel)
  })
  it('every COS mark has a width and a height, so none is ever drawn at the browser default size', () => {
    const marks = [...HTML.matchAll(/<svg class="mark"[^>]*>/g)].map(m => m[0])
    expect(marks.length).toBeGreaterThanOrEqual(4)
    expect(marks.filter(m => !/\swidth="\d+"/.test(m) || !/\sheight="\d+"/.test(m))).toEqual([])
  })
})

// theme.js's second part, the restyle check, run against fakes.
const RESTYLE = (() => { const a = THEME.indexOf('/* 7.0.28 (Miles 19:28'); expect(a).toBeGreaterThan(-1); return THEME.slice(THEME.indexOf('(function () {', a)) })()
function kit(o: { sheets?: Array<'ok' | 'empty' | 'throws' | 'none'>; store?: Record<string, string>; fetchOk?: () => boolean } = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [], fetched: string[] = [], inserted: string[] = []
  let reloads = 0
  const store: Record<string, string> = { ...(o.store || {}) }
  const links = (o.sheets || ['ok']).map((k, i) => ({
    href: '/control/s' + i + '.css', getAttribute: () => '/control/s' + i + '.css',
    get sheet() { if (k === 'none') return null; return { get cssRules() { if (k === 'throws') throw new Error('SecurityError'); return { length: k === 'empty' ? 0 : 3 } } } },
    parentNode: { insertBefore: (el: any) => inserted.push(el.href), removeChild: () => {} }, nextSibling: null,
  }))
  const listeners: Record<string, () => void> = {}
  const document = { hidden: false, readyState: 'complete', querySelectorAll: () => links, createElement: () => ({}), addEventListener: (t: string, f: () => void) => { listeners[t] = f } }
  const window: any = { fetch: (u: string) => { fetched.push(u); return (o.fetchOk ? o.fetchOk() : true) ? Promise.resolve({ ok: true }) : Promise.reject(new Error('down')) }, addEventListener: () => {}, dispatchEvent: () => {} }
  const deps = {
    window, document, location: { reload: () => { reloads++ } },
    sessionStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }, CustomEvent: class { constructor(public type: string, public init: any) {} },
    Date, JSON, Promise,
  }
  // eslint-disable-next-line no-new-func
  new Function('deps', `with (deps) {\n${RESTYLE}\n}`)(deps)
  return { timers, fetched, inserted, store, get reloads() { return reloads }, R: window.CosRestyle, listeners }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe("theme.js's restyle check (7.0.28)", () => {
  it('does nothing when every stylesheet loaded', () => {
    const k = kit({ sheets: ['ok', 'ok'] })
    expect(k.timers).toHaveLength(0)
  })
  it('a sheet that failed counts as missing, including one whose rules throw on read (WebKit)', () => {
    for (const kind of ['none', 'empty', 'throws'] as const) expect(kit({ sheets: ['ok', kind] }).timers, kind).toHaveLength(1)
  })
  it('checks after 1, 2, 4 and 8 s, then every 30 s, asking for the failed file itself', async () => {
    const k = kit({ sheets: ['throws'], fetchOk: () => false })
    for (let i = 0; i < 6; i++) { k.timers[i]!.fn(); await flush() }
    expect(k.timers.map(t => t.ms)).toEqual([1000, 2000, 4000, 8000, 30000, 30000, 30000])
    expect(k.fetched.every(u => u.startsWith('/control/s0.css?r='))).toBe(true)
  })
  it('when the Mac answers, failed stylesheets are asked for again in place (fresh query), and the check stops', async () => {
    const k = kit({ sheets: ['ok', 'throws'] })
    k.timers[0]!.fn(); await flush()
    expect(k.inserted).toHaveLength(1)
    expect(k.inserted[0]).toMatch(/^\/control\/s1\.css\?r=\d+$/)
    expect(k.R.last.how).toBe('sheets')
    expect(k.timers).toHaveLength(1)
  })
  it('a failed script reloads the page once the Mac answers, and the reloaded page asks for its scripts afresh', async () => {
    const k = kit({ sheets: ['ok'] })
    k.R.scriptFailed('/control/app.js')
    k.timers[0]!.fn(); await flush()
    expect(k.fetched[0]).toMatch(/^\/control\/app\.js\?r=\d+$/)
    expect(k.reloads).toBe(1)
    expect(k.store.cos_web_bust).toMatch(/^\d+$/)
    expect(JSON.parse(k.store.cos_web_restyle!).how).toBe('reload')
  })
  it('never a reload loop: at most 2 reloads in 5 minutes, then it gives up', async () => {
    const now = Date.now()
    const k = kit({ sheets: ['ok'], store: { cos_web_restyle_reloads: JSON.stringify([now - 1000, now - 2000]) } })
    k.R.scriptFailed('/control/app.js')
    k.timers[0]!.fn(); await flush()
    expect(k.reloads).toBe(0)
    expect(k.R.last.how).toBe('gave-up')
  })
  it('the loader reads the fresh-query flag once and applies it to every boot script', () => {
    expect(THEME).toContain("bust = sessionStorage.getItem('cos_web_bust') || ''; sessionStorage.removeItem('cos_web_bust');")
    expect(THEME).toMatch(/el\.src = \/\^\\d\{1,15\}\$\/\.test\(bust\) \? src \+ \(src\.indexOf\('\?'\) >= 0 \? '&' : '\?'\) \+ 'r=' \+ bust : src;/)
    expect(THEME).toContain("el.onerror = function () { if (window.CosRestyle) window.CosRestyle.scriptFailed(src);")
  })
})
