/**
 * 7.0.17 (Miles 2026-11-10 06:17: "a lot of zooming in and out as I'm opening and closing keyboard" in the Control Web
 * app on the Duo; his phone's breadcrumb showed vvs=2.12 with the keyboard down, a double-tap zoom fitting a column).
 * These pin each rule in the source and run the two functions against fakes. They cannot prove the zoom is gone: only
 * the phone can. That check is on Miles's device list.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'app.css'), 'utf8')
const PANE_CSS = readdirSync(join(HERE, 'panes')).filter(f => f.endsWith('.css')).map(f => readFileSync(join(HERE, 'panes', f), 'utf8')).join('\n')
function block(startMark: string, endMark: string): string {
  const a = APP.indexOf(startMark), b = APP.indexOf(endMark, a)
  expect(a, startMark).toBeGreaterThan(0)
  expect(b, endMark).toBeGreaterThan(a)
  return APP.slice(a, b)
}

describe('7.0.17: double-tap zoom is off, and the stricter touch rules are untouched', () => {
  it('the root says touch-action: manipulation (pan and pinch stay, double-tap zoom goes)', () => {
    expect(CSS).toContain('\nhtml { touch-action: manipulation; }')
  })
  it('the splitter keeps touch-action: none and the charts keep pan-y (touch-action narrows down the tree)', () => {
    const all = CSS + '\n' + PANE_CSS
    // none: the Sessions splitter in app.css and sessions.css, the Today sheet's scrim and its ::before; pan-y: the usage
    // chart and the speakers bar. The same counts as d2de7ee.
    expect(all.match(/touch-action: none/g)?.length).toBe(4)
    expect(all.match(/touch-action: pan-y/g)?.length).toBe(2)
    expect(all.match(/touch-action: manipulation/g)?.length, 'only on the root').toBe(1)
  })
  it('the 16 px floor covers an element that types without being a field, inside the touch-screen block', () => {
    const coarse = CSS.slice(CSS.indexOf('@media (any-pointer: coarse) {'), CSS.indexOf('\n}', CSS.indexOf('@media (any-pointer: coarse) {')))
    expect(coarse).toContain("[contenteditable]:not([contenteditable='false']) { font-size: 16px !important; }")
    expect(coarse).toContain('select, textarea { font-size: 16px !important; }')
  })
})

describe('7.0.17: iOS caps the viewport at maximum-scale=1, once, at load', () => {
  // Ends at the next statement that is not the call, so a missing call fails the call-site test by name.
  const SRC = block('  function viewportCap(meta, ua, vv) {', '  window.COSWeb.keyboardUp = ').replace(/\n  try \{ viewportCap\([^\n]*\n/, '\n')
  // eslint-disable-next-line no-new-func
  const cap = new Function(`${SRC}\nreturn viewportCap;`)() as (meta: unknown, ua: { os: string }, vv?: { scale: number }) => boolean
  const meta = (content = 'width=device-width, initial-scale=1, viewport-fit=cover') => ({ content, getAttribute() { return this.content }, setAttribute(_n: string, v: string) { this.content = v } })

  it('iOS: the cap is added to the existing content, nothing else changes', () => {
    const m = meta()
    expect(cap(m, { os: 'ios' }, { scale: 1 })).toBe(true)
    expect(m.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1')
  })
  it('Android, the Mac, Windows: the viewport stays exactly as it is', () => {
    for (const os of ['android', 'mac', 'windows', 'linux', 'other']) {
      const m = meta()
      expect(cap(m, { os }, { scale: 1 }), os).toBe(false)
      expect(m.content, os).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
    }
  })
  it('never while the page is zoomed (a reload mid-zoom): the zoom is never changed under the fingers', () => {
    const m = meta()
    expect(cap(m, { os: 'ios' }, { scale: 2.12 })).toBe(false)
    expect(m.content).not.toContain('maximum-scale')
  })
  it('once: a viewport that already says maximum-scale is left alone', () => {
    const m = meta()
    cap(m, { os: 'ios' }, { scale: 1 })
    expect(cap(m, { os: 'ios' }, { scale: 1 })).toBe(false)
    expect(m.content.match(/maximum-scale/g)?.length).toBe(1)
  })
  it('it runs only at load: one call site, outside every handler', () => {
    expect(APP.split('viewportCap(').length - 1, 'the definition and one call').toBe(2)
    expect(APP).toContain("  try { viewportCap(document.querySelector('meta[name=\"viewport\"]'), uaClass(), window.visualViewport); }")
    expect(block('  function lrApply() {', '  function lrFit() {')).not.toContain('viewportCap')
  })
})

describe('7.0.17: one breadcrumb when the zoom crosses 1.01 either way', () => {
  const SRC = block('  function zoomCrumb(v) {', '  function lrApply() {')
  function run(active: { tagName?: string; textContent?: string } | null = null) {
    const lines: Array<{ what: string; extra: Record<string, unknown> }> = []
    const body = { tagName: 'BODY' }
    const LR = { zoomed: false, touchAt: Date.now() - 300 }
    const deps = { LR, document: { activeElement: active ?? body, body }, lrPane: () => 'sessions',
      layoutCrumb: (what: string, extra: Record<string, unknown>) => { lines.push({ what, extra }); return true } }
    // eslint-disable-next-line no-new-func
    const fn = new Function('deps', `with (deps) {\n${SRC}\nreturn zoomCrumb;\n}`)(deps) as (v: { zoomed: boolean; scale: number }) => boolean
    return { fn, lines, LR }
  }
  it('zoom in, stay zoomed, zoom out: two lines, with the scale, the pane, the tag and the time since the last touch', () => {
    const h = run()
    h.fn({ zoomed: false, scale: 1 })
    h.fn({ zoomed: true, scale: 2.12 })
    h.fn({ zoomed: true, scale: 2.4 })
    h.fn({ zoomed: true, scale: 1.8 })
    h.fn({ zoomed: false, scale: 1 })
    expect(h.lines.map(l => l.what)).toEqual(['zoom-in', 'zoom-out'])
    expect(h.lines[0]!.extra).toMatchObject({ pane: 'sessions', scale: 2.12, tag: 'none' })
    expect(h.lines[0]!.extra.sinceTouch as number).toBeGreaterThanOrEqual(300)
    expect(Object.keys(h.lines[0]!.extra).sort()).toEqual(['pane', 'scale', 'sinceTouch', 'tag'])
  })
  it('a focused field gives its tag only, never its text', () => {
    const h = run({ tagName: 'TEXTAREA', textContent: 'private words' })
    h.fn({ zoomed: true, scale: 1.12 })
    expect(h.lines[0]!.extra.tag).toBe('textarea')
    expect(JSON.stringify(h.lines)).not.toContain('private words')
  })
  it('runs on every viewport change (lrApply), inside layoutCrumb, and reads the zoom without changing it', () => {
    expect(block('  function lrApply() {', '  function lrFit() {')).toContain('    zoomCrumb(v);')
    expect(SRC).toContain("return layoutCrumb(zoomed ? 'zoom-in' : 'zoom-out',")
    expect(SRC).not.toMatch(/setAttribute|\.scale\s*=|scrollTo|style\./)
    expect(APP).toContain("document.addEventListener('touchstart', function () { LR.touchAt = Date.now(); }, { capture: true, passive: true });")
  })
})
