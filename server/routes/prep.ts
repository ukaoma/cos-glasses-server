/**
 * Prep v1.1 routes (6.99.19). Mounted under /api, so the X-Cos-Token check in index.ts runs first. Every answer is
 * Cache-Control: no-store and carries the top-level `serverInstanceId` (errors included; the original-bytes route
 * sends it as the X-COS-Server-Instance header). Errors are `{ error: '<code>' }` like Meeting Ask; a revision conflict
 * also carries `draft`, run_in_progress carries `run`, and file_context_limit carries needBytes and haveBytes.
 * Every mutation requires X-COS-Expected-Server-Instance (v1.1 #19), checked before the runtime is called. The
 * behaviour lives in lib/prep-runtime.ts; shared/prep.ts lists the routes and DTOs.
 */
import { Router, type Request, type Response } from 'express'
import { PrepError } from '../lib/prep-store.js'
import type { PrepRuntime } from '../lib/prep-runtime.js'

export const EXPECTED_SERVER_HEADER = 'x-cos-expected-server-instance'

/** An ASCII fallback name plus the RFC 5987 UTF-8 name: no quotes, slashes or control characters reach the header. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[ .]+/, '').slice(0, 120) || 'file'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 240))}`
}

export function createPrepRouter(runtime: PrepRuntime): Router {
  const router = Router()
  router.use('/prep', (_q, res, next) => { res.set('Cache-Control', 'no-store'); next() })

  const serverInstanceId = () => { try { return runtime.serverInstanceId() } catch { return null } }
  const send = (res: Response, status: number, body: Record<string, unknown>) => res.status(status).json({ ...body, serverInstanceId: serverInstanceId() })
  const failure = (res: Response, error: unknown) => {
    if (error instanceof PrepError) {
      send(res, error.status, { error: error.code, ...error.extra, ...(error.draft ? { draft: error.draft } : {}) })
      return
    }
    console.warn('[prep] request failed:', error instanceof Error ? error.message : 'unknown')
    send(res, 503, { error: 'prep_unavailable' })
  }
  /** A mutation: the expected server is checked before the runtime runs anything. */
  const write = (status: number, fn: (req: Request) => Promise<Record<string, unknown>>) => async (req: Request, res: Response) => {
    try {
      runtime.authorize(req.get(EXPECTED_SERVER_HEADER))
      send(res, status, await fn(req))
    } catch (e) { failure(res, e) }
  }
  const read = (fn: (req: Request) => Promise<Record<string, unknown>> | Record<string, unknown>) => async (req: Request, res: Response) => {
    try { send(res, 200, await fn(req)) } catch (e) { failure(res, e) }
  }

  router.post('/prep/drafts', async (req, res) => {
    try {
      runtime.authorize(req.get(EXPECTED_SERVER_HEADER))
      const { draft, created } = await runtime.create(req.body)
      send(res, created ? 201 : 200, { draft })
    } catch (e) { failure(res, e) }
  })
  router.get('/prep/drafts', read(req => ({ drafts: runtime.list({ occurrence: req.query.occurrence, state: req.query.state, limit: req.query.limit }) })))
  router.get('/prep/drafts/:id', read(async req => ({ draft: await runtime.get(String(req.params.id)) })))
  router.patch('/prep/drafts/:id', write(200, async req => ({ draft: await runtime.patch(String(req.params.id), req.body) })))
  router.post('/prep/drafts/:id/files', write(200, async req => ({ draft: await runtime.addFiles(String(req.params.id), req.body) })))
  router.delete('/prep/drafts/:id/files/:fileId', write(200, async req => ({ draft: await runtime.removeFile(String(req.params.id), String(req.params.fileId), req.query.revision, req.query.serverInstanceId) })))
  router.get('/prep/drafts/:id/files/:fileId', (req, res) => {
    try {
      const file = runtime.readOriginal(String(req.params.id), String(req.params.fileId))
      res.set({ 'Content-Type': file.mime, 'Content-Disposition': attachmentDisposition(file.name), 'X-Content-Type-Options': 'nosniff', 'X-COS-Server-Instance': serverInstanceId() ?? '' })
      res.send(file.bytes)
    } catch (e) { failure(res, e) }
  })
  router.get('/prep/drafts/:id/files/:fileId/text', read(req => ({ text: runtime.readText(String(req.params.id), String(req.params.fileId)) })))
  router.post('/prep/drafts/:id/run', write(202, async req => ({ ...await runtime.run(String(req.params.id), req.body) })))
  router.get('/prep/drafts/:id/runs/:clientRequestId', async (req, res) => {
    try {
      const { status, run, job } = await runtime.getRun(String(req.params.id), String(req.params.clientRequestId))
      send(res, status, status === 202 ? { run } : { run, job })
    } catch (e) { failure(res, e) }
  })
  router.post('/prep/drafts/:id/bind', write(200, async req => ({ ...await runtime.bind(String(req.params.id), req.body) })))
  router.delete('/prep/drafts/:id/bind/:sessionId', write(200, async req => ({ draft: await runtime.unbind(String(req.params.id), String(req.params.sessionId), req.query.serverInstanceId) })))
  router.get('/prep/by-session/:sessionId', read(req => ({ snapshots: runtime.bySession(String(req.params.sessionId)) })))
  router.get('/prep/suggest', read(req => ({ drafts: runtime.suggest({ sessionId: req.query.sessionId, startedAt: req.query.startedAt }) })))
  return router
}
