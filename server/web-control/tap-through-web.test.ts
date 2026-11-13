/**
 * 7.0.33 A12 (Anand round 2, slide 27; lead 11:47): no tap falls through a hidden top bar, and a button armed in place
 * does not stay armed forever. These run the shipped functions, cut from app.js. The browser check, with real taps in
 * WebKit at 450 x 640 and 390 x 844, is W1_evidence/7033/a12_check.cjs (red on 7.0.32: one tap pair signed out every
 * browser).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8')
const cut = (a: string, b: string) => { const i = APP.indexOf(a), j = APP.indexOf(b, i); if (i < 0 || j < 0) throw new Error('cut: ' + a); return APP.slice(i, j) }

describe('the top bar band: while the bar is away or sliding back, the first tap there only brings it back', () => {
  const BAND = cut('  var barBackAt = 0, barCatch = null;', "  document.addEventListener('pointerdown'")
  function band(height: number) {
    const cls = new Set<string>(['tucked']), clock = { now: 1_000_000 }
    const bar = { offsetHeight: height, getBoundingClientRect: () => ({ left: 0, right: 390 }), classList: { contains: (c: string) => cls.has(c), remove: (c: string) => cls.delete(c) } }
    // eslint-disable-next-line no-new-func
    const k = new Function('deps', `with (deps) {\n${BAND}\nreturn { barShow, barCatches };\n}`)({ $: () => bar, Date: { now: () => clock.now } })
    return { k, cls, clock, bar }
  }
  it('tucked: a tap inside the band is caught, one below it is not', () => {
    const { k } = band(48)
    expect(k.barCatches(200, 24)).toBe(true)
    expect(k.barCatches(200, 0)).toBe(true)
    expect(k.barCatches(200, 48)).toBe(false)
    expect(k.barCatches(200, 300)).toBe(false)
  })
  it('only the bar\'s own width: a tap beside the bar (the folded Duo\'s rail) is not caught (Q1)', () => {
    const { k } = band(48)
    expect(k.barCatches(389, 24)).toBe(true)
    expect(k.barCatches(390, 24)).toBe(false)
    expect(k.barCatches(426, 24)).toBe(false)
  })
  it('the band is the bar\'s own height, safe area included', () => {
    const { k } = band(92)
    expect(k.barCatches(200, 80)).toBe(true)
  })
  it('sliding back: still caught for the slide, then the bar is the bar again', () => {
    const { k, cls, clock, bar } = band(48)
    k.barShow(bar)
    expect(cls.has('tucked')).toBe(false)
    clock.now += 100; expect(k.barCatches(200, 24)).toBe(true)
    clock.now += 400; expect(k.barCatches(200, 24)).toBe(false)
  })
  it('a bar that was never away catches nothing', () => {
    const { k, cls, bar } = band(48)
    cls.delete('tucked')
    k.barShow(bar)   // already shown: no new slide starts
    expect(k.barCatches(200, 24)).toBe(false)
  })
})

describe('armTap: armed for 5 s, and the second tap counts only after 400 ms', () => {
  const ARM = cut('  var ARM_CONFIRM_MS = 400;', '  window.COSWeb.today = {')
  function rig() {
    const clock = { now: 5_000_000 }, timers: Array<[() => void, number]> = []
    const attrs: Record<string, string> = {}
    const el: any = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), setAttribute: (k: string, v: string) => { attrs[k] = String(v) }, removeAttribute: (k: string) => { delete attrs[k] } }
    const label = { textContent: 'Sign out every browser' }
    const win: any = { COSWeb: {} }
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${ARM}\n}`)({ window: win, Date: { now: () => clock.now }, setTimeout: (fn: () => void, ms: number) => { timers.push([fn, ms]) } })
    const tap = () => win.COSWeb.armTap(el, label, 'Tap again to sign out every browser')
    return { clock, timers, attrs, label, tap }
  }
  it('the first tap arms and says so; a tap 500 ms later confirms', () => {
    const r = rig()
    expect(r.tap()).toBe(false)
    expect(r.label.textContent).toBe('Tap again to sign out every browser')
    r.clock.now += 500
    expect(r.tap()).toBe(true)
  })
  it('a double tap (150 ms) only arms', () => {
    const r = rig(); r.tap(); r.clock.now += 150
    expect(r.tap()).toBe(false)
    expect(r.attrs['data-armed']).toBe('1')
  })
  it('after 5 s the timer puts the words back', () => {
    const r = rig(); r.tap()
    expect(r.timers.map(t => t[1])).toEqual([5000])
    r.timers[0][0]()
    expect(r.attrs['data-armed']).toBeUndefined()
    expect(r.label.textContent).toBe('Sign out every browser')
  })
  it('timers paused by the phone: a tap 5 s after arming arms again instead of confirming', () => {
    const r = rig(); r.tap(); r.clock.now += 5500
    expect(r.tap()).toBe(false)
    expect(r.label.textContent).toBe('Tap again to sign out every browser')
    r.clock.now += 500
    expect(r.tap()).toBe(true)
  })
  it('an old timer does not disarm a newer arming', () => {
    const r = rig(); r.tap(); r.clock.now += 5500; r.tap()
    r.timers[0][0]()
    expect(r.attrs['data-armed']).toBe('1')
  })
})

describe('both buttons that armed with no time limit now go through armTap', () => {
  it('Sign out every browser and Settings\' Release', () => {
    expect(APP).toContain("if (!window.COSWeb.armTap(t, t.querySelector('.grow').firstChild, 'Tap again to sign out every browser')) return;")
    const SET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes/settings.js'), 'utf8')
    expect(SET).toContain("if (!W.armTap(t, t, 'Tap again to release')) return;")
    expect((APP + SET).match(/setAttribute\('data-armed', '1'\)/g) || []).toHaveLength(1)   // only armTap itself
  })
})

describe('one expiry for every armed button that has one (Q1)', () => {
  it('app.js names it once and exports it; Memories reads it instead of its own 6 s', () => {
    expect(APP.match(/var ARM_EXPIRE_MS = (\d+);/)![1]).toBe('5000')
    expect(APP).toContain('window.COSWeb.armExpireMs = ARM_EXPIRE_MS;')
    const MEM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes/memories.js'), 'utf8')
    const arm = /function arm\(key\) \{[^\n]*\n/.exec(MEM)![0]
    expect(arm).toContain('W.armExpireMs || 5000')
    expect(arm).not.toMatch(/\b6000\b/)
  })
})
