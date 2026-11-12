/**
 * 7.0.31 hotfix (Miles 17:25 on the open Duo, message #490): from 600 px the message reader is its own frame. The page
 * is one screen (html.rd-frame), the reader scrolls inside its own box and its Reply box sticks to that box's bottom,
 * so a stale Safari viewport after folds can no longer leave Reply and the rail mid-screen with the message drawn below
 * them. Under 600 px, and on a message's image, nothing changes. These run app.js's own text against fakes and pin the
 * CSS; W1_evidence/7031_hotfix/reader_frame_check.cjs checks the layout in WebKit at seven sizes, light and dark.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes/cos-chat.css'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const SRC = slice(APP, '  function rdFrameOn(r) {', "  // Where the frame's parts sit against the VISIBLE area")

class FakeClass { s = new Set<string>(); toggle(c: string, on?: boolean) { const v = on === undefined ? !this.s.has(c) : on; if (v) this.s.add(c); else this.s.delete(c); return v } contains(c: string) { return this.s.has(c) } add(c: string) { this.s.add(c) } remove(...cs: string[]) { cs.forEach(c => this.s.delete(c)) } }

function kit(o: { wide?: boolean; shellHidden?: boolean; route?: { pane: string; args: string[] }; crumbOk?: boolean; reply?: boolean } = {}) {
  const de: any = { classList: new FakeClass() }
  const mqs: Array<{ q: string; fns: Array<() => void> }> = []
  const frames: Array<() => void> = []
  const crumbs: Array<{ what: string; data: any }> = []
  const box = (t: number, b: number) => ({ getBoundingClientRect: () => ({ top: t, bottom: b }) })
  let wide = o.wide ?? true
  const win: any = {
    matchMedia: (q: string) => { const m = { q, fns: [] as Array<() => void> }; mqs.push(m); return { get matches() { return q === '(min-width: 600px)' ? wide : false }, addEventListener: (_t: string, fn: () => void) => m.fns.push(fn) } },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length },
  }
  const deps: any = {
    window: win,
    document: { documentElement: de, scrollingElement: { scrollHeight: 787 }, querySelector: (s: string) => (s === '#pane-messages .cx-reply-form' ? (o.reply === false ? null : box(680, 787)) : s === '#pane-messages > .cx' ? box(62, 787) : null) },
    $: (id: string) => (id === 'app-shell' ? { classList: { contains: (c: string) => c === 'hidden' && !!o.shellHidden } } : null),
    parseRoute: () => o.route ?? { pane: 'messages', args: ['m', 'i5'] },
    viewportFit: () => ({ top: 0, height: 787, bad: false }),
    layoutCrumb: (what: string, data: any) => { crumbs.push({ what, data }); return o.crumbOk ?? true },
    lrProbe: () => 787,
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${SRC}\nreturn { on: rdFrameOn, sync: rdFrameSync, crumb: rdFrameCrumb, RD: RD_FRAME };\n}`)(deps)
  return { k, de, mqs, frames, crumbs, setWide: (v: boolean) => { wide = v } }
}

describe('html.rd-frame: on only for a message reader from 600 px', () => {
  it('a message reader at 600 px and wider: on', () => {
    const h = kit()
    expect(h.k.sync({ pane: 'messages', args: ['m', 'i5'] })).toBe(true)
    expect(h.de.classList.contains('rd-frame')).toBe(true)
  })
  it('off, and the class taken away, for: under 600 px, a message image, the list, the archive, other panes, the sign-in gate', () => {
    const cases: Array<[string, any]> = [
      ['under 600 px', { wide: false }],
      ['a message image', { route: { pane: 'messages', args: ['m', 'i5', 'a', 'att1'] } }],
      ['the Messages list', { route: { pane: 'messages', args: [] } }],
      ['the archive', { route: { pane: 'messages', args: ['archive'] } }],
      ['a session reader', { route: { pane: 'sessions', args: ['claude', 'x'] } }],
      ['a meeting', { route: { pane: 'meetings', args: ['m', 'i5'] } }],
      ['the shell hidden (sign-in gate)', { shellHidden: true }],
    ]
    for (const [name, o] of cases) {
      const h = kit(o)
      h.de.classList.add('rd-frame')
      expect(h.k.sync(o.route), name).toBe(false)
      expect(h.de.classList.contains('rd-frame'), name).toBe(false)
    }
  })
  it('crossing 600 px resyncs it from the route, with one listener however often it syncs', () => {
    const h = kit()
    h.k.sync(); h.k.sync(); h.k.sync()
    const six = h.mqs.filter(m => m.q === '(min-width: 600px)' && m.fns.length)
    expect(six, 'one 600 px listener').toHaveLength(1)
    h.setWide(false); six[0].fns[0]()
    expect(h.de.classList.contains('rd-frame'), 'folded under 600: off').toBe(false)
    h.setWide(true); six[0].fns[0]()
    expect(h.de.classList.contains('rd-frame'), 'unfolded: on again').toBe(true)
  })
  it('route() syncs it right after the Sessions frame, with the route it parsed', () => {
    const r = slice(APP, '  function route(forceChanged) {', '    var paneEl')
    expect(r).toContain("    if (typeof sxFrameSync === 'function') sxFrameSync();\n    if (typeof rdFrameSync === 'function') rdFrameSync(r);\n")
  })
  it('showAuth takes it off with the Sessions frame (run on its own text)', () => {
    const AUTH = slice(APP, '  function showAuth(message) {', '  function signedInOnce() {')
    const de: any = { classList: new FakeClass() }
    de.classList.add('rd-frame'); de.classList.add('sx-frame')
    const els: Record<string, any> = {}
    const $ = (id: string) => (els[id] ??= { classList: new FakeClass() })
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${AUTH}\nshowAuth('Signed out');\n}`)({ $, document: { documentElement: de }, readerImagesStop: () => {}, setStatus: () => {}, CONN: {} })
    expect(de.classList.contains('rd-frame')).toBe(false)
    expect(de.classList.contains('sx-frame')).toBe(false)
  })
})

describe('the rd-frame report: where the box and Reply sit, numbers only, bounded', () => {
  it('one report a frame after it turns on, with the box, the reader, Reply, the document height and 100dvh', () => {
    const h = kit()
    h.k.sync()
    expect(h.crumbs).toHaveLength(0)
    h.frames.forEach(f => f())
    expect(h.crumbs).toHaveLength(1)
    expect(h.crumbs[0]).toEqual({ what: 'rd-frame', data: { why: 'open', fb: false, boxT: 0, boxB: 787, rdT: 62, rdB: 787, replyB: 787, docH: 787, dvh: 787 } })
    for (const v of Object.values(h.crumbs[0].data)) expect(['number', 'boolean', 'string']).toContain(typeof v)
  })
  it('never while the frame is off, and at most 8 a page load', () => {
    const off = kit({ wide: false })
    off.k.sync(); off.frames.forEach(f => f())
    expect(off.crumbs).toHaveLength(0)
    const h = kit()
    h.de.classList.add('rd-frame')
    for (let i = 0; i < 12; i++) h.k.crumb('open')
    expect(h.crumbs).toHaveLength(8)
  })
  it('a report the log refused does not count against the 8', () => {
    const h = kit({ crumbOk: false })
    h.de.classList.add('rd-frame')
    for (let i = 0; i < 12; i++) h.k.crumb('open')
    expect(h.k.RD.n).toBe(0)
  })
  it('the fold report (rail) also carries 100dvh, the number his 17:25 frame was missing', () => {
    expect(slice(APP, '  function railSync() {', '\n  }\n')).toContain("layoutCrumb('rail', { sw: sc.width, sh: sc.height, rail: on, railHit: RAIL.hit, dvh: typeof lrProbe === 'function' ? lrProbe('height:100dvh', 'h') : null });")
  })
})

describe('the frame CSS (panes/cos-chat.css)', () => {
  const block = slice(CSS, '@media (min-width: 600px) {\n  html.rd-frame, html.rd-frame body', '\n}\n')
  it('every html.rd-frame rule is inside the 600 px block: nothing reaches the phone or the folded Duo', () => {
    const outside = CSS.replace(block, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(outside).not.toMatch(/html\.rd-frame/)
  })
  it('the page is one screen: html and body clipped, the shell fixed to the visible box', () => {
    expect(block).toContain('html.rd-frame, html.rd-frame body { height: 100%; overflow: hidden; overscroll-behavior: none; }')
    expect(block).toMatch(/html\.rd-frame \.app-shell \{ position: fixed; left: 0; right: 0; top: var\(--vv-top, 0px\); height: var\(--vv-h, 100dvh\);/)
  })
  it('the rail is a column of the shell (not 100dvh) and the reader is the scroller', () => {
    expect(block).toContain('html.rd-frame .rail { position: static; top: auto; height: auto; min-height: 0; overflow-y: auto;')
    expect(block).toContain('html.rd-frame #pane-messages > .cx { flex: 1 1 auto; min-height: 0; overflow-y: auto;')
    expect(block).toContain('html.rd-frame .workspace { flex: 1 1 auto; min-height: 0;')
  })
  it('with the keyboard up the Reply box stays at the frame bottom (the frame is already the visible box)', () => {
    expect(block).toContain('html.rd-frame.kb-reply .cx-reply-form { bottom: 0; }')
  })
  it('contained, not hidden: no z-index in the frame', () => {
    expect(block).not.toMatch(/z-index/)
  })
})
