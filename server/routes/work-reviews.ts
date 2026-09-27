import { Router } from 'express'
import { WorkReviewError } from '../lib/work-review-store.js'
import type { WorkReviewRuntime } from '../lib/work-review-runtime.js'
/** Mount beneath requireApiToken, just like query jobs and the meeting library. */
export function createWorkReviewsRouter(runtime: WorkReviewRuntime | null): Router {
  const router = Router()
  router.use('/work-reviews', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!runtime) return res.status(404).json({ error: { code: 'work_reviews_disabled' } })
    next()
  })
  const fail = (res: import('express').Response, e: unknown) => res.status(e instanceof WorkReviewError ? e.status : 503)
    .json({ error: { code: e instanceof WorkReviewError ? e.code : 'work_reviews_unavailable' } })
  router.get('/work-reviews', async (_req,res) => {
    try { res.json({ schemaVersion: 1, capabilities: await runtime!.capabilities(), reviews: await runtime!.list() }) } catch(e) { fail(res,e) }
  })
  router.post('/work-reviews', async (req,res) => {
    try { const result = await runtime!.request(req.body); res.status(result.replayed ? 200 : 202).json({ schemaVersion: 1, ...result }) } catch(e) { fail(res,e) }
  })
  router.get('/work-reviews/:id', async (req,res) => {
    try { res.json({ schemaVersion: 1, review: await runtime!.get(String(req.params.id)) }) } catch(e) { fail(res,e) }
  })
  return router
}
