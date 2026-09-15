// Suggestions: what the engine wants a person to decide (6.47.0, WS4).
//
//   GET  /api/meeting-suggestions?state=open|confirmed|accepted|dismissed|all
//   POST /api/meeting-suggestions/:id/accept    imports mode: make the merge
//   POST /api/meeting-suggestions/:id/confirm   advise mode: record the answer only
//   POST /api/meeting-suggestions/:id/dismiss   never these two meetings again
//
// ACCEPT AND CONFIRM ARE DIFFERENT VERBS BECAUSE THEY MEAN DIFFERENT THINGS. In imports
// mode "yes" writes a record. In advise mode the server may not write into the operations
// tree at all, so "yes" is remembered and acted on later, if and when a person switches to
// apply. One verb doing both would make the advise answer look like it did something.
//
// Every refusal is a code a surface renders: suggestion_not_found, suggestion_stale,
// suggestion_dismissed, advise_mode, maintenance_drain_active.

import { Router, type Response } from 'express'
import { ActionRefusedError, getMeetingMergeRunner, type MeetingMergeRunner } from '../lib/meeting-actions.js'

export interface MeetingSuggestionsRouterDeps {
  runner: () => MeetingMergeRunner
}

export function actionRefusal(error: unknown, res: Response, fallback: string, message: string): void {
  if (error instanceof ActionRefusedError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } })
    return
  }
  console.error(`[meeting-suggestions] ${fallback}:`, error)
  res.status(500).json({ error: { code: fallback, message } })
}

export function createMeetingSuggestionsRouter(deps: MeetingSuggestionsRouterDeps): Router {
  const router = Router()

  router.get('/meeting-suggestions', (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : undefined
      res.set('Cache-Control', 'private, no-store')
      res.json({ suggestions: deps.runner().listSuggestions(state) })
    } catch (error) {
      actionRefusal(error, res, 'meeting_suggestions_unavailable', 'The suggestions could not be read.')
    }
  })

  router.post('/meeting-suggestions/:id/accept', (req, res) => {
    deps.runner().acceptSuggestion(String(req.params.id))
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_suggestion_accept_failed', 'That merge could not be made.'))
  })

  router.post('/meeting-suggestions/:id/confirm', (req, res) => {
    deps.runner().confirmSuggestion(String(req.params.id))
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_suggestion_confirm_failed', 'That answer could not be saved.'))
  })

  router.post('/meeting-suggestions/:id/dismiss', (req, res) => {
    deps.runner().dismissSuggestion(String(req.params.id))
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_suggestion_dismiss_failed', 'That answer could not be saved.'))
  })

  return router
}

export const meetingSuggestionsRouter = createMeetingSuggestionsRouter({ runner: getMeetingMergeRunner })
