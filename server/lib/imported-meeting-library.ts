// The imported meeting library: meetings this Mac did not record.
//
// Root is dataPath('imports'), 0700, with 0600 files in YYYY-MM folders, the
// same shape as the recordings store. Three record kinds live here:
//
//   fireflies  one imported vendor meeting          <date>_fireflies_<h16>.md
//   merged     one meeting plus its G2 recordings   <date>_merged_<h16>.md
//   piece      one span of a long recording         <date>_piece_<h16>.md
//
// WHY A SEPARATE ROOT. The recordings store holds what the glasses captured,
// and `.g2-chunks.json` beside a recording is the key the whole speaker system
// looks meetings up by (findBySessionId, sidecarSessionId, sidecarListHints and
// two sidecar scans in cos-operations-meetings). An imported record has no
// capture and no session, so it carries `.import.json` / `.derived.json`
// instead. Nothing here ever writes a `.g2-chunks.json`: a derived record that
// looked like a capture would be offered for speaker review, relabelled, and
// then re-derived from its own output.
//
// ADDITIVE, NEVER REDUCTIVE. A record written here is a NEW file. No source is
// edited, moved or deleted, so every action in this release is reversible by
// removing what it added.
//
// FILENAMES ARE A CONTRACT, not a convenience. The hash in the name is derived
// from the vendor id (or the merge inputs), so writing the same meeting twice
// lands on the same file rather than making a second row, and a strict pattern
// on the way back in is what keeps an iCloud conflict copy ("... 2.md"), a
// hand-dropped file, or a crafted name out of the list.

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { extractMeetingDateTime } from './cos-operations-meetings.js'
import { dataPath } from './data-dir.js'
import { domainAbbreviation, isSafeDomainName } from './domains.js'
import {
  MAX_MEETING_BYTES,
  existingRootRealpath,
  safeDirectoryRealpath,
  safeReadFile,
  safeReadFileHead,
} from './meeting-file-guards.js'
import { parseMeeting, toMeta } from './meeting-parse.js'
import type { MeetingDetail, MeetingMeta } from './meeting-store.js'

export const IMPORTS_DIR_NAME = 'imports'
/** The routing domain of every record here. Not the meeting's own domain. */
export const IMPORTED_DOMAIN = 'imported'
/** Where an import came from when nothing says otherwise. */
export const DEFAULT_ORIGIN_DOMAIN = 'personal'

export const IMPORTED_RECORD_KINDS = ['fireflies', 'merged', 'piece'] as const
export type ImportedRecordKind = (typeof IMPORTED_RECORD_KINDS)[number]

/** Sidecars are JSON and legitimately large; markdown is not. Separate ceilings. */
export const IMPORT_SIDECAR_MAX_BYTES = 32 * 1024 * 1024
export const IMPORT_MARKDOWN_MAX_BYTES = 9 * 1024 * 1024
/** Enough to clear a sidecar's leading metadata keys whatever their order. */
export const IMPORT_SIDECAR_HEAD_BYTES = 4096

export const IMPORTED_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
export const IMPORTED_FILENAME_PATTERN =
  /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))_(fireflies|merged|piece)_([0-9a-f]{16})\.md$/
export const IMPORTED_SIDECAR_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_(?:fireflies|merged|piece)_[0-9a-f]{16}\.(?:import|derived)\.json$/
/** durableAtomicWriteFileSync's temp shape: .<name>.<pid>.<hex>.tmp */
export const IMPORTED_TEMP_PATTERN = /^\..+\.\d+\.[0-9a-f]{6,}\.tmp$/

export class ImportedLibraryError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'ImportedLibraryError'
  }
}

/** A path under the imports root. Resolved per call so tests can move the data home. */
export function importsRoot(...parts: string[]): string {
  return dataPath(IMPORTS_DIR_NAME, ...parts)
}

function hash16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function importHash(firefliesId: string): string {
  return hash16(`fireflies:${firefliesId}`)
}

/**
 * Identity of a merged record: its Fireflies primary plus every G2 session it
 * holds, sorted so input order cannot make two names for one merge.
 *
 * The separator is a comma because a session id may itself contain a colon
 * (normalizeSessionId allows it), and a separator that can appear inside a
 * part is a separator that can collide.
 */
export function mergedHash(firefliesPrimaryId: string, g2SessionIds: string[]): string {
  return hash16(`merge:${firefliesPrimaryId}:${[...g2SessionIds].sort().join(',')}`)
}

export function pieceHash(sourceRecordId: string, pieceIndex: number): string {
  return hash16(`split:${sourceRecordId}:${pieceIndex}`)
}

/** The id every surface uses for one of these rows. */
export function importRecordId(kind: ImportedRecordKind, hash: string): string {
  return kind === 'fireflies' ? `imported:fireflies:${hash}` : `blended:${hash}`
}

export function importedFilename(kind: ImportedRecordKind, date: string, hash: string): string {
  return `${date}_${kind}_${hash}.md`
}

export function sidecarFilenameFor(filename: string): string {
  const match = filename.match(IMPORTED_FILENAME_PATTERN)
  if (!match) throw new ImportedLibraryError('Not an imported record filename', 400, 'invalid_filename')
  const suffix = match[2] === 'fireflies' ? '.import.json' : '.derived.json'
  return filename.replace(/\.md$/, suffix)
}

export function localDateParts(timestamp: number): { date: string; month: string; time: string } {
  const value = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(value.getTime())) {
    throw new ImportedLibraryError('Invalid meeting time', 400, 'invalid_date')
  }
  const year = String(value.getFullYear())
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hour = String(value.getHours()).padStart(2, '0')
  const minute = String(value.getMinutes()).padStart(2, '0')
  return { date: `${year}-${month}-${day}`, month: `${year}-${month}`, time: `${hour}:${minute}` }
}

/**
 * Flatten a value into one safe markdown line.
 *
 * Two collapses are load-bearing rather than cosmetic. `##` becomes `#` so a
 * title or a spoken sentence cannot open a section the parser then reads as the
 * summary, and `**` becomes `*` so it cannot forge a `| **Date** |` field. Both
 * are matched by the parser ANYWHERE in the file, and the title line sits above
 * the real table, so without this a meeting called "**Date** | 1999-01-01"
 * would file itself under 1999. The unedited text is kept in the sidecar.
 */
export function singleLine(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/#{2,}/g, '#')
    .replace(/\*{2,}/g, '*')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableValue(value: string): string {
  return singleLine(value).replace(/\|/g, '\\|')
}

export function timestampLabel(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const secs = String(total % 60).padStart(2, '0')
  return `[${hours}:${minutes}:${secs}]`
}

export interface ImportedTranscriptLine {
  speakerName: string
  text: string
  startTime: number
}

/**
 * The vendor hands back action items as ONE string with newlines in it, not as
 * a list, so the split belongs here rather than in the parser: `## Action
 * Items` is a bulleted section, and `parseActions` reads one item per line.
 *
 * A line that already starts with a bullet loses it, or the render would show
 * two. Blank lines are dropped rather than becoming empty bullets.
 */
export function actionItemLines(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
    .filter(line => line.length > 0)
}

export interface FirefliesImportRender {
  title: string
  dateMs: number
  durationSeconds: number | null
  attendees: string[]
  overview?: string
  actionItems?: string[]
  sentences: ImportedTranscriptLine[]
}

/** Shown in place of the lines that did not fit. Plain words, no arrows. */
export const TRANSCRIPT_TRUNCATED_NOTE = 'Transcript truncated here. The full transcript is kept in this record sidecar.'

/**
 * The import template.
 *
 * It has to satisfy three readers at once: `parseMeeting` here, the COS
 * pipeline's own duration regex (`**Duration** | N min`) and date regex
 * (`**Date** | YYYY-MM-DD HH:MM`) in sync_meetings.py, and a person reading the
 * file. `## Transcript` is last because the parser reads that section to the
 * end of the file.
 */
export function renderImportMarkdown(input: FirefliesImportRender): string {
  const parts = localDateParts(input.dateMs)
  const durationMinutes = input.durationSeconds == null ? null : Math.round(input.durationSeconds / 60)
  const title = singleLine(input.title) || `Fireflies meeting ${parts.date}`

  const lines: string[] = [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Date** | ${parts.date} ${parts.time} |`,
    ...(durationMinutes == null ? [] : [`| **Duration** | ${durationMinutes} minutes |`]),
    '| **Source** | Fireflies |',
    `| **Domain** | ${IMPORTED_DOMAIN} |`,
    '',
  ]

  const overview = input.overview ? singleLine(input.overview) : ''
  if (overview) lines.push('## Summary', '', overview, '')

  const actionItems = (input.actionItems ?? []).map(singleLine).filter(Boolean)
  if (actionItems.length > 0) {
    lines.push('## Action Items', '', ...actionItems.map(item => `- ${item}`), '')
  }

  const attendees = input.attendees.map(singleLine).filter(Boolean)
  if (attendees.length > 0) {
    lines.push('## Attendees', '', ...attendees.map(name => `- ${name}`), '')
  }

  lines.push('## Transcript', '')
  const header = `${lines.join('\n')}\n`

  const body: string[] = []
  let bytes = Buffer.byteLength(header)
  let truncated = false
  for (const sentence of input.sentences) {
    const speaker = singleLine(sentence.speakerName) || 'Unknown'
    const text = singleLine(sentence.text)
    if (!text) continue
    const line = `${timestampLabel(sentence.startTime)} ${speaker}: ${text}`
    const lineBytes = Buffer.byteLength(`${line}\n`)
    // Leave room for the note itself, so the ceiling holds even at the boundary.
    if (bytes + lineBytes + Buffer.byteLength(TRANSCRIPT_TRUNCATED_NOTE) + 2 > IMPORT_MARKDOWN_MAX_BYTES) {
      truncated = true
      break
    }
    body.push(line)
    bytes += lineBytes
  }
  if (truncated) body.push('', TRANSCRIPT_TRUNCATED_NOTE)

  return `${header}${body.join('\n')}\n`
}

export interface ImportedRecordWrite {
  kind: ImportedRecordKind
  hash: string
  /** Decides the filename date and the month folder. */
  dateMs: number
  markdown: string
  sidecar: unknown
}

export interface ImportedRecordWriteResult {
  written: boolean
  month: string
  filename: string
  filepath: string
  sidecarPath: string
  recordId: string
}

/** A list row for an imported record. WS5 widens MeetingMeta to carry these. */
export type ImportedMeetingMeta = Omit<MeetingMeta, 'librarySource'> & {
  librarySource: 'imported' | 'blended'
  recordId: string
  mutable: false
  originDomain: string
  derivedKind?: 'merge' | 'split'
}

/** Omit-and-restate rather than extend: MeetingMeta's `librarySource` union
 *  does not carry the imported values yet, and widening a type this many
 *  surfaces decode from belongs with the list and detail integration, not here. */
export type ImportedMeetingDetail = Omit<MeetingDetail, 'librarySource'> & {
  librarySource: 'imported' | 'blended'
  recordId: string
  mutable: false
  originDomain: string
  derivedKind?: 'merge' | 'split'
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ImportedLibraryError('Unsafe imports directory', 500, 'unsafe_imports_store')
  }
  chmodSync(path, 0o700)
}

function originDomainFromSidecarHead(head: string | null): string {
  if (!head) return DEFAULT_ORIGIN_DOMAIN
  const match = head.match(/"originDomain"\s*:\s*"([^"]{1,64})"/)
  if (!match) return DEFAULT_ORIGIN_DOMAIN
  return isSafeDomainName(match[1]) ? match[1] : DEFAULT_ORIGIN_DOMAIN
}

export class ImportedMeetingLibrary {
  readonly root: string

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? importsRoot()
  }

  private rootReal(): string | null {
    return existingRootRealpath(this.root, () => new ImportedLibraryError('Unsafe imports directory', 500, 'unsafe_imports_store'))
  }

  private months(rootReal: string): string[] {
    return readdirSync(this.root)
      .filter(name => IMPORTED_MONTH_PATTERN.test(name) && safeDirectoryRealpath(join(this.root, name), rootReal))
      .sort()
      .reverse()
  }

  /**
   * Write one record. Sidecar first, markdown second.
   *
   * The markdown is the commit marker: a crash between the two leaves a sidecar
   * with no record, which lists as nothing and is swept at the next startup. The
   * reverse order would publish a listed record whose evidence never landed.
   */
  writeRecord(input: ImportedRecordWrite): ImportedRecordWriteResult {
    if (!/^[0-9a-f]{16}$/.test(input.hash)) {
      throw new ImportedLibraryError('Invalid record hash', 400, 'invalid_hash')
    }
    const parts = localDateParts(input.dateMs)
    const filename = importedFilename(input.kind, parts.date, input.hash)
    if (!IMPORTED_FILENAME_PATTERN.test(filename)) {
      throw new ImportedLibraryError('Invalid record filename', 400, 'invalid_filename')
    }
    const sidecarText = JSON.stringify(input.sidecar)
    if (Buffer.byteLength(sidecarText) > IMPORT_SIDECAR_MAX_BYTES) {
      throw new ImportedLibraryError('Record evidence is too large to store', 507, 'derived_too_large')
    }
    if (Buffer.byteLength(input.markdown) > IMPORT_MARKDOWN_MAX_BYTES) {
      throw new ImportedLibraryError('Record markdown is too large to store', 507, 'derived_too_large')
    }

    ensurePrivateDirectory(this.root)
    const monthDir = join(this.root, parts.month)
    ensurePrivateDirectory(monthDir)
    const monthReal = safeDirectoryRealpath(monthDir, this.rootReal() ?? '')
    if (!monthReal) throw new ImportedLibraryError('Unsafe imports month folder', 500, 'unsafe_imports_store')

    const sidecarName = sidecarFilenameFor(filename)
    const filepath = join(monthDir, filename)
    const sidecarPath = join(monthDir, sidecarName)
    const recordId = importRecordId(input.kind, input.hash)

    // Re-deriving the same bytes is not a write. This is what lets the importer
    // re-see a meeting on every poll without rewriting the library each time.
    const existingMarkdown = safeReadFile(monthDir, monthReal, filename, IMPORT_MARKDOWN_MAX_BYTES)
    if (existingMarkdown === input.markdown) {
      const existingSidecar = safeReadFile(monthDir, monthReal, sidecarName, IMPORT_SIDECAR_MAX_BYTES)
      if (existingSidecar === sidecarText) {
        return { written: false, month: parts.month, filename, filepath, sidecarPath, recordId }
      }
    }

    durableAtomicWriteFileSync(sidecarPath, sidecarText, { mode: 0o600 })
    try {
      durableAtomicWriteFileSync(filepath, input.markdown, { mode: 0o600 })
    } catch (error) {
      try { unlinkSync(sidecarPath) } catch { /* an orphan sidecar lists as nothing */ }
      throw error
    }
    return { written: true, month: parts.month, filename, filepath, sidecarPath, recordId }
  }

  /** Hashes actually on disk. The importer proves a write by re-listing.
   *
   *  `kind` matters once merged and split records live here too: a count of
   *  "imported meetings" that silently included every derived record would
   *  climb every time the engine ran. */
  listHashes(options: { month?: string; kind?: ImportedRecordKind } = {}): Set<string> {
    const hashes = new Set<string>()
    const rootReal = this.rootReal()
    if (!rootReal) return hashes
    for (const month of this.months(rootReal)) {
      if (options.month && month !== options.month) continue
      const monthDir = join(this.root, month)
      if (!safeDirectoryRealpath(monthDir, rootReal)) continue
      for (const name of readdirSync(monthDir)) {
        const match = name.match(IMPORTED_FILENAME_PATTERN)
        if (!match) continue
        if (options.kind && match[2] !== options.kind) continue
        hashes.add(match[3])
      }
    }
    return hashes
  }

  has(hash: string): boolean {
    return this.listHashes().has(hash)
  }

  list(options: { limit?: number; domain?: string; month?: string; day?: string } = {}): ImportedMeetingMeta[] {
    const rootReal = this.rootReal()
    if (!rootReal) return []
    const domain = options.domain ?? 'all'
    const rows: ImportedMeetingMeta[] = []

    for (const month of this.months(rootReal)) {
      if (options.month && month !== options.month) continue
      const monthDir = join(this.root, month)
      const monthReal = safeDirectoryRealpath(monthDir, rootReal)
      if (!monthReal) continue
      for (const filename of readdirSync(monthDir).filter(name => IMPORTED_FILENAME_PATTERN.test(name)).sort().reverse()) {
        try {
          const row = this.metaFor(monthDir, monthReal, month, filename)
          if (!row) continue
          // `imported` is the routing domain every record shares; a domain
          // filter otherwise matches where the meeting actually came from.
          if (domain !== 'all' && domain !== IMPORTED_DOMAIN && row.originDomain !== domain) continue
          if (options.day && row.date !== options.day) continue
          rows.push(row)
        } catch {
          // One unreadable record must not hide the rest of the library.
        }
      }
    }

    rows.sort((left, right) => (
      right.date.localeCompare(left.date)
      || (right.time ?? '').localeCompare(left.time ?? '')
      || right.filename.localeCompare(left.filename)
    ))
    return typeof options.limit === 'number' ? rows.slice(0, Math.max(0, options.limit)) : rows
  }

  private metaFor(monthDir: string, monthReal: string, month: string, filename: string): ImportedMeetingMeta | null {
    const content = safeReadFile(monthDir, monthReal, filename, MAX_MEETING_BYTES)
    if (content === null) return null
    const match = filename.match(IMPORTED_FILENAME_PATTERN)
    if (!match) return null
    const kind = match[2] as ImportedRecordKind
    const hash = match[3]
    const detail = parseMeeting(content, filename, month)
    const stamp = extractMeetingDateTime(content, filename)
    const originDomain = originDomainFromSidecarHead(
      safeReadFileHead(monthDir, monthReal, sidecarFilenameFor(filename), IMPORT_SIDECAR_HEAD_BYTES),
    )
    const meta = toMeta({ ...detail, date: stamp.date })
    return {
      ...meta,
      ...(stamp.time ? { time: stamp.time } : {}),
      domain: IMPORTED_DOMAIN,
      domainAbbr: domainAbbreviation(originDomain),
      originDomain,
      librarySource: kind === 'fireflies' ? 'imported' : 'blended',
      recordId: importRecordId(kind, hash),
      mutable: false,
      ...(kind === 'merged' ? { derivedKind: 'merge' as const } : {}),
      ...(kind === 'piece' ? { derivedKind: 'split' as const } : {}),
    }
  }

  detail(month: string, filename: string): ImportedMeetingDetail | null {
    if (!IMPORTED_MONTH_PATTERN.test(month)) return null
    const match = filename.match(IMPORTED_FILENAME_PATTERN)
    if (!match) return null
    const rootReal = this.rootReal()
    if (!rootReal) return null
    const monthDir = join(this.root, month)
    const monthReal = safeDirectoryRealpath(monthDir, rootReal)
    if (!monthReal) return null
    const content = safeReadFile(monthDir, monthReal, filename, MAX_MEETING_BYTES)
    if (content === null) return null

    const kind = match[2] as ImportedRecordKind
    const detail = parseMeeting(content, filename, month)
    // The table carries `YYYY-MM-DD HH:MM`, so the raw field is a date AND a
    // time. list() splits them; detail() has to split them the same way or the
    // row and the record it opens disagree about when the meeting happened.
    const stamp = extractMeetingDateTime(content, filename)
    const originDomain = originDomainFromSidecarHead(
      safeReadFileHead(monthDir, monthReal, sidecarFilenameFor(filename), IMPORT_SIDECAR_HEAD_BYTES),
    )
    return {
      ...detail,
      date: stamp.date,
      ...(stamp.time ? { time: stamp.time } : {}),
      domain: IMPORTED_DOMAIN,
      domainAbbr: domainAbbreviation(originDomain),
      originDomain,
      librarySource: kind === 'fireflies' ? 'imported' : 'blended',
      recordId: importRecordId(kind, match[3]),
      mutable: false,
      ...(kind === 'merged' ? { derivedKind: 'merge' as const } : {}),
      ...(kind === 'piece' ? { derivedKind: 'split' as const } : {}),
    }
  }

  /** The record's evidence. Bounded well above markdown: this is where the
   *  unedited sentences, fingerprints and per-sentence labels live. */
  readSidecar(month: string, filename: string): unknown | null {
    if (!IMPORTED_MONTH_PATTERN.test(month) || !IMPORTED_FILENAME_PATTERN.test(filename)) return null
    const rootReal = this.rootReal()
    if (!rootReal) return null
    const monthDir = join(this.root, month)
    const monthReal = safeDirectoryRealpath(monthDir, rootReal)
    if (!monthReal) return null
    const text = safeReadFile(monthDir, monthReal, sidecarFilenameFor(filename), IMPORT_SIDECAR_MAX_BYTES)
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /**
   * Startup sweep: temp files from a killed write, and sidecars whose markdown
   * never landed. Both are invisible to every reader, so they are debris rather
   * than data, and leaving them means a crashed backfill silently fills the
   * data home.
   *
   * SKIPPED WHILE A WRITER HOLDS THE LEASE. Mid-write, a sidecar with no
   * markdown is the correct intermediate state, and deleting it would destroy
   * the evidence of a record that is about to exist.
   */
  sweep(options: { isBusy?: () => boolean } = {}): { removedTemp: number; removedSidecars: number; skipped: boolean } {
    if (options.isBusy?.()) return { removedTemp: 0, removedSidecars: 0, skipped: true }
    const rootReal = this.rootReal()
    if (!rootReal) return { removedTemp: 0, removedSidecars: 0, skipped: false }
    let removedTemp = 0
    let removedSidecars = 0

    const removeFile = (directory: string, name: string): boolean => {
      const path = join(directory, name)
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !stat.isFile()) return false
        unlinkSync(path)
        return true
      } catch {
        return false
      }
    }

    for (const name of readdirSync(this.root)) {
      if (IMPORTED_TEMP_PATTERN.test(name) && removeFile(this.root, name)) removedTemp += 1
    }

    for (const month of this.months(rootReal)) {
      const monthDir = join(this.root, month)
      if (!safeDirectoryRealpath(monthDir, rootReal)) continue
      const names = readdirSync(monthDir)
      const present = new Set(names)
      for (const name of names) {
        if (IMPORTED_TEMP_PATTERN.test(name)) {
          if (removeFile(monthDir, name)) removedTemp += 1
          continue
        }
        if (!IMPORTED_SIDECAR_PATTERN.test(name)) continue
        const markdown = name.replace(/\.(?:import|derived)\.json$/, '.md')
        if (!present.has(markdown) && removeFile(monthDir, name)) removedSidecars += 1
      }
    }

    return { removedTemp, removedSidecars, skipped: false }
  }
}

let library: ImportedMeetingLibrary | null = null

export function getImportedMeetingLibrary(): ImportedMeetingLibrary {
  library ??= new ImportedMeetingLibrary()
  return library
}
