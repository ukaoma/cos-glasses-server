import { Router } from 'express'
import { queryJobCoordinator } from '../lib/query-job-runtime.js'
import { runTaskNow } from '../lib/task-dispatcher.js'
import { domainAbbreviation } from '../lib/domains.js'
import { domainLabel } from '../lib/domain-label.js'
import {
  TaskBridgeError,
  TaskRunError,
  captureTask,
  checkTask,
  listBoard,
  listProjectedTaskRuns,
  loadDispatchCap,
  moveTask,
  saveDispatchCap,
  setTaskRunAt,
  setTaskText,
  taskDomains,
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

tasksRouter.get('/tasks/runs', async (req, res) => {
  if (tasksGate() === 'disabled') {
    return res.status(503).json({ error: { code: 'cos_pipeline_not_configured', message: 'COS pipeline is not configured.' }, gate: 'disabled' })
  }
  const limit = Number.parseInt(String(req.query.limit ?? '20'), 10)
  const runs = await listProjectedTaskRuns(
    jobId => queryJobCoordinator.getSnapshot(jobId).catch(() => undefined),
    Number.isFinite(limit) ? limit : 20,
  )
  res.json({ runs })
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

/** The domain list a client should offer, so no picker hardcodes one user's
 *  business units. `abbr` is derived server-side so every surface agrees on the
 *  badge; the two abbreviation maps that used to live in the app disagreed. */
tasksRouter.get('/domains', (_req, res) => {
  try {
    const names = taskDomains()
    res.json({
      domains: names.map(name => ({ name, abbr: domainAbbreviation(name), label: domainLabel(name) })),
      gate: tasksGate(),
    })
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
    if ('text' in body) {
      await setTaskText(domain, req.params.id, String(body.text))
    } else if ('runAt' in body) {
      await setTaskRunAt(domain, req.params.id, body.runAt == null || body.runAt === '' ? null : String(body.runAt))
    } else if ('section' in body) {
      await moveTask(domain, req.params.id, String(body.section))
    } else if ('checked' in body) {
      await checkTask({ domain, id: req.params.id, checked: body.checked === true })
    } else {
      throw new TaskRunError(400, 'invalid_patch', 'Expected text, runAt, section, or checked.')
    }
    res.json({ ok: true })
  } catch (error) {
    sendError(res, error)
  }
})

tasksRouter.post('/tasks/:id/run', async (req, res) => {
  try {
    const domain = requireDomain((req.body ?? {}).domain)
    const result = await runTaskNow(req.params.id, domain)
    res.status(202).json(result)
  } catch (error) {
    if (error instanceof TaskRunError && error.code === 'dispatch_slots_busy') {
      res.setHeader('Retry-After', '30')
    }
    sendError(res, error)
  }
})
