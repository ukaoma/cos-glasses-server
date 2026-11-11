/**
 * 7.0.23, step 1 of the chat-style Sessions (DESIGN_PLAN v2 "The frame", lead 23:00): while Sessions shows its list
 * and reader, html.sx-frame makes the page one screen; the rail, the list and the reader's body scroll by themselves,
 * the reply area is a dock at the bottom of the reader, the reader stays at the newest turn until the person scrolls,
 * Full width reads Hide list, and a bounded report says where the rail, the list and the reply box sit against the
 * visible area. These run app.js's own text against fakes and pin the CSS the frame depends on. They cannot see a
 * phone: W1_evidence/two_column/frame_check.cjs (WebKit, real wheel events) checks the layout, and only his phone shows
 * the keyboard and the 0.85 state.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes/sessions.css'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const FRAME_SRC = slice(APP, '  function sxFrameSync() {', "  // 7.0.1: the hero's counts say")

class FakeClass { s = new Set<string>(); toggle(c: string, on?: boolean) { const v = on === undefined ? !this.s.has(c) : on; if (v) this.s.add(c); else this.s.delete(c); return v } contains(c: string) { return this.s.has(c) } add(c: string) { this.s.add(c) } remove(...cs: string[]) { cs.forEach(c => this.s.delete(c)) } }
type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number }
const rect = (top: number, bottom: number, left: number, right: number): Rect => ({ top, bottom, left, right, width: right - left, height: bottom - top })

function kit(o: { pane?: string; view?: string; ro?: boolean; fit?: any; rects?: Record<string, Rect | null>; crumbOk?: boolean; shellHidden?: boolean } = {}) {
  const de: any = { classList: new FakeClass() }
  const listeners: Record<string, Array<() => void>> = {}
  const body: any = {
    id: 'session-body', isConnected: true, scrollTop: 0, scrollHeight: 5000, clientHeight: 300, children: [{ n: 'note' }, { n: 'turns' }, { n: 'foot' }],
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn) },
  }
  const fire = (t: string) => (listeners[t] || []).forEach(fn => fn())
  const observed: unknown[] = [], ros: Array<{ cb: () => void; disconnected: boolean }> = []
  class RO { r: { cb: () => void; disconnected: boolean }; constructor(cb: () => void) { this.r = { cb, disconnected: false }; ros.push(this.r) } observe(x: unknown) { observed.push(x) } disconnect() { this.r.disconnected = true } }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const crumbs: Array<{ what: string; data: any }> = [], hooks: Array<(w: string) => void> = []
  const rects = o.rects ?? {}
  const el = (key: string) => {
    const r = rects[key]
    return r === undefined ? null : { offsetParent: r ? {} : null, getBoundingClientRect: () => r ?? rect(0, 0, 0, 0) }
  }
  const scrolls: number[][] = []
  const win: any = { innerWidth: 1119, innerHeight: 787, visualViewport: { offsetLeft: 0, width: 1119, height: 787, offsetTop: 0 }, scrollTo: (x: number, y: number) => scrolls.push([x, y]),
    COSWeb: { onKeyboard: (fn: (w: string) => void) => hooks.push(fn) } }
  const deps: any = {
    window: win, document: { documentElement: de, querySelector: (s: string) => (s === '.rail' ? el('rail') : null) },
    state: { pane: o.pane ?? 'sessions' }, SX: { view: o.view ?? 'sessions' },
    $: (id: string) => (id === 'app-shell' ? { classList: { contains: (c: string) => c === 'hidden' && !!o.shellHidden } } : id === 'session-body' ? body : id === 'sessions-list-col' ? el('list') : id === 'session-reader' ? el('rd') : id === 'session-form' ? el('reply') : null),
    viewportFit: () => o.fit ?? { top: 0, height: 787, vv: true },
    layoutCrumb: (what: string, data: any) => { crumbs.push({ what, data }); return o.crumbOk ?? true },
    ResizeObserver: o.ro === false ? undefined : RO,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length },
    Date,
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${FRAME_SRC}\nreturn { sync: sxFrameSync, newest: sxToNewest, crumb: sxFrameCrumb, goq: sxGoQuestionPaint, PIN: SX_PIN, FRAME: SX_FRAME, MAX: SX_FRAME_MAX, USER_MS: SX_PIN_USER_MS };\n}`)(deps)
  return { k, de, body, fire, observed, ros, timers, crumbs, hooks, scrolls, deps }
}

describe('the sign-in gate is a normal page: no frame while it shows (7.0.23 regression, lapse_check)', () => {
  it('sxFrameSync is off while the shell is hidden, even in Sessions', () => {
    const h = kit({ shellHidden: true })
    h.de.classList.add('sx-frame')
    expect(h.k.sync()).toBe(false)
    expect(h.de.classList.contains('sx-frame')).toBe(false)
  })
  it('showAuth takes both frame classes off as it shows the gate (run on its own text)', () => {
    const SRC = slice(APP, '  function showAuth(message) {', '  function signedInOnce() {')
    const de: any = { classList: new FakeClass() }
    de.classList.add('sx-frame'); de.classList.add('mx-frame'); de.classList.add('kb-up')
    const els: Record<string, any> = {}
    const $ = (id: string) => (els[id] ??= { classList: new FakeClass() })
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${SRC}\nshowAuth('Signed out');\n}`)({ $, document: { documentElement: de }, readerImagesStop: () => {}, setStatus: () => {}, CONN: {} })
    expect(de.classList.contains('sx-frame')).toBe(false)
    expect(de.classList.contains('mx-frame')).toBe(false)
    expect(de.classList.contains('kb-up'), 'the keyboard kit owns kb-up').toBe(true)
    expect(els['app-shell'].classList.contains('hidden')).toBe(true)
  })
})

describe('html.sx-frame: on only while Sessions shows its list and reader', () => {
  it('Sessions with its list and reader: on, and the keyboard hook is added once', () => {
    const h = kit()
    expect(h.k.sync()).toBe(true)
    expect(h.de.classList.contains('sx-frame')).toBe(true)
    h.k.sync()
    expect(h.hooks, 'one after-close hook however often it syncs').toHaveLength(1)
  })
  it('Usage or COS cost inside Sessions, and every other pane: off (the page keeps its own scroll)', () => {
    for (const [pane, view] of [['sessions', 'usage'], ['sessions', 'cost'], ['today', 'sessions'], ['memories', 'sessions']]) {
      const h = kit({ pane, view })
      h.de.classList.add('sx-frame')
      expect(h.k.sync(), pane + ' ' + view).toBe(false)
      expect(h.de.classList.contains('sx-frame')).toBe(false)
    }
  })
  it('route() and the Sessions header both resync it', () => {
    expect(slice(APP, '  function route(forceChanged) {', '    var paneEl')).toContain("if (typeof sxFrameSync === 'function') sxFrameSync();")
    expect(slice(APP, '  function paintSessionsHero() {', '\n  }\n')).toContain('    sxFrameSync();')
  })
})

describe('the reader opens at the newest turn and stays there until the person scrolls', () => {
  it('in the frame: the body goes to its end, and it and each of its parts are watched', () => {
    const h = kit()
    h.de.classList.add('sx-frame')
    h.k.newest()
    expect(h.body.scrollTop).toBe(5000)
    expect(h.observed).toEqual([h.body, ...h.body.children])
    expect(h.scrolls, 'never the window').toEqual([])
  })
  it('content that lands later (the question cards, a redraw) moves it back to the end', () => {
    const h = kit()
    h.de.classList.add('sx-frame')
    h.k.newest()
    h.body.scrollHeight = 5260
    h.ros[0]!.cb()
    expect(h.body.scrollTop).toBe(5260)
  })
  it('a scroll the browser makes on its own (scroll anchoring) does not release it', () => {
    const h = kit()
    h.de.classList.add('sx-frame')
    h.k.newest()
    h.body.scrollTop = 2400; h.body.scrollHeight = 6000
    h.fire('scroll')
    expect(h.k.PIN.body, 'still pinned').toBe(h.body)
    h.ros[0]!.cb()
    expect(h.body.scrollTop).toBe(6000)
  })
  it('the person scrolling up (a wheel, a touch, a pointer or a key on it, then a scroll away from the end) releases it', () => {
    for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      const h = kit()
      h.de.classList.add('sx-frame')
      h.k.newest()
      h.fire(t)
      h.body.scrollTop = 4000
      h.fire('scroll')
      expect(h.k.PIN.body, t).toBe(null)
      expect(h.ros[0]!.disconnected, t).toBe(true)
    }
  })
  it('the person’s own input long ago does not count (only within 1 s)', () => {
    const h = kit()
    h.de.classList.add('sx-frame')
    h.k.newest()
    h.fire('wheel')
    h.k.PIN.userAt -= h.k.USER_MS + 50
    h.body.scrollTop = 4000
    h.fire('scroll')
    expect(h.k.PIN.body).toBe(h.body)
  })
  it('without ResizeObserver: two more passes at 250 and 900 ms, while still pinned', () => {
    const h = kit({ ro: false })
    h.de.classList.add('sx-frame')
    h.k.newest()
    expect(h.timers.map(t => t.ms)).toEqual([250, 900])
    h.body.scrollHeight = 5300
    h.timers[0]!.fn()
    expect(h.body.scrollTop).toBe(5300)
  })
  it('the frame off (an old route): the window goes to the end, as before', () => {
    const h = kit()
    h.k.newest()
    expect(h.scrolls).toHaveLength(1)
  })
  it('opening, a sent turn and a redraw while pinned all use it', () => {
    expect(APP).toContain("if (turns.length) requestAnimationFrame(function () { if (typeof sxToNewest === 'function') sxToNewest(); else window.scrollTo(0, document.documentElement.scrollHeight); });")
    expect(slice(APP, '  function showPendingTurn(text, note, heldKey) {', '\n  }\n')).toContain("if (typeof sxToNewest === 'function') sxToNewest();")
    expect(APP).toContain("if (body && typeof SX_PIN === 'object' && SX_PIN.body === body) { body.scrollTop = body.scrollHeight; SX_PIN.put = body.scrollTop; return; }")
  })
})

describe('the reader: header, the conversation, then the dock with everything it had', () => {
  const html = slice(APP, "      reader.innerHTML =\n        '<div class=\"sx-reader-head\">", '      readerImagesMount($')
  it('the conversation (note, turns, Copy session, and the session\u2019s question cards last) is in #session-body, between the header and the dock', () => {
    const head = html.indexOf('sx-reader-head'), body = html.indexOf('id="session-body"'), dock = html.indexOf('id="session-dock"')
    expect(head).toBeGreaterThan(-1)
    expect(body).toBeGreaterThan(head)
    expect(dock).toBeGreaterThan(body)
    for (const part of ['sx-note', 'id="session-turns"', 'data-sx="copy-session"', 'id="session-copy-note"', 'id="session-questions"']) {
      const at = html.indexOf(part)
      expect(at > body && at < dock, part).toBe(true)
    }
  })
  it('the question cards end the conversation, right above the dock (the newest thing in it)', () => {
    const q = html.indexOf('id="session-questions"')
    expect(q).toBeGreaterThan(html.indexOf('id="session-copy-note"'))
    expect(q).toBeLessThan(html.indexOf('id="session-dock"'))
  })
  it('the dock keeps the activity with Stop, the Mac question, the verdict, the reply box, its status and the queue', () => {
    const dock = html.indexOf('id="session-dock"')
    for (const part of ['id="session-live"', 'id="session-mac-q"', 'id="session-verdict"', 'id="session-form"', 'data-action="fork-session"', 'id="session-send"', 'id="session-status"', 'id="session-caution"', 'id="session-queue"'])
      expect(html.indexOf(part), part).toBeGreaterThan(dock)
  })
})

describe('Hide list', () => {
  it('Sessions says Hide list; Show list brings it back; Memories and Messages keep Full width', () => {
    expect(APP).toContain("(full ? 'Show list' : 'Hide list')")
    expect(APP).toMatch(/var SX_SPLIT_OPTS = \{[^}]*hideText: 'Hide list'/)
    expect(APP).toContain("b.textContent = full ? 'Show list' : (o.hideText || 'Full width');")
  })
})

describe('the position report against the visible area', () => {
  const R = { rail: rect(0, 787, 0, 248), list: rect(300, 780, 288, 628), rd: rect(300, 780, 646, 1095), reply: rect(660, 770, 646, 1079) }
  it('on open: the visible box and each part with its edges and whether it is inside', () => {
    const h = kit({ rects: R })
    h.de.classList.add('sx-frame')
    expect(h.k.crumb('open')).toBe(true)
    expect(h.crumbs).toHaveLength(1)
    expect(h.crumbs[0]).toMatchObject({ what: 'sx-frame', data: { why: 'open', fb: false, boxT: 0, boxB: 787, boxL: 0, boxR: 1119,
      railT: 0, railB: 787, railL: 0, railR: 248, railIn: true, listIn: true, rdIn: true, replyT: 660, replyB: 770, replyIn: true } })
  })
  it('a part past the visible area reads In false; a part not shown reads -1 and false', () => {
    const h = kit({ rects: { ...R, reply: rect(820, 930, 646, 1079), rail: null } })
    h.de.classList.add('sx-frame')
    h.k.crumb('open')
    expect(h.crumbs[0]!.data).toMatchObject({ replyIn: false, replyT: 820, railT: -1, railB: -1, railL: -1, railR: -1, railIn: false })
  })
  it('a part moved sideways off the left edge reads In false', () => {
    const h = kit({ rects: { ...R, list: rect(300, 780, -340, 0) } })
    h.de.classList.add('sx-frame')
    h.k.crumb('open')
    expect(h.crumbs[0]!.data.listIn).toBe(false)
  })
  it('measured against the box viewportFit gives: after a keyboard, the box is the visible part', () => {
    const h = kit({ rects: R, fit: { top: 407, height: 380, vv: true } })
    h.de.classList.add('sx-frame')
    h.k.crumb('kb-after')
    expect(h.crumbs[0]!.data).toMatchObject({ why: 'kb-after', boxT: 407, boxB: 787, railIn: false, replyIn: true })
  })
  it('a bad visible-height reading (fb): the fallback box, and the sideways edges are the window\'s', () => {
    const h = kit({ rects: R, fit: { top: 0, height: 787, vv: false, bad: true } })
    h.deps.window.visualViewport = { offsetLeft: 300, width: 10, height: 0 }
    h.de.classList.add('sx-frame')
    h.k.crumb('kb-after')
    expect(h.crumbs[0]!.data).toMatchObject({ fb: true, boxL: 0, boxR: 1119 })
  })
  it('only in the frame, at most 8 a page load, counted only when sent', () => {
    const off = kit({ rects: R })
    expect(off.k.crumb('open')).toBe(false)
    expect(off.crumbs).toHaveLength(0)
    const h = kit({ rects: R })
    h.de.classList.add('sx-frame')
    for (let i = 0; i < 12; i++) h.k.crumb('open')
    expect(h.crumbs).toHaveLength(8)
    const no = kit({ rects: R, crumbOk: false })
    no.de.classList.add('sx-frame')
    for (let i = 0; i < 12; i++) no.k.crumb('open')
    expect(no.crumbs, 'a report the caps refused does not use up the 8').toHaveLength(12)
  })
  it('the keyboard after-close moment reports once more', () => {
    const h = kit({ rects: R })
    h.k.sync()
    h.hooks[0]!('close')
    expect(h.crumbs).toHaveLength(0)
    h.hooks[0]!('after')
    expect(h.crumbs.map(c => c.data.why)).toEqual(['kb-after'])
  })
  it('keys and values fit layoutCrumb', () => {
    const h = kit({ rects: R })
    h.de.classList.add('sx-frame')
    h.k.crumb('kb-after')
    for (const [k, v] of Object.entries(h.crumbs[0]!.data)) {
      expect(k).toMatch(/^[a-z][a-zA-Z0-9]{0,15}$/)
      expect(['number', 'boolean'].includes(typeof v) || (typeof v === 'string' && (v as string).length <= 24), k).toBe(true)
    }
  })
})

describe('panes/sessions.css: the frame', () => {
  const css = CSS.slice(CSS.indexOf('/* ── the frame (7.0.23'))
  it('the shell is the visible box the keyboard kit publishes, not 100dvh alone', () => {
    expect(css).toContain('position: fixed; left: 0; right: 0; top: var(--vv-top, 0px); height: var(--vv-h, 100dvh);')
    expect(css).toContain('html.sx-frame, html.sx-frame body { height: 100%; overflow: hidden; overscroll-behavior: none; }')
  })
  it('the rail, the list and the conversation each scroll by themselves', () => {
    expect(css).toContain('html.sx-frame .rail { position: static; top: auto; height: auto; min-height: 0; overflow-y: auto;')
    expect(css).toContain('html.sx-frame .sx-split > .split-list { min-height: 0; overflow: auto;')
    expect(css).toContain('html.sx-frame .sx-body { flex: 1 1 0; overflow: auto;')
  })
  it('the labelled rail only from 1100 wide and 721 tall', () => {
    expect(css).toContain('@media (min-width: 1100px) and (min-height: 721px) {\n  html.sx-frame .app-shell { grid-template-columns: 248px minmax(0, 1fr); }')
    expect(css).toContain('html.sx-frame .app-shell { display: grid; grid-template-columns: 74px minmax(0, 1fr);')
  })
  it('the divider stays relative, so its 44 px touch area stays its own size (static let it cover the split)', () => {
    expect(css).toContain('html.sx-frame .sx-handle { position: relative;')
  })
  it('the dock: at most 60 percent, the activity gives way first, the reply box never does', () => {
    expect(css).toContain('html.sx-frame .sx-dock { flex: 0 0 auto; max-height: 60%;')
    expect(css).toContain('html.sx-frame .sx-dock > .sx-activity { flex: 0 4 auto; min-height: 32px; max-height: 96px;')
    expect(css).toContain('html.sx-frame .sx-dock #session-queue { flex: none; max-height: 9rem; overflow: auto;')
    expect(css).toContain('html.sx-frame .sx-dock .sx-chat > * { flex: none; }')
    // 951 by 539 with Go to the question shown: a shrinking reply part let the capped dock clip the reply box by 17 px.
    expect(css).toContain('html.sx-frame .sx-dock .sx-chat { margin-top: 0; flex: none;')
    expect(css).not.toMatch(/html\.sx-frame \.sx-dock \{[^}]*overflow: hidden/)
  })
  it('while typing the dock drops its spacing, and an empty status line takes no room (382 by 557, keyboard up)', () => {
    expect(css).toContain('html.sx-frame .sx-dock #session-status:empty { min-height: 0; margin: 0; }')
    expect(css).toContain('html.sx-frame.kb-up .sx-dock { padding-top: 4px; }')
    expect(css).toContain('html.sx-frame.kb-up .sx-dock > .sx-activity { margin-bottom: 4px; }')
    expect(css).toContain('html.sx-frame.kb-up .sx-dock .sx-chat { padding-top: 0; }')
    expect(css).toContain('html.sx-frame.kb-up .sx-dock #session-form { margin-top: 0; }')
  })
  it('touch at any size in the frame: Copy session and the rail Settings reach 44 px', () => {
    expect(css).toMatch(/@media \(any-pointer: coarse\) \{\s*html\.sx-frame \.sx-foot \.cx-btn, html\.sx-frame \.rail-settings \{ min-height: 44px; \}/)
  })
  it('Go to the question floats on the dock edge and takes no room from it; only its button shows', () => {
    expect(css).toContain('html.sx-frame .sx-dock > .sx-goq { position: absolute; right: 8px; left: auto; bottom: calc(100% + 6px);')
    expect(css).toMatch(/html\.sx-frame \.sx-dock > \.sx-goq > span \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/)
  })
  it('what sits over every pane never takes the screen: the question cards as their one line, capped and scrolling', () => {
    expect(css).toContain('html.sx-frame #sq-host { max-height: 35%; overflow: auto;')
    expect(css).toContain('html.sx-frame .sq-host .sq-cards:not(.open) { display: none; }')
  })
  it('with the keyboard up: the headers, the notices and the question line step aside', () => {
    expect(css).toContain('html.sx-frame.kb-up .navbar, html.sx-frame.kb-up #conn-notice, html.sx-frame.kb-up #sq-host { display: none; }')
  })
  it('short screens: the sign-in line keeps its Hide button (the line is not wider than the screen)', () => {
    expect(css).toContain('html.sx-frame .conn-notice { margin-bottom: 8px; gap: 6px; grid-template-columns: minmax(0, 1fr); }')
    expect(css).toContain('html.sx-frame .conn-line > .btn { flex: none; }')
  })
})

describe('Go to the question (Q1 23:40): the dock says a question waits when its card is out of view', () => {
  function goq(o: { cards: boolean; qTop: number; frame?: boolean }) {
    const h = kit()
    if (o.frame !== false) h.de.classList.add('sx-frame')
    const line: any = { hidden: true }
    const q: any = { children: o.cards ? [{}] : [], textContent: o.cards ? 'Which branch?' : '', getBoundingClientRect: () => ({ top: o.qTop }) }
    const body: any = { getBoundingClientRect: () => ({ bottom: 700 }) }
    h.deps.$ = (id: string) => (id === 'session-goq' ? line : id === 'session-body' ? body : id === 'session-questions' ? q : null)
    return { show: h.k.goq(), line }
  }
  it('a card at the end, below what shows: the line shows', () => {
    const g = goq({ cards: true, qTop: 1400 })
    expect(g.show).toBe(true)
    expect(g.line.hidden).toBe(false)
  })
  it('the card in view, no card, or the frame off: no line', () => {
    expect(goq({ cards: true, qTop: 500 }).line.hidden).toBe(true)
    expect(goq({ cards: false, qTop: 1400 }).line.hidden).toBe(true)
    expect(goq({ cards: true, qTop: 1400, frame: false }).line.hidden).toBe(true)
  })
  it('the line is in the dock; it repaints on the body\u2019s scroll, its size changes and the cards\u2019 redraws; its button goes to the end', () => {
    const html = slice(APP, "      reader.innerHTML =\n        '<div class=\"sx-reader-head\">", '      readerImagesMount($')
    expect(html.indexOf('id="session-goq"')).toBeGreaterThan(html.indexOf('id="session-dock"'))
    expect(APP).toContain("body.addEventListener('scroll', sxGoQuestionPaint, { passive: true });")
    expect(APP).toContain("if (SX_PIN.body === body && body.isConnected) bottom(); sxGoQuestionPaint(); });")
    expect(APP).toContain("if (typeof sxGoQuestionPaint === 'function') sxGoQuestionPaint(); });")
    expect(APP).toContain("if (act === 'goto-question') { sxToNewest(); sxGoQuestionPaint();")
  })
})
