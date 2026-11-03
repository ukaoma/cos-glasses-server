// Tableau at lead-source level: the file's optional source detail (budget lines), the vocabulary that maps what people say ("paid search",
// "PPC", "events") to source names, the cue that leads with one source, and the meeting assistant's answer for one source. The group-level
// behaviour is in live-cues-v2-data.test.ts and must not change; the older-file cases here prove it does not.
import { describe, expect, it } from 'vitest'
import {
  DATA_ASK_ADDENDUM, DATA_FACTS_LIMITS as L, DATA_WRITER_ADDENDUM, askDataIntent, askSources, askUserWords, dataCandidate, dataFactsForAsk, dataTrigger, namedGroups, namedSources,
  parseDataFacts, sourceLabel, type DataFacts,
} from './live-cues-v2-data.js'
import { NOW, rawFacts, rawSourceFacts, type Raw } from './__fixtures__/live-cues-v2-data-fixture.js'

function facts(raw: Raw = rawSourceFacts()): DataFacts {
  const r = parseDataFacts(raw, NOW)
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`)
  return r.facts
}
const f = facts()
const notes = (w: string, ff: DataFacts = f) => { const r = dataCandidate(ff, w, '2026-11-02'); if (!('candidate' in r)) throw new Error(r.none); return r.candidate.notes }
const NB = 'Paid Search - Non-Brand', BRAND = 'Paid Search - Brand'

describe('the file: budget lines and source pointers', () => {
  it('reads budget lines, with their stages, and the line a source row points at', () => {
    expect(f.budgetLines).toHaveLength(10)
    const thrift = f.budgetLines.find(l => l.industry === 'Thrift' && l.line === NB)!
    expect(thrift.sources).toEqual([NB, 'Paid Social'])
    expect(thrift.stages.leads).toEqual({ actual: 66, budget: 47, pctToGoal: 140.4 })
    expect(thrift.stages.customers).toEqual({ actual: 6, budget: 3, pctToGoal: 200 })
    expect(f.sources.find(r => r.industry === 'Thrift' && r.source === 'Paid Social')!.budgetLine).toBe(NB)
  })
  it('an older file (no budget lines, no pointers) reads, with none', () => {
    const old = facts(rawFacts())
    expect(old.budgetLines).toEqual([])
    expect(old.sources.every(r => !('budgetLine' in r))).toBe(true)
    const rows = facts(rawFacts({ sources: [{ industry: 'Thrift', source: 'Paid Social', bucket: 'General Marketing', leads: 21, opps: 6, customers: 3 }] }))
    expect(rows.sources).toHaveLength(1)
  })
  it('a budget line that does not parse is dropped and the rest stay; a bad pointer is just absent', () => {
    const raw = rawSourceFacts()
    raw.budgetLines[0].stages = { leads: { actual: 'many' } }                  // no stage with a numeric actual
    raw.budgetLines[1].industry = ''                                           // no industry
    raw.budgetLines[2].stages.opps = { actual: -1 }                            // a negative actual drops the stage, not the line
    raw.budgetLines[3].sources = [7, 'Paid Social']                            // a member that is not a string is skipped
    raw.budgetLines.push(4, null, { industry: 'Pet' })
    raw.sources[0].budgetLine = 7
    const g = facts(raw)
    expect(g.budgetLines).toHaveLength(8)
    expect(g.budgetLines.find(l => l.industry === 'Liquor' && l.line === 'Organic Direct')!.stages.opps).toBeUndefined()
    expect(g.budgetLines.find(l => l.industry === 'Thrift' && l.line === NB)!.sources).toEqual(['Paid Social'])
    expect(g.sources[0]).not.toHaveProperty('budgetLine')
  })
  it('a null budget stays null; the line count is capped', () => {
    const raw = rawSourceFacts(); raw.budgetLines[0].stages.leads = { actual: 74, budget: null, pctToGoal: null }
    expect(facts(raw).budgetLines[0].stages.leads).toEqual({ actual: 74, budget: null, pctToGoal: null })
    const many = rawSourceFacts(); many.budgetLines = Array.from({ length: L.maxBudgetLines + 50 }, () => ({ ...rawSourceFacts().budgetLines[0] }))
    expect(facts(many).budgetLines).toHaveLength(L.maxBudgetLines)
  })
  it('the group-level reading is unchanged by the extras', () => {
    expect(facts().groups).toEqual(facts(rawFacts()).groups)
  })
})

describe('the source vocabulary', () => {
  const src = (w: string, ff: DataFacts = f) => namedSources(ff, w).map(s => ({ names: [...s.names].sort(), strong: s.strong }))
  const BOTH = [BRAND, NB].sort()
  it.each([
    ['paid search', BOTH], ['PPC', BOTH], ['pay per click', BOTH], ['SEM', BOTH], ['search engine marketing', BOTH], ['Google Ads', BOTH], ['adwords', BOTH], ['Google AdWords', BOTH],
  ])('"%s" is paid search, Brand and Non-Brand, specific enough to stand alone', (w, names) => { expect(src(w)).toEqual([{ names, strong: true }]) })
  it.each([
    ['non-brand ppc', [NB]], ['ppc non brand', [NB]], ['nonbrand ppc', [NB]], ['ppc nonbrand', [NB]], ['paid search non-brand', [NB]], ['Paid Search - Non-Brand', [NB]],
    ['brand ppc', [BRAND]], ['ppc brand', [BRAND]], ['branded ppc', [BRAND]], ['ppc branded', [BRAND]], ['paid search brand', [BRAND]],
  ])('"%s" narrows to one of the two', (w, names) => { expect(src(w)).toEqual([{ names, strong: true }]) })
  it('two phrases for the same names are one source, specific if either is', () => {
    expect(src('ppc non brand search')).toEqual([{ names: [NB], strong: true }])
    expect(src('non brand search')).toEqual([{ names: [NB], strong: false }])
  })
  it('a source named by two phrases counts at its latest, so the one said last still comes first', () => {
    const named = namedSources(f, 'non brand ppc then paid social then non brand search')
    expect(named.map(s => s.names)).toEqual([[NB], ['Paid Social']])
  })
  it('a brand word that is not beside the name narrows nothing; a longer name beats the shorter one inside it', () => {
    expect(src('ppc landing pages for the brand team')[0].names).toEqual(BOTH)
    expect(namedSources(f, 'paid search non-brand')).toHaveLength(1)           // not also the broad "paid search"
  })
  it.each([
    ['paid social', ['Paid Social'], true], ['Facebook ads', ['Paid Social'], true], ['LinkedIn ads', ['Paid Social'], true], ['meta ads', ['Paid Social'], true],
    ['facebook', ['Paid Social'], false], ['linkedin', ['Paid Social'], false],
    ['trade show', ['Event Conferences'], true], ['trade shows', ['Event Conferences'], true], ['events', ['Event Conferences'], false], ['conference', ['Event Conferences'], false],
    ['event conferences', ['Event Conferences'], true],
    ['organic', ['Organic', 'Organic Direct'], false], ['SEO', ['Organic', 'Organic Direct'], false], ['organic direct', ['Organic Direct'], true],
    ['direct', ['Direct'], false],
    ['social media', ['Social Media'], false], ['social', ['Paid Social', 'Social Media'], false],
  ])('"%s" covers %j (specific enough to stand alone: %s)', (w, names, strong) => { expect(src(w)).toEqual([{ names: [...names].sort(), strong }]) })

  const withAll = facts(rawSourceFacts({ budgetLines: [
    { industry: 'Thrift', line: 'General Marketing', sources: ['Referral Traffic', 'Social Media', 'Email Database', 'Paid Partnership'], stages: { leads: { actual: 3, budget: 9, pctToGoal: 33.3 } } },
    { industry: 'Thrift', line: 'Organic Direct', sources: ['Organic', 'Organic Direct', 'Direct', 'AI Referrals'], stages: { leads: { actual: 3, budget: 9, pctToGoal: 33.3 } } },
    { industry: 'Thrift', line: 'Lead Aggregators', sources: ['Paid Aggregator'], stages: { leads: { actual: 3, budget: 9, pctToGoal: 33.3 } } },
    { industry: 'Thrift', line: 'Customer Referral', sources: ['Customer Referral'], stages: { leads: { actual: 3, budget: 9, pctToGoal: 33.3 } } },
    { industry: 'Thrift', line: 'Webinar', sources: ['Webinar'], stages: { leads: { actual: 3, budget: 9, pctToGoal: 33.3 } } },
  ] }))
  it.each([
    ['referral traffic', ['Referral Traffic'], false], ['customer referral', ['Customer Referral'], false], ['referrals', ['Customer Referral', 'Referral Traffic'], false],
    ['AI referrals', ['AI Referrals'], true], ['chatgpt', ['AI Referrals'], false],
    ['capterra', ['Paid Aggregator'], true], ['Software Advice', ['Paid Aggregator'], true], ['lead aggregators', ['Paid Aggregator'], true], ['G2 Crowd', ['Paid Aggregator'], true],
    ['email database', ['Email Database'], true], ['email', ['Email Database'], false], ['newsletter', ['Email Database'], true],
    ['webinar', ['Webinar'], false], ['paid partnership', ['Paid Partnership'], true], ['partnership', ['Paid Partnership'], false],
  ])('a source the file only knows from a budget line: "%s" covers %j (stands alone: %s)', (w, names, strong) => { expect(src(w, withAll)).toEqual([{ names: [...names].sort(), strong }]) })
  it('names the file does not have: the concept is named, with no names, so a reader can say there are none', () => {
    expect(namedSources(f, 'capterra leads').map(s => ({ label: s.label, names: s.names, strong: s.strong }))).toEqual([{ label: 'Aggregators', names: [], strong: true }])
    expect(namedSources(f, 'webinar')[0].names).toEqual([])
  })
  it('a source name the table does not know is still an alias: its own name, spoken', () => {
    const raw = rawSourceFacts(); raw.sources.push(row('Thrift', 'Podcast Sponsorship'), row('Thrift', 'Billboard'))
    const g = facts(raw)
    expect(namedSources(g, 'podcast sponsorship leads')).toMatchObject([{ names: ['Podcast Sponsorship'], strong: true }])
    expect(namedSources(g, 'billboard leads')).toMatchObject([{ names: ['Billboard'], strong: false }])
  })
  it('whole words only, case does not matter, and the one named last comes first', () => {
    expect(namedSources(f, 'ppcs and eventsx and directory')).toEqual([])
    expect(namedSources(f, 'PAID SEARCH').length).toBe(1)
    expect(namedSources(f, 'paid social first and then ppc').map(s => s.label)).toEqual(['Paid Search', 'Paid Social'])
  })
  it('labels read like speech: no spaced hyphen', () => {
    expect(sourceLabel('Paid Search - Non-Brand')).toBe('Paid Search Non-Brand')
    expect(sourceLabel('Organic Direct')).toBe('Organic Direct')
  })
  it('a specific source name directly beside a plain-English group word makes the group count ("paid search pet")', () => {
    const named = (w: string) => namedGroups(f, w).map(n => n.group.name)
    expect(named('ppc pet')).toEqual(['Pet'])                                   // directly beside it
    expect(named('paid search dive')).toEqual(['Dive'])
    expect(named('pet ppc')).toEqual(['Pet'])
    expect(named('paid search pet')).toEqual(['Pet'])
    expect(named('events pet')).toEqual([])                                     // a plain-English source word is no anchor even beside it
    expect(named('ppc for pet')).toEqual([])                                    // not across a bridge word: only a funnel word reaches that far
    expect(named("let's dive in, google ads are the topic")).toEqual([])
    expect(named('leads for pet')).toEqual(['Pet'])
    expect(named('events for pet')).toEqual([])                                 // a plain-English source word is not an anchor
    expect(named('pet project for ppc people') ).toEqual([])                    // 'project' sits between, no bridge
    expect(named('dive into the numbers')).toEqual([])
  })
})

const row = (industry: string, source: string) => ({ industry, source, bucket: '', leads: 5, opps: 1, customers: 0 })

describe('the cue trigger with a source', () => {
  const t = (w: string) => dataTrigger(f, w)
  it('a specific source beside a group fires with no funnel word, and says it had none', () => {
    const r = t("we're doing a refresh on the PPC landing pages for thrift")
    expect(r.fired && r.groups.map(g => g.name)).toEqual(['Thrift'])
    expect(r.fired && r.source && r.source.names.sort()).toEqual([BRAND, NB].sort())
    expect(r.fired && r.funnel).toBe(false)
  })
  it('the same window without the source is still no_funnel, and a plain-English source beside a group needs a funnel word as before', () => {
    expect(t('we are doing a refresh on the landing pages for thrift')).toEqual({ fired: false, why: 'no_funnel' })
    expect(t('events for thrift are tomorrow')).toEqual({ fired: false, why: 'no_funnel' })
    const w = t('events for thrift leads were great')
    expect(w.fired && w.source?.names).toEqual(['Event Conferences'])
    expect(w.fired && w.funnel).toBe(true)
  })
  it('a specific source alone needs a funnel word or a figure; a plain-English one alone never fires', () => {
    expect(t('the ppc landing pages need a refresh')).toEqual({ fired: false, why: 'no_funnel' })
    const a = t('paid search is at 40 this month')
    expect(a.fired && a.groups).toEqual([]); expect(a.fired && a.source?.label).toBe('Paid Search')
    expect(t('paid search leads are down').fired).toBe(true)
    expect(t('we have 40 events planned')).toEqual({ fired: false, why: 'no_group' })
    expect(t('our direct reports have 40 leads')).toEqual({ fired: false, why: 'no_group' })
    expect(t('chatgpt wrote 50 emails')).toEqual({ fired: false, why: 'no_group' })
  })
  it('a source the file has nothing for does not choose the cue; the group totals rule decides as before', () => {
    const r = t('capterra for thrift leads')
    expect(r.fired && r.source).toBeNull()
    expect(t('capterra for thrift')).toEqual({ fired: false, why: 'no_funnel' })
  })
  it('names the source said last when several are named', () => {
    const r = t('paid social and then ppc for liquor leads')
    expect(r.fired && r.source?.label).toBe('Paid Search')
  })
  it('without any source named it is the old trigger: no source, funnel true', () => {
    const r = t('liquor leads were way down last month')
    expect(r.fired && r.source).toBeNull(); expect(r.fired && r.funnel).toBe(true)
  })
})

describe('the cue candidate with a source', () => {
  const HEAD = 'Tableau Oct 2026 final, marketing-sourced, lead-source detail, refreshed Nov 2 05:41 CT. '
  it('leads with that source\'s own numbers for the group, then its budget line, naming what the line also counts', () => {
    expect(notes("we're doing a refresh on the PPC landing pages for thrift")).toBe(HEAD
      + 'Thrift, Paid Search Non-Brand alone: leads 45, opps 11; Paid Search Brand alone: leads 8, opps 2. '
      + 'Budget line Paid Search Non-Brand (also counts Paid Social): leads 66 vs 47 (140%), opps 17 vs 13 (131%).')
  })
  it('a narrowed window gives one source with all three stages and its line', () => {
    expect(notes('non-brand ppc for thrift')).toBe(HEAD
      + 'Thrift, Paid Search Non-Brand alone: leads 45, opps 11, customers 3. '
      + 'Budget line Paid Search Non-Brand (also counts Paid Social): leads 66 vs 47 (140%), opps 17 vs 13 (131%), customers 6 vs 3 (200%).')
  })
  it('the stage the room named is the one shown; a stage a source has no number for falls back to the three', () => {
    expect(notes('thrift customers from paid social')).toContain('Thrift, Paid Social alone: customers 3. Paid Social is budgeted inside the Paid Search Non-Brand line, which also counts Paid Search Non-Brand: customers 6 vs 3 (200%).')
    expect(notes('thrift sqls from events')).toContain('Thrift, Event Conferences alone: leads 24, opps 15, customers 2.')
  })
  it('a line with no zero-line budget shows "no budget" instead of a percent', () => {
    expect(notes('events for thrift customers')).toContain('Event Conferences is budgeted inside the Events line: customers 2 vs 0')
    const raw = rawSourceFacts(); raw.budgetLines[5].stages.leads = { actual: 24, budget: null, pctToGoal: null }
    expect(notes('events for thrift leads', facts(raw))).toContain('Event Conferences is budgeted inside the Events line: leads 24 vs no budget.')
  })
  it('is at most 300 characters, dropping budget lines, then the second group, then stages, before it cuts', () => {
    const w = "we're doing a refresh on the PPC landing pages for thrift and liquor leads opps customers"
    const n = notes(w)
    expect(L.candidateChars).toBe(300)
    expect(n.length).toBeLessThanOrEqual(300)
    expect(n).toContain('Liquor, Paid Search Non-Brand alone')
    const raw = rawSourceFacts(); raw.groups[3].display = 'Thrift stores and resale shops across every market we sell into today'
    expect(notes('ppc for thrift leads opps customers', facts(raw)).length).toBeLessThanOrEqual(300)
    const huge = rawSourceFacts(); huge.groups[3].display = 'T'.repeat(40) + ' '.repeat(1) + 'X'.repeat(15)
    huge.groups[3].name = 'Thrift'
    expect(notes('ppc for thrift leads opps customers', facts(huge)).length).toBeLessThanOrEqual(300)
  })
  it('a cue that cannot fit even one stage is cut at 300, never longer', () => {
    const long = 'Very Long Podcast Network Sponsorship Program Lead Source Number One Test'
    const raw = rawSourceFacts(); raw.sources.push(row('A'.repeat(40), long), row('B'.repeat(40), long))
    raw.sources.slice(-2).forEach((r: Raw, i: number) => { r.leads = 50 - i })
    raw.period.label = 'October 2026 fiscal reporting window'
    const n = notes(`${long} leads are at 40`, facts(raw))
    expect(n.length).toBe(300)
    expect(n.startsWith('Tableau October 2026 fiscal reporting window final, marketing-sourced, lead-source detail, refreshed Nov 2 05:41 CT. ' + long + ' alone, largest by leads: AAAA')).toBe(true)
  })
  it('two groups too long for one note: only the group said last is kept, with its source', () => {
    const raw = rawSourceFacts()
    raw.groups[2].display = 'Liquor and spirits retailers across every market we sell'    // 56 characters, under the 60 a group may carry
    raw.groups[3].display = 'Thrift stores and resale shops across every market we sell'   // 56
    const n = notes('ppc for thrift and liquor leads opps customers', facts(raw))
    expect(n.length).toBeLessThanOrEqual(300)
    expect(n).toContain('Liquor and spirits retailers'); expect(n).not.toContain('Thrift stores and resale')
  })
  it('with no group named it lists the largest industries for that source, never a total', () => {
    const n = notes('paid search leads are 40 this month')
    expect(n).toBe(HEAD + 'Paid Search alone, largest by leads: Liquor Paid Search Non-Brand leads 64; Thrift Paid Search Non-Brand leads 45.')
    expect(n).not.toMatch(/\b109\b/)                                            // 64 + 45: nothing is added up
    expect(notes('capterra'.length ? 'trade show leads are at 20' : '')).toBe(HEAD + 'Event Conferences alone, largest by leads: Thrift leads 24.')
    expect(L.cueSourceRows).toBe(2)
  })
  it('a business unit lists its industries\' rows for that source', () => {
    expect(notes('paid social for SBU leads')).toBe(HEAD + 'SBU industries, Paid Social alone, largest by leads: Liquor leads 10.')
  })
  it('a source with no row for the named group: totals when the room carried a funnel word, no cue when it did not', () => {
    const quilt = dataCandidate(f, 'ppc leads for like sew', '2026-11-02')
    expect('candidate' in quilt && quilt.candidate.notes).toContain('Quilt industry (Like Sew): leads 50 vs 38 (132%)')
    expect(dataCandidate(f, 'ppc landing pages for like sew', '2026-11-02')).toEqual({ none: 'no_funnel' })
    expect('candidate' in dataCandidate(f, 'events for thrift leads', '2026-11-02')).toBe(true)
  })
  it('an older file (rows only) gives the rows and no budget line', () => {
    const old = facts(rawFacts({ sources: rawSourceFacts().sources.map(({ budgetLine: _b, ...r }: Raw) => r) }))
    expect(notes('non-brand ppc for thrift', old)).toBe(HEAD + 'Thrift, Paid Search Non-Brand alone: leads 45, opps 11, customers 3.')
  })
  it('keeps the shape of a data candidate and the brand flag of its group', () => {
    const r = dataCandidate(f, 'ThriftCart ppc leads', '2026-11-02')
    expect(r).toMatchObject({ brand: true, candidate: { id: 'D1', arm: 'data', kind: 'data', title: 'Tableau, Oct 2026 close, marketing sources', key: 'data:tableau|Tableau, Oct 2026 close, marketing sources|2026-11-02T05:41:00-06:00' } })
    const s = dataCandidate(f, 'paid search leads are 40', '2026-11-02')
    expect(s).toMatchObject({ brand: false })                                   // a source alone is never a Quilt-brand signal
  })
  it('never says revenue, MRR or locations', () => {
    for (const w of ['ppc for thrift', 'events for thrift leads', 'paid search leads are 40']) expect(notes(w)).not.toMatch(/revenue|MRR|locations|[—–]|->|→/i)
  })
  it('the writer rules say a source note covers only that source', () => {
    expect(DATA_WRITER_ADDENDUM).toContain('covers only that source')
    expect(DATA_WRITER_ADDENDUM).toContain('the budget is for that line')
    expect(DATA_WRITER_ADDENDUM).not.toMatch(/[—–]|->|→/)
    expect(DATA_ASK_ADDENDUM).toContain('covers only that source')
    expect(DATA_ASK_ADDENDUM).not.toMatch(/[—–]|->|→/)
  })
})

describe('the meeting assistant, intent', () => {
  const intent = (q: string, ff: DataFacts = f) => askDataIntent(q, ff).intent
  it.each([
    'Can you check that tableau report via paid search',
    'check Tableau for PPC',
  ])('Tableau by name is still tableau: %s', q => { expect(intent(q)).toBe('tableau') })
  it.each([
    'how did paid search do for thrift in October',          // a specific source beside a group, no funnel word
    'what were ppc leads last month',                        // a specific source beside a funnel word
    'what is the budget for ppc',
    'how many leads from events',                            // a plain-English source beside a stage word
    'customers from direct',
    'which channel brought leads, events or direct',
    'what did the direct channel bring us',                  // a plain-English source beside a source word
    'how did events do for thrift',                          // a plain-English source, a group and a performance word
    'how are events doing for thrift',
    'non-brand ppc leads for jewelry',
    'how are referrals doing for thrift leads',
    'what about ai referrals for thrift',
  ])('a source question is a data question: %s', q => { expect(intent(q)).toBe('named') })
  it.each([
    'how is ppc going',                                      // a specific source with no group and no funnel word
    'what is the budget for events',                         // a plain-English source beside a budget word only
    'what time is the thrift events call',
    'the direct reports on the thrift team',
    'how are the direct reports on the thrift team doing',
    'how did the conference go for liquor',
    'let me email Gina about thrift',
    'who runs the events team',
    'what is the weather',
    'chatgpt wrote the memo',
  ])('and these stay quiet: %s', q => { expect(intent(q)).toBeNull() })
  it('names the Quilt-brand signal from the group only, never from a source', () => {
    expect(askDataIntent('how did paid search do for ThriftCart', f)).toEqual({ intent: 'named', brand: true })
    expect(askDataIntent('how did paid search do for thrift', f)).toEqual({ intent: 'named', brand: false })
    expect(askDataIntent('what were ppc leads', f)).toEqual({ intent: 'named', brand: false })
  })
  it('reads only the user\'s own words: a pasted article that mentions PPC counts for nothing', () => {
    const article = 'Paid search and PPC leads for thrift stores rose twelve percent while events were flat. '.repeat(6)
    expect(article.length).toBeGreaterThan(L.askQuestionChars)
    expect(intent(article)).toBeNull()
    expect(intent(article + '\nhow did ppc do for thrift?')).toBe('named')
    expect(intent(article + '\nwhat is the weather?')).toBeNull()
    expect(askSources(f, askUserWords(article), false)).toEqual([])        // the words the runtime hands it: a paste is stripped first
  })
  it('askSources: a specific name always counts; a plain-English one needs a stage or source word, or a group with Tableau or a performance word', () => {
    expect(askSources(f, 'ppc', false).map(s => s.label)).toEqual(['Paid Search'])
    expect(askSources(f, 'direct', false)).toEqual([])
    expect(askSources(f, 'direct leads', false).map(s => s.label)).toEqual(['Direct'])
    expect(askSources(f, 'by source: direct', false).map(s => s.label)).toEqual(['Direct'])
    expect(askSources(f, 'direct for thrift', true)).toEqual([])
    expect(askSources(f, 'direct for thrift in tableau', true).map(s => s.label)).toEqual(['Direct'])
    expect(askSources(f, 'how did direct do for thrift', true).map(s => s.label)).toEqual(['Direct'])
    expect(askSources(f, 'how did direct do', false)).toEqual([])
  })
})

describe('the meeting assistant, the data it is given', () => {
  const ask = (q: string, ff: DataFacts = f) => dataFactsForAsk(ff, q)!.text
  const REAL = 'Can you check that tableau report via paid search'
  it('"check that tableau report via paid search": paid search rows for every industry with their budget lines, and no all-marketing totals', () => {
    const t = ask(REAL)
    expect(t).toContain('Lead source asked about: Paid Search (Paid Search Non-Brand, Paid Search Brand).')
    expect(t).toContain('Liquor (leads/opps/customers): Paid Search Non-Brand 64/11/4; Paid Search Brand 17/7/4. '
      + 'Budget line Paid Search Non-Brand (also counts Paid Social): leads 74 vs 85 (87%), opps 13 vs 20 (65%), customers 5 vs 9 (56%). '
      + 'Budget line Paid Search Brand: leads 17 vs 18 (94%), opps 7 vs 10 (70%), customers 4 vs 6 (67%).')
    expect(t).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0. ')
    expect(t).toContain('Budget line Paid Search Non-Brand (also counts Paid Social): leads 66 vs 47 (140%), opps 17 vs 13 (131%), customers 6 vs 3 (200%).')
    for (const industry of ['Pet', 'Dive']) expect(t).toContain(`${industry} (leads/opps/customers): Paid Search Non-Brand`)
    expect(t).not.toMatch(/^SBU|^XBU|^Thrift: leads|^Liquor: leads/m)             // the group totals are what it used to quote
    expect(t).not.toContain('lead sources (leads/opps/customers)')                  // nor the old top-six rows
    expect(t.indexOf('Liquor (leads')).toBeLessThan(t.indexOf('Thrift (leads'))     // largest by leads first: 81 before 53
  })
  it('keeps the scope lines, says budgets are per line, and that rows are not added up', () => {
    const t = ask(REAL)
    expect(t).toContain('Not company revenue, MRR, ARR or location counts.')
    expect(t).toContain('Extract refreshed Nov 2 05:41 CT.')
    expect(t).toContain('Tableau sets budgets per budget line, and one line can count several sources')
    expect(t).toContain('Rows are listed, not added up.')
    expect(t).not.toMatch(/\b53\b|\b81\b|\b109\b/)                                  // Thrift 45 + 8, Liquor 64 + 17, both industries: no sums
  })
  it('"how did paid search do for thrift in October": Thrift\'s totals for context, then only Thrift\'s paid search rows and lines', () => {
    const t = ask('how did paid search do for thrift in October')
    expect(t).toContain('Thrift: leads 151 vs 110 (137%)')
    expect(t).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
    expect(t).toContain('Budget line Paid Search Brand: leads 8 vs 11 (73%), opps 2 vs 8 (25%), customers 0 vs 3 (0%).')
    expect(t).toContain('Budget line Paid Search Non-Brand (also counts Paid Social): leads 66 vs 47 (140%)')
    expect(t).not.toContain('Liquor (leads'); expect(t).not.toContain('SBU (')
  })
  it('a business unit named with the source: its member industries only', () => {
    const t = ask('how did paid social do for SBU')
    expect(t).toContain('SBU (3 of 4 industries: Grocery, Liquor, Tobacco): leads 402 vs 428')
    expect(t).toContain('Liquor (leads/opps/customers): Paid Social 10/2/1.')
    expect(t).not.toContain('Thrift (leads')
  })
  it('a budget line says what else it counts: named for the source, "also counts"; named for another, the source "is budgeted inside" it', () => {
    expect(ask('how did paid social do for thrift')).toContain('Paid Social 21/6/3. Paid Social is budgeted inside the Paid Search Non-Brand line, which also counts Paid Search Non-Brand: leads 66 vs 47')
    expect(ask('how did events do for thrift')).toContain('Event Conferences 24/15/2. Event Conferences is budgeted inside the Events line: leads 24 vs 6 (400%)')
    expect(ask('how did organic do for thrift')).toContain('Organic is budgeted inside the Organic Direct line, which also counts Direct: leads 46 vs 37 (124%)')
    expect(ask('how did organic direct do for liquor')).toContain('Organic Direct 63/41/16. Budget line Organic Direct: leads 63 vs 70 (90%)')   // named for the source, nothing else counted
    expect(ask('how did paid search and paid social do for thrift')).not.toContain('is budgeted inside')
    expect(ask('how did organic and direct do for thrift')).toContain('Organic and Direct are budgeted inside the Organic Direct line')   // two sources shown, one line   // the line is named for one of the rows shown
  })
  it('the budget line is shared only with sources that have volume in that industry: a zero row is not named', () => {
    const raw = rawSourceFacts(); raw.sources.push({ industry: 'Thrift', source: 'AI Referrals', bucket: 'Organic Direct', leads: 0, opps: 0, customers: 0, budgetLine: 'Organic Direct' })
    expect(ask('how did organic do for thrift', facts(raw))).toContain('which also counts Direct: leads')
    raw.sources[raw.sources.length - 1].leads = 2
    expect(ask('how did organic do for thrift', facts(raw))).toContain('which also counts Direct, AI Referrals: leads')
  })
  it('rows are largest by leads first, whatever order the file lists them in; a Quilt industry keeps its display name', () => {
    const raw = rawSourceFacts(); raw.sources.reverse()
    raw.sources.push({ industry: 'Quilt', source: NB, bucket: 'Paid Search Non-Brand', leads: 19, opps: 4, customers: 3, budgetLine: NB })
    const g = facts(raw)
    expect(ask('how did paid search do for thrift', g)).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
    expect(notes('ppc for thrift leads', g)).toContain('Thrift, Paid Search Non-Brand alone: leads 45; Paid Search Brand alone: leads 8')
    expect(ask('how did paid search do for like sew', g)).toContain('Quilt industry (Like Sew) (leads/opps/customers): Paid Search Non-Brand 19/4/3.')
  })
  it('a named industry with no row for the source says so, and gives no budget line it cannot tie to a row', () => {
    const raw = rawSourceFacts(); raw.sources = raw.sources.filter((r: Raw) => r.industry !== 'Dive')
    const t = ask('how did paid search do for dive leads', facts(raw))
    expect(t).toContain('Dive (leads/opps/customers): no rows for this source.')
    expect(t).not.toContain('Budget line')
  })
  it('a line that also counts many sources names at most three', () => {
    const raw = rawSourceFacts()
    raw.budgetLines.push({ industry: 'Pet', line: 'Wide Line', sources: ['Paid Social', 'A1', 'A2', 'A3', 'A4', 'A5'], stages: { leads: { actual: 30, budget: 20, pctToGoal: 150 } } })
    for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) raw.sources.push({ industry: 'Pet', source: n, bucket: '', leads: 2, opps: 0, customers: 0 })
    raw.sources = raw.sources.filter((r: Raw) => !(r.industry === 'Pet' && r.source === NB)); raw.budgetLines = raw.budgetLines.filter((l: Raw) => !(l.industry === 'Pet' && l.line === NB))
    expect(ask('how did paid social do for pet leads', facts(raw))).toContain('Paid Social is budgeted inside the Wide Line line, which also counts A1, A2, A3: leads 30 vs 20 (150%)')
  })
  it('the lines of an industry follow the sources that have rows: "social" does not pull in General Marketing without a Social Media row', () => {
    const raw = rawSourceFacts(); raw.sources = raw.sources.filter((r: Raw) => r.source !== 'Social Media')
    const t = ask('how did we do on social for thrift leads', facts(raw))
    expect(t).toContain('Paid Social is budgeted inside the Paid Search Non-Brand line')
    expect(t).not.toContain('General Marketing')
    expect(ask('how did we do on social for thrift leads')).toContain('Social Media is budgeted inside the General Marketing line')   // with the row, the line is shown
  })
  it('a source the file has no rows for says so instead of answering with totals', () => {
    const t = ask('how many webinar leads for thrift')
    expect(t).toContain('Lead source asked about: Webinar (no rows in this Tableau extract).')
    expect(t).not.toContain('Thrift (leads/opps/customers)')
    expect(t).toContain('Thrift: leads 151 vs 110')                                  // the group the user named still gets its stage line
  })
  it('an industry with a budget line but no row for the source says "no rows for this source"', () => {
    const raw = rawSourceFacts(); raw.sources = raw.sources.filter((r: Raw) => !(r.industry === 'Pet' && r.source === 'Paid Social'))
    const t = ask('how did paid social do for pet leads', facts(raw))
    expect(t).toContain('Pet (leads/opps/customers): no rows for this source.')
  })
  it('an older file (rows only): the rows, no budget line, nothing invented', () => {
    const old = facts(rawFacts({ sources: rawSourceFacts().sources.map(({ budgetLine: _b, ...r }: Raw) => r) }))
    const t = ask('how did paid search do for thrift', old)
    expect(t).toContain('Thrift (leads/opps/customers): Paid Search Non-Brand 45/11/3; Paid Search Brand 8/2/0.')
    expect(t).not.toContain('Budget line')
  })
  it('without a source named it is exactly what it was: totals for the named group and its top lead-source rows', () => {
    const t = ask('how is thrift pacing against budget')
    expect(t).toContain('Thrift lead sources (leads/opps/customers): Paid Search - Non-Brand 45/11/3; Event Conferences 24/15/2; Organic 24/8/2; Direct 22/16/5; Paid Social 21/6/3; Paid Search - Brand 8/2/0')
    expect(t).not.toContain('Lead source asked about')
    expect(ask('check Tableau')).toContain('SBU (3 of 4')
    expect(ask('check Tableau')).not.toContain('Lead source asked about')
  })
  it('a plain-English source word with no stage or source word is not a source: a question that only names "direct" gets the old answer', () => {
    expect(ask('check Tableau, the direct reports are asking')).toContain('SBU (3 of 4')
    expect(ask('check Tableau, the direct reports are asking')).not.toContain('Lead source asked about')
  })
  it('is capped at 3,500 characters, shows whole industry lines largest first, and names how many it left out', () => {
    const raw = rawSourceFacts()
    raw.sources = Array.from({ length: 40 }, (_, i) => ({ industry: `Industry${String(i).padStart(2, '0')}`, source: NB, bucket: 'Paid Search Non-Brand', leads: 100 - i, opps: 10, customers: 1, budgetLine: NB })).reverse()   // the largest last in the file
    raw.budgetLines = raw.sources.map((r: Raw) => ({ industry: r.industry, line: NB, sources: NB.length ? [NB, 'Paid Social'] : [], stages: { leads: { actual: r.leads, budget: 50, pctToGoal: 100 }, opps: { actual: 10, budget: 9, pctToGoal: 111.1 }, customers: { actual: 1, budget: 1, pctToGoal: 100 } } }))
    const t = ask('how did ppc do for leads', facts(raw))
    expect(L.askChars).toBe(3500)
    expect(t.length).toBeLessThanOrEqual(3500)
    expect(t).toMatch(/\n\d+ more industries are not shown \(the smallest by leads\)\.$/)
    const shown = (t.match(/^Industry\d\d \(leads/gm) ?? []).length
    expect(shown).toBeGreaterThan(5); expect(shown).toBeLessThan(40)
    expect(t).toContain('Industry00 (leads'); expect(t).not.toContain('Industry39 (leads')   // the largest are the ones kept
    expect(t).toContain(`${40 - shown} more industries are not shown`)
    for (const l of t.split('\n').filter(x => x.startsWith('Industry'))) expect(l.endsWith('.')).toBe(true)  // no line cut in half
  })
  it('a pasted article\'s source words do not choose the rows', () => {
    const article = 'ppc paid search events direct leads thrift '.repeat(20)
    const t = dataFactsForAsk(f, article + '\ncheck Tableau')!.text
    expect(t).not.toContain('Lead source asked about')
    expect(t).toContain('SBU (3 of 4')
  })
})

describe('plain words that are not a source, and the picks that follow', () => {
  const withEmail = (() => { const raw = rawSourceFacts(); raw.sources.push(row('Thrift', 'Email Database')); raw.sources.push(row('Thrift', 'Direct')); return facts(raw) })()
  const labels = (w: string) => namedSources(withEmail, w).map(x => x.label)
  it.each([
    'my direct reports on the thrift team', 'a direct message', 'send a direct mail piece', 'the direct line', 'direct reports',
    'on the conference call', 'in the conference room', 'the conferences calls',
    'let me email Gina', 'I will email them', 'we should email about it', 'please email', 'email me', 'to email everyone', 'Gina can email',
    'meta description', 'the meta',
  ])('"%s" names no source', w => { expect(labels(w)).toEqual([]) })
  it.each([
    ['direct leads for thrift', 'Direct'], ['the conference leads for liquor', 'Events'], ['email leads for thrift', 'Email'], ['the email list is at 40', 'Email'],
    ['meta ads for thrift', 'Paid Social'], ['direct traffic', 'Direct'],
  ])('"%s" still names %s', (w, label) => { expect(labels(w).includes(label)).toBe(true) })
  it('the cue is the group totals when the plain word was not a source', () => {
    for (const w of ['my direct reports on the thrift team have 40 leads', 'on the conference call thrift leads were down', 'I will email them about thrift leads']) {
      const t = dataTrigger(withEmail, w)
      expect(t.fired && t.source, w).toBeNull()
      expect(notes(w, withEmail), w).toContain('Thrift: leads 151 vs 110 (137%)')
    }
  })
  it('G2 is the glasses, not an aggregator: no source, and the cue is the group totals', () => {
    expect(namedSources(f, 'I said this on the G2, thrift leads are up')).toEqual([])
    const t = dataTrigger(f, 'I said this on the G2, thrift leads are up')
    expect(t.fired && t.source).toBeNull()
    expect(notes('I said this on the G2, thrift leads are up')).toContain('Thrift: leads 151 vs 110 (137%)')
    const g = dataTrigger(f, 'paid search for thrift is great but on my G2 the leads looked low')
    expect(g.fired && g.source?.label).toBe('Paid Search')
  })
  it('the cue takes the last SPECIFIC source named; a plain-English one only when no specific one was', () => {
    const a = dataTrigger(f, 'paid search for thrift leads, and events too')
    expect(a.fired && a.source?.label).toBe('Paid Search')                   // events came last but is plain English
    const b = dataTrigger(f, 'events for thrift leads and then ppc')
    expect(b.fired && b.source?.label).toBe('Paid Search')
    const c = dataTrigger(f, 'events for thrift leads')
    expect(c.fired && c.source?.label).toBe('Events')                        // no specific one: the plain one, beside a group
    const d = dataTrigger(f, 'ppc and paid social for thrift leads')
    expect(d.fired && d.source?.label).toBe('Paid Social')                   // two specific: the one said last
  })
  it('a strong source word is no bridge for a weak group word: "let us dive in, google ads are the topic" names no group', () => {
    const t = dataTrigger(f, "let's dive in, google ads are at 40 percent")
    expect(t.fired && t.groups).toEqual([])                                  // a source-alone cue at most, never the dive industry
    expect(dataTrigger(f, "let's dive in, google ads are the topic")).toEqual({ fired: false, why: 'no_funnel' })
  })
  it('a source-alone cue is skipped when the largest row has no leads', () => {
    const raw = rawSourceFacts(); for (const r of raw.sources) if (r.source.startsWith('Paid Search')) r.leads = 0
    const g = facts(raw)
    expect(dataCandidate(g, 'paid search leads are at 40', '2026-11-02')).toEqual({ none: 'no_stage' })
    expect('candidate' in dataCandidate(f, 'paid search leads are at 40', '2026-11-02')).toBe(true)
    // with a group named the rows still show, zero or not
    expect(notes('ppc for thrift leads', g)).toContain('Thrift, Paid Search Non-Brand alone: leads 0')
  })
})
