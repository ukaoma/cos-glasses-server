import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { FALLBACK_DOMAIN, isSafeDomainName } from './domains.js'
import {
  existingRootRealpath,
  safeDirectoryRealpath,
  safeReadFile,
  safeReadFileHead,
} from './meeting-file-guards.js'
import { parseMeeting, toMeta } from './meeting-parse.js'
import type {
  ProviderCandidateRecord,
  IndexedTranscriptChunk,
  TranscriptChunk,
  TranscriptGapReport,
} from '../routes/transcribe-stream.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const DAY_FILE_PREFIX = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))_/
const LIST_CAP = 50
const LIST_CAP_SCOPED = 200

export function meetingListLimit(limit: number | undefined, scoped: boolean): number {
  const raw = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 20
  return Math.max(1, Math.min(scoped ? LIST_CAP_SCOPED : LIST_CAP, raw))
}

/** Calendar dots from filenames. Does not open the markdown. */
export function meetingDayCountsFromNames(names: string[]): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  for (const name of names) {
    const match = name.match(DAY_FILE_PREFIX)
    if (!match) continue
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }))
}

const SAFE_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.md$/
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

// The parser and the filesystem guards moved to their own modules in 6.47.0 so
// the imported library can share them rather than grow a second copy. They are
// re-exported here because every existing caller and test imports them from
// this module, and a shared helper is not a reason to move anyone's import.
export {
  MEETING_SOURCE_MAX_BYTES,
  boundedMeetingSource,
  parseField,
  parseMeeting,
  toMeta,
} from './meeting-parse.js'

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
  /** From the chunk sidecar, absent on meetings saved without one. Carried so a
   *  list row can open the per-meeting speaker review, which is keyed on the
   *  session rather than the filename — the session is what lets the store's
   *  own hardened lookup find the sidecar again. */
  sessionId?: string
  title: string
  date: string
  time?: string
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
  /** Additive archive identity. Older companions ignore these fields. */
  librarySource?: 'direct_library' | 'cos_operations' | 'standalone_recordings'
  recordId?: string
  mutable?: boolean
  /** Present only when the server can state a truthful local record. */
  canonicalRecord?: string
  /** Additive. Unique sidecar speakers + whether a human correction landed. */
  voiceReview?: {
    voices: number
    unattributedVoices: number
    namedVoices: number
    humanTouched: boolean
  }
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
  /** Durable intent used to reconstruct post-save work if the process exits
   * between the canonical commit and creation of the replay job. */
  finalizationRequired?: boolean
  claimPending?: boolean
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

/**
 * Trim, validate, and PRESERVE CASE.
 *
 * Lowercasing was silently destructive: a domain folder named `DNP study` became
 * `dnp study`, which then matched no directory on disk. Existing all-lowercase
 * domains are unaffected.
 */
function normalizeDomain(value?: string): string {
  const domain = (value || FALLBACK_DOMAIN).trim()
  if (!isSafeDomainName(domain)) {
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

/** Enough to clear the sidecar's leading metadata keys whatever their order. */
const SIDECAR_HEAD_BYTES = 4096

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
      // When COS ops is configured, use the private-app pipeline markers so
      // sync_meetings.py --g2-file will enrich (and reclassify domain). Plain
      // "Standalone recording" summaries are treated as already-final and skipped.
      ...(process.env.COS_SCRIPTS_DIR
        ? [
            '<!-- g2-needs-domain-review -->',
            '',
            '*G2 recording — summary pending pipeline processing.*',
          ]
        : ['*Standalone recording — canonical transcript shown in meeting detail.*']),
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
      ...(input.finalizationRequired ? {
        finalizationState: 'capture_pending',
        claimPending: input.claimPending === true,
        finalizationUpdatedAt: new Date().toISOString(),
      } : {}),
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
    const rootReal = this.rootRealpath()
    if (!rootReal) return null
    for (const month of readdirSync(this.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()) {
      const monthDir = join(this.root, month)
      const monthReal = safeDirectoryRealpath(monthDir, rootReal)
      if (!monthReal) continue
      const sidecars = readdirSync(monthDir)
        .filter(name => /^\d{4}-\d{2}-\d{2}_[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.g2-chunks\.json$/.test(name))
        .sort()
        .reverse()
      for (const sidecarName of sidecars) {
        const sidecarText = safeReadFile(monthDir, monthReal, sidecarName)
        if (sidecarText === null) continue
        try {
          const sidecar = JSON.parse(sidecarText) as Record<string, unknown>
          if (sidecar.sessionId !== sessionId) continue
          const filename = sidecarName.replace(/\.g2-chunks\.json$/, '.md')
          const markdown = safeReadFile(monthDir, monthReal, filename)
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

  list(options: { limit?: number; domain?: string; month?: string; day?: string } = {}): MeetingMeta[] {
    const scoped = Boolean(options.month || options.day)
    const limit = meetingListLimit(options.limit, scoped)
    const domain = options.domain ?? 'all'
    if (domain !== 'all' && !isSafeDomainName(domain)) {
      throw new MeetingStoreError('Invalid domain filter', 400, 'invalid_domain')
    }
    if (options.month && !MONTH_PATTERN.test(options.month)) {
      throw new MeetingStoreError('Invalid month filter', 400, 'invalid_month')
    }
    if (options.day && !DAY_PATTERN.test(options.day)) {
      throw new MeetingStoreError('Invalid day filter', 400, 'invalid_day')
    }
    const rootReal = this.rootRealpath()
    if (!rootReal) return []
    const meetings: MeetingMeta[] = []

    for (const month of readdirSync(this.root).filter(name => MONTH_PATTERN.test(name)).sort().reverse()) {
      if (options.month && month !== options.month) continue
      const monthDir = join(this.root, month)
      const monthReal = safeDirectoryRealpath(monthDir, rootReal)
      if (!monthReal) continue
      for (const filename of readdirSync(monthDir).filter(name => SAFE_FILENAME_PATTERN.test(name)).sort().reverse()) {
        try {
          const content = safeReadFile(monthDir, monthReal, filename)
          if (content === null) continue
          const detail = parseMeeting(content, filename, month)
          if (domain !== 'all' && detail.domain !== domain) continue
          if (options.day && detail.date !== options.day) continue
          meetings.push(toMeta(detail, this.sidecarSessionId(monthDir, monthReal, filename)))
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

  /** Folder names only. Used by the Control calendar pager. */
  listMonths(): string[] {
    const rootReal = this.rootRealpath()
    if (!rootReal) return []
    return readdirSync(this.root)
      .filter(name => MONTH_PATTERN.test(name) && safeDirectoryRealpath(join(this.root, name), rootReal))
      .sort()
      .reverse()
  }

  listDayCounts(month: string): Array<{ date: string; count: number }> {
    if (!MONTH_PATTERN.test(month)) return []
    const rootReal = this.rootRealpath()
    if (!rootReal) return []
    const monthDir = join(this.root, month)
    const monthReal = safeDirectoryRealpath(monthDir, rootReal)
    if (!monthReal) return []
    return meetingDayCountsFromNames(
      readdirSync(monthDir).filter(name => SAFE_FILENAME_PATTERN.test(name) || name.endsWith('.md')),
    )
  }

  detail(domain: string, month: string, filename: string): MeetingDetail {
    if (!isSafeDomainName(domain)) {
      throw new MeetingStoreError('Invalid domain', 400, 'invalid_domain')
    }
    if (!MONTH_PATTERN.test(month)) {
      throw new MeetingStoreError('Invalid month', 400, 'invalid_month')
    }
    if (!SAFE_FILENAME_PATTERN.test(filename) || basename(filename) !== filename) {
      throw new MeetingStoreError('Invalid filename', 400, 'invalid_filename')
    }

    const rootReal = this.rootRealpath()
    if (!rootReal) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const monthDir = join(this.root, month)
    const monthReal = safeDirectoryRealpath(monthDir, rootReal)
    if (!monthReal) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const content = safeReadFile(monthDir, monthReal, filename)
    if (content === null) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    const detail = parseMeeting(content, filename, month)
    if (detail.domain !== domain) throw new MeetingStoreError('Meeting not found', 404, 'meeting_not_found')
    return detail
  }

  private rootRealpath(): string | null {
    return existingRootRealpath(
      this.root,
      () => new MeetingStoreError('Unsafe recordings directory', 500, 'unsafe_recordings_store'),
    )
  }

  /** The sessionId recorded in a meeting's chunk sidecar, if it has one.
   *
   *  Matched with a regex over the file's head rather than JSON.parse: the goal
   *  is one small field, and parsing a megabyte of chunks per list row to reach
   *  it would make listing cost scale with total transcript size. */
  private sidecarSessionId(monthDir: string, monthReal: string, meetingFilename: string): string | undefined {
    const sidecarName = meetingFilename.replace(/\.md$/, '.g2-chunks.json')
    if (sidecarName === meetingFilename) return undefined
    const head = safeReadFileHead(monthDir, monthReal, sidecarName, SIDECAR_HEAD_BYTES)
    if (!head) return undefined
    const match = head.match(/"sessionId"\s*:\s*"([A-Za-z0-9:_-]{3,96})"/)
    return match ? match[1] : undefined
  }
}

let defaultMeetingStore: MeetingStore | null = null

export function getMeetingStore(): MeetingStore {
  defaultMeetingStore ??= new MeetingStore()
  return defaultMeetingStore
}
