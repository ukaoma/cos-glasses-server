// Test fixture shared by the Tableau data arm tests: a valid data-facts.json as parsed JSON, shaped like cue_data_facts.py writes it.
// Numbers are the real 2026-11-02 report's for SBU and Liquor, made-up for the rest.

export const NOW = Date.parse('2026-11-02T21:30:00Z')
export const ASOF = '2026-11-02T05:41:00-06:00'
export const HOUR = 3_600_000

export type Raw = Record<string, any>
const stage = (actual: number, budget: number | null, extra: Raw = {}) => ({ actual, budget, budgetMonth: budget, pctToGoal: budget ? Math.round((1000 * actual) / budget) / 10 : null,
  priorMonthSamePeriod: actual + 20, pySamePeriod: actual + 5, ...extra })
const stages = (n: Record<string, [number, number | null]>) => Object.fromEntries(Object.entries(n).map(([k, [a, b]]) => [k, stage(a, b)]))

export function rawFacts(over: Raw = {}): Raw {
  return {
    v: 1, source: 'Tableau', label: 'Tableau, Oct 2026 close, marketing sources', scope: 'Marketing sources (MTD Performance filter)',
    period: { label: 'Oct 2026', start: '2026-10-01', end: '2026-10-31', closed: true }, asOf: ASOF, generatedAt: '2026-11-02T15:10:23-06:00',
    groups: [
      { name: 'SBU', kind: 'bu', aliases: ['sbu'], weakAliases: [], brandAliases: ['sbu'], members: ['Grocery', 'Liquor', 'Tobacco'], coverage: { have: 3, of: 4 },
        stages: stages({ leads: [402, 428], opps: [190, 175], sqls: [143, 145], demos: [145, 142], customers: [54, 81] }) },
      { name: 'XBU', kind: 'bu', aliases: ['xbu'], weakAliases: [], brandAliases: ['xbu'], members: ['Jewelry', 'Pet', 'Quilt', 'Thrift'], coverage: { have: 4, of: 12 },
        stages: stages({ leads: [380, 333], opps: [131, 146], customers: [53, 57] }) },
      { name: 'Liquor', kind: 'industry', aliases: ['bottle pos', 'bottlepos', 'liquor'], weakAliases: [], brandAliases: ['bottle pos', 'bottlepos'], members: ['Liquor'],
        stages: stages({ leads: [191, 231], opps: [108, 98], sqls: [87, 84], demos: [88, 82], customers: [32, 53] }) },
      { name: 'Thrift', kind: 'industry', aliases: ['thriftcart', 'thrift'], weakAliases: [], brandAliases: ['thriftcart'], members: ['Thrift'], stages: stages({ leads: [151, 110], opps: [63, 51], customers: [18, 18] }) },
      { name: 'Pet', kind: 'industry', aliases: ['etailpet', 'pet industry', 'pet vertical', 'pet stores'], weakAliases: ['pet', 'pets'], brandAliases: ['etailpet'], members: ['Pet'], stages: stages({ leads: [49, 28], opps: [9, 12], customers: [4, 5] }) },
      { name: 'Quilt', display: 'Quilt industry (Like Sew)', kind: 'industry', aliases: ['like sew', 'likesew', 'quilt industry'], weakAliases: [], brandAliases: ['like sew', 'likesew'], members: ['Quilt'], stages: stages({ leads: [50, 38], customers: [13, 16] }) },
      { name: 'Dive', kind: 'industry', aliases: ['diveshop360', 'dive industry'], weakAliases: ['dive'], brandAliases: ['diveshop360'], members: ['Dive'], stages: stages({ leads: [30, 40] }) },
    ],
    sources: [
      { industry: 'Liquor', source: 'Organic Direct', bucket: 'Organic Direct', leads: 63, opps: 41, customers: 16 },
      { industry: 'Liquor', source: 'Paid Search - Non-Brand', bucket: 'Paid Search Non-Brand', leads: 64, opps: 11, customers: 4 },
      { industry: 'Thrift', source: 'Organic', bucket: 'Organic Direct', leads: 24, opps: 8, customers: 2 },
    ],
    ...over,
  }
}
