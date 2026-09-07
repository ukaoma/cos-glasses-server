// `mem_` addresses the vector store, `file_` addresses a note on disk. Two stores,
// one id space, disjoint prefixes — so a reference is never ambiguous about which
// one it means. `.` is permitted because a file id carries its extension; it
// cannot traverse, since `/` is excluded and a bare `..` cannot match the prefix.
export const MEMORY_ID_PATTERN = /^(?:mem|file)_[A-Za-z0-9._:-]{1,120}$/
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/**
 * Filesystem roots. Anchoring to real roots does two jobs at once: it catches the
 * shapes the old pattern missed, and it stops redacting API routes.
 *
 * The old pattern was `(^|[\s("'`])(?:~\/|\/(?!\/)…)`. Three failures, all
 * reproduced against 6.21.35 on the live store before this rewrite:
 *   1. `~\/` had no segment requirement, so `~/.cos-glasses/data/x.json` lost only
 *      the two characters "~/" and shipped the rest to the lens.
 *   2. The leading `(^|[\s("'`])` meant `KEY=/Users/...`, `>/Users/...` and
 *      `,/Users/...` never matched at all.
 *   3. Being root-agnostic, it redacted `/api/context/status` and `/v1/chat/…`
 *      — and that same redacted string is sent to the model as evidence, so a
 *      follow-up about a route lost its subject.
 */
const FS_ROOTS = 'Users|home|root|opt|usr|var|private|tmp|Volumes|etc|Library|System|Applications'
/**
 * Greedy to a hard delimiter, then trimmed back in the replacer. A path may
 * legitimately contain spaces — this machine's own repo root does — and no regex
 * can tell "space inside a path" from "space before the next word", so the
 * boundary decision is made in code where it can be tested.
 */
const ABSOLUTE_PATH = new RegExp(`(?:~|/(?:${FS_ROOTS}))(?:/[^,;)"'\`\r\n]*)?`, 'g')
const UNC_PATH = /\\\\[A-Za-z0-9._-]+\\(?:[^\\\r\n]+\\?)*/g

/**
 * Trim a greedy path match back to its last plausible component.
 *
 * Keeps `…/Ukaoma Chief Of Staff/MU/ops/comp.md` whole (every space is followed by
 * more path) while not swallowing the trailing prose in `/Users/me/x.md here`.
 * A component qualifies if it is followed by a `/` or contains a dot.
 */
function pathMatchEnd(match: string): number {
  const lastSlash = match.lastIndexOf('/')
  if (lastSlash <= 0) return match.length
  const tail = match.slice(lastSlash + 1)
  const space = tail.indexOf(' ')
  // No space in the final component: the whole match is path.
  if (space === -1) return match.length
  // A dotted filename before the space is the end of the path.
  const beforeSpace = tail.slice(0, space)
  return beforeSpace.length > 0 ? lastSlash + 1 + beforeSpace.length : lastSlash
}
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:bearer|token|api[_ -]?key)\s*[:=]\s*[A-Za-z0-9._-]{12,})\b/gi
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g
// 4 OR 5 dashes: SSH2/PuTTY exports use four, and PuTTY uses a bare header line.
const PEM_BLOCK = /-{4,5} ?BEGIN [^-\r\n]*(?:PRIVATE KEY|KEY)[^-\r\n]*-{4,5}[\s\S]*?(?:-{4,5} ?END [^-\r\n]+-{4,5}|$)/g
const PUTTY_KEY = /\bPuTTY-User-Key-File-\d+:.*/g
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
/**
 * Credential prefixes. Every family added here was demonstrated LEAKING against
 * 6.21.35 with a correctly-shaped fabricated value. `pat-` is the one that
 * mattered most: HubSpot PAK rotation is a recurring topic in this store, and
 * `/end-session` writes rotation notes into it.
 */
const PREFIXED_SECRET = new RegExp([
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{30,}',
  'xox[baprsde]-[A-Za-z0-9-]{15,}',      // +d (cookie) +e (refresh)
  'xapp-[A-Za-z0-9-]{15,}',
  'AIza[A-Za-z0-9_-]{20,}',
  'AKIA[A-Z0-9]{16}',
  'ASIA[A-Z0-9]{16}',
  'GOCSPX-[A-Za-z0-9_-]{16,}',
  'npm_[A-Za-z0-9]{30,}',
  '(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}',
  'pat-[a-z0-9]{2,4}-[0-9a-fA-F-]{20,}',
  'glpat-[A-Za-z0-9_-]{16,}',
].join('|'), 'g')
/**
 * AWS secret access keys have no prefix: exactly 40 chars of the base64 alphabet.
 *
 * A `/` or `+` is REQUIRED, which is a deliberate trade-off. Without it, any
 * 40-char alphanumeric run matches — and a SHA-1 hex digest is exactly 40 chars,
 * so every commit sha in this store would be redacted as a credential. The cost
 * is that an all-alphanumeric AWS key is missed; the alternative corrupts far more
 * real evidence than it protects.
 */
const AWS_SECRET_KEY = /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))(?=[A-Za-z0-9]*[/+])[A-Za-z0-9/+]{40}/g
// Username may be EMPTY — `redis://:password@host` defeated the old `+`.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]*:[^\s/@]+@/gi
const QUERY_SECRET = /([?&](?:access_token|api_key|apikey|token|secret|password|key)=)[^&#\s]+/gi
/**
 * Env-style assignments. Added PWD and PASS; requires a value that is not purely
 * numeric, because `MAX_THINKING_TOKENS=31999` is a real setting in this store and
 * redacting it corrupted evidence without protecting anything.
 */
const ENV_SECRET = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|PASS|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*\s*=)\s*(?!\d+\b)[^\s]+/gi
const BEARER_SECRET = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi
const FILE_URI = /\bfile:\/\/(?:localhost)?\/(?:[^\s)"'`]+\/?)+/gi
const LABELED_PATH = /\b(path|file|folder|directory)\s*[:=]\s*(?:~\/|\/(?!\/)[^\s,;)}\]"'`]+)/gi

export interface MemoryRefGroups {
  people?: string[]
  files?: string[]
  meetings?: string[]
  threads?: string[]
}

export interface MemoryListItem {
  id: string
  type: string
  summary: string
  content: string
  created_at: string
  domain: string
  refs: MemoryRefGroups
  reference_available: true
}

export interface ThreadListItem {
  id: string
  name: string
  domain: string
  is_manual: boolean
  topics: string[]
  meeting_count: number
  first_seen: string
  last_seen: string
  velocity: string
  age_days: number
  is_stale: boolean
  is_resolved: boolean
  meetings: Array<{ name: string; date: string }>
  manual_updates: Array<{ content: string; timestamp: string; source: string }>
  stakeholders: string[]
  milestones: string[]
  sources: string[]
  target_date: string
  serves_goal: string
  created_at: string
  created_by: string
  access_count: number
  reference_available: true
}

export function cleanContextText(value: unknown, limit: number): string {
  let text = typeof value === 'string' ? value : value == null ? '' : String(value)
  text = text.slice(0, Math.max(limit, Math.min(64_000, limit * 2)))
  text = text.replace(CONTROL_CHARS, '')
  text = text.replace(PEM_BLOCK, '[secret hidden]')
  text = text.replace(PUTTY_KEY, '[secret hidden]')
  text = text.replace(JWT_TOKEN, '[secret hidden]')
  text = text.replace(PREFIXED_SECRET, '[secret hidden]')
  text = text.replace(URL_CREDENTIALS, '$1[credentials hidden]@')
  text = text.replace(QUERY_SECRET, '$1[secret hidden]')
  text = text.replace(ENV_SECRET, '$1[secret hidden]')
  text = text.replace(BEARER_SECRET, '$1[secret hidden]')
  text = text.replace(FILE_URI, '[local path hidden]')
  text = text.replace(LABELED_PATH, '$1: [local path hidden]')
  text = text.replace(WINDOWS_PATH, '[local path hidden]')
  text = text.replace(UNC_PATH, '[local path hidden]')
  // Trimmed in code, not by the regex: a path may contain spaces, so the greedy
  // match is walked back to its last plausible component.
  text = text.replace(ABSOLUTE_PATH, (match: string) => {
    const end = pathMatchEnd(match)
    return `[local path hidden]${match.slice(end)}`
  })
  // AFTER the path rules, so a 40-char path segment cannot be mistaken for a key.
  text = text.replace(AWS_SECRET_KEY, '[secret hidden]')
  text = text.replace(SECRET_TOKEN, '[secret hidden]')
  return text.trim().slice(0, limit)
}

function finiteInteger(value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(maximum, Math.trunc(number)))
}

function stringList(value: unknown, itemLimit: number, textLimit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, itemLimit).map(item => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      const primary = record.title ?? record.name ?? record.summary ?? record.event ?? record.content
        ?? record.reference ?? record.path ?? record.url
      const label = record.reference && record.content && record.reference !== record.content
        ? `${record.content} (${record.reference})`
        : record.date && record.event ? `${record.event} (${record.date})` : primary
      return cleanContextText(label ?? '', textLimit)
    }
    return cleanContextText(item, textLimit)
  }).filter(Boolean)
}

function memoryRefs(value: unknown): MemoryRefGroups {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const result: MemoryRefGroups = {}
  for (const key of ['people', 'files', 'meetings', 'threads'] as const) {
    const items = stringList(source[key], 12, 160)
    if (items.length) result[key] = items
  }
  return result
}

export function normalizeMemoryList(value: unknown, limit: number): MemoryListItem[] {
  if (!Array.isArray(value)) return []
  const result: MemoryListItem[] = []
  for (const row of value.slice(0, Math.max(0, Math.min(limit, 50)))) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const source = row as Record<string, unknown>
    const id = cleanContextText(source.id, 128)
    if (!MEMORY_ID_PATTERN.test(id)) continue
    result.push({
      id,
      type: cleanContextText(source.type || 'unknown', 48),
      summary: cleanContextText(source.summary || source.content, 240),
      content: cleanContextText(source.content, 1200),
      created_at: cleanContextText(source.created_at, 64),
      domain: cleanContextText(source.domain, 64),
      refs: memoryRefs(source.refs),
      reference_available: true,
    })
  }
  return result
}

export function normalizeMemoryDetail(value: unknown): (MemoryListItem & {
  auto_generated: boolean
  consolidated: boolean
}) | null {
  const rows = normalizeMemoryList(value && typeof value === 'object' ? [value] : [], 1)
  if (!rows[0] || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  return {
    ...rows[0],
    content: cleanContextText(source.content, 32_000),
    auto_generated: source.auto_generated === true,
    consolidated: source.consolidated === true,
  }
}

function normalizeThread(value: unknown, detail: boolean): ThreadListItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = cleanContextText(source.id, 128)
  if (!THREAD_ID_PATTERN.test(id)) return null
  const rawMeetings = Array.isArray(source.meetings) && source.meetings.length
    ? source.meetings
    : Array.isArray(source.linked_meetings) ? source.linked_meetings : []
  const meetings = rawMeetings
    .slice(0, detail ? 50 : 12).flatMap(item => {
        if (typeof item === 'string') {
          const name = cleanContextText(item, 240)
          return name ? [{ name, date: '' }] : []
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const meeting = item as Record<string, unknown>
        const name = cleanContextText(meeting.name ?? meeting.title ?? meeting.id, 240)
        return name ? [{ name, date: cleanContextText(meeting.date, 32) }] : []
      })
  const manualUpdates = Array.isArray(source.manual_updates)
    ? source.manual_updates.slice(0, detail ? 20 : 8).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const update = item as Record<string, unknown>
        return [{
          content: cleanContextText(update.content, detail ? 2000 : 500),
          timestamp: cleanContextText(update.timestamp, 64),
          source: cleanContextText(update.source, 120),
        }]
      })
    : []
  return {
    id,
    name: cleanContextText(source.name || 'Untitled thread', 160),
    domain: cleanContextText(source.domain || 'unknown', 64),
    is_manual: source.is_manual === true,
    topics: stringList(source.topics, detail ? 40 : 12, 160),
    meeting_count: finiteInteger(source.meeting_count, meetings.length, 100_000),
    first_seen: cleanContextText(source.first_seen, 32),
    last_seen: cleanContextText(source.last_seen, 32),
    velocity: cleanContextText(source.velocity, 48),
    age_days: finiteInteger(source.age_days, 0, 1_000_000),
    is_stale: source.is_stale === true,
    is_resolved: source.is_resolved === true,
    meetings,
    manual_updates: manualUpdates,
    stakeholders: stringList(source.stakeholders, detail ? 30 : 12, 160),
    milestones: stringList(source.milestones, detail ? 30 : 8, 500),
    sources: stringList(source.sources, detail ? 30 : 8, 500),
    target_date: cleanContextText(source.target_date, 32),
    serves_goal: cleanContextText(source.serves_goal, 160),
    created_at: cleanContextText(source.created_at, 64),
    created_by: cleanContextText(source.created_by, 120),
    access_count: finiteInteger(source.access_count),
    reference_available: true,
  }
}

export function normalizeThreads(value: unknown, limit: number): {
  generated_at: string
  active_count: number
  stale_count: number
  resolved_count: number
  threads: ThreadListItem[]
} {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const rawThreads = Array.isArray(source.threads) ? source.threads : []
  const threads = rawThreads.slice(0, Math.max(0, Math.min(limit, 50)))
    .map(item => normalizeThread(item, false))
    .filter((item): item is ThreadListItem => item !== null)
  return {
    generated_at: cleanContextText(source.generated_at, 64),
    active_count: finiteInteger(source.active_count),
    stale_count: finiteInteger(source.stale_count),
    resolved_count: finiteInteger(source.resolved_count),
    threads,
  }
}

export function normalizeThreadDetail(value: unknown): ThreadListItem | null {
  return normalizeThread(value, true)
}

export function normalizeMemoryOverview(value: unknown): {
  available: boolean
  collection: 'cos_memory'
  total: number
  by_type: Record<string, number>
  reason?: string
} {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const rawTypes = source.by_type && typeof source.by_type === 'object' && !Array.isArray(source.by_type)
    ? source.by_type as Record<string, unknown>
    : {}
  const byType: Record<string, number> = {}
  for (const [rawKey, rawValue] of Object.entries(rawTypes).slice(0, 24)) {
    const key = cleanContextText(rawKey, 48)
    if (key) byType[key] = finiteInteger(rawValue)
  }
  const result: ReturnType<typeof normalizeMemoryOverview> = {
    available: source.available === true,
    collection: 'cos_memory',
    total: finiteInteger(source.total),
    by_type: byType,
  }
  const reason = cleanContextText(source.reason, 120)
  if (reason) result.reason = reason
  return result
}

export interface ContextBrowserStatus {
  available: boolean
  protocol: number
  state?: string
  /**
   * WHICH tier answered: 'bridge' is a Python/vector pipeline, 'files' is plain
   * markdown on disk. Present so a client can say what it is showing instead of
   * implying a vector store that may not exist. Absent means the field was not
   * supplied, which is every response from a server older than 6.22.0.
   */
  source?: 'bridge' | 'files'
  memory: { available: boolean; total: number; state: string; reason?: string }
  threads: { available: boolean; total: number; active: number; stale: number; resolved: number; state: string; reason?: string }
  /** Recent learning / To review, served by learning_bridge.py since 6.44.5. Absent on older bridges. */
  learning?: LearningBlock
  /** Knowledge graph status, served by learning_bridge.py since 6.44.5. Absent on older bridges. */
  graph?: GraphBlock
}

export interface LearningBlock {
  available: boolean
  state: string
  count?: number
  to_review?: { patterns?: number; task_proposals?: number }
  last_ts?: string
  orphan_decisions?: number
  stores_readable?: number
}

export interface GraphBlock {
  available: boolean
  state: string
  entities?: number
  relationships?: number
  source_updated_at?: string
  index_state?: string
  index_built_at?: string
  queue_pending?: number
  owner_host?: string
  is_owner?: boolean
  replica?: boolean
  processor_state?: string
  lock_state?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * A count is carried ONLY when the bridge sent a clean integer. finiteInteger()
 * would coerce '1', 1.5 and true to a number and default a missing field to 0,
 * which is how an absent block would read as "0 to review".
 */
function integerOrAbsent(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function isoOrAbsent(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const cleaned = cleanContextText(value, 40)
  return Number.isFinite(Date.parse(cleaned)) ? cleaned : undefined
}

function stringOrAbsent(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const cleaned = cleanContextText(value, limit)
  return cleaned || undefined
}

function booleanOrAbsent(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function defined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  return record
}

export function normalizeLearningBlock(value: unknown): LearningBlock | null {
  const source = asRecord(value)
  if (!source) return null
  const review = asRecord(source.to_review)
  const toReview = review ? defined({ patterns: integerOrAbsent(review.patterns), task_proposals: integerOrAbsent(review.task_proposals) }) : undefined
  return defined({
    available: source.available === true,
    state: cleanContextText(source.state, 64) || (source.available === true ? 'ready' : 'unavailable'),
    count: integerOrAbsent(source.count),
    to_review: toReview && Object.keys(toReview).length ? toReview : undefined,
    last_ts: isoOrAbsent(source.last_ts),
    orphan_decisions: integerOrAbsent(source.orphan_decisions),
    stores_readable: integerOrAbsent(source.stores_readable),
  }) as LearningBlock
}

export function normalizeGraphBlock(value: unknown): GraphBlock | null {
  const source = asRecord(value)
  if (!source) return null
  return defined({
    available: source.available === true,
    state: cleanContextText(source.state, 64) || (source.available === true ? 'ready' : 'unavailable'),
    entities: integerOrAbsent(source.entities),
    relationships: integerOrAbsent(source.relationships),
    source_updated_at: isoOrAbsent(source.source_updated_at),
    index_state: stringOrAbsent(source.index_state, 32),
    index_built_at: isoOrAbsent(source.index_built_at),
    queue_pending: integerOrAbsent(source.queue_pending),
    owner_host: stringOrAbsent(source.owner_host, 128),
    is_owner: booleanOrAbsent(source.is_owner),
    replica: booleanOrAbsent(source.replica),
    processor_state: stringOrAbsent(source.processor_state, 32),
    lock_state: stringOrAbsent(source.lock_state, 32),
  }) as GraphBlock
}

// ── Recent learning payloads (GET /context/learning, /context/learning/:id) ──

export const LEARNING_EVENT_ID_PATTERN = /^evt_[a-f0-9]{16}$/
export const LEARNING_EVENT_TYPES = new Set(['captured', 'proposed', 'promotable', 'saved', 'retrieved', 'used', 'checked', 'dismissed', 'reverted', 'reopened', 'consolidated', 'previewed'])
const LEARNING_LIST_LIMIT = 50
/** The strict To review set is small (121 today); one page shows it whole. */
export const LEARNING_REVIEW_LIMIT = 200
const LEARNING_DETAIL_KEYS = ['shape', 'task', 'kind', 'layer', 'date', 'future', 'logged_times', 'memory_type', 'capture', 'source', 'content', 'before', 'after', 'rule', 'status', 'occurrences', 'threshold', 'entry', 'truncated'] as const

export interface LearningEvent {
  event_id: string
  lesson_id: string | null
  event_type: string
  ts: string
  store: string
  title: string
  scope: string
  category: string | null
  engine: string
  target: { kind: string | null; id: string; version: string | null }
  applies_to: Array<{ kind: string; name: string; cadence: string | null; evidence: string }>
  source_refs: Array<{ kind: string; id: string; excerpt: string }>
  prior_event_id: string | null
  outcome: { name: string; result: string; evaluator: string; ts: string | null } | null
  provenance: string
  ordinal?: number
}

function normalizeLearningEvent(value: unknown, excerptLimit: number): LearningEvent | null {
  const source = asRecord(value)
  if (!source || typeof source.event_id !== 'string' || !LEARNING_EVENT_ID_PATTERN.test(source.event_id)) return null
  const eventType = cleanContextText(source.event_type, 32)
  if (!LEARNING_EVENT_TYPES.has(eventType)) return null
  const ts = isoOrAbsent(source.ts)
  if (!ts) return null
  const target = asRecord(source.target) ?? {}
  const outcome = asRecord(source.outcome)
  const appliesTo = Array.isArray(source.applies_to) ? source.applies_to.slice(0, 10).map(asRecord).filter((r): r is Record<string, unknown> => !!r).map(r => ({
    kind: cleanContextText(r.kind, 16), name: cleanContextText(r.name, 160),
    cadence: stringOrAbsent(r.cadence, 120) ?? null, evidence: cleanContextText(r.evidence, 240),
  })) : []
  const refs = Array.isArray(source.source_refs) ? source.source_refs.slice(0, 10).map(asRecord).filter((r): r is Record<string, unknown> => !!r).map(r => ({
    kind: cleanContextText(r.kind, 32), id: cleanContextText(r.id, 200), excerpt: cleanContextText(r.excerpt, excerptLimit),
  })) : []
  const event: LearningEvent = {
    event_id: source.event_id,
    lesson_id: stringOrAbsent(source.lesson_id, 200) ?? null,
    event_type: eventType,
    ts,
    store: cleanContextText(source.store, 40),
    title: cleanContextText(source.title, 160),
    scope: cleanContextText(source.scope, 24) || 'unknown',
    category: stringOrAbsent(source.category, 160) ?? null,
    engine: cleanContextText(source.engine, 24) || 'unknown',
    target: { kind: stringOrAbsent(target.kind, 24) ?? null, id: cleanContextText(target.id, 200), version: stringOrAbsent(target.version, 64) ?? null },
    applies_to: appliesTo,
    source_refs: refs,
    prior_event_id: typeof source.prior_event_id === 'string' && LEARNING_EVENT_ID_PATTERN.test(source.prior_event_id) ? source.prior_event_id : null,
    outcome: outcome ? {
      name: cleanContextText(outcome.name, 160), result: cleanContextText(outcome.result, 24),
      evaluator: cleanContextText(outcome.evaluator, 64), ts: isoOrAbsent(outcome.ts) ?? null,
    } : null,
    provenance: cleanContextText(source.provenance, 24) || 'unavailable',
  }
  const ordinal = integerOrAbsent(source.ordinal)
  if (ordinal !== undefined) event.ordinal = ordinal
  return event
}

export interface LearningCoverage { [store: string]: { state: string; count: number; detail?: string } }

export function normalizeLearningCoverage(value: unknown): LearningCoverage {
  const source = asRecord(value) ?? {}
  const out: LearningCoverage = {}
  for (const [store, raw] of Object.entries(source).slice(0, 16)) {
    const entry = asRecord(raw)
    if (!entry) continue
    const key = cleanContextText(store, 40)
    if (!key) continue
    out[key] = defined({
      state: cleanContextText(entry.state, 32) || 'unavailable',
      count: integerOrAbsent(entry.count) ?? 0,
      detail: stringOrAbsent(entry.detail, 240),
    }) as { state: string; count: number; detail?: string }
  }
  return out
}

export function normalizeLearningEvents(value: unknown, limit: number, max = LEARNING_LIST_LIMIT): {
  events: LearningEvent[]; total: number; next_cursor: { since_ts: string; since_event_id: string } | null; coverage: LearningCoverage
} {
  const source = asRecord(value) ?? {}
  const cap = Math.max(1, Math.min(limit, max))
  const events = (Array.isArray(source.events) ? source.events : []).slice(0, cap)
    .map(item => normalizeLearningEvent(item, 240)).filter((e): e is LearningEvent => !!e)
  const cursor = asRecord(source.next_cursor)
  const sinceTs = cursor ? isoOrAbsent(cursor.since_ts) : undefined
  const sinceId = cursor && typeof cursor.since_event_id === 'string' && LEARNING_EVENT_ID_PATTERN.test(cursor.since_event_id) ? cursor.since_event_id : undefined
  return {
    events,
    total: integerOrAbsent(source.total) ?? events.length,
    next_cursor: sinceTs && sinceId ? { since_ts: sinceTs, since_event_id: sinceId } : null,
    coverage: normalizeLearningCoverage(source.coverage),
    ...(integerOrAbsent(source.review_count) !== undefined ? { review_count: integerOrAbsent(source.review_count) } : {}),
  }
}

export function normalizeLearningEventDetail(value: unknown): (LearningEvent & { detail: Record<string, unknown> }) | null {
  const event = normalizeLearningEvent(value, 1200)
  if (!event) return null
  const raw = asRecord((value as Record<string, unknown>).detail) ?? {}
  const detail: Record<string, unknown> = {}
  for (const key of LEARNING_DETAIL_KEYS) {
    const item = raw[key]
    if (item === undefined || item === null) continue
    if (typeof item === 'boolean') detail[key] = item
    else if (Number.isInteger(item)) detail[key] = item
    else if (typeof item === 'string') detail[key] = cleanContextText(item, 1200)
  }
  if (Array.isArray(raw.bodies)) detail.bodies = raw.bodies.slice(0, 12).map(body => cleanContextText(body, 1200))
  return { ...event, detail }
}

export interface LearningStatus {
  stores: LearningCoverage & { [store: string]: { state: string; count: number; detail?: string; readable?: boolean; last_ts?: string } }
  to_review: { count: number; pattern: number; 'task-proposal': number }
  orphan_decisions: number
  no_store_active: boolean
  engines: string[]
  counts_by_type: Record<string, number>
}

export function normalizeLearningStatus(value: unknown): LearningStatus {
  const source = asRecord(value) ?? {}
  const stores: LearningStatus['stores'] = {}
  for (const [store, raw] of Object.entries(asRecord(source.stores) ?? {}).slice(0, 16)) {
    const entry = asRecord(raw)
    const key = cleanContextText(store, 40)
    if (!entry || !key) continue
    stores[key] = defined({
      state: cleanContextText(entry.state, 32) || 'unavailable',
      count: integerOrAbsent(entry.count) ?? 0,
      readable: booleanOrAbsent(entry.readable),
      last_ts: isoOrAbsent(entry.last_ts),
    }) as LearningStatus['stores'][string]
  }
  const review = asRecord(source.to_review) ?? {}
  const counts: Record<string, number> = {}
  for (const [type, raw] of Object.entries(asRecord(source.counts_by_type) ?? {})) {
    if (LEARNING_EVENT_TYPES.has(type) && Number.isInteger(raw)) counts[type] = raw as number
  }
  return {
    stores,
    to_review: { count: integerOrAbsent(review.count) ?? 0, pattern: integerOrAbsent(review.pattern) ?? 0, 'task-proposal': integerOrAbsent(review['task-proposal']) ?? 0 },
    orphan_decisions: integerOrAbsent(source.orphan_decisions) ?? 0,
    no_store_active: source.no_store_active === true,
    engines: stringList(source.engines, 8, 24),
    counts_by_type: counts,
  }
}

// ── Knowledge graph payloads (GET /context/graph/*) ──

export const GRAPH_ENTITY_ID_LIMIT = 200
export const GRAPH_INDEX_STATES = new Set(['fresh', 'stale', 'missing', 'source_missing'])

export function normalizeIndexReceipt(value: unknown): Record<string, unknown> | null {
  const source = asRecord(value)
  if (!source) return null
  return defined({
    state: stringOrAbsent(source.state, 16) ?? null,
    started_at: isoOrAbsent(source.started_at) ?? null,
    ended_at: isoOrAbsent(source.ended_at) ?? null,
    pid: integerOrAbsent(source.pid) ?? null,
    host: stringOrAbsent(source.host, 128) ?? null,
    reason: stringOrAbsent(source.reason, 64) ?? null,
    error: stringOrAbsent(source.error, 240) ?? null,
    wall_s: typeof source.wall_s === 'number' && Number.isFinite(source.wall_s) ? source.wall_s : null,
    peak_rss_mb: typeof source.peak_rss_mb === 'number' && Number.isFinite(source.peak_rss_mb) ? source.peak_rss_mb : null,
    node_count: integerOrAbsent(source.node_count) ?? null,
    edge_count: integerOrAbsent(source.edge_count) ?? null,
    build_seq: integerOrAbsent(source.build_seq) ?? null,
    degraded: source.degraded === true,
  })
}

export function normalizeGraphStatus(value: unknown): Record<string, unknown> {
  const source = asRecord(value) ?? {}
  const src = asRecord(source.source) ?? {}
  const queue = asRecord(source.queue) ?? {}
  const budget = asRecord(source.budget) ?? {}
  const lock = asRecord(source.lock) ?? {}
  const processor = asRecord(source.processor) ?? {}
  const indexState = stringOrAbsent(source.index_state, 32)
  return {
    entities: integerOrAbsent(source.entities) ?? null,
    relationships: integerOrAbsent(source.relationships) ?? null,
    source_updated_at: isoOrAbsent(source.source_updated_at) ?? null,
    index_built_at: isoOrAbsent(source.index_built_at) ?? null,
    index_state: indexState && GRAPH_INDEX_STATES.has(indexState) ? indexState : 'missing',
    index_degraded: source.index_degraded === true,
    build: normalizeIndexReceipt(source.build),
    source: {
      owner_host: stringOrAbsent(src.owner_host, 128) ?? null,
      this_host: stringOrAbsent(src.this_host, 128) ?? null,
      is_owner: src.is_owner === true,
      owner_state: stringOrAbsent(src.owner_state, 16) ?? 'unset',
      replica: src.replica === true,
      source_sha256_prefix: stringOrAbsent(src.source_sha256_prefix, 16) ?? null,
      index_built_on_host: stringOrAbsent(src.index_built_on_host, 128) ?? null,
      index_host_mismatch: src.index_host_mismatch === true,
    },
    queue: {
      live_total: integerOrAbsent(queue.live_total) ?? null,
      pending: integerOrAbsent(queue.pending) ?? null,
      failed: integerOrAbsent(queue.failed) ?? null,
      deferred: integerOrAbsent(queue.deferred) ?? null,
      oldest_pending_at: isoOrAbsent(queue.oldest_pending_at) ?? null,
      oldest_pending_age_s: integerOrAbsent(queue.oldest_pending_age_s) ?? null,
      missing_sources: integerOrAbsent(queue.missing_sources) ?? null,
      conflict_copies: integerOrAbsent(queue.conflict_copies) ?? null,
    },
    budget: { used: integerOrAbsent(budget.used) ?? null, cap: integerOrAbsent(budget.cap) ?? null },
    lock: { state: stringOrAbsent(lock.state, 16) ?? 'unknown', owner_pid: integerOrAbsent(lock.owner_pid) ?? null, error: stringOrAbsent(lock.error, 64) ?? null },
    last_run: normalizeIndexReceipt(source.last_run),
    processor: {
      state: stringOrAbsent(processor.state, 24) ?? 'none',
      plist: processor.plist === true,
      cadence_s: integerOrAbsent(processor.cadence_s) ?? null,
      last_run_at: isoOrAbsent(processor.last_run_at) ?? null,
      last_outcome: stringOrAbsent(processor.last_outcome, 24) ?? null,
    },
  }
}

export function normalizeGraphSearch(value: unknown, limit: number): Record<string, unknown> {
  const source = asRecord(value) ?? {}
  const items = (Array.isArray(source.items) ? source.items : []).slice(0, Math.max(1, Math.min(limit, 30))).map(asRecord)
    .filter((r): r is Record<string, unknown> => !!r && typeof r.id === 'string')
    .map(r => ({ id: cleanContextText(r.id, GRAPH_ENTITY_ID_LIMIT), type: stringOrAbsent(r.type, 40) ?? null, degree: integerOrAbsent(r.degree) ?? 0, description: cleanContextText(r.description, 240) }))
  return {
    items,
    total: integerOrAbsent(source.total) ?? items.length,
    scope: stringOrAbsent(source.scope, 32) ?? 'full-index',
    index_built_at: isoOrAbsent(source.index_built_at) ?? null,
    index_state: stringOrAbsent(source.index_state, 32) ?? 'missing',
    matcher: stringOrAbsent(source.matcher, 16) ?? null,
    window: integerOrAbsent(source.window) ?? null,
    offset: integerOrAbsent(source.offset) ?? 0,
    limit: integerOrAbsent(source.limit) ?? items.length,
  }
}

export function normalizeGraphEntity(value: unknown): Record<string, unknown> | null {
  const source = asRecord(value)
  if (!source || source.found !== true || typeof source.id !== 'string') return null
  const edges = (Array.isArray(source.edges) ? source.edges : []).slice(0, 30).map(asRecord).filter((r): r is Record<string, unknown> => !!r).map(r => ({
    source: cleanContextText(r.source, GRAPH_ENTITY_ID_LIMIT), target: cleanContextText(r.target, GRAPH_ENTITY_ID_LIMIT),
    weight: typeof r.weight === 'number' && Number.isFinite(r.weight) ? r.weight : null, description: cleanContextText(r.description, 240),
  }))
  const neighbors = (Array.isArray(source.neighbors) ? source.neighbors : []).slice(0, 30).map(asRecord).filter((r): r is Record<string, unknown> => !!r).map(r => ({
    id: cleanContextText(r.id, GRAPH_ENTITY_ID_LIMIT), type: stringOrAbsent(r.type, 40) ?? null, degree: integerOrAbsent(r.degree) ?? 0,
  }))
  return {
    found: true,
    id: cleanContextText(source.id, GRAPH_ENTITY_ID_LIMIT),
    type: stringOrAbsent(source.type, 40) ?? null,
    degree: integerOrAbsent(source.degree) ?? 0,
    description: cleanContextText(source.description, 1200),
    description_length: integerOrAbsent(source.description_length) ?? null,
    descriptions: stringList(source.descriptions, 12, 1200),
    created_at: integerOrAbsent(source.created_at) ?? null,
    first_seen_build: integerOrAbsent(source.first_seen_build) ?? null,
    edges, neighbors,
    total_relationships: integerOrAbsent(source.total_relationships) ?? edges.length,
    offset: integerOrAbsent(source.offset) ?? 0,
    limit: integerOrAbsent(source.limit) ?? edges.length,
    source_status: stringOrAbsent(source.source_status, 16) ?? 'unresolved',
    source_count: integerOrAbsent(source.source_count) ?? 0,
    source_resolved: integerOrAbsent(source.source_resolved) ?? 0,
    index_built_at: isoOrAbsent(source.index_built_at) ?? null,
    index_state: stringOrAbsent(source.index_state, 32) ?? 'missing',
  }
}

export function normalizeGraphPassages(value: unknown): Record<string, unknown> {
  const source = asRecord(value) ?? {}
  const items = (Array.isArray(source.items) ? source.items : []).slice(0, 5).map(asRecord).filter((r): r is Record<string, unknown> => !!r).map(r => {
    const src = asRecord(r.source) ?? {}
    return {
      chunk_id: cleanContextText(r.chunk_id, 80), doc_id: stringOrAbsent(r.doc_id, 80) ?? null,
      order: integerOrAbsent(r.order) ?? null, excerpt: cleanContextText(r.excerpt, 1200),
      source: {
        status: stringOrAbsent(src.status, 16) ?? 'unresolved', key: stringOrAbsent(src.key, 200) ?? null,
        title: stringOrAbsent(src.title, 200) ?? null, date: stringOrAbsent(src.date, 40) ?? null, summary: stringOrAbsent(src.summary, 120) ?? null,
      },
    }
  })
  return {
    items,
    total: integerOrAbsent(source.total) ?? items.length,
    index_state: stringOrAbsent(source.index_state, 32) ?? null,
    index_built_at: isoOrAbsent(source.index_built_at) ?? null,
    fallback: stringOrAbsent(source.fallback, 24) ?? null,
    unavailable: stringList(source.unavailable, 8, 64),
    note: stringOrAbsent(source.note, 240) ?? null,
  }
}

/** The review decision the bridge wrote back: lesson, decision, stamp, id, who. */
export function normalizeReviewDecision(value: unknown): Record<string, unknown> | null {
  const source = asRecord(value)
  const row = asRecord(source?.decision)
  if (!row) return null
  const decision = stringOrAbsent(row.decision, 16)
  const lessonId = stringOrAbsent(row.lesson_id, 200)
  if (!lessonId || (decision !== 'dismissed' && decision !== 'reopened')) return null
  return {
    lesson_id: lessonId,
    decision,
    ts: isoOrAbsent(row.ts) ?? null,
    event_id: LEARNING_EVENT_ID_PATTERN.test(String(row.event_id ?? '')) ? String(row.event_id) : null,
    by: stringOrAbsent(row.by, 32) ?? null,
  }
}

export function normalizeIndexBuildKickoff(value: unknown): { started: boolean; already_running: boolean; pid: number | null; receipt: Record<string, unknown> | null } {
  const source = asRecord(value) ?? {}
  return {
    started: source.started === true,
    already_running: source.already_running === true,
    pid: integerOrAbsent(source.pid) ?? null,
    receipt: normalizeIndexReceipt(source.receipt),
  }
}

export const INGEST_LIMIT_DEFAULT = 10
export const INGEST_LIMIT_MAX = 50

export interface IngestKickoff {
  started: boolean
  already_running: boolean
  nothing_pending: boolean
  budget_exhausted: boolean
  pid: number | null
  limit: number | null
  pending: number | null
  lock: { state: string; owner_pid: number | null } | null
  budget: { used: number; cap: number } | null
}

/** The bridge's `graph-ingest-start` answer, every flag a real boolean. */
export function normalizeIngestKickoff(value: unknown): IngestKickoff {
  const source = asRecord(value) ?? {}
  const lock = asRecord(source.lock)
  const budget = asRecord(source.budget)
  return {
    started: source.started === true,
    already_running: source.already_running === true,
    nothing_pending: source.nothing_pending === true,
    budget_exhausted: source.budget_exhausted === true,
    pid: integerOrAbsent(source.pid) ?? null,
    limit: integerOrAbsent(source.limit) ?? null,
    pending: integerOrAbsent(source.pending) ?? null,
    lock: lock ? { state: stringOrAbsent(lock.state, 16) ?? 'unknown', owner_pid: integerOrAbsent(lock.owner_pid) ?? null } : null,
    budget: budget && integerOrAbsent(budget.used) !== undefined && integerOrAbsent(budget.cap) !== undefined
      ? { used: integerOrAbsent(budget.used)!, cap: integerOrAbsent(budget.cap)! } : null,
  }
}

export const KNOWLEDGE_SETUP_SAMPLE_MAX = 3

/**
 * A folder or file path the user chose for the setup path. Unlike
 * `stringOrAbsent`, which hides local paths from surfaces that must not leak
 * them, this keeps the path: COS Control shows it back to the person who
 * picked it, on the Mac it lives on.
 */
function chosenPathOrAbsent(value: unknown, max = 1000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined
}
export const KNOWLEDGE_ASK_MAX_CHARS = 400

export interface KnowledgeSetupCheck { id: string; ok: boolean; detail: string }
export interface KnowledgeSetupSource { path: string; enabled: boolean; exists: boolean; files: number | null; added_at: string | null }

/** `graph-setup-status`: the checklist behind the Knowledge setup path. */
export function normalizeKnowledgeSetup(value: unknown): Record<string, unknown> {
  const s = asRecord(value) ?? {}
  const owner = asRecord(s.owner) ?? {}
  const queue = asRecord(s.queue) ?? {}
  const graph = asRecord(s.graph) ?? {}
  const budget = asRecord(s.budget) ?? {}
  const schedule = asRecord(s.schedule) ?? {}
  const sample = asRecord(s.sample) ?? {}
  const checks: KnowledgeSetupCheck[] = (Array.isArray(s.checks) ? s.checks : []).flatMap((row) => {
    const r = asRecord(row); if (!r) return []
    const id = stringOrAbsent(r.id, 40); if (!id) return []
    return [{ id, ok: r.ok === true, detail: stringOrAbsent(r.detail, 400) ?? '' }]
  })
  return {
    ready: checks.length > 0 && checks.every(c => c.ok),
    checks,
    owner: {
      owner_host: stringOrAbsent(owner.owner_host, 120) ?? null,
      this_host: stringOrAbsent(owner.this_host, 120) ?? null,
      is_owner: owner.is_owner === true,
      source: stringOrAbsent(owner.source, 16) ?? 'none',
    },
    sources: normalizeKnowledgeSources(s.sources),
    queue: { pending: integerOrAbsent(queue.pending) ?? null, indexed: integerOrAbsent(queue.indexed) ?? null },
    graph: { entities: integerOrAbsent(graph.entities) ?? null, relationships: integerOrAbsent(graph.relationships) ?? null },
    budget: { used: integerOrAbsent(budget.used) ?? null, cap: integerOrAbsent(budget.cap) ?? null },
    schedule: { installed: schedule.installed === true, interval_s: integerOrAbsent(schedule.interval_s) ?? null, plist: chosenPathOrAbsent(schedule.plist, 400) ?? null },
    sample: {
      candidates: (Array.isArray(sample.candidates) ? sample.candidates : []).flatMap((row) => {
        const r = asRecord(row); const path = r ? chosenPathOrAbsent(r.path) : undefined
        return path ? [{ path, bytes: integerOrAbsent(r!.bytes) ?? null }] : []
      }).slice(0, KNOWLEDGE_SETUP_SAMPLE_MAX),
      queued: integerOrAbsent(sample.queued) ?? 0,
      indexed: integerOrAbsent(sample.indexed) ?? 0,
    },
    lock: normalizeIngestKickoff({ lock: s.lock }).lock,
    ask_ready: s.ask_ready === true,
    protocol: integerOrAbsent(s.protocol) ?? null,
  }
}

export function normalizeKnowledgeSources(value: unknown): KnowledgeSetupSource[] {
  return (Array.isArray(value) ? value : []).flatMap((row) => {
    const r = asRecord(row); if (!r) return []
    const path = chosenPathOrAbsent(r.path); if (!path) return []
    return [{ path, enabled: r.enabled !== false, exists: r.exists !== false, files: integerOrAbsent(r.files) ?? null, added_at: isoOrAbsent(r.added_at) ?? null }]
  })
}

/** `graph-ingest-sample`: what was queued, what was not, and whether a run started. */
export function normalizeSampleKickoff(value: unknown): Record<string, unknown> {
  const s = asRecord(value) ?? {}
  const rows = (key: string, extra: string) => (Array.isArray(s[key]) ? (s[key] as unknown[]) : []).flatMap((row) => {
    const r = asRecord(row); const path = r ? chosenPathOrAbsent(r.path) : undefined
    return path ? [{ path, [extra]: stringOrAbsent(r![extra], 200) ?? null }] : []
  })
  return { ...normalizeIngestKickoff(s), queued: rows('queued', 'id'), skipped: rows('skipped', 'reason') }
}

/** `graph-ask`: one answer from the graph, bounded. */
export function normalizeGraphAnswer(value: unknown): { question: string; mode: string; answer: string; elapsed_s: number | null } | null {
  const s = asRecord(value) ?? {}
  const answer = typeof s.answer === 'string' ? s.answer.slice(0, 20_000) : null
  if (answer === null) return null
  return { question: stringOrAbsent(s.question, KNOWLEDGE_ASK_MAX_CHARS) ?? '', mode: stringOrAbsent(s.mode, 16) ?? 'hybrid', answer, elapsed_s: typeof s.elapsed_s === 'number' && Number.isFinite(s.elapsed_s) ? s.elapsed_s : null }
}

export function normalizeContextBrowserStatus(value: unknown): ContextBrowserStatus {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const memory = source.memory && typeof source.memory === 'object' && !Array.isArray(source.memory)
    ? source.memory as Record<string, unknown> : {}
  const threads = source.threads && typeof source.threads === 'object' && !Array.isArray(source.threads)
    ? source.threads as Record<string, unknown> : {}
  const cleanState = (candidate: unknown, fallback: string) => cleanContextText(candidate, 64) || fallback
  // STRICT and PRE-COERCION. finiteInteger() does Math.trunc(Number(v)), so
  // 6.21.35 turned '1', 1.5, 1.9, true and [1] all into 1 and served them as
  // compatible — and rewrote the reported field to 1, so Control could not even
  // see what it had been handed. The changelog claimed the opposite.
  const protocolCompatible = source.protocol === 1
  // Report the RAW value when it is a clean integer, else 0. Truncating 1.5 to 1
  // is what let an incompatible bridge look compatible in Control's own display.
  const protocol = protocolCompatible
    ? 1
    : (Number.isInteger(source.protocol) ? source.protocol as number : 0)
  const memoryAvailable = protocolCompatible && memory.available === true
  const threadsAvailable = protocolCompatible && threads.available === true
  const incompatibleState = protocolCompatible ? '' : 'bridge_outdated'
  const memoryState = incompatibleState || cleanState(memory.state, memoryAvailable ? 'ready' : 'unavailable')
  const threadState = incompatibleState || cleanState(threads.state, threadsAvailable ? 'ready' : 'unavailable')
  // The learning and graph blocks (6.44.5) sit behind the SAME protocol gate; an
  // absent block stays absent so the two toEqual pins on older payloads hold.
  const learning = protocolCompatible ? normalizeLearningBlock(source.learning) : null
  const graph = protocolCompatible ? normalizeGraphBlock(source.graph) : null
  return {
    available: protocolCompatible && source.available === true,
    protocol,
    ...(!protocolCompatible
      ? { state: 'bridge_outdated' }
      : source.state ? { state: cleanState(source.state, 'unavailable') } : {}),
    // Allowlisted, not passed through: an unrecognised value would let a future
    // or hostile payload put arbitrary text on a surface a client renders.
    ...(protocolCompatible && (source.source === 'bridge' || source.source === 'files')
      ? { source: source.source }
      : {}),
    memory: {
      available: memoryAvailable,
      total: memoryAvailable ? finiteInteger(memory.total) : 0,
      state: memoryState,
      ...(!protocolCompatible
        ? { reason: 'bridge_outdated' }
        : memory.reason ? { reason: cleanState(memory.reason, memoryState) } : {}),
    },
    threads: {
      available: threadsAvailable,
      total: threadsAvailable ? finiteInteger(threads.total) : 0,
      active: threadsAvailable ? finiteInteger(threads.active) : 0,
      stale: threadsAvailable ? finiteInteger(threads.stale) : 0,
      resolved: threadsAvailable ? finiteInteger(threads.resolved) : 0,
      state: threadState,
      ...(!protocolCompatible
        ? { reason: 'bridge_outdated' }
        : threads.reason ? { reason: cleanState(threads.reason, threadState) } : {}),
    },
    ...(learning ? { learning } : {}),
    ...(graph ? { graph } : {}),
  }
}
