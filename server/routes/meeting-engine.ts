// The engine's own state, and the one switch a person may throw (6.47.0, WS4).
//
//   GET  /api/meeting-engine/status   mode, what the pipeline sees, mismatch, runs, counts
//   POST /api/meeting-engine/mode     { mode: 'advise' | 'apply' }
//
// `pipelineSees` IS THE POINT OF THE STATUS ROUTE. Four processes read the mode file, and
// the one failure a person cannot see for themselves is the server acting on `apply` while
// the pipeline on the same Mac still believes it owns the blend. The server asks
// `sync_meetings.py --merge-engine-status` (at most once every five minutes) and reports
// both answers plus whether they disagree. When the pipeline cannot be asked, the field is
// null and `mismatch` is false: "not known" is not "disagrees".
//
// THE MODE ROUTE REFUSES ON A MAC WITH NO PIPELINE. There is nothing to choose there: the
// server is in imports mode and does the importing itself.

import { Router } from 'express'
import { getMeetingMergeRunner, type MeetingMergeRunner } from '../lib/meeting-actions.js'
import type { MeetingEnginePipelineMode } from '../lib/meeting-engine-mode.js'
import { actionRefusal } from './meeting-suggestions.js'

export interface MeetingEngineRouterDeps {
  runner: () => MeetingMergeRunner
}

export function createMeetingEngineRouter(deps: MeetingEngineRouterDeps): Router {
  const router = Router()

  router.get('/meeting-engine/status', (_req, res) => {
    deps.runner().status()
      .then(status => {
        res.set('Cache-Control', 'private, no-store')
        res.json(status)
      })
      .catch(error => actionRefusal(error, res, 'meeting_engine_status_unavailable', 'The engine status could not be read.'))
  })

  router.post('/meeting-engine/mode', (req, res) => {
    try {
      // `setMode` refuses synchronously (wrong Mac, bad value, work in flight) and only then
      // returns a promise, so both paths have to be caught or a refusal becomes a 500.
      deps.runner().setMode(req.body?.mode as MeetingEnginePipelineMode)
        .then(result => res.json(result))
        .catch(error => actionRefusal(error, res, 'meeting_engine_mode_failed', 'The mode could not be changed.'))
    } catch (error) {
      actionRefusal(error, res, 'meeting_engine_mode_failed', 'The mode could not be changed.')
    }
  })

  return router
}

export const meetingEngineRouter = createMeetingEngineRouter({ runner: getMeetingMergeRunner })
