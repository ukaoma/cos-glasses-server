// Morning brief — the settings and status surface.
//
//   GET  /api/morning-brief          config + source catalog + status + recent runs
//   PUT  /api/morning-brief          patch the config (validated; 400 on a bad field)
//   POST /api/morning-brief/run      fire a brief now (202; 409 while one runs; 429 past the daily cap)
//   GET  /api/morning-brief/runs     recent runs with live job status, message numbers, section outcomes
//   GET  /api/morning-brief/coverage what each source can reach right now (?refresh=1 re-probes)
//   GET  /api/morning-brief/preview  the exact prompt today's brief would send
//
// Authenticated by the global /api middleware like every other settings route.
// Nothing here returns a brief's full text: the answer lives in the conversation
// store and the phone reads it through the same history route as any reply.

import { Router } from 'express'
import { MorningBriefConfigError, describeMorningBriefSources } from '../lib/morning-brief-config.js'
import { MorningBriefRunError, type MorningBriefScheduler } from '../lib/morning-brief-scheduler.js'

export function createMorningBriefRouter(scheduler: () => MorningBriefScheduler): Router {
  const router = Router()

  const describe = async () => {
    const instance = scheduler()
    return {
      config: instance.getConfig(),
      sources: describeMorningBriefSources(),
      status: await instance.status(),
      runs: await instance.listRuns(7),
      coverage: await instance.coverage(),
    }
  }

  router.get('/morning-brief', async (_req, res) => {
    try {
      res.json(await describe())
    } catch (error) {
      console.error('[morning-brief] describe failed:', error)
      res.status(500).json({ error: { code: 'morning_brief_unavailable', message: 'Could not read the morning brief settings.' } })
    }
  })

  router.put('/morning-brief', async (req, res) => {
    try {
      scheduler().updateConfig(req.body)
      res.json(await describe())
    } catch (error) {
      if (error instanceof MorningBriefConfigError) {
        return res.status(400).json({ error: { code: error.code, message: error.message } })
      }
      console.error('[morning-brief] update failed:', error)
      res.status(500).json({ error: { code: 'morning_brief_save_failed', message: 'The settings could not be saved.' } })
    }
  })

  router.post('/morning-brief/run', async (_req, res) => {
    try {
      const run = await scheduler().runNow()
      res.status(202).json({ run })
    } catch (error) {
      if (error instanceof MorningBriefRunError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } })
      }
      console.error('[morning-brief] run now failed:', error)
      res.status(500).json({ error: { code: 'morning_brief_run_failed', message: 'The brief could not be started.' } })
    }
  })

  router.get('/morning-brief/runs', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '14'), 10)
    try {
      res.json({ runs: await scheduler().listRuns(Number.isFinite(limit) ? limit : 14) })
    } catch (error) {
      console.error('[morning-brief] runs failed:', error)
      res.status(500).json({ error: { code: 'morning_brief_unavailable', message: 'Could not read the morning brief runs.' } })
    }
  })

  router.get('/morning-brief/coverage', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
    try {
      const coverage = await scheduler().coverage(refresh)
      if (!coverage) return res.status(503).json({ error: { code: 'coverage_unavailable', message: 'This server has no coverage probes.' } })
      res.json({ coverage })
    } catch (error) {
      console.error('[morning-brief] coverage failed:', error)
      res.status(500).json({ error: { code: 'coverage_failed', message: 'Could not read source coverage.' } })
    }
  })

  router.get('/morning-brief/preview', (_req, res) => {
    res.type('text/plain').send(scheduler().previewPrompt('scheduled'))
  })

  return router
}
