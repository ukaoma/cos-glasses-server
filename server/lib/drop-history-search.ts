/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 6): History search by meaning.
 *
 * The chat's History searches its drops by words at once, on the client. After a pause it asks this for the drop he
 * MEANS: one Jev Choice over the drops' cleaned words and link labels, with `none` as an option, on the work-search
 * pattern (lib/work-search.ts): the same option cleaning, the same ranking, a 10-minute cache and one request per query.
 *
 * Cost and privacy:
 * - Charged to the drop router's own budget (COS_DROP_DAILY_TOKENS, its usage ledger and breaker), through the client
 *   the caller passes in; P1 pins drops to Jev, so the decision provider setting does not apply here either.
 * - Off with the router (COS_DROP_ROUTER=0).
 * - A drop whose words trip the secret check (cleanDropForJev) is never offered: it stays a note, found by words only.
 * - A Choice holds 254 options plus `none`. History can be longer, so the newest 254 are searched and the answer says
 *   `partial` (word search still covers everything) instead of refusing.
 * - Logs hold a count and an error code, never words.
 */
import { createHash } from 'node:crypto'
import type { DecisionClient } from './decision-provider.js'
import { DecisionProviderError } from './decision-provider.js'
import { estimateJevTokens, JevError } from './jev.js'
import { cleanDropForJev, dropRouterEnabled } from './drop-router.js'
import type { DropRecord } from './drop-store.js'
import { normalizeQuery, queryLength, rankHits, searchOptionText, unavailable, WORK_SEARCH_LIMITS, type WorkSearchHit, type WorkSearchReason } from './work-search.js'

export const DROP_SEARCH_INSTRUCTIONS = 'The user typed `query` into the search box of the history of things they jotted down '
  + '(ideas, tasks, notes, reminders). Which entry are they trying to find? Pick the one they mean even when it uses different '
  + 'words, or none if no entry fits.'
export const DROP_SEARCH_NONE = 'None of these entries is what the user is looking for.'

export type DropSearchResult =
  | { available: true; results: WorkSearchHit[]; none: number | null; cached: boolean; tokens: number; searched: number; partial: boolean }
  | { available: false; reason: WorkSearchReason | 'query_invalid'; message: string }

/** What Jev reads for one drop: its words and its link labels, cleaned as work search cleans a card. */
export function dropOptionText(drop: Pick<DropRecord, 'text' | 'links'>): string {
  const labels = drop.links.map(l => l.label).filter(Boolean).join('; ')
  return searchOptionText(labels ? `${drop.text} (${labels})` : drop.text)
}

/** The drops a search covers, newest first: never one that tripped the secret check, never one with no words left. */
export function searchableDrops(drops: readonly DropRecord[]): { rows: Array<{ id: string; text: string }>; total: number } {
  const rows = [...drops]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter(d => d.route?.reason !== 'redacted' && !cleanDropForJev(d.text).tripped)
    .map(d => ({ id: d.id, text: dropOptionText(d) }))
    .filter(r => r.text.length > 0)
  return { rows: rows.slice(0, WORK_SEARCH_LIMITS.maxCandidates), total: rows.length }
}

const PASSED_THROUGH = new Set<string>(['jev_not_configured', 'jev_key_rejected', 'jev_cap_reached', 'jev_breaker_open', 'jev_request_rejected'])

export class DropHistorySearcher {
  private cache = new Map<string, { at: number; results: WorkSearchHit[]; none: number | null; searched: number; partial: boolean }>()
  private inflight = new Map<string, Promise<DropSearchResult>>()
  constructor(private readonly client: DecisionClient, private readonly now: () => number = () => Date.now(), private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Never throws for a Jev failure: it answers `available: false` with one line, and word search carries on. */
  async search(query: unknown, drops: readonly DropRecord[]): Promise<DropSearchResult> {
    if (typeof query !== 'string' || queryLength(query.trim()) < WORK_SEARCH_LIMITS.queryMin || queryLength(query) > WORK_SEARCH_LIMITS.queryMax) {
      return { available: false, reason: 'query_invalid', message: `Type ${WORK_SEARCH_LIMITS.queryMin} to ${WORK_SEARCH_LIMITS.queryMax} characters to search by meaning.` }
    }
    if (!dropRouterEnabled(this.env)) return unavailable('search_off')
    const { rows, total } = searchableDrops(drops)
    const partial = total > rows.length
    if (!rows.length) return { available: true, results: [], none: 1, cached: false, tokens: 0, searched: 0, partial: false }
    const set = createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.text]))).digest('hex')
    const key = createHash('sha256').update(normalizeQuery(query) + '\0' + set).digest('hex')
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < WORK_SEARCH_LIMITS.cacheMs) return { available: true, results: hit.results, none: hit.none, cached: true, tokens: 0, searched: hit.searched, partial: hit.partial }
    if (hit) this.cache.delete(key)
    const running = this.inflight.get(key)
    if (running) return running
    const work = this.ask(query, rows, key, partial)
    this.inflight.set(key, work)
    try { return await work } finally { this.inflight.delete(key) }
  }

  private async ask(query: string, rows: Array<{ id: string; text: string }>, key: string, partial: boolean): Promise<DropSearchResult> {
    const state = { query: query.trim() }
    const criteria: Record<string, string> = Object.fromEntries(rows.map((r, i) => [`t${i}`, r.text]))
    criteria.none = DROP_SEARCH_NONE
    const questions = { c: { type: 'choice', instructions: DROP_SEARCH_INSTRUCTIONS, criteria } }
    try {
      const reply = await this.client.ask(state, questions, estimateJevTokens({ state, questions }))
      const { results, none } = rankHits(reply.answers.c?.probabilities, rows.map(r => r.id))
      if (this.cache.size >= WORK_SEARCH_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: this.now(), results, none, searched: rows.length, partial })
      return { available: true, results, none, cached: false, tokens: reply.inputTokens, searched: rows.length, partial }
    } catch (e) {
      if (e instanceof DecisionProviderError) return unavailable(e.code)
      if (!(e instanceof JevError)) throw e
      if (PASSED_THROUGH.has(e.code)) return unavailable(e.code as WorkSearchReason)
      console.warn('[drop-search] Jev failed:', e.code)
      return unavailable('jev_unavailable')
    }
  }
}
