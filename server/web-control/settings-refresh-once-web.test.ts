/**
 * The build after 7.0.43 (lead 19:09; W1's note on F1's fc4cb500): Settings Refresh does not start a second load while
 * one runs. A double tap used to start two loads; the first answer cleared `refreshing`, so the second landed as a plain
 * load (no kept sections, no typed text kept, no failure line). A refresh that has run REFRESH_STUCK_MS (30 s) no longer
 * blocks one. Runs the real panes/settings.js in a vm and counts the reads it starts.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'settings.js'), 'utf8')

function load() {
  const listeners: Record<string, (e: unknown) => void> = {}
  const pane: any = { innerHTML: '', addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn }, querySelectorAll: () => [], querySelector: () => null,
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} } }
  const held: Array<{ path: string; res: (v: unknown) => void }> = []
  let holding = false
  const answers: Record<string, unknown> = { '/api/health': { status: 'ok' }, '/api/today/brief/settings': { enabled: true, dailyCap: 20, min: 1, max: 100 }, '/api/domains': { domains: [] } }
  const reads: string[] = []
  let defn: any = null
  const W: any = {
    $: (id: string) => (id === 'pane-settings' ? pane : null), esc: (s: unknown) => String(s), md: (s: unknown) => String(s), state: { serverName: 'Mac' }, skeletonRows: () => '',
    toast() {}, copyText: () => Promise.resolve(), parseRoute: () => ({ pane: 'settings', args: [] }), go() {}, setCrumb() {}, armTap: () => true, petPrefs: () => ({}), setPetPrefs() {}, resetTodayBrief() {},
    clock: () => '4:00 PM', registerPane: (_n: string, d: any) => { defn = d },
    api: (path: string) => {
      const key = path.split('?')[0]; reads.push(key)
      if (holding) return new Promise(res => held.push({ path: key, res }))
      return key in answers ? Promise.resolve(answers[key]) : Promise.reject(Object.assign(new Error('404'), { status: 404 }))
    },
  }
  const clock = { now: Date.UTC(2026, 10, 14, 19, 0, 0) }
  class FakeDate extends Date { constructor(...a: unknown[]) { super(...((a.length ? a : [clock.now]) as [number])) } static now() { return clock.now } }
  const ctx = vm.createContext({ window: { COSWeb: W }, document: { activeElement: null, getElementById: () => null }, console, Promise, Number, String, isFinite, Date: FakeDate, Array, Object, JSON, Math, setTimeout, clearTimeout })
  vm.runInContext(SRC, ctx)
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) }
  const click = (act: string) => listeners.click!({ target: { closest: (sel: string) => (sel === '[data-set]' ? { getAttribute: (k: string) => (k === 'data-set' ? act : null) } : null) } })
  const health = () => reads.filter(r => r === '/api/health').length
  const release = async () => { holding = false; for (const h of held.splice(0)) h.res(answers[h.path] ?? null); await flush() }
  return { open: async () => { defn.load([]); await flush() }, click, flush, health, hold: () => { holding = true }, release, clock }
}

describe('Settings Refresh: one load at a time', () => {
  it('a second tap while the first refresh loads starts nothing', async () => {
    const h = load(); await h.open()
    const first = h.health()
    h.hold(); h.click('refresh'); await h.flush()
    expect(h.health()).toBe(first + 1)
    h.click('refresh'); await h.flush()
    expect(h.health(), 'no second load').toBe(first + 1)
    await h.release()
  })
  it('once the refresh has landed, the next tap refreshes again', async () => {
    const h = load(); await h.open()
    const first = h.health()
    h.click('refresh'); await h.flush()
    h.click('refresh'); await h.flush()
    expect(h.health()).toBe(first + 2)
  })
  it('a refresh still loading after 30 s no longer blocks one', async () => {
    const h = load(); await h.open()
    const first = h.health()
    h.hold(); h.click('refresh'); await h.flush()
    h.clock.now += 29_999; h.click('refresh'); await h.flush()
    expect(h.health(), 'still running at 29.999 s').toBe(first + 1)
    h.clock.now += 2; h.click('refresh'); await h.flush()
    expect(h.health(), 'stuck past 30 s: a new load').toBe(first + 2)
    await h.release()
  })
})
