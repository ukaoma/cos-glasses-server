/**
 * F1 (Miles 2026-11-14 07:14, the open Duo): "our setting rail when opened [has] the same scrolling beyond the container
 * height issue". His rows: the keyboard closed on Today at 13:07:41Z and the visual viewport read height 0 until at least
 * 13:09:00Z (Safari's stranded view). Settings scrolls the page and the rail was sticky to the layout viewport, which that
 * view had left: the rail ended mid-screen, its last items at the top, the pets running on below.
 * Settings now gets the message reader's frame (html.pg-frame) from 600 px on touch: the page is one screen, the shell
 * is the visible box, the rail a static column, Settings scrolls in the workspace.
 * The layout proof is the WebKit sweep's long-pane pass (F1_evidence/sweep.cjs LONG=1, check rail-long). What neither can
 * prove: that a one-screen page clears Safari's stranded view. The reader and Sessions frames are the evidence it does;
 * his phone is the proof.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function mediaBlock(src: string, query: string): string {
  const at = src.indexOf('@media ' + query + ' {'); if (at < 0) return ''
  let i = src.indexOf('{', at), depth = 0; const start = i + 1
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break }
  return src.slice(start, i)
}
function rule(css: string, sel: string): string {
  const m = css.match(new RegExp('(^|[}\\s])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[2] : ''
}

/** The frame's code from app.js (pgFrameOn, pgFrameSync, its row), run against a fake <html>, shell, rail and workspace. */
function frame(hidden = false, bad = false, applies = true) {
  const cls = new Set<string>(), rows: Array<{ what: string; data: any }> = [], hooks: Array<(w: string) => void> = []
  const de = { classList: { toggle: (c: string, on: boolean) => { if (on) cls.add(c); else cls.delete(c) }, contains: (c: string) => cls.has(c) } }
  const box = (t: number, b: number) => ({ getBoundingClientRect: () => ({ top: t, bottom: b }) })
  const shell = { classList: { contains: (c: string) => c === 'hidden' && hidden }, ...box(0, 787) }
  const rail = box(0, 787), scrolled: string[] = []
  const field = { id: 'f', scrollIntoView: (o: any) => scrolled.push(o.block) }, outside = { id: 'o', scrollIntoView: (o: any) => scrolled.push('outside') }
  const ws = { scrollTop: 4200, scrollHeight: 17400, contains: (e: any) => e === field }
  const media: string[] = []
  const win = { COSWeb: { onKeyboard: (fn: (w: string) => void) => hooks.push(fn) }, scrollY: 0, getComputedStyle: () => ({ position: 'static' }),
    matchMedia: (q: string) => { media.push(q); return { matches: applies } } }
  const doc: any = { documentElement: de, body: {}, activeElement: field, scrollingElement: { scrollHeight: 787 }, querySelector: (q: string) => (q === '.rail' ? rail : null) }
  const src = APP.slice(APP.indexOf('  var PG_FRAME_PANES'), APP.indexOf('  var RD_FRAME = { hooked: false, n: 0 };'))
  const make = new Function('document', 'window', 'getComputedStyle', '$', 'parseRoute', 'sideRail', 'viewportFit', 'layoutCrumb', 'requestAnimationFrame',
    src + '\nreturn { pgFrameSync: pgFrameSync, pgFrameOn: pgFrameOn };')
  const api = make(doc, win, win.getComputedStyle, (id: string) => (id === 'app-shell' ? shell : id === 'workspace' ? ws : null), () => ({ pane: 'today', args: [] }), () => false,
    () => ({ bad, top: 0, height: 787 }), (what: string, data: any) => { rows.push({ what, data }); return true }, (fn: () => void) => fn())
  return { cls, rows, hooks, doc, field, outside, scrolled, media, shellNoClass: () => { delete (shell as any).classList }, ...api }
}

describe('Settings frame: the rail stays a column of the visible box', () => {
  it('on for Settings and Today only, off while the sign-in gate shows', () => {
    const f = frame()
    expect(f.pgFrameSync({ pane: 'settings', args: [] })).toBe(true); expect(f.cls.has('pg-frame')).toBe(true)
    expect(f.pgFrameSync({ pane: 'settings', args: ['pet'] })).toBe(true)
    expect(f.pgFrameSync({ pane: 'today', args: [] })).toBe(true)
    for (const pane of ['messages', 'sessions', 'work', 'meetings', 'memories', 'toString', 'constructor']) {
      expect(f.pgFrameSync({ pane, args: [] }), pane).toBe(false); expect(f.cls.has('pg-frame')).toBe(false)
    }
    // a shell with no classList (route harnesses, W1 08:04): no throw, Settings still framed
    const h = frame(); (h as any).shellNoClass()
    expect(() => h.pgFrameSync({ pane: 'settings', args: [] })).not.toThrow(); expect(h.cls.has('pg-frame')).toBe(true)
    const g = frame(true)
    expect(g.pgFrameSync({ pane: 'settings', args: [] })).toBe(false); expect(g.cls.has('pg-frame')).toBe(false)
  })
  it('one numbers-only pg-frame row when the frame comes on and after the keyboard closes; at most 8; none unframed', () => {
    const f = frame(false, true)
    f.pgFrameSync({ pane: 'work', args: [] }); expect(f.rows).toHaveLength(0)
    f.pgFrameSync({ pane: 'settings', args: [] }); f.pgFrameSync({ pane: 'settings', args: ['pet'] })
    expect(f.rows).toHaveLength(1)
    const d = f.rows[0].data
    expect(f.rows[0].what).toBe('pg-frame')
    expect(d).toMatchObject({ why: 'open', fb: true, framed: true, railT: 0, railB: 787, shellT: 0, shellB: 787, docH: 787, pageY: 0, wsY: 4200, wsH: 17400, boxT: 0, boxB: 787 })
    for (const v of Object.values(d)) expect(['number', 'boolean', 'string']).toContain(typeof v)
    expect(f.hooks).toHaveLength(1)
    f.hooks[0]('open'); expect(f.rows).toHaveLength(1)
    for (let i = 0; i < 12; i++) f.hooks[0]('after')
    expect(f.rows).toHaveLength(8)
    expect(f.rows[1].data.why).toBe('kb-after')
  })
  it('keyboard up in the framed pane: the focused field comes into the workspace view, nearest; nothing otherwise', () => {
    const f = frame()
    f.pgFrameSync({ pane: 'settings', args: [] })
    f.hooks[0]('open'); expect(f.scrolled).toEqual(['nearest'])
    f.hooks[0]('move'); expect(f.scrolled).toEqual(['nearest', 'nearest'])
    f.hooks[0]('close'); f.hooks[0]('after'); expect(f.scrolled).toHaveLength(2)
    f.doc.activeElement = f.outside; f.hooks[0]('open'); expect(f.scrolled).toHaveLength(2)   // a field outside the workspace
    f.doc.activeElement = f.doc.body; f.hooks[0]('open'); expect(f.scrolled).toHaveLength(2)  // nothing focused
    f.doc.activeElement = f.field; f.pgFrameSync({ pane: 'work', args: [] }); f.hooks[0]('open')
    expect(f.scrolled).toHaveLength(2)                                                          // not framed: Safari's own pan
  })
  it('on a tall phone under 600 px or with a mouse (the CSS frame does not apply), a keyboard opening in Settings scrolls nothing', () => {
    const f = frame(false, false, false)
    f.pgFrameSync({ pane: 'settings', args: [] }); expect(f.cls.has('pg-frame')).toBe(false)
    // No frame, hence no keyboard hook. A wide-touch or folded-Duo frame owns its own hook.
    f.hooks.forEach(fn => { fn('open'); fn('move') })
    expect(f.scrolled).toHaveLength(0)
    expect(f.media).toContain('(min-width: 600px) and (pointer: coarse)')
    // the query is the CSS block's own
    expect(CSS).toContain('@media (min-width: 600px) and (pointer: coarse) {\n  html.pg-frame,')
  })
  it('the route runs it beside the other frames; the sign-in gate takes the class off', () => {
    expect(APP).toContain("if (typeof rdFrameSync === 'function') rdFrameSync(r);\n    if (typeof pgFrameSync === 'function') pgFrameSync(r);")
    const gate = APP.slice(APP.indexOf("document.documentElement.classList.remove('sx-frame');"), APP.indexOf('// A later 401'))
    expect(gate).toContain("document.documentElement.classList.remove('pg-frame');")
  })
  it('a new pane starts at the workspace top when framed (the page itself cannot scroll then)', () => {
    expect(APP).toMatch(/if \(changedPane\) \{ window\.scrollTo\(0, 0\); var wsTop = \$\('workspace'\), deTop = document\.documentElement; if \(wsTop && deTop && deTop\.classList && deTop\.classList\.contains\('pg-frame'\)\) wsTop\.scrollTop = 0; \}/)
  })
  it('the CSS: from 600 px on touch, one-screen page, the shell is the visible box, a static rail, the workspace scrolls', () => {
    const b = mediaBlock(CSS, '(min-width: 600px) and (pointer: coarse)')
    expect(b).toContain('html.pg-frame')
    expect(rule(b, 'html.pg-frame, html.pg-frame body')).toMatch(/overflow:\s*hidden/)
    const shell = rule(b, 'html.pg-frame .app-shell')
    expect(shell).toMatch(/position:\s*fixed/)
    expect(shell).toMatch(/top:\s*var\(--vv-top, 0px\)/)
    expect(shell).toMatch(/height:\s*var\(--vv-h, 100dvh\)/)
    const rail = rule(b, 'html.pg-frame .rail')
    expect(rail).toMatch(/position:\s*static/)
    expect(rail).toMatch(/height:\s*auto/)
    expect(rail).toMatch(/overflow-y:\s*auto/)
    expect(rule(b, 'html.pg-frame .workspace')).toMatch(/overflow-y:\s*auto/)
    // a sticky bar in the scroller (the question card's footer) pins to its padding edge: no bottom padding, a spacer instead
    expect(rule(b, 'html.pg-frame .workspace')).toMatch(/padding-bottom:\s*0/)
    expect(rule(b, 'html.pg-frame .workspace::after')).toMatch(/height:\s*calc\(var\(--safe-bottom\) \+ 40px\)/)
    expect(rule(b, 'html.pg-frame .workspace::after')).toMatch(/display:\s*block/)
    expect(rule(b, 'html.pg-frame .main-col')).toMatch(/overflow:\s*hidden/)
  })
  it('the folded block is short-screen only, touch only, and follows the old sticky rail', () => {
    const at = CSS.indexOf('html.short-screen.pg-frame, html.short-screen.pg-frame body')
    expect(at).toBeGreaterThan(CSS.indexOf('html.short-screen .section-btn { cursor: default; }'))
    const folded = CSS.slice(at)
    expect(folded).toMatch(/html\.short-screen\.pg-frame \.app-shell \{[^}]*align-items:\s*stretch/)
    expect(folded).toMatch(/html\.short-screen\.pg-frame \.rail \{[^}]*position:\s*static;[^}]*height:\s*auto/)
    expect(folded).toMatch(/html\.short-screen\.pg-frame \.workspace \{[^}]*overflow-y:\s*auto/)
  })
})
