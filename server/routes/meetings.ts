// Meeting archive: COS operations tree when configured, else standalone recordings.

import { Router } from 'express'
import { getMeetingStore, MeetingStore, MeetingStoreError } from '../lib/meeting-store.js'
import {
  cosOperationsMeetingsConfigured,
  getDirectLibraryMeetingDetail,
  getCosOperationsMeetingDetail,
  listDirectLibraryMeetings,
  listDirectLibraryMeetingMonths,
  listCosOperationsMeetings,
  listCosOperationsMeetingMonths,
  resolveMeetingLibrary,
} from '../lib/cos-operations-meetings.js'
import type { MeetingMeta } from '../lib/meeting-store.js'
import { meetingListLimit } from '../lib/meeting-store.js'
import { searchMeetingLibrary } from '../lib/meeting-library-search.js'
import { g2RecordingsReachOperations } from '../lib/g2-ops-handoff.js'
import {
  type ImportedMeetingLibrary,
  IMPORTED_DOMAIN,
  getImportedMeetingLibrary,
} from '../lib/imported-meeting-library.js'
import {
  type DerivedRecordSummary,
  derivedSourcesFor,
  dropSupersededRows,
  importedLibraryMonths,
  listImportedLibraryRows,
  readDerivedRecords,
  supersededDayCounts,
  supersededFromRows,
  supersededInputsOf,
  withDerivedIdentity,
} from '../lib/imported-library-rows.js'

const MONTH_QUERY = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_QUERY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * The only filenames the imported branch of detail will answer for.
 *
 * Deliberately stricter than "is it in the imports folder": a G2 recording whose
 * TITLE contains the word "merged" produces a store filename that must keep
 * resolving through the store, and a hand-dropped or iCloud-conflicted file in
 * the imports root must not be served as a record. The branch falls through on a
 * miss rather than 404ing, so a near-miss is answered by the next source.
 */
export const IMPORTED_DETAIL_FILENAME = /^\d{4}-\d{2}-\d{2}_(?:fireflies|merged|piece)_[0-9a-f]{16}\.md$/

function withStandaloneIdentity(meeting: MeetingMeta): MeetingMeta {
  return {
    ...meeting,
    librarySource: 'standalone_recordings',
    recordId: `standalone:${meeting.sessionId || `${meeting.domain}:${meeting.month}:${meeting.filename}`}`,
    mutable: true,
  }
}

function mergeMeetingSources(groups: MeetingMeta[][], limit: number, max = 50): MeetingMeta[] {
  const seenSessions = new Set<string>()
  const seenExact = new Set<string>()
  const merged: MeetingMeta[] = []
  for (const group of groups) {
    for (const meeting of group) {
      if (meeting.sessionId) {
        if (seenSessions.has(meeting.sessionId)) continue
        seenSessions.add(meeting.sessionId)
      } else {
        const exact = `${meeting.librarySource || ''}:${meeting.domain}:${meeting.month}:${meeting.filename}`
        if (seenExact.has(exact)) continue
        seenExact.add(exact)
      }
      merged.push(meeting)
    }
  }
  merged.sort((a, b) => `${b.date}T${b.time || '00:00'}`.localeCompare(`${a.date}T${a.time || '00:00'}`)
    || b.filename.localeCompare(a.filename))
  return merged.slice(0, Math.min(Math.max(limit, 1), max))
}

function parseListFilters(query: { month?: unknown; day?: unknown }): {
  month?: string
  day?: string
  error?: { status: number; body: { error: string; reason: string } }
} {
  const rawMonth = typeof query.month === 'string' ? query.month : ''
  const rawDay = typeof query.day === 'string' ? query.day : ''
  if (rawMonth && !MONTH_QUERY.test(rawMonth)) {
    return { error: { status: 400, body: { error: 'Invalid month', reason: 'invalid_month' } } }
  }
  if (rawDay && !DAY_QUERY.test(rawDay)) {
    return { error: { status: 400, body: { error: 'Invalid day', reason: 'invalid_day' } } }
  }
  if (rawDay && rawMonth && !rawDay.startsWith(`${rawMonth}-`)) {
    return { error: { status: 400, body: { error: 'day is not in month', reason: 'month_day_mismatch' } } }
  }
  const day = rawDay || undefined
  const month = rawMonth || (day ? day.slice(0, 7) : undefined)
  return { month, day }
}

function uniqueSortedMonths(groups: string[][]): string[] {
  return [...new Set(groups.flat())].sort().reverse()
}

/**
 * Detail for one record of the imported library, or null to fall through.
 *
 * NULL, NEVER 404. The three detail sources share one URL shape, and a record
 * that is not here may still be an operations meeting or a store recording, so a
 * miss has to hand the request on. The two gates — the routing domain and the
 * strict filename — are what keep an ordinary meeting out of this branch.
 *
 * A merged record answers with `sources[]`, each input naming the record that
 * still holds it. Nothing is read from the client: the record's own sidecar is
 * the only thing consulted.
 */
function importedMeetingDetail(
  domain: string,
  month: string,
  filename: string,
  store: MeetingStore,
  library: ImportedMeetingLibrary,
): MeetingMeta | null {
  if (domain !== IMPORTED_DOMAIN) return null
  if (!IMPORTED_DETAIL_FILENAME.test(filename)) return null
  const detail = library.detail(month, filename)
  if (!detail) return null
  if (detail.librarySource !== 'blended') return detail as MeetingMeta
  const record = readDerivedRecords(library).find(entry => entry.recordId === detail.recordId)
  if (!record) return detail as MeetingMeta
  return {
    ...withDerivedIdentity(detail as MeetingMeta, record),
    sources: derivedSourcesFor(record, store),
  }
}

/**
 * The imported library's contribution to one list request.
 *
 * Read ONCE per request: the derived sidecars decide both what the derived rows
 * say about themselves and which G2, import and long-original rows they have
 * taken over, and reading them twice would let a write between the two reads
 * show a meeting and its merged replacement side by side.
 */
function importedContribution(
  options: { limit: number; domain: string; month?: string; day?: string },
  library: ImportedMeetingLibrary,
): {
  imports: MeetingMeta[]
  derived: MeetingMeta[]
  records: DerivedRecordSummary[]
  drop: (rows: MeetingMeta[]) => MeetingMeta[]
  present: boolean
} {
  const records = readDerivedRecords(library)
  const { imports, derived } = listImportedLibraryRows(options, library, records)
  const superseded = supersededInputsOf(records)
  return {
    imports,
    derived,
    records,
    drop: rows => dropSupersededRows(rows, superseded),
    present: imports.length > 0 || derived.length > 0,
  }
}

export function createMeetingsRouter(
  store: MeetingStore = getMeetingStore(),
  // Injectable so a test can drive a whole imports library without reaching the
  // process-wide data home. Production passes nothing and gets the singleton.
  importsLibrary: ImportedMeetingLibrary = getImportedMeetingLibrary(),
): Router {
  const router = Router()

  // GET /api/meetings?limit=20&domain=all
  // Optional month=YYYY-MM and day=YYYY-MM-DD raise the cap to 200 and
  // return `months` / `days` for the Control calendar. G2 omits those
  // filters and still receives at most 50 rows.
  router.get('/meetings', (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
      const domain = typeof req.query.domain === 'string' ? req.query.domain : 'all'
      const filters = parseListFilters(req.query)
      if (filters.error) {
        res.status(filters.error.status).json(filters.error.body)
        return
      }
      const scoped = Boolean(filters.month || filters.day)
      const limit = meetingListLimit(Number.isFinite(rawLimit) ? rawLimit : 20, scoped)
      const sourceLimit = scoped ? 200 : 50
      res.set('Cache-Control', 'private, no-store')

      const library = resolveMeetingLibrary()
      if (library.layout === 'invalid_explicit_root') {
        res.status(409).json({
          error: 'Configured meetings library is unavailable or malformed',
          reason: 'invalid_explicit_root',
          layout: library.layout,
          warnings: library.warnings,
        })
        return
      }

      const listOptions = { limit: sourceLimit, domain, month: filters.month, day: filters.day }

      if (library.layout === 'direct') {
        const imported = importedContribution(listOptions, importsLibrary)
        const operations = cosOperationsMeetingsConfigured()
          ? listCosOperationsMeetings(listOptions)
          : []
        const direct = domain === 'all' || domain === 'library'
          ? listDirectLibraryMeetings({ limit: sourceLimit, month: filters.month, day: filters.day })
          : []
        const standalone = store.list(listOptions).map(withStandaloneIdentity)
        // Derived rows lead. They carry the sessionId of the earliest capture they
        // hold, so leading makes a merged record win that session outright even if
        // its sidecar became unreadable and the supersession filter went quiet.
        const meetings = mergeMeetingSources([
          imported.derived,
          imported.drop(operations),
          imported.drop(direct),
          imported.drop(standalone),
          imported.drop(imported.imports),
        ], limit, sourceLimit)
        const months = uniqueSortedMonths([
          ...(cosOperationsMeetingsConfigured() ? [listCosOperationsMeetingMonths(domain)] : []),
          ...(domain === 'all' || domain === 'library' ? [listDirectLibraryMeetingMonths()] : []),
          store.listMonths(),
          importedLibraryMonths(importsLibrary),
        ])
        const days = filters.month
          ? supersededDayCounts(filters.month, 'direct', { domain, store, library: importsLibrary })
          : []
        res.json({
          meetings,
          months,
          days,
          source: operations.length > 0 || imported.present ? 'mixed_library' : 'direct_library',
          layout: 'direct',
          root: library.root,
          rootFingerprint: library.rootFingerprint,
          meetingCount: meetings.length,
          warnings: library.warnings,
        })
        return
      }

      if (library.layout === 'multi_domain') {
        if (g2RecordingsReachOperations()) {
          // The pipeline owns this tree, so the tree is the whole library: no
          // imports, no derived records from `data/imports`. A merge here was
          // spliced into the Fireflies scribe, which declares the captures it
          // holds, so the capture's own row is dropped from its own tree.
          const rows = listCosOperationsMeetings({
            limit,
            domain,
            month: filters.month,
            day: filters.day,
          })
          const declaredSessions = supersededFromRows(rows).g2Sessions
          const meetings = dropSupersededRows(rows, { g2Sessions: declaredSessions, importRecordIds: new Set<string>(), isEmpty: declaredSessions.size === 0 })
          // ONLY WHEN THE LIST SAW THE WHOLE MONTH. The row list is capped, and a capped
          // list knows about fewer merged scribes than the month holds, so handing its
          // sessions to an UNCAPPED day count would subtract too little and put the dot
          // back above the row. A capped page pays for the scan instead.
          const listSawWholeMonth = rows.length < limit
          res.json({
            meetings,
            months: listCosOperationsMeetingMonths(domain),
            // The rows above already read every scribe in this month and told us which
            // sessions the merged ones hold. Handing that over is the difference between
            // one read per file and two on every month request.
            days: filters.month
              ? supersededDayCounts(filters.month, 'multi_domain', {
                  domain,
                  store,
                  library: importsLibrary,
                  pipeline: true,
                  ...(listSawWholeMonth ? { declaredSessions } : {}),
                })
              : [],
            source: 'cos_operations',
            layout: 'multi_domain',
            root: library.root,
            rootFingerprint: library.rootFingerprint,
            meetingCount: meetings.length,
            warnings: library.warnings,
          })
          return
        }

        // No COS pipeline can file this Mac's G2 recordings into the operations folder (a Starter Kit library
        // without COS_SCRIPTS_DIR, 2026-09-14), so they live only in this server's store. List them beside the
        // operations rows. Operations rows go first, so a copy that did reach operations wins by sessionId, and
        // the day counts skip the store row it covers. Day counts always describe the whole month.
        const imported = importedContribution(listOptions, importsLibrary)
        const operations = listCosOperationsMeetings(listOptions)
        const standalone = store.list(listOptions).map(withStandaloneIdentity)
        const meetings = mergeMeetingSources([
          imported.derived,
          imported.drop(operations),
          imported.drop(standalone),
          imported.drop(imported.imports),
        ], limit, sourceLimit)
        const days = filters.month
          ? supersededDayCounts(filters.month, 'multi_domain', { domain, store, library: importsLibrary, pipeline: false })
          : []
        res.json({
          meetings,
          months: uniqueSortedMonths([
            listCosOperationsMeetingMonths(domain),
            store.listMonths(),
            importedLibraryMonths(importsLibrary),
          ]),
          days,
          source: standalone.length > 0 || imported.present ? 'mixed_library' : 'cos_operations',
          layout: 'multi_domain',
          root: library.root,
          rootFingerprint: library.rootFingerprint,
          meetingCount: meetings.length,
          warnings: library.warnings,
        })
        return
      }

      const imported = importedContribution(listOptions, importsLibrary)
      const standalone = store.list({
        limit: sourceLimit,
        domain,
        month: filters.month,
        day: filters.day,
      }).map(withStandaloneIdentity)
      const meetings = mergeMeetingSources([
        imported.derived,
        imported.drop(standalone),
        imported.drop(imported.imports),
      ], limit, sourceLimit)
      res.json({
        meetings,
        months: uniqueSortedMonths([store.listMonths(), importedLibraryMonths(importsLibrary)]),
        days: filters.month ? supersededDayCounts(filters.month, 'standalone', { domain, store, library: importsLibrary }) : [],
        source: imported.present ? 'mixed_library' : 'standalone_recordings',
        layout: 'standalone',
        meetingCount: meetings.length,
      })
    } catch (error) {
      sendMeetingStoreError(res, error)
    }
  })

  // Literal path before /meetings/:domain/:month/:filename.
  router.get('/meetings/search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (query.length < 2) {
        res.status(400).json({ error: 'q must be at least 2 characters', reason: 'invalid_query' })
        return
      }
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
      const domain = typeof req.query.domain === 'string' ? req.query.domain : 'all'
      res.set('Cache-Control', 'private, no-store')
      const result = await searchMeetingLibrary({
        query,
        domain,
        limit: Number.isFinite(rawLimit) ? rawLimit : 20,
      }, store)
      res.json(result)
    } catch (error) {
      sendMeetingStoreError(res, error)
    }
  })

  // Query-form detail is convenient for generic API consumers. Register the
  // literal route before the build199 dynamic compatibility route.
  router.get('/meetings/detail', (req, res) => {
    try {
      const domain = typeof req.query.domain === 'string' ? req.query.domain : ''
      const month = typeof req.query.month === 'string' ? req.query.month : ''
      const filename = typeof req.query.filename === 'string' ? req.query.filename : ''
      if (!domain || !month || !filename) {
        res.status(400).json({ error: 'domain, month, and filename are required', reason: 'invalid_meeting_ref' })
        return
      }
      res.set('Cache-Control', 'private, no-store')

      if (domain === 'library') {
        const detail = getDirectLibraryMeetingDetail(month, filename)
        if (detail) {
          res.json(detail)
          return
        }
      }

      const imported = importedMeetingDetail(domain, month, filename, store, importsLibrary)
      if (imported) {
        res.json(imported)
        return
      }

      if (cosOperationsMeetingsConfigured()) {
        const detail = getCosOperationsMeetingDetail(domain, month, filename)
        if (detail) {
          res.json(detail)
          return
        }
        // Fall through to standalone store for G2-local recordings that share
        // the same API shape when ops lookup misses.
      }

      res.json(store.detail(domain, month, filename))
    } catch (error) {
      sendMeetingStoreError(res, error)
    }
  })

  // Build199 compatibility: detail requests carry the list row's domain even
  // though standalone files all live in one fixed recordings/YYYY-MM store.
  router.get('/meetings/:domain/:month/:filename', (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store')

      if (req.params.domain === 'library') {
        const detail = getDirectLibraryMeetingDetail(req.params.month, req.params.filename)
        if (detail) {
          res.json(detail)
          return
        }
      }

      const imported = importedMeetingDetail(
        req.params.domain,
        req.params.month,
        req.params.filename,
        store,
        importsLibrary,
      )
      if (imported) {
        res.json(imported)
        return
      }

      if (cosOperationsMeetingsConfigured()) {
        const detail = getCosOperationsMeetingDetail(
          req.params.domain,
          req.params.month,
          req.params.filename,
        )
        if (detail) {
          res.json(detail)
          return
        }
      }

      res.json(store.detail(req.params.domain, req.params.month, req.params.filename))
    } catch (error) {
      sendMeetingStoreError(res, error)
    }
  })

  return router
}

function sendMeetingStoreError(
  res: { status: (status: number) => { json: (body: unknown) => unknown } },
  error: unknown,
): unknown {
  if (error instanceof MeetingStoreError) {
    return res.status(error.status).json({ error: error.message, reason: error.code })
  }
  console.error('[meetings] Store read failed:', error)
  return res.status(500).json({ error: 'Meeting store unavailable', reason: 'meeting_store_error' })
}

export const meetingsRouter = createMeetingsRouter()
