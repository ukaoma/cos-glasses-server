// Live cues data arm and meeting assistant data context: Tableau actuals against budget for the marketing-sourced funnel,
// read from ONE local file (`<data dir>/data-facts.json`, written by operations/scripts/tableau/cue_data_facts.py from the
// weekday Tableau report CSVs). Nothing here calls a model, the network or Tableau, and nothing writes.
//
// Why: a funnel number said in a meeting ("SBU closed at 120% of MRR budget") is checked against what Tableau shows for the
// same group. The two are often different measures, so a candidate always carries its scope and period, and the writer is told
// never to present it as revenue, MRR or location counts (DATA_WRITER_ADDENDUM).
//
// Rules, each on purpose:
//   - the arm is OFF when the file is missing, unreadable, invalid or older than DATA_FACTS_LIMITS.maxAgeHours (asOf, the
//     Tableau extract refresh, not the file's mtime);
//   - it offers at most ONE candidate, and only when the last ~600 characters spoken name a group (or an alias of one) AND
//     carry a funnel word or a figure of two digits or a percent;
//   - a one-word alias that is also plain English (pet, dive, music...) is "weak": it counts only beside a funnel word or an
//     industry word, so "let's dive into the numbers" and "pet project" stay quiet. The bare word "quilt" is never an alias;
//   - a lead source named in speech ("paid search", "PPC", "events") narrows the note to that source: its rows for the named group,
//     or the largest industries when no group is named. A source alone fires only for a jargon or multi-word name with a funnel word
//     or figure; a plain word that is also English (direct, events, email, organic...) counts only beside a named group. A source with
//     a group fires without a funnel word ("PPC landing pages for thrift"), the way a funnel word alone never could;
//   - domain (dataArmGate): a Quilt meeting runs it. An unreadable orientation is off. Any other confirmed domain (personal,
//     Sprocket Rocket, Hermit Crabs...) is off. A meeting with no confirmed domain (most G2 meetings) needs a Quilt signal from
//     the same evaluation: a Quilt brand or SBU/XBU named, a Quilt-domain memory or note among the candidates, or a Quilt term in
//     the meeting's title. A plain industry word alone (grocery, liquor, pet...) is not a signal.

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { GroundedNote } from './live-cues-v2-grounded.js'

export const DATA_FACTS_FILE = 'data-facts.json'

export const DATA_FACTS_LIMITS = {
  /** An open month: 120 hours (5 days) from `asOf`. The file is rewritten on weekdays from a 10:30 CT job; a long weekend leaves it
   *  72 hours old on Monday morning and a missed run or a holiday adds a day or two. Past 5 days the numbers could be last week's. */
  maxAgeHours: 120,
  /** A closed month does not go stale the way a month to date does: its figures only move by late-closing deals. It is kept for 35
   *  days from `asOf` (a month plus five days of slack): by then the next month's close should have replaced it, and a writer that
   *  stopped is still caught. Without this the first Monday after a month start, when the report window is still under 3 days, went dark. */
  maxClosedAgeDays: 35,
  /** A clock that reads this far behind the file's own time is wrong or the file is: off. */
  maxFutureMs: 60 * 60_000,
  maxBytes: 2_000_000,
  maxGroups: 60,
  maxSources: 400,
  maxBudgetLines: 400,
  /** The speech the trigger reads: the last this many characters of the window (about 100 words). */
  recentChars: 600,
  /** A candidate is at most this long, like a file passage. */
  candidateChars: 300,
  maxNamedGroups: 2,
  /** What the meeting assistant is given: at most this many characters of Tableau text. */
  askChars: 3_500,
  askSourceRowsPerIndustry: 6,
  /** A source-alone cue (no group named) lists this many industries, largest by leads. */
  cueSourceRows: 2,
  /** A typed question longer than this is probably pasted text (see askUserWords). */
  askQuestionChars: 300,
} as const

export const DATA_STAGES = ['leads', 'opps', 'sqls', 'demos', 'customers'] as const
export type DataStageKey = typeof DATA_STAGES[number]

export interface DataStage {
  actual: number
  budget: number | null
  budgetMonth: number | null
  pctToGoal: number | null
  priorMonthSamePeriod: number | null
  pySamePeriod: number | null
  exEventsPct?: number
  coreActual?: number
}
export interface DataGroup {
  name: string
  /** How text names the group where the plain name would be mistaken for the company ("Quilt industry (Like Sew)"). */
  display?: string
  kind: 'bu' | 'industry'
  aliases: string[]
  weakAliases: string[]
  /** The aliases that are Quilt brand names (and sbu/xbu): naming one is a Quilt signal. A plain industry word is not. */
  brandAliases: string[]
  members: string[]
  coverage?: { have: number; of: number }
  stages: Partial<Record<DataStageKey, DataStage>>
}
/** The stages a lead source has an actual for (Tableau's source budget file carries no per-source SQLs or demos). */
export const SOURCE_STAGES = ['leads', 'opps', 'customers'] as const
export type SourceStageKey = typeof SOURCE_STAGES[number]
export interface DataSourceStage { actual: number; budget: number | null; pctToGoal: number | null }
/** Tableau budgets per BUDGET LINE, not per lead source, and one line can count several sources (Paid Social sits inside "Paid Search -
 *  Non-Brand"). So a line's actual and budget are the whole line's, never one source's. Optional: older files have none. */
export interface DataBudgetLine { industry: string; line: string; sources: string[]; stages: Partial<Record<SourceStageKey, DataSourceStage>> }
export interface DataSourceRow {
  industry: string; source: string; bucket: string; leads: number; opps: number; customers: number
  /** The budget line the writer verified this source counts under; absent in older files. */
  budgetLine?: string
}
export interface DataFacts {
  label: string
  scope: string
  period: { label: string; start: string; end: string; closed: boolean }
  /** The Tableau extract refresh (or the report time), as given, and in ms. */
  asOfIso: string
  asOf: number
  completeThrough?: string
  groups: DataGroup[]
  sources: DataSourceRow[]
  /** Empty for a file written before budget lines. */
  budgetLines: DataBudgetLine[]
}

export type DataFactsOff = 'missing' | 'unreadable' | 'invalid' | 'stale' | 'future'
export type DataFactsRead = { ok: true; facts: DataFacts } | { ok: false; reason: DataFactsOff }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null)
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const wordList = (v: unknown, maxItems: number): string[] | null => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > maxItems) return null
  const out: string[] = []
  for (const item of v) {
    const s = str(item, 40)
    if (s === null || s.trim().length < 2) return null
    out.push(s.trim().toLowerCase())
  }
  return out
}

function parseStage(raw: unknown): DataStage | null {
  if (!isObj(raw)) return null
  const actual = fin(raw.actual)
  if (actual === null || actual < 0) return null
  const opt = (v: unknown) => fin(v)
  const stage: DataStage = { actual, budget: opt(raw.budget), budgetMonth: opt(raw.budgetMonth), pctToGoal: opt(raw.pctToGoal),
    priorMonthSamePeriod: opt(raw.priorMonthSamePeriod), pySamePeriod: opt(raw.pySamePeriod) }
  const ex = fin(raw.exEventsPct), core = fin(raw.coreActual)
  if (ex !== null) stage.exEventsPct = ex
  if (core !== null) stage.coreActual = core
  return stage
}

function parseSourceStage(raw: unknown): DataSourceStage | null {
  if (!isObj(raw)) return null
  const actual = fin(raw.actual)
  return actual === null || actual < 0 ? null : { actual, budget: fin(raw.budget), pctToGoal: fin(raw.pctToGoal) }
}

function parseBudgetLine(raw: unknown): DataBudgetLine | null {
  if (!isObj(raw) || !isObj(raw.stages)) return null
  const industry = str(raw.industry, 40), line = str(raw.line, 80)
  if (!industry || !line) return null
  const stages: DataBudgetLine['stages'] = {}
  for (const key of SOURCE_STAGES) {
    const st = parseSourceStage((raw.stages as Record<string, unknown>)[key])
    if (st) stages[key] = st
  }
  if (!Object.keys(stages).length) return null
  const sources = Array.isArray(raw.sources) ? raw.sources.map(x => str(x, 80)).filter((x): x is string => x !== null).slice(0, 20) : []
  return { industry, line, sources, stages }
}

function parseGroup(raw: unknown): DataGroup | null {
  if (!isObj(raw)) return null
  const name = str(raw.name, 40)
  const aliases = wordList(raw.aliases, 40), weak = wordList(raw.weakAliases, 10), brand = wordList(raw.brandAliases, 20)
  if (name === null || aliases === null || weak === null || brand === null || !isObj(raw.stages)) return null
  const stages: DataGroup['stages'] = {}
  for (const key of DATA_STAGES) {
    const s = parseStage((raw.stages as Record<string, unknown>)[key])
    if (s) stages[key] = s
  }
  if (!Object.keys(stages).length || (!aliases.length && !weak.length)) return null
  const members = Array.isArray(raw.members) ? raw.members.map(m => str(m, 40)).filter((m): m is string => m !== null).slice(0, 20) : []
  const cov = isObj(raw.coverage) && fin(raw.coverage.have) !== null && fin(raw.coverage.of) !== null && (raw.coverage.of as number) > 0
    ? { have: raw.coverage.have as number, of: raw.coverage.of as number } : undefined
  const display = str(raw.display, 60)
  return { name, ...(display ? { display } : {}), kind: raw.kind === 'bu' ? 'bu' : 'industry', aliases, weakAliases: weak, brandAliases: brand, members, ...(cov ? { coverage: cov } : {}), stages }
}

/** The facts from a parsed file, or why not. A group that does not parse is dropped (never guessed at); a file with no usable group is
 *  invalid. The clock is passed in, so staleness is testable. */
export function parseDataFacts(raw: unknown, nowMs: number): DataFactsRead {
  if (!isObj(raw) || raw.v !== 1 || raw.source !== 'Tableau') return { ok: false, reason: 'invalid' }
  const label = str(raw.label, 120), scope = str(raw.scope, 160)
  const period = isObj(raw.period) ? raw.period : null
  const pLabel = str(period?.label, 40), pStart = str(period?.start, 10), pEnd = str(period?.end, 10)
  const asOfIso = str(raw.asOf, 40)
  const asOf = asOfIso === null ? NaN : Date.parse(asOfIso)
  if (!label || !scope || !period || !pLabel || !pStart || !pEnd || typeof period.closed !== 'boolean' || Number.isNaN(asOf)) return { ok: false, reason: 'invalid' }
  if (!Array.isArray(raw.groups) || raw.groups.length > DATA_FACTS_LIMITS.maxGroups) return { ok: false, reason: 'invalid' }
  const groups = raw.groups.map(parseGroup).filter((g): g is DataGroup => g !== null)
  if (!groups.length) return { ok: false, reason: 'invalid' }
  const sources: DataSourceRow[] = []
  for (const r of Array.isArray(raw.sources) ? raw.sources.slice(0, DATA_FACTS_LIMITS.maxSources) : []) {
    if (!isObj(r)) continue
    const industry = str(r.industry, 40), source = str(r.source, 80)
    const leads = fin(r.leads), opps = fin(r.opps), customers = fin(r.customers)
    const budgetLine = str(r.budgetLine, 80)
    if (industry && source && leads !== null && opps !== null && customers !== null) sources.push({ industry, source, bucket: typeof r.bucket === 'string' ? r.bucket : '', leads, opps, customers, ...(budgetLine ? { budgetLine } : {}) })
  }
  const budgetLines = (Array.isArray(raw.budgetLines) ? raw.budgetLines.slice(0, DATA_FACTS_LIMITS.maxBudgetLines) : []).map(parseBudgetLine).filter((l): l is DataBudgetLine => l !== null)
  if (asOf - nowMs > DATA_FACTS_LIMITS.maxFutureMs) return { ok: false, reason: 'future' }
  const maxAgeMs = period.closed === true ? DATA_FACTS_LIMITS.maxClosedAgeDays * 24 * 3_600_000 : DATA_FACTS_LIMITS.maxAgeHours * 3_600_000
  if (nowMs - asOf > maxAgeMs) return { ok: false, reason: 'stale' }
  const through = typeof raw.completeThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.completeThrough) ? raw.completeThrough : undefined
  return { ok: true, facts: { label, scope, period: { label: pLabel, start: pStart, end: pEnd, closed: period.closed }, asOfIso: asOfIso as string, asOf,
    ...(through ? { completeThrough: through } : {}), groups, sources, budgetLines } }
}

/** Reads and parses the file. Missing, too big, unreadable or not JSON are three different reasons; never throws. */
export function readDataFactsFile(path: string, nowMs: number): DataFactsRead {
  try {
    if (!existsSync(path)) return { ok: false, reason: 'missing' }
    const st = statSync(path)
    if (!st.isFile() || st.size > DATA_FACTS_LIMITS.maxBytes) return { ok: false, reason: 'invalid' }
    return parseDataFacts(JSON.parse(readFileSync(path, 'utf8')), nowMs)
  } catch (e) {
    return { ok: false, reason: e instanceof SyntaxError ? 'invalid' : 'unreadable' }
  }
}

/** A reader that parses the file again only when its size or modified time changed, and checks staleness on every call. A cue
 *  evaluation runs up to three times a minute; this is one stat each. */
export function dataFactsReader(path: string, now: () => number = Date.now): () => DataFactsRead {
  let sig = '', cached: { raw: unknown } | { reason: DataFactsOff } | null = null
  return () => {
    const nowMs = now()
    try {
      if (!existsSync(path)) { sig = ''; cached = null; return { ok: false, reason: 'missing' } }
      const st = statSync(path)
      const next = `${st.size}:${st.mtimeMs}`
      if (next !== sig || !cached) {
        sig = next
        if (!st.isFile() || st.size > DATA_FACTS_LIMITS.maxBytes) cached = { reason: 'invalid' }
        else { try { cached = { raw: JSON.parse(readFileSync(path, 'utf8')) } } catch (e) { cached = { reason: e instanceof SyntaxError ? 'invalid' : 'unreadable' } } }
      }
    } catch { sig = ''; cached = null; return { ok: false, reason: 'unreadable' } }
    return 'reason' in cached ? { ok: false, reason: cached.reason } : parseDataFacts(cached.raw, nowMs)
  }
}

// ── The trigger ──────────────────────────────────────────────────────────────

const FUNNEL_TOKENS = new Set(['lead', 'leads', 'opp', 'opps', 'opportunity', 'opportunities', 'sql', 'sqls', 'demo', 'demos', 'logo', 'logos',
  'customer', 'customers', 'budget', 'budgets', 'budgeted', 'pacing', 'pace', 'percent', 'plan', 'goal', 'goals', 'forecast', 'attainment', 'quota'])
const STAGE_OF: Record<string, DataStageKey> = { lead: 'leads', leads: 'leads', opp: 'opps', opps: 'opps', opportunity: 'opps', opportunities: 'opps',
  sql: 'sqls', sqls: 'sqls', demo: 'demos', demos: 'demos', logo: 'customers', logos: 'customers', customer: 'customers', customers: 'customers' }
/** Words that, beside a weak alias, say the industry is meant: "pet vertical", "dive shops". */
const INDUSTRY_TOKENS = new Set(['industry', 'vertical', 'segment', 'stores', 'shops', 'retailers'])
/** A word between a weak alias and a funnel word: "leads for pet", "customers in dive". */
const BRIDGE_TOKENS = new Set(['for', 'in', 'on', 'of', 'the', 'our', 'with', 'by'])
/** A figure of two digits or more standing alone (not inside a word like said10 or a time like 10:30, and not a year), or a percent. */
function hasFigure(speech: string): boolean {
  if (/%|\bpercent\b/i.test(speech)) return true
  for (const m of speech.matchAll(/(?<![A-Za-z0-9:.,])(\d[\d,]*)(?:\.\d+)?(?![A-Za-z0-9:])/g)) {
    const digits = m[1].replace(/,/g, '')
    if (digits.length >= 2 && !/^(?:19|20)\d{2}$/.test(digits)) return true
  }
  return false
}

export const wordsOfSpeech = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

/** The speech the trigger reads: the last recentChars of the window, cut at a word. */
export function recentSpeech(window: string, chars: number = DATA_FACTS_LIMITS.recentChars): string {
  if (window.length <= chars) return window
  const cut = window.slice(-chars)
  const space = cut.indexOf(' ')
  return space > 0 && space < 24 ? cut.slice(space + 1) : cut
}

function occurrences(tokens: string[], phrase: string[]): number[] {
  const at: number[] = []
  if (!phrase.length) return at
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let all = true
    for (let j = 0; j < phrase.length; j += 1) if (tokens[i + j] !== phrase[j]) { all = false; break }
    if (all) at.push(i)
  }
  return at
}

/** `anchors` are the token positions of a lead-source name that is specific enough to stand alone (ppc, paid search): beside one, a weak
 *  alias counts the way it does beside a funnel word ("PPC for pet", "paid search for dive"). */
function weakAt(tokens: string[], i: number, anchors: ReadonlySet<number>): boolean {
  const inside = (k: number) => k >= 0 && k < tokens.length
  const funnel = (k: number) => inside(k) && (FUNNEL_TOKENS.has(tokens[k]) || anchors.has(k))
  const funnelOrIndustry = (k: number) => funnel(k) || (inside(k) && INDUSTRY_TOKENS.has(tokens[k]))
  const bridge = (k: number) => inside(k) && BRIDGE_TOKENS.has(tokens[k])
  if (funnelOrIndustry(i - 1) || funnelOrIndustry(i + 1)) return true
  return (bridge(i - 1) && funnel(i - 2)) || (bridge(i + 1) && funnel(i + 2))
}

// ── Lead sources ─────────────────────────────────────────────────────────────

/** How a lead source is said aloud. `strong` aliases are jargon or multi-word names that stand alone; `weak` ones are plain English
 *  (direct, events, email, organic, social...) and count only beside a named group or a stage word. `match` picks the source names IN THE
 *  FILE the concept covers, so a file without Webinar rows has nothing for "webinar". Names in the file are aliases too (see sourceHits); where
 *  a concept lists the same phrase as weak, the concept wins the tie, so a plain-English name stays weak. */
interface SourceConcept { label: string; strong: string[]; weak: string[]; match: (key: string) => boolean; /** "non-brand" or "brand" right beside it narrows it. */ narrow?: boolean }
const SOURCE_CONCEPTS: SourceConcept[] = [
  { label: 'Paid Search', strong: ['paid search', 'ppc', 'pay per click', 'sem', 'search engine marketing', 'google ads', 'google adwords', 'adwords', 'search ads'], weak: [], match: k => k.startsWith('paid search'), narrow: true },
  { label: 'Paid Search Brand', strong: [], weak: ['brand search', 'branded search'], match: k => k === 'paid search brand' },
  { label: 'Paid Search Non-Brand', strong: [], weak: ['non brand search', 'nonbrand search'], match: k => k === 'paid search non brand' },
  { label: 'Paid Social', strong: ['paid social', 'social ads', 'facebook ads', 'meta ads', 'instagram ads', 'linkedin ads', 'paid facebook', 'paid linkedin'], weak: ['facebook', 'meta', 'linkedin', 'instagram'], match: k => k === 'paid social' },
  { label: 'Social Media', strong: [], weak: ['social media'], match: k => k === 'social media' },
  { label: 'Social', strong: [], weak: ['social'], match: k => k.includes('social') },
  { label: 'Events', strong: ['trade show', 'trade shows', 'tradeshow', 'tradeshows'], weak: ['events', 'event', 'conference', 'conferences'], match: k => /(^| )events?( |$)/.test(k) },
  { label: 'Organic', strong: [], weak: ['organic', 'organic search', 'seo'], match: k => k.startsWith('organic') },
  { label: 'Direct', strong: [], weak: ['direct', 'direct traffic'], match: k => k === 'direct' },
  { label: 'Referral Traffic', strong: [], weak: ['referral traffic'], match: k => k === 'referral traffic' },
  { label: 'Customer Referral', strong: [], weak: ['customer referral', 'customer referrals'], match: k => k === 'customer referral' },
  { label: 'Referral', strong: [], weak: ['referral', 'referrals'], match: k => k === 'referral traffic' || k === 'customer referral' },
  { label: 'AI Referrals', strong: ['ai referrals', 'ai referral', 'ai traffic'], weak: ['chatgpt', 'chat gpt', 'perplexity'], match: k => k === 'ai referrals' },
  { label: 'Aggregators', strong: ['paid aggregator', 'paid aggregators', 'lead aggregator', 'lead aggregators', 'capterra', 'software advice', 'getapp'], weak: ['aggregator', 'aggregators', 'g2'], match: k => k === 'paid aggregator' },
  { label: 'Email', strong: ['email database', 'email marketing', 'newsletter', 'newsletters'], weak: ['email', 'emails'], match: k => k === 'email database' },
  { label: 'Webinar', strong: [], weak: ['webinar', 'webinars'], match: k => k === 'webinar' },
  { label: 'Partnership', strong: ['paid partnership', 'paid partnerships'], weak: ['partnership', 'partnerships'], match: k => k === 'paid partnership' },
]

const sourceKey = (name: string): string => wordsOfSpeech(name).join(' ')
/** "Paid Search - Non-Brand" as people say it: "Paid Search Non-Brand". */
export const sourceLabel = (name: string): string => name.replace(/\s+-\s+/g, ' ')

/** Every lead source the file knows: the rows' and the budget lines' members. */
function sourceNamesOf(facts: DataFacts): string[] {
  const out = new Set<string>()
  for (const r of facts.sources) out.add(r.source)
  for (const l of facts.budgetLines) for (const x of l.sources) out.add(x)
  return [...out]
}

interface SourceHit { start: number; end: number; names: string[]; strong: boolean; label: string }

/** "ppc non-brand", "brand ppc", "paid search brand": the word right beside a broad paid-search name picks Non-Brand or Brand. */
function narrowedNames(tokens: string[], start: number, end: number, names: string[]): string[] {
  const at = (k: number) => tokens[k] ?? ''
  const nonBrand = (at(start - 2) === 'non' && at(start - 1) === 'brand') || at(start - 1) === 'nonbrand' || (at(end) === 'non' && at(end + 1) === 'brand') || at(end) === 'nonbrand'
  if (nonBrand) return names.filter(n => sourceKey(n).includes('non brand'))
  const brand = at(start - 1) === 'brand' || at(start - 1) === 'branded' || at(end) === 'brand' || at(end) === 'branded'
  return brand ? names.filter(n => sourceKey(n).endsWith('brand') && !sourceKey(n).includes('non brand')) : names
}

/** Every place the speech names a lead source, the longer name winning where two overlap ("paid search non-brand" beats "paid search"). */
function sourceHits(facts: DataFacts, tokens: string[]): SourceHit[] {
  const all = sourceNamesOf(facts)
  const hits: SourceHit[] = []
  const add = (alias: string, strong: boolean, label: string, names: string[], narrow: boolean) => {
    const phrase = wordsOfSpeech(alias)
    for (const start of occurrences(tokens, phrase)) {
      const end = start + phrase.length
      hits.push({ start, end, names: narrow ? narrowedNames(tokens, start, end, names) : names, strong, label })
    }
  }
  for (const c of SOURCE_CONCEPTS) {
    const names = all.filter(n => c.match(sourceKey(n)))
    for (const a of c.strong) add(a, true, c.label, names, !!c.narrow)
    for (const a of c.weak) add(a, false, c.label, names, !!c.narrow)
  }
  for (const n of all) add(n, wordsOfSpeech(n).length > 1, sourceLabel(n), [n], false)
  const span = (h: SourceHit) => h.end - h.start
  return hits.filter((h, i) => !hits.some((o, j) => j !== i && o.start <= h.start && o.end >= h.end
    && (span(o) > span(h) || (span(o) === span(h) && (o.names.length > h.names.length || (o.names.length === h.names.length && j < i))))))
}

export interface NamedSource {
  /** What the speech called it ("Paid Search", "Events"), for a sentence. */
  label: string
  /** The source names in the file it covers. Empty when this extract has nothing for it. */
  names: string[]
  /** Specific enough to stand alone; a weak one is plain English and counts only beside a group or a stage word. */
  strong: boolean
  at: number
}

/** The lead sources the speech names, the one named last first. Two phrases that cover the same source names are one source. */
export function namedSources(facts: DataFacts, speech: string): NamedSource[] {
  const merged = new Map<string, NamedSource>()
  for (const h of sourceHits(facts, wordsOfSpeech(speech))) {
    const key = [...h.names].sort().join('|') || `none:${h.label}`
    const cur = merged.get(key)
    if (!cur) merged.set(key, { label: h.label, names: h.names, strong: h.strong, at: h.start })
    else { cur.strong = cur.strong || h.strong; cur.at = Math.max(cur.at, h.start) }
  }
  return [...merged.values()].sort((a, b) => b.at - a.at)
}

export interface NamedGroup { group: DataGroup; at: number; /** Named by a Quilt brand name or sbu/xbu, not only by an industry word. */ brand: boolean }
/** The groups the speech names, the one named last first. A group named twice counts at its last mention. */
export function namedGroups(facts: DataFacts, speech: string): NamedGroup[] {
  const tokens = wordsOfSpeech(speech)
  const anchors = new Set<number>()
  for (const h of sourceHits(facts, tokens)) if (h.strong) for (let k = h.start; k < h.end; k += 1) anchors.add(k)
  const out: NamedGroup[] = []
  for (const group of facts.groups) {
    let last = -1, brand = false
    for (const alias of group.aliases) for (const i of occurrences(tokens, wordsOfSpeech(alias))) last = Math.max(last, i)
    for (const alias of group.brandAliases) for (const i of occurrences(tokens, wordsOfSpeech(alias))) { last = Math.max(last, i); brand = true }
    for (const alias of group.weakAliases) for (const i of occurrences(tokens, wordsOfSpeech(alias))) if (weakAt(tokens, i, anchors)) last = Math.max(last, i)
    if (last >= 0) out.push({ group, at: last, brand })
  }
  return out.sort((a, b) => b.at - a.at)
}

export type DataTrigger = { fired: true; groups: DataGroup[]; stages: DataStageKey[]; brand: boolean
  /** The lead source the speech named last, when the note should be about that source. Null: the group totals. */
  source: NamedSource | null
  /** The speech carries a funnel word or a figure. False only when a source beside a group fired it. */
  funnel: boolean } | { fired: false; why: 'no_group' | 'no_funnel' }

/** Fires when the speech names a group AND carries a funnel word or a figure (two digits or more, or a percent). A lead source narrows
 *  the note: a specific one fires beside a group with no funnel word ("PPC landing pages for thrift") and, with a funnel word or a
 *  figure, alone; a plain-English one ("events", "direct") counts only beside a group. */
export function dataTrigger(facts: DataFacts, window: string): DataTrigger {
  const speech = recentSpeech(window)
  const named = namedGroups(facts, speech)
  const tokens = wordsOfSpeech(speech)
  const source = namedSources(facts, speech).find(s => s.names.length > 0 && (s.strong || named.length > 0)) ?? null
  if (!named.length && !source) return { fired: false, why: 'no_group' }
  const funnel = tokens.some(t => FUNNEL_TOKENS.has(t)) || hasFigure(speech)
  if (!funnel && !(source?.strong && named.length)) return { fired: false, why: 'no_funnel' }
  const stages = [...new Set(tokens.map(t => STAGE_OF[t]).filter((s): s is DataStageKey => !!s))]
  const picked = named.slice(0, DATA_FACTS_LIMITS.maxNamedGroups)
  return { fired: true, groups: picked.map(n => n.group), stages: DATA_STAGES.filter(s => stages.includes(s)), brand: picked.some(n => n.brand), source, funnel }
}

export interface DataGateInput {
  /** The confirmed meeting domain (Ask orientation), or null/empty when none is confirmed. */
  domain: string | null | undefined
  /** The orientation could not be read: it may belong to a personal meeting, so the arm is off. */
  orientationFailed?: boolean
  /** The speech names a Quilt brand or sbu/xbu (not only an industry word). */
  brand: boolean
  /** A Quilt-domain cue_memory or notes candidate survived the exclusions in this evaluation. */
  memoryQuilt?: boolean
  /** The meeting's title carries a Quilt term. */
  titleQuilt?: boolean
}
export type DataGate = { ok: true; signal: 'quilt' | 'brand' | 'memory' | 'title' } | { ok: false; why: 'orientation' | 'domain' | 'unconfirmed' }

/** Whether this meeting may be given Quilt's numbers. A Quilt meeting: yes. An unreadable orientation: no. Another confirmed domain: no.
 *  No confirmed domain: only with a Quilt signal from this evaluation, never from an industry word alone. */
export function dataArmGate(i: DataGateInput): DataGate {
  if (i.orientationFailed) return { ok: false, why: 'orientation' }
  const d = typeof i.domain === 'string' ? i.domain.trim().toLowerCase() : ''
  if (d === 'quilt') return { ok: true, signal: 'quilt' }
  if (d !== '') return { ok: false, why: 'domain' }
  if (i.brand) return { ok: true, signal: 'brand' }
  if (i.memoryQuilt) return { ok: true, signal: 'memory' }
  if (i.titleQuilt) return { ok: true, signal: 'title' }
  return { ok: false, why: 'unconfirmed' }
}

/** Does a Quilt-domain note (cue_memory.py or the notes arm says the domain) stand among the candidates. */
export const isQuiltDomain = (domain: unknown): boolean => typeof domain === 'string' && domain.trim().toLowerCase() === 'quilt'

/** A Quilt term in a meeting title: the company, SBU or XBU, Tableau, or the name of a Quilt brand in the facts. */
export function quiltTitleSignal(facts: DataFacts, titles: ReadonlyArray<string | null | undefined>): boolean {
  const brands = facts.groups.flatMap(g => g.brandAliases)
  for (const title of titles) {
    if (typeof title !== 'string' || !title.trim()) continue
    const tokens = wordsOfSpeech(title)
    if (tokens.some(t => t === 'quilt' || t === 'sbu' || t === 'xbu' || t === 'tableau')) return true
    if (brands.some(b => occurrences(tokens, wordsOfSpeech(b)).length > 0)) return true
  }
  return false
}

// ── The candidate ────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10))
const pctText = (s: { pctToGoal: number | null }) => (s.pctToGoal === null ? '' : ` (${Math.round(s.pctToGoal)}%)`)

/** "Nov 2 05:41 CT": the refresh as the file states it, with CT only for a Central offset. */
export function refreshText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso)
  if (!m) return iso
  const zone = m[6] === '-06:00' || m[6] === '-0600' || m[6] === '-05:00' || m[6] === '-0500' ? ' CT' : m[6] ? ` ${m[6]}` : ''
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])} ${m[4]}:${m[5]}${zone}`
}

function periodText(f: DataFacts): string {
  if (f.period.closed) return `${f.period.label} final`
  const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.period.end)
  return end ? `${f.period.label} to ${MONTHS[Number(end[2]) - 1]} ${Number(end[3])}, month to date` : `${f.period.label}, month to date`
}

function groupLine(g: DataGroup, stages: DataStageKey[], withContext: boolean): string {
  const cov = g.coverage && g.coverage.have < g.coverage.of ? ` (${g.coverage.have} of ${g.coverage.of} industries)` : ''
  const parts = stages.filter(k => g.stages[k]).map(k => {
    const s = g.stages[k] as DataStage
    const vs = s.budget === null ? ' (no budget)' : ` vs ${fmt(s.budget)}${pctText(s)}`
    return `${k} ${fmt(s.actual)}${vs}`
  })
  let line = `${g.display ?? g.name}${cov}: ${parts.join(', ')}`
  if (withContext && stages.length === 1) {
    const s = g.stages[stages[0]]
    if (s?.priorMonthSamePeriod != null) line += `, prior month same period ${fmt(s.priorMonthSamePeriod)}`
    if (s?.pySamePeriod != null) line += `, last year ${fmt(s.pySamePeriod)}`
  }
  return line
}

/** The stages a candidate shows: the ones the speech named, else leads, opps and customers. */
function shownStages(g: DataGroup, named: DataStageKey[]): DataStageKey[] {
  const wanted = (named.length ? named : (['leads', 'opps', 'customers'] as DataStageKey[])).filter(k => g.stages[k])
  return wanted.length ? wanted : DATA_STAGES.filter(k => g.stages[k]).slice(0, 3)
}

/** The candidate text: period, scope and refresh first, then actual against budget to date and % to goal for the named group(s).
 *  At most candidateChars: a second group, then stages, are dropped before it is cut. Empty only when no named group has a stage. */
export function dataCandidateText(facts: DataFacts, groups: DataGroup[], named: DataStageKey[]): string {
  const head = `Tableau ${periodText(facts)}, marketing-sourced funnel only, actual vs budget to date, refreshed ${refreshText(facts.asOfIso)}.`
  const max = DATA_FACTS_LIMITS.candidateChars
  const build = (gs: DataGroup[], cut: number): string => {
    const lines = gs.map(g => groupLine(g, shownStages(g, named).slice(0, Math.max(1, shownStages(g, named).length - cut)), true)).filter(l => !l.endsWith(': '))
    return lines.length ? `${head} ${lines.join('; ')}.` : ''
  }
  for (const gs of [groups, groups.slice(0, 1)]) {
    for (let cut = 0; cut < 3; cut += 1) {
      const text = build(gs, cut)
      if (text && text.length <= max) return text
    }
  }
  return build(groups.slice(0, 1), 2).slice(0, max)
}

const bySourceLeads = (a: DataSourceRow, b: DataSourceRow) => b.leads - a.leads
const rowStages = (r: DataSourceRow, shown: SourceStageKey[]) => shown.map(k => `${k} ${fmt(r[k])}`).join(', ')

/** The rows of the named source names, for these industries (every industry when null), the largest by leads first. */
function sourceRowsFor(facts: DataFacts, names: string[], industries: string[] | null): DataSourceRow[] {
  return facts.sources.filter(r => names.includes(r.source) && (!industries || industries.includes(r.industry))).sort(bySourceLeads)
}

/** The budget lines of an industry that count any of these sources. A line is the whole line's actual against its budget. */
function budgetLinesFor(facts: DataFacts, industry: string, names: string[]): DataBudgetLine[] {
  return facts.budgetLines.filter(l => l.industry === industry && l.sources.some(x => names.includes(x)))
}

/** "shared with Paid Social": the other sources that have rows in this industry and sit in the same budget line. */
function alsoCounts(facts: DataFacts, l: DataBudgetLine, names: string[]): string {
  const others = l.sources.filter(x => !names.includes(x) && facts.sources.some(r => r.industry === l.industry && r.source === x && r.leads + r.opps + r.customers > 0))
  return others.length ? ` (shared with ${others.slice(0, 3).map(sourceLabel).join(', ')})` : ''
}

function lineStagesText(l: DataBudgetLine, shown: SourceStageKey[]): string {
  const parts = shown.filter(k => l.stages[k]).map(k => { const st = l.stages[k] as DataSourceStage; return `${k} ${fmt(st.actual)} vs ${st.budget === null ? 'no budget' : fmt(st.budget)}${pctText(st)}` })
  return parts.join(', ')
}

/** The candidate when the room named a lead source. Leads with that source's own rows ("Thrift, Paid Search Non-Brand alone: leads 45,
 *  opps 11, customers 3") for the named industry, or for the largest industries when no group is named; with the budget line it is counted
 *  under, when the file has one, because Tableau budgets per line and a line can count more than one source. At most candidateChars:
 *  budget lines, then a second group, then stages are dropped before it is cut. Empty when the source has no row for the named group. */
export function dataSourceCandidateText(facts: DataFacts, source: NamedSource, groups: DataGroup[], named: DataStageKey[]): string {
  const head = `Tableau ${periodText(facts)}, marketing-sourced, lead-source detail, refreshed ${refreshText(facts.asOfIso)}.`
  const max = DATA_FACTS_LIMITS.candidateChars
  const wanted = SOURCE_STAGES.filter(k => named.includes(k))
  const all: SourceStageKey[] = wanted.length ? wanted : [...SOURCE_STAGES]
  const several = source.names.length > 1
  // `budget`: every row's line, only the largest row's line, or none.
  type Budget = 'all' | 'top' | 'none'
  const segment = (g: DataGroup | null, shown: SourceStageKey[], budget: Budget): string => {
    if (g && g.kind === 'industry' && g.members.length === 1) {
      const industry = g.members[0]
      const rows = sourceRowsFor(facts, source.names, [industry])
      if (!rows.length) return ''
      let out = `${g.display ?? g.name}, ${rows.map(r => `${sourceLabel(r.source)} alone: ${rowStages(r, shown)}`).join('; ')}.`
      if (budget !== 'none') for (const l of budgetLinesFor(facts, industry, (budget === 'top' ? rows.slice(0, 1) : rows).map(r => r.source))) {
        const text = lineStagesText(l, shown)
        if (text) out += ` Budget line ${sourceLabel(l.line)}${alsoCounts(facts, l, rows.map(r => r.source))}: ${text}.`
      }
      return out
    }
    const rows = sourceRowsFor(facts, source.names, g ? g.members : null).slice(0, DATA_FACTS_LIMITS.cueSourceRows)
    if (!rows.length) return ''
    return `${g ? `${g.display ?? g.name} industries, ` : ''}${several ? source.label : sourceLabel(source.names[0])} alone, largest by leads: ${rows.map(r => `${r.industry}${several ? ` ${sourceLabel(r.source)}` : ''} ${rowStages(r, shown)}`).join('; ')}.`
  }
  const tries = groups.length ? [groups, groups.slice(0, 1)] : [[] as DataGroup[]]
  for (const gs of tries) for (const budget of ['all', 'top', 'none'] as Budget[]) for (let cut = 0; cut < 3; cut += 1) {
    const shown = all.slice(0, Math.max(1, all.length - cut))
    const parts = (gs.length ? gs : [null]).map(g => segment(g, shown, budget)).filter(Boolean)
    const text = parts.length ? `${head} ${parts.join(' ')}` : ''
    if (text && text.length <= max) return text
  }
  const parts = (tries[tries.length - 1].length ? tries[tries.length - 1] : [null]).map(g => segment(g, all.slice(0, 1), 'none')).filter(Boolean)
  return parts.length ? `${head} ${parts.join(' ')}`.slice(0, max) : ''
}

/** The grounded candidate for a window, or why there is none. */
export function dataCandidate(facts: DataFacts, window: string, nowDate: string): { candidate: GroundedNote; brand: boolean } | { none: 'no_group' | 'no_funnel' | 'no_stage' } {
  const t = dataTrigger(facts, window)
  if (!t.fired) return { none: t.why }
  const fromSource = t.source ? dataSourceCandidateText(facts, t.source, t.groups, t.stages) : ''
  // A source with no row for the named group must not turn a window with no funnel word into a totals cue.
  if (!fromSource && t.source && !t.funnel) return { none: 'no_funnel' }
  const notes = fromSource || (t.groups.length ? dataCandidateText(facts, t.groups, t.stages) : '')
  if (!notes) return { none: 'no_stage' }
  const date = /^\d{4}-\d{2}-\d{2}/.exec(facts.asOfIso)?.[0] ?? nowDate
  return { candidate: { id: 'D1', date, title: facts.label, notes, key: `data:tableau|${facts.label}|${facts.asOfIso}`, arm: 'data', kind: 'data' }, brand: t.brand }
}

/** Appended to the writer's rules only when a Tableau note was kept. The v3/v4 rules themselves stay byte-identical. */
export const DATA_WRITER_ADDENDUM = '\nTableau note. A memory note whose title starts with Tableau is a live extract of the marketing-sourced funnel '
  + '(leads, opportunities, SQLs, demos, customers) for the period in its title. It is not company revenue, MRR, ARR, location counts or customers from every source. '
  + 'If you use it, say Tableau, the period, and marketing sources. Quote its numbers exactly; do not sum, project or round them. '
  + 'Set a figure the room said beside the Tableau figure only when both measure the same thing (same stage, same group). '
  + 'When they differ in scope, such as MRR or locations against marketing-sourced customers, say they are different measures and give the Tableau figure as context, not as proof that the room is wrong. '
  + 'A note that names a lead source (Paid Search Non-Brand, Events...) covers only that source: say which source, never present it as the whole group, '
  + 'and when it gives a budget line, say the budget is for that line, which can count other sources too. '
  + 'If the note does not cover what the room said, ignore it.'

// ── The meeting assistant ────────────────────────────────────────────────────

const ASK_TABLEAU = /\btableau\b/i
const ASK_FUNNEL = /\b(?:funnel|leads?|opps?|opportunit(?:y|ies)|sqls?|demos?|logos?|customers?|budget(?:s|ed)?|pac(?:e|ing)|forecast|attainment|goals?|quota|percent|plan)\b|%/i

/** The words of a typed question that are the user's own. A long text (a pasted article, a transcript) carries other people's words:
 *  past askQuestionChars only its last line counts, and only when that line is short; a long text with no short last line counts
 *  for nothing. */
export function askUserWords(question: string): string {
  if (question.length <= DATA_FACTS_LIMITS.askQuestionChars) return question
  const last = question.trimEnd().split(/\n+/).pop() ?? ''
  return last.length <= DATA_FACTS_LIMITS.askQuestionChars && last.length < question.trim().length ? last : ''
}

/** A funnel stage or pacing word: enough, beside a plain-English source word, to say the question is about the data ("leads from events"). */
const ASK_STAGE = /\b(?:leads?|opps?|opportunit(?:y|ies)|sqls?|demos?|logos?|customers?|pac(?:e|ing)|attainment)\b/i
const ASK_SOURCE_WORD = /\b(?:sources?|channels?|campaigns?)\b/i
/** "how did events do for thrift": a question about how something performed, which a group and a plain source word then make a data question. */
const ASK_PERFORMANCE = /\b(?:did|doing|perform(?:ed|ing|ance)?|results?|numbers?|convert(?:ed|ing)?|conversions?|roi|worked|working)\b/i

/** The lead sources a typed question names that it may be answered from. A specific name ("paid search", "PPC") always counts; a
 *  plain-English one ("direct", "events", "email") only with a stage or source word, or with a group beside "Tableau" or a
 *  performance word, so "the direct reports on the thrift team" stays quiet. */
export function askSources(facts: DataFacts, own: string, hasGroup: boolean): NamedSource[] {
  const weakOk = ASK_STAGE.test(own) || ASK_SOURCE_WORD.test(own) || (hasGroup && (ASK_PERFORMANCE.test(own) || ASK_TABLEAU.test(own)))
  return namedSources(facts, own).filter(x => x.strong || weakOk)
}

export interface AskDataIntent { intent: 'tableau' | 'named' | null; /** A Quilt brand or sbu/xbu is named. */ brand: boolean }
/** What a typed question asks of the data: `tableau` when it says Tableau, `named` when it names a group and asks about funnel,
 *  budget or pacing, or names a lead source (see askSources) beside a group or a funnel word, else null. `tableau` may be answered in any meeting but a personal one. `named` goes through dataArmGate like
 *  the cue arm: a Quilt meeting, or an unconfirmed one with a Quilt brand named or a Quilt term in the meeting's title. */
export function askDataIntent(question: string, facts: DataFacts): AskDataIntent {
  const own = askUserWords(question)
  const named = namedGroups(facts, own)
  const brand = named.some(n => n.brand)
  if (ASK_TABLEAU.test(own)) return { intent: 'tableau', brand }
  if (ASK_FUNNEL.test(own) && named.length > 0) return { intent: 'named', brand }
  // A lead source: a specific name needs a group or a funnel word beside it ("how did paid search do for thrift"); a plain-English one
  // already passed askSources' own test.
  const sources = askSources(facts, own, named.length > 0)
  if (sources.length && (!sources.some(x => x.strong) || named.length > 0 || ASK_FUNNEL.test(own))) return { intent: 'named', brand }
  return { intent: null, brand }
}

/** The Tableau text the meeting assistant reads as a local source, or null. Stage rows for the groups the question names (or the
 *  business units and every industry when it names none), then the lead-source rows of the named industries. When the question names a
 *  lead source ("paid search", "PPC"), the answer is about that source instead: its rows for the named industries, or for every industry
 *  when none is named, each with the budget line Tableau counts it under. The rows are listed, never added up: the writer's rules say
 *  not to sum, and a sum of rows is not a figure Tableau shows. */
export function dataFactsForAsk(facts: DataFacts, rawQuestion: string): { title: string; text: string } | null {
  const own = askUserWords(rawQuestion)
  const named = namedGroups(facts, own).map(n => n.group)
  const sources = askSources(facts, own, named.length > 0)
  const chosen = named.length || sources.length ? named : facts.groups
  const lines: string[] = [
    `Tableau marketing funnel, ${periodText(facts)}. Scope: ${facts.scope}; marketing-sourced leads, opportunities, SQLs, demos and customers only. Not company revenue, MRR, ARR or location counts.`,
    `Extract refreshed ${refreshText(facts.asOfIso)}.${facts.completeThrough ? ` Complete through ${facts.completeThrough}.` : ''} Each stage: actual vs budget to date (% to goal; PM = prior month same period; PY = last year same period).`,
  ]
  for (const g of chosen) {
    const cov = g.coverage && g.coverage.have < g.coverage.of ? ` (${g.coverage.have} of ${g.coverage.of} industries: ${g.members.join(', ')})` : ''
    const stages = DATA_STAGES.filter(k => g.stages[k]).map(k => {
      const s = g.stages[k] as DataStage
      const extra = [s.priorMonthSamePeriod != null ? `PM ${fmt(s.priorMonthSamePeriod)}` : '', s.pySamePeriod != null ? `PY ${fmt(s.pySamePeriod)}` : '',
        s.exEventsPct != null ? `ex-events ${Math.round(s.exEventsPct)}%` : ''].filter(Boolean).join(', ')
      return `${k} ${fmt(s.actual)} vs ${s.budget === null ? 'no budget' : fmt(s.budget)}${pctText(s)}${extra ? ` [${extra}]` : ''}`
    })
    lines.push(`${g.display ?? g.name}${cov}: ${stages.join('; ')}`)
  }
  if (sources.length) {
    lines.push(...sourceLinesForAsk(facts, sources, named, lines.join('\n').length))
  } else if (named.length) {
    for (const g of named) {
      const rows = facts.sources.filter(r => g.members.includes(r.industry)).sort((a, b) => b.leads - a.leads).slice(0, DATA_FACTS_LIMITS.askSourceRowsPerIndustry * Math.max(1, g.members.length))
      if (rows.length) lines.push(`${g.display ?? g.name} lead sources (leads/opps/customers): ${rows.map(r => `${g.kind === 'bu' ? `${r.industry} ` : ''}${r.source} ${fmt(r.leads)}/${fmt(r.opps)}/${fmt(r.customers)}`).join('; ')}`)
    }
  }
  const text = lines.join('\n').slice(0, DATA_FACTS_LIMITS.askChars)
  return chosen.length || sources.length ? { title: facts.label, text } : null
}

/** The lines for a question about a lead source: what was asked, then one line per industry (largest leads first) with that source's
 *  rows and the budget line(s) it is counted under. Industries that do not fit in askChars are named as left out, never half shown. */
function sourceLinesForAsk(facts: DataFacts, sources: NamedSource[], groups: DataGroup[], used: number): string[] {
  const names = [...new Set(sources.flatMap(x => x.names))]
  const asked = sources.map(x => `${x.label}${x.names.length ? ` (${x.names.map(sourceLabel).join(', ')})` : ' (no rows in this Tableau extract)'}`).join('; ')
  const out = [`Lead source asked about: ${asked}. Each row below is that source alone as leads/opps/customers. Tableau sets budgets per budget line, and one line can count several sources, `
    + 'so a budget appears only against its whole line, never against one source. Rows are listed, not added up.']
  if (!names.length) return out
  const wanted = groups.length ? new Set(groups.flatMap(g => g.members)) : null
  const industries = [...new Set([...facts.sources.filter(r => names.includes(r.source)).map(r => r.industry), ...facts.budgetLines.filter(l => l.sources.some(x => names.includes(x))).map(l => l.industry)])]
    .filter(i => !wanted || wanted.has(i))
  const leadsOf = (i: string) => sourceRowsFor(facts, names, [i]).reduce((n, r) => n + r.leads, 0)
  const blocks = industries.sort((a, b) => leadsOf(b) - leadsOf(a)).map(industry => {
    const rows = sourceRowsFor(facts, names, [industry])
    const display = facts.groups.find(g => g.kind === 'industry' && g.name === industry)?.display ?? industry
    const rowText = rows.length ? rows.map(r => `${sourceLabel(r.source)} ${fmt(r.leads)}/${fmt(r.opps)}/${fmt(r.customers)}`).join('; ') : 'no rows for this source'
    const budget = budgetLinesFor(facts, industry, names).map(l => `Budget line ${sourceLabel(l.line)}${alsoCounts(facts, l, names)}: ${lineStagesText(l, [...SOURCE_STAGES])}.`)
    return `${display} (leads/opps/customers): ${rowText}.${budget.length ? ` ${budget.join(' ')}` : ''}`
  })
  const room = DATA_FACTS_LIMITS.askChars - used - out[0].length - 80
  let spent = 0, shown = 0
  for (const b of blocks) {
    if (spent + b.length + 1 > room) break
    out.push(b); spent += b.length + 1; shown += 1
  }
  if (shown < blocks.length) out.push(`${blocks.length - shown} more industries are not shown (the smallest by leads).`)
  return out
}

/** Added to the meeting assistant's rules only when its Tableau source is in the context. */
export const DATA_ASK_ADDENDUM = ' A Tableau source covers the marketing-sourced funnel only: when you use it, say Tableau, its period and marketing sources, '
  + 'and never present it as company revenue, MRR, ARR or location counts. Set a figure from the meeting beside it only when both measure the same thing; otherwise name the difference. '
  + 'A lead-source row covers only that source: say which source it is, and when you quote a budget, say it is the budget line, which can count other sources too.'
