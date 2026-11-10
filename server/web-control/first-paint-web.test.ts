/**
 * 7.0.19 (Miles 2026-11-10 12:07, "Let's build that for the next publish for today. Ensure no regressions."): the first
 * open showed a blank page until the Mac answered the sign-in check. Now the COS mark shows on the page's own background
 * at once, and goes the moment the sign-in card or the app shows. These run theme.js and app.js's own text against fakes
 * and pin the HTML and CSS it depends on. They cannot see paint timing on the phone: the 'open-time' layout report does.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const THEME = readFileSync(join(HERE, 'theme.js'), 'utf8')
function slice(text: string, startMark: string, endMark: string): string {
  const a = text.indexOf(startMark), b = text.indexOf(endMark, a + startMark.length)
  expect(a, startMark).toBeGreaterThan(-1)
  expect(b, endMark).toBeGreaterThan(a)
  return text.slice(a, b)
}

describe('theme.js: the theme first, then the gate that lets the first paint show', () => {
  function run(stored: string | null, dark: boolean) {
    const order: string[] = []
    const root = { setAttribute: (n: string, v: string) => order.push(`${n}=${v}`), classList: { add: (c: string) => order.push(`class+${c}`) } }
    const window = { matchMedia: () => ({ matches: dark, addEventListener() {} }) }
    const localStorage = { getItem: () => stored }
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'localStorage', THEME)(window, { documentElement: root }, localStorage)
    return order
  }
  it('sets data-theme, then adds fp-wait, in that order, for system, light and dark', () => {
    expect(run(null, true)).toEqual(['data-theme=dark', 'class+fp-wait'])
    expect(run('light', true)).toEqual(['data-theme=light', 'class+fp-wait'])
    expect(run('dark', false)).toEqual(['data-theme=dark', 'class+fp-wait'])
  })
  it('theme.js stays the first script, in the head, before the body: no frame in the wrong theme', () => {
    const head = HTML.slice(0, HTML.indexOf('</head>'))
    expect(head).toContain('<script src="/control/theme.js"></script>')
    expect(HTML.indexOf('<script src="/control/theme.js">')).toBeLessThan(HTML.indexOf('<script src=', HTML.indexOf('<script src="/control/theme.js">') + 10))
  })
})

describe('index.html: the first paint is inline, asks for nothing, and reads with JavaScript off', () => {
  const block = slice(HTML, '<div id="first-paint"', '</div>')
  it('the mark from the page’s own sprite, hidden from screen readers, before the sign-in card and the app', () => {
    expect(block).toBe('<div id="first-paint" class="first-paint" aria-hidden="true"><svg class="mark"><use href="#i-mark"/></svg>')
    expect(HTML.indexOf('<symbol id="i-mark"')).toBeLessThan(HTML.indexOf('id="first-paint"'))
    expect(HTML.indexOf('id="first-paint"')).toBeLessThan(HTML.indexOf('id="auth-gate"'))
    expect(HTML.indexOf('id="first-paint"')).toBeLessThan(HTML.indexOf('id="app-shell"'))
  })
  it('no new request: no img, link, url or src in it, and no inline script anywhere (CSP script-src self)', () => {
    expect(block).not.toMatch(/<img|<link|url\(|src=/)
    const inline = [...HTML.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map(m => m[1])
    expect(inline.every(attrs => /type="application\/json"/.test(attrs)), String(inline)).toBe(true)
  })
  it('with JavaScript off, one plain line says what to do', () => {
    expect(HTML).toContain('<noscript><p class="noscript-note">COS Control Web needs JavaScript. Turn it on for this site, then reload.</p></noscript>')
  })
})

describe('app.css: out of the layout, the page’s own colours, and a failsafe longer than the sign-in check', () => {
  const rule = slice(CSS, 'html.fp-wait .first-paint {', '}')
  it('hidden unless theme.js ran (so never with JavaScript off)', () => {
    expect(CSS).toContain('\n.first-paint { display: none; }\n')
  })
  it('fixed and full screen, so nothing shifts when it goes; never takes a tap', () => {
    expect(rule).toContain('position: fixed; inset: 0;')
    expect(rule).toContain('pointer-events: none;')
    expect(rule).toContain('background: var(--page); color: var(--ink);')
  })
  it('the failsafe hides it after 25 s, longer than the 20 s sign-in check, so only a page whose scripts never ran needs it', () => {
    expect(rule).toContain('animation: fp-failsafe 1ms linear 25s forwards;')
    expect(CSS).toContain('@keyframes fp-failsafe { to { visibility: hidden; } }')
    const read = Number(/var API_READ_TIMEOUT_MS = (\d+);/.exec(APP)![1])
    expect(25000).toBeGreaterThan(read)
  })
  it('the reduced-motion rule shortens durations only, so the failsafe delay still runs', () => {
    const rm = slice(CSS, '@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {', '}')
    expect(rm).not.toMatch(/animation:\s*none|animation-delay|animation-name/)
  })
  it('the no-JavaScript line is 17 px (the 16 px floor holds)', () => {
    expect(slice(CSS, '.noscript-note {', '}')).toContain('font-size: 17px;')
  })
})

describe('app.js: the first paint ends once, when the sign-in card or the app shows, with one timing report', () => {
  const SRC = slice(APP, '  var FIRST_PAINT = { done: false };', '  function showAuth(message) {')
  function run(opts: { fcp?: number | null; now?: number; crumbThrows?: boolean } = {}) {
    const removed: string[] = [], crumbs: Array<{ what: string; extra: Record<string, unknown> }> = []
    const deps = {
      document: { documentElement: { classList: { remove: (c: string) => removed.push(c) } } },
      window: { performance: { now: () => opts.now ?? 412.6, getEntriesByName: (n: string) => (n === 'first-contentful-paint' && opts.fcp != null ? [{ startTime: opts.fcp }] : []) } },
      layoutCrumb: (what: string, extra: Record<string, unknown>) => { if (opts.crumbThrows) throw new Error('x'); crumbs.push({ what, extra }); return true },
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('deps', `with (deps) {\n${SRC}\nreturn firstPaintDone;\n}`)(deps) as (via: string) => boolean
    return { fn, removed, crumbs }
  }
  it('removes fp-wait and sends one report: first contentful paint, the moment it showed, and which one showed', () => {
    const h = run({ fcp: 161.4, now: 351.7 })
    expect(h.fn('shell')).toBe(true)
    expect(h.removed).toEqual(['fp-wait'])
    expect(h.crumbs).toEqual([{ what: 'open-time', extra: { fcp: 161, shown: 352, via: 'shell' } }])
  })
  it('once: a later sign-in card (a lapsed sign-in) changes nothing and reports nothing', () => {
    const h = run({ fcp: 100 })
    h.fn('auth'); expect(h.fn('auth')).toBe(false); h.fn('shell')
    expect(h.removed).toEqual(['fp-wait'])
    expect(h.crumbs).toHaveLength(1)
  })
  it('no paint recorded yet reads -1, and a failing report never stops the page', () => {
    const none = run({ fcp: null }); none.fn('shell')
    expect(none.crumbs[0]!.extra.fcp).toBe(-1)
    const h = run({ crumbThrows: true })
    expect(() => h.fn('auth')).not.toThrow()
    expect(h.removed).toEqual(['fp-wait'])
  })
  it('the report fits the layout report’s rules: short keys, numbers and a short string', () => {
    for (const k of ['fcp', 'shown', 'via']) expect(k).toMatch(/^[a-z][a-zA-Z0-9]{0,15}$/)
    expect(APP).toContain("layoutCrumb('open-time', { fcp: fcp ? Math.round(fcp.startTime) : -1, shown: shown, via: via });")
  })
})

describe('every way the wait ends takes the first paint away', () => {
  it('showAuth and showShell end it first thing', () => {
    expect(APP).toContain("  function showAuth(message) {\n    if (typeof firstPaintDone === 'function') firstPaintDone('auth');")
    expect(APP).toContain("  function showShell(info) {\n    if (typeof firstPaintDone === 'function') firstPaintDone('shell');")
  })
  it('only those two can show the sign-in card or the app, so boot, a code, a handoff, a refused link and "not answering" all pass through them', () => {
    expect(APP.split("$('auth-gate').classList.remove('hidden')").length - 1).toBe(1)
    expect(APP.split("$('app-shell').classList.remove('hidden')").length - 1).toBe(1)
    expect(slice(APP, '  function showAuth(message) {', '  function showShell(info) {')).toContain("$('auth-gate').classList.remove('hidden')")
    expect(slice(APP, '  function showShell(info) {', '\n  }\n')).toContain("$('app-shell').classList.remove('hidden')")
    const boot = slice(APP, '  function boot() {', "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);")
    for (const exit of ['.then(showShell)', 'showAuth(UNREACHABLE_COPY)', 'return linkFailed(', 'return showShell(st)', 'showAuth(err.message)', 'showAuth(); authOffline(true)']) expect(boot, exit).toContain(exit)
  })
})
