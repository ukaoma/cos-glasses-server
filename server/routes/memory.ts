import { Router } from 'express'
import { callPython } from '../lib/python-bridge.js'
import {
  MEMORY_ID_PATTERN,
  normalizeMemoryDetail,
  normalizeMemoryList,
  normalizeMemoryOverview,
} from '../lib/cos-context-browser.js'

export const memoryRouter = Router()

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

memoryRouter.get('/memory/overview', async (_req, res) => {
  try {
    const data = await callPython(['memory-overview'])
    res.json(normalizeMemoryOverview(data))
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

memoryRouter.get('/memory/:id', async (req, res) => {
  if (!MEMORY_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: 'invalid_memory_id' })
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
  try {
    const data = await callPython(['memory', '--days', String(days), '--limit', String(limit)])
    // Preserve the legacy top-level array used by released companions.
    res.json(normalizeMemoryList(data, limit))
  } catch {
    res.json([])
  }
})
