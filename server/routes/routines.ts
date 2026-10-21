// 6.82.0 Routines: every routine on this server, the morning brief first.
//
//   GET    /api/routines                 list (the brief, then skill routines) + master switch + limits
//   GET    /api/routines/skills          the workspace skills a routine may run (labels only, never paths)
//   GET    /api/routines/runs            recent runs of every skill routine
//   POST   /api/routines                 create a skill routine (201; 400 bad field; 409 at the limit)
//   GET    /api/routines/:id             one routine
//   PATCH  /api/routines/:id             edit (PUT is the same); `resetBreaker: true` closes an open breaker
//   POST   /api/routines/:id/pause       turn it off
//   POST   /api/routines/:id/resume      turn it on
//   DELETE /api/routines/:id             delete a skill routine (the brief can only be turned off)
//   POST   /api/routines/:id/run         Run now (202; 409 running or off; 423 breaker open; 429 capped)
//   GET    /api/routines/:id/runs        that routine's run history
//
// Authenticated by the global /api middleware like every settings route. No route returns a run's
// full answer: it lands in the conversation store like any reply.

import { Router, type Response } from 'express'
import { MORNING_BRIEF_ROUTINE_ID } from '../lib/morning-brief-scheduler.js'
import { RoutineRegistryError, type RoutineRegistry } from '../lib/routines-registry.js'
import type { WorkspaceSkill } from '../lib/workspace-skills.js'

const ID_RE = /^(morning-brief|routine-[0-9a-f]{10})$/

export function createRoutinesRouter(registry: () => RoutineRegistry, skills: () => WorkspaceSkill[]): Router {
  const router = Router()

  const fail = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof RoutineRegistryError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message, ...error.detail } })
    }
    console.error(`[routines] ${fallback}:`, error)
    return res.status(500).json({ error: { code: fallback, message: 'The routine could not be read or saved.' } })
  }
  const idOf = (raw: string, res: Response): string | null => {
    if (ID_RE.test(raw)) return raw
    res.status(404).json({ error: { code: 'routine_not_found', message: 'That routine does not exist.' } })
    return null
  }

  router.get('/routines', async (_req, res) => {
    try { res.json(await registry().list()) } catch (error) { fail(res, error, 'routines_unavailable') }
  })

  router.get('/routines/skills', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      res.json({ skills: skills().map(s => ({ name: s.name, slash: s.slash, description: s.description, group: s.group })) })
    } catch (error) { fail(res, error, 'skills_unavailable') }
  })

  router.get('/routines/runs', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10)
    try { res.json({ runs: await registry().runs(undefined, Number.isFinite(limit) ? limit : 20) }) } catch (error) { fail(res, error, 'routines_unavailable') }
  })

  router.post('/routines', async (req, res) => {
    try { res.status(201).json({ routine: await registry().create(req.body) }) } catch (error) { fail(res, error, 'routine_save_failed') }
  })

  router.get('/routines/:id', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { res.json({ routine: await registry().get(id) }) } catch (error) { fail(res, error, 'routines_unavailable') }
  })

  const edit = async (req: { params: { id: string }; body: unknown }, res: Response) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { res.json({ routine: await registry().update(id, req.body) }) } catch (error) { fail(res, error, 'routine_save_failed') }
  }
  router.patch('/routines/:id', edit)
  router.put('/routines/:id', edit)

  router.post('/routines/:id/pause', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { res.json({ routine: await registry().setEnabled(id, false) }) } catch (error) { fail(res, error, 'routine_save_failed') }
  })
  router.post('/routines/:id/resume', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { res.json({ routine: await registry().setEnabled(id, true) }) } catch (error) { fail(res, error, 'routine_save_failed') }
  })

  router.delete('/routines/:id', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { await registry().remove(id); res.status(204).end() } catch (error) { fail(res, error, 'routine_save_failed') }
  })

  router.post('/routines/:id/run', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    try { res.status(202).json({ run: await registry().runNow(id) }) } catch (error) { fail(res, error, 'routine_run_failed') }
  })

  router.get('/routines/:id/runs', async (req, res) => {
    const id = idOf(req.params.id, res); if (!id) return
    const limit = Number.parseInt(String(req.query.limit ?? '14'), 10)
    try { res.json({ runs: await registry().runs(id, Number.isFinite(limit) ? limit : 14) }) } catch (error) { fail(res, error, 'routines_unavailable') }
  })

  return router
}

export { MORNING_BRIEF_ROUTINE_ID }
