/**
 * 7.0.56: the Sessions dock, Direction 2 (A1's mock and README, wk47_2026/sessions_dock_mocks; Miles 18:3x "yup this
 * design is it."; the lead's OK on W1's plan, 18:5x). The real SX_DOCK block and the real note functions, sliced out of
 * app.js and run with fakes for the page; the CSS and the markup read as they ship. Geometry here is the mock's own
 * arithmetic; the real measurement at 382x557, 449x655 and 951x539 is F1's probe, which gates the build.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes', 'sessions.css'), 'utf8')
const CHATCSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const TA = readFileSync(join(HERE, 'panes', 'today-actions.js'), 'utf8')
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error('marker moved: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const DOCK = between(APP, '  // ── 7.0.56: the Sessions dock, Direction 2', '  function paintActivity(r) {')
const NOTE = between(APP, '  var SX_PARK = {', "  /** The composer's \"Working right now\" note")
const DOCKCSS = between(CSS, '/* ── 7.0.56: the Sessions dock, Direction 2', '/* ── the list (7.0.23, step 2b-1;')

// ── a page of fakes ───────────────────────────────────────────────────────────────────────────────────────────────
class El {
  attrs: Record<string, string> = {}; cls = new Set<string>(); innerHTML = ''; style: Record<string, string> = {}; focused = 0
  constructor(public id = '', public h = 0) {}
  get classList() { const c = this.cls; return { toggle: (n: string, on: boolean) => { if (on) c.add(n); else c.delete(n) }, contains: (n: string) => c.has(n) } }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  removeAttribute(k: string) { delete this.attrs[k] }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  getBoundingClientRect() { return { height: this.h, top: 0 } }
  closest(sel: string) { return sel === '#session-handle' && this.id === 'session-handle' ? this : null }
  querySelector(sel: string): El | null {
    if (sel === '[data-sx="dock-full"]') return this.kids.full ?? null
    if (sel === '[data-sx="dock-focus"]') return this.kids.focus ?? null
    if (sel === '[data-sx="dock-stop-keep"]') return /data-sx="dock-stop-keep"/.test(this.innerHTML) ? this.kids.keep ?? (this.kids.keep = new El('keep')) : null
    if (sel === '.sx-reader-head') return this.kids.head ?? null
    return null
  }
  kids: Record<string, El> = {}
  focus() { this.focused++ }
  setPointerCapture() {}
  clientHeight = 0; offsetHeight = 0
}
interface Opts { docked?: boolean; stored?: string | null; storageThrows?: boolean; working?: boolean }
function page(o: Opts = {}) {
  const reader = new El('session-reader'), handle = new El('session-handle'), dock = new El('session-dock', 126), stop = new El('session-stop-row')
  reader.kids.full = new El('full'); reader.kids.focus = new El('focus'); reader.kids.head = Object.assign(new El('head'), { offsetHeight: 37 })
  reader.clientHeight = 463
  const ids: Record<string, El> = { 'session-reader': reader, 'session-handle': handle, 'session-dock': dock, 'session-stop-row': stop }
  const store: Record<string, string> = o.stored == null ? {} : { 'cos.sxDock': o.stored }
  const writes: string[] = []
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const localStorage = {
    getItem: (k: string) => { if (o.storageThrows) throw new Error('SecurityError'); return k in store ? store[k] : null },
    setItem: (k: string, v: string) => { if (o.storageThrows) throw new Error('QuotaExceeded'); store[k] = v; writes.push(v) },
  }
  const r: any = { live: { working: o.working !== false } }
  const ctx: Record<string, unknown> = {
    window: { localStorage, matchMedia: (q: string) => ({ matches: !!o.docked && q.includes('pointer: coarse'), addEventListener: () => {} }),
      addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ||= []).push(f) } },
    $: (id: string) => ids[id] ?? null, state: { reading: r }, Math, Infinity,
  }
  vm.createContext(ctx)
  vm.runInContext(DOCK + `
;this.api = { SX_DOCK: SX_DOCK, SX_DOCK_PX: SX_DOCK_PX, SX_DOCK_MQ: SX_DOCK_MQ, height: sxDockHeight, set: sxDockSet, next: sxDockNext, step: sxDockStep, snap: sxDockSnap,
  paint: sxDockPaint, stop: sxStopPaint, click: sxDockClick, key: sxDockKey, down: sxDockDown, move: sxDockMove, up: sxDockUp, hook: sxDockHook };`, ctx)
  const api = (ctx as { api: any }).api
  return { api, reader, handle, dock, stop, store, writes, r, listeners }
}

describe('the height: one value per device, Middle when nothing is stored (the lead 18:5x)', () => {
  it('nothing stored: middle; a stored height is used; anything else stored: middle', () => {
    expect(page().api.height()).toBe('middle')
    expect(page({ stored: 'focus' }).api.height()).toBe('focus')
    expect(page({ stored: 'full' }).api.height()).toBe('full')
    expect(page({ stored: 'tall' }).api.height()).toBe('middle')
    expect(page({ stored: '__proto__' }).api.height()).toBe('middle')
  })
  it('storage that throws: middle, and his choice still holds for this page', () => {
    const p = page({ storageThrows: true })
    expect(p.api.height()).toBe('middle')
    expect(() => p.api.set('focus')).not.toThrow()
    expect(p.api.height()).toBe('focus')
  })
  it('his choice is kept for the next open on this device', () => {
    const p = page(); p.api.set('full')
    expect(p.store['cos.sxDock']).toBe('full')
    expect(page({ stored: p.store['cos.sxDock'] }).api.height()).toBe('full')
  })
  it('an unknown height is never written', () => {
    const p = page(); p.api.set('huge'); p.api.set('')
    expect(p.writes).toEqual([]); expect(p.api.height()).toBe('middle')
  })
})

describe('only his drag, tap or keys change it', () => {
  it('a tap on the handle steps focus, middle, full, then focus again', () => {
    const p = page({ stored: 'focus' })
    p.api.click('dock-handle'); expect(p.api.height()).toBe('middle')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('focus')
  })
  it('the chat bubble opens full; pressed in full it goes back to middle; from focus it opens full', () => {
    const p = page(); p.api.click('dock-full'); expect(p.api.height()).toBe('full')
    p.api.click('dock-full'); expect(p.api.height()).toBe('middle')
    const f = page({ stored: 'focus' }); f.api.click('dock-full'); expect(f.api.height()).toBe('full')
  })
  it('expand goes to focus from middle or full; in focus it is "Show the reply box" and goes back to middle', () => {
    const p = page(); p.api.click('dock-focus'); expect(p.api.height()).toBe('focus')
    p.api.click('dock-focus'); expect(p.api.height()).toBe('middle')
    const f = page({ stored: 'full' }); f.api.click('dock-focus'); expect(f.api.height()).toBe('focus')
  })
  it('the arrow keys on the handle: up is a taller dock, down a shorter one, and they stop at the ends', () => {
    const p = page({ stored: 'focus' }), key = (k: string) => p.api.key({ target: p.handle, key: k, preventDefault() {} })
    key('ArrowDown'); expect(p.api.height()).toBe('focus')
    key('ArrowUp'); expect(p.api.height()).toBe('middle')
    key('ArrowUp'); expect(p.api.height()).toBe('full')
    key('ArrowUp'); expect(p.api.height()).toBe('full')
    key('ArrowDown'); expect(p.api.height()).toBe('middle')
    p.api.key({ target: p.handle, key: 'Enter', preventDefault() {} }); expect(p.api.height()).toBe('middle')
    p.api.key({ target: p.dock, key: 'ArrowUp', preventDefault() {} }); expect(p.api.height()).toBe('middle')   // not the handle
  })
  it('a drag lets go at the nearest height (68, 126, or full: the reader less 48, never under 126)', () => {
    const p = page()
    expect(p.api.snap(70, 378)).toBe('focus')
    expect(p.api.snap(96, 378)).toBe('focus')
    expect(p.api.snap(98, 378)).toBe('middle')
    expect(p.api.snap(250, 378)).toBe('middle')
    expect(p.api.snap(253, 378)).toBe('full')
    // A tiny reader: full is never under 126, so it sits at middle's height and a drag lands on middle (the bubble
    // and a tap still reach full).
    expect(p.api.snap(400, 40)).toBe('middle')
    expect(p.api.snap(40, 40)).toBe('focus')   // full is not taken at the tiny reader's own 40
  })
  it('the drag itself: the dock follows the finger, lets go at the nearest height, and the click after it is not a tap', () => {
    const p = page({ stored: 'middle' })
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 })
    p.api.move({ clientY: 0 }); expect(p.dock.style.height).toBe('378px')     // never past full (the reader less 48)
    p.api.move({ clientY: 1000 }); expect(p.dock.style.height).toBe('68px')   // never under focus
    p.api.move({ clientY: 340 })                          // up 160 px: the dock grows from 126
    expect(p.dock.style.height).toBe('286px')
    p.api.up({ clientY: 300 })                            // let go 200 px up: 326, nearest is full (378)
    expect(p.api.height()).toBe('full'); expect(p.dock.style.height).toBe('')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')   // the click the browser sends after a drag
    p.api.click('dock-handle'); expect(p.api.height()).toBe('focus')  // the next tap steps again
  })
  it('a press that moves less than 6 px is a tap, not a drag', () => {
    const p = page({ stored: 'middle' })
    p.api.down({ target: p.handle, clientY: 500, pointerId: 1 }); p.api.move({ clientY: 497 }); p.api.up({ clientY: 497 })
    expect(p.api.height()).toBe('middle'); expect(p.dock.style.height).toBe('')
    p.api.click('dock-handle'); expect(p.api.height()).toBe('full')
  })
  it('a press anywhere but the handle starts no drag', () => {
    const p = page(); p.api.down({ target: p.dock, clientY: 500 }); p.api.move({ clientY: 100 }); p.api.up({ clientY: 100 })
    expect(p.api.height()).toBe('middle'); expect(p.writes).toEqual([])
  })
  it('nothing else writes the height: in all of app.js, only sxDockSet writes it, and only his handlers call sxDockSet', () => {
    expect(APP.match(/SX_DOCK\.h\s*=[^=]/g)).toHaveLength(2)                  // sxDockSet, and sxDockHeight's first read
    expect(APP).toContain('if (!SX_DOCK.h) SX_DOCK.h = sxDockRead();')
    expect(APP.match(/setItem\(SX_DOCK_KEY/g)).toHaveLength(1)
    const calls = [...APP.matchAll(/sxDockSet\(/g)].length - 1                 // less its own definition
    expect(calls).toBe(5)                                                        // tap, bubble, expand, key, drag
    const inClick = between(APP, '  function sxDockClick(act) {', '  function sxDockKey(e) {').match(/sxDockSet\(/g)!.length
    const inKey = between(APP, '  function sxDockKey(e) {', '  function sxDockDown(e) {').match(/sxDockSet\(/g)!.length
    const inUp = between(APP, '  function sxDockUp(e) {', '  function sxDockHook() {').match(/sxDockSet\(/g)!.length
    expect([inClick, inKey, inUp]).toEqual([3, 1, 1])
    expect(calls - inClick - inKey - inUp).toBe(0)                               // no caller anywhere else
  })
  it('painting draws the stored height and never chooses one (a fold, a render, a frame)', () => {
    const p = page({ docked: true, stored: 'focus' })
    p.api.paint(); p.api.paint()
    expect(p.reader.attrs['data-dock']).toBe('focus'); expect(p.reader.cls.has('sx-docked')).toBe(true)
    expect(p.writes).toEqual([])
  })
})

describe('where it applies: phones and both Duo postures only (the lead 18:5x)', () => {
  it('the gate is a coarse pointer and under 600 px wide or at most 720 px tall (SHORT_TOUCH_MQ\'s numbers)', () => {
    expect(page().api.SX_DOCK_MQ).toBe('(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 720px)')
    expect(APP).toContain("var SHORT_TOUCH_MQ = '(pointer: coarse) and (max-height: 720px)';")
  })
  it('off the gate (a desktop, a tall tablet): no .sx-docked, no data-dock, today\'s dock', () => {
    const p = page({ docked: false, stored: 'full' }); p.api.paint()
    expect(p.reader.cls.has('sx-docked')).toBe(false); expect(p.reader.getAttribute('data-dock')).toBeNull()
  })
  it('every dock rule keys on .sx-docked, but the one that hides the new parts everywhere else', () => {
    const rules = DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean)
    const off = rules.filter(sel => !sel.split(',').every(part => /\.sx-docked/.test(part)))
    expect(off).toEqual(['.sx-dock-handle, .sx-dock-acts, .sx-x2, .sx-x2-note, .sx-stop-row', '.sx-dock-ico'])
    expect(DOCKCSS).toContain('.sx-dock-handle, .sx-dock-acts, .sx-x2, .sx-x2-note, .sx-stop-row { display: none; }')
  })
  it('the gate is read again on a fold or a resize (it repaints; the height stays his)', () => {
    const p = page(); p.api.hook(); p.api.hook()
    expect(p.listeners.resize).toHaveLength(1)
    expect(p.listeners.pointermove).toHaveLength(1); expect(p.listeners.pointerup).toHaveLength(1)
  })
})

describe('Stop: full only, never one tap, Keep working the default', () => {
  it('while working, full\'s Stop only asks: the first tap is not stop-session', () => {
    const p = page({ stored: 'full' }); p.api.stop(p.r)
    expect(p.stop.innerHTML).toBe('<button type="button" class="cx-btn quiet sx-stop-ask" data-sx="dock-stop">Stop</button>')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
  it('asked: "Stop this session?", Keep working filled and focused first, Stop to the right', () => {
    const p = page({ stored: 'full' }); p.api.click('dock-stop')
    expect(p.stop.innerHTML).toBe('<p class="sx-stop-q" id="session-stop-q">Stop this session?</p>' +
      '<button type="button" class="cx-btn primary sx-stop-keep" data-sx="dock-stop-keep" aria-describedby="session-stop-q">Keep working</button>' +
      '<button type="button" class="cx-btn danger sx-stop-go" data-action="stop-session">Stop</button>')
    expect(p.stop.kids.keep.focused).toBe(1)
    expect(p.stop.innerHTML.indexOf('dock-stop-keep')).toBeLessThan(p.stop.innerHTML.indexOf('stop-session'))
  })
  it('Keep working puts the one Stop back; a height change forgets the question', () => {
    const p = page({ stored: 'full' }); p.api.click('dock-stop'); p.api.click('dock-stop-keep')
    expect(p.stop.innerHTML).toContain('data-sx="dock-stop"'); expect(p.stop.innerHTML).not.toContain('stop-session')
    p.api.click('dock-stop'); p.api.click('dock-focus'); p.api.click('dock-full')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
  it('not working: no Stop at all', () => {
    const p = page({ stored: 'full', working: false }); p.api.stop(p.r)
    expect(p.stop.innerHTML).toBe('')
  })
  it('the lead 18:5x: Stop cannot be reached in one tap from focus or middle', () => {
    // No Stop on the working line while docked, and the Stop row is drawn in full only.
    expect(DOCKCSS).toContain('.sx-docked .sx-act-label, .sx-docked .sx-act-prompt, .sx-docked .sx-act-stop, .sx-docked .sx-act-tail { display: none; }')
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-form > .sx-x2-note, .sx-docked:not([data-dock='full']) #session-form > .sx-stop-row,")
    expect(DOCKCSS).toContain(".sx-docked[data-dock='focus'] #session-verdict, .sx-docked[data-dock='focus'] #session-form,")
    // The reader has two Stops that stop: the working line's (not drawn docked) and the answer to the ask.
    expect(APP.match(/data-action="stop-session"/g)).toHaveLength(2)
    expect(APP).toContain('<button type="button" class="cx-btn quiet sx-act-stop" data-action="stop-session">Stop</button>')
    // The working line's two buttons only change the height.
    const p = page({ stored: 'middle' }); p.api.click('dock-full'); p.api.click('dock-focus')
    expect(p.stop.innerHTML).not.toContain('stop-session')
  })
})

describe('the one note (README "The working note")', () => {
  function note(o: { provider?: string; midTurn?: boolean; files?: boolean; passkey?: boolean }) {
    const ctx: Record<string, unknown> = {
      phoneEngine: (r: any) => (r.provider === 'codex' ? 'Codex' : r.provider === 'cursor' ? 'Cursor' : 'Claude'),
      sxProvider: (p: string) => (p === 'codex' || p === 'cursor' ? p : 'claude'), sxReaderHasFiles: () => !!o.files, WEB_KEY: { views: [] },
    }
    vm.createContext(ctx)
    vm.runInContext(NOTE + ';this.note = sxWorkNote;', ctx)
    return (ctx as any).note({ provider: o.provider || 'claude', verdict: { midTurn: !!o.midTurn } }, !!o.passkey, o.files)
  }
  it('a session that takes a message mid-turn: Queue message lands at its next step', () => {
    expect(note({ midTurn: true, passkey: true })).toBe('Claude is working. Queue message lands at its next step. Send with passkey opens when it stops.')
  })
  it('one that does not: it waits and lands when this turn ends', () => {
    expect(note({ passkey: true })).toBe('Claude is working. A message you send waits and lands when this turn ends. Send with passkey opens when it stops.')
  })
  it('with files in the box: a message with files waits for the turn end', () => {
    expect(note({ midTurn: true, files: true, passkey: true })).toBe('Claude is working. A message with files waits and lands when this turn ends. Send with passkey opens when it stops.')
  })
  it('Codex and Cursor say their own', () => {
    expect(note({ provider: 'codex', passkey: true })).toBe('Codex is working. A message you send joins the Codex app’s queue for this thread. Send with passkey opens when it stops.')
    expect(note({ provider: 'cursor', passkey: true })).toBe('Cursor is working. A message you send goes into this Cursor chat when its turn ends. Send with passkey opens when it stops.')
  })
  it('the passkey sentence only where the passkey button exists', () => {
    expect(note({ midTurn: true, passkey: false })).toBe('Claude is working. Queue message lands at its next step.')
  })
  it('sxPaOn: true only for this session, and only where its form carries pa-on', () => {
    const r1 = {}, r2 = {}, form = (on: boolean) => ({ classList: { contains: (c: string) => on && c === 'pa-on' } })
    const ctx: Record<string, unknown> = { WEB_KEY: { views: [{ r: r1, view: { form: form(true) } }, { r: r2, view: { form: form(false) } }] } }
    vm.createContext(ctx); vm.runInContext(NOTE + ';this.paOn = sxPaOn;', ctx)
    const paOn = (ctx as any).paOn
    expect(paOn(r1)).toBe(true); expect(paOn(r2)).toBe(false); expect(paOn({})).toBe(false); expect(paOn(null)).toBe(false)
  })
  it('one note: where the passkey composer is on, the reader\'s, the Answer box\'s and Today\'s park notes are not drawn', () => {
    expect(APP).toContain("if (sxParkNoteShows(r) && !paOn) html = '<div class=\"sx-park\"><p>' + esc(sxParkLine(r)) + '</p>'")
    expect(APP).toContain("return sxParkNoteShows(r) && !sxPaOn(r) ? '<div class=\"sx-park\"><p>' + esc(sxParkLine(r, false)) + '</p></div>' : '';")
    expect(TA).toContain("if (K.feed.parkNoteShows(r) && !(typeof K.paOn === 'function' && K.paOn(r))) html = '<p class=\"sx-park\">'")
    expect(APP).toContain('paOn: sxPaOn,')
  })
})

describe('the markup and the CSS', () => {
  it('the dock opens with the handle and the working line with its two 44 px buttons; full\'s parts live inside the form', () => {
    expect(APP).toContain('\'<button type="button" class="sx-dock-handle" id="session-handle" data-sx="dock-handle" aria-valuetext="middle"><span aria-hidden="true"></span></button>\' +')
    expect(APP).toContain('data-sx="dock-full" aria-pressed="false" aria-label="Show all actions">')
    expect(APP).toContain('data-sx="dock-focus" aria-label="Expand the thread">')
    expect(APP).toContain('<div class="sx-x2"><button type="button" class="cx-btn quiet" data-action="fork-session"')
    expect(APP).toContain('\'<div class="sx-stop-row" id="session-stop-row"></div>\' +')
    expect(DOCKCSS).toContain('.sx-docked .sx-dock-btn { display: grid; place-items: center; width: 44px; height: 44px;')
    expect(DOCKCSS).toContain('.sx-docked .sx-stop-ask, .sx-docked .sx-stop-keep, .sx-docked .sx-stop-go { min-height: 44px; }')
    // The handle is 20 px to see and 44 to touch: 24 more above it.
    expect(DOCKCSS).toContain('height: 20px;')
    expect(DOCKCSS).toContain(".sx-docked .sx-dock-handle::before { content: ''; position: absolute; left: 0; right: 0; top: -24px; bottom: 0; }")
  })
  it('the plain send keeps 140 px for both its labels, so the field never moves', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-send { grid-area: send; width: 140px; min-height: 44px; }')
    expect(DOCKCSS).toContain("grid-template-columns: auto auto minmax(0, 1fr) 140px;")
  })
  it('one Fork: the composer\'s small Fork is not drawn docked, and the busy box\'s is not drawn beside full\'s', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-form .sx-fork-small { display: none; }')
    expect(DOCKCSS).toContain(".sx-docked[data-dock='full'] #session-verdict [data-action='fork-session'] { display: none; }")
  })
  it('camera, attach and the passkey send live in full only', () => {
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-form > .pa-note, .sx-docked:not([data-dock='full']) #session-form .pa-go,")
    expect(DOCKCSS).toContain(".sx-docked:not([data-dock='full']) #session-clip, .sx-docked:not([data-dock='full']) #session-form > .sx-x2,")
  })
  it('a request card up keeps Approve and send in the reply row at every height (the lead 18:5x: not flipped)', () => {
    expect(DOCKCSS).toContain('.sx-docked #session-form.pa-req .pa-go { grid-area: send; width: 140px; }')
    expect(DOCKCSS).toContain(".sx-docked[data-dock='middle'] #session-form.pa-req .pa-go { display: inline-flex; }")
  })
  it('full: 48 px of thread stay; the dock never under 126', () => {
    expect(DOCKCSS).toContain("html.sx-frame .sx-docked[data-dock='full'] .sx-body { flex: 0 0 48px; }")
    expect(DOCKCSS).toContain("html.sx-frame .sx-docked[data-dock='full'] .sx-dock { flex: 1 1 auto; min-height: 126px; }")
  })
  it('keyboard up in middle at 382x557 (the mock\'s arithmetic): the reply row fits and the thread keeps 47 px', () => {
    // README "Keyboard up, folded": 291 pt leaves 266 px; the top bar 48, the workspace 12 and a 33 px header stay.
    const visible = 266, chrome = 48 + 12 + 33, middle = page().api.SX_DOCK_PX.middle
    expect(middle).toBe(126)
    expect(visible - chrome - middle).toBeGreaterThanOrEqual(47)
    // The middle dock is the handle 20, the working line 44 and the reply row: nothing else is drawn there.
    expect(DOCKCSS).toContain('.sx-docked .sx-wline { display: flex; align-items: center; gap: 8px; flex: none; min-height: 44px; }')
  })
  it('no motion on a height change (reduced motion is respected by having none)', () => {
    expect(DOCKCSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/transition|animation/)
  })
  it('the send rule\'s weight everywhere the passkey composer runs; a request card keeps today\'s', () => {
    expect(CHATCSS).toContain('.composer.pa-on:not(.pa-req) .pa-go, .rr-answer.pa-on:not(.pa-req) .pa-go { background: transparent; color: var(--accent); border: 1px solid var(--accent); }')
    expect(CHATCSS).toContain('.rr-answer.pa-on:not(.pa-req) #rr-send { background: var(--accent); color: var(--on-accent); border-color: var(--accent); min-height: 44px; }')
  })
})
