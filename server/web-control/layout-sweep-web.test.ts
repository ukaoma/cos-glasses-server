/**
 * F1, the open Duo's three columns (Miles 11/13 22:14: "the answer and the submit button are lapped over the message
 * content or the question content ... our tests need to incorporate resizing that kind of two column layout, knowing
 * that there's also a side rail"). Two breaks, both reproduced on 7.0.34 in WebKit before any change:
 *  1  After a fold Safari can leave the screen panned with the visual viewport reading a height of 0 (his rows at 22:10:
 *     top 267, then 552). The question card's footer is sticky to the page's viewport, so it drew mid-screen over the
 *     questions. While viewportFit reads `bad`, #sq-host carries sq-vv-lost and the footer is static (questions.css),
 *     and one numbers-only web.layout row (sq-vv-lost) goes out per bad stretch while a card shows.
 *  2  The Messages list header (.cx-hero) bleeds by the workspace gutter (control.css), meant for a pane-wide header;
 *     inside the list column (860 px and up) it drew 40 px past both edges. It ends at the column now (cos-chat.css).
 * questions.js runs here from its own file against fakes. A source test cannot see layout: the layout proof is the
 * WebKit sweep, operations/personal/wk46_2026/production_hardening/lanes/F1_evidence/sweep.cjs (FAST=1 for his five
 * sizes with the keyboard and the pan; the full set steps every 40 px from 360 to 1400 on 15 routes), which fails on
 * 7.0.34 and passes here. What it cannot see: a pan that reports a normal height (nothing on the page tells it apart).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QJS = readFileSync(join(HERE, 'panes/questions.js'), 'utf8')
const QCSS = readFileSync(join(HERE, 'panes/questions.css'), 'utf8')
const CHAT_CSS = readFileSync(join(HERE, 'panes/cos-chat.css'), 'utf8')
const CONTROL_CSS = readFileSync(join(HERE, 'control.css'), 'utf8')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the first `@media <query> { ... }` block, by brace matching. */
function mediaBlock(css: string, query: string): string {
  const src = strip(css), at = src.indexOf('@media ' + query)
  if (at < 0) return ''
  let i = src.indexOf('{', at), depth = 0, start = i + 1
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break }
  return src.slice(start, i)
}

function boot(read: { v: any }) {
  const classes = new Set<string>(), props: Record<string, string> = {}, crumbs: Array<{ what: string; data: any }> = []
  let cards = 0
  const host: any = {
    classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) }, contains: (c: string) => classes.has(c), add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    style: { setProperty: (k: string, v: string) => { props[k] = v } },
    querySelector: (s: string) => (s === '.sq-foot' && cards ? {} : null),
    querySelectorAll: (s: string) => (s === '.sq-card' ? new Array(cards).fill({}) : []),
    addEventListener: () => {}, contains: () => false, innerHTML: '', hidden: true, setAttribute: () => {}, removeAttribute: () => {}
  }
  const W: any = {
    esc: (s: string) => String(s), api: () => Promise.resolve({}), plural: (n: number, a: string, b: string) => (n === 1 ? a : b),
    viewportFit: () => read.v, layoutCrumb: (what: string, data: any) => { crumbs.push({ what, data }); return true },
    onShell: () => {}, onRoute: () => {}, onServer: () => {}
  }
  const win: any = { COSWeb: W, addEventListener: () => {}, visualViewport: { addEventListener: () => {} }, matchMedia: () => ({ matches: false }) }
  const doc: any = { getElementById: (id: string) => (id === 'sq-host' ? host : null), addEventListener: () => {}, activeElement: null, hidden: false, querySelectorAll: () => [] }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setInterval', 'clearInterval', QJS)(win, doc, () => 0, () => {})
  return { fit: () => W.sessionQuestions._fitKeyboard(), render: () => W.sessionQuestions._render(), classes, props, crumbs, setCards: (n: number) => { cards = n } }
}
const GOOD = { layoutH: 787, top: 0, height: 787, inset: 118, below: 0, dock: 0, scale: 0.85, zoomed: false, vv: true }
const BAD = { layoutH: 787, top: 0, height: 787, inset: 0, below: 0, dock: 0, scale: 1, zoomed: false, vv: false, bad: true }

describe('F1 fix 1: the question footer stops sticking while the visual viewport reading is bad', () => {
  it('a bad reading (his 0-height pan) puts sq-vv-lost on #sq-host; a good one takes it off', () => {
    const read = { v: GOOD as any }, h = boot(read)
    h.setCards(1)
    h.fit(); expect(h.classes.has('sq-vv-lost')).toBe(false)
    read.v = BAD; h.fit(); expect(h.classes.has('sq-vv-lost')).toBe(true)
    read.v = GOOD; h.fit(); expect(h.classes.has('sq-vv-lost')).toBe(false)
  })
  it('the keyboard rule is unchanged: a good reading 464 px covered still sets sq-kb-up and lifts nothing past it', () => {
    const read = { v: { ...GOOD, inset: 464, below: 187, top: 220, height: 380 } as any }, h = boot(read)
    h.fit()
    expect(h.classes.has('sq-kb-up')).toBe(true)
    expect(h.classes.has('sq-vv-lost')).toBe(false)
    expect(h.props['--sq-kb']).toBe('187px')
  })
  it('one numbers-only sq-vv-lost row per bad stretch while a card shows; none with no card', () => {
    const read = { v: BAD as any }, h = boot(read)
    h.fit(); h.fit()
    expect(h.crumbs.filter(c => c.what === 'sq-vv-lost')).toHaveLength(0)   // bad, but no card on screen
    h.setCards(1); h.fit(); h.fit(); h.fit()
    const rows = h.crumbs.filter(c => c.what === 'sq-vv-lost')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.data).toEqual({ cards: 1 })
    read.v = GOOD; h.fit()
    read.v = BAD; h.fit()
    expect(h.crumbs.filter(c => c.what === 'sq-vv-lost')).toHaveLength(2)   // a new stretch, a new row
  })
  it('a card drawn while the reading is already bad gets the rule and its row at once (render runs fitKeyboard)', () => {
    const read = { v: BAD as any }, h = boot(read)
    h.setCards(1)
    h.render()
    expect(h.classes.has('sq-vv-lost')).toBe(true)
    expect(h.crumbs.filter(c => c.what === 'sq-vv-lost')).toHaveLength(1)
  })
  it('questions.css makes the footer static under sq-vv-lost, on #sq-host only', () => {
    expect(strip(QCSS)).toMatch(/\.sq-host\.sq-vv-lost \.sq-foot \{ position: static; \}/)
    expect(strip(QCSS).match(/sq-vv-lost/g)).toHaveLength(1)
  })
})

describe('F1 fix 2: the Messages list header ends at its column', () => {
  it('from 860 px the list column hero has no bleed (margin and padding inline 0)', () => {
    const wide = mediaBlock(CHAT_CSS, '(min-width: 860px)')
    expect(wide).toMatch(/\.msg-left \.cx-hero \{ margin-inline: 0; padding-inline: 0; \}/)
  })
  it('the bleed it cancels is still the pane hero\'s (control.css), so the rule is load-bearing', () => {
    expect(strip(CONTROL_CSS)).toMatch(/\.cx-hero \{[^}]*margin: 0 calc\(-1 \* var\(--gutter\)\) 0;/)
  })
  it('under 860 px (one column, the list is the pane) the hero keeps its bleed: the rule is only in the wide block', () => {
    const all = strip(CHAT_CSS), wide = mediaBlock(CHAT_CSS, '(min-width: 860px)')
    expect(all.split('.msg-left .cx-hero {').length - 1).toBe(1)
    expect(wide.includes('.msg-left .cx-hero {')).toBe(true)
  })
})
