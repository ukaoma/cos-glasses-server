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
