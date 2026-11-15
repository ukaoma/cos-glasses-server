/**
 * Folded reader item 1 (the build after 7.0.43, F1's scope, lead accepted): the page's own "1 question for you" bar
 * (#sq-host) leaves out the questions of the session the reader is showing now (its card is drawn there), and counts the
 * others. Runs the real panes/questions.js in a vm with a fake COSWeb route, the page host and a reader mount.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'questions.js'), 'utf8')
const el = () => ({ hidden: true, innerHTML: '', isConnected: true, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: { setProperty() {} } })

function load() {
  const host = el()
  const winL: Record<string, Array<() => void>> = {}
  const route = { pane: 'today', args: [] as string[] }
  const W: any = { esc: (s: unknown) => String(s), toast() {}, onShell() {}, noteServer() {}, api: () => Promise.resolve({}), parseRoute: () => route }
  const document = { getElementById: (id: string) => (id === 'sq-host' ? host : null), addEventListener() {}, hidden: false, activeElement: null }
  const ctx = vm.createContext({
    window: { COSWeb: W, addEventListener: (t: string, fn: () => void) => { (winL[t] ??= []).push(fn) } }, document, fetch: () => new Promise(() => {}), console, Date, JSON, Math, Promise,
    crypto: globalThis.crypto, isFinite, AbortController, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  })
  vm.runInContext(SRC, ctx)
  const Qs = W.sessionQuestions
  const item = (id: string, sid: string) => ({ id, sessionId: sid, provider: 'claude', kind: 'question', tool: 'AskUserQuestion', createdAt: new Date(Date.now() - 5000).toISOString(),
    deadlineAt: new Date(Date.now() + 115000).toISOString(), answerable: true, awayHold: false, waitingAtMac: false, questions: [{ question: 'Which branch?', header: '', multiSelect: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] }] })
  const go = (pane: string, args: string[] = []) => { route.pane = pane; route.args = args; (winL.hashchange || []).forEach(fn => fn()) }
  const bar = () => (host.hidden ? null : (/sq-banner-text">([^<]*)</.exec(host.innerHTML) || [])[1] ?? '(cards, no banner)')
  return { Qs, host, item, go, bar, route, winL }
}
const A = 'aaaaaaaa-1111-4111-8111-111111111111', B = 'bbbbbbbb-2222-4222-8222-222222222222'
const pq = (n: number) => 'pq_' + String(n).repeat(24).slice(0, 24)

describe('the page bar leaves out the session the reader is showing', () => {
  it('only this session waits: the bar is hidden while its reader shows the card', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    expect(h.bar()).toBe('1 question for you.')
    h.go('sessions', ['claude', A])
    const reader = el(); h.Qs.mount(reader, A, () => {})
    expect(h.host.hidden).toBe(true)
    expect(reader.innerHTML).toContain('Which branch?')
  })
  it('another session waits too: the bar stays and counts only the others', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A), h.item(pq(2), B)], [], [], null)
    expect(h.bar()).toBe('2 questions for you.')
    h.go('sessions', ['claude', A])
    h.Qs.mount(el(), A, () => {})
    expect(h.bar()).toBe('1 question for you.')
  })
  it('leaving the reader brings the session back to the bar at once (the reader left in the DOM does not count)', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    h.go('sessions', ['claude', A]); h.Qs.mount(el(), A, () => {})
    expect(h.host.hidden).toBe(true)
    h.go('today')
    expect(h.bar()).toBe('1 question for you.')
  })
  it('a reader whose cards are not mounted keeps the bar', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    h.go('sessions', ['claude', A])
    expect(h.bar()).toBe('1 question for you.')
  })
  it('a reader of another session leaves this one on the bar; the session list (no reader) too', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    h.go('sessions', ['claude', B]); h.Qs.mount(el(), B, () => {})
    expect(h.bar()).toBe('1 question for you.')
    h.go('sessions', [])
    expect(h.bar()).toBe('1 question for you.')
  })
  it('a disconnected reader mount (another session opened over it) does not hide the bar', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    const reader = el(); h.go('sessions', ['claude', A]); h.Qs.mount(reader, A, () => {})
    expect(h.host.hidden).toBe(true)
    reader.isConnected = false
    h.go('sessions', ['claude', A])
    expect(h.bar()).toBe('1 question for you.')
  })
  it('a stale reader mount, not yet swept, does not hide the bar when another card host mounts (Today\'s sheet)', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A), h.item(pq(2), B)], [], [], null)
    const old = el(); h.go('sessions', ['claude', A]); h.Qs.mount(old, A, () => {})
    expect(h.bar()).toBe('1 question for you.')
    old.isConnected = false               // the reader redrew; no render has swept the old mount yet
    h.Qs.mount(el(), B, () => {})         // another host mounts and redraws the bar
    expect(h.bar()).toBe('2 questions for you.')
  })
  it('only the Sessions reader: another pane with an id-shaped address and a mount for that session keeps the bar', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    h.go('meetings', ['view', A]); h.Qs.mount(el(), A, () => {})
    expect(h.bar()).toBe('1 question for you.')
  })
  it('case of the id does not matter', () => {
    const h = load()
    h.Qs._take([h.item(pq(1), A)], [], [], null)
    h.go('sessions', ['claude', A.toUpperCase()]); h.Qs.mount(el(), A.toUpperCase(), () => {})
    expect(h.host.hidden).toBe(true)
  })
  it('the bar redraw in mount() runs fitKeyboard, as render() does (Q1 18:37 note)', () => {
    const SRC2 = SRC.slice(SRC.indexOf('  function mount(el, sessionId, onChange) {'))
    expect(SRC2.slice(0, SRC2.indexOf('\n  }\n'))).toContain("if (host) { drawInto({ el: host, sessionId: null, scope: 'sq' }); fitKeyboard(); }")
  })
  it('the route change listener is there', () => {
    expect(load().winL.hashchange?.length).toBe(1)
  })
})
