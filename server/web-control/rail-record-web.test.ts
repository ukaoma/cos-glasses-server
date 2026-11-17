/**
 * 7.0.55 (the lead 11:2x; F1_findings_1120.md): the folded strip's rail record, instrumented before any fix. app.js's
 * railRecord / railMoved block is sliced and run with fakes for the page; layoutCrumb is a spy. Pinned: the record's exact
 * shape (numbers and fixed labels only, every key and value one layoutCrumb keeps), its numbering, the settled re-report
 * 600 ms after the last change, and both caps (6 a minute, 24 a page load).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error('marker moved: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const BLOCK = between(APP, '  // 7.0.55 (the lead 11:2x; F1_findings_1120)', '  function railSync() {')
const KEYS = ['n', 'at', 'sw', 'sh', 'rail', 'railHit', 'dvh', 'mqRail', 'mqNarrow', 'short', 'cw', 'sy', 'stripTop', 'stripH', 'stripPos', 'shellH']

function kit(o: { refuse?: boolean; pos?: string; short?: boolean; noStrip?: boolean } = {}) {
  const now = { t: 1_700_000_000_000 }
  const sent: Array<{ what: string; data: Record<string, unknown> }> = []
  const timers = new Map<number, () => void>(); let id = 0
  let syncs = 0, side = true
  const strip = { getBoundingClientRect: () => ({ top: -240, height: 797 }) }
  const de = { clientWidth: 449, classList: { contains: (c: string) => c === 'short-screen' && o.short !== false } }
  const vvL: Record<string, Array<() => void>> = {}
  const vv = { width: 449, height: 797, offsetTop: 0, addEventListener: (t: string, f: () => void) => { (vvL[t] ||= []).push(f) } }
  const ctx: Record<string, unknown> = {
    Date: { now: () => now.t },
    setTimeout: (f: () => void) => { timers.set(++id, f); return id }, clearTimeout: (i: number) => { timers.delete(i) },
    document: { documentElement: de, querySelector: (s: string) => (s === '.rail' && !o.noStrip ? strip : null) },
    window: { visualViewport: vv, screen: { width: 466, height: 678 }, scrollY: 1200.5, matchMedia: (q: string) => ({ matches: q === '(max-width: 599px)' || q === '(max-width: 599px) and (pointer: coarse)' }),
      getComputedStyle: () => ({ position: o.pos ?? 'sticky' }) },
    $: (i: string) => (i === 'app-shell' ? { getBoundingClientRect: () => ({ height: 1668 }) } : null),
    layoutCrumb: (what: string, data: Record<string, unknown>) => { if (o.refuse) return false; sent.push({ what, data }); return true },
    lrProbe: () => 797, RAIL: { hit: 52 }, SIDE_RAIL_MQ: '(max-width: 599px) and (pointer: coarse)',
    sideRail: () => side, railSync: () => { syncs++ },
  }
  vm.createContext(ctx)
  vm.runInContext(BLOCK + '\n;this.api = { railRecord: railRecord, railMoved: railMoved, railVvHook: railVvHook, RAIL_REC: RAIL_REC };', ctx)
  const api = (ctx as { api: { railRecord(at: string, on: boolean): boolean; railMoved(): void; railVvHook(): void; RAIL_REC: { n: number } } }).api
  return { api, sent, now, timers, vv, vvL, vvFire(t = 'resize') { (vvL[t] || []).forEach(f => f()) }, syncs: () => syncs, setSide: (v: boolean) => { side = v }, fire() { const fs = [...timers.values()]; timers.clear(); fs.forEach(f => f()) } }
}

describe('the rail record: what the strip was drawn against', () => {
  it('exactly these keys, every one a number, a boolean or a fixed label', () => {
    const k = kit(); k.api.railRecord('change', true)
    expect(k.sent).toHaveLength(1)
    const { what, data } = k.sent[0]
    expect(what).toBe('rail')
    expect(Object.keys(data)).toEqual(KEYS)
    expect(data).toEqual({ n: 1, at: 'change', sw: 466, sh: 678, rail: true, railHit: 52, dvh: 797, mqRail: true, mqNarrow: true, short: true,
      cw: 449, sy: 1200.5, stripTop: -240, stripH: 797, stripPos: 'sticky', shellH: 1668 })
  })
  it('every key and value is one layoutCrumb keeps (its own rule: a short camelCase key; numbers, booleans, strings of 24 or fewer)', () => {
    const k = kit(); k.api.railRecord('settled', false)
    for (const [key, v] of Object.entries(k.sent[0].data)) {
      expect(key, key).toMatch(/^[a-z][a-zA-Z0-9]{0,15}$/)
      expect(['number', 'boolean', 'string'].includes(typeof v) || v === null, key).toBe(true)
      if (typeof v === 'string') expect(['change', 'settled', 'static', 'relative', 'absolute', 'fixed', 'sticky', 'other']).toContain(v)
    }
    expect(between(APP, '  function layoutCrumb(event, extra) {', '\n  }\n')).toContain("if (/^[a-z][a-zA-Z0-9]{0,15}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 24)))")
  })
  it('only fixed labels leave: an unexpected position or label becomes a fixed word', () => {
    const k = kit({ pos: '-webkit-sticky; injected' }); k.api.railRecord('anything else', true)
    expect(k.sent[0].data.stripPos).toBe('other'); expect(k.sent[0].data.at).toBe('change')
  })
  it('no strip or no shell on the page: nulls, never a throw', () => {
    const k = kit({ noStrip: true }); expect(k.api.railRecord('change', false)).toBe(true)
    expect(k.sent[0].data.stripTop).toBe(null); expect(k.sent[0].data.stripH).toBe(null)
  })
})

describe('numbered, settled, capped', () => {
  it('numbered in order; a record the log refused takes no number', () => {
    const r = kit({ refuse: true }); r.api.railRecord('change', true); expect(r.api.RAIL_REC.n).toBe(0)
    const k = kit(); k.api.railRecord('change', true); k.api.railRecord('change', false)
    expect(k.sent.map(s => s.data.n)).toEqual([1, 2])
  })
  it('a resize or fold syncs at once and reports once, 600 ms after the last of a burst, as settled, with the strip as it then is', () => {
    const k = kit()
    k.api.railMoved(); k.api.railMoved(); k.api.railMoved()
    expect(k.syncs()).toBe(3); expect(k.timers.size).toBe(1); expect(k.sent).toHaveLength(0)
    k.setSide(false); k.fire()
    expect(k.sent).toHaveLength(1); expect(k.sent[0].data).toMatchObject({ n: 1, at: 'settled', rail: false })
    k.setSide(true); k.api.railMoved(); k.fire()                       // the strip as it is at settle, not the last change's value
    expect(k.sent[1].data).toMatchObject({ n: 2, at: 'settled', rail: true })
    expect(BLOCK).toContain('RAIL_SETTLE_MS = 600')
  })
  it('at most 6 in any minute, then again after the minute', () => {
    const k = kit()
    for (let i = 0; i < 9; i++) k.api.railRecord('change', true)
    expect(k.sent).toHaveLength(6)
    k.now.t += 60_001; k.api.railRecord('change', true)
    expect(k.sent).toHaveLength(7); expect(k.sent[6].data.n).toBe(7)
  })
  it('at most 24 in a page load, so the keyboard and frame reports keep their budget', () => {
    const k = kit()
    for (let m = 0; m < 6; m++) { for (let i = 0; i < 6; i++) k.api.railRecord('change', true); k.now.t += 60_001 }
    expect(k.sent).toHaveLength(24)
  })
})

describe('the visual viewport (the lead 11:4x, Codex): his fault shows it stranded at height 0', () => {
  it('a viewport resize or scroll reports once, 600 ms after the last, only when its width, height or top moved', () => {
    const k = kit(); k.api.railVvHook()
    k.api.railRecord('change', true)                        // the last record saw 449,797,0
    k.vvFire('resize'); k.fire(); expect(k.sent).toHaveLength(1)   // nothing moved: nothing sent
    k.vv.height = 0; k.vv.offsetTop = 797                   // stranded
    k.vvFire('resize'); k.vvFire('scroll'); k.vvFire('resize'); expect(k.timers.size).toBe(1)
    k.fire(); expect(k.sent).toHaveLength(2); expect(k.sent[1].data).toMatchObject({ n: 2, at: 'settled' })
    k.vv.height = 797; k.vv.offsetTop = 0                   // recovered, seen only as a scroll
    k.vvFire('scroll'); k.fire(); expect(k.sent).toHaveLength(3)
  })
  it('never changes behaviour: a viewport event never syncs the strip', () => {
    const k = kit(); k.api.railVvHook(); k.vv.height = 10; k.vvFire('resize'); k.vvFire('scroll'); k.fire()
    expect(k.syncs()).toBe(0)
  })
  it('a resize in the same burst still reports, even if the viewport ends where it was', () => {
    const k = kit(); k.api.railVvHook(); k.api.railRecord('change', true)
    k.api.railMoved(); k.vvFire('resize'); k.fire()
    expect(k.sent).toHaveLength(2); expect(k.sent[1].data.at).toBe('settled')
  })
  it('hooked once, resize and scroll; the same caps (6 a minute)', () => {
    const k = kit(); k.api.railVvHook(); k.api.railVvHook()
    expect(k.vvL.resize).toHaveLength(1); expect(k.vvL.scroll).toHaveLength(1)
    for (let i = 0; i < 9; i++) { k.vv.height = 100 + i; k.vvFire('resize'); k.fire() }
    expect(k.sent).toHaveLength(6)
  })
})

describe('wired', () => {
  it('railSync reports a change through railRecord; resize, orientation and the strip\'s media test go through railMoved', () => {
    const rs = between(APP, '  function railSync() {', '\n  }\n')
    expect(rs).toContain("if (RAIL.on !== null && RAIL.on !== on) railRecord('change', on);")
    expect(rs).toContain("mq.addEventListener('change', railMoved)")
    expect(rs).toContain("window.addEventListener('resize', railMoved);")
    expect(rs).toContain("window.addEventListener('orientationchange', railMoved);")
    expect(rs).not.toContain("layoutCrumb('rail'")
    expect(rs).toContain("window.addEventListener('orientationchange', railMoved);\n        railVvHook();")
  })
})
