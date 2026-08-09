// Meeting archive: COS operations tree when configured, else standalone recordings.

import { Router } from 'express'
import { getMeetingStore, MeetingStore, MeetingStoreError } from '../lib/meeting-store.js'
import {
  cosOperationsMeetingsConfigured,
  getDirectLibraryMeetingDetail,
  getCosOperationsMeetingDetail,
  listDirectLibraryMeetings,
  listCosOperationsMeetings,
  resolveMeetingLibrary,
} from '../lib/cos-operations-meetings.js'
import type { MeetingMeta } from '../lib/meeting-store.js'

function withStandaloneIdentity(meeting: MeetingMeta): MeetingMeta {
  return {
    ...meeting,
    librarySource: 'standalone_recordings',
    recordId: `standalone:${meeting.sessionId || `${meeting.domain}:${meeting.month}:${meeting.filename}`}`,
    mutable: true,
  }
}

function mergeMeetingSources(groups: MeetingMeta[][], limit: number): MeetingMeta[] {
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
  return merged.slice(0, Math.min(Math.max(limit, 1), 50))
}

export function createMeetingsRouter(store: MeetingStore = getMeetingStore()): Router {
  const router = Router()

  // GET /api/meetings?limit=20&domain=all
  router.get('/meetings', (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
      const limit = Number.isFinite(rawLimit) ? rawLimit : 20
      const domain = typeof req.query.domain === 'string' ? req.query.domain : 'all'
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

      if (library.layout === 'direct') {
        const operations = cosOperationsMeetingsConfigured()
          ? listCosOperationsMeetings({ limit: 50, domain })
          : []
        const direct = domain === 'all' || domain === 'library'
          ? listDirectLibraryMeetings({ limit: 50 })
          : []
        const standalone = store.list({ limit: 50, domain }).map(withStandaloneIdentity)
        const meetings = mergeMeetingSources([operations, direct, standalone], limit)
        res.json({
          meetings,
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
        const meetings = listCosOperationsMeetings({ limit, domain })
        res.json({
          meetings,
          source: 'cos_operations',
          layout: 'multi_domain',
          root: library.root,
          rootFingerprint: library.rootFingerprint,
          meetingCount: meetings.length,
          warnings: library.warnings,
        })
        return
      }

      const meetings = store.list({ limit, domain }).map(withStandaloneIdentity)
      res.json({ meetings, source: 'standalone_recordings', layout: 'standalone', meetingCount: meetings.length })
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
