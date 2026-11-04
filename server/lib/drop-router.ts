/**
 * Drop it router (plan section 2): where one drop goes.
 *
 * Deterministic first, with no Jev call: "remind me" is a reminder, "remember" is a memory, and text ending in "?"
 * or starting with who, what, when, where, why or how is a question for the existing Ask job. Everything else is
 * ONE Jev request with up to six questions (dest, domain, card, thread, session, clear). It files on its own at 0.80
 * with a 0.25 lead (memory needs 0.90); otherwise it asks one question with the top two readings and "Just a note".
 * When Jev cannot run (no key, cap, breaker, switch off, unreachable, a bad answer) the drop is saved as a plain note.
 *
 * Cost controls of its own, copying lib/work-search.ts: a daily input-token cap (COS_DROP_DAILY_TOKENS, default
 * 300,000), its own usage ledger (data/jev-drop-usage.json), its own breaker (jev.ts: 3 failures, then 1 hour), and a
 * kill switch (COS_DROP_ROUTER=0 turns Jev routing off; drops are still saved). Token-audit caller `drop`.
 * Pinned to Jev for P1: the global decision provider setting (SubQ) does not apply, and there is no `drop` decision
 * use case, so no settings file can carry a drop override that 6.99.4 and earlier would refuse to read.
 *
 * Privacy (plan section 8): Jev reads cleaned text only (credentials, URLs, email addresses and opaque ids removed),
 * and a drop whose words trip the secret redactor is never sent at all: it stays a note. Nothing here logs words.
 * There is no claude -p and no generative model anywhere on this path.
 */
import { dataPath } from './data-dir.js'
import { estimateJevTokens, JevClient, JevError } from './jev.js'
import { DecisionProviderError, type DecisionClient } from './decision-provider.js'
import { boundForRedaction, redactSecretText } from './activity-preview.js'
import { redactSecrets } from './lens-gist-engines.js'
import { searchOptionText } from './work-search.js'
import { logTokenAudit } from './token-audit.js'
import type { DropChoice, DropDest } from './drop-store.js'

export const DROP_ROUTER_LIMITS = {
  autoFile: 0.80, lead: 0.25, memory: 0.90, clear: 0.5, target: 0.80,
  cardCandidates: 30, threadCandidates: 15, stateChars: 600, scanChars: 2_400,
  defaultDailyTokens: 300_000,
} as const
export const DROP_USAGE_FILE = dataPath('jev-drop-usage.json')

/** The Jev-routed destinations. Reminder and ask are rule-routed only. */
export const JEV_DESTS = ['new_card', 'existing_card', 'thread', 'memory', 'session', 'note'] as const
export type JevDest = typeof JEV_DESTS[number]
export const DEST_CRITERIA: Record<JevDest, string> = {
  new_card: 'A new task the user means to do: a new card on their Work board.',
  existing_card: 'More detail or an update for one of the user\'s existing Work cards.',
  thread: 'A note that belongs on one of the user\'s ongoing topic threads.',
  memory: 'A lasting fact or preference the assistant should remember for later answers.',
  session: 'A follow-up instruction for the AI work session the user just had open.',
  note: 'A loose note or idea to keep, with nothing else to do.',
}
export const DROP_INSTRUCTIONS = {
  dest: 'The user typed `drop` into a quick capture box. Where should it go?',
  domain: 'Which area of the user\'s work does `drop` belong to?',
  card: 'Which of the user\'s existing Work cards is `drop` about? None if no card fits.',
  thread: 'Which of the user\'s topic threads is `drop` about? None if no thread fits.',
  session: 'Is `drop` an instruction for the AI work session named in `session`?',
  clear: 'Is `drop` a clear, specific statement rather than a rough idea?',
} as const
export const DROP_NONE = { card: 'None of these cards.', thread: 'None of these threads.' } as const

export type DropFallbackReason = 'router_off' | 'redacted' | 'jev_not_configured' | 'jev_key_rejected' | 'jev_cap_reached'
  | 'jev_breaker_open' | 'jev_request_rejected' | 'jev_unavailable' | 'jev_bad_answer' | DecisionProviderError['code']

/** The daily input-token cap for drop routing alone. The ledger day is UTC. */
export function dropDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_DROP_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DROP_ROUTER_LIMITS.defaultDailyTokens
}
/** On unless COS_DROP_ROUTER says off (0, false, no, off). Read from the server's environment at each drop. */
export function dropRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.COS_DROP_ROUTER ?? '').trim().toLowerCase())
}
export function createDropJevClient(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(), usageFile = DROP_USAGE_FILE): JevClient {
  return new JevClient(fetchImpl, now, usageFile, () => dropDailyCap())
}
let sharedClient: JevClient | null = null
export function sharedDropJevClient(): JevClient { return sharedClient ??= createDropJevClient() }
let sharedDecision: DecisionClient | null = null
/** Jev only, whatever the decision provider setting says: a drop never goes to another classifier in P1. */
export function jevOnlyDropClient(jev: Pick<JevClient, 'ask'>): DecisionClient {
  return {
    provider: 'jev',
    async ask(state, questions, estimate, options) {
      if (options?.images?.length) throw new DecisionProviderError('decision_images_unsupported')
      return { ...await jev.ask(state, questions, estimate, options), provider: 'jev' }
    },
  }
}
export function sharedDropDecisionClient(): DecisionClient {
  return sharedDecision ??= jevOnlyDropClient(sharedDropJevClient())
}

// ── Rules ──────────────────────────────────────────────────────────────

const REMIND = /^\s*(?:please\s+|hey\s+cos[,\s]+)?remind\s+me\b/i
const REMEMBER = /^\s*(?:please\s+|hey\s+cos[,\s]+)?remember\b/i
const QUESTION_START = /^\s*(?:who|what|when|where|why|how)\b/i

export type RuleDest = 'reminder' | 'memory' | 'ask'
/** The deterministic routes. Order matters: "remind me what…?" is a reminder, not a question. */
export function ruleRoute(text: string): RuleDest | null {
  if (REMIND.test(text)) return 'reminder'
  if (REMEMBER.test(text)) return 'memory'
  if (/\?\s*$/.test(text) || QUESTION_START.test(text)) return 'ask'
  return null
}

// ── What Jev reads ─────────────────────────────────────────────────────

/**
 * The drop as Jev reads it. `tripped` is true when the server's secret redaction changed the words: such a drop is
 * never sent (plan section 8), it stays a note. URLs, email addresses and opaque ids are removed without tripping:
 * they add nothing to routing.
 */
export function cleanDropForJev(text: string): { text: string; tripped: boolean } {
  const head = boundForRedaction(text, DROP_ROUTER_LIMITS.scanChars).head
  const tripped = redactSecrets(redactSecretText(head)) !== head
  return { text: searchOptionText(head).slice(0, DROP_ROUTER_LIMITS.stateChars), tripped }
}

const STOP = new Set(('the a an and or but for to of in on at by with from into about this that these those it its is are was were be '
  + 'been do does did done have has had will would should could can may might must not no yes our your my me we you they them '
  + 'i he she his her their there here then than so if as up out over just also very more most some any all each new next last '
  + 'get got make made send sent call ask let lets need needs want wants try think idea note today tomorrow week').split(' '))
export function words(text: string): Set<string> {
  return new Set(text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOP.has(w)))
}
/**
 * The candidates worth a token: rows sharing at least one meaningful word with the drop, most shared words first,
 * then the caller's order. A drop that shares no word with any card offers no existing card, and Jev is not asked.
 */
export function rankByOverlap<Row>(drop: string, rows: readonly Row[], text: (row: Row) => string, max: number): Row[] {
  const mine = words(drop)
  if (!mine.size) return []
  return rows.map((row, i) => {
    let score = 0
    for (const w of words(text(row))) if (mine.has(w)) score++
    return { row, i, score }
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).map(r => r.row)
}

export interface DropCard { id: string; workIdentity: string; domain: string; text: string }
export interface DropThread { id: string; name: string }
export interface RouteCandidates {
  domains: Array<{ name: string; label: string }>
  cards: DropCard[]
  threads: DropThread[]
  session?: { id: string; label: string }
}
export interface DropRequest {
  state: Record<string, string>
  questions: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }>
  dests: JevDest[]
  cards: DropCard[]
  threads: DropThread[]
  domains: RouteCandidates['domains']
}

/** One request: only the questions that have something to choose. */
export function buildDropRequest(cleaned: string, candidates: RouteCandidates): DropRequest {
  const cards = candidates.cards.slice(0, DROP_ROUTER_LIMITS.cardCandidates)
  const threads = candidates.threads.slice(0, DROP_ROUTER_LIMITS.threadCandidates)
  const dests = JEV_DESTS.filter(d => (d !== 'new_card' || candidates.domains.length > 0) && (d !== 'existing_card' || cards.length > 0)
    && (d !== 'thread' || threads.length > 0) && (d !== 'session' || !!candidates.session))
  const state: Record<string, string> = { drop: cleaned }
  const questions: DropRequest['questions'] = {
    dest: { type: 'choice', instructions: DROP_INSTRUCTIONS.dest, criteria: Object.fromEntries(dests.map(d => [d, DEST_CRITERIA[d]])) },
  }
  if (candidates.domains.length >= 2) {
    questions.domain = { type: 'choice', instructions: DROP_INSTRUCTIONS.domain,
      criteria: Object.fromEntries(candidates.domains.map((d, i) => [`d${i}`, searchOptionText(d.label) || `Area ${i + 1}`])) }
  }
  if (cards.length) {
    questions.card = { type: 'choice', instructions: DROP_INSTRUCTIONS.card,
      criteria: { ...Object.fromEntries(cards.map((c, i) => [`c${i}`, searchOptionText(c.text) || `Card ${i + 1}`])), none: DROP_NONE.card } }
  }
  if (threads.length) {
    questions.thread = { type: 'choice', instructions: DROP_INSTRUCTIONS.thread,
      criteria: { ...Object.fromEntries(threads.map((t, i) => [`h${i}`, searchOptionText(t.name) || `Thread ${i + 1}`])), none: DROP_NONE.thread } }
  }
  if (candidates.session) {
    state.session = searchOptionText(candidates.session.label) || 'the open session'
    questions.session = { type: 'noul', instructions: DROP_INSTRUCTIONS.session }
  }
  questions.clear = { type: 'noul', instructions: DROP_INSTRUCTIONS.clear }
  return { state, questions, dests, cards, threads, domains: candidates.domains }
}

// ── Deciding ───────────────────────────────────────────────────────────

export interface DropTarget { id: string; label: string; domain?: string }
export type DropDecision =
  | { kind: 'file'; dest: JevDest; target?: DropTarget; p: number; clear: number }
  | { kind: 'ask'; choices: DropChoice[]; p: number; clear: number }

type Answers = Record<string, { probabilities?: Record<string, number>; noul?: number } | undefined>
const probs = (answers: Answers, q: string): Array<[string, number]> => {
  const raw = answers[q]?.probabilities
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw).filter(([, p]) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1).sort((a, b) => b[1] - a[1])
}
const noul = (answers: Answers, q: string): number | null => {
  const v = answers[q]?.noul
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
}
const short = (text: string, max = 60): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Turn Jev's answer into a decision. Thresholds (plan section 2): the top destination files on its own at 0.80 with a
 * 0.25 lead over the next (memory needs 0.90), and only when its target is just as sure (a domain, card or thread
 * at 0.80, the session at 0.80). Otherwise one question: the top two readings that have a target, and Just a note.
 */
export function decideDrop(answers: Answers, request: DropRequest): DropDecision {
  const dest = probs(answers, 'dest').filter(([d]) => (request.dests as string[]).includes(d)) as Array<[JevDest, number]>
  if (!dest.length) throw new JevError('jev_bad_answer', 'Jev returned no destination')
  const clear = noul(answers, 'clear') ?? 0.5
  const targetOf = (d: JevDest, strict: boolean): DropTarget | null | undefined => {
    const need = strict ? DROP_ROUTER_LIMITS.target : 0
    if (d === 'new_card') {
      if (request.domains.length === 1) return { id: request.domains[0].name, label: request.domains[0].label, domain: request.domains[0].name }
      const [top] = probs(answers, 'domain')
      const index = top && /^d\d+$/.test(top[0]) ? Number(top[0].slice(1)) : -1
      return top && top[1] >= need && index >= 0 && index < request.domains.length
        ? { id: request.domains[index].name, label: request.domains[index].label, domain: request.domains[index].name } : null
    }
    if (d === 'existing_card' || d === 'thread') {
      const [top] = probs(answers, d === 'existing_card' ? 'card' : 'thread')
      if (!top || top[0] === 'none' || top[1] < need) return null
      const index = Number(top[0].slice(1))
      if (d === 'existing_card') {
        const card = /^c\d+$/.test(top[0]) ? request.cards[index] : undefined
        return card ? { id: card.workIdentity, label: short(card.text), domain: card.domain } : null
      }
      const thread = /^h\d+$/.test(top[0]) ? request.threads[index] : undefined
      return thread ? { id: thread.id, label: short(thread.name) } : null
    }
    if (d === 'session') {
      const p = noul(answers, 'session')
      return p !== null && p >= need ? { id: '', label: '' } : null
    }
    return undefined  // memory and note need no target
  }
  const [d1, p1] = dest[0], p2 = dest[1]?.[1] ?? 0
  const sure = p1 >= DROP_ROUTER_LIMITS.autoFile && p1 - p2 >= DROP_ROUTER_LIMITS.lead && (d1 !== 'memory' || p1 >= DROP_ROUTER_LIMITS.memory)
  const strictTarget = targetOf(d1, true)
  if (sure && strictTarget !== null) return { kind: 'file', dest: d1, ...(strictTarget && strictTarget.id ? { target: strictTarget } : {}), p: p1, clear }
  const choices: DropChoice[] = []
  for (const [d] of dest) {
    if (d === 'note' || choices.length === 2) continue
    const target = targetOf(d, false)
    if (target === null) continue
    choices.push(choiceFor(d, target && target.id ? target : undefined, `o${choices.length + 1}`))
  }
  if (!choices.length) return { kind: 'file', dest: 'note', p: dest.find(([d]) => d === 'note')?.[1] ?? 0, clear }
  choices.push(choiceFor('note', undefined, 'note'))
  return { kind: 'ask', choices, p: p1, clear }
}

/** The words of one reading, as the mock's question shows it. */
export function choiceFor(dest: DropDest, target: DropTarget | undefined, id: string): DropChoice {
  const t = target ? { target: { id: target.id, label: target.label, ...(target.domain ? { domain: target.domain } : {}) } } : {}
  switch (dest) {
    case 'new_card': return { id, dest, label: 'A task for me', detail: target ? `A card in Work, ${target.label}.` : 'A card in Work.', ...t }
    case 'existing_card': return { id, dest, label: target ? `An update to ${target.label}` : 'An update to a card', detail: 'Linked to that card. No new card.', ...t }
    case 'thread': return { id, dest, label: target ? `A note on ${target.label}` : 'A note on a thread', detail: 'Added to the thread for the next prep. No card.', ...t }
    case 'memory': return { id, dest, label: 'Something to remember', detail: 'Kept in memories, in To review.', ...t }
    case 'session': return { id, dest, label: 'A follow-up for the session', detail: 'Held until you send it to the session.', ...t }
    case 'reminder': return { id, dest, label: 'A reminder', detail: 'COS reminds you.', ...t }
    case 'ask': return { id, dest, label: 'A question', detail: 'COS answers it here.', ...t }
    default: return { id, dest: 'note', label: 'Just a note', detail: 'Kept, nothing else happens.' }
  }
}

// ── The router ─────────────────────────────────────────────────────────

export type RouteOutcome =
  | { by: 'jev'; decision: DropDecision; tokens: number; provider: string }
  | { by: 'fallback'; reason: DropFallbackReason }

export interface DropRouterDeps {
  client: DecisionClient
  enabled: () => boolean
  audit?: (entry: { inputChars: number; tokens: number; durationMs: number; outcome: string }) => void
  now?: () => number
}

const PASSED: ReadonlySet<string> = new Set(['jev_not_configured', 'jev_key_rejected', 'jev_cap_reached', 'jev_breaker_open', 'jev_request_rejected', 'jev_bad_answer'])

export class DropRouter {
  constructor(private readonly deps: DropRouterDeps) {}

  /** One Jev request for one drop. Never throws for a Jev failure: the caller saves a note with the reason. */
  async route(text: string, candidates: RouteCandidates): Promise<RouteOutcome> {
    if (!this.deps.enabled()) return { by: 'fallback', reason: 'router_off' }
    const cleaned = cleanDropForJev(text)
    if (cleaned.tripped || !cleaned.text) return { by: 'fallback', reason: 'redacted' }
    const request = buildDropRequest(cleaned.text, candidates)
    const started = (this.deps.now ?? Date.now)()
    const inputChars = JSON.stringify({ state: request.state, questions: request.questions }).length
    let client: DecisionClient
    try { client = this.deps.client.snapshot?.() ?? this.deps.client } catch (e) {
      if (e instanceof DecisionProviderError) return { by: 'fallback', reason: e.code }
      throw e
    }
    try {
      const reply = await client.ask(request.state, request.questions, estimateJevTokens({ state: request.state, questions: request.questions }))
      const decision = decideDrop(reply.answers, request)
      this.deps.audit?.({ inputChars, tokens: reply.inputTokens, durationMs: (this.deps.now ?? Date.now)() - started, outcome: decision.kind })
      return { by: 'jev', decision, tokens: reply.inputTokens, provider: reply.provider ?? 'jev' }
    } catch (e) {
      if (e instanceof DecisionProviderError) return { by: 'fallback', reason: e.code }
      if (!(e instanceof JevError)) throw e
      return { by: 'fallback', reason: PASSED.has(e.code) ? e.code as DropFallbackReason : 'jev_unavailable' }
    }
  }
}

/** The token-audit row for one routed drop: caller `drop`, sizes and timing only, never words. */
export function auditDropRoute(entry: { inputChars: number; tokens: number; durationMs: number; outcome: string }): void {
  logTokenAudit({ source: 'drop-router', model: 'jev', inputChars: entry.inputChars, outputChars: 0, durationMs: entry.durationMs, caller: 'drop',
    ...(entry.tokens > 0 ? { realUsage: { inputTokens: entry.tokens, outputTokens: 0 } } : {}) })
}

export function createDropRouter(overrides: Partial<DropRouterDeps> = {}): DropRouter {
  return new DropRouter({ client: sharedDropDecisionClient(), enabled: () => dropRouterEnabled(), audit: auditDropRoute, ...overrides })
}
