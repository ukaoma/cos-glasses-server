/**
 * Optional COS operations meeting library.
 *
 * When configured, G2 "Review Meetings" reads markdown from a COS-style tree:
 *   {operationsDir}/{domain}/meetings/YYYY-MM/*.md
 *
 * Read resolution accepts COS_MEETINGS_ROOT as a direct YYYY-MM library.
 * Write/enrichment resolution remains COS_OPERATIONS_DIR, a legacy
 * multi-domain COS_MEETINGS_ROOT, then COS_SCRIPTS_DIR/...
 *
 * Standalone installs leave all of these unset and keep using MeetingStore
 * (~/.cos-glasses/data/recordings).
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { discoveredDomains, domainAbbreviation as deriveAbbr, isSafeDomainName as safeName } from './domains.js'
import type { MeetingDetail, MeetingMeta } from './meeting-store.js'
import { MEETING_SOURCE_MAX_BYTES, meetingDayCountsFromNames, meetingListLimit } from './meeting-store.js'

/**
 * The four domains of ONE user's COS. Retained as the documented example layout
 * and as test material — never as the set this module will accept.
 */
export const EXAMPLE_MEETING_DOMAINS = ['quilt', 'sprocket_rocket', 'hermit_crabs', 'personal'] as const

/**
 * Domain resolution, safe-name checks and badges have exactly ONE definition
 * each, in `domains.ts`, shared with the meeting store and mirrored by the
 * Control picker. Re-exported because this module's callers import them.
 */
export { domainAbbreviation, isSafeDomainName } from './domains.js'

/** Immediate subdirectories of `operationsDir` holding a `meetings/` tree. */
export function discoverMeetingDomains(operationsDir: string): string[] {
  return discoveredDomains(operationsDir)
}

const DETAIL_CHUNK_ESTIMATE_CHARS = 1700

export type CosOperationsMeetingMeta = MeetingMeta & { time?: string }

export type MeetingLibraryLayout = 'direct' | 'multi_domain' | 'standalone' | 'invalid_explicit_root'

export interface MeetingLibraryInspection {
  layout: MeetingLibraryLayout
  root: string | null
  rootFingerprint: string | null
  meetingCount: number
  warnings: string[]
  domains: string[]
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const MAX_LIST_CANDIDATES = 2_000
const MAX_LIST_FILE_BYTES = 100_000
const MAX_DETAIL_FILE_BYTES = 10 * 1024 * 1024

function rootFingerprint(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

function safeRoot(path: string): string | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    return realpathSync(path)
  } catch { return null }
}

function safeChildDirectory(parentReal: string, path: string): string | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    const real = realpathSync(path)
    return dirname(real) === parentReal ? real : null
  } catch { return null }
}

function safeRegularFile(parentReal: string, path: string, maxBytes = MAX_LIST_FILE_BYTES): string | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null
    const real = realpathSync(path)
    if (dirname(real) !== parentReal) return null
    return readFileSync(real, 'utf8')
  } catch { return null }
}

function safeBoundedRegularFile(parentReal: string, path: string, maxReadBytes: number): { content: string; truncated: boolean } | null {
  let fd: number | null = null
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DETAIL_FILE_BYTES) return null
    const real = realpathSync(path)
    if (dirname(real) !== parentReal) return null
    fd = openSync(real, 'r')
    const buffer = Buffer.alloc(Math.min(maxReadBytes, stat.size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return { content: buffer.subarray(0, read).toString('utf8'), truncated: stat.size > read }
  } catch { return null }
  finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
  }
}

export function inspectMeetingLibraryPath(path: string): MeetingLibraryInspection {
  const requested = resolve(path)
  const root = safeRoot(requested)
  if (!root) {
    return { layout: 'invalid_explicit_root', root: null, rootFingerprint: null, meetingCount: 0, warnings: ['folder is missing, unreadable, or unsafe'], domains: [] }
  }
  const entries = (() => { try { return readdirSync(root) } catch { return [] } })()
  const directMonths = entries.filter(name => MONTH_PATTERN.test(name) && safeChildDirectory(root, join(root, name))).sort()
  const domains = entries.filter(safeName).filter(name => {
    const domainReal = safeChildDirectory(root, join(root, name))
    if (!domainReal) return false
    return safeChildDirectory(domainReal, join(domainReal, 'meetings')) != null
  }).sort()
  const warnings: string[] = []
  if (directMonths.length > 0 && domains.length > 0) {
    return { layout: 'invalid_explicit_root', root, rootFingerprint: rootFingerprint(root), meetingCount: 0, warnings: ['folder mixes direct months and domain/meetings trees'], domains }
  }
  const layout: MeetingLibraryLayout = directMonths.length > 0 ? 'direct' : domains.length > 0 ? 'multi_domain' : 'invalid_explicit_root'
  if (layout === 'invalid_explicit_root') {
    const nearMisses = entries.filter(safeName).filter(name => {
      const child = safeChildDirectory(root, join(root, name))
      if (!child) return false
      try {
        return readdirSync(child).some(entry => MONTH_PATTERN.test(entry) && safeChildDirectory(child, join(child, entry)))
      } catch { return false }
    })
    warnings.push(nearMisses.length > 0
      ? `missing meetings/ inside: ${nearMisses.slice(0, 6).join(', ')}`
      : 'expected YYYY-MM folders or <domain>/meetings/YYYY-MM')
  }
  return { layout, root, rootFingerprint: rootFingerprint(root), meetingCount: 0, warnings, domains }
}

/** Enough to clear the sidecar's leading metadata keys whatever their order. */
const SIDECAR_HEAD_BYTES = 4096

/**
 * The sessionId recorded in a meeting's chunk sidecar, if it has one.
 *
 * Carried on the list so a Control row can open the per-meeting speaker review,
 * which is keyed on the session rather than the filename.
 *
 * Reads only the head. A sidecar for a 32-minute meeting is ~1.3 MB, so reading
 * them whole would make listing cost scale with total transcript size — and this
 * lister already reads every markdown file it finds.
 */
export function sidecarSessionId(monthDir: string, meetingFilename: string): string | undefined {
  const sidecarName = meetingFilename.replace(/\.md$/, '.g2-chunks.json')
  if (sidecarName === meetingFilename) return undefined
  const path = join(monthDir, sidecarName)
  let fd: number | null = null
  try {
    const linkStat = lstatSync(path)
    if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size === 0) return undefined
    const real = realpathSync(path)
    if (dirname(real) !== realpathSync(monthDir)) return undefined
    const stat = statSync(real)
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(Math.min(SIDECAR_HEAD_BYTES, stat.size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const match = buffer.subarray(0, read).toString('utf8')
      .match(/"sessionId"\s*:\s*"([A-Za-z0-9:_-]{3,96})"/)
    return match ? match[1] : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
  }
}

function envPath(name: string): string | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  return resolve(raw)
}

/** Resolve the COS operations directory, or null in standalone mode.
 * Reads process.env on each call so tests and Control env updates stay live. */
export function resolveCosOperationsDir(): string | null {
  const operations = envPath('COS_OPERATIONS_DIR')
  if (operations && inspectMeetingLibraryPath(operations).layout === 'multi_domain') return safeRoot(operations)
  // Backward compatibility: before 6.21.33 COS_MEETINGS_ROOT was documented as
  // an alias for COS_OPERATIONS_DIR. Preserve that meaning only for a real
  // multi-domain tree; a direct library is never a write destination.
  const legacy = envPath('COS_MEETINGS_ROOT')
  if (legacy && inspectMeetingLibraryPath(legacy).layout === 'multi_domain') return safeRoot(legacy)
  const scriptsDir = envPath('COS_SCRIPTS_DIR')
  if (scriptsDir) {
    const inferred = resolve(scriptsDir, '..')
    if (inspectMeetingLibraryPath(inferred).layout === 'multi_domain') return safeRoot(inferred)
  }
  return null
}

export function cosOperationsMeetingsConfigured(): boolean {
  return resolveCosOperationsDir() != null
}

export function resolveMeetingLibrary(): MeetingLibraryInspection {
  const explicit = envPath('COS_MEETINGS_ROOT')
  if (explicit) return inspectMeetingLibraryPath(explicit)
  const operations = resolveCosOperationsDir()
  if (operations) return inspectMeetingLibraryPath(operations)
  return { layout: 'standalone', root: null, rootFingerprint: null, meetingCount: 0, warnings: [], domains: [] }
}

export function meetingLibraryConfigured(): boolean {
  const layout = resolveMeetingLibrary().layout
  return layout === 'direct' || layout === 'multi_domain'
}

function boundedMeetingSource(content: string): { sourceContent: string; sourceTruncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length <= MEETING_SOURCE_MAX_BYTES) return { sourceContent: content, sourceTruncated: false }
  let end = MEETING_SOURCE_MAX_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return { sourceContent: bytes.subarray(0, end).toString('utf8'), sourceTruncated: true }
}

function parseDurationMinutes(duration: string): number | undefined {
  if (!duration) return undefined
  const normalized = duration.toLowerCase()
  const colonMatch = normalized.match(/\b(\d+):(\d{2})\b/)
  if (colonMatch) return Number(colonMatch[1]) * 60 + Number(colonMatch[2])

  let total = 0
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/)
  if (hourMatch) total += Math.round(Number(hourMatch[1]) * 60)

  const minuteMatch = normalized.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/)
  if (minuteMatch) total += Number(minuteMatch[1])

  if (total > 0) return total

  const bareNumber = normalized.match(/^\s*(\d+)\s*$/)
  return bareNumber ? Number(bareNumber[1]) : undefined
}

function normalizeMeetingTime(hourText: string, minuteText: string, meridiemText = ''): string | undefined {
  let hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  const meridiem = meridiemText.trim().toUpperCase()
  if (meridiem) {
    if (hour < 1 || hour > 12 || !['AM', 'PM'].includes(meridiem)) return undefined
    if (meridiem === 'AM' && hour === 12) hour = 0
    if (meridiem === 'PM' && hour !== 12) hour += 12
  } else if (hour < 0 || hour > 23) {
    return undefined
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function extractMeetingDateTime(content: string, filename: string): { date: string; time?: string } {
  const metadata = content.match(/\*\*Date(?::)?\*\*\s*(?:\|\s*)?((?:19|20)\d{2}-\d{2}-\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?:\s*([AP]M))?)?/i)
  if (metadata) {
    const time = metadata[2] && metadata[3]
      ? normalizeMeetingTime(metadata[2], metadata[3], metadata[4])
      : undefined
    return { date: metadata[1], ...(time ? { time } : {}) }
  }

  const g2 = filename.match(/_((?:19|20)\d{2}-\d{2}-\d{2})_(\d{2})(\d{2})(?:\D|$)/)
  if (g2) {
    const time = normalizeMeetingTime(g2[2], g2[3])
    return { date: g2[1], ...(time ? { time } : {}) }
  }

  const dateMatch = filename.match(/^((?:19|20)\d{2}-\d{2}-\d{2})/)
  return { date: dateMatch ? dateMatch[1] : 'unknown' }
}

export function compareMeetingsNewestFirst(a: CosOperationsMeetingMeta, b: CosOperationsMeetingMeta): number {
  const aKey = `${a.date || '0000-00-00'}T${a.time || '00:00'}`
  const bKey = `${b.date || '0000-00-00'}T${b.time || '00:00'}`
  return bKey.localeCompare(aKey)
    || b.filename.localeCompare(a.filename)
    || b.domain.localeCompare(a.domain)
}

export function matchRenamedMeetingFilename(
  requestedFilename: string,
  candidates: Array<{ filename: string; content: string }>,
): string | undefined {
  const requested = extractMeetingDateTime('', requestedFilename)
  if (requested.date === 'unknown' || !requested.time) return undefined
  const matches = candidates.filter(candidate => {
    const timestamp = extractMeetingDateTime(candidate.content, candidate.filename)
    return timestamp.date === requested.date && timestamp.time === requested.time
  })
  return matches.length === 1 ? matches[0].filename : undefined
}

function parseMeetingMeta(content: string, filename: string, domain: string): CosOperationsMeetingMeta {
  const name = basename(filename, '.md')
  const titleMatch = content.match(/^#\s+(.+)$/m)
  let title: string
  if (titleMatch) {
    title = titleMatch[1].trim()
  } else {
    const parts = name.split('_').slice(1)
    title = parts.join(' ').slice(0, 50)
  }

  const { date, time } = extractMeetingDateTime(content, filename)
  const sourceMatch = content.match(/\*\*Source\*\*\s*\|\s*(.+)/i)
    || content.match(/\*\*Source:\*\*\s*(.+)/i)
  const source = sourceMatch ? sourceMatch[1].replace(/\s*\|?\s*$/, '').trim() : ''

  const durationMatch = content.match(/\*\*Duration\*\*\s*\|\s*(.+)/i)
    || content.match(/\*\*Duration:\*\*\s*(.+)/i)
  const duration = durationMatch ? durationMatch[1].replace(/\s*\|?\s*$/, '').trim() : ''
  const durationMinutes = parseDurationMinutes(duration)

  return {
    filename,
    title: title || 'Untitled Meeting',
    date,
    ...(time ? { time } : {}),
    domain,
    domainAbbr: deriveAbbr(domain),
    source,
    duration,
    durationMinutes,
    month: '',
  }
}

function extractSummary(content: string): string {
  const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n##|\n$|$)/)
  if (summaryMatch) return summaryMatch[1].trim().slice(0, 2000)
  return ''
}

function extractTopics(content: string): string[] {
  const topicsMatch = content.match(/## Topics Discussed\s*\n([\s\S]*?)(?=\n##|\n$|$)/)
  if (!topicsMatch) return []
  return topicsMatch[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

function extractActionItems(content: string): Array<{ task: string; owner: string }> {
  const actionsMatch = content.match(/## (?:Action Items|Tasks|Next Steps)\s*\n([\s\S]*?)(?=\n##|\n$|$)/)
  if (!actionsMatch) return []
  return actionsMatch[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*') || l.trim().match(/^\[/))
    .map(l => {
      const cleaned = l.replace(/^[-*]\s*/, '').replace(/^\[.\]\s*/, '').replace(/`\[REVIEW\]`\s*/i, '').trim()
      const ownerMatch = cleaned.match(/\(\*\*(.+?)\*\*\)\s*$/)
      const owner = ownerMatch ? ownerMatch[1] : ''
      const task = ownerMatch ? cleaned.replace(ownerMatch[0], '').trim() : cleaned
      return { task, owner }
    })
    .filter(i => i.task.length > 0)
    .slice(0, 15)
}

function extractDecisions(content: string): string[] {
  const match = content.match(/## Decisions(?: Made)?\s*\n([\s\S]*?)(?=\n##|\n$|$)/)
  if (!match) return []
  return match[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

function extractAttendees(content: string): string[] {
  const match = content.match(/## Attendees\s*\n([\s\S]*?)(?=\n##|\n$|$)/)
  if (!match) return []
  return match[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
    .map(l => {
      const cleaned = l.replace(/^[-*]\s*/, '').trim()
      const nameMatch = cleaned.match(/^\*\*(.+?)\*\*/) || cleaned.match(/^([^(]+)/)
      return nameMatch ? nameMatch[1].trim() : cleaned
    })
    .filter(Boolean)
    .slice(0, 20)
}

function withMeetingListInsights(meta: CosOperationsMeetingMeta, content: string): CosOperationsMeetingMeta {
  const summary = extractSummary(content)
  const topics = extractTopics(content)
  const decisions = extractDecisions(content)
  const actionItems = extractActionItems(content)
  const attendees = extractAttendees(content)
  const header = `${meta.title}\n${meta.date}${meta.time ? ` ${meta.time}` : ''} • ${meta.domainAbbr} • ${meta.duration || meta.source}\n\n`
  const detailCharEstimate = [
    header,
    summary,
    topics.join('\n'),
    decisions.join('\n'),
    actionItems.map(a => `${a.owner ? `[${a.owner}] ` : ''}${a.task}`).join('\n'),
    attendees.join(', '),
  ].join('\n\n').trim().length

  return {
    ...meta,
    detailCharEstimate,
    estimatedDetailPages: Math.max(1, Math.ceil(detailCharEstimate / DETAIL_CHUNK_ESTIMATE_CHARS)),
    topicCount: topics.length,
    decisionCount: decisions.length,
    actionCount: actionItems.length,
    attendeeCount: attendees.length,
  }
}

/**
 * Locate a meeting in the operations tree by the sessionId in its sidecar.
 *
 * Needed because the same session exists in BOTH trees under different names:
 * the standalone store keeps the raw capture name ("G2 Recording 2026-08-02
 * 1717") while operations holds the titled copy ("Family Dinner And
 * Commonwealth Games"). The meetings list reads operations, so anything keyed on
 * a session has to resolve there too or the same meeting shows two different
 * titles depending on which surface you are looking at.
 *
 * Scans sidecar heads rather than parsing them, so the cost is a 4 KB read per
 * candidate and not the transcript.
 */
export function findCosOperationsMeetingBySessionId(sessionId: string): {
  sidecarPath: string
  meetingPath: string
  filename: string
  domain: string
  month: string
  title: string
} | null {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return null

  for (const domain of discoverMeetingDomains(operationsDir)) {
    const meetingsBase = join(operationsDir, domain, 'meetings')
    let months: string[]
    try {
      months = readdirSync(meetingsBase).filter(d => /^\d{4}-\d{2}$/.test(d)).sort().reverse()
    } catch { continue }

    for (const month of months) {
      const monthDir = join(meetingsBase, month)
      let sidecars: string[]
      try {
        sidecars = readdirSync(monthDir).filter(f => f.endsWith('.g2-chunks.json')).sort().reverse()
      } catch { continue }

      for (const sidecarName of sidecars) {
        const meetingFilename = sidecarName.replace(/\.g2-chunks\.json$/, '.md')
        if (sidecarSessionId(monthDir, meetingFilename) !== sessionId) continue
        const meetingPath = join(monthDir, meetingFilename)
        let title = meetingFilename.replace(/\.md$/, '')
        try {
          const head = readFileSync(meetingPath, 'utf-8').slice(0, 4000)
          const heading = head.match(/^#\s+(.+)$/m)?.[1]?.trim()
          if (heading) title = heading
        } catch { /* fall back to the filename stem */ }
        return {
          sidecarPath: join(monthDir, sidecarName),
          meetingPath,
          filename: meetingFilename,
          domain,
          month,
          title,
        }
      }
    }
  }
  return null
}

export type MeetingLibraryRecord = NonNullable<ReturnType<typeof findCosOperationsMeetingBySessionId>> & {
  recordId?: string
  librarySource?: 'direct_library' | 'cos_operations'
  mutable?: boolean
}

/** Read resolver for direct libraries. Mutations must require recordId and
 * mutable=true; the legacy operations resolver above remains writable. */
export function findDirectLibraryMeetingBySessionId(sessionId: string): MeetingLibraryRecord | null {
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct' || !inspection.root) return null
  const root = inspection.root
  const months = readdirSync(root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()
  for (const month of months) {
    const monthDir = safeChildDirectory(root, join(root, month))
    if (!monthDir) continue
    for (const sidecarName of readdirSync(monthDir).filter(name => name.endsWith('.g2-chunks.json')).sort().reverse()) {
      const filename = sidecarName.replace(/\.g2-chunks\.json$/, '.md')
      if (sidecarSessionId(monthDir, filename) !== sessionId) continue
      const meetingPath = join(monthDir, filename)
      const bounded = safeBoundedRegularFile(monthDir, meetingPath, MEETING_SOURCE_MAX_BYTES)
      if (bounded == null) continue
      const title = bounded.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || filename.replace(/\.md$/, '')
      return {
        sidecarPath: join(monthDir, sidecarName), meetingPath, filename,
        domain: 'library', month, title,
        recordId: `direct:${month}:${filename}`,
        librarySource: 'direct_library',
        mutable: false,
      }
    }
  }
  return null
}

export function listCosOperationsMeetings(options: {
  limit?: number
  domain?: string
  month?: string
  day?: string
} = {}): CosOperationsMeetingMeta[] {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return []

  const scoped = Boolean(options.month || options.day)
  const limit = meetingListLimit(options.limit, scoped)
  const domainFilter = options.domain || 'all'
  const discovered = discoverMeetingDomains(operationsDir)
  const domains = domainFilter === 'all'
    ? discovered
    : discovered.includes(domainFilter) ? [domainFilter] : []

  const allMeetings: CosOperationsMeetingMeta[] = []

  for (const domain of domains) {
    const meetingsBase = join(operationsDir, domain, 'meetings')
    try {
      const months = readdirSync(meetingsBase)
        .filter(d => MONTH_PATTERN.test(d))
        .sort()
        .reverse()

      for (const month of months) {
        if (options.month && month !== options.month) continue
        const monthDir = join(meetingsBase, month)
        try {
          const files = readdirSync(monthDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .reverse()

          for (const file of files) {
            try {
              const filepath = join(monthDir, file)
              const content = readFileSync(filepath, 'utf-8')
              const meta = withMeetingListInsights(parseMeetingMeta(content.slice(0, 4000), file, domain), content)
              meta.month = month
              meta.librarySource = 'cos_operations'
              meta.recordId = `ops:${domain}:${month}:${file}`
              meta.mutable = true
              meta.canonicalRecord = `operations/${domain}/meetings/${month}/${file}`
              const sessionId = sidecarSessionId(monthDir, file)
              if (sessionId) meta.sessionId = sessionId
              if (options.day && meta.date !== options.day) continue
              allMeetings.push(meta)
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable months */ }
      }
    } catch { /* domain has no meetings dir */ }
  }

  allMeetings.sort(compareMeetingsNewestFirst)
  return allMeetings.slice(0, limit)
}

/** Folder names only. Used by the Control calendar pager. */
export function listCosOperationsMeetingMonths(domainFilter = 'all'): string[] {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return []
  const discovered = discoverMeetingDomains(operationsDir)
  const domains = domainFilter === 'all'
    ? discovered
    : discovered.includes(domainFilter) ? [domainFilter] : []
  const months = new Set<string>()
  for (const domain of domains) {
    const meetingsBase = join(operationsDir, domain, 'meetings')
    try {
      for (const month of readdirSync(meetingsBase).filter(name => MONTH_PATTERN.test(name))) {
        months.add(month)
      }
    } catch { /* domain has no meetings dir */ }
  }
  return [...months].sort().reverse()
}

export function listCosOperationsMeetingDays(month: string, domainFilter = 'all'): Array<{ date: string; count: number }> {
  if (!MONTH_PATTERN.test(month)) return []
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return []
  const discovered = discoverMeetingDomains(operationsDir)
  const domains = domainFilter === 'all'
    ? discovered
    : discovered.includes(domainFilter) ? [domainFilter] : []
  const names: string[] = []
  for (const domain of domains) {
    const monthDir = join(operationsDir, domain, 'meetings', month)
    try {
      names.push(...readdirSync(monthDir).filter(name => name.endsWith('.md')))
    } catch { /* missing month */ }
  }
  return meetingDayCountsFromNames(names)
}

export function listDirectLibraryMeetings(options: {
  limit?: number
  month?: string
  day?: string
} = {}): CosOperationsMeetingMeta[] {
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct' || !inspection.root) return []
  const scoped = Boolean(options.month || options.day)
  const limit = meetingListLimit(options.limit, scoped)
  const all: CosOperationsMeetingMeta[] = []
  let candidates = 0
  for (const month of readdirSync(inspection.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()) {
    if (options.month && month !== options.month) continue
    const monthDir = safeChildDirectory(inspection.root, join(inspection.root, month))
    if (!monthDir) continue
    for (const file of readdirSync(monthDir).filter(name => name.endsWith('.md')).sort().reverse()) {
      if (++candidates > MAX_LIST_CANDIDATES) break
      const bounded = safeBoundedRegularFile(monthDir, join(monthDir, file), MAX_LIST_FILE_BYTES)
      if (bounded == null) continue
      const content = bounded.content
      const meta = withMeetingListInsights(parseMeetingMeta(content.slice(0, 4000), file, 'library'), content)
      meta.month = month
      meta.librarySource = 'direct_library'
      meta.recordId = `direct:${month}:${file}`
      meta.mutable = false
      const sessionId = sidecarSessionId(monthDir, file)
      if (sessionId) meta.sessionId = sessionId
      if (options.day && meta.date !== options.day) continue
      all.push(meta)
    }
    if (candidates > MAX_LIST_CANDIDATES) break
  }
  all.sort(compareMeetingsNewestFirst)
  return all.slice(0, limit)
}

export function listDirectLibraryMeetingMonths(): string[] {
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct' || !inspection.root) return []
  return readdirSync(inspection.root)
    .filter(name => MONTH_PATTERN.test(name) && safeChildDirectory(inspection.root, join(inspection.root, name)))
    .sort()
    .reverse()
}

export function listDirectLibraryMeetingDays(month: string): Array<{ date: string; count: number }> {
  if (!MONTH_PATTERN.test(month)) return []
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct' || !inspection.root) return []
  const monthDir = safeChildDirectory(inspection.root, join(inspection.root, month))
  if (!monthDir) return []
  return meetingDayCountsFromNames(readdirSync(monthDir).filter(name => name.endsWith('.md')))
}

export function getCosOperationsMeetingDetail(
  domain: string,
  month: string,
  filename: string,
): MeetingDetail | null {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return null

  // Two separate jobs, and the old single membership test conflated them:
  // traversal safety, then whether this domain actually exists here.
  if (!safeName(domain)) return null
  if (!discoverMeetingDomains(operationsDir).includes(domain)) return null
  if (!/^\d{4}-\d{2}$/.test(month) || basename(filename) !== filename || !filename.endsWith('.md')) {
    return null
  }

  const monthDir = join(operationsDir, domain, 'meetings', month)
  let resolvedFilename = filename
  let filepath = join(monthDir, resolvedFilename)

  try {
    statSync(filepath)
  } catch {
    let candidates: Array<{ filename: string; content: string }> = []
    try {
      candidates = readdirSync(monthDir)
        .filter(candidate => candidate.endsWith('.md'))
        .map(candidate => ({
          filename: candidate,
          content: readFileSync(join(monthDir, candidate), 'utf8').slice(0, 4000),
        }))
    } catch {
      return null
    }
    const renamed = matchRenamedMeetingFilename(filename, candidates)
    if (!renamed) return null
    resolvedFilename = renamed
    filepath = join(monthDir, resolvedFilename)
  }

  const content = readFileSync(filepath, 'utf-8')
  const meta = parseMeetingMeta(content, resolvedFilename, domain)
  meta.month = month
  const source = boundedMeetingSource(content)

  return {
    ...meta,
    summary: extractSummary(content),
    topics: extractTopics(content),
    decisions: extractDecisions(content),
    actionItems: extractActionItems(content),
    attendees: extractAttendees(content),
    transcript: content,
    ...source,
  }
}

export function getDirectLibraryMeetingDetail(month: string, filename: string): MeetingDetail | null {
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct' || !inspection.root) return null
  if (!MONTH_PATTERN.test(month) || basename(filename) !== filename || !filename.endsWith('.md')) return null
  const monthDir = safeChildDirectory(inspection.root, join(inspection.root, month))
  if (!monthDir) return null
  let resolvedFilename = filename
  let bounded = safeBoundedRegularFile(monthDir, join(monthDir, resolvedFilename), MEETING_SOURCE_MAX_BYTES)
  if (bounded == null) {
    const candidates = readdirSync(monthDir).filter(name => name.endsWith('.md')).slice(0, MAX_LIST_CANDIDATES)
      .map(name => ({ filename: name, content: safeRegularFile(monthDir, join(monthDir, name), 4_000) ?? '' }))
    const renamed = matchRenamedMeetingFilename(filename, candidates)
    if (!renamed) return null
    resolvedFilename = renamed
    bounded = safeBoundedRegularFile(monthDir, join(monthDir, resolvedFilename), MEETING_SOURCE_MAX_BYTES)
    if (bounded == null) return null
  }
  const content = bounded.content
  const meta = parseMeetingMeta(content, resolvedFilename, 'library')
  meta.month = month
  meta.librarySource = 'direct_library'
  meta.recordId = `direct:${month}:${resolvedFilename}`
  meta.mutable = false
  const sessionId = sidecarSessionId(monthDir, resolvedFilename)
  if (sessionId) meta.sessionId = sessionId
  const source = { sourceContent: content, sourceTruncated: bounded.truncated }
  return {
    ...meta,
    summary: extractSummary(content), topics: extractTopics(content), decisions: extractDecisions(content),
    actionItems: extractActionItems(content), attendees: extractAttendees(content), transcript: content, ...source,
  }
}
