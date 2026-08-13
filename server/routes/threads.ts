import { Router } from 'express'
import { callPython, contextSourceAvailable, pythonBridgeState } from '../lib/python-bridge.js'
import { searchThreads } from '../lib/context-library-search.js'
import { THREAD_ID_PATTERN, normalizeThreadDetail, normalizeThreads } from '../lib/cos-context-browser.js'

export const threadsRouter = Router()

threadsRouter.get('/threads/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (query.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters', reason: 'invalid_query' })
    return
  }
  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
  res.set('Cache-Control', 'private, no-store')
  try {
    const result = await searchThreads({
      query,
      limit: Number.isFinite(rawLimit) ? rawLimit : 20,
    })
    res.json(result)
  } catch {
    res.status(503).json({ error: 'threads_search_unavailable', reason: 'threads_search_unavailable' })
  }
})

threadsRouter.get('/threads/:id', async (req, res) => {
  if (!THREAD_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: 'invalid_thread_id' })
    return
  }
  if (contextSourceAvailable() === null) {
    res.status(503).json({ error: pythonBridgeState() })
    return
  }
  try {
    const data = await callPython(['thread-detail', req.params.id])
    if (data && typeof data === 'object' && 'error' in data) {
      res.status(404).json({ error: 'thread_not_found' })
      return
    }
    const thread = normalizeThreadDetail(data)
    if (!thread) {
      res.status(404).json({ error: 'thread_not_found' })
      return
    }
    res.json(thread)
  } catch {
    res.status(503).json({ error: 'threads_unavailable' })
  }
})

threadsRouter.get('/threads', async (req, res) => {
  const parsed = Number(req.query.limit)
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : 30
  if (contextSourceAvailable() === null) {
    res.status(503).json({
      error: pythonBridgeState(), available: false,
      generated_at: '', active_count: 0, stale_count: 0, resolved_count: 0, threads: [],
    })
    return
  }
  try {
    const data = await callPython(['threads', '--limit', String(limit)])
    res.json(normalizeThreads(data, limit))
  } catch {
    res.status(503).json({
      error: 'threads_unavailable', available: false,
      ...normalizeThreads({}, limit),
    })
  }
})
