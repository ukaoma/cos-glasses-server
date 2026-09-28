/**
 * Which of the user's agent sessions should take a Work task: Continue one already doing it, Fork one that shares
 * its context (same deliverable, page, module, codebase or client thread) but is doing different work, or start a
 * New session. Jev answers two choice questions over the sessions in one request; the thresholds below were
 * checked on Miles's live sessions on 2026-09-28 (a 1:1 task went New, a server bug Continued its server session at
 * 0.91, a hardware-page task Forked the hardware session). A recommendation is advice: nothing is selected or sent.
 */
import { createHash } from 'node:crypto'
import { estimateJevTokens, JevError, type JevClient } from './jev.js'

export const CONTINUE_AT = 0.5  // P(a session is already doing this exact task)
export const FORK_AT = 0.6      // P(some session shares the context) = 1 - P(none)
export const RECOMMENDATION_LIMITS = { sessions: 80, title: 120, summary: 240, cacheMs: 30 * 60_000, cacheEntries: 200 } as const

export interface CandidateSession { id: string; provider: string; title: string; summary?: string; updated?: string }
export interface RecommendationInput { task: { text: string; domain: string; meetings: string[] }; sessions: CandidateSession[] }
export type Recommendation =
  | { provider: 'jev'; model: string; action: 'continue' | 'fork' | 'new'; sessionId: string | null; confidence: number; reason: string;
      alternatives: Array<{ sessionId: string; p: number }>; cached: boolean }
  | { provider: 'none'; reason: string }

const BEST = "Which one of the user's agent sessions is the natural place to do the work in `task`: the session already working on the "
  + 'same deliverable, page, module, codebase or client thread, so continuing or forking it saves re-explaining context? '
  + 'Choose none if no session works on the same deliverable, page, module, codebase or client thread.'
const EXACT = "Which one of the user's agent sessions is already doing this exact task, so the work should simply continue there? "
  + 'A session on the same project doing different work does not count. Choose none if no session is doing this task.'

const clip = (text: string | undefined, max: number) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const round = (n: number) => Math.round(n * 100) / 100

function ranked(probabilities: Record<string, number> | undefined, offered: Set<string>): Array<[string, number]> {
  const rows = Object.entries(probabilities ?? {}).filter(([k]) => k !== 'none')
  if (rows.some(([k]) => !offered.has(k))) throw new JevError('jev_bad_answer', 'Jev chose a session that was not offered')
  return rows.map(([k, v]) => [k, Number(v) || 0] as [string, number]).sort((a, b) => b[1] - a[1])
}

/** Pure policy over Jev's two answers. Exported for tests. */
export function decide(best: Record<string, number>, exact: Record<string, number>, sessions: CandidateSession[]):
    Omit<Extract<Recommendation, { provider: 'jev' }>, 'provider' | 'model' | 'cached'> {
  const offered = new Set(sessions.map((_, i) => `s${i}`))
  const bestRank = ranked(best, offered), exactRank = ranked(exact, offered)
  const idOf = (key: string) => sessions[Number(key.slice(1))].id
  const alternatives = bestRank.slice(0, 3).filter(([, p]) => p > 0).map(([k, p]) => ({ sessionId: idOf(k), p: round(p) }))
  const [exactKey, exactP] = exactRank[0] ?? ['', 0]
  if (exactKey && exactP >= CONTINUE_AT) {
    return { action: 'continue', sessionId: idOf(exactKey), confidence: round(exactP), reason: 'Already doing this task.', alternatives }
  }
  const covered = 1 - (Number(best.none) || 0)
  const [bestKey] = bestRank[0] ?? ['']
  if (bestKey && covered >= FORK_AT) {
    return { action: 'fork', sessionId: idOf(bestKey), confidence: round(covered),
      reason: 'Shares this work’s context (same deliverable, page, module or thread) but is doing different work.', alternatives }
  }
  return { action: 'new', sessionId: null, confidence: round(1 - covered), reason: 'No existing session shares this work’s context.', alternatives }
}

/** Validate what the client sends. Sessions are candidates only: the task text always comes from the board. */
export function parseCandidates(raw: unknown): CandidateSession[] | null {
  if (!Array.isArray(raw) || raw.length > RECOMMENDATION_LIMITS.sessions) return null
  const seen = new Set<string>(), out: CandidateSession[] = []
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 200 || seen.has(r.id)) return null
    if (typeof r.title !== 'string' || !clip(r.title, RECOMMENDATION_LIMITS.title)) return null
    seen.add(r.id)
    out.push({ id: r.id, provider: clip(typeof r.provider === 'string' ? r.provider : 'agent', 20), title: clip(r.title, RECOMMENDATION_LIMITS.title),
      summary: clip(typeof r.summary === 'string' ? r.summary : '', RECOMMENDATION_LIMITS.summary), updated: clip(typeof r.updated === 'string' ? r.updated : '', 10) })
  }
  return out
}

export class SessionRecommender {
  private cache = new Map<string, { at: number; value: Extract<Recommendation, { provider: 'jev' }> }>()
  constructor(private readonly jev: JevClient, private readonly now: () => number = () => Date.now()) {}

  async recommend(input: RecommendationInput): Promise<Recommendation> {
    const sessions = input.sessions
    if (!sessions.length) return { provider: 'none', reason: 'no_sessions' }
    const key = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < RECOMMENDATION_LIMITS.cacheMs) return { ...hit.value, cached: true }
    const state = { task: { text: clip(input.task.text, 1200), domain: input.task.domain, meetings: input.task.meetings.map(t => clip(t, 160)).slice(0, 8) },
      sessions: sessions.map((s, i) => ({ i, provider: s.provider, title: s.title, summary: s.summary, updated: s.updated })) }
    const options = Object.fromEntries(sessions.map((s, i) => [`s${i}`, `sessions[${i}]: ${clip(s.title, 100)}`]))
    const questions = {
      best: { type: 'choice', criteria: { ...options, none: 'No listed session shares this work’s context.' }, instructions: BEST },
      exact: { type: 'choice', criteria: { ...options, none: 'No listed session is doing this task.' }, instructions: EXACT },
    }
    try {
      const reply = await this.jev.ask(state, questions, estimateJevTokens({ state, questions }))
      const best = reply.answers.best?.probabilities, exact = reply.answers.exact?.probabilities
      if (!best || !exact) throw new JevError('jev_bad_answer')
      const value = { provider: 'jev' as const, model: reply.model ?? 'jev', cached: false, ...decide(best, exact, sessions) }
      if (this.cache.size >= RECOMMENDATION_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: this.now(), value })
      return value
    } catch (e) {
      if (e instanceof JevError) return { provider: 'none', reason: e.code }
      throw e
    }
  }
}
