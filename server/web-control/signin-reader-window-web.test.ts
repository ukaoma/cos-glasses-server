/**
 * Folded reader item 3 (the build after 7.0.43, F1's scope, lead accepted): on a folded phone's session reader the
 * sign-in line shows only in the last 2 hours before the sign-in ends; Today and every other pane keep the 24-hour
 * notice, and unfolded the reader keeps it too. The Mac-not-answering line is never held back. Runs app.js's own
 * reachability and sign-in block (connPaint) with a fake route and matchMedia.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8')
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function block(startMark: string, endMark: string): string {
  const a = APP.indexOf(startMark), b = APP.indexOf(endMark)
  expect(a, startMark).toBeGreaterThan(0); expect(b, endMark).toBeGreaterThan(a)
  return APP.slice(a, b)
}
const CONN = block('  // ── Mac reachability and sign-in lifetime (W1', '  // ── end Mac reachability and sign-in lifetime')
const H = 3600000

// 7.0.51: the window's size, not a flag. folded = the folded Duo (382 x 557); not folded = a tall desktop (1280 x 800),
// unless a size is given (the open Duo, 951 x 539). The fake evaluates the media list the way the browser does.
const SIZES = { folded: { w: 382, h: 557 }, tall: { w: 1280, h: 800 }, openDuo: { w: 951, h: 539 } }
function mq(q: string, s: { w: number; h: number }): boolean {
  return q.split(',').some(part => { const m = /^\s*\(max-(width|height): (\d+)px\)\s*$/.exec(part); if (!m) throw new Error('unexpected media query: ' + q); return (m[1] === 'width' ? s.w : s.h) <= Number(m[2]) })
}
function conn(o: { pane: string; args?: string[]; folded: boolean; size?: { w: number; h: number }; up?: boolean; endsIn: number }) {
  const box = { innerHTML: '', hidden: true }
  const m = new Map<string, string>()
  const route = { pane: o.pane, args: o.args ?? [] }
  const media: { folded: boolean; size?: { w: number; h: number } } = { folded: o.folded, size: o.size }
  const deps = {
    api: () => Promise.resolve({}), esc, clock: () => 'T', $: (id: string) => (id === 'conn-notice' ? box : null),
    SERVER: { up: o.up ?? true, hooks: [], lastUpAt: 0 }, noteServer() {}, route() {}, document: { hidden: false },
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)) }, removeItem: (k: string) => { m.delete(k) } },
    navigator: { onLine: true }, setTimeout: () => 0, clearTimeout() {},
    parseRoute: () => route,
    matchMedia: (q: string) => ({ matches: mq(q, media.size ?? (media.folded ? SIZES.folded : SIZES.tall)) }),
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${CONN}\nreturn { connPaint, signinRemember, signinWarnMs, READER: SIGNIN_WARN_READER_MS, DAY: SIGNIN_WARN_MS };\n}`)(deps)
  fns.signinRemember({ expiresAt: new Date(Date.now() + o.endsIn).toISOString() })
  fns.connPaint()
  return { fns, box, route, media, line: () => box.innerHTML.includes('Sign-in here ends ') }
}
const READER = ['claude', 'aaaaaaaa-1111-4111-8111-111111111111']

describe('the sign-in line on a folded session reader: the last 2 hours only', () => {
  it('folded reader, 5 hours left: no sign-in line', () => {
    expect(conn({ pane: 'sessions', args: READER, folded: true, endsIn: 5 * H }).line()).toBe(false)
  })
  it('folded reader, 90 minutes left: the line shows', () => {
    expect(conn({ pane: 'sessions', args: READER, folded: true, endsIn: 1.5 * H }).line()).toBe(true)
  })
  it('the window is exactly 2 hours there, 24 hours elsewhere', () => {
    const h = conn({ pane: 'sessions', args: READER, folded: true, endsIn: 5 * H })
    expect(h.fns.READER).toBe(2 * H); expect(h.fns.DAY).toBe(24 * H)
    expect(h.fns.signinWarnMs()).toBe(2 * H)
    h.media.folded = false; expect(h.fns.signinWarnMs()).toBe(24 * H)
    h.media.folded = true; h.route.args = []; expect(h.fns.signinWarnMs()).toBe(24 * H)
    h.route.pane = 'today'; h.route.args = READER; expect(h.fns.signinWarnMs()).toBe(24 * H)
  })
  it('7.0.51: the open Duo (951 x 539, under 620 px tall) is treated like the folded phone: 2 hours in the reader', () => {
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: SIZES.openDuo, endsIn: 5 * H }).line()).toBe(false)
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: SIZES.openDuo, endsIn: 1.5 * H }).line()).toBe(true)
    // Exactly at the edges: 619 tall counts, 620 does not; 599 wide counts, 600 (tall) does not.
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: { w: 1280, h: 619 }, endsIn: 5 * H }).line()).toBe(false)
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: { w: 1280, h: 620 }, endsIn: 5 * H }).line()).toBe(true)
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: { w: 599, h: 900 }, endsIn: 5 * H }).line()).toBe(false)
    expect(conn({ pane: 'sessions', args: READER, folded: false, size: { w: 600, h: 900 }, endsIn: 5 * H }).line()).toBe(true)
    // Today on the open Duo keeps the 24-hour notice: the rule is the reader's only.
    expect(conn({ pane: 'today', folded: false, size: SIZES.openDuo, endsIn: 5 * H }).line()).toBe(true)
  })
  it('unfolded, the reader keeps the 24-hour notice', () => {
    expect(conn({ pane: 'sessions', args: READER, folded: false, endsIn: 5 * H }).line()).toBe(true)
  })
  it('folded, Today and the session list keep the 24-hour notice', () => {
    expect(conn({ pane: 'today', folded: true, endsIn: 5 * H }).line()).toBe(true)
    expect(conn({ pane: 'sessions', folded: true, endsIn: 5 * H }).line()).toBe(true)
  })
  it('leaving the reader brings the line back on the next paint (route() and a resize repaint it)', () => {
    const h = conn({ pane: 'sessions', args: READER, folded: true, endsIn: 5 * H })
    expect(h.line()).toBe(false)
    h.route.pane = 'today'; h.route.args = []
    h.fns.connPaint()
    expect(h.line()).toBe(true)
    const route = block('  function route(forceChanged) {', '    var changedPane')
    expect(route).toContain("if (typeof connPaint === 'function') connPaint();")
    expect(APP).toContain("window.addEventListener('resize', function () { if (typeof connPaint === 'function') connPaint(); });")
  })
  it('the Mac not answering always shows on the folded reader', () => {
    const h = conn({ pane: 'sessions', args: READER, folded: true, up: false, endsIn: 5 * H })
    expect(h.box.hidden).toBe(false)
    expect(h.box.innerHTML).toContain('COS on your Mac is not answering.')
    expect(h.line()).toBe(false)
  })
  it('no route or media helpers (an older harness): the 24-hour window', () => {
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', `with (deps) {\n${CONN}\nreturn { signinWarnMs };\n}`)({ api() {}, esc, clock() {}, $: () => null, SERVER: { up: true, hooks: [] }, noteServer() {}, route() {}, document: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, setTimeout() {}, clearTimeout() {} })
    expect(fns.signinWarnMs()).toBe(24 * H)
    // A route helper that throws: the 24-hour window, never the shorter one.
    // eslint-disable-next-line no-new-func
    const bad = new Function('deps', `with (deps) {\n${CONN}\nreturn { signinWarnMs };\n}`)({ api() {}, esc, clock() {}, $: () => null, SERVER: { up: true, hooks: [] }, noteServer() {}, route() {}, document: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, setTimeout() {}, clearTimeout() {}, parseRoute: () => { throw new Error('no route') }, matchMedia: () => ({ matches: true }) })
    expect(bad.signinWarnMs()).toBe(24 * H)
  })
})
