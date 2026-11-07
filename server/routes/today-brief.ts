/**
 * 6.99.26 candidate: the Today summary for COS Control Web (lib/today-brief.ts says how it stops: switch, caps, breaker).
 *
 * - GET  /api/today/brief           the cached summary; never generates.
 * - POST /api/today/brief           an open Today's ask, with the rows it read (titles, states, how long, last lines,
 *                                   what needs you). Generates only when the switch is on, the inputs changed, 10 minutes
 *                                   passed and the day's 60 are not spent. The Work cards in progress come from the
 *                                   server's own shared board read, never the body.
 * - GET  /api/today/brief/settings  the switch and what set it.
 * - POST /api/today/brief/settings  { enabled: boolean }, the Settings toggle. COS_TODAY_BRIEF_LLM, when set, still wins.
 * Auth is the parent /api gate (token or web session cookie). Every answer is private, no-store.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { dataPath } from '../lib/data-dir.js'
import { runClaudeText } from '../lib/claude-text-runner.js'
import { logTokenAudit } from '../lib/token-audit.js'
import type { TaskBoardRow } from '../lib/task-store.js'
import {
  TODAY_BRIEF_BODY_MAX_BYTES, TODAY_BRIEF_EFFORT, TODAY_BRIEF_SETTINGS_FILE, TODAY_BRIEF_STATE_FILE, TODAY_BRIEF_TIMEOUT_MS,
  TodayBriefInputError, createTodayBrief, normalizeTodayBriefInputs, type BriefWork, type TodayBrief,
} from '../lib/today-brief.js'

export interface TodayBriefRouterDeps {
  brief: TodayBrief
  /** The Work board as the server already reads it (a shared, bounded read), or null when it cannot be read. */
  board: () => Promise<TaskBoardRow[] | null>
}

/** The server's own brief: the data folder, Haiku through the isolated text runner, one audit row per start. */
export function defaultTodayBrief(): TodayBrief {
  return createTodayBrief({
    stateFile: dataPath(TODAY_BRIEF_STATE_FILE),
    settingsFile: dataPath(TODAY_BRIEF_SETTINGS_FILE),
    generate: (prompt, systemPrompt, model) => runClaudeText(prompt, {
      model, effort: TODAY_BRIEF_EFFORT, timeoutMs: TODAY_BRIEF_TIMEOUT_MS, systemPrompt, label: 'Today brief',
    }),
    audit: row => logTokenAudit({
      source: 'web-today-brief', model: row.model, inputChars: row.inputChars, outputChars: row.outputChars,
      durationMs: row.durationMs, caller: row.outcome === 'ok' ? 'today_brief' : `today_brief_${row.guard ?? row.outcome}`,
    }),
  })
}

const IN_PROGRESS = new Set(['draft', 'built', 'qa'])
/** Work cards in progress, by title and stage: open, not delegated, drafting to QA, or with an agent on it. */
export function workInProgress(rows: TaskBoardRow[] | null): BriefWork[] {
  if (!rows) return []
  const out: BriefWork[] = []
  for (const row of rows) {
    if (row.checked || row.delegated) continue
    const stage = row.workStage ?? (row.stage === 'active' ? 'draft' : row.stage === 'review' ? 'qa' : 'planned')
    const running = row.agentState === 'running'
    if (!IN_PROGRESS.has(stage) && !running) continue
    out.push({ title: row.title || row.text || '', stage, running })
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running)).slice(0, 12)
}

export function createTodayBriefRouter(deps: TodayBriefRouterDeps): Router {
  const router = Router()
  router.use('/today/brief', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  const failed = (res: Response) => res.status(503).json({ error: { code: 'today_brief_unavailable', message: 'The Today summary is unavailable right now.' } })

  router.get('/today/brief', (_req, res) => {
    try { res.json(deps.brief.peek()) } catch { failed(res) }
  })
  router.post('/today/brief', async (req, res) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > TODAY_BRIEF_BODY_MAX_BYTES) {
        return res.status(413).json({ error: { code: 'today_brief_too_large', message: 'Too much for the Today summary.' } })
      }
      // The switch first: off reads nothing, not even the board.
      if (!deps.brief.settings().enabled) {
        normalizeTodayBriefInputs(req.body)
        return res.json(deps.brief.peek())
      }
      const work = workInProgress(await deps.board().catch(() => null))
      const inputs = normalizeTodayBriefInputs(req.body, work)
      res.json(await deps.brief.ask(inputs))
    } catch (error) {
      if (error instanceof TodayBriefInputError) return res.status(400).json({ error: { code: error.code, message: 'That is not a Today summary request.' } })
      console.warn(`[today-brief] ask failed (${error instanceof Error ? error.name : 'error'})`)
      failed(res)
    }
  })
  router.get('/today/brief/settings', (_req, res) => {
    try { res.json(deps.brief.settings()) } catch { failed(res) }
  })
  router.post('/today/brief/settings', (req, res) => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'enabled') || typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'invalid_today_brief_settings', message: 'Send { enabled: true } or { enabled: false }.' } })
    }
    try { res.json(deps.brief.setEnabled(body.enabled)) } catch { failed(res) }
  })
  return router
}
