export const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9_:-]{1,120}$/
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const ABSOLUTE_PATH = /(^|[\s("'`])(?:~\/|\/(?!\/)(?:[^/\s)"'`]+\/)+[^/\s)"'`]+\/?)/g
const SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:bearer|token|api[_ -]?key)\s*[:=]\s*[A-Za-z0-9._-]{12,})\b/gi

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
  text = text.replace(CONTROL_CHARS, '')
  text = text.replace(ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[local path hidden]`)
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
      const label = record.title ?? record.name ?? record.summary ?? record.content ?? record.path ?? record.url
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
  const meetings = Array.isArray(source.meetings)
    ? source.meetings.slice(0, detail ? 50 : 12).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const meeting = item as Record<string, unknown>
        return [{ name: cleanContextText(meeting.name, 240), date: cleanContextText(meeting.date, 32) }]
      })
    : []
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
