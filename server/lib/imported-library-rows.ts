/**
 * Rows for the imported library, and the supersession rule (6.47.0, WS5).
 *
 * WHAT SUPERSESSION IS. A merge is ADDITIVE: the Fireflies import, the G2
 * recordings and the merged record all exist on disk afterwards, because that is
 * what makes Undo possible (D12). But a person scrolling their meetings must see
 * ONE row for one meeting, so the LIST drops the inputs a derived record already
 * holds. Nothing is deleted; the sources stay reachable from the merged record's
 * detail through its `sources[]`.
 *
 * WHY A FILTER RATHER THAN A MERGE RULE. `mergeMeetingSources` dedupes by
 * sessionId, and 6.46.1 leans on its group ORDER so an operations copy beats the
 * store copy of the same capture. Teaching it about derived records would have
 * meant a second precedence rule inside the first. Worse, a split piece has NO
 * sessionId (it is a span of a recording, not a capture), so two pieces of one
 * recording would have collapsed onto each other. Supersession therefore runs
 * BEFORE the merge, as its own pass, and derived rows dedupe on `recordId`.
 *
 * COST. Every helper here is free until a derived record exists: the scan reads
 * the imports root's `.derived.json` sidecars, and when there are none, each
 * function returns its input untouched without opening a meeting file. That
 * matters because `probeMeetings` sums day counts across every month on every
 * morning brief.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'
import {
  cosOperationsMeetingsConfigured,
  discoverMeetingDomains,
  findCosOperationsMeetingBySessionId,
  listCosOperationsMeetingDays,
  listDirectLibraryMeetingDays,
  mergedScribeSessions,
  resolveCosOperationsDir,
  resolveMeetingLibrary,
  sidecarSessionId,
} from './cos-operations-meetings.js'
import { g2RecordingsReachOperations } from './g2-ops-handoff.js'
import {
  type ImportedMeetingLibrary,
  type ImportedRecordKind,
  IMPORTED_DOMAIN,
  IMPORTED_FILENAME_PATTERN,
  IMPORTED_MONTH_PATTERN,
  getImportedMeetingLibrary,
  importHash,
  importRecordId,
} from './imported-meeting-library.js'
import { getMeetingStore, type MeetingMeta, type MeetingStore } from './meeting-store.js'

/** The merged-scribe markers live with the scribe reader; re-exported for callers. */
export {
  G2_SESSION_MARKER,
  MERGE_ACTION_MARKER,
  mergedScribeActionId,
  mergedScribeSessions,
} from './cos-operations-meetings.js'

const DAY_FILE_PREFIX = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))_/
/** The month folder a day-prefixed filename belongs to. */
const MONTH_FROM_DAY_FILE = /^(\d{4}-(?:0[1-9]|1[0-2]))-(?:0[1-9]|[12]\d|3[01])_/

/** One derived record's identity and inputs, read from its `.derived.json`. */
export interface DerivedRecordSummary {
  recordId: string
  month: string
  filename: string
  kind: 'merge' | 'split'
  actionId?: string
  /** G2 captures the record holds, in the sidecar's own order (start order). */
  g2SessionIds: string[]
  /** Fireflies meetings the record holds: the primary first, then alternates. */
  firefliesIds: string[]
  pieceIndex?: number
  /** The capture whose content defined a split piece, when it names one. */
  sourceSessionId?: string
}

/** Everything a derived record has taken over. Empty until one exists. */
export interface SupersededInputs {
  g2Sessions: Set<string>
  /** `imported:fireflies:<h16>` record ids of the imports a derived record holds. */
  importRecordIds: Set<string>
  isEmpty: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one `.derived.json` into the fields the surfaces need.
 *
 * Tolerant on purpose: a sidecar from a newer version, or one that lost a field,
 * must degrade to "this record exists" rather than take the whole list down with
 * it. The one field it cannot do without is `inputs`, because that is what
 * supersession is computed from.
 */
export function summarizeDerivedSidecar(
  sidecar: unknown,
  ref: { recordId: string; month: string; filename: string; kind: ImportedRecordKind },
): DerivedRecordSummary | null {
  const doc = asRecord(sidecar)
  if (!doc) return null
  const inputs = Array.isArray(doc.inputs) ? doc.inputs : []
  const g2SessionIds: string[] = []
  const firefliesIds: string[] = []
  for (const entry of inputs) {
    const input = asRecord(entry)
    if (!input) continue
    const id = stringField(input, 'id')
    if (!id) continue
    if (input.kind === 'g2') g2SessionIds.push(id)
    else if (input.kind === 'fireflies') firefliesIds.push(id)
  }
  const pieces = Array.isArray(doc.pieces) ? doc.pieces : []
  const firstPiece = asRecord(pieces[0])
  const pieceIndex = typeof firstPiece?.index === 'number' && Number.isInteger(firstPiece.index)
    ? firstPiece.index
    : undefined
  const pieceSessions = Array.isArray(firstPiece?.sessionIds) ? firstPiece.sessionIds : []
  const sourceSessionId = typeof pieceSessions[0] === 'string' ? pieceSessions[0] as string : undefined
  const actionId = stringField(doc, 'actionId')

  return {
    recordId: ref.recordId,
    month: ref.month,
    filename: ref.filename,
    kind: ref.kind === 'piece' ? 'split' : 'merge',
    ...(actionId ? { actionId } : {}),
    g2SessionIds,
    firefliesIds,
    ...(ref.kind === 'piece' && pieceIndex !== undefined ? { pieceIndex } : {}),
    ...(ref.kind === 'piece' && sourceSessionId ? { sourceSessionId } : {}),
  }
}

/** Derived record filenames on disk, without opening anything. */
function derivedFilenames(
  library: ImportedMeetingLibrary,
): Array<{ month: string; filename: string; kind: ImportedRecordKind; hash: string }> {
  const found: Array<{ month: string; filename: string; kind: ImportedRecordKind; hash: string }> = []
  let months: string[]
  try {
    months = readdirSync(library.root).filter(name => IMPORTED_MONTH_PATTERN.test(name))
  } catch {
    return found
  }
  for (const month of months) {
    let names: string[]
    try {
      names = readdirSync(join(library.root, month))
    } catch {
      continue
    }
    for (const filename of names) {
      const match = filename.match(IMPORTED_FILENAME_PATTERN)
      if (!match) continue
      const kind = match[2] as ImportedRecordKind
      if (kind === 'fireflies') continue
      found.push({ month, filename, kind, hash: match[3] })
    }
  }
  return found
}

/**
 * Every derived record in the imports library.
 *
 * Reads only the derived sidecars — never a markdown file — through the
 * library's own bounded reader, so a 32 MiB sidecar is capped and an iCloud
 * conflict copy is refused by the filename pattern before it is opened.
 */
export function readDerivedRecords(
  library: ImportedMeetingLibrary = getImportedMeetingLibrary(),
): DerivedRecordSummary[] {
  const records: DerivedRecordSummary[] = []
  for (const { month, filename, kind, hash } of derivedFilenames(library)) {
    const summary = summarizeDerivedSidecar(library.readSidecar(month, filename), {
      recordId: importRecordId(kind, hash),
      month,
      filename,
      kind,
    })
    if (summary) records.push(summary)
  }
  return records
}

export function supersededInputsOf(records: readonly DerivedRecordSummary[]): SupersededInputs {
  const g2Sessions = new Set<string>()
  const importRecordIds = new Set<string>()
  for (const record of records) {
    for (const sessionId of record.g2SessionIds) g2Sessions.add(sessionId)
    for (const firefliesId of record.firefliesIds) {
      importRecordIds.add(importRecordId('fireflies', importHash(firefliesId)))
    }
  }
  return { g2Sessions, importRecordIds, isEmpty: g2Sessions.size === 0 && importRecordIds.size === 0 }
}

/**
 * Drop the rows a derived record already holds.
 *
 * A row is superseded when its session is one a derived record holds, or when it
 * IS the import a derived record holds. A derived row is never superseded: pieces
 * of one long recording each stand alone, and grouping (WS3) guarantees one
 * merged record per capture.
 */
export function dropSupersededRows(rows: readonly MeetingMeta[], superseded: SupersededInputs): MeetingMeta[] {
  if (superseded.isEmpty) return [...rows]
  return rows.filter(row => {
    if (row.derivedKind) return true
    if (row.recordId && superseded.importRecordIds.has(row.recordId)) return false
    if (row.sessionId && superseded.g2Sessions.has(row.sessionId)) return false
    return true
  })
}

/** Derived rows dedupe on `recordId`, because a split piece has no session. */
export function dedupeDerivedRows(rows: readonly MeetingMeta[]): MeetingMeta[] {
  const seen = new Set<string>()
  const kept: MeetingMeta[] = []
  for (const row of rows) {
    const key = row.recordId ?? `${row.month}:${row.filename}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(row)
  }
  return kept
}

export function withDerivedIdentity(row: MeetingMeta, record: DerivedRecordSummary | undefined): MeetingMeta {
  if (!record) return row
  const identified: MeetingMeta = { ...row }
  if (record.actionId) identified.actionId = record.actionId
  if (record.kind === 'merge') {
    // The earliest capture, so the row that replaced it can still open the
    // speaker panel. `g2SessionIds` keeps the rest reachable.
    if (record.g2SessionIds.length > 0) {
      identified.sessionId = record.g2SessionIds[0]
      identified.g2SessionIds = [...record.g2SessionIds]
    }
  } else {
    // A piece is a SPAN, not a capture. A sessionId here would make two pieces of
    // one recording collapse onto each other in mergeMeetingSources.
    delete identified.sessionId
    if (record.pieceIndex !== undefined) identified.pieceIndex = record.pieceIndex
    if (record.sourceSessionId) identified.sourceSessionId = record.sourceSessionId
  }
  return identified
}

/**
 * The imported library's rows, split into imports and derived records, with the
 * derived rows carrying their action and their inputs.
 *
 * The limit is doubled before it reaches the library because supersession runs
 * after this: a superseded import and the merged record that replaced it are two
 * rows on the same date, and asking for exactly `limit` would let the pair push
 * an older meeting out of a page that ends up holding only one of them.
 */
export function listImportedLibraryRows(
  options: { limit?: number; domain?: string; month?: string; day?: string } = {},
  library: ImportedMeetingLibrary = getImportedMeetingLibrary(),
  records: readonly DerivedRecordSummary[] = readDerivedRecords(library),
): { imports: MeetingMeta[]; derived: MeetingMeta[] } {
  const byRecordId = new Map(records.map(record => [record.recordId, record]))
  const imports: MeetingMeta[] = []
  const derived: MeetingMeta[] = []
  const rows = library.list({
    ...options,
    ...(typeof options.limit === 'number' ? { limit: options.limit * 2 } : {}),
  })
  for (const row of rows) {
    if (row.librarySource === 'imported') {
      imports.push(row as MeetingMeta)
      continue
    }
    derived.push(withDerivedIdentity(row as MeetingMeta, byRecordId.get(row.recordId)))
  }
  return { imports, derived: dedupeDerivedRows(derived) }
}

/** Month folders of the imported library, newest first. */
export function importedLibraryMonths(
  library: ImportedMeetingLibrary = getImportedMeetingLibrary(),
): string[] {
  try {
    return readdirSync(library.root).filter(name => IMPORTED_MONTH_PATTERN.test(name)).sort().reverse()
  } catch {
    return []
  }
}

/**
 * A derived record's inputs, each with the record id that opens it.
 *
 * This is how "merged automatically" stays honest: the sources are not gone, and
 * the detail names exactly where each one still lives. A G2 input's id is
 * resolved against the trees rather than assumed, because the same capture is
 * `ops:...` on one Mac and `standalone:...` on another, and a link built from the
 * wrong assumption opens nothing.
 */
export function derivedSourcesFor(
  record: DerivedRecordSummary,
  store: MeetingStore = getMeetingStore(),
): NonNullable<MeetingMeta['sources']> {
  const sources: NonNullable<MeetingMeta['sources']> = []
  for (const id of record.firefliesIds) {
    sources.push({ kind: 'fireflies', id, recordId: importRecordId('fireflies', importHash(id)) })
  }
  for (const id of record.g2SessionIds) {
    const recordId = g2RecordIdFor(id, store)
    sources.push({ kind: 'g2', id, ...(recordId ? { recordId } : {}) })
  }
  return sources
}

function g2RecordIdFor(sessionId: string, store: MeetingStore): string | undefined {
  if (cosOperationsMeetingsConfigured()) {
    const operations = findCosOperationsMeetingBySessionId(sessionId)
    if (operations) return `ops:${operations.domain}:${operations.month}:${operations.filename}`
  }
  try {
    return store.findBySessionId(sessionId) ? `standalone:${sessionId}` : undefined
  } catch {
    return undefined
  }
}

/** The derived record behind a `blended:` row, or null when there is none. */
export function findDerivedRecord(
  recordId: string,
  library: ImportedMeetingLibrary = getImportedMeetingLibrary(),
): DerivedRecordSummary | null {
  if (!/^blended:[0-9a-f]{16}$/.test(recordId)) return null
  return readDerivedRecords(library).find(record => record.recordId === recordId) ?? null
}

/**
 * Sessions the rows in hand already declare they hold.
 *
 * Used for the operations tree, where a merged scribe carries its inputs as
 * `<!-- g2-session -->` markers rather than a `.derived.json`: the list has the
 * markers in hand, so the filter costs nothing beyond what it already read.
 */
export function supersededFromRows(rows: readonly MeetingMeta[]): SupersededInputs {
  const g2Sessions = new Set<string>()
  for (const row of rows) {
    if (!row.derivedKind) continue
    for (const sessionId of row.g2SessionIds ?? []) g2Sessions.add(sessionId)
    if (row.sessionId) g2Sessions.add(row.sessionId)
  }
  return { g2Sessions, importRecordIds: new Set<string>(), isEmpty: g2Sessions.size === 0 }
}

/** Day counts from filenames, summed across groups. Shared with the list. */
export function mergeDayCounts(
  groups: Array<Array<{ date: string; count: number }>>,
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  for (const group of groups) {
    for (const { date, count } of group) {
      counts.set(date, (counts.get(date) ?? 0) + count)
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }))
}

/**
 * Day counts for the imported library in one month.
 *
 * An import a derived record has taken over is dropped, so the calendar dot and
 * the list agree. For `all` and `imported` nothing is opened: the record id is a
 * pure function of the filename's hash. A filter on the meeting's OWN domain has
 * to read each record's sidecar head, which is what `list()` already does.
 */
export function importedLibraryDayCounts(
  month: string,
  superseded: SupersededInputs,
  library: ImportedMeetingLibrary = getImportedMeetingLibrary(),
  domain = 'all',
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  if (domain !== 'all' && domain !== IMPORTED_DOMAIN) {
    for (const row of library.list({ month, domain })) {
      if (row.librarySource === 'imported' && superseded.importRecordIds.has(row.recordId)) continue
      counts.set(row.date, (counts.get(row.date) ?? 0) + 1)
    }
  } else {
    let names: string[]
    try {
      names = readdirSync(join(library.root, month))
    } catch {
      return []
    }
    for (const filename of names) {
      const match = filename.match(IMPORTED_FILENAME_PATTERN)
      if (!match) continue
      const kind = match[2] as ImportedRecordKind
      if (kind === 'fireflies' && superseded.importRecordIds.has(importRecordId('fireflies', match[3]))) continue
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }))
}

// ── Day counts with supersession ─────────────────────────────────────────────
//
// The calendar dot and the list must agree, and the list drops superseded rows,
// so the count has to drop them too. The existing day-count helpers are FILENAME
// scans and are uncapped, which is why they can describe a whole month the
// 50-row list cannot; that property is kept. What is added is a subtraction, and
// the subtraction is the only part that opens a file — a 4 KB sidecar head per
// candidate — so it is gated on there being anything to subtract at all.

export type SupersededLayout = 'direct' | 'multi_domain' | 'standalone'

/**
 * The session a meeting file declares, with the same fallback the LIST uses.
 *
 * The operations tree gitignores `.g2-chunks.json`, so a recording whose markdown arrived
 * through git or iCloud sits there with no sidecar beside it. `listCosOperationsMeetings`
 * handles that by looking under the server's own recordings root by the same stem; this did
 * not, so a row the list DROPPED was still counted, and the calendar dot said two where the
 * list showed one. A count that can disagree with the list it counts is the bug being fixed.
 */
function droppedSessionId(directory: string, filename: string, recordingsRoot: string): string | undefined {
  const direct = sidecarSessionId(directory, filename)
  if (direct) return direct
  const month = filename.match(MONTH_FROM_DAY_FILE)?.[1]
  if (!month) return undefined
  const fallbackDir = join(recordingsRoot, month)
  if (!existsSync(fallbackDir)) return undefined
  return sidecarSessionId(fallbackDir, filename)
}

/** One `-1` per file in `directories` whose chunk sidecar names a dropped session. */
function sessionDropCounts(
  directories: readonly string[],
  sessions: ReadonlySet<string>,
  recordingsRoot: string = dataPath('recordings'),
): Array<{ date: string; count: number }> {
  if (sessions.size === 0) return []
  const drops: Array<{ date: string; count: number }> = []
  for (const directory of directories) {
    let names: string[]
    try {
      names = readdirSync(directory).filter(name => name.endsWith('.md'))
    } catch {
      continue
    }
    for (const filename of names) {
      const date = filename.match(DAY_FILE_PREFIX)?.[1]
      if (!date) continue
      const sessionId = droppedSessionId(directory, filename, recordingsRoot)
      if (!sessionId || !sessions.has(sessionId)) continue
      drops.push({ date, count: -1 })
    }
  }
  return drops
}

/** Month folders of the operations tree that the domain filter admits. */
function operationsMonthDirs(month: string, domainFilter: string): string[] {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return []
  const discovered = discoverMeetingDomains(operationsDir)
  const domains = domainFilter === 'all'
    ? discovered
    : discovered.includes(domainFilter) ? [domainFilter] : []
  return domains.map(domain => join(operationsDir, domain, 'meetings', month))
}


/**
 * Sessions declared by merged scribes in the operations tree for one month.
 *
 * READS EVERY SCRIBE IN THE MONTH, deliberately. A cheaper gate was tried first
 * — scan only where the server has written a pipeline decision file — and it was
 * wrong: the ROW filter reads these markers unconditionally, so a tree holding a
 * merged scribe with no decision file beside it showed one row while the
 * calendar dot said two. A count that can disagree with the list it counts is
 * worse than a count that costs a read, and in this layout the scribe is the
 * only place the merge is recorded.
 *
 * NOT WHEN THE CALLER ALREADY KNOWS. `/api/meetings` has just read every scribe
 * in this month to build its rows, and each merged one told it which sessions it
 * holds. Reading the same files again to learn the same thing doubled the cost
 * of every month request on a pipeline Mac. The caller passes what it declared;
 * only a caller with no list of its own — `probeMeetings` — pays for the scan.
 *
 * The markers sit before `## Transcript`, past the summary, decisions, action
 * items and attendees, so there is no head-sized prefix that reliably holds
 * them: when this does read, it reads the file.
 */
function operationsMergedSessions(
  directories: readonly string[],
  declared: ReadonlySet<string> | undefined,
): Set<string> {
  if (declared) return new Set(declared)
  const sessions = new Set<string>()
  for (const directory of directories) {
    let names: string[]
    try {
      names = readdirSync(directory).filter(name => name.endsWith('.md'))
    } catch {
      continue
    }
    for (const filename of names) {
      let content = ''
      try {
        content = readFileSync(join(directory, filename), 'utf8')
      } catch {
        continue
      }
      for (const sessionId of mergedScribeSessions(content)) sessions.add(sessionId)
    }
  }
  return sessions
}

/**
 * Day counts for one month across every source the list shows, with supersession
 * applied. The list and `probeMeetings` share it so a dot and a row can never
 * disagree about how many meetings a day holds.
 */
export function supersededDayCounts(
  month: string,
  layout: SupersededLayout,
  options: {
    domain?: string
    store?: MeetingStore
    library?: ImportedMeetingLibrary
    /** Whether a COS pipeline files this Mac's recordings. Read live by default. */
    pipeline?: boolean
    /**
     * Sessions the CALLER's rows already declare they hold.
     *
     * `/api/meetings` has just read every scribe in this month; passing what it found here
     * is the difference between one read per file and two. A caller with no list of its own
     * omits it and the scan runs.
     */
    declaredSessions?: ReadonlySet<string>
    /** The server's own recordings root, for the sidecar fallback. Tests point it at a temp dir. */
    recordingsRoot?: string
  } = {},
): Array<{ date: string; count: number }> {
  if (!IMPORTED_MONTH_PATTERN.test(month)) return []
  const domain = options.domain ?? 'all'
  const store = options.store ?? getMeetingStore()
  const library = options.library ?? getImportedMeetingLibrary()
  const superseded = supersededInputsOf(readDerivedRecords(library))

  if (layout === 'multi_domain' && (options.pipeline ?? g2RecordingsReachOperations())) {
    // Operations rows only, as the list shows them. The imports root is not read
    // into this layout at all: on a pipeline Mac the operations tree is the one
    // library, and a derived record here would be a second row for one meeting.
    const directories = operationsMonthDirs(month, domain)
    return mergeDayCounts([
      listCosOperationsMeetingDays(month, domain),
      sessionDropCounts(directories, operationsMergedSessions(directories, options.declaredSessions), options.recordingsRoot),
    ])
  }

  const groups: Array<Array<{ date: string; count: number }>> = []
  const sessionDirectories: string[] = []

  if (layout !== 'standalone' && cosOperationsMeetingsConfigured()) {
    groups.push(listCosOperationsMeetingDays(month, domain))
    sessionDirectories.push(...operationsMonthDirs(month, domain))
  }
  if (layout === 'direct' && (domain === 'all' || domain === 'library')) {
    groups.push(listDirectLibraryMeetingDays(month))
    const root = resolveMeetingLibrary().root
    if (root) sessionDirectories.push(join(root, month))
  }
  // DOMAIN-SCOPED. Every other group here honours the filter; this one did not, so a
  // `domain=quilt` count added every personal recording in the store to it.
  groups.push(store.listDayCounts(month, domain))
  sessionDirectories.push(join(store.root, month))
  groups.push(importedLibraryDayCounts(month, superseded, library, domain))

  if (layout === 'multi_domain') {
    // 6.46.1: an operations copy of a capture wins over the store copy, and the
    // day count skips the store row it covers. Unchanged, and now uncapped.
    const covered = new Set<string>()
    for (const directory of operationsMonthDirs(month, domain)) {
      let names: string[]
      try {
        names = readdirSync(directory).filter(name => name.endsWith('.md'))
      } catch {
        continue
      }
      for (const filename of names) {
        const sessionId = sidecarSessionId(directory, filename)
        if (sessionId) covered.add(sessionId)
      }
    }
    groups.push(sessionDropCounts([join(store.root, month)], covered, options.recordingsRoot))
  }

  groups.push(sessionDropCounts(sessionDirectories, superseded.g2Sessions, options.recordingsRoot))
  return mergeDayCounts(groups)
}
