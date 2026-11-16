// Test fixture for the Salesforce funnel log (funnel-log.json as sfdc_funnel_log.py writes it). Numbers are the real 2026-11-16 06:15
// run's for Liquor, Grocery and Thrift (Liquor opps and demos disagree: Salesforce 2 ahead of Tableau), trimmed to three industries.

export const SF_NOW = Date.parse('2026-11-16T16:00:00Z')
export const SF_GENERATED = '2026-11-16T07:08:23-06:00'

type Raw = Record<string, any>
const stage = (tableau: number | null, salesforce: number, extra: Raw = {}) => ({
  tableau, salesforce, today_salesforce: 0, salesforce_through_now: salesforce, prior_month_sp: salesforce + 20, last_year_sp: salesforce + 5,
  budget_to_date: 40, pct_to_goal: tableau === null ? null : Math.round((1000 * tableau) / 40) / 10, disagree: false, ...extra })

export function rawFunnelLog(over: Raw = {}): Raw {
  return {
    v: 1, kind: 'funnel-log', generatedAt: SF_GENERATED,
    window: { period: ['2026-11-01', '2026-11-15'], today: ['2026-11-16', '2026-11-16'], prior_month_sp: ['2026-10-01', '2026-10-15'], last_year_sp: ['2025-11-01', '2025-11-15'] },
    tableau: { label: 'Tableau, Nov 2026 to Nov 15, marketing sources', asOf: '2026-11-16T05:28:00-06:00', generatedAt: '2026-11-16T07:08:22-06:00',
      period: { label: 'Nov 2026', start: '2026-11-01', end: '2026-11-15', closed: false }, sameWindow: true },
    salesforce: { coefficientJob: 't_67792f2e', method: 'Live Salesforce queries, run separately on each org.', orgs: { 'POS Nation': '00D40000000N194EAC', 'Rain Retail': '00D4W000008J2IAUA0' } },
    notes: ['Tableau dates leads on UTC days, so lead counts can differ by 1 to 3 from Salesforce Central days.'],
    rows: [
      { org: 'POS Nation', industry: 'Liquor', stages: {
        leads: stage(72, 71, { prior_month_sp: 91, last_year_sp: 126, budget_to_date: 108.5, pct_to_goal: 66.4 }),
        opps: stage(38, 40, { prior_month_sp: 65, last_year_sp: 47, budget_to_date: 45.5, pct_to_goal: 83.5, disagree: true }),
        demos: stage(32, 34, { prior_month_sp: 53, last_year_sp: 31, budget_to_date: 37.5, pct_to_goal: 85.3, disagree: true }),
        customers: stage(11, 10, { prior_month_sp: 21, last_year_sp: 18, budget_to_date: 25, pct_to_goal: 44.0 }) } },
      { org: 'POS Nation', industry: 'Grocery', stages: {
        leads: stage(83, 84), opps: stage(39, 39), demos: stage(32, 32), customers: stage(10, 9) } },
      { org: 'Rain Retail', industry: 'Thrift', stages: {
        leads: stage(67, 68), opps: stage(17, 17, { today_salesforce: 1 }), demos: stage(13, 13), customers: stage(9, 9) } },
    ],
    ...over,
  }
}

/** The same log written when the Tableau sheet covered another window: Tableau columns blank, nothing compared. */
export function rawFunnelLogOtherWindow(): Raw {
  const raw = rawFunnelLog()
  raw.tableau = { ...raw.tableau, sameWindow: false }
  for (const r of raw.rows) for (const s of Object.values(r.stages) as Raw[]) { s.tableau = null; s.budget_to_date = null; s.pct_to_goal = null; s.disagree = false }
  return raw
}
