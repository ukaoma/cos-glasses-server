// Meeting archive: COS operations tree when configured, else standalone recordings.

import { Router } from 'express'
import { getMeetingStore, MeetingStore, MeetingStoreError } from '../lib/meeting-store.js'
import {
  cosOperationsMeetingsConfigured,
  getCosOperationsMeetingDetail,
  listCosOperationsMeetings,
  resolveCosOperationsDir,
} from '../lib/cos-operations-meetings.js'

export function createMeetingsRouter(store: MeetingStore = getMeetingStore()): Router {
  const router = Router()

  // GET /api/meetings?limit=20&domain=all
  router.get('/meetings', (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
      const limit = Number.isFinite(rawLimit) ? rawLimit : 20
      const domain = typeof req.query.domain === 'string' ? req.query.domain : 'all'
      res.set('Cache-Control', 'private, no-store')

      if (cosOperationsMeetingsConfigured()) {
        const meetings = listCosOperationsMeetings({ limit, domain })
        res.json({
          meetings,
          source: 'cos_operations',
          operationsDir: resolveCosOperationsDir(),
        })
        return
      }

      res.json({ meetings: store.list({ limit, domain }), source: 'standalone_recordings' })
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
