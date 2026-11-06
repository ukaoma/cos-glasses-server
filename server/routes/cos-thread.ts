/**
 * 6.99.16: the COS thread (lib/cos-thread.ts). Auth comes from the parent /api mount. Every answer is
 * `Cache-Control: private, no-store`. Gated exactly like the Drop it routes (routes/drops.ts): while Drop it is off,
 * every route answers 404 `{ error: { code: 'drop_it_off' } }` and no file is created (the store opens on the first
 * request after the feature is turned on). Advertised as `capabilities.dropIt.thread: { protocol: 1 }` while on.
 *
 *   GET  /cos-thread                    CosThreadAnswer: the thread and what the next Ask should do
 *   POST /cos-thread/new     {}         CosThreadAnswer (next.reason 'manual'): closes this thread, starts another
 *   POST /cos-thread/turn    { clientId, sessionId, query, answer?, messageNo?, provider? }   CosThreadAnswer
 *   GET  /cos-thread/search  ?q&limit   { hits: [{ threadId, sessionId, at, query, answerHead, messageNo }], scanned }
 *   GET  /cos-thread/threads ?limit     { threads: [{ id, startedAt, endedAt, asks, segments, title }] }
 */
import { Router, type Response } from 'express'
import { CosThread, CosThreadError, parseTurnInput } from '../lib/cos-thread.js'

export interface CosThreadRouterDependencies {
  enabled: () => boolean
  /** The store, opened on first use. Null when it cannot open. */
  thread: () => CosThread | null
}

const fail = (res: Response, error: unknown) => {
  if (error instanceof CosThreadError) return res.status(error.status).json({ error: { code: error.code } })
  console.error('[cos-thread] request failed:', error instanceof Error ? error.name : 'error')
  return res.status(500).json({ error: { code: 'cos_thread_failed' } })
}
/** A whole number in [min, max], the default when absent, or null when present and out of range. */
function intParam(raw: unknown, min: number, max: number, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

export function createCosThreadRouter(deps: CosThreadRouterDependencies): Router {
  const router = Router()
  router.use('/cos-thread', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.enabled()) return res.status(404).json({ error: { code: 'drop_it_off', message: 'Drop it is off on this server.' } })
    next()
  })
  const withThread = (res: Response, fn: (t: CosThread) => unknown) => {
    const thread = deps.thread()
    if (!thread) return res.status(503).json({ error: { code: 'cos_thread_unavailable' } })
    try { return fn(thread) } catch (e) { return fail(res, e) }
  }

  router.get('/cos-thread', (_req, res) => withThread(res, t => res.json(t.view())))

  router.post('/cos-thread/new', (req, res) => {
    const b = req.body
    if (b !== undefined && (b === null || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length)) {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'Send {}.' } })
    }
    return withThread(res, t => res.json(t.startNew()))
  })

  router.post('/cos-thread/turn', (req, res) => {
    const input = parseTurnInput(req.body)
    if (!input) return res.status(400).json({ error: { code: 'invalid_turn' } })
    return withThread(res, t => res.json(t.recordTurn(input)))
  })

  router.get('/cos-thread/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < 2 || q.length > 200) return res.status(400).json({ error: { code: 'invalid_query', message: 'Search with 2 to 200 characters.' } })
    const limit = intParam(req.query.limit, 1, 50, 20)
    if (limit === null) return res.status(400).json({ error: { code: 'invalid_limit' } })
    return withThread(res, t => res.json(t.search(q, limit)))
  })

  router.get('/cos-thread/threads', (req, res) => {
    const limit = intParam(req.query.limit, 1, 100, 20)
    if (limit === null) return res.status(400).json({ error: { code: 'invalid_limit' } })
    return withThread(res, t => res.json(t.list(limit)))
  })

  return router
}
