/**
 * Folded reader item 4 (the build after 7.0.43; lead 17:35, F1's scope): a reader that opens on a waiting question lands
 * with the question card's top at the top of the reader's scroll (#session-body), not at the card's end. Only at open:
 * a question that arrives later, a live line, a refresh or the question changing never moves him; a session with no
 * waiting question opens at its newest line, as before. These run the real app.js pin code (sxPinTo, sxPinApply,
 * sxQuestionTop, sxOpenOnQuestion, sxAtEnd) on fake rects; F1 measures it in WebKit at 382 x 557, 449 x 798, 1119 x 787.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function slice(text: string, start: string, end: string) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1); expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const PIN_SRC = slice(APP, '  function sxFrameSync() {', "  // 7.0.1: the hero's counts say")
const ATEND_SRC = slice(APP, '  function sxAtEnd() {', '\n  }\n') + '\n  }\n'

class FakeClass { s = new Set<string>(); toggle(c: string, on?: boolean) { const v = on === undefined ? !this.s.has(c) : on; if (v) this.s.add(c); else this.s.delete(c); return v } contains(c: string) { return this.s.has(c) } add(c: string) { this.s.add(c) } remove(...cs: string[]) { cs.forEach(c => this.s.delete(c)) } }

// A reader: the body's top on screen at bodyTop, its scroll at scrollTop; the card's top on screen = cardAt - scrollTop
// (cardAt is the card's offset inside the scrolled content, plus bodyTop).
function reader(o: { card?: boolean; cardAt?: number; frame?: boolean } = {}) {
  const de: any = { classList: new FakeClass() }
  if (o.frame !== false) de.classList.add('sx-frame')
  const listeners: Record<string, Array<() => void>> = {}
  const bodyTop = 120
  const body: any = {
    id: 'session-body', isConnected: true, scrollTop: 0, scrollHeight: 3000, clientHeight: 110, children: [{}, {}, {}],
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn) },
    getBoundingClientRect: () => ({ top: bodyTop, bottom: bodyTop + 110 }),
  }
  const lay = { cardAt: o.cardAt ?? 2600 }
  const q: any = { children: o.card === false ? [] : [{}], get textContent() { return o.card === false ? '' : 'Which branch should I use?' },
    getBoundingClientRect: () => ({ top: bodyTop + lay.cardAt - body.scrollTop }) }
  const ros: Array<{ cb: () => void }> = []
  class RO { constructor(cb: () => void) { ros.push({ cb }) } observe() {} disconnect() {} }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const scrolls: number[][] = []
  let now = 1_000_000
  class FakeDate extends Date { static now() { return now } }
  const state: any = { pane: 'sessions', reading: null }
  const deps: any = {
    window: { innerWidth: 382, innerHeight: 557, visualViewport: { offsetLeft: 0, width: 382, height: 557, offsetTop: 0 }, scrollTo: (x: number, y: number) => scrolls.push([x, y]), COSWeb: { onKeyboard() {} } },
    document: { documentElement: de, querySelector: () => null },
    state, SX: { view: 'sessions' },
    $: (id: string) => (id === 'session-body' ? body : id === 'session-questions' ? q : null),
    viewportFit: () => ({ top: 0, height: 557, vv: true }), layoutCrumb: () => true,
    ResizeObserver: RO, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length },
    Date: FakeDate,
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${PIN_SRC}\n${ATEND_SRC}\nreturn { newest: sxToNewest, question: sxToQuestion, apply: sxPinApply, top: sxQuestionTop, open: sxOpenOnQuestion, atEnd: sxAtEnd, unpin: sxUnpin, PIN: SX_PIN, OPEN_MS: SX_OPEN_Q_MS, GAP: SX_Q_GAP, USER_MS: SX_PIN_USER_MS };\n}`)(deps)
  const fire = (t: string) => (listeners[t] || []).forEach(fn => fn())
  return { k, body, q, lay, ros, timers, scrolls, state, de, fire, tick: (ms: number) => { now += ms }, now: () => now }
}

describe('the pin holds the question card’s top', () => {
  it('Go to the question / an open on a question: the card’s top lands at the body’s top (less the 8 px gap)', () => {
    const h = reader()
    h.k.question()
    expect(h.k.PIN.mode).toBe('question')
    expect(h.body.scrollTop).toBe(2600 - h.k.GAP)
    expect(h.k.PIN.put).toBe(h.body.scrollTop)
    // On screen, the card's top is 8 px under the body's top.
    expect(h.q.getBoundingClientRect().top - h.body.getBoundingClientRect().top).toBe(h.k.GAP)
  })
  it('what mounts above the card (turns, images) does not move him off the card: the observer keeps its top in place', () => {
    const h = reader()
    h.k.question()
    h.lay.cardAt = 2900; h.body.scrollHeight = 3300   // an image preview above grew by 300 px
    h.ros[0]!.cb()
    expect(h.body.scrollTop).toBe(2900 - h.k.GAP)
    h.timers.forEach(t => t.fn())                        // the 250 and 900 ms passes hold it too
    expect(h.body.scrollTop).toBe(2900 - h.k.GAP)
  })
  it('a card that is gone (answered) falls back to the newest line', () => {
    const h = reader()
    h.k.question()
    h.q.children = []
    h.ros[0]!.cb()
    expect(h.k.PIN.mode).toBe('newest')
    expect(h.body.scrollTop).toBe(h.body.scrollHeight)
  })
  it('no card at all: Go to the question is the newest line', () => {
    const h = reader({ card: false })
    h.k.question()
    expect(h.k.PIN.mode).toBe('newest')
    expect(h.body.scrollTop).toBe(3000)
  })
  it('held on the card, any scroll of his own of more than 4 px lets go, toward the end too', () => {
    const h = reader()
    h.k.question()
    h.fire('touchstart')
    h.body.scrollTop = h.body.scrollHeight - h.body.clientHeight   // he scrolls down to the very end
    h.fire('scroll')
    expect(h.k.PIN.body).toBe(null)
    expect(h.k.PIN.mode).toBe('newest')
  })
  it('held on the newest line, his scroll at the end keeps it (unchanged)', () => {
    const h = reader()
    h.k.newest()
    h.fire('touchstart')
    h.body.scrollTop = h.body.scrollHeight - h.body.clientHeight
    h.fire('scroll')
    expect(h.k.PIN.body).toBe(h.body)
  })
  it('a scroll the browser makes on its own (no touch) never lets go of the card', () => {
    const h = reader()
    h.k.question()
    h.tick(5000)
    h.body.scrollTop -= 200
    h.fire('scroll')
    expect(h.k.PIN.body).toBe(h.body)
  })
  it('held on the card is not "at the end": the turns above it were not shown', () => {
    const h = reader()
    h.k.question()
    expect(h.k.atEnd()).toBe(false)
    h.k.newest()
    expect(h.k.atEnd()).toBe(true)
  })
  it('a redraw while held (sxMergeTurns) keeps the pin’s place, whichever mode', () => {
    const merge = slice(APP, '  function sxMergeTurns(', '\n  }\n')
    expect(merge).toContain("if (body && typeof SX_PIN === 'object' && SX_PIN.body === body) { sxPinApply(body); return; }")
  })
})

describe('only at open', () => {
  const opened = (h: ReturnType<typeof reader>) => { const r: any = { openAt: h.now(), openQ: 'pending' }; h.state.reading = r; return r }
  it('a question in the first draw: lands on the card, once', () => {
    const h = reader(); const r = opened(h)
    expect(h.k.open(r, 1)).toBe(true)
    expect(r.openQ).toBe('done'); expect(h.k.PIN.mode).toBe('question'); expect(h.body.scrollTop).toBe(2600 - h.k.GAP)
    // The question changing, or a second card, later: no move.
    h.body.scrollTop = 1234
    expect(h.k.open(r, 2)).toBe(false)
    expect(h.body.scrollTop).toBe(1234)
  })
  it('no question yet: still waiting, nothing moves', () => {
    const h = reader(); const r = opened(h)
    expect(h.k.open(r, 0)).toBe(false)
    expect(r.openQ).toBe('pending'); expect(h.body.scrollTop).toBe(0)
  })
  it('a question that arrives within the open window and before any touch still lands', () => {
    const h = reader(); const r = opened(h)
    h.k.newest()
    h.tick(h.k.OPEN_MS - 1)
    expect(h.k.open(r, 1)).toBe(true)
    expect(h.k.PIN.mode).toBe('question')
  })
  it('a question that arrives after the window: no move, and never again', () => {
    const h = reader(); const r = opened(h)
    h.k.newest(); const at = h.body.scrollTop
    h.tick(h.k.OPEN_MS + 1)
    expect(h.k.open(r, 1)).toBe(false)
    expect(r.openQ).toBe('done'); expect(h.body.scrollTop).toBe(at); expect(h.k.PIN.mode).toBe('newest')
  })
  it('he touched the reader first: no move', () => {
    const h = reader(); const r = opened(h)
    h.k.newest()
    h.tick(300); h.fire('pointerdown')
    expect(h.k.open(r, 1)).toBe(false)
    expect(r.openQ).toBe('done'); expect(h.k.PIN.mode).toBe('newest')
  })
  it('another session opened since: no move', () => {
    const h = reader(); const r = opened(h)
    h.state.reading = { openQ: 'pending', openAt: h.now() }
    expect(h.k.open(r, 1)).toBe(false)
    expect(h.body.scrollTop).toBe(0)
  })
})

describe('the open path and Go to the question are wired to it', () => {
  const open = slice(APP, '  function openSession(provider, id) {', '    }).catch(function (err) {')
  it('the cards’ draws report their count to the open rule, every draw', () => {
    expect(open).toContain("r.openAt = Date.now(); r.openQ = 'pending';")
    expect(open).toContain('var openOnQuestion = function (n) { return sxOpenOnQuestion(r, n); };')
    expect(open).toContain('r.qMount = qk.mount(qhost, id, function (n) {')
    expect(open).toContain('openOnQuestion(Number(n) || 0);')
  })
  it('the first frame: a card already drawn lands on it; else the newest line when there are turns', () => {
    expect(open).toContain("if (r.openQ === 'done' && SX_PIN.mode === 'question') return sxToQuestion();")
    expect(open).toContain('if (n > 0 && openOnQuestion(n)) return;')
    expect(open).toContain("if (turns.length) { if (typeof sxToNewest === 'function') sxToNewest(); else window.scrollTo(0, document.documentElement.scrollHeight); }")
  })
  it('Go to the question lands on the card’s top', () => {
    expect(APP).toContain("if (act === 'goto-question') { sxToQuestion(); sxGoQuestionPaint();")
  })
})
