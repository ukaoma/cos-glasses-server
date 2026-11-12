/**
 * 7.0.30 item 4 (Miles 10:15: "Meetings should SHOW the current day as well but give quick navigation back to the other
 * days"; Anand on the 11-12 HC call: today not marked, the month opening on no day). Runs meetings.js's own helpers,
 * loadMonth, paintCal and the empty-today pieces against fakes, with the clock at Thu Nov 12 2026, 10:00.
 * The browser check is W1_evidence/7030/items_check.cjs.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const M = readFileSync(join(HERE, 'panes', 'meetings.js'), 'utf8')
const cut = (a: string, b: string) => { const i = M.indexOf(a), j = M.indexOf(b, i); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return M.slice(i, j) }
const SRC = [
  cut('  function pad2(n) {', '  function clockOf(d) {'),
  cut('  function num(v) {', '  function fmtCount(n) {'),
  cut('  function icon(name) {', '\n'),
  cut('  function paintCal() {', '  // ── list: toolbar'),
  cut('  function emptyBox(text) {', '  function paintList() {'),
  cut('  function loadMonth(quiet) {', '  // A saved meeting changes the month'),
].join('\n')
const NOW = new Date(2026, 10, 12, 10, 0, 0)

function kit(days: Array<{ date: string; count: number }>, o: { autoDay?: boolean; month?: string } = {}) {
  class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(NOW.getTime()) } static now() { return NOW.getTime() } }
  const S: any = { month: o.month || '2026-11', day: null, days: [], rows: null, dayRows: {}, autoDay: !!o.autoDay, loadSeq: 0, view: 'list', q: '', error: '', loading: false }
  let calHtml = '', painted = 0
  const deps: any = {
    S, Date: FakeDate, esc: (t: unknown) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    W: { plainDay: (d: string) => (d === '2026-11-10' ? 'Tuesday' : d) },
    $: (id: string) => (id === 'mt-cal' ? {} : null), queryActive: () => false, weekStart: () => 0,
    paintAbove: (_el: unknown, _k: string, html: string) => { calHtml = html },
    paintBrowse: () => { painted++ }, ensureDay: () => {},
    api: () => Promise.resolve({ meetings: days.flatMap(d => Array.from({ length: d.count }, (_, i) => ({ date: d.date, title: 'M' + i }))), days }),
  }
  // eslint-disable-next-line no-new-func
  const f = new Function('deps', `with (deps) {\n${SRC}\nreturn { paintCal, emptyToday, latestDayBefore, loadMonth, dayKey };\n}`)(deps)
  return { f, S, cal: () => calHtml, painted: () => painted }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('Meetings opens on today', () => {
  it('a month with meetings today: today is the picked day', async () => {
    const k = kit([{ date: '2026-11-10', count: 2 }, { date: '2026-11-12', count: 1 }])
    k.f.loadMonth(); await flush()
    expect(k.S.day).toBe('2026-11-12')
  })
  it('a month with NO meetings today: today is still the picked day (before: no day, the whole month listed)', async () => {
    const k = kit([{ date: '2026-11-10', count: 2 }])
    k.f.loadMonth(); await flush()
    expect(k.S.day).toBe('2026-11-12')
  })
  it('only once: after he picks All month or another day, a reload of the month does not move him back', async () => {
    const k = kit([{ date: '2026-11-10', count: 2 }], { autoDay: true })
    k.f.loadMonth(); await flush()
    expect(k.S.day).toBe(null)
  })
  it('another month does not pick a day', async () => {
    const k = kit([{ date: '2026-10-03', count: 2 }], { month: '2026-10' })
    k.f.loadMonth(); await flush()
    expect(k.S.day).toBe(null)
  })
})

describe('today is marked on the calendar', () => {
  it('today has a ring and aria-current, and can be picked with no meetings; other empty days stay off', () => {
    const k = kit([])
    k.S.days = [{ date: '2026-11-10', count: 2 }]
    k.f.paintCal()
    const cell = (d: string) => (k.cal().match(new RegExp('<button[^>]*data-day="' + d + '"[^>]*>')) || [''])[0]
    expect(cell('2026-11-12')).toContain('class="mt-day mt-today"')
    expect(cell('2026-11-12')).toContain('aria-current="date"')
    expect(cell('2026-11-12')).not.toContain('disabled')
    expect(cell('2026-11-12')).toContain('aria-label="2026-11-12, today, no meetings"')
    expect(cell('2026-11-11')).toContain('disabled')
    expect(cell('2026-11-10')).not.toContain('disabled')
    expect(k.cal().match(/mt-today/g)).toHaveLength(1)
  })
})

describe('an empty today says so, with one tap back to a day that has meetings', () => {
  it('the latest earlier day with meetings this month', () => {
    const k = kit([])
    k.S.days = [{ date: '2026-11-03', count: 1 }, { date: '2026-11-10', count: 2 }, { date: '2026-11-11', count: 0 }, { date: '2026-11-20', count: 4 }]
    const html = k.f.emptyToday()
    expect(html).toContain('<p class="cx-empty mt-empty">No meetings today.</p>')
    expect(html).toContain('data-mt="jump-day" data-day="2026-11-10">Go to Tuesday</button>')
  })
  it('none this month: one tap to last month', () => {
    const k = kit([])
    k.S.days = [{ date: '2026-11-20', count: 4 }]
    expect(k.f.emptyToday()).toContain('data-mt="month" data-delta="-1">Go to last month</button>')
  })
  it('the list shows it for an empty today, and the jump picks that day (not a toggle)', () => {
    expect(M).toContain(': S.day && S.day === dayKey(new Date()) ? emptyToday()')
    expect(M).toContain("case 'jump-day': { S.day = t.getAttribute('data-day'); S.autoDay = true; paintBrowse(); ensureDay(); return; }")
  })
})
