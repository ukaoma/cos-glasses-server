// Meeting archive: COS operations tree when configured, else standalone recordings.

import { Router } from 'express'
import { getMeetingStore, MeetingStore, MeetingStoreError } from '../lib/meeting-store.js'
import {
  cosOperationsMeetingsConfigured,
  getDirectLibraryMeetingDetail,
  getCosOperationsMeetingDetail,
  listDirectLibraryMeetings,
  listDirectLibraryMeetingDays,
  listDirectLibraryMeetingMonths,
  listCosOperationsMeetings,
  listCosOperationsMeetingDays,
  listCosOperationsMeetingMonths,
  resolveMeetingLibrary,
} from '../lib/cos-operations-meetings.js'
import type { MeetingMeta } from '../lib/meeting-store.js'
import { meetingListLimit } from '../lib/meeting-store.js'
import { searchMeetingLibrary } from '../lib/meeting-library-search.js'

const MONTH_QUERY = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_QUERY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

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

function mergeDayCounts(
  groups: Array<Array<{ date: string; count: number }>>,
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  for (const group of groups) {
    for (const { date, count } of group) {
      counts.set(date, (counts.get(date) ?? 0) + count)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }))
}

function uniqueSortedMonths(groups: string[][]): string[] {
  return [...new Set(groups.flat())].sort().reverse()
}

export function createMeetingsRouter(store: MeetingStore = getMeetingStore()): Router {
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
        const operations = cosOperationsMeetingsConfigured()
          ? listCosOperationsMeetings(listOptions)
          : []
        const direct = domain === 'all' || domain === 'library'
          ? listDirectLibraryMeetings({ limit: sourceLimit, month: filters.month, day: filters.day })
          : []
        const standalone = store.list(listOptions).map(withStandaloneIdentity)
        const meetings = mergeMeetingSources([operations, direct, standalone], limit, sourceLimit)
        const months = uniqueSortedMonths([
          ...(cosOperationsMeetingsConfigured() ? [listCosOperationsMeetingMonths(domain)] : []),
          ...(domain === 'all' || domain === 'library' ? [listDirectLibraryMeetingMonths()] : []),
          store.listMonths(),
        ])
        const days = filters.month
          ? mergeDayCounts([
            ...(cosOperationsMeetingsConfigured() ? [listCosOperationsMeetingDays(filters.month, domain)] : []),
            ...(domain === 'all' || domain === 'library' ? [listDirectLibraryMeetingDays(filters.month)] : []),
            store.listDayCounts(filters.month),
          ])
          : []
        res.json({
          meetings,
          months,
          days,
          source: operations.length > 0 ? 'mixed_library' : 'direct_library',
          layout: 'direct',
          root: library.root,
          rootFingerprint: library.rootFingerprint,
          meetingCount: meetings.length,
          warnings: library.warnings,
        })
        return
      }

      if (library.layout === 'multi_domain') {
        const meetings = listCosOperationsMeetings({
          limit,
          domain,
          month: filters.month,
          day: filters.day,
        })
        res.json({
          meetings,
          months: listCosOperationsMeetingMonths(domain),
          days: filters.month ? listCosOperationsMeetingDays(filters.month, domain) : [],
          source: 'cos_operations',
          layout: 'multi_domain',
          root: library.root,
          rootFingerprint: library.rootFingerprint,
          meetingCount: meetings.length,
          warnings: library.warnings,
        })
        return
      }

      const meetings = store.list({
        limit,
        domain,
        month: filters.month,
        day: filters.day,
      }).map(withStandaloneIdentity)
      res.json({
        meetings,
        months: store.listMonths(),
        days: filters.month ? store.listDayCounts(filters.month) : [],
        source: 'standalone_recordings',
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
