export const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9_:-]{1,120}$/
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
  memory: { available: boolean; total: number; state: string; reason?: string }
  threads: { available: boolean; total: number; active: number; stale: number; resolved: number; state: string; reason?: string }
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
  return {
    available: protocolCompatible && source.available === true,
    protocol,
    ...(!protocolCompatible
      ? { state: 'bridge_outdated' }
      : source.state ? { state: cleanState(source.state, 'unavailable') } : {}),
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
  }
}
