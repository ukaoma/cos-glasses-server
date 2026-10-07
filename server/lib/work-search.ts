/**
 * Work search by meaning (6.65.0, Control 0.5.259).
 *
 * Control searches the board's cards by words on its own, instantly. After a pause it asks this for the card the user
 * MEANS: one Jev Choice over the board's task texts, with `none` as an option. Measured 2026-10-06 on 105 real Quilt
 * tasks and 10 queries: the right card first 10 of 10 times in 0.2 s (keyword search alone found 7 of 10).
 *
 * The candidates are the board's own rows (the same listBoard read /api/tasks serves), never client text: the client
 * names a scope, a domain, or exact ids. A Choice holds at most 254 options plus `none`, so a larger set is refused as
 * `too_many_candidates` rather than truncated (a truncated search would silently miss cards).
 *
 * Cost controls of its own, separate from Work intake and session advice (COS_JEV_DAILY_TOKENS): a daily input-token
 * cap (COS_JEV_SEARCH_DAILY_TOKENS, default 1,000,000, about 200 searches at the ~5k input tokens measured per search:
 * 64.5k over 13 live calls), its own usage ledger, its own breaker (3 failures, then 1 hour), and a switch
 * (COS_JEV_SEARCH=0 turns it off). Key resolution and the request timeout are jev.ts's. A search that cannot run
 * answers HTTP 200 with `available: false` and a reason, so Control keeps its word search and says one line about why.
 */
import { createHash } from 'node:crypto'
import { dataPath } from './data-dir.js'
import { estimateJevTokens, JevClient, JevError } from './jev.js'
import { boundForRedaction, redactSecretText } from './activity-preview.js'
import { redactSecrets } from './lens-gist-engines.js'

export const WORK_SEARCH_LIMITS = {
  queryMin: 2, queryMax: 200,
  /** A Jev Choice holds 255 options; one is `none`. */
  maxCandidates: 254,
  optionChars: 300,
  /** How much of a task's text the redaction reads: four times what Jev gets, so no pattern ever scans a long input. */
  optionScanChars: 1_200,
  minP: 0.02, maxResults: 20,
  cacheMs: 10 * 60_000, cacheEntries: 200,
  defaultDailyTokens: 1_000_000,
} as const
export const WORK_SEARCH_USAGE_FILE = dataPath('jev-search-usage.json')
export const WORK_SEARCH_SCOPES = ['all', 'attention', 'progress', 'completed'] as const
export type WorkSearchScope = typeof WORK_SEARCH_SCOPES[number]

export const WORK_SEARCH_INSTRUCTIONS = 'The user typed `query` into the search box of their task board. Which task are they trying '
  + 'to find? Pick the task they mean even when it uses different words, or none if no task fits.'
export const WORK_SEARCH_NONE = 'None of these tasks is what the user is looking for.'

export type WorkSearchReason = 'jev_not_configured' | 'jev_key_rejected' | 'jev_cap_reached' | 'jev_breaker_open' | 'jev_request_rejected'
  | 'jev_unavailable' | 'search_off' | 'too_many_candidates'
export const WORK_SEARCH_MESSAGES: Record<WorkSearchReason, string> = {
  jev_not_configured: 'Meaning search needs a TypeSafe key. Add one in Settings.',
  jev_key_rejected: 'TypeSafe did not accept the saved key. Check it in Settings. Word search still works.',
  jev_cap_reached: 'Meaning search has used today’s budget. It resets at midnight UTC. Word search still works.',
  jev_breaker_open: 'Meaning search is paused for an hour after repeated failures. Word search still works.',
  jev_request_rejected: 'Jev refused this search request. Word search still works.',
  jev_unavailable: 'Meaning search got no answer from Jev. Word search still works.',
  search_off: 'Meaning search is turned off on this server.',
  too_many_candidates: `Meaning search covers up to ${WORK_SEARCH_LIMITS.maxCandidates} cards. Pick a domain to search this view.`,
}

export interface WorkSearchHit { id: string; p: number }
export type WorkSearchResult =
  | { available: true; results: WorkSearchHit[]; none: number | null; cached: boolean; tokens: number }
  | { available: false; reason: WorkSearchReason; message: string }

export function unavailable(reason: WorkSearchReason): Extract<WorkSearchResult, { available: false }> {
  return { available: false, reason, message: WORK_SEARCH_MESSAGES[reason] }
}

/** The daily input-token cap for search alone. The ledger day is UTC, so the budget resets at midnight UTC. */
export function workSearchDailyCap(): number {
  const raw = Number(process.env.COS_JEV_SEARCH_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : WORK_SEARCH_LIMITS.defaultDailyTokens
}

/**
 * On unless COS_JEV_SEARCH says off (0, false, no, off). The value comes from the server's environment, which is fixed
 * when the server starts (the LaunchAgent plist, or ~/.cos-glasses/.env read at boot), so changing it takes a restart.
 * The cap, COS_JEV_SEARCH_DAILY_TOKENS, is the same.
 */
export function workSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.COS_JEV_SEARCH ?? '').trim().toLowerCase())
}

/** Search's own Jev client: its own ledger file, cap and breaker. jev.ts supplies the key and the timeout. */
export function createWorkSearchJevClient(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(),
                                          usageFile = WORK_SEARCH_USAGE_FILE): JevClient {
  return new JevClient(fetchImpl, now, usageFile, workSearchDailyCap)
}

let sharedSearchClient: JevClient | null = null
/** One search client per process: it owns search's breaker. Saving a new key resets it (routes/jev.ts). */
export function sharedWorkSearchJevClient(): JevClient { return sharedSearchClient ??= createWorkSearchJevClient() }

const WORK_DETAILS_RE = /\[Work details\]\([^)]*\)/gi
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)\s]*\)/g
// Bounded scheme, as in activity-preview.ts: an unbounded one is retried from every position of a long run.
const SCHEME_URL_RE = /\b(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)\S+/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g
// A host with a path (docs.google.com/document/d/…). A bare domain stays: it is usually a brand name people search for.
const PATH_URL_RE = /\b(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}\/\S*/gi
const LONG_RUN_RE = /[A-Za-z0-9_-]{24,}/g

/**
 * What Jev reads for one card (6.65.0 QA, S-W6): the task text with `[Work details](…)` links dropped, other markdown
 * links reduced to their label, credentials masked by the server's secret redaction (redactSecretText, then
 * redactSecrets), and URLs, email addresses and opaque ids (24 or more letters, digits, `-` or `_` with both a letter and
 * a digit, the shape of a key or a document id) removed. They add nothing to finding a card, and TypeSafe is a third
 * party. One line, at most 300 characters.
 */
export function searchOptionText(text: string): string {
  let out = boundForRedaction(text, WORK_SEARCH_LIMITS.optionScanChars).head.replace(WORK_DETAILS_RE, ' ')
  out = redactSecrets(redactSecretText(out))
  out = out.replace(MARKDOWN_LINK_RE, '$1').replace(SCHEME_URL_RE, ' ').replace(EMAIL_RE, ' ').replace(PATH_URL_RE, ' ')
  out = out.replace(LONG_RUN_RE, run => /\d/.test(run) && /[A-Za-z]/.test(run) ? ' ' : run)
  return out.replace(/\s+/g, ' ').trim().slice(0, WORK_SEARCH_LIMITS.optionChars).trim()
}

/**
 * API POSTs that only read (6.65.0 QA). index.ts lets them past the global mutation lease. POST /work/search reads the
 * board and asks Jev one question; it writes nothing but its own token ledger (one atomic write). Under the lease, a
 * drain for an update or restart would wait up to 20 s (the Jev timeout) for a search, and a drain would answer every
 * search 503. Outside it, a restart mid-search loses at most that search's token count.
 */
export function isReadOnlyApiPost(method: string, path: string): boolean {
  return method === 'POST' && path === '/work/search'
}

/** A query's length as people count it: code points, not UTF-16 units, so 150 emoji are 150 (Control counts characters). */
export function queryLength(query: string): number { return [...query].length }

export interface SearchableRow { id: string; domain: string; text: string; checked: boolean; workIdentity?: string }
export interface CandidateRequest { domain?: string; scope?: WorkSearchScope; ids?: string[] }

/**
 * The cards a search covers, in board order. Exact ids win: Control sends them for views only it can compute (Needs
 * attention, In progress). Otherwise a domain board covers that domain's cards; All work covers open cards; Completed
 * covers completed ones. Needs attention and In progress without ids cover open cards. Rows without searchable text
 * are left out. Returns null when there are more than 254.
 */
export function selectCandidates<Row extends SearchableRow>(rows: readonly Row[], request: CandidateRequest): Row[] | null {
  const inDomain = (row: Row) => !request.domain || row.domain === request.domain
  let picked: Row[]
  if (request.ids) {
    const wanted = new Set(request.ids)
    picked = rows.filter(row => wanted.has(row.id) || (!!row.workIdentity && wanted.has(row.workIdentity)))
  } else if (request.scope === 'completed') {
    picked = rows.filter(row => row.checked && inDomain(row))
  } else if (request.scope === 'attention' || request.scope === 'progress') {
    picked = rows.filter(row => !row.checked && inDomain(row))
  } else if (request.domain) {
    picked = rows.filter(row => row.domain === request.domain)
  } else {
    picked = rows.filter(row => !row.checked)
  }
  picked = picked.filter(row => searchOptionText(row.text).length > 0)
  return picked.length > WORK_SEARCH_LIMITS.maxCandidates ? null : picked
}

/** Jev's probabilities as hits: offered cards only, p at least 0.02, most likely first, at most 20. */
export function rankHits(probabilities: Record<string, unknown> | undefined, ids: readonly string[]): { results: WorkSearchHit[]; none: number | null } {
  if (!probabilities || typeof probabilities !== 'object') throw new JevError('jev_bad_answer', 'Jev returned no probabilities')
  const results: WorkSearchHit[] = []
  let none: number | null = null
  for (const [key, raw] of Object.entries(probabilities)) {
    const p = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN
    if (Number.isNaN(p) || p < 0 || p > 1) throw new JevError('jev_bad_answer', 'Jev answered with a probability outside 0 to 1')
    if (key === 'none') { none = round(p); continue }
    const index = /^t(0|[1-9]\d*)$/.test(key) ? Number(key.slice(1)) : -1
    if (index < 0 || index >= ids.length) throw new JevError('jev_bad_answer', 'Jev chose a card that was not offered')
    if (p >= WORK_SEARCH_LIMITS.minP) results.push({ id: ids[index], p: round(p) })
  }
  results.sort((a, b) => b.p - a.p)
  return { results: results.slice(0, WORK_SEARCH_LIMITS.maxResults), none }
}
const round = (n: number) => Math.round(n * 10_000) / 10_000

/** Case, spacing and Unicode form do not change what was asked. */
export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

const PASSED_THROUGH = new Set<string>(['jev_not_configured', 'jev_key_rejected', 'jev_cap_reached', 'jev_breaker_open', 'jev_request_rejected'])

export class WorkSearcher {
  private cache = new Map<string, { at: number; results: WorkSearchHit[]; none: number | null }>()
  private inflight = new Map<string, Promise<WorkSearchResult>>()
  constructor(private readonly jev: JevClient, private readonly now: () => number = () => Date.now()) {}

  /** One Jev Choice over `candidates` (already selected, at most 254). Never throws for a Jev failure. */
  async search(query: string, candidates: readonly SearchableRow[]): Promise<WorkSearchResult> {
    if (candidates.length > WORK_SEARCH_LIMITS.maxCandidates) return unavailable('too_many_candidates')
    if (!candidates.length) return { available: true, results: [], none: 1, cached: false, tokens: 0 }
    const texts = candidates.map(row => searchOptionText(row.text))
    const set = createHash('sha256').update(JSON.stringify(candidates.map((row, i) => [row.id, texts[i]]))).digest('hex')
    const key = createHash('sha256').update(normalizeQuery(query) + '\0' + set).digest('hex')
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < WORK_SEARCH_LIMITS.cacheMs) {
      return { available: true, results: hit.results, none: hit.none, cached: true, tokens: 0 }
    }
    if (hit) this.cache.delete(key)
    // Typing can send the same search twice before the first answers; the second waits for the first.
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.ask(query, candidates.map(row => row.id), texts, key)
    this.inflight.set(key, work)
    try { return await work } finally { this.inflight.delete(key) }
  }

  private async ask(query: string, ids: string[], texts: string[], key: string): Promise<WorkSearchResult> {
    const state = { query: query.trim() }
    const criteria: Record<string, string> = Object.fromEntries(texts.map((text, i) => [`t${i}`, text]))
    criteria.none = WORK_SEARCH_NONE
    const questions = { c: { type: 'choice', instructions: WORK_SEARCH_INSTRUCTIONS, criteria } }
    try {
      const reply = await this.jev.ask(state, questions, estimateJevTokens({ state, questions }))
      const { results, none } = rankHits(reply.answers.c?.probabilities, ids)
      if (this.cache.size >= WORK_SEARCH_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: this.now(), results, none })
      return { available: true, results, none, cached: false, tokens: reply.inputTokens }
    } catch (e) {
      if (!(e instanceof JevError)) throw e
      // Each says what happened. A 400, 413 or 422 is jev_request_rejected: the request itself was refused, which does
      // not count toward the breaker (jev.ts), because the same cards would be refused again and an outage pause would
      // only hide search for every other board. Unreachable, 5xx and a malformed answer are jev_unavailable.
      if (PASSED_THROUGH.has(e.code)) return unavailable(e.code as WorkSearchReason)
      console.warn('[work-search] Jev failed:', e.code)
      return unavailable('jev_unavailable')
    }
  }
}
