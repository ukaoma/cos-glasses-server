import { Router } from 'express'
import {
  TaskBridgeError,
  TaskRunError,
  captureTask,
  checkTask,
  listBoard,
  listTaskRuns,
  loadDispatchCap,
  moveTask,
  saveDispatchCap,
  setTaskRunAt,
  tasksGate,
  workBadgeCount,
} from '../lib/task-store.js'

export const tasksRouter = Router()

function sendError(res: import('express').Response, error: unknown): void {
  if (error instanceof TaskRunError) {
    if (error.code === 'task_file_locked') res.setHeader('Retry-After', '2')
    res.status(error.status).json({ error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof TaskBridgeError) {
    const status = error.code === 'task_file_locked' ? 503
      : error.code === 'task_not_found' || error.code === 'ambiguous_text' ? (error.code === 'ambiguous_text' ? 409 : 404)
      : error.code === 'cos_pipeline_not_configured' ? 503
      : 400
    if (error.code === 'task_file_locked') res.setHeader('Retry-After', '2')
    res.status(status).json({ error: { code: error.code, message: error.message } })
    return
  }
  console.error('[tasks]', error)
  res.status(500).json({ error: { code: 'task_store_failed', message: 'Task store failed.' } })
}

function requireDomain(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new TaskRunError(400, 'invalid_domain', 'domain is required')
  return value
}

tasksRouter.get('/tasks/runs', (req, res) => {
  if (tasksGate() === 'disabled') {
    return res.status(503).json({ error: { code: 'cos_pipeline_not_configured', message: 'COS pipeline is not configured.' }, gate: 'disabled' })
  }
  const limit = Number.parseInt(String(req.query.limit ?? '20'), 10)
  res.json({ runs: listTaskRuns(Number.isFinite(limit) ? limit : 20) })
})

tasksRouter.get('/tasks/next', async (_req, res) => {
  try {
    const rows = await listBoard('today')
    res.json({ task: rows[0] ?? null })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.post('/tasks/capture', async (req, res) => {
  try {
    const body = req.body ?? {}
    const result = await captureTask({
      domain: requireDomain(body.domain),
      text: String(body.text ?? ''),
      section: String(body.section ?? 'inbox'),
      runAt: typeof body.runAt === 'string' ? body.runAt : undefined,
      captureId: typeof body.captureId === 'string' ? body.captureId : undefined,
    })
    res.status(result.replayed ? 200 : 200).json(result)
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.patch('/tasks/by-text', async (req, res) => {
  try {
    const body = req.body ?? {}
    if (typeof body.domain !== 'string' || !body.domain) {
      throw new TaskRunError(400, 'invalid_domain', 'domain is required')
    }
    if (typeof body.text !== 'string' || !body.text) {
      throw new TaskRunError(400, 'text_required', 'text is required')
    }
    await checkTask({
      domain: body.domain,
      text: body.text,
      checked: body.checked !== false,
    })
    res.json({ ok: true })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.patch('/tasks/dispatch-cap', (req, res) => {
  try {
    const cap = Number((req.body ?? {}).capPerDay)
    saveDispatchCap(cap)
    res.json({ capPerDay: loadDispatchCap() })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.get('/tasks', async (req, res) => {
  try {
    const column = typeof req.query.column === 'string' ? req.query.column : undefined
    const rows = await listBoard(column)
    res.json({ tasks: rows, workBadge: workBadgeCount(rows), gate: tasksGate() })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.patch('/tasks/:id', async (req, res) => {
  try {
    const body = req.body ?? {}
    const domain = requireDomain(body.domain)
    if ('runAt' in body) {
      await setTaskRunAt(domain, req.params.id, body.runAt == null || body.runAt === '' ? null : String(body.runAt))
    } else if ('section' in body) {
      await moveTask(domain, req.params.id, String(body.section))
    } else if ('checked' in body) {
      await checkTask({ domain, id: req.params.id, checked: body.checked === true })
    } else {
      throw new TaskRunError(400, 'invalid_patch', 'Expected runAt, section, or checked.')
    }
    res.json({ ok: true })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.post('/tasks/:id/run', (_req, res) => {
  res.status(409).json({
    error: {
      code: 'durable_jobs_off',
      message: 'Task dispatch lands with the rest of Train 1 Phase 7.',
    },
  })
})
