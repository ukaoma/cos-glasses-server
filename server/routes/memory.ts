import { Router } from 'express'
import { callPython, contextSourceAvailable, pythonBridgeState } from '../lib/python-bridge.js'
import { searchMemories } from '../lib/context-library-search.js'

/**
 * Is there anything to serve — a Python bridge OR plain files on disk?
 *
 * These routes used to gate on `pythonBridgeAvailable()`, which returned 503
 * before `callPython` was ever reached. That is why "I selected COS Memory and
 * the G2 says Unavailable" was the experience for anyone without a venv and a
 * vector database: the answer was decided two layers above the data.
 */
function contextConfigured(): boolean {
  return contextSourceAvailable() !== null
}
import {
  MEMORY_ID_PATTERN,
  normalizeMemoryDetail,
  normalizeMemoryList,
  normalizeMemoryOverview,
  normalizeContextBrowserStatus,
} from '../lib/cos-context-browser.js'

export const memoryRouter = Router()
let overviewCache: { expiresAt: number; value: ReturnType<typeof normalizeMemoryOverview> } | null = null

memoryRouter.get('/context/status', async (_req, res) => {
  if (!contextConfigured()) {
    const state = pythonBridgeState()
    res.json(normalizeContextBrowserStatus({
      available: false, protocol: 1, state,
      memory: { available: false, total: 0, state },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state },
    }))
    return
  }
  try {
    const data = await callPython(['context-status'], 8_000)
    res.json(normalizeContextBrowserStatus(data))
  } catch {
    res.json(normalizeContextBrowserStatus({
      available: false, protocol: 1, state: 'bridge_error',
      memory: { available: false, total: 0, state: 'bridge_error', reason: 'bridge_error' },
      threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state: 'bridge_error', reason: 'bridge_error' },
    }))
  }
})

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

memoryRouter.get('/memory/overview', async (_req, res) => {
  if (!contextConfigured()) {
    res.status(503).json(normalizeMemoryOverview({
      available: false, reason: pythonBridgeState(), total: 0, by_type: {},
    }))
    return
  }
  if (overviewCache && overviewCache.expiresAt > Date.now()) {
    res.json(overviewCache.value)
    return
  }
  try {
    const data = await callPython(['memory-overview'])
    const value = normalizeMemoryOverview(data)
    overviewCache = { expiresAt: Date.now() + 30_000, value }
    res.json(value)
  } catch (error) {
    res.status(503).json({
      available: false,
      collection: 'cos_memory',
      total: 0,
      by_type: {},
      reason: 'memory_bridge_unavailable',
    })
  }
})

memoryRouter.get('/memory/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (query.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters', reason: 'invalid_query' })
    return
  }
  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
  res.set('Cache-Control', 'private, no-store')
  try {
    const result = await searchMemories({
      query,
      limit: Number.isFinite(rawLimit) ? rawLimit : 20,
    })
    res.json(result)
  } catch {
    res.status(503).json({ error: 'memory_search_unavailable', reason: 'memory_search_unavailable' })
  }
})

memoryRouter.get('/memory/:id', async (req, res) => {
  if (!MEMORY_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: 'invalid_memory_id' })
    return
  }
  if (!contextConfigured()) {
    res.status(503).json({ error: pythonBridgeState() })
    return
  }
  try {
    const data = await callPython(['memory-detail', req.params.id])
    if (data && typeof data === 'object' && 'error' in data) {
      res.status(404).json({ error: 'memory_not_found' })
      return
    }
    const memory = normalizeMemoryDetail(data)
    if (!memory) {
      res.status(404).json({ error: 'memory_not_found' })
      return
    }
    res.json(memory)
  } catch {
    res.status(503).json({ error: 'memory_unavailable' })
  }
})

memoryRouter.get('/memory', async (req, res) => {
  const days = boundedInteger(req.query.days, 30, 1, 3650)
  const limit = boundedInteger(req.query.limit, 20, 1, 50)
  if (!contextConfigured()) {
    res.status(503).json({ error: pythonBridgeState() })
    return
  }
  try {
    const data = await callPython(['memory', '--days', String(days), '--limit', String(limit)])
    // Preserve the legacy top-level array used by released companions.
    res.json(normalizeMemoryList(data, limit))
  } catch {
    res.status(503).json({ error: 'memory_unavailable' })
  }
})
