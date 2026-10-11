import { Router } from 'express'
import { AskError, normalizeAsk } from '../lib/live-cos-ask.js'
import { maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
import { meetingAskRuntime } from '../lib/meeting-ask-runtime.js'
export const liveCosAskRouter = Router()
liveCosAskRouter.post('/meetings/live-ask', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 150_000)
  res.once('close', () => { if (!res.writableEnded) controller.abort() })
  try {
    if (!maintenanceAdmissionsOpen()) throw new AskError('maintenance', 503)
    // Authentication is provided by index.ts before all /api routes. No model-owned tools.
    const input = normalizeAsk(req.body)
    res.json(await meetingAskRuntime.legacy(input, controller.signal))
  } catch (error) {
    if (!res.destroyed) res.status(error instanceof AskError ? error.status : 503).json({ error: error instanceof AskError ? error.reason : 'haiku_unavailable' })
  } finally { clearTimeout(timer) }
})
