// What the engine did, and how to undo it (6.47.0, WS4).
//
//   GET  /api/meeting-actions?limit=
//   GET  /api/meeting-actions/:id              one action
//   POST /api/meeting-actions/:id/revert       { dryRun } or { previewHash }
//   POST /api/meeting-actions/:id/retry        a failed action, in its own direction
//   POST /api/meeting-actions/revert-all       { dryRun } or { previewHash }
//
// TWO CALLS, ALWAYS. A revert asks for the preview first and gets a `previewHash` covering
// the outputs' CURRENT bytes; sending it back is what proves the person is undoing the thing
// they were shown. This follows the held-groups enroll gate in `voice.ts`, and for the same
// reason: the blast radius belongs in the preview, not in an apology afterwards.
//
// RETRY EXISTS BECAUSE FAILURE WAS TERMINAL. An action that used its one automatic retry
// stayed failed until the server restarted, and even a restart only re-drove WAITING rows.
// Control's Retry button reloaded the list and nothing else. This is the route it needed.
//
// `revert-all` is declared BEFORE `/:id/revert`. Express matches in order, and without that
// ordering `revert-all` is read as an action whose id is the literal string "revert-all".

import { Router } from 'express'
import { getMeetingMergeRunner, type MeetingMergeRunner } from '../lib/meeting-actions.js'
import { actionRefusal } from './meeting-suggestions.js'

export interface MeetingActionsRouterDeps {
  runner: () => MeetingMergeRunner
}

export function createMeetingActionsRouter(deps: MeetingActionsRouterDeps): Router {
  const router = Router()

  router.get('/meeting-actions', (req, res) => {
    try {
      const raw = Number(req.query.limit)
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 1_000) : 100
      res.set('Cache-Control', 'private, no-store')
      res.json({ actions: deps.runner().listActions(limit) })
    } catch (error) {
      actionRefusal(error, res, 'meeting_actions_unavailable', 'The action log could not be read.')
    }
  })

  router.get('/meeting-actions/:id', (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store')
      res.json({ action: deps.runner().getAction(String(req.params.id)) })
    } catch (error) {
      actionRefusal(error, res, 'meeting_action_unavailable', 'That action could not be read.')
    }
  })

  router.post('/meeting-actions/revert-all', (req, res) => {
    deps.runner().revertAll({ dryRun: req.body?.dryRun === true, previewHash: asHash(req.body?.previewHash) })
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_actions_revert_all_failed', 'Those merges could not be undone.'))
  })

  router.post('/meeting-actions/:id/revert', (req, res) => {
    deps.runner().revert(String(req.params.id), {
      dryRun: req.body?.dryRun === true,
      previewHash: asHash(req.body?.previewHash),
    })
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_action_revert_failed', 'That merge could not be undone.'))
  })

  router.post('/meeting-actions/:id/retry', (req, res) => {
    // Every refusal arrives as a rejection: `retryAction` is async, so a drain, a run in
    // flight and a wrong state all land in the same handler as a real failure.
    deps.runner().retryAction(String(req.params.id))
      .then(result => res.json(result))
      .catch(error => actionRefusal(error, res, 'meeting_action_retry_failed', 'That one could not be tried again.'))
  })

  return router
}

function asHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined
}

export const meetingActionsRouter = createMeetingActionsRouter({ runner: getMeetingMergeRunner })
