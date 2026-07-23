import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import type {
  ProviderCandidateRecord,
  IndexedTranscriptChunk,
  TranscriptChunk,
  TranscriptGapReport,
} from '../routes/transcribe-stream.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const SAFE_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.md$/
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const MAX_MEETING_BYTES = 10 * 1024 * 1024
const DETAIL_CHUNK_ESTIMATE_CHARS = 1_700
export const MEETING_SOURCE_MAX_BYTES = 100_000

export class MeetingStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'MeetingStoreError'
  }
}

export interface MeetingMeta {
  filename: string
  title: string
  date: string
  domain: string
  domainAbbr: string
  source: string
  duration: string
  durationMinutes?: number
  month: string
  estimatedDetailPages?: number
  detailCharEstimate?: number
  topicCount?: number
  decisionCount?: number
  actionCount?: number
  attendeeCount?: number
}

export interface MeetingActionItem {
  task: string
  owner: string
}

export interface MeetingDetail extends MeetingMeta {
  summary: string
  topics: string[]
  decisions: string[]
  actionItems: MeetingActionItem[]
  attendees: string[]
  /** Additive field for API consumers that want the exact canonical record. */
  transcript: string
  /** Bounded canonical meeting markdown for model-grounded follow-up prompts. */
  sourceContent: string
  /** True when sourceContent is a UTF-8-safe prefix of a larger record. */
  sourceTruncated: boolean
}

export interface SaveMeetingInput {
  sessionId: string
  title?: string
  domain?: string
  transcript: string
  startTime: number
  durationMs: number
  chunks: TranscriptChunk[]
  chunkEntries?: IndexedTranscriptChunk[]
  providerCandidates?: Record<string, ProviderCandidateRecord>
  transferIntegrity?: TranscriptGapReport | null
}

export interface SavedMeeting {
  filepath: string
  sidecarPath: string
  filename: string
  month: string
  title: string
  domain: string
  durationMin: number
  transferIntegrity?: TranscriptGapReport | null
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MeetingStoreError('Unsafe recordings directory', 500, 'unsafe_recordings_store')
  }
  chmodSync(path, 0o700)
}

function normalizeSessionId(value: string): string {
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(value)) {
    throw new MeetingStoreError('Invalid sessionId', 400, 'invalid_session_id')
  }
  return value
}

function normalizeDomain(value?: string): string {
  const domain = (value || 'personal').trim().toLowerCase()
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new MeetingStoreError('Invalid domain', 400, 'invalid_domain')
  }
  return domain
}

function normalizeTitle(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return normalized || fallback
}

function filenameStem(title: string, fallback: string): string {
  const safe = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 72)
  return safe || fallback
}

function localParts(timestamp: number): {
  date: string
  month: string
  time: string
  hourMinute: string
} {
  const date = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) {
    throw new MeetingStoreError('Invalid meeting start time', 400, 'invalid_start_time')
  }
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return {
    date: `${yyyy}-${mm}-${dd}`,
    month: `${yyyy}-${mm}`,
    hourMinute: `${hh}${minute}`,
    time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
  }
}

function escapeTableValue(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function canonicalProvider(chunks: TranscriptChunk[]): 'server-whisper' | 'iphone-whisperkit-beta' | 'mixed' {
  const providers = new Set(chunks.map(chunk => chunk.asrProvider || 'server-whisper'))
  if (providers.size === 0) return 'server-whisper'
  if (providers.size === 1) return [...providers][0] as 'server-whisper' | 'iphone-whisperkit-beta'
  return 'mixed'
}

function parseField(content: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const table = content.match(new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\|\\s*(.+)`, 'i'))
  if (table) return table[1].replace(/\s*\|?\s*$/, '').trim()
  const plain = content.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, 'i'))
  return plain ? plain[1].trim() : ''
}

function extractSection(content: string, headings: string[], toEnd = false): string {
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = toEnd
      ? new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*)$`, 'i')
      : new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i')
    const match = content.match(pattern)
    if (match) return match[1].trim()
  }
  return ''
}

function parseListSection(content: string, headings: string[], limit: number): string[] {
  const section = extractSection(content, headings)
  if (!section) return []
  return section
    .split('\n')
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, limit)
}

function parseActions(content: string): MeetingActionItem[] {
  const section = extractSection(content, ['Action Items', 'Tasks', 'Next Steps'])
  if (!section) return []
  return section
    .split('\n')
    .filter(line => /^\s*(?:[-*]|\[[ xX]\])\s+/.test(line))
    .map(line => {
      const cleaned = line
        .replace(/^\s*[-*]\s+/, '')
        .replace(/^\[[ xX]\]\s*/, '')
        .replace(/`\[REVIEW\]`\s*/i, '')
        .trim()
      const ownerMatch = cleaned.match(/\(\*\*(.+?)\*\*\)\s*$/)
      return {
        task: ownerMatch ? cleaned.replace(ownerMatch[0], '').trim() : cleaned,
        owner: ownerMatch ? ownerMatch[1] : '',
      }
    })
    .filter(item => item.task.length > 0)
    .slice(0, 15)
}

function parseAttendees(content: string): string[] {
  return parseListSection(content, ['Attendees'], 20).map(line => {
    const match = line.match(/^\*\*(.+?)\*\*/) || line.match(/^([^(]+)/)
    return match ? match[1].trim() : line
  })
}

function parseDurationMinutes(duration: string): number | undefined {
  if (!duration) return undefined
  const value = duration.toLowerCase()
  const colon = value.match(/\b(\d+):(\d{2})\b/)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  let total = 0
  const hours = value.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/)
  if (hours) total += Math.round(Number(hours[1]) * 60)
  const minutes = value.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/)
  if (minutes) total += Number(minutes[1])
  return total > 0 ? total : undefined
}

function parseMeeting(content: string, filename: string, month: string): MeetingDetail {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const date = parseField(content, 'Date') || filename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || 'unknown'
  const domain = parseField(content, 'Domain') || 'personal'
  const duration = parseField(content, 'Duration')
  const transcript = extractSection(content, ['Transcript'], true)
  const storedSummary = extractSection(content, ['Summary'])
  // Standalone recordings have no private enrichment pipeline. Returning the
  // canonical transcript as the detail summary lets the build199 reader review
  // the saved meeting instead of displaying only a placeholder.
  const summary = !storedSummary || /standalone recording|summary unavailable/i.test(storedSummary)
    ? transcript
    : storedSummary
  const topics = parseListSection(content, ['Topics Discussed'], 10)
  const decisions = parseListSection(content, ['Decisions', 'Decisions Made'], 10)
  const actionItems = parseActions(content)
  const attendees = parseAttendees(content)
  const source = boundedMeetingSource(content)

  return {
    filename,
    title: heading || basename(filename, '.md').split('_').slice(1).join(' ') || 'Untitled Meeting',
    date,
    domain,
    domainAbbr: domain === 'personal' ? 'P' : domain.slice(0, 2).toUpperCase() || '?',
    source: parseField(content, 'Source'),
    duration,
    ...(parseDurationMinutes(duration) !== undefined ? { durationMinutes: parseDurationMinutes(duration) } : {}),
    month,
    summary,
    topics,
    decisions,
    actionItems,
    attendees,
    transcript,
    ...source,
  }
}

/** Return enough canonical source for grounded meeting follow-ups without
 * allowing an unexpectedly large archive record to inflate every response.
 * The boundary backs up over UTF-8 continuation bytes so the prefix never
 * ends with a replacement character. */
export function boundedMeetingSource(content: string): { sourceContent: string; sourceTruncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length <= MEETING_SOURCE_MAX_BYTES) return { sourceContent: content, sourceTruncated: false }
  let end = MEETING_SOURCE_MAX_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return { sourceContent: bytes.subarray(0, end).toString('utf8'), sourceTruncated: true }
}

function toMeta(detail: MeetingDetail): MeetingMeta {
  const detailCharEstimate = [
    detail.title,
    detail.date,
    detail.duration || detail.source,
    detail.summary,
    detail.topics.join('\n'),
    detail.decisions.join('\n'),
    detail.actionItems.map(item => `${item.owner ? `[${item.owner}] ` : ''}${item.task}`).join('\n'),
    detail.attendees.join(', '),
  ].join('\n\n').trim().length
  return {
    filename: detail.filename,
    title: detail.title,
    date: detail.date,
    domain: detail.domain,
    domainAbbr: detail.domainAbbr,
    source: detail.source,
    duration: detail.duration,
    ...(detail.durationMinutes !== undefined ? { durationMinutes: detail.durationMinutes } : {}),
    month: detail.month,
    detailCharEstimate,
    estimatedDetailPages: Math.max(1, Math.ceil(detailCharEstimate / DETAIL_CHUNK_ESTIMATE_CHARS)),
    topicCount: detail.topics.length,
    decisionCount: detail.decisions.length,
    actionCount: detail.actionItems.length,
    attendeeCount: detail.attendees.length,
  }
}

function isContained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

export class MeetingStore {
  readonly root: string

  constructor(root = dataPath('recordings')) {
    this.root = resolve(root)
  }

  save(input: SaveMeetingInput): SavedMeeting {
    const sessionId = normalizeSessionId(input.sessionId)
    const domain = normalizeDomain(input.domain)
    const transcript = input.transcript
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n')
      .trim()
    if (!transcript) throw new MeetingStoreError('Transcript is empty', 400, 'empty_transcript')

    const parts = localParts(input.startTime)
    const fallbackTitle = `G2 Recording ${parts.date} ${parts.hourMinute}`
    const title = normalizeTitle(input.title, fallbackTitle)
    const stem = filenameStem(title, `G2_Recording_${parts.hourMinute}`)
    const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0
    const durationMin = Math.round(durationMs / 60_000)

    ensurePrivateDirectory(this.root)
    const meetingDir = join(this.root, parts.month)
    ensurePrivateDirectory(meetingDir)

    const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
    // Include the session-derived suffix up front. The process-wide server lock
    // gives us one writer, and distinct sessions cannot choose the same target
    // merely because their title/date match.
    let filename = `${parts.date}_${stem}_${suffix}.md`
    let filepath = join(meetingDir, filename)
    if (existsSync(filepath) || existsSync(filepath.replace(/\.md$/, '.g2-chunks.json'))) {
      let collision = 2
      while (existsSync(filepath) || existsSync(filepath.replace(/\.md$/, '.g2-chunks.json'))) {
        filename = `${parts.date}_${stem}_${suffix}_${collision}.md`
        filepath = join(meetingDir, filename)
        collision++
      }
    }
    const sidecarPath = filepath.replace(/\.md$/, '.g2-chunks.json')

    const missing = input.transferIntegrity?.missingIndices.length ?? 0
    const completenessPct = input.transferIntegrity
      ? Math.floor(input.transferIntegrity.completeness * 1_000) / 10
      : 100
    const integrityValue = missing > 0
      ? `${completenessPct}% — ${missing} chunk${missing === 1 ? '' : 's'} not received`
      : '100%'
    const markdown = [
      `# ${title}`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| **Date** | ${parts.date} |`,
      `| **Time** | ${parts.time} |`,
      `| **Duration** | ${durationMin} minutes |`,
      '| **Source** | G2 Glasses |',
      `| **Domain** | ${escapeTableValue(domain)} |`,
      `| **Transfer integrity** | ${integrityValue} |`,
      '| **Transcription quality** | streaming |',
      '',
      '## Summary',
      '',
      '*Standalone recording — canonical transcript shown in meeting detail.*',
      '',
      '## Transcript',
      '',
      transcript,
      '',
    ].join('\n')

    const providers = [...new Set(input.chunks.map(chunk => chunk.asrProvider || 'server-whisper'))]
    const sidecar = {
      schemaVersion: 2,
      sessionId,
      startTime: input.startTime,
      durationMs,
      domain,
      title,
      canonicalProvider: canonicalProvider(input.chunks),
      providers,
      providerCandidates: input.providerCandidates ?? {},
      speakers: [...new Set(input.chunks.map(chunk => chunk.speaker).filter(speaker => speaker && speaker !== 'Ext'))],
      chunks: input.chunks,
      chunkEntries: input.chunkEntries ?? input.chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk })),
      transferIntegrity: input.transferIntegrity ?? null,
      transcriptionQuality: 'streaming',
      batchApplied: false,
      streamingWordCount: wordCount(transcript),
    }

    // Sidecar first, markdown second: the markdown is the visible commit marker.
    // A crash can leave an orphan sidecar, but never a listed meeting whose
    // canonical chunk metadata was not durably published.
    durableAtomicWriteFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), { mode: 0o600 })
    try {
      durableAtomicWriteFileSync(filepath, markdown, { mode: 0o600 })
    } catch (error) {
      try { unlinkSync(sidecarPath) } catch { /* orphan stays hidden without markdown */ }
      throw error
    }

    return {
      filepath,
      sidecarPath,
      filename,
      month: parts.month,
      title,
      domain,
      durationMin,
      transferIntegrity: input.transferIntegrity ?? null,
    }
  }

  /** Durable idempotency lookup for a client retry after its save response was lost. */
  findBySessionId(rawSessionId: string): SavedMeeting | null {
    const sessionId = normalizeSessionId(rawSessionId)
    const rootReal = this.existingRootRealpath()
    if (!rootReal) return null
    for (const month of readdirSync(this.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()) {
      const monthDir = join(this.root, month)
      const monthReal = this.safeDirectoryRealpath(monthDir, rootReal)
      if (!monthReal) continue
      const sidecars = readdirSync(monthDir)
        .filter(name => /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.g2-chunks\.json$/.test(name))
        .sort()
        .reverse()
      for (const sidecarName of sidecars) {
        const sidecarText = this.safeReadFile(monthDir, monthReal, sidecarName)
        if (sidecarText === null) continue
        try {
          const sidecar = JSON.parse(sidecarText) as Record<string, unknown>
          if (sidecar.sessionId !== sessionId) continue
          const filename = sidecarName.replace(/\.g2-chunks\.json$/, '.md')
          const markdown = this.safeReadMeeting(monthDir, monthReal, filename)
          if (markdown === null) continue
          const detail = parseMeeting(markdown, filename, month)
          const durationMs = typeof sidecar.durationMs === 'number' && Number.isFinite(sidecar.durationMs)
            ? Math.max(0, sidecar.durationMs)
            : 0
          return {
            filepath: join(monthDir, filename),
            sidecarPath: join(monthDir, sidecarName),
            filename,
            month,
            title: detail.title,
            domain: detail.domain,
            durationMin: Math.round(durationMs / 60_000),
            transferIntegrity: sidecar.transferIntegrity as TranscriptGapReport | null | undefined,
          }
        } catch {
          // Malformed diagnostic metadata is not a valid idempotency record.
        }
      }
    }
    return null
  }

  list(options: { limit?: number; domain?: string } = {}): MeetingMeta[] {
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)))
    const domain = options.domain ?? 'all'
    if (domain !== 'all' && !DOMAIN_PATTERN.test(domain)) {
      throw new MeetingStoreError('Invalid domain filter', 400, 'invalid_domain')
    }
    const rootReal = this.existingRootRealpath()
    if (!rootReal) return []
    const meetings: MeetingMeta[] = []

    for (const month of readdirSync(this.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()) {
      const monthDir = join(this.root, month)
      const monthReal = this.safeDirectoryRealpath(monthDir, rootReal)
      if (!monthReal) continue
      for (const filename of readdirSync(monthDir).filter(name => SAFE_FILENAME_PATTERN.test(name)).sort().reverse()) {
        try {
          const content = this.safeReadMeeting(monthDir, monthReal, filename)
          if (content === null) continue
          const detail = parseMeeting(content, filename, month)
          if (domain !== 'all' && detail.domain !== domain) continue
          meetings.push(toMeta(detail))
        } catch {
          // One unreadable/corrupt entry must not hide the rest of the store.
        }
      }
    }
    meetings.sort((left, right) => (
      right.date.localeCompare(left.date) || right.filename.localeCompare(left.filename)
    ))
    return meetings.slice(0, limit)
  }

  detail(domain: string, month: string, filename: string): MeetingDetail {
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new MeetingStoreError('Invalid domain', 400, 'invalid_domain')
    }
    if (!MONTH_PATTERN.test(month)) {
      throw new MeetingStoreError('Invalid month', 400, 'invalid_month')
    }
    if (!SAFE_FILENAME_PATTERN.test(filename) || basename(filename) !== filename) {
      throw new MeetingStoreError('Invalid filename', 400, 'invalid_filename')
    }

    const rootReal = this.existingRootRealpath()
    if (!rootReal) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const monthDir = join(this.root, month)
    const monthReal = this.safeDirectoryRealpath(monthDir, rootReal)
    if (!monthReal) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const content = this.safeReadMeeting(monthDir, monthReal, filename)
    if (content === null) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const detail = parseMeeting(content, filename, month)
    if (detail.domain !== domain) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    return detail
  }

  private existingRootRealpath(): string | null {
    if (!existsSync(this.root)) return null
    const stat = lstatSync(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MeetingStoreError('Unsafe recordings directory', 500, 'unsafe_recordings_store')
    }
    return realpathSync(this.root)
  }

  private safeDirectoryRealpath(path: string, parentReal: string): string | null {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null
      const real = realpathSync(path)
      return isContained(parentReal, real) && dirname(real) === parentReal ? real : null
    } catch {
      return null
    }
  }

  private safeReadMeeting(monthDir: string, monthReal: string, filename: string): string | null {
    return this.safeReadFile(monthDir, monthReal, filename)
  }

  private safeReadFile(monthDir: string, monthReal: string, filename: string): string | null {
    const filepath = join(monthDir, filename)
    let fd: number | null = null
    try {
      const linkStat = lstatSync(filepath)
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null
      const real = realpathSync(filepath)
      if (!isContained(monthReal, real) || dirname(real) !== monthReal) return null
      fd = openSync(filepath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_MEETING_BYTES) return null
      return readFileSync(fd, 'utf8')
    } catch {
      return null
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
    }
  }
}

let defaultMeetingStore: MeetingStore | null = null

export function getMeetingStore(): MeetingStore {
  defaultMeetingStore ??= new MeetingStore()
  return defaultMeetingStore
}
