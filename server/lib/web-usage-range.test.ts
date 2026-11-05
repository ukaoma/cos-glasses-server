// COS Control Web, Usage (server/web-control/app.js): the date range math behind the wide layout's summary card, its
// ‹ › stepping and the custom range sheet, and the promise that under 860 px the page writes the same Usage HTML as
// 6.99.10. The code runs straight out of app.js: the block between "Numbers the way Control writes them" and the COS
// cost view holds only functions and constants, so it evaluates here without a page.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../web-control/app.js', import.meta.url), 'utf8')
const BASELINE = readFileSync(new URL('./__fixtures__/web-usage-narrow-6.99.10.js', import.meta.url), 'utf8')

function region(source: string): string {
  const start = source.indexOf('// Numbers the way Control writes them')
  const end = source.indexOf('// ── COS cost view')
  expect(start, 'the Usage region starts with the number helpers').toBeGreaterThan(-1)
  return end > start ? source.slice(start, end) : source.slice(start)
}

const RANGE_NAMES = ['uRange', 'uCompare', 'uStep', 'uCustomError', 'uDayKey', 'uDefaultScale', 'uPeriodTitle', 'uDateRangeTitle',
  'uRangeTitle', 'uPartialPeriods', 'uWeekday', 'uAddDays', 'uMonthEnd', 'uPeriodKey', 'uAxisKeys', 'uNiceTop', 'uKnownPeriod']
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fns = Record<string, (...args: any[]) => any>
function rangeMath(): Fns {
  const start = APP.indexOf('// Numbers the way Control writes them'), end = APP.indexOf('// ── end of usage range math ──')
  expect(end, 'the range math block ends with its marker').toBeGreaterThan(start)
  // eslint-disable-next-line no-new-func
  return new Function(APP.slice(start, end) + `; return { ${RANGE_NAMES.join(', ')} };`)() as Fns
}

const T = '2026-11-04' // a Wednesday
describe('Usage range math', () => {
  const m = rangeMath()

  it('gives every preset its dates, from today in the report zone', () => {
    expect(m.uRange('Last 7 days', T)).toEqual(['2026-10-29', T])
    expect(m.uRange('Last 30 days', T)).toEqual(['2026-10-06', T])
    expect(m.uRange('Last 90 days', T)).toEqual(['2026-08-07', T])
    expect(m.uRange('This month', T)).toEqual(['2026-11-01', '2026-11-30'])
    expect(m.uRange('Last month', T)).toEqual(['2026-10-01', '2026-10-31'])
    expect(m.uRange('This quarter', T)).toEqual(['2026-10-01', '2026-12-31'])
    expect(m.uRange('This quarter', '2026-02-14')).toEqual(['2026-01-01', '2026-03-31'])
    expect(m.uRange('This quarter', '2026-12-15'), 'the last month of a quarter').toEqual(['2026-10-01', '2026-12-31'])
    expect(m.uRange('This quarter', '2026-03-31')).toEqual(['2026-01-01', '2026-03-31'])
    expect(m.uRange('Year to date', T)).toEqual(['2026-01-01', T])
    expect(m.uRange('Last weekend', T)).toEqual(['2026-10-31', '2026-11-01'])
    expect(m.uRange('Last weekend', '2026-11-01'), 'on a Sunday, the weekend before').toEqual(['2026-10-24', '2026-10-25'])
    expect(m.uRange('Last weekend', '2026-11-02'), 'on a Monday, the one just gone').toEqual(['2026-10-31', '2026-11-01'])
    expect(m.uRange('2026-02', T)).toEqual(['2026-02-01', '2026-02-28'])
    expect(m.uRange('2028-02', T), 'a leap February').toEqual(['2028-02-01', '2028-02-29'])
    expect(m.uRange('Last month', '2026-01-15'), 'across a year').toEqual(['2025-12-01', '2025-12-31'])
    expect(m.uRange('All history', T)).toBeNull()
    expect(m.uRange('Custom dates', T, '2026-09-01', '2026-09-15')).toEqual(['2026-09-01', '2026-09-15'])
    expect(m.uRange('Next fortnight', T)).toBe(false)
  })

  it('refuses a custom range that ends before it starts, or is not a date', () => {
    expect(m.uCustomError('2026-10-02', '2026-10-01')).toBe('Choose an end date on or after the start.')
    expect(m.uRange('Custom dates', T, '2026-10-02', '2026-10-01')).toBe(false)
    expect(m.uCustomError('2026-10-01', '2026-10-01')).toBe('')
    expect(m.uCustomError('2026-02-30', '2026-03-01')).toBe('Choose a start and an end date.')
    expect(m.uCustomError('', '2026-03-01')).toBe('Choose a start and an end date.')
    expect(m.uCustomError('2026-3-1', '2026-03-02')).toBe('Choose a start and an end date.')
    expect(m.uKnownPeriod('Custom dates') && m.uKnownPeriod('2026-10') && m.uKnownPeriod('Year to date')).toBe(true)
    expect(m.uKnownPeriod('Last 31 days')).toBe(false)
  })

  it('compares with the equal-length period before, like for like for months', () => {
    expect(m.uCompare('Last 30 days', T)).toEqual({ current: ['2026-10-06', T], prior: ['2026-09-06', '2026-10-05'] })
    expect(m.uCompare('Last 7 days', T).prior).toEqual(['2026-10-22', '2026-10-28'])
    expect(m.uCompare('Last weekend', T).prior, 'the weekend before').toEqual(['2026-10-24', '2026-10-25'])
    expect(m.uCompare('This month', T), 'a month in progress: the same dates of the month before')
      .toEqual({ current: ['2026-11-01', T], prior: ['2026-10-01', '2026-10-04'] })
    expect(m.uCompare('2026-03', '2026-03-31').prior, 'clamped to a shorter month').toEqual(['2026-02-01', '2026-02-28'])
    expect(m.uCompare('Last month', T), 'a finished month: the whole month before')
      .toEqual({ current: ['2026-10-01', '2026-10-31'], prior: ['2026-09-01', '2026-09-30'] })
    expect(m.uCompare('This quarter', T), 'the dates that have happened, then as many before')
      .toEqual({ current: ['2026-10-01', T], prior: ['2026-08-27', '2026-09-30'] })
    expect(m.uCompare('Custom dates', T, '2026-10-20', '2026-12-01').current, 'a range past today stops at today').toEqual(['2026-10-20', T])
    expect(m.uCompare('Custom dates', T, '2026-10-20', '2026-12-01').prior).toEqual(['2026-10-04', '2026-10-19'])
    expect(m.uCompare('Custom dates', T, '2026-11-10', '2026-11-20'), 'a range after today has nothing to compare').toBeNull()
    expect(m.uCompare('All history', T)).toBeNull()
  })

  it('steps by the range length, a month by a month and a quarter by a quarter, never past today or before history', () => {
    expect(m.uStep('Last 30 days', T, '', '', -1, '2026-03-03')).toEqual({ period: 'Custom dates', from: '2026-09-06', to: '2026-10-05' })
    expect(m.uStep('Custom dates', T, '2026-09-06', '2026-10-05', 1, '2026-03-03'), 'back on the last 30 days says so').toEqual({ period: 'Last 30 days', from: '', to: '' })
    expect(m.uStep('Last 30 days', T, '', '', 1, '2026-03-03'), 'nothing later than today').toBeNull()
    expect(m.uStep('Last 7 days', T, '', '', -1)).toEqual({ period: 'Custom dates', from: '2026-10-22', to: '2026-10-28' })
    expect(m.uStep('This month', T, '', '', -1)).toEqual({ period: '2026-10', from: '', to: '' })
    expect(m.uStep('2026-10', T, '', '', 1)).toEqual({ period: '2026-11', from: '', to: '' })
    expect(m.uStep('This month', T, '', '', 1), 'December has not started').toBeNull()
    expect(m.uStep('2026-01', T, '', '', -1)).toEqual({ period: '2025-12', from: '', to: '' })
    expect(m.uStep('This quarter', T, '', '', -1)).toEqual({ period: 'Custom dates', from: '2026-07-01', to: '2026-09-30' })
    expect(m.uStep('Custom dates', T, '2026-07-01', '2026-09-30', -1)).toEqual({ period: 'Custom dates', from: '2026-04-01', to: '2026-06-30' })
    expect(m.uStep('Custom dates', T, '2026-07-01', '2026-09-30', 1)).toEqual({ period: 'Custom dates', from: '2026-10-01', to: '2026-12-31' })
    expect(m.uStep('Custom dates', T, '2026-03-01', '2026-03-10', -1, '2026-03-03'), 'not past the first day of history').toBeNull()
    expect(m.uStep('Custom dates', T, '2026-03-11', '2026-03-20', -1, '2026-03-03')).toEqual({ period: 'Custom dates', from: '2026-03-01', to: '2026-03-10' })
    expect(m.uStep('All history', T, '', '', -1)).toBeNull()
    expect(m.uStep('Custom dates', T, '2026-10-05', '2026-10-01', -1), 'a range that is not one does not step').toBeNull()
  })

  it('reads today in the report zone, across midnight and daylight saving', () => {
    const at = new Date('2026-11-05T04:30:00Z')
    expect(m.uDayKey('America/Chicago', at)).toBe('2026-11-04')
    expect(m.uDayKey('UTC', at)).toBe('2026-11-05')
    expect(m.uDayKey('Asia/Tokyo', at)).toBe('2026-11-05')
    expect(m.uDayKey('America/Los_Angeles', new Date('2026-03-08T07:59:00Z'))).toBe('2026-03-07')
    expect(m.uDayKey('America/Chicago', new Date('2026-03-08T08:30:00Z')), 'the spring-forward morning').toBe('2026-03-08')
    expect(m.uDayKey('Not/AZone', at), 'an unknown zone still answers').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(m.uWeekday('2026-10-19'), 'Monday is 0').toBe(0)
    expect(m.uWeekday('2026-11-01')).toBe(6)
    expect(m.uAddDays('2026-03-07', 1), 'no hour is lost on a DST day').toBe('2026-03-08')
    expect(m.uAddDays('2026-11-01', 1)).toBe('2026-11-02')
  })

  it('names bars and ranges the way Control does', () => {
    expect(m.uDateRangeTitle(['2026-09-06', '2026-10-05'])).toBe('Sep 6 – Oct 5, 2026')
    expect(m.uDateRangeTitle(['2025-12-29', '2026-01-04'])).toBe('Dec 29, 2025 – Jan 4, 2026')
    expect(m.uDateRangeTitle(['2026-10-19', '2026-10-19'])).toBe('Oct 19, 2026')
    expect(m.uPeriodTitle('2026-10-19', 'daily')).toBe('Monday, Oct 19, 2026')
    expect(m.uPeriodTitle('2026-10-26', 'weekly')).toBe('Week of Oct 26 – Nov 1, 2026')
    expect(m.uPeriodTitle('2026-10-05', 'weekly', ['2026-10-06', T])).toBe('Oct 6 – Oct 11, 2026 (partial week)')
    expect(m.uPeriodTitle('2026-10', 'monthly', ['2026-10-06', T])).toBe('October 2026 (Oct 6 – Oct 31)')
    expect(m.uRangeTitle('Custom dates', '2026-09-01', '2026-09-15')).toBe('Sep 1 – Sep 15, 2026')
    expect(m.uRangeTitle('2026-10')).toBe('October 2026')
    expect(m.uDefaultScale('Last 90 days', T)).toBe('weekly')
    expect(m.uDefaultScale('All history', T)).toBe('monthly')
    expect(m.uDefaultScale('This quarter', T)).toBe('weekly')
    expect(m.uDefaultScale('Last 30 days', T)).toBe('daily')
    expect(m.uDefaultScale('Year to date', T)).toBe('monthly')
    expect(m.uDefaultScale('Custom dates', T, '2026-09-01', '2026-09-30')).toBe('daily')
    expect(m.uDefaultScale('Custom dates', T, '2026-06-01', '2026-09-30')).toBe('weekly')
    expect(m.uPeriodKey('2026-11-04', 'weekly')).toBe('2026-11-02')
    expect(m.uPartialPeriods(['2026-10-05', '2026-10-12', '2026-11-02'], 'weekly', '2026-10-06', T)).toEqual({ '2026-10-05': true, '2026-11-02': true })
    expect(m.uAxisKeys(Array.from({ length: 30 }, (_, i) => String(i))).length).toBeLessThanOrEqual(8)
    expect(m.uNiceTop(2.82e3)).toBe(3200)
  })
})

// The Usage view as data: a realistic report, not generated from the code under test.
function report() {
  const buckets: unknown[] = []
  const days = ['2026-10-01', '2026-10-15', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-09-20', '2026-08-02']
  days.forEach((day, i) => {
    buckets.push({ day, provider: 'Anthropic', model: 'claude-opus-5-5', counts: { input: 3e6 + i, output: 9e6, cacheRead: 9.4e8, cacheWrite: 3e7 }, events: 1200 + i, pricedEvents: 1200 + i, estimatedUSD: 541.2 + i })
    buckets.push({ day, provider: 'OpenAI', model: 'gpt-5.3-codex', counts: { input: 1e6, output: 2e6, cacheRead: 2e8, cacheWrite: 4e6 }, events: 300, pricedEvents: 180, estimatedUSD: 40.5 })
  })
  return { sessionUsage: { buckets, updatedAt: '2026-11-04T23:41:00Z', timeZone: 'America/Chicago', filesIndexed: 4182, pendingFiles: 2, unreadableFiles: 1, malformedRows: 0, missingBaselineEvents: 0, coverage: ['Claude Code and Codex local session logs.'], pricingVersion: '2026-10-25-standard-v1' } }
}
// The page's own helpers, passed in so both builds run with the same ones.
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const toDate = (v: string) => (v ? new Date(v) : null)
const clock = () => '11:41 PM'
function narrowBuilder(source: string, SX: Record<string, unknown>) {
  // eslint-disable-next-line no-new-func
  return new Function('SX', 'esc', 'toDate', 'clock', region(source) + '; return sessionUsageHtml;')(SX, esc, toDate, clock) as (d: unknown) => string
}
const FROZEN = new Date('2026-11-05T05:41:00Z') // 11:41 PM in Chicago on Nov 4

describe('Usage under 860 px writes the 6.99.10 HTML', () => {
  const withClock = <T,>(fn: () => T): T => {
    const RealDate = Date
    class Frozen extends RealDate { constructor(...a: unknown[]) { super(...((a.length ? a : [FROZEN.getTime()]) as [])) } static now() { return FROZEN.getTime() } }
    globalThis.Date = Frozen as DateConstructor
    try { return fn() } finally { globalThis.Date = RealDate }
  }
  const sx = (over: Record<string, unknown> = {}) => ({ uPeriod: 'Last 30 days', uTool: 'All tools', uModel: 'All models', uFrom: '', uTo: '', ...over })
  const CUSTOM_OPTION = '<option value="Custom dates">Custom dates</option>'

  for (const [label, over] of [['Last 30 days', {}], ['Last 7 days, one tool', { uPeriod: 'Last 7 days', uTool: 'OpenAI' }],
    ['a month', { uPeriod: '2026-10' }], ['All history, one model', { uPeriod: 'All history', uModel: 'claude-opus-5-5' }], ['Last weekend', { uPeriod: 'Last weekend' }]] as const) {
    it(`is the same page for ${label}, apart from the new Custom dates option`, () => {
      const [before, after] = withClock(() => [narrowBuilder(BASELINE, sx(over))(report()), narrowBuilder(APP, sx(over))(report())])
      expect(after.split(CUSTOM_OPTION).length - 1, 'one Custom dates option').toBe(1)
      expect(after.indexOf(CUSTOM_OPTION), 'it sits before All history, as on the Mac').toBeLessThan(after.indexOf('<option value="All history"'))
      expect(after.replace(CUSTOM_OPTION, '')).toBe(before)
      expect(before.length).toBeGreaterThan(2000)
    })
  }

  it('shows a custom range by its dates, with a way to change them, and filters to it', () => {
    const html = withClock(() => narrowBuilder(APP, sx({ uPeriod: 'Custom dates', uFrom: '2026-10-01', uTo: '2026-10-20' }))(report()))
    expect(html).toContain('<option value="Custom dates" selected>Oct 1 – Oct 20, 2026</option>')
    expect(html).toContain('data-sx="usage-range">Change dates</button>')
    expect(html).toContain('2 days with usage')
  })

  it('keeps a range picked on the wide layout when the phone folds', () => {
    const html = withClock(() => narrowBuilder(APP, sx({ uPeriod: 'This quarter' }))(report()))
    expect(html).toContain('<option value="This quarter" selected>This quarter</option>')
    expect(html).toContain('6 days with usage')
  })

  it('falls back to the last 30 days for a custom range that is not one', () => {
    const state = sx({ uPeriod: 'Custom dates', uFrom: '2026-10-20', uTo: '2026-10-01' })
    withClock(() => narrowBuilder(APP, state)(report()))
    expect(state.uPeriod).toBe('Last 30 days')
  })
})
