// The Salesforce funnel log (funnel-log.json): parsing the blend, a stale, missing or broken file, sameWindow, and the words a disagreement
// is said in, for the meeting assistant and the data cue. The engine and the Ask runtime are tested in their own files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FUNNEL_LOG_LIMITS, askNamesSalesforce, funnelCueClause, funnelLogForAsk, funnelLogReader, funnelRowsFor, funnelUncovered, parseFunnelLog, spanText, type FunnelLog } from './funnel-log.js'
import { parseDataFacts, type DataFacts, type DataGroup } from './live-cues-v2-data.js'
import { NOW, rawFacts } from './__fixtures__/live-cues-v2-data-fixture.js'
import { SF_NOW, rawFunnelLog, rawFunnelLogOtherWindow } from './__fixtures__/funnel-log-fixture.js'

const HOUR = 3_600_000
const log = (raw: Record<string, unknown> = rawFunnelLog(), now = SF_NOW): FunnelLog => { const r = parseFunnelLog(raw, now); if (!r.ok) throw new Error(r.reason); return r.log }
const facts = (): DataFacts => { const r = parseDataFacts(rawFacts(), NOW); if (!r.ok) throw new Error(r.reason); return r.facts }
const group = (name: string): DataGroup => facts().groups.find(g => g.name === name)!

describe('parsing the blend', () => {
  it('keeps Salesforce, Tableau and the disagree flag per industry and stage', () => {
    const l = log()
    expect(l.rows.map(r => r.industry)).toEqual(['Liquor', 'Grocery', 'Thrift'])
    expect(l.rows[0].stages.opps).toEqual({ salesforce: 40, tableau: 38, todaySalesforce: 0, priorMonthSp: 65, lastYearSp: 47, budgetToDate: 45.5, pctToGoal: 83.5, disagree: true })
    expect(l.rows[0].stages.leads?.disagree).toBe(false)
    expect(l.window).toEqual({ period: ['2026-11-01', '2026-11-15'], today: ['2026-11-16', '2026-11-16'], priorMonthSp: ['2026-10-01', '2026-10-15'], lastYearSp: ['2025-11-01', '2025-11-15'] })
    expect(l.tableau).toEqual({ label: 'Tableau, Nov 2026 to Nov 15, marketing sources', asOfIso: '2026-11-16T05:28:00-06:00', sameWindow: true })
    expect(l.salesforce.orgs).toEqual({ 'POS Nation': '00D40000000N194EAC', 'Rain Retail': '00D4W000008J2IAUA0' })
    expect(l.notes).toHaveLength(1)
  })
  it('respects sameWindow: another window means no Tableau figure, budget or disagreement, whatever the row says', () => {
    const raw = rawFunnelLog({ tableau: { ...rawFunnelLog().tableau, sameWindow: false } })   // rows still carry Tableau figures and disagree: true
    const l = log(raw)
    expect(l.tableau.sameWindow).toBe(false)
    expect(l.rows[0].stages.opps).toMatchObject({ salesforce: 40, tableau: null, budgetToDate: null, pctToGoal: null, disagree: false })
    // a missing flag is not "same window"
    const { sameWindow: _s, ...noFlag } = rawFunnelLog().tableau
    expect(log(rawFunnelLog({ tableau: noFlag })).rows[0].stages.opps?.tableau).toBeNull()
  })
  it('a disagree flag with no Tableau figure is not a disagreement', () => {
    const raw = rawFunnelLog(); raw.rows[1].stages.opps = { ...raw.rows[1].stages.opps, tableau: null, disagree: true }
    expect(log(raw).rows[1].stages.opps?.disagree).toBe(false)
  })
  it('drops a stage whose Salesforce count is not a non-negative integer, and a row with none left', () => {
    const raw = rawFunnelLog()
    raw.rows[0].stages.leads.salesforce = 71.5
    raw.rows[0].stages.opps.salesforce = -1
    raw.rows[0].stages.demos.salesforce = '34'
    raw.rows[1].stages = { leads: { salesforce: null }, opps: 'x' }
    const l = log(raw)
    expect(Object.keys(l.rows[0].stages)).toEqual(['customers'])
    expect(l.rows.map(r => r.industry)).toEqual(['Liquor', 'Thrift'])
  })
  it.each([
    ['another kind', { kind: 'data-facts' }],
    ['another version', { v: 2 }],
    ['no time', { generatedAt: 'soon' }],
    ['no period', { window: { today: ['2026-11-16', '2026-11-16'] } }],
    ['a backwards period', { window: { period: ['2026-11-15', '2026-11-01'] } }],
    ['no rows', { rows: [] }],
    ['no usable row', { rows: [{ org: 'POS Nation', industry: 'Liquor', stages: { opps: { salesforce: 'many' } } }] }],
    ['too many rows', { rows: Array.from({ length: FUNNEL_LOG_LIMITS.maxRows + 1 }, () => rawFunnelLog().rows[0]) }],
  ])('invalid: %s', (_why, over) => {
    expect(parseFunnelLog(rawFunnelLog(over), SF_NOW)).toEqual({ ok: false, reason: 'invalid' })
  })
  it('the Salesforce as-of is salesforce.queriedAt, not the 10:45 re-join that rewrote the file; an older file falls back to generatedAt', () => {
    const rejoined = rawFunnelLog({ generatedAt: '2026-11-16T10:45:08-06:00', salesforce: { ...rawFunnelLog().salesforce, queriedAt: '2026-11-16T07:07:01-06:00' } })
    const l = log(rejoined)
    expect(l.queriedAtIso).toBe('2026-11-16T07:07:01-06:00')
    const { title, text } = funnelLogForAsk(l, 'liquor opps', null, null)
    expect(title).toBe('Salesforce via Coefficient, Nov 1 to 15, marketing sources, queried Nov 16 07:07 CT')
    expect(text).toContain('queried live through Coefficient Nov 16 07:07 CT')
    expect(text).toContain('Salesforce on Nov 16 through 07:07 CT +0')
    expect(text).not.toContain('10:45')
    expect(funnelCueClause(l, [group('Liquor')], ['opps'])).toContain('queried Nov 16 07:07 CT:')
    // staleness is counted from the query, so a re-join cannot keep an old Salesforce reply alive
    const q = Date.parse('2026-11-16T07:07:01-06:00')
    expect(parseFunnelLog(rejoined, q + (FUNNEL_LOG_LIMITS.maxAgeHours + 1) * HOUR)).toEqual({ ok: false, reason: 'stale' })
    // no queriedAt, or one that does not parse: generatedAt, as before
    expect(log(rawFunnelLog()).queriedAtIso).toBe('2026-11-16T07:08:23-06:00')
    expect(log(rawFunnelLog({ salesforce: { ...rawFunnelLog().salesforce, queriedAt: 'this morning' } })).queriedAtIso).toBe('2026-11-16T07:08:23-06:00')
  })
  it('stale past maxAgeHours from the Salesforce query, never from the file time; future past an hour ahead', () => {
    const gen = Date.parse('2026-11-16T07:08:23-06:00')
    expect(parseFunnelLog(rawFunnelLog(), gen + (FUNNEL_LOG_LIMITS.maxAgeHours - 1) * HOUR).ok).toBe(true)
    expect(parseFunnelLog(rawFunnelLog(), gen + (FUNNEL_LOG_LIMITS.maxAgeHours + 1) * HOUR)).toEqual({ ok: false, reason: 'stale' })
    expect(parseFunnelLog(rawFunnelLog(), gen - 2 * HOUR)).toEqual({ ok: false, reason: 'future' })
    expect(parseFunnelLog(rawFunnelLog(), gen - 30 * 60_000).ok).toBe(true)
  })
})

describe('the reader', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'funnel-log-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('missing, then valid, then broken JSON, then valid again after a rewrite; staleness is checked on every call', () => {
    const path = join(dir, 'funnel-log.json')
    let now = SF_NOW
    const read = funnelLogReader(path, () => now)
    expect(read()).toEqual({ ok: false, reason: 'missing' })
    writeFileSync(path, JSON.stringify(rawFunnelLog()))
    expect(read().ok).toBe(true)
    writeFileSync(path, '{"v":1,')
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    expect(read()).toEqual({ ok: false, reason: 'invalid' })
    writeFileSync(path, JSON.stringify(rawFunnelLogOtherWindow()))
    utimesSync(path, new Date(), new Date(Date.now() + 10_000))
    const r = read()
    expect(r.ok && r.log.tableau.sameWindow).toBe(false)
    now = SF_NOW + 200 * HOUR                     // same file, later clock
    expect(read()).toEqual({ ok: false, reason: 'stale' })
  })
  it('a directory or an oversized file is invalid, never thrown', () => {
    expect(funnelLogReader(dir, () => SF_NOW)()).toEqual({ ok: false, reason: 'invalid' })
    const big = join(dir, 'big.json')
    writeFileSync(big, ' '.repeat(FUNNEL_LOG_LIMITS.maxBytes + 1))
    expect(funnelLogReader(big, () => SF_NOW)()).toEqual({ ok: false, reason: 'invalid' })
  })
  // 7.0.52 (Q1 15:06): spaces are invalid JSON anyway, so the size cap needs a VALID log on each side of it.
  it('a valid log of exactly maxBytes reads; one byte more is invalid', () => {
    const sized = (bytes: number) => {
      const base = JSON.stringify({ ...rawFunnelLog(), pad: '' })
      const out = JSON.stringify({ ...rawFunnelLog(), pad: 'x'.repeat(bytes - base.length) })
      expect(Buffer.byteLength(out)).toBe(bytes)
      return out
    }
    const at = join(dir, 'at.json'), over = join(dir, 'over.json')
    writeFileSync(at, sized(FUNNEL_LOG_LIMITS.maxBytes))
    writeFileSync(over, sized(FUNNEL_LOG_LIMITS.maxBytes + 1))
    expect(funnelLogReader(at, () => SF_NOW)().ok).toBe(true)
    expect(funnelLogReader(over, () => SF_NOW)()).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('the file notes', () => {
  it('a note of 300 characters is kept; one of 301 is dropped', () => {
    const keep = 'k'.repeat(300), drop = 'd'.repeat(301)
    expect(log(rawFunnelLog({ notes: [keep, drop] })).notes).toEqual([keep])
  })
})

describe('the meeting assistant text at the parser limits (7.0.52, Q1 15:06)', () => {
  // Every field at the most the parser accepts: maxRows rows, a 60-character org and 40-character industry, all four stages disagreeing,
  // maxNotes notes of 300 characters, a 160-character Tableau label. Without the cap this text runs to tens of thousands of characters.
  const maxed = () => {
    const raw = rawFunnelLog({ tableau: { ...rawFunnelLog().tableau, label: 'L'.repeat(160) }, notes: Array.from({ length: FUNNEL_LOG_LIMITS.maxNotes + 2 }, (_, i) => `${i}`.repeat(300)) })
    const st = (n: number) => ({ tableau: n, salesforce: n + 7, today_salesforce: 3, prior_month_sp: n + 20, last_year_sp: n + 5, budget_to_date: 40.5, pct_to_goal: 99.5, disagree: true })
    raw.rows = Array.from({ length: FUNNEL_LOG_LIMITS.maxRows }, (_, i) => ({ org: `org${i}`.padEnd(60, 'o'), industry: `ind${String(i).padStart(2, '0')}`.padEnd(40, 'q'),
      stages: { leads: st(1000 + i), opps: st(500 + i), demos: st(300 + i), customers: st(100 + i) } }))
    const l = log(raw)
    expect(l.rows).toHaveLength(FUNNEL_LOG_LIMITS.maxRows)
    expect(l.notes).toHaveLength(FUNNEL_LOG_LIMITS.maxNotes)
    return l
  }
  // What gives way at these limits, in order: rows (with a line saying how many are not shown), the elsewhere line, notes, the industry
  // names in "Not in this log" (300 characters, then "and N more"). The head, the disagreement line (700 characters, then "and N more") and
  // the "Not in this log" and "This question asks for" lines are never cut, and together they fit in askChars even at the parser's limits.
  it('stays within askChars; rows and the industry list give way while the disagreement and "This question asks for" lines stay whole', () => {
    // with a Tableau sheet for other days and SBU named, the mismatch and BU lines are in the head too: the most the kept lines can be
    for (const [facts_, groups] of [[null, null], [facts(), [group('SBU')]]] as const) {
      const { text } = funnelLogForAsk(maxed(), 'leads, opps, demos and customers by lead source and rep, SQLs and conversion', facts_, groups)
      expect(text.length).toBeLessThanOrEqual(FUNNEL_LOG_LIMITS.askChars)
      expect(text).toMatch(/^Salesforce, queried live through Coefficient/)
      const lines = text.split('\n')
      const dis = lines.findIndex(l => l.startsWith('Tableau and Salesforce disagree on: ind00'))
      const notIn = lines.findIndex(l => l.startsWith('Not in this log: '))
      expect(dis).toBeGreaterThan(0)
      expect(lines[dis]).toMatch(/; and \d+ more\.$/)                       // bounded, never cut mid-item
      expect(lines[notIn]).toMatch(/industries other than ind00q+, [^\n]*, and \d+ more\. Ask cannot query Salesforce live/)
      expect(lines.at(-1)).toMatch(/^This question asks for [^\n]*: the daily log does not carry it\. Say so; do not answer it from these totals\.$/)
      expect(dis).toBeLessThan(notIn)                                         // reading order kept
      expect(text).toMatch(/\n\d+ more industries are not shown here\.\n/)  // rows gave way, and say so
      expect(lines.filter(l => l.startsWith('ind'))).not.toHaveLength(FUNNEL_LOG_LIMITS.maxRows)
    }
    // Short rows can fill the budget to the last character: room is kept for the line that says rows were left out.
    const short = rawFunnelLog({ notes: Array.from({ length: FUNNEL_LOG_LIMITS.maxNotes }, (_, i) => `${i}`.repeat(300)) })
    short.rows = Array.from({ length: FUNNEL_LOG_LIMITS.maxRows }, (_, i) => ({ ...rawFunnelLog().rows[0], industry: `Industry${String(i).padStart(2, '0')}` }))
    expect(funnelLogForAsk(log(short), 'how many opps came from leads created this month', null, null).text).toMatch(/\n\d+ more industries are not shown here\.\n/)
  })
  // Q1 15:32: the order among the lines that give way. Rows before notes; the elsewhere line before notes; reading order kept.
  it('rows are kept before notes: an every-stage question at the limits keeps rows and no note', () => {
    const lines = funnelLogForAsk(maxed(), 'leads, opps, demos and customers', null, null).text.split('\n')
    expect(lines.filter(l => l.startsWith('ind')).length).toBeGreaterThan(0)
    expect(lines.filter(l => l.startsWith('Note: '))).toHaveLength(0)
  })
  it('the elsewhere line is kept before notes: one industry asked at the limits keeps it', () => {
    const ind = maxed().rows[0].industry
    const lines = funnelLogForAsk(maxed(), `${ind} opps`, null, null).text.split('\n')
    expect(lines.some(l => l.startsWith('Elsewhere in the log they disagree on '))).toBe(true)
    expect(lines.filter(l => l.startsWith('Note: ')).length).toBeLessThan(FUNNEL_LOG_LIMITS.maxNotes)
  })
  it('reading order: the disagreement line, then the elsewhere line, then the notes', () => {
    const lines = funnelLogForAsk(log(), 'liquor opps', null, null).text.split('\n')
    const dis = lines.findIndex(l => l.startsWith('Tableau and Salesforce disagree on: ')), els = lines.findIndex(l => l.startsWith('Elsewhere in the log '))
    const note = lines.findIndex(l => l.startsWith('Note: '))
    expect(dis).toBeGreaterThan(0)
    expect(els).toBeGreaterThan(dis)
    expect(note).toBeGreaterThan(els)
  })
})

describe('the meeting assistant text', () => {
  it('the 11/16 question: both sources with their as-of times, and the Liquor opps disagreement in words', () => {
    const { title, text } = funnelLogForAsk(log(), 'How many opps are from this month in Liquor?', null, null)
    expect(title).toBe('Salesforce via Coefficient, Nov 1 to 15, marketing sources, queried Nov 16 07:08 CT')
    expect(text).toContain('Salesforce, queried live through Coefficient Nov 16 07:08 CT, beside Tableau for the same window: Nov 1 to 15')
    expect(text).toContain('Tableau side: Tableau, Nov 2026 to Nov 15, marketing sources, extract refreshed Nov 16 05:28 CT.')
    expect(text).toContain('Liquor (POS Nation org): opps Salesforce 40 vs Tableau 38 [DISAGREE: Salesforce 2 higher]; Tableau budget to date 45.5 (84% to goal); Salesforce on Nov 16 through 07:08 CT +0; Salesforce PM 65, PY 47')
    expect(text).toContain('Tableau and Salesforce disagree on: Liquor opps: Salesforce 40, Tableau 38 (Salesforce 2 higher).')
    // the stage not asked about is not dropped from view: it is named as elsewhere
    expect(text).toContain('Elsewhere in the log they disagree on 1 more: Liquor demos: Salesforce 34, Tableau 32 (Salesforce 2 higher).')
    expect(text).not.toContain('Grocery (')
    expect(text).toContain('Not in this log: SQLs, lead-cohort splits')
    expect(text).toContain('Ask cannot query Salesforce live')
    expect(text).toContain('Note: Tableau dates leads on UTC days')
    expect(text).not.toMatch(/[—–]|->|→/)
  })
  it('no group and no stage named ("use the tableau and SFDC coefficient"): every row, every stage, every disagreement', () => {
    const { text } = funnelLogForAsk(log(), 'use the tableau and SFDC coefficient.', null, null)
    // three industries by four stages is past half the budget: one compact line each, Salesforce over Tableau
    expect(text).toContain('Liquor (POS Nation org) Salesforce/Tableau: leads 71/72 (66% to goal), opps 40/38 DISAGREE (84% to goal), demos 34/32 DISAGREE (85% to goal), customers 10/11 (44% to goal)')
    for (const row of ['Grocery (POS Nation org) Salesforce/Tableau', 'Thrift (Rain Retail org) Salesforce/Tableau']) expect(text).toContain(row)
    expect(text).toContain('Tableau and Salesforce disagree on: Liquor opps: Salesforce 40, Tableau 38 (Salesforce 2 higher); Liquor demos: Salesforce 34, Tableau 32 (Salesforce 2 higher).')
    expect(text).not.toContain('Elsewhere in the log')
    expect(text).not.toContain('This question asks for')        // "sources" in a question is not a lead-source question
    expect(text.length).toBeLessThanOrEqual(FUNNEL_LOG_LIMITS.askChars)
  })
  it('a row with no disagreement says they agree', () => {
    const { text } = funnelLogForAsk(log(), 'thrift opps?', null, null)
    expect(text).toContain('Thrift (Rain Retail org): opps Salesforce 17 vs Tableau 17; Tableau budget to date 40 (43% to goal); Salesforce on Nov 16 through 07:08 CT +1')
    expect(text).toContain('Tableau and Salesforce agree within 1 on everything shown.')
    expect(text).toContain('Elsewhere in the log they disagree on 2 more')
  })
  it.each([
    ['How many liquor opps came from leads created this month?', 'lead-cohort splits'],
    ['what is the liquor opp cohort by lead month', 'lead-cohort splits'],
    ['how many SQLs in liquor', 'SQLs'],
    ['liquor opps by lead source', 'lead-source or campaign detail'],
    ['which BDR set the most liquor demos', 'rep or owner detail'],
    ['what is the liquor lead to opp conversion', 'conversion rates'],
  ])('says what the log does not carry: %s', (q, what) => {
    expect(funnelLogForAsk(log(), q, null, null).text).toMatch(new RegExp(`This question asks for [^\\n]*${what}[^\\n]*: the daily log does not carry it`))
  })
  it.each(['use both sources', 'how are liquor opps pacing', 'check SFDC for grocery demos'])('a plain funnel question is not flagged as uncovered: %s', q => {
    expect(funnelUncovered(q)).toEqual([])
  })
  it('another window: Salesforce alone, said not compared', () => {
    const { text } = funnelLogForAsk(log(rawFunnelLogOtherWindow()), 'liquor opps', null, null)
    expect(text).toContain('Tableau covered a different window when this log was written, so no Tableau figure is compared here.')
    expect(text).toContain('Liquor (POS Nation org): opps Salesforce 40; Salesforce on Nov 16')
    expect(text).not.toContain('DISAGREE')
    expect(text).not.toContain('vs Tableau')
    expect(text).toContain('agree within 1 on everything shown (not compared: different windows).')
  })
  it('names the mismatch when the Tableau sheet loaded now covers other days than the log', () => {
    const { text } = funnelLogForAsk(log(), 'liquor opps', facts(), [group('Liquor')])   // the Tableau fixture is the October close
    expect(text).toContain('The Tableau sheet loaded now covers Oct 1 to 31, not Nov 1 to 15: compare it with this log only for the same days.')
  })
  it('SBU from the Tableau groups is the POS Nation rows, listed and never totalled', () => {
    const { text } = funnelLogForAsk(log(), 'SBU opps', facts(), [group('SBU')])
    expect(text).toContain('Liquor (POS Nation org)')
    expect(text).toContain('Grocery (POS Nation org)')
    expect(text).not.toContain('Thrift (')
    expect(text).toContain('The log has no SBU or XBU total')
  })
  it('a group the log does not cover falls back to every row', () => {
    expect(funnelRowsFor(log(), [group('Pet')], '')).toEqual([])
    expect(funnelLogForAsk(log(), 'pet opps', facts(), [group('Pet')]).text).toContain('Thrift (Rain Retail org)')
  })
  it('without the Tableau sheet, industries are found by name and the bare word quilt is never one', () => {
    const raw = rawFunnelLog(); raw.rows.push({ org: 'Rain Retail', industry: 'Quilt', stages: { opps: { salesforce: 5, tableau: 5, disagree: false } } })
    const l = log(raw)
    expect(funnelRowsFor(l, null, 'quilt opps this month')).toBeNull()
    expect(funnelRowsFor(l, null, 'like sew opps')?.map(r => r.industry)).toEqual(['Quilt'])
    expect(funnelRowsFor(l, null, 'xbu opps')?.map(r => r.industry)).toEqual(['Thrift', 'Quilt'])
  })
  it('spanText', () => {
    expect(spanText(['2026-11-01', '2026-11-15'])).toBe('Nov 1 to 15')
    expect(spanText(['2026-10-28', '2026-11-03'])).toBe('Oct 28 to Nov 3')
    expect(spanText(['2026-11-16', '2026-11-16'])).toBe('Nov 16')
  })
})

describe('the data cue clause', () => {
  it('Liquor opps: Salesforce beside the same stage, and the disagreement', () => {
    const c = funnelCueClause(log(), [group('Liquor')], ['opps'])
    expect(c).toBe('Salesforce via Coefficient, Nov 1 to 15, queried Nov 16 07:08 CT: Liquor opps 40. Disagree: Liquor opps Tableau 38 vs Salesforce 40.')
  })
  it('no stage named: leads, opps and customers, and only the disagreement among them', () => {
    const c = funnelCueClause(log(), [group('Liquor')], [])
    expect(c).toContain('Liquor leads 71, opps 40, customers 10.')
    expect(c).toContain('Disagree: Liquor opps Tableau 38 vs Salesforce 40.')
    expect(c.length).toBeLessThanOrEqual(FUNNEL_LOG_LIMITS.cueChars)
  })
  it('two industries named: a disagreement on the second is said, not only the first', () => {
    expect(funnelCueClause(log(), [group('Thrift'), group('Liquor')], ['opps'])).toBe(
      'Salesforce via Coefficient, Nov 1 to 15, queried Nov 16 07:08 CT: Thrift opps 17; Liquor opps 40. Disagree: Liquor opps Tableau 38 vs Salesforce 40.')
  })
  it('agreement is said too', () => {
    expect(funnelCueClause(log(), [group('Thrift')], ['opps'])).toContain('Thrift opps 17. Agrees with Tableau within 1.')
  })
  it('another window: Salesforce alone, said not compared', () => {
    expect(funnelCueClause(log(rawFunnelLogOtherWindow()), [group('Liquor')], ['opps'])).toContain('Liquor opps 40. Not compared: Tableau covered another window.')
  })
  it('nothing for a BU or an industry the log does not cover', () => {
    expect(funnelCueClause(log(), [group('SBU')], ['opps'])).toBe('')
    expect(funnelCueClause(log(), [group('Pet')], ['opps'])).toBe('')
  })
  it('over the cap, the figures shrink but every disagreement on what is shown is still said with both numbers', () => {
    const c = funnelCueClause(log(), [group('Liquor'), group('Thrift')], ['leads', 'opps', 'demos', 'customers'])
    expect(c.length).toBeLessThanOrEqual(FUNNEL_LOG_LIMITS.cueChars)
    expect(c).toContain('Liquor opps Tableau 38 vs Salesforce 40')
    expect(c).toContain('Liquor demos Tableau 32 vs Salesforce 34')
  })
})

describe('routing a typed question to Salesforce', () => {
  it.each([
    ['use the tableau and SFDC coefficient.', true],
    ['what does Salesforce say for liquor', true],
    ['check sales force', true],
    ['coefficient numbers for liquor', true],
    ['pull it from coefficient', false],
    ['what is the correlation coefficient here', false],
    ['how are liquor opps pacing', false],
  ])('%s', (q, yes) => {
    expect(askNamesSalesforce(q)).toBe(yes)
  })
})
