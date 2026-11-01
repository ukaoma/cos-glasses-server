/**
 * Find a session by meaning (Control 0.5.363): `POST /api/agent-sessions/find`.
 *
 * Control's command panel sends what the person typed. This reads the Mac's own session store (never client text), shows a
 * decision model each session's title and the first 150 characters of its first prompt, and answers the few sessions that
 * model thinks were meant, with how sure it is. What it does and why it is shaped this way:
 *   - session-find-collect.ts: the pool (newest 254, or 508 when the first 254 do not settle it), its filters and its memo.
 *   - session-find-redact.ts: read, redact, then cut every string that leaves the Mac, and every string handed back.
 *   - session-find-ask.ts: the Choice, the merge, the yes/no view, the floors and bands.
 *
 * WHAT LEAVES THE MAC. Per search: the redacted words typed, plus a redacted title and first-prompt excerpt of up to 508
 * recent sessions, to the person's selected decision provider (Settings > Decision models, the `search` setting, no fallback
 * to the other provider). Nothing leaves before the person has consented for THAT provider: the body names the provider they
 * consented to, and a mismatch with the provider selected now is refused before any session is read.
 *
 * COST CONTROLS, separate from Work search, Work intake and session advice (so one runaway cannot spend another's budget):
 * its own Jev ledger and SubQ ledger (session-find-jev-usage.json, session-find-subq-usage.json), a daily input-token cap
 * of 3,000,000 for each (COS_SESSION_FIND_DAILY_TOKENS), each provider's own breaker (3 failures, then an hour), and a switch
 * (COS_SESSION_FIND=0 turns it off; the value is read at boot like COS_JEV_SEARCH). The ledger day is UTC.
 *
 * It is also gated on the Sessions feature (COS_CLAUDE_SESSIONS_ENABLED=1), which is off by default on the published package:
 * a person who never turned sessions on never sees a session leave their Mac.
 */
import { dataPath } from './data-dir.js'
import { JevClient, JevError } from './jev.js'
import {
  DecisionProviderError, SubqDecisionClient, createDecisionClient, selectedDecisionProvider, type DecisionClient, type DecisionProvider,
} from './decision-provider.js'
import { resolveJevKey } from './jev.js'
import { resolveSubqKey } from './subq-key.js'
import { isAbortError, sharedSessionFindCollector, type FindCandidate, type SessionFindCollector } from './session-find-collect.js'
import { FIND_CHOICE_OPTIONS, SessionFindAsker, type AskCandidate, type FindStrength } from './session-find-ask.js'
import { candidateTexts, redactQuery } from './session-find-redact.js'
import { agentSessionRoots, type AgentSessionRoots } from './agent-session-store.js'
import { listKeyedSessionsStrict } from './keyed-sessions.js'

export const SESSION_FIND_LIMITS = {
  /** After redaction, in code points. Control sends three or more words; a shorter redacted query is not worth a model call. */
  queryMin: 3,
  /** Bytes of JSON-string a query may arrive as, before anything reads it. The 200 code point cap is applied to the redacted words. */
  queryRawMax: 2_000,
  defaultDailyTokens: 3_000_000,
} as const
export const SESSION_FIND_JEV_USAGE_FILE = dataPath('session-find-jev-usage.json')
export const SESSION_FIND_SUBQ_USAGE_FILE = dataPath('session-find-subq-usage.json')

export type SessionFindReason =
  | 'consent_required' | 'provider_changed' | 'decision_not_configured' | 'jev_not_configured' | 'sessions_off' | 'find_off'
  | 'cap_reached' | 'breaker_open' | 'query_too_short' | 'failed'
export const SESSION_FIND_MESSAGES: Record<SessionFindReason, string> = {
  consent_required: 'Meaning search needs your okay before it sends anything. Turn it on in Settings.',
  provider_changed: 'The decision model changed since you agreed. Agree again for the new one in Settings.',
  decision_not_configured: 'Meaning search needs an API key for the selected decision model. Add one in Settings.',
  jev_not_configured: 'Meaning search needs a TypeSafe key. Add one in Settings.',
  sessions_off: 'Sessions are turned off on this server, so there is nothing to search.',
  find_off: 'Meaning search is turned off on this server.',
  cap_reached: 'Meaning search has used today’s budget. It resets at midnight UTC.',
  breaker_open: 'Meaning search is paused for an hour after repeated failures.',
  query_too_short: 'Type a few more words to search by meaning.',
  failed: 'Meaning search could not answer this time.',
}

/** The daily input-token cap for session find alone, per provider ledger. The ledger day is UTC. */
export function sessionFindDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_SESSION_FIND_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SESSION_FIND_LIMITS.defaultDailyTokens
}

/** On unless COS_SESSION_FIND says off (0, false, no, off). Fixed when the server starts, like COS_JEV_SEARCH. */
export function sessionFindEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.COS_SESSION_FIND ?? '').trim().toLowerCase())
}

/**
 * Whether this server can find sessions by meaning at all: the Sessions feature is on and the switch is not off. This is what
 * `capabilities.sessionFind` on GET /api/decision-provider reports, so Control never offers a consent it cannot honour.
 * The Sessions test is claudeSessionsEnabled() in routes/claude-sessions.ts (a test holds the two together; that module is
 * not imported here because it pulls in the whole registry).
 */
export function sessionFindAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_CLAUDE_SESSIONS_ENABLED === '1' && sessionFindEnabled(env)
}

/**
 * API POSTs that only read, for the mutation lease (index.ts). Finding a session reads the session store and asks a model;
 * it writes only its own token ledger. Under the lease a drain for an update would wait for a search that can take a few
 * seconds, and the helper's own deadline is shorter than the lease's. Its own predicate, not isReadOnlyApiPost's list: that
 * list differs between the public and the private line, and a pinned test holds its single call site.
 */
export function isSessionFindPost(method: string, path: string): boolean {
  return method === 'POST' && path === '/agent-sessions/find'
}

/** Session find's own Jev client: its own ledger, cap and breaker. jev.ts supplies the key and the timeout. */
export function createSessionFindJevClient(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(),
                                           usageFile = SESSION_FIND_JEV_USAGE_FILE, cap: () => number = () => sessionFindDailyCap()): JevClient {
  return new JevClient(fetchImpl, now, usageFile, cap)
}
let sharedJev: JevClient | null = null
/** One per process: it owns this feature's Jev breaker. Saving a new Jev key resets it (routes/jev.ts). */
export function sharedSessionFindJevClient(): JevClient { return sharedJev ??= createSessionFindJevClient() }

/** The selected provider's client for this feature: Jev on its own client, SubQ on its own ledger and cap. */
export function createSessionFindDecisionClient(jev: Pick<JevClient, 'ask'> = sharedSessionFindJevClient(), env: NodeJS.ProcessEnv = process.env,
                                                subqUsageFile = SESSION_FIND_SUBQ_USAGE_FILE, cap: () => number = () => sessionFindDailyCap(env)): DecisionClient {
  return createDecisionClient('search', jev, env, { usageFile: subqUsageFile, cap })
}
let sharedDecision: DecisionClient | null = null
export function sharedSessionFindDecisionClient(): DecisionClient { return sharedDecision ??= createSessionFindDecisionClient() }

export interface SessionFindRequest {
  query: string
  /** The provider the person agreed to send to, or null for "not agreed". */
  consentedProvider: DecisionProvider | null
  stage: 'first' | 'full'
}

export interface SessionFindRow {
  session_id: string
  provider: 'claude' | 'codex' | 'cursor'
  slug: string
  custom_title: string
  display_label: string
  first_prompt: string
  discussion_summary: string
  project: string
  created: string
  modified: string
  duration_minutes: number
  message_count: number
  domain: string
  device_id: string
  machine_spawned: boolean
  alive: boolean
  state: 'recent'
  pinned: boolean
  last_activity_at: string
  judged_text: string
  probability: number
  strength: FindStrength
  compressed: boolean
}

export interface SessionFindAnswer {
  available: boolean
  reason: SessionFindReason | null
  message: string
  provider: DecisionProvider | null
  /** True when the provider is documented to keep what it is sent (SubQ). False says nothing about TypeSafe, whose retention is not documented. */
  storesData: boolean
  rows: SessionFindRow[]
  /** Sessions a model was asked about. */
  asked: number
  /** The oldest time among them (their last record), or null. */
  reachedBack: string | null
  /** Compressed Codex files this server could not read, so they were not asked about. */
  skipped: number
  /** No model was called for this answer. */
  cached: boolean
  /** On `cap_reached`: when that provider's ledger next resets. On `breaker_open`: when the breaker reopens. ISO 8601 UTC; absent when not known. */
  resetsAt?: string
}

export function unavailableAnswer(reason: SessionFindReason, provider: DecisionProvider | null = null, resetsAt?: string): SessionFindAnswer {
  return { available: false, reason, message: SESSION_FIND_MESSAGES[reason], provider, storesData: provider === 'subq', rows: [], asked: 0, reachedBack: null, skipped: 0, cached: false, ...(resetsAt ? { resetsAt } : {}) }
}

/**
 * When a cap or a pause ends, read from the clients' own bookkeeping and never guessed. Both ledgers (JevClient `today()`, SubqDecisionClient
 * `day()`) key a day by `now.toISOString().slice(0, 10)`, so a cap clears at the next UTC midnight of the client's clock. A breaker opens until
 * the client's `breakerOpenUntil` (Jev reports it as an ISO string, SubQ as epoch milliseconds). Unknown stays undefined.
 */
export function resetsAtFor(reason: SessionFindReason, client: DecisionClient, provider: DecisionProvider, jev: JevClient | null, nowMs: number): string | undefined {
  if (reason === 'cap_reached') {
    const day = new Date(nowMs)
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString()
  }
  if (reason !== 'breaker_open') return undefined
  let until: number | null = null
  if (provider === 'subq') { if (client instanceof SubqDecisionClient) until = client.status().breakerOpenUntil }
  else if (jev) { const iso = jev.status().breakerOpenUntil; until = iso ? Date.parse(iso) : null }
  return until !== null && Number.isFinite(until) && until > nowMs ? new Date(until).toISOString() : undefined
}

/** Every failure a model or its ledger can raise, as one of the contract's reasons. Anything not named is `failed`. */
export function reasonFor(error: unknown): SessionFindReason {
  if (error instanceof DecisionProviderError) {
    if (error.code === 'decision_cap_reached') return 'cap_reached'
    if (error.code === 'decision_breaker_open') return 'breaker_open'
    if (error.code === 'decision_not_configured') return 'decision_not_configured'
    return 'failed'
  }
  if (error instanceof JevError) {
    if (error.code === 'jev_cap_reached') return 'cap_reached'
    if (error.code === 'jev_breaker_open') return 'breaker_open'
    if (error.code === 'jev_not_configured') return 'jev_not_configured'
    return 'failed'
  }
  return 'failed'
}

export interface SessionFindDependencies {
  collector: Pick<SessionFindCollector, 'collect'>
  asker: Pick<SessionFindAsker, 'ask'>
  decision: DecisionClient
  roots: () => AgentSessionRoots
  keyedIds: () => ReadonlySet<string>
  available: () => { find: boolean; sessions: boolean }
  /** The provider the person has selected for the `search` setting. Throws DecisionProviderError when the setting is invalid. */
  selected: () => DecisionProvider
  configured: (provider: DecisionProvider) => boolean
  /** Cap or breaker already reached for this provider, known without sending anything. */
  capacity: (client: DecisionClient, provider: DecisionProvider, jev: JevClient | null) => 'cap_reached' | 'breaker_open' | null
  jev: JevClient | null
  chunkSize?: number
  now?: () => number
}

/**
 * Cap and breaker, read from the two clients' own status. SubQ's status reads an unreadable ledger as the cap reached. Jev's reads
 * a missing or unreadable ledger as 0 used (jev.ts usedToday), so this check cannot catch one; the client's own write would.
 */
export function clientCapacity(client: DecisionClient, provider: DecisionProvider, jev: JevClient | null): 'cap_reached' | 'breaker_open' | null {
  if (provider === 'subq') {
    if (!(client instanceof SubqDecisionClient)) return null
    const status = client.status()
    if (status.breakerOpenUntil) return 'breaker_open'
    return status.usedToday >= status.dailyCap ? 'cap_reached' : null
  }
  if (!jev) return null
  const status = jev.status()
  if (status.breakerOpenUntil) return 'breaker_open'
  return status.usedToday >= status.dailyCap ? 'cap_reached' : null
}

export function defaultSessionFindDependencies(): SessionFindDependencies {
  return {
    collector: sharedSessionFindCollector(),
    asker: new SessionFindAsker(),
    decision: sharedSessionFindDecisionClient(),
    roots: () => agentSessionRoots(),
    // Strict: a damaged keyed-sessions file must fail the search (reported as `failed`), not read as no keyed sessions.
    keyedIds: () => new Set(listKeyedSessionsStrict().map(record => record.id.toLowerCase())),
    available: () => ({ find: sessionFindEnabled(), sessions: process.env.COS_CLAUDE_SESSIONS_ENABLED === '1' }),
    selected: () => selectedDecisionProvider('search'),
    configured: provider => provider === 'subq' ? !!resolveSubqKey() : !!resolveJevKey(),
    capacity: clientCapacity,
    jev: sharedSessionFindJevClient(),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export class SessionFinder {
  constructor(private readonly deps: SessionFindDependencies = defaultSessionFindDependencies()) {}

  /**
   * Never throws for a model or ledger failure: those are answers with a reason. A thrown AbortError means the caller went
   * away; the route does not answer it.
   */
  async find(request: SessionFindRequest, signal: AbortSignal): Promise<SessionFindAnswer> {
    const { deps } = this
    const live = deps.available()
    if (!live.find) return unavailableAnswer('find_off')
    if (!live.sessions) return unavailableAnswer('sessions_off')

    // Everything below that can refuse does so before a single session is read or a single byte is sent.
    let provider: DecisionProvider
    try { provider = deps.selected() } catch { return unavailableAnswer('failed') }
    if (!request.consentedProvider) return unavailableAnswer('consent_required', provider)
    if (request.consentedProvider !== provider) return unavailableAnswer('provider_changed', provider)
    const query = redactQuery(request.query)
    if (Array.from(query).length < SESSION_FIND_LIMITS.queryMin) return unavailableAnswer('query_too_short', provider)
    if (!deps.configured(provider)) return unavailableAnswer(provider === 'jev' ? 'jev_not_configured' : 'decision_not_configured', provider)
    let client: DecisionClient
    try { client = deps.decision.snapshot?.() ?? deps.decision } catch (error) { return unavailableAnswer(reasonFor(error), provider) }
    // The snapshot is the provider this whole search uses. A settings change between the two reads above and this one is refused.
    if ((client.provider ?? 'jev') !== provider) return unavailableAnswer('provider_changed', provider)
    const full = deps.capacity(client, provider, deps.jev)
    if (full) return unavailableAnswer(full, provider, resetsAtFor(full, client, provider, deps.jev, (deps.now ?? Date.now)()))

    try {
      const roots = deps.roots()
      // Inside the try: an unreadable keyed-sessions file is a failed search, never an empty set (keyed text must not leave).
      const keyedIds = deps.keyedIds()
      const chunk = Math.min(deps.chunkSize ?? FIND_CHOICE_OPTIONS, FIND_CHOICE_OPTIONS)
      const firstPool = await deps.collector.collect({ roots, limit: chunk, keyedIds, signal })
      const byKey = new Map<string, FindCandidate & { judged: string }>()
      const toAsk = (pool: readonly FindCandidate[]): AskCandidate[] => {
        const out: AskCandidate[] = []
        for (const candidate of pool) {
          if (byKey.has(candidate.key)) continue
          const { option, prompt } = candidateTexts(candidate.title, candidate.typed)
          // A session whose words all redact away has nothing a model could judge it by.
          if (!option) continue
          byKey.set(candidate.key, { ...candidate, judged: prompt })
          out.push({ key: candidate.key, option, clockMs: candidate.clockMs })
        }
        return out
      }
      const first = toAsk(firstPool.candidates)
      let skipped = firstPool.skippedNoDecoder + firstPool.skippedUnreadable
      const outcome = await deps.asker.ask({
        client, query, stage: request.stage, first, chunkSize: chunk,
        shouldStop: () => signal.aborted,
        second: async () => {
          const wider = await deps.collector.collect({ roots, limit: chunk * 2, keyedIds, signal })
          skipped = Math.max(skipped, wider.skippedNoDecoder + wider.skippedUnreadable)
          return toAsk(wider.candidates)
        },
      })
      if (outcome.stopped) throw abortLike()
      const rows: SessionFindRow[] = []
      for (const row of outcome.rows) {
        const candidate = byKey.get(row.key)
        if (!candidate) continue
        rows.push(toRow(candidate, row.probability, row.strength))
      }
      return {
        available: true, reason: null, message: '', provider, storesData: provider === 'subq', rows,
        asked: outcome.asked.length, reachedBack: outcome.asked.length ? iso(Math.min(...outcome.asked.map(c => c.clockMs))) : null,
        skipped, cached: outcome.cached,
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      const reason = reasonFor(error)
      return unavailableAnswer(reason, provider, resetsAtFor(reason, client, provider, deps.jev, (deps.now ?? Date.now)()))
    }
  }
}

function abortLike(): Error { const e = new Error('cancelled'); e.name = 'AbortError'; return e }

/** The list's session fields (routes/agent-sessions.ts toEntry), without live state, plus what this search adds. */
function toRow(candidate: FindCandidate & { judged: string }, probability: number, strength: FindStrength): SessionFindRow {
  const title = candidate.title
  return {
    session_id: candidate.session_id, provider: candidate.provider, slug: candidate.session_id,
    custom_title: title, display_label: title, first_prompt: candidate.listFirstLine || title, discussion_summary: '',
    project: candidate.project, created: candidate.created, modified: iso(candidate.mtimeMs),
    duration_minutes: 0, message_count: 0, domain: '', device_id: candidate.provider, machine_spawned: false,
    alive: false, state: 'recent', pinned: false,
    last_activity_at: iso(candidate.clockMs), judged_text: candidate.judged, probability, strength, compressed: candidate.compressed,
  }
}
