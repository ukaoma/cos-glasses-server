// Salesforce beside Tableau, for the meeting assistant and the data cue: ONE local file (`<data dir>/funnel-log.json`), written on
// weekdays at 06:15 by operations/scripts/tableau/sfdc_funnel_log.py. That script asks Coefficient once a day for live Salesforce counts
// (marketing lead sources, New opportunities, both orgs) and blends them with the Tableau sheet (data-facts.json): per industry and stage it
// keeps the Salesforce value, the Tableau value for the same window and a `disagree` flag. Nothing here calls a model, the network,
// Salesforce or Coefficient, and nothing writes.
//
// Rules, each on purpose:
//   - Miles's standing rule (2026-11-13): every Quilt funnel read names BOTH sources with their as-of times and says where they disagree.
//     A disagreement is a finding to explain, not noise, so it is said in words and is the last thing dropped for space;
//   - `tableau.sameWindow` false means the Tableau sheet covered another window when the log was written: no Tableau column is shown and
//     nothing is called a disagreement, whatever the file's flags say;
//   - the log covers a fixed set of industries and four stages (no SQLs), as totals. What it does not cover is said every time, so an answer
//     never claims Salesforce was "not provided" and never stretches the log to a question it cannot answer (lead cohorts, sources, reps);
//   - the Salesforce as-of is `salesforce.queriedAt` (when Coefficient was asked), never `generatedAt`: the 10:45 job re-joins the morning
//     reply to a newer Tableau sheet and rewrites the file, and citing that time would make the Salesforce figures look 3+ hours fresher;
//     a file written before queriedAt existed falls back to generatedAt;
//   - the file is off when missing, unreadable, invalid, older than FUNNEL_LOG_LIMITS.maxAgeHours from the Salesforce query or from the future.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { refreshText, type DataFacts, type DataGroup } from './live-cues-v2-data.js'

export const FUNNEL_LOG_FILE = 'funnel-log.json'

export const FUNNEL_LOG_LIMITS = {
  /** The log is written each weekday at 06:15 CT; a long weekend leaves Friday's 72 hours old on Monday before 06:15, a missed run or a
   *  holiday a day or two more. Past 5 days, like the Tableau sheet, it is off. The as-of time is always stated. */
  maxAgeHours: 120,
  maxFutureMs: 60 * 60_000,
  maxBytes: 1_000_000,
  maxRows: 40,
  maxNotes: 6,
  /** What the meeting assistant is given: at most this many characters of Salesforce text. */
  askChars: 3_000,
  /** The Salesforce clause added to a data cue. The judge reads only the first 300 characters of a note (the Tableau part, which is what
   *  makes it relevant); the writer reads all of it. */
  cueChars: 220,
} as const

export const FUNNEL_STAGES = ['leads', 'opps', 'demos', 'customers'] as const
export type FunnelStageKey = typeof FUNNEL_STAGES[number]

export interface FunnelStage {
  salesforce: number
  /** Tableau for the same window, or null (another window, or Tableau had no figure). */
  tableau: number | null
  /** Salesforce on the log's "today" (the morning of the run, up to the query time). */
  todaySalesforce: number | null
  /** Salesforce for the prior month's and last year's same days. */
  priorMonthSp: number | null
  lastYearSp: number | null
  /** Tableau's budget to date and % to goal for the window. */
  budgetToDate: number | null
  pctToGoal: number | null
  disagree: boolean
}
export interface FunnelRow { org: string; industry: string; stages: Partial<Record<FunnelStageKey, FunnelStage>> }
export type DateSpan = [string, string]
export interface FunnelLog {
  generatedAtIso: string
  generatedAt: number
  /** When Salesforce was queried: `salesforce.queriedAt`, else `generatedAt` (files written before 2026-11-16 13:3x). */
  queriedAtIso: string
  queriedAt: number
  window: { period: DateSpan; today: DateSpan | null; priorMonthSp: DateSpan | null; lastYearSp: DateSpan | null }
  tableau: { label: string | null; asOfIso: string | null; sameWindow: boolean }
  salesforce: { method: string | null; job: string | null; orgs: Record<string, string> }
  notes: string[]
  rows: FunnelRow[]
}

export type FunnelLogOff = 'missing' | 'unreadable' | 'invalid' | 'stale' | 'future'
export type FunnelLogRead = { ok: true; log: FunnelLog } | { ok: false; reason: FunnelLogOff }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null)
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const DAY = /^\d{4}-\d{2}-\d{2}$/
function span(v: unknown): DateSpan | null {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && DAY.test(v[0]) && DAY.test(v[1]) && v[0] <= v[1] ? [v[0], v[1]] : null
}

function parseStage(raw: unknown, sameWindow: boolean): FunnelStage | null {
  if (!isObj(raw)) return null
  const salesforce = count(raw.salesforce)
  if (salesforce === null) return null
  const tableau = sameWindow ? fin(raw.tableau) : null
  return {
    salesforce, tableau, todaySalesforce: count(raw.today_salesforce), priorMonthSp: count(raw.prior_month_sp), lastYearSp: count(raw.last_year_sp),
    budgetToDate: sameWindow ? fin(raw.budget_to_date) : null, pctToGoal: sameWindow ? fin(raw.pct_to_goal) : null,
    // A disagreement needs both figures for the same window.
    disagree: raw.disagree === true && tableau !== null,
  }
}

/** The log from a parsed file, or why not. A row or stage that does not parse is dropped (never guessed at); a file with no usable row is
 *  invalid. The clock is passed in, so staleness is testable. */
export function parseFunnelLog(raw: unknown, nowMs: number): FunnelLogRead {
  if (!isObj(raw) || raw.v !== 1 || raw.kind !== 'funnel-log') return { ok: false, reason: 'invalid' }
  const generatedAtIso = str(raw.generatedAt, 40)
  const generatedAt = generatedAtIso === null ? NaN : Date.parse(generatedAtIso)
  const w = isObj(raw.window) ? raw.window : null
  const period = span(w?.period)
  if (Number.isNaN(generatedAt) || !period || !Array.isArray(raw.rows) || raw.rows.length > FUNNEL_LOG_LIMITS.maxRows) return { ok: false, reason: 'invalid' }
  const t: Record<string, unknown> = isObj(raw.tableau) ? raw.tableau : {}
  const sameWindow = t.sameWindow === true
  const rows: FunnelRow[] = []
  for (const r of raw.rows) {
    if (!isObj(r) || !isObj(r.stages)) continue
    const org = str(r.org, 60), industry = str(r.industry, 40)
    if (!org || !industry) continue
    const stages: FunnelRow['stages'] = {}
    for (const k of FUNNEL_STAGES) {
      const s = parseStage((r.stages as Record<string, unknown>)[k], sameWindow)
      if (s) stages[k] = s
    }
    if (Object.keys(stages).length) rows.push({ org, industry, stages })
  }
  if (!rows.length) return { ok: false, reason: 'invalid' }
  const sf: Record<string, unknown> = isObj(raw.salesforce) ? raw.salesforce : {}
  const q = str(sf.queriedAt, 40), qMs = q === null ? NaN : Date.parse(q)
  const queriedAtIso = q !== null && !Number.isNaN(qMs) ? q : generatedAtIso as string
  const queriedAt = Number.isNaN(qMs) ? generatedAt : qMs
  if (queriedAt - nowMs > FUNNEL_LOG_LIMITS.maxFutureMs) return { ok: false, reason: 'future' }
  if (nowMs - queriedAt > FUNNEL_LOG_LIMITS.maxAgeHours * 3_600_000) return { ok: false, reason: 'stale' }
  const orgs: Record<string, string> = {}
  if (isObj(sf.orgs)) for (const [k, v] of Object.entries(sf.orgs)) { const id = str(v, 20); if (id && k.length <= 60) orgs[k] = id }
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(n => str(n, 300)).filter((n): n is string => n !== null).slice(0, FUNNEL_LOG_LIMITS.maxNotes)
  return { ok: true, log: {
    generatedAtIso: generatedAtIso as string, generatedAt, queriedAtIso, queriedAt,
    window: { period, today: span(w?.today), priorMonthSp: span(w?.prior_month_sp), lastYearSp: span(w?.last_year_sp) },
    tableau: { label: str(t.label, 160), asOfIso: str(t.asOf, 40), sameWindow },
    salesforce: { method: str(sf.method, 600), job: str(sf.coefficientJob, 120), orgs },
    notes, rows,
  } }
}

/** A reader that parses the file again only when its size or modified time changed, and checks staleness on every call. Never throws. */
export function funnelLogReader(path: string, now: () => number = Date.now): () => FunnelLogRead {
  let sig = '', cached: { raw: unknown } | { reason: FunnelLogOff } | null = null
  return () => {
    const nowMs = now()
    try {
      if (!existsSync(path)) { sig = ''; cached = null; return { ok: false, reason: 'missing' } }
      const st = statSync(path)
      const next = `${st.size}:${st.mtimeMs}`
      if (next !== sig || !cached) {
        sig = next
        if (!st.isFile() || st.size > FUNNEL_LOG_LIMITS.maxBytes) cached = { reason: 'invalid' }
        else { try { cached = { raw: JSON.parse(readFileSync(path, 'utf8')) } } catch (e) { cached = { reason: e instanceof SyntaxError ? 'invalid' : 'unreadable' } } }
      }
    } catch { sig = ''; cached = null; return { ok: false, reason: 'unreadable' } }
    return 'reason' in cached ? { ok: false, reason: cached.reason } : parseFunnelLog(cached.raw, nowMs)
  }
}

// ── Words ────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10))
const day = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? d.slice(5, 7)} ${Number(d.slice(8, 10))}`
/** "Nov 1 to 15", "Oct 28 to Nov 3", "Nov 16". */
export function spanText([a, b]: DateSpan): string {
  if (a === b) return day(a)
  return a.slice(0, 7) === b.slice(0, 7) ? `${day(a)} to ${Number(b.slice(8, 10))}` : `${day(a)} to ${day(b)}`
}
/** "07:08 CT" from the log's own time. */
const clockText = (iso: string) => refreshText(iso).replace(/^[A-Z][a-z]{2} \d{1,2} /, '')

/** One disagreement in words: "Liquor opps: Salesforce 40, Tableau 38 (Salesforce 2 higher)". */
export function disagreeText(row: FunnelRow, k: FunnelStageKey): string {
  const s = row.stages[k] as FunnelStage
  const diff = s.salesforce - (s.tableau as number)
  return `${row.industry} ${k}: Salesforce ${s.salesforce}, Tableau ${fmt(s.tableau as number)} (Salesforce ${fmt(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'})`
}

const SBU_ORG = 'POS Nation', XBU_ORG = 'Rain Retail'

/** The rows a question or a cue is about. With the Tableau facts: an industry group is the row of the same name; SBU or XBU is the rows of
 *  its org (listed, never added up: the log carries no BU total). Without them: an industry named by its own name (never the bare word
 *  "quilt", which is the company). None named: null. */
export function funnelRowsFor(log: FunnelLog, groups: DataGroup[] | null, text: string): FunnelRow[] | null {
  if (groups) {
    if (!groups.length) return null
    const out: FunnelRow[] = []
    for (const g of groups) {
      if (g.kind === 'bu') {
        const org = /^sbu$/i.test(g.name) ? SBU_ORG : /^xbu$/i.test(g.name) ? XBU_ORG : null
        for (const r of log.rows) if (org && r.org === org && !out.includes(r)) out.push(r)
      } else {
        const r = log.rows.find(x => x.industry.toLowerCase() === g.name.toLowerCase())
        if (r && !out.includes(r)) out.push(r)
      }
    }
    return out
  }
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const quiltIndustry = /\b(?:quilt (?:industry|vertical|segment|stores)|like ?sew)\b/i.test(text)
  const out = log.rows.filter(r => r.industry.toLowerCase() === 'quilt' ? quiltIndustry : words.has(r.industry.toLowerCase()))
  if (words.has('sbu')) for (const r of log.rows) if (r.org === SBU_ORG && !out.includes(r)) out.push(r)
  if (words.has('xbu')) for (const r of log.rows) if (r.org === XBU_ORG && !out.includes(r)) out.push(r)
  return out.length ? out : null
}

const STAGE_WORDS: Record<string, FunnelStageKey> = { lead: 'leads', leads: 'leads', opp: 'opps', opps: 'opps', opportunity: 'opps', opportunities: 'opps',
  demo: 'demos', demos: 'demos', customer: 'customers', customers: 'customers', logo: 'customers', logos: 'customers', win: 'customers', wins: 'customers' }
/** The stages a text names, in funnel order; empty when it names none. */
export function funnelStagesNamed(text: string): FunnelStageKey[] {
  const named = new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).map(w => STAGE_WORDS[w]).filter(Boolean))
  return FUNNEL_STAGES.filter(k => named.has(k))
}

/** What the daily log cannot answer, and the question asks: lead cohorts, sources, reps, SQLs, conversion rates. Null when nothing. */
const UNCOVERED: Array<[RegExp, string]> = [
  [/\bcohorts?\b|\b(?:leads?|opps?|opportunities)\s+(?:that\s+)?(?:were\s+|was\s+)?created\b|\bwhich month\b|\bmonth (?:the|their) lead/i, 'lead-cohort splits (which month the lead was created)'],
  [/\bsqls?\b/i, 'SQLs'],
  [/\blead\s+sources?\b|\bby\s+(?:lead\s+)?source\b|\bcampaigns?\b|\bpaid search\b|\bppc\b|\borganic\b/i, 'lead-source or campaign detail'],
  [/\b(?:reps?|bdrs?|vdrs?|owners?|by person)\b/i, 'rep or owner detail'],
  [/\bconver(?:t|ts|ted|ting|sion|sions)\b/i, 'conversion rates (the log has counts only)'],
]
export function funnelUncovered(question: string): string[] {
  return UNCOVERED.filter(([re]) => re.test(question)).map(([, what]) => what)
}

function stageAskText(log: FunnelLog, s: FunnelStage, k: FunnelStageKey, todayLabel: string | null): string {
  const parts = [`${k} Salesforce ${s.salesforce}`]
  if (s.tableau !== null) {
    parts[0] += ` vs Tableau ${fmt(s.tableau)}`
    if (s.disagree) { const diff = s.salesforce - s.tableau; parts[0] += ` [DISAGREE: Salesforce ${fmt(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'}]` }
  }
  if (s.budgetToDate !== null) parts.push(`Tableau budget to date ${fmt(s.budgetToDate)}${s.pctToGoal !== null ? ` (${Math.round(s.pctToGoal)}% to goal)` : ''}`)
  if (s.todaySalesforce !== null && todayLabel) parts.push(`Salesforce ${todayLabel} +${s.todaySalesforce}`)
  const ctx = [s.priorMonthSp !== null ? `PM ${s.priorMonthSp}` : '', s.lastYearSp !== null ? `PY ${s.lastYearSp}` : ''].filter(Boolean).join(', ')
  if (ctx) parts.push(`Salesforce ${ctx}`)
  return parts.join('; ')
}

/** "opps 40/38 DISAGREE (84% to goal)": Salesforce over Tableau, for a line that lists several industries. */
function stageCompactText(s: FunnelStage, k: FunnelStageKey): string {
  return `${k} ${s.salesforce}${s.tableau !== null ? `/${fmt(s.tableau)}` : ''}${s.disagree ? ' DISAGREE' : ''}${s.pctToGoal !== null ? ` (${Math.round(s.pctToGoal)}% to goal)` : ''}`
}

/** The Salesforce text the meeting assistant reads as a local source: what it is and its as-of times, the rows asked about (every row when
 *  none is named), the disagreements in words, the file's own notes, and what it does not cover. `facts` is the Tableau sheet now loaded
 *  (or null): it names the groups, and when it covers another window the text says so. */
export function funnelLogForAsk(log: FunnelLog, question: string, facts: DataFacts | null, groups: DataGroup[] | null): { title: string; text: string } {
  const p = log.window.period
  const asked = funnelRowsFor(log, groups, question)
  const rows = asked && asked.length ? asked : log.rows
  const named = funnelStagesNamed(question)
  const stages: FunnelStageKey[] = named.length ? named : [...FUNNEL_STAGES]
  const todayLabel = log.window.today ? `on ${spanText(log.window.today)} through ${clockText(log.queriedAtIso)}` : null
  const tableauLine = !log.tableau.sameWindow
    ? 'Tableau covered a different window when this log was written, so no Tableau figure is compared here.'
    : `Tableau side: ${log.tableau.label ?? 'Tableau marketing funnel'}${log.tableau.asOfIso ? `, extract refreshed ${refreshText(log.tableau.asOfIso)}` : ''}.`
  const lines = [
    `Salesforce, queried live through Coefficient ${refreshText(log.queriedAtIso)}, ${log.tableau.sameWindow ? 'beside Tableau for the same window' : 'for the window'}: ${spanText(p)} (month to the day before the query). `
      + 'Marketing lead sources only, New opportunities only, Central days. Not company revenue, MRR, ARR or location counts.',
    tableauLine,
  ]
  if (facts && (facts.period.start !== p[0] || facts.period.end !== p[1]))
    lines.push(`The Tableau sheet loaded now covers ${spanText([facts.period.start, facts.period.end])}, not ${spanText(p)}: compare it with this log only for the same days.`)
  lines.push(`Each stage: Salesforce${log.tableau.sameWindow ? ' vs Tableau' : ''} for ${spanText(p)}. `
    + `${log.tableau.sameWindow ? 'DISAGREE marks 2 or more apart: a finding to state and explain, not noise. ' : ''}`
    + `${todayLabel ? `"Salesforce ${todayLabel}" is today's count so far, not in the window. ` : ''}PM and PY are Salesforce for the same days of the prior month and of last year.`)
  const rowLines = (compact: boolean) => rows.flatMap(r => {
    const shown = stages.filter(k => r.stages[k])
    if (!shown.length) return []
    const body = compact ? shown.map(k => stageCompactText(r.stages[k] as FunnelStage, k)).join(', ') : shown.map(k => stageAskText(log, r.stages[k] as FunnelStage, k, todayLabel)).join(' | ')
    return [`${r.industry} (${r.org} org)${compact ? ' Salesforce/Tableau' : ''}: ${body}`]
  })
  // Detailed rows when they fit; else one compact line per industry, so no industry is cut for the detail of another.
  const detailed = rowLines(false)
  lines.push(...(detailed.join('\n').length > FUNNEL_LOG_LIMITS.askChars / 2 ? rowLines(true) : detailed))
  if (groups?.some(g => g.kind === 'bu')) lines.push('The log has no SBU or XBU total: its industries are listed, never added up.')
  const shownDis = rows.flatMap(r => stages.filter(k => r.stages[k]?.disagree).map(k => disagreeText(r, k)))
  const allDis = log.rows.flatMap(r => FUNNEL_STAGES.filter(k => r.stages[k]?.disagree).map(k => disagreeText(r, k)))
  lines.push(shownDis.length ? `Tableau and Salesforce disagree on: ${shownDis.join('; ')}.` : `Tableau and Salesforce agree within 1 on everything shown${log.tableau.sameWindow ? '' : ' (not compared: different windows)'}.`)
  const elsewhere = allDis.length - shownDis.length
  if (elsewhere > 0) lines.push(`Elsewhere in the log they disagree on ${elsewhere} more: ${allDis.filter(d => !shownDis.includes(d)).slice(0, 4).join('; ')}.`)
  for (const n of log.notes) lines.push(`Note: ${n}`)
  const industries = log.rows.map(r => r.industry).join(', ')
  lines.push(`Not in this log: SQLs, lead-cohort splits (which month an opp's lead was created), lead source, campaign or rep detail, conversion rates, and industries other than ${industries}. `
    + 'Ask cannot query Salesforce live, so a question that needs these is not answered from Salesforce.')
  const missing = funnelUncovered(question)
  if (missing.length) lines.push(`This question asks for ${missing.join(', ')}: the daily log does not carry it. Say so; do not answer it from these totals.`)
  // The disagreements and the coverage lines are the last to go: keep the head and tail, cut rows from the middle.
  let text = lines.join('\n')
  if (text.length > FUNNEL_LOG_LIMITS.askChars) {
    const head = lines.slice(0, 3).join('\n'), tail = lines.slice(-3).join('\n')
    const middle = lines.slice(3, -3)
    while (middle.length && `${head}\n${middle.join('\n')}\n${tail}`.length > FUNNEL_LOG_LIMITS.askChars) middle.pop()
    text = `${head}\n${middle.join('\n')}\n${tail}`.slice(0, FUNNEL_LOG_LIMITS.askChars)
  }
  // The query time rides in the title, so a cited figure always shows when Salesforce was read.
  return { title: `Salesforce via Coefficient, ${spanText(p)}, marketing sources, queried ${refreshText(log.queriedAtIso)}`, text }
}

/** The clause a data cue adds after its Tableau text: Salesforce for the same stages and window, and any disagreement in words. Empty when the
 *  log has no row or stage for what the cue shows. At most cueChars: the Salesforce figures shrink (stages, then a second industry) while the
 *  disagreement sentence, which carries both figures, is kept whole. */
export const SFDC_CUE_MARK = 'Salesforce via Coefficient'
export function funnelCueClause(log: FunnelLog, groups: DataGroup[], stages: readonly string[]): string {
  const rows = (funnelRowsFor(log, groups, '') ?? []).filter(r => groups.some(g => g.kind === 'industry' && g.name.toLowerCase() === r.industry.toLowerCase()))
  if (!rows.length) return ''
  const wanted = FUNNEL_STAGES.filter(k => stages.includes(k))
  const shownFor = (r: FunnelRow) => (wanted.length ? wanted : (['leads', 'opps', 'customers'] as FunnelStageKey[])).filter(k => r.stages[k])
  const head = `${SFDC_CUE_MARK}, ${spanText(log.window.period)}, queried ${refreshText(log.queriedAtIso)}:`
  const build = (rs: FunnelRow[], cut: number) => {
    const body = rs.map(r => {
      const shown = shownFor(r)
      if (!shown.length) return ''
      return `${r.industry} ${shown.slice(0, Math.max(1, shown.length - cut)).map(k => `${k} ${(r.stages[k] as FunnelStage).salesforce}`).join(', ')}`
    }).filter(Boolean).join('; ')
    if (!body) return ''
    const dis = rs.flatMap(r => shownFor(r).filter(k => r.stages[k]?.disagree).map(k => `${r.industry} ${k} Tableau ${fmt((r.stages[k] as FunnelStage).tableau as number)} vs Salesforce ${(r.stages[k] as FunnelStage).salesforce}`))
    const tail = !log.tableau.sameWindow ? ' Not compared: Tableau covered another window.' : dis.length ? ` Disagree: ${dis.join('; ')}.` : ' Agrees with Tableau within 1.'
    return `${head} ${body}.${tail}`
  }
  for (const rs of [rows, rows.slice(0, 1)]) for (let cut = 0; cut < 4; cut += 1) {
    const text = build(rs, cut)
    if (text && text.length <= FUNNEL_LOG_LIMITS.cueChars) return text
  }
  return build(rows.slice(0, 1), 4).slice(0, FUNNEL_LOG_LIMITS.cueChars)
}

// ── The meeting assistant: routing ───────────────────────────────────────────

const ASK_SALESFORCE = /\b(?:salesforce|sales\s+force|sfdc)\b/i
const ASK_COEFFICIENT = /\bcoefficient\b/i
const ASK_DATA_WORD = /\b(?:tableau|funnel|leads?|opps?|opportunit(?:y|ies)|sqls?|demos?|customers?|budget|pacing|forecast|numbers?|data)\b/i
/** The question names Salesforce. "Coefficient" counts only beside Tableau or a funnel or data word, so a correlation coefficient does not. */
export function askNamesSalesforce(own: string): boolean {
  return ASK_SALESFORCE.test(own) || (ASK_COEFFICIENT.test(own) && ASK_DATA_WORD.test(own))
}

/** Added to the meeting assistant's rules only when the Salesforce source is in the context. */
export const FUNNEL_ASK_ADDENDUM = ' A Salesforce source (Salesforce via Coefficient) gives live Salesforce counts beside Tableau for the same window. '
  + 'For a funnel question, answer from BOTH, and attach each figure to its source and as-of time in the answer itself, in this form: '
  + '"Tableau (refreshed <its refresh time>) <figure>; Salesforce (queried <its query time>) <figure>", with the times the sources give. '
  + 'Where a line says DISAGREE, or the source lists a disagreement, state it plainly as a finding (Tableau X, Salesforce Y), never as noise and never averaged away. '
  + 'Never say Salesforce figures were not provided while this source is present. Salesforce today-so-far counts are outside the window: say so if you use them. '
  + 'If the question needs something the source lists under Not in this log, say the daily log does not cover it and that Ask cannot query Salesforce live; do not answer it from the totals.'

/** Added to the cue writer's rules only when a kept data note carries Salesforce. */
export const FUNNEL_WRITER_ADDENDUM = '\nSalesforce in a Tableau note. When the note also gives Salesforce via Coefficient, name both sources. '
  + 'Where it says Disagree, say Tableau and Salesforce disagree and give both figures; that is a finding, not noise.'
