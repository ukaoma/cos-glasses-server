// Live cues data arm, pure parts: the file contract, staleness, the trigger, the candidate text, how the candidate sits among the
// grounded candidates and what the meeting assistant reads. The engine and the meeting assistant are in their own test files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DATA_FACTS_LIMITS as L, askDataIntent, askUserWords, dataArmGate, dataCandidate, dataCandidateText, dataFactsForAsk, dataFactsReader, dataTrigger, namedGroups,
  isQuiltDomain, parseDataFacts, quiltTitleSignal, readDataFactsFile, recentSpeech, refreshText, type DataFacts,
} from './live-cues-v2-data.js'
import { GROUNDED_LIMITS, groundedCandidates, groundedSource, selfIdSet, shingleSet, type GroundedNote } from './live-cues-v2-grounded.js'
import { isCueSourceExtras, isLiveCueV2, type LiveCueV2 } from '../../shared/live-cues-v2.js'
import { isLogRow, type LiveCueLogRow } from './live-cue-verdicts.js'

import { ASOF, HOUR, NOW, rawFacts, type Raw } from './__fixtures__/live-cues-v2-data-fixture.js'

function facts(over: Raw = {}): DataFacts {
  const r = parseDataFacts(rawFacts(over), NOW)
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`)
  return r.facts
}

describe('the contract', () => {
  it('a valid file reads, with asOf in ms and every group', () => {
    const f = facts()
    expect(f.label).toBe('Tableau, Oct 2026 close, marketing sources')
    expect(f.asOf).toBe(Date.parse(ASOF))
    expect(f.groups.map(g => g.name)).toEqual(['SBU', 'XBU', 'Liquor', 'Thrift', 'Pet', 'Quilt', 'Dive'])
    expect(f.groups[0].coverage).toEqual({ have: 3, of: 4 })
    expect(f.sources).toHaveLength(3)
  })
  it.each([
    ['not an object', null], ['an array', []], ['v 2', { ...rawFacts(), v: 2 }], ['another source', { ...rawFacts(), source: 'Salesforce' }],
    ['no label', { ...rawFacts(), label: '' }], ['no scope', { ...rawFacts(), scope: undefined }], ['no period', { ...rawFacts(), period: undefined }],
    ['closed not a boolean', { ...rawFacts(), period: { label: 'Oct 2026', start: '2026-10-01', end: '2026-10-31', closed: 'yes' } }],
    ['asOf not a date', { ...rawFacts(), asOf: 'yesterday' }], ['asOf missing', { ...rawFacts(), asOf: undefined }],
    ['groups not an array', { ...rawFacts(), groups: {} }], ['no usable group', { ...rawFacts(), groups: [{ name: 'X' }, 7, null] }],
  ])('malformed (%s) is invalid', (_n, raw) => {
    expect(parseDataFacts(raw, NOW)).toEqual({ ok: false, reason: 'invalid' })
  })
  it('a group that does not parse is dropped, never guessed at; the rest stay', () => {
    const raw = rawFacts()
    raw.groups[2].aliases = ['liquor', 7]                       // an alias that is not a string
    raw.groups[3].stages = { leads: { actual: 'many' } }        // no stage with a numeric actual
    raw.groups[4].aliases = []; raw.groups[4].weakAliases = []  // nothing to name it by
    expect(facts(raw).groups.map(g => g.name)).toEqual(['SBU', 'XBU', 'Quilt', 'Dive'])
  })
  it('a stage without a numeric actual is dropped from its group, a null budget stays null', () => {
    const raw = rawFacts()
    raw.groups[2].stages.sqls = { actual: null }
    raw.groups[2].stages.demos = { actual: 88, budget: null }
    const liquor = facts(raw).groups[2]
    expect(liquor.stages.sqls).toBeUndefined()
    expect(liquor.stages.demos).toMatchObject({ actual: 88, budget: null, pctToGoal: null })
  })
  it('source rows that do not parse are dropped', () => {
    const raw = rawFacts({ sources: [{ industry: 'Liquor', source: 'Organic Direct', leads: 1, opps: 1, customers: 1 }, { industry: 'Liquor', source: 'X', leads: 'a' }, 4] })
    expect(facts(raw).sources).toHaveLength(1)
  })
  const OPEN = { period: { label: 'Nov 2026', start: '2026-11-01', end: '2026-11-04', closed: false }, label: 'Tableau, Nov 2026 to Nov 4, marketing sources' }
  it('stale, open month: older than 120 hours from asOf is off, 120 hours exactly is still on', () => {
    expect(L.maxAgeHours).toBe(120)
    const asOf = Date.parse(ASOF)
    expect(parseDataFacts(rawFacts(OPEN), asOf + 120 * HOUR).ok).toBe(true)
    expect(parseDataFacts(rawFacts(OPEN), asOf + 120 * HOUR + 1)).toEqual({ ok: false, reason: 'stale' })
    expect(parseDataFacts(rawFacts(OPEN), asOf + 72 * HOUR).ok).toBe(true)   // Monday morning after Friday's run
  })
  it('stale, closed month: 120 hours does not take it off; 35 days from asOf does', () => {
    expect(L.maxClosedAgeDays).toBe(35)
    const asOf = Date.parse(ASOF), day = 24 * HOUR
    expect(parseDataFacts(rawFacts(), asOf + 121 * HOUR).ok).toBe(true)     // the Monday after a Thursday month start
    expect(parseDataFacts(rawFacts(), asOf + 10 * day).ok).toBe(true)
    expect(parseDataFacts(rawFacts(), asOf + 35 * day).ok).toBe(true)
    expect(parseDataFacts(rawFacts(), asOf + 35 * day + 1)).toEqual({ ok: false, reason: 'stale' })
  })
  it('a file dated more than an hour ahead of the clock is off; a minute ahead is not', () => {
    const asOf = Date.parse(ASOF)
    expect(parseDataFacts(rawFacts(), asOf - L.maxFutureMs - 1)).toEqual({ ok: false, reason: 'future' })
    expect(parseDataFacts(rawFacts(), asOf - 60_000).ok).toBe(true)
  })
})

describe('reading the file', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'data-facts-')); path = join(dir, 'data-facts.json') })
  afterEach(() => { try { chmodSync(path, 0o600) } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }) })

  it('missing, unreadable, malformed JSON and an oversize file are four different answers', () => {
    expect(readDataFactsFile(path, NOW)).toEqual({ ok: false, reason: 'missing' })
    writeFileSync(path, '{not json')
    expect(readDataFactsFile(path, NOW)).toEqual({ ok: false, reason: 'invalid' })
    writeFileSync(path, ' '.repeat(L.maxBytes + 1))
    expect(readDataFactsFile(path, NOW)).toEqual({ ok: false, reason: 'invalid' })
    writeFileSync(path, JSON.stringify(rawFacts()))
    expect(readDataFactsFile(path, NOW).ok).toBe(true)
    chmodSync(path, 0o000)
    expect(readDataFactsFile(path, NOW)).toEqual({ ok: false, reason: 'unreadable' })
  })
  it('a directory where the file should be is invalid, not a throw', () => {
    expect(readDataFactsFile(dir, NOW)).toEqual({ ok: false, reason: 'invalid' })
  })
  it('the reader re-parses on change, checks staleness on every call, and follows the file away and back', () => {
    let now = NOW
    const read = dataFactsReader(path, () => now)
    expect(read()).toEqual({ ok: false, reason: 'missing' })
    writeFileSync(path, JSON.stringify(rawFacts()))
    const first = read()
    expect(first.ok && first.facts.label).toBe('Tableau, Oct 2026 close, marketing sources')
    now = Date.parse(ASOF) + 36 * 24 * HOUR
    expect(read()).toEqual({ ok: false, reason: 'stale' })           // same bytes, later clock
    now = NOW
    writeFileSync(path, JSON.stringify(rawFacts({ label: 'Tableau, Nov 2026 to Nov 3, marketing sources' })))
    utimesSync(path, new Date(NOW + 5_000), new Date(NOW + 5_000))
    const second = read()
    expect(second.ok && second.facts.label).toBe('Tableau, Nov 2026 to Nov 3, marketing sources')
    writeFileSync(path, '[]'); utimesSync(path, new Date(NOW + 9_000), new Date(NOW + 9_000))
    expect(read()).toEqual({ ok: false, reason: 'invalid' })
    unlinkSync(path)
    expect(read()).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('the trigger', () => {
  const f = facts()
  const fires = (w: string) => dataTrigger(f, w).fired
  it.each([
    'liquor leads were way down last month',
    'SBU closed at 120% of MRR budget, 148 vs 131 locations',
    'thrift customers are at 18',
    'Bottle POS opps look healthy',
    'the pet vertical leads are above plan',
    'what are the leads for pet this month',
    'jewelry is not in the list but thrift is at 85 percent',
    'XBU is behind on new logos',
    'thrift is up 5% on the month',
    'liquor is at 1,200 and 40.5 percent of what we said',
    'ThriftCart pacing is fine',
    'Like Sew customers are at 13',
  ])('a named group with a funnel word or a figure fires: %s', w => { expect(fires(w)).toBe(true) })
  it.each([
    ['a group alone', 'we visited a liquor store owner yesterday and he was friendly'],
    ['a funnel word alone', 'leads were down this week and demos too, we should look at the ads'],
    ['a figure alone', 'the review is at 12:30 on the 15th'],
    ['a group beside a time, a year and a digit inside a word', 'liquor stores in 2027 at 10:30 said10 and room2b'],
    ['unrelated talk', 'lunch is at noon, who is driving'],
    ['a group and a one-digit number', 'we met the thrift manager at 5'],
    ['a weak word with no funnel beside it', 'let us dive into the numbers for 2027'],
    ['pet as a project', 'it is a pet project with 40 hours so far'],
    ['dive with a far-off funnel word', 'we dive deep on the topic and then talked about the leads in the spreadsheet we shared'],
    ['the company, not the industry', 'Quilt customers grew 40 percent and Quilt leads too'],
    ['a group said long ago', 'liquor was mentioned. ' + 'filler words go here '.repeat(40) + ' now leads are 40'],
  ])('%s does not fire', (_n, w) => { expect(fires(w)).toBe(false) })
  it('reports why it did not fire', () => {
    expect(dataTrigger(f, 'liquor store')).toEqual({ fired: false, why: 'no_funnel' })
    expect(dataTrigger(f, 'leads and demos')).toEqual({ fired: false, why: 'no_group' })
  })
  it('reads only the last 600 characters', () => {
    const old = 'liquor customers '
    const tail = 'x'.repeat(L.recentChars)
    expect(fires(old + tail + ' leads')).toBe(false)
    expect(L.recentChars).toBe(600)
    expect(recentSpeech('a'.repeat(1000)).length).toBeLessThanOrEqual(600)
    expect(recentSpeech('short')).toBe('short')
  })
  it('a weak alias needs a funnel or industry word right beside it, or one bridge word away', () => {
    const named = (w: string) => namedGroups(f, w).map(n => n.group.name)
    expect(named('pet leads')).toEqual(['Pet'])
    expect(named('leads for pet')).toEqual(['Pet'])
    expect(named('customers in dive')).toEqual(['Dive'])
    expect(named('dive into the numbers')).toEqual([])
    expect(named('dive in leads')).toEqual(['Dive'])        // a bridge word; the price of keeping "leads in dive" working
    expect(named('pets are great and we have 40 leads')).toEqual([])
  })
  it('names the group said last first, at most two, and the stages it heard', () => {
    const t = dataTrigger(f, 'liquor opps are up, and thrift customers and thrift leads, SBU too')
    expect(t.fired && t.groups.map(g => g.name)).toEqual(['SBU', 'Thrift'])
    expect(t.fired && t.stages).toEqual(['leads', 'opps', 'customers'])
    const three = dataTrigger(f, 'liquor leads, thrift leads, pet vertical leads')
    expect(three.fired && three.groups).toHaveLength(2)
  })
  it('the bare word quilt is never enough', () => {
    expect(namedGroups(f, 'quilt leads quilt customers quilt budget')).toEqual([])
    expect(namedGroups(f, 'the quilt industry has 13 customers').map(n => n.group.name)).toEqual(['Quilt'])
  })
  it('brand aliases mark a group as named by a Quilt brand; an industry word does not', () => {
    const brand = (w: string) => namedGroups(f, w).map(n => [n.group.name, n.brand])
    expect(brand('Bottle POS leads')).toEqual([['Liquor', true]])
    expect(brand('liquor leads')).toEqual([['Liquor', false]])
    expect(brand('SBU leads')).toEqual([['SBU', true]])
    expect(brand('etailpet leads and pet leads')).toEqual([['Pet', true]])
    const t = dataTrigger(f, 'grocery budget'), u = dataTrigger(f, 'thrift budget and ThriftCart leads')
    expect(t.fired).toBe(false)                                    // grocery is not in this fixture
    expect(u.fired && u.brand).toBe(true)
    const w = dataTrigger(f, 'liquor leads are 40')
    expect(w.fired && w.brand).toBe(false)
  })
})

describe('the domain gate', () => {
  const g = (over: Partial<Parameters<typeof dataArmGate>[0]> = {}) => dataArmGate({ domain: null, brand: false, ...over })
  it('a Quilt meeting runs, however it is written', () => {
    for (const d of ['quilt', 'Quilt', ' quilt ']) expect(g({ domain: d })).toEqual({ ok: true, signal: 'quilt' })
  })
  it('another confirmed domain never runs, whatever else is true', () => {
    for (const d of ['personal', 'Personal', 'sprocket_rocket', 'hermit_crabs', 'DNP study']) {
      expect(g({ domain: d, brand: true, memoryQuilt: true, titleQuilt: true }), d).toEqual({ ok: false, why: 'domain' })
    }
  })
  it('an orientation that could not be read is off, even with every signal', () => {
    expect(g({ orientationFailed: true, brand: true, memoryQuilt: true, titleQuilt: true })).toEqual({ ok: false, why: 'orientation' })
    expect(g({ orientationFailed: true, domain: 'quilt' })).toEqual({ ok: false, why: 'orientation' })
  })
  it('no confirmed domain (null, undefined, empty, blank): off without a Quilt signal, on with one, each named', () => {
    for (const d of [null, undefined, '', '  ']) {
      expect(g({ domain: d }), String(d)).toEqual({ ok: false, why: 'unconfirmed' })
      expect(g({ domain: d, brand: true })).toEqual({ ok: true, signal: 'brand' })
      expect(g({ domain: d, memoryQuilt: true })).toEqual({ ok: true, signal: 'memory' })
      expect(g({ domain: d, titleQuilt: true })).toEqual({ ok: true, signal: 'title' })
    }
  })
  it('a Quilt-domain note is one whose domain says quilt, nothing else', () => {
    expect(isQuiltDomain('quilt')).toBe(true); expect(isQuiltDomain(' Quilt ')).toBe(true)
    for (const d of ['personal', 'hermit_crabs', '', undefined, null, 7]) expect(isQuiltDomain(d)).toBe(false)
  })
  it('a Quilt term in a title: quilt, sbu, xbu, tableau, or a brand in the facts; nothing for a generic title', () => {
    const f = facts()
    for (const t of ['Quilt weekly forecast', 'SBU pacing review', 'XBU sync', 'Tableau walk-through', 'Bottle POS launch', 'ThriftCart renewal call']) expect(quiltTitleSignal(f, [t]), t).toBe(true)
    for (const t of ['G2 Recording 2026-10-19 0741', 'Family dinner plans', 'Sprocket Rocket client call', 'Grocery list', '', null, undefined]) expect(quiltTitleSignal(f, [t]), String(t)).toBe(false)
    expect(quiltTitleSignal(f, ['Family', 'Quilt sync'])).toBe(true)
  })
})

describe('the candidate', () => {
  const f = facts()
  const text = (w: string) => { const r = dataCandidate(f, w, '2026-11-02'); if (!('candidate' in r)) throw new Error(r.none); return r.candidate }

  it('states the period, the scope, the refresh time, actual against budget and % to goal', () => {
    const c = text('SBU closed at 120% of MRR budget, 148 vs 131 locations')
    expect(c.notes).toBe('Tableau Oct 2026 final, marketing-sourced funnel only, actual vs budget to date, refreshed Nov 2 05:41 CT. '
      + 'SBU (3 of 4 industries): leads 402 vs 428 (94%), opps 190 vs 175 (109%), customers 54 vs 81 (67%).')
    expect(c.title).toBe('Tableau, Oct 2026 close, marketing sources')
    expect(c.date).toBe('2026-11-02')
    expect(c).toMatchObject({ id: 'D1', arm: 'data', kind: 'data' })
  })
  it('never says revenue, MRR or locations, and always says marketing-sourced', () => {
    for (const w of ['SBU leads 40', 'liquor customers', 'thrift pacing and pet vertical budget']) {
      const n = text(w).notes
      expect(n).toMatch(/marketing-sourced funnel only/)
      expect(n).not.toMatch(/revenue|MRR|locations/i)
    }
  })
  it('shows the stage the room named, with the prior month and last year when it is the only one', () => {
    expect(text('liquor leads were way down last month').notes).toContain('Liquor: leads 191 vs 231 (83%), prior month same period 211, last year 196.')
    expect(text('liquor leads and customers').notes).toContain('Liquor: leads 191 vs 231 (83%), customers 32 vs 53 (60%).')
    expect(text('liquor sqls').notes).toContain('Liquor: sqls 87 vs 84 (104%)')
  })
  it('a group missing the named stage shows its own stages instead of nothing', () => {
    expect(text('quilt industry demos were 13').notes).toContain('Quilt industry (Like Sew): leads 50 vs 38 (132%), customers 13 vs 16 (81%).')
  })
  it('a null budget says so instead of a percent', () => {
    const raw = rawFacts(); raw.groups[2].stages.leads = { actual: 191, budget: null }
    const r = dataCandidate(facts(raw), 'liquor leads', '2026-11-02')
    expect('candidate' in r && r.candidate.notes).toContain('Liquor: leads 191 (no budget)')
  })
  it('an open month says month to date and the end date', () => {
    const raw = rawFacts({ label: 'Tableau, Nov 2026 to Nov 9, marketing sources', period: { label: 'Nov 2026', start: '2026-11-01', end: '2026-11-09', closed: false } })
    const r = dataCandidate(facts(raw), 'liquor leads', '2026-11-10')
    expect('candidate' in r && r.candidate.notes.startsWith('Tableau Nov 2026 to Nov 9, month to date, marketing-sourced')).toBe(true)
  })
  it('is at most 300 characters, dropping the second group and then stages before it cuts', () => {
    const w = 'liquor leads opps sqls demos customers and thrift leads opps sqls demos customers'
    const c = text(w)
    expect(L.candidateChars).toBe(300)
    expect(c.notes.length).toBeLessThanOrEqual(300)
    expect(c.notes).toContain('Liquor: leads')
    const raw = rawFacts(); raw.groups[2].name = 'Liquor and spirits industry group'; raw.groups[2].display = 'Liquor and spirits industry group across every market we sell into'
    const long = dataCandidate(facts(raw), w, '2026-11-02')
    expect('candidate' in long && long.candidate.notes.length).toBeLessThanOrEqual(300)
  })
  it('refresh time reads as the file states it, CT for a Central offset', () => {
    expect(refreshText('2026-11-02T05:41:00-06:00')).toBe('Nov 2 05:41 CT')
    expect(refreshText('2026-06-02T05:41:00-05:00')).toBe('Jun 2 05:41 CT')
    expect(refreshText('2026-11-02T05:41:00+01:00')).toBe('Nov 2 05:41 +01:00')
    expect(refreshText('2026-11-02T05:41:00Z')).toBe('Nov 2 05:41 Z')
    expect(refreshText('not a date')).toBe('not a date')
  })
  it('no stage to show is no candidate', () => {
    expect(dataCandidateText(f, [], [])).toBe('')
  })
})

describe('among the grounded candidates', () => {
  const f = facts()
  const data = (): GroundedNote => { const r = dataCandidate(f, 'SBU leads 402 vs 428', '2026-11-02'); if (!('candidate' in r)) throw new Error('none'); return r.candidate }
  const note = (id: string, over: Partial<GroundedNote> = {}) => ({ id, date: '2026-09-01', title: `Past ${id}`, notes: `Summary of ${id}`, key: `2026-09-01|past ${id}`, domain: 'quilt', ...over })
  const base = { cueMemory: [] as any[], notes: [] as any[], files: [], transcript: new Set<string>(), window: '', selfIds: selfIdSet('meeting_a'), meetingDomain: 'quilt' as string | null, today: '2026-11-02' }

  it('is D1, counted, after the others', () => {
    const r = groundedCandidates({ ...base, cueMemory: [note('M1')], notes: [note('N1', { key: 'memory:abc', memoryId: 'abc' })], data: data() })
    expect(r.candidates.map(c => c.id)).toEqual(['M1', 'N1', 'D1'])
  })
  it('when the six are full, D1 displaces the lowest-ranked memory, never the file passage or the note', () => {
    const mems = [1, 2, 3, 4].map(i => note(`m${i}`, { date: `2026-09-0${i}` }))
    const files = [{ id: 'f1', name: 'Plan.txt', status: 'ready', text: 'overage pricing renewal contract Harborview quarter terms' }]
    const full = { ...base, cueMemory: mems, notes: [note('n1', { key: 'memory:x1', memoryId: 'x1', title: 'Other' })], files, window: 'overage pricing renewal contract Harborview quarter' }
    const without = groundedCandidates(full)
    expect(without.candidates.map(c => c.arm)).toEqual(['cue_memory', 'cue_memory', 'cue_memory', 'cue_memory', 'notes', 'files'])
    expect(without.candidates).toHaveLength(GROUNDED_LIMITS.maxCandidates)
    const withData = groundedCandidates({ ...full, data: data() })
    expect(withData.candidates.map(c => c.arm)).toEqual(['cue_memory', 'cue_memory', 'cue_memory', 'notes', 'files', 'data'])
    expect(withData.candidates.map(c => c.id)).toEqual(['M1', 'M2', 'M3', 'N1', 'F1', 'D1'])   // M4, the lowest ranked, is the one that went
    expect(withData.candidates).toHaveLength(GROUNDED_LIMITS.maxCandidates)
  })
  it('with room to spare nothing is displaced', () => {
    const r = groundedCandidates({ ...base, cueMemory: [note('m1'), note('m2', { date: '2026-09-02' })], data: data() })
    expect(r.candidates.map(c => c.id)).toEqual(['M1', 'M2', 'D1'])
  })
  it('is not a copy of any meeting: a room that reads the numbers aloud does not exclude it', () => {
    const d = data()
    const transcript = shingleSet(d.notes)                                  // every 6-word sequence of the candidate was said
    const r = groundedCandidates({ ...base, transcript, data: d })
    expect(r.candidates.map(c => c.id)).toEqual(['D1'])
    expect(r.excludedSelf).toBe(0)
    // the same text as a memory note would be excluded: this is the rule it is exempt from
    expect(groundedCandidates({ ...base, transcript, cueMemory: [note('m1', { notes: d.notes })] }).excludedSelf).toBe(1)
  })
  it('is not subject to the personal-domain rule and does not count as a note without a domain', () => {
    const r = groundedCandidates({ ...base, meetingDomain: 'personal', data: data() })
    expect(r.candidates.map(c => c.arm)).toEqual(['data'])
    expect(r.domainUnknown).toBe(0)
  })
  it('its twin or a meeting titled the same does not hide it, and it hides nothing', () => {
    const r = groundedCandidates({ ...base, cueMemory: [note('m1', { title: 'Tableau, Oct 2026 close, marketing sources', date: '2026-11-02' })], data: data() })
    expect(r.candidates.map(c => c.arm)).toEqual(['cue_memory', 'data'])
  })
  it('without data nothing changes: the same six, no D1', () => {
    expect(groundedCandidates({ ...base, cueMemory: [note('m1')], data: null }).candidates.map(c => c.id)).toEqual(['M1'])
  })

  describe('the source a client sees', () => {
    const source = () => groundedSource(data(), 'mtg_abc123def456')
    it('is a file source with no locator and the Tableau label as its title', () => {
      expect(source()).toEqual({ id: 'mtg_abc123def456', date: '2026-11-02', title: 'Tableau, Oct 2026 close, marketing sources', kind: 'file' })
      expect(isCueSourceExtras(source())).toBe(true)
    })
    it('passes the cue validator, the log-row validator, and uses only fields the oldest reader (Control 0.5.363) reads', () => {
      const cue: LiveCueV2 = { protocol: 2, cueId: 'c1', sessionId: 'meeting_a', headline: 'SBU customers are 67% to goal in Tableau', detail: 'Tableau, Oct 2026, marketing sources: SBU customers 54 vs 81 budget.',
        kind: 'challenge', sources: [source()], gate: 0.93, createdAt: 1, model: 'm' }
      expect(isLiveCueV2(cue)).toBe(true)
      const row: LiveCueLogRow = { v: 1, cueId: 'c1', sessionId: 'meeting_a', meetingTitle: 't', createdAt: 1, armedAt: 0, kind: 'challenge', headline: cue.headline, detail: cue.detail,
        gate: 0.93, sources: cue.sources, model: 'm', prompt: 'v3', memorySource: 'none', kept: 1, before: '', arms: [] }
      expect(isLogRow(row)).toBe(true)
      expect(Object.keys(source()).sort()).toEqual(['date', 'id', 'kind', 'title'])
    })
  })
})

describe('the meeting assistant context', () => {
  const f = facts()
  const intent = (q: string) => askDataIntent(q, f).intent
  it('intent: Tableau by name, or a named group beside a funnel word, else none', () => {
    expect(intent('check Tableau')).toBe('tableau')
    expect(intent('Can you check TABLEAU for the numbers?')).toBe('tableau')
    expect(intent('how is SBU pacing against budget?')).toBe('named')
    expect(intent('what were liquor leads last month')).toBe('named')
    expect(intent('what does the SBU funnel look like')).toBe('named')
    expect(intent('what is the budget for the offsite')).toBeNull()
    expect(intent('who is the liquor distributor?')).toBeNull()
    expect(intent('what time is lunch')).toBeNull()
  })
  it('intent: says whether a Quilt brand was named', () => {
    expect(askDataIntent('how is Bottle POS pacing', f)).toEqual({ intent: 'named', brand: true })
    expect(askDataIntent('how is liquor pacing', f)).toEqual({ intent: 'named', brand: false })
  })
  it('reads only the user\'s own words: a long pasted text counts for nothing, a short last line after it does', () => {
    expect(L.askQuestionChars).toBe(300)
    const article = 'Pet owners spent more this year. Liquor sales and thrift store customers rose 12 percent while leads for SBU products dipped. '.repeat(6)
    expect(article.length).toBeGreaterThan(300)
    expect(intent(article)).toBeNull()
    expect(intent(article + ' check Tableau')).toBeNull()                    // one long paragraph: nothing of it is the user\'s
    expect(intent(article + '\ncheck Tableau')).toBe('tableau')               // their question on its own line
    expect(intent(article + '\nhow is liquor pacing?')).toBe('named')
    expect(intent(article + '\nwhat is the weather?')).toBeNull()
    expect(askUserWords('short question')).toBe('short question')
    expect(askUserWords('x'.repeat(301))).toBe('')
    expect(askUserWords('x'.repeat(400) + '\nis it done?\n')).toBe('is it done?')
  })
  it('named groups: their stage rows with prior month, last year and ex-events, then their lead sources', () => {
    const raw = rawFacts(); raw.groups[2].stages.leads.exEventsPct = 81.4
    const r = dataFactsForAsk(facts(raw), 'check Tableau for liquor pacing')!
    expect(r.title).toBe('Tableau, Oct 2026 close, marketing sources')
    expect(r.text).toContain('Tableau marketing funnel, Oct 2026 final. Scope: Marketing sources (MTD Performance filter)')
    expect(r.text).toContain('Not company revenue, MRR, ARR or location counts.')
    expect(r.text).toContain('Extract refreshed Nov 2 05:41 CT.')
    expect(r.text).toContain('Liquor: leads 191 vs 231 (83%) [PM 211, PY 196, ex-events 81%]; opps 108 vs 98 (110%)')
    expect(r.text).toContain('customers 32 vs 53 (60%)')
    expect(r.text).toContain('Liquor lead sources (leads/opps/customers): Paid Search - Non-Brand 64/11/4; Organic Direct 63/41/16')
    expect(r.text).not.toContain('Thrift lead sources')
    expect(r.text).not.toMatch(/^Thrift:/m)
  })
  it('a pasted article\'s group names do not choose the groups', () => {
    const article = 'liquor thrift pet vertical leads percent '.repeat(20)
    const r = dataFactsForAsk(f, article + '\ncheck Tableau')!
    expect(r.text).toContain('SBU (3 of 4')     // no group chosen from the paste: every group
    expect(r.text).toContain('Thrift:')
    expect(r.text).not.toContain('lead sources')
  })
  it('a business unit says it is partial and which industries it covers', () => {
    const r = dataFactsForAsk(f, 'how is SBU pacing')!
    expect(r.text).toContain('SBU (3 of 4 industries: Grocery, Liquor, Tobacco): leads 402 vs 428 (94%)')
  })
  it('naming none gives every group (no source rows), and is capped', () => {
    const r = dataFactsForAsk(f, 'check Tableau')!
    for (const name of ['SBU', 'XBU', 'Liquor', 'Thrift', 'Pet', 'Quilt industry (Like Sew)', 'Dive']) expect(r.text).toContain(`${name}`)
    expect(r.text).not.toContain('lead sources')
    expect(L.askChars).toBe(3500)
    expect(r.text.length).toBeLessThanOrEqual(3500)
    const raw = rawFacts(); raw.groups = Array.from({ length: 40 }, (_, i) => ({ ...rawFacts().groups[2], name: `G${i}`, aliases: [`g${i}x`] }))
    expect(dataFactsForAsk(facts(raw), 'check Tableau')!.text.length).toBeLessThanOrEqual(3500)
  })
})
