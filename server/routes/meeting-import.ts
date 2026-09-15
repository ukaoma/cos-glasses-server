// Meeting import endpoints.
//
//   POST /api/meeting-import/fireflies/run       { windowDays } -> 202 { runId }
//   GET  /api/meeting-import/fireflies/status    mode, state, counts, budget
//   POST /api/meeting-import/fireflies/settings  { keepImporting, planCap }
//
// The run route answers as soon as the run is admitted. A backfill takes
// minutes and holds a maintenance lease per page, so an HTTP request that
// waited for it would sit far past COS Control's drain timeout; status is how a
// surface follows it.
//
// Every refusal is a code a surface can render: operations_pipeline_owns_fireflies
// (this Mac's pipeline owns Fireflies), import_in_progress, fireflies_key_missing,
// invalid_key, invalid_window, maintenance_drain_active.

import { Router } from 'express'
import { ImportRefusedError, getFirefliesImporter, type FirefliesImporter } from '../lib/meeting-import.js'

export interface MeetingImportRouterDeps {
  importer: () => FirefliesImporter
}

export function createMeetingImportRouter(deps: MeetingImportRouterDeps): Router {
  const router = Router()

  const refusal = (error: unknown, res: import('express').Response, fallback: string): void => {
    if (error instanceof ImportRefusedError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } })
      return
    }
    console.error(`[meeting-import] ${fallback}:`, error)
    res.status(500).json({ error: { code: fallback, message: 'The import could not be started.' } })
  }

  router.post('/meeting-import/fireflies/run', (req, res) => {
    try {
      const started = deps.importer().run({ windowDays: req.body?.windowDays })
      res.status(202).json({ accepted: true, runId: started.runId, status: deps.importer().status() })
    } catch (error) {
      refusal(error, res, 'meeting_import_run_failed')
    }
  })

  router.get('/meeting-import/fireflies/status', (_req, res) => {
    try {
      res.json(deps.importer().status())
    } catch (error) {
      console.error('[meeting-import] status failed:', error)
      res.status(500).json({ error: { code: 'meeting_import_unavailable', message: 'The import status could not be read.' } })
    }
  })

  router.post('/meeting-import/fireflies/settings', (req, res) => {
    try {
      res.json(deps.importer().settings({
        keepImporting: req.body?.keepImporting,
        planCap: req.body?.planCap,
      }))
    } catch (error) {
      refusal(error, res, 'meeting_import_settings_failed')
    }
  })

  return router
}

export const meetingImportRouter = createMeetingImportRouter({ importer: getFirefliesImporter })
