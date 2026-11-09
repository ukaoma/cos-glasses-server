/**
 * 6.99.26 candidate: the Today summary for COS Control Web (lib/today-brief.ts says how it stops: switch, caps, breaker).
 *
 * - GET  /api/today/brief           the cached summary; never generates.
 * - POST /api/today/brief           an open Today's ask, with the rows it read (titles, states, how long, last lines,
 *                                   what needs you). Generates only when the switch is on, the inputs changed, 10 minutes
 *                                   passed and the day's cap (Summaries per day, 7.0.5) is not spent. The Work cards in progress come from the
 *                                   server's own shared board read, never the body.
 *                                   7.0.1: `"force": true` in the body is the Today refresh button. It skips the
 *                                   10-minute interval and the "inputs unchanged" check, at most once every 30 s,
 *                                   inside the same daily cap. A throttled one answers reason `refresh_throttled` and
 *                                   `retryAfterMs`.
 *                                   7.0.5: `"reason": "reconnect"` says the client's read just recovered from a failed
 *                                   one: that start skips the 10-minute interval, at most once per 10 minutes. The
 *                                   "inputs unchanged" check, the breaker, the switch and the daily cap still apply.
 * - GET  /api/today/brief/settings  the switch and what set it.
 * - POST /api/today/brief/settings  { enabled: boolean }, the Settings toggle. COS_TODAY_BRIEF_LLM, when set, still wins.
 * - GET  /api/today/brief/settings/cap   7.0.5 "Summaries per day": { dailyCap, min: 1, max: 100, default: 100, usedToday }.
 * - PUT  /api/today/brief/settings/cap   { dailyCap: number }, clamped to 1 to 100 and saved; answers the same shape.
 * Auth is the parent /api gate (token or web session cookie). Every answer is private, no-store.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { dataPath } from '../lib/data-dir.js'
import { runClaudeText } from '../lib/claude-text-runner.js'
import { logTokenAudit } from '../lib/token-audit.js'
import type { TaskBoardRow } from '../lib/task-store.js'
import type { TaskDateFields } from '../lib/task-dates.js'
import { agentSessionRoots, codexSessionRootsOf, findAgentSessionFile, listCodexJsonlFiles, loadClaudeDesktopAliases, loadClaudeTranscriptIndex, type AgentProvider } from '../lib/agent-session-store.js'
import { readClaudeSubagents, summarize, type SessionSubagents } from '../lib/session-subagents.js'
import { readCodexSubagentDetails } from '../lib/codex-subagent-activity.js'
import { readRecentActivity, type RecentActivity } from '../lib/agent-session-recent.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen } from '../lib/maintenance-lifecycle.js'
import { isRecordingLive } from '../lib/stt-runtime.js'
import {
  TODAY_BRIEF_BODY_MAX_BYTES, TODAY_BRIEF_EFFORT, TODAY_BRIEF_SETTINGS_FILE, TODAY_BRIEF_STATE_FILE, TODAY_BRIEF_TIMEOUT_MS,
  TodayBriefInputError, createTodayBrief, normalizeTodayBriefInputs, sessionContextLookups, todayBriefFingerprint, withRecentActivity, withSubagents, type BriefWork, type SubagentReading, type TodayBrief,
} from '../lib/today-brief.js'

export interface TodayBriefRouterDeps {
  brief: TodayBrief
  /** The Work board, dated when it can be (2026-11-09: listBoardWithDates, so a card's last move is known), or null
   *  when it cannot be read. */
  board: () => Promise<Array<TaskBoardRow & Partial<TaskDateFields>> | null>
  /** Sub-agents and recent activity for up to 12 sessions, by "provider|id", written into `into` as each session is
   *  read, so an ask that stops waiting keeps what was read by then. Missing keys mean "not read": the page's counts
   *  and `line` stay, the line marked "may be old". */
  context?: (keys: string[], into: SessionContext) => Promise<unknown>
  now?: () => number
}

/** How long the session reads may hold the ask before it goes on with what was read by then. */
export const TODAY_BRIEF_SUBAGENT_WAIT_MS = 2_500

/** What the server read per session: its sub-agents and its recent activity, by "provider|id". */
export interface SessionContext { agents: Map<string, SubagentReading>; recent: Map<string, RecentActivity> }
export const emptySessionContext = (): SessionContext => ({ agents: new Map(), recent: new Map() })

/**
 * 2026-11-09: readSubagentsFor became this. For each key, most important first: the sub-agents (Claude from the
 * transcript tail, Codex from the spawn-edge snapshot) and the recent activity (lib/agent-session-recent.ts). Claude
 * and Cursor read one after another; Codex reads in parallel with them, because a Codex rollout's first scan is the
 * slow one (32 GB files) and must not starve the rest. Results land in `into` as they arrive. Read-only.
 */
export async function readSessionContext(keys: string[], into: SessionContext = emptySessionContext(), now = Date.now()): Promise<SessionContext> {
  const roots = agentSessionRoots()
  const split = (k: string) => { const i = k.indexOf('|'); return { provider: k.slice(0, i) as AgentProvider, id: k.slice(i + 1) } }
  const codexKeys = keys.filter(k => k.startsWith('codex|'))
  const localKeys = keys.filter(k => k.startsWith('claude|') || k.startsWith('cursor|'))
  const local = (async () => {
    // One index for every Claude id in this ask, not one per call.
    const claudeFiles = localKeys.some(k => k.startsWith('claude|')) ? await loadClaudeTranscriptIndex(roots).catch(() => undefined) : undefined
    const aliases = claudeFiles ? await loadClaudeDesktopAliases(roots.claudeCodeSessions).catch(() => undefined) : undefined
    for (const key of localKeys) {
      const { provider, id } = split(key)
      const file = await findAgentSessionFile(provider, id, roots, new Date(now), aliases, claudeFiles ? { claudeFiles } : undefined).catch(() => null)
      if (!file) continue
      if (provider === 'claude') {
        const read: SessionSubagents | null = await readClaudeSubagents(file)
        if (read && read.total) into.agents.set(key, read)
      }
      const recent = await readRecentActivity(provider, file, now)
      if (recent) into.recent.set(key, recent)
    }
  })()
  const codex = (async () => {
    if (!codexKeys.length) return
    const ids = codexKeys.map(k => k.slice(6))
    const details = await readCodexSubagentDetails(ids, roots.codexSessions, now).catch(() => new Map())
    for (const [id, list] of details) {
      const rows = (list as Array<{ name: string; task: string; state: string; at: number }>).map(d => ({ name: d.name, task: d.task, status: d.state === 'active' ? 'running' as const : d.state === 'completed' ? 'done' as const : 'unknown' as const, at: d.at }))
      // Every row, not six: the brief keeps the live and recent ones and counts the rest as history.
      if (rows.length) into.agents.set('codex|' + id, summarize(rows, false, rows.length))
    }
    const lists = await Promise.all(codexSessionRootsOf(roots).map(root => listCodexJsonlFiles(root).catch(() => [] as string[])))
    const codexFiles = lists.flat()
    for (const key of codexKeys) {
      const file = await findAgentSessionFile('codex', key.slice(6), roots, new Date(now), undefined, { codexFiles }).catch(() => null)
      if (!file) continue
      const recent = await readRecentActivity('codex', file, now)
      if (recent) into.recent.set(key, recent)
    }
  })()
  await Promise.all([local, codex])
  return into
}

/** The server's own brief: the data folder, Sonnet (7.0.1) through the isolated text runner, one audit row per start. */
export function defaultTodayBrief(): TodayBrief {
  return createTodayBrief({
    stateFile: dataPath(TODAY_BRIEF_STATE_FILE),
    settingsFile: dataPath(TODAY_BRIEF_SETTINGS_FILE),
    generate: (prompt, systemPrompt, model) => runClaudeText(prompt, {
      model, effort: TODAY_BRIEF_EFFORT, timeoutMs: TODAY_BRIEF_TIMEOUT_MS, systemPrompt, label: 'Today brief',
    }),
    audit: row => logTokenAudit({
      source: 'web-today-brief', model: row.model, inputChars: row.inputChars, outputChars: row.outputChars,
      durationMs: row.durationMs, caller: row.outcome === 'ok' ? 'today_brief' : `today_brief_${row.guard ?? row.error ?? row.outcome}`,
    }),
    // No call while a meeting records (it keeps the Mac's CPU and the CLI for the meeting) or while the server drains.
    blocked: () => (!maintenanceAdmissionsOpen() ? 'maintenance' : isRecordingLive() ? 'recording' : null),
    // The call holds api_mutation, as the generic mutation lease would have; this route is lifecycle-owned in index.ts.
    lease: () => acquireMaintenanceWork('api_mutation'),
  })
}

const IN_PROGRESS = new Set(['draft', 'built', 'qa'])
/**
 * Work cards in progress, by title and stage: open, not delegated, drafting to QA, or with an agent on it. 2026-11-09:
 * with when each last moved (the dated board read: the line's git change time, else the day it was created; null when
 * neither is known), running first, then the most recently moved, so the twelve kept are the live ones.
 */
export function workInProgress(rows: Array<TaskBoardRow & Partial<TaskDateFields>> | null, now = Date.now()): BriefWork[] {
  if (!rows) return []
  const out: BriefWork[] = []
  for (const row of rows) {
    if (row.checked || row.delegated) continue
    const stage = row.workStage ?? (row.stage === 'active' ? 'draft' : row.stage === 'review' ? 'qa' : 'planned')
    const running = row.agentState === 'running'
    if (!IN_PROGRESS.has(stage) && !running) continue
    const at = Date.parse(row.lineChangedAt ?? '') || Date.parse(row.createdOn ?? '') || 0
    out.push({ title: row.title || row.text || '', stage, running, movedMinutes: at > 0 ? Math.max(0, Math.round((now - at) / 60000)) : null })
  }
  const age = (w: BriefWork) => (w.movedMinutes == null ? Number.MAX_SAFE_INTEGER : w.movedMinutes)
  return out.sort((a, b) => Number(b.running) - Number(a.running) || age(a) - age(b)).slice(0, 12)
}

/**
 * The body without `force` and `reason`, and what they asked. Anything but a boolean `force` is a bad request; 7.0.5
 * `reason` may only be "reconnect".
 */
export function splitForce(raw: unknown): { body: unknown; force: boolean; reconnect: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('force' in raw || 'reason' in raw)) return { body: raw, force: false, reconnect: false }
  const { force, reason, ...rest } = raw as Record<string, unknown>
  if (force !== undefined && typeof force !== 'boolean') throw new TodayBriefInputError('invalid_today_brief')
  if (reason !== undefined && reason !== 'reconnect') throw new TodayBriefInputError('invalid_today_brief')
  return { body: rest, force: force === true, reconnect: reason === 'reconnect' }
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
      // 7.0.1: `force` is the refresh button's flag, taken off before the rows are read (the rows reject unknown keys).
      const { body, force, reconnect } = splitForce(req.body)
      // The switch first: off reads nothing, not even the board.
      if (!deps.brief.settings().enabled) {
        normalizeTodayBriefInputs(body)
        return res.json(deps.brief.peek())
      }
      // Every gate that needs no reads goes first (switch, recording, drain, breaker, daily cap, interval or, forced,
      // the 30 s refresh floor): a gated ask answers from the page's rows alone and reads neither the board nor any
      // transcript.
      const pageInputs = normalizeTodayBriefInputs(body)
      const closed = deps.brief.gate({ force, reconnect })
      if (closed) return res.json(deps.brief.askGated(pageInputs, closed))
      const now = (deps.now ?? Date.now)()
      // The board and the session reads run together; the reads stop being waited for after 2.5 s and the ask goes on
      // with whatever they wrote by then (a Codex first scan that runs on still fills its memo for the next ask).
      const keys = sessionContextLookups(normalizeTodayBriefInputs(body))
      const context = emptySessionContext()
      let timer: ReturnType<typeof setTimeout> | undefined
      const reads = keys.length && deps.context
        ? Promise.race([Promise.resolve().then(() => deps.context!(keys, context)).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, TODAY_BRIEF_SUBAGENT_WAIT_MS) })]).finally(() => clearTimeout(timer))
        : Promise.resolve()
      const [rows] = await Promise.all([deps.board().catch(() => null), reads])
      // A snapshot: a read still running after the wait cannot change the inputs under the call.
      const agents = new Map(context.agents), recent = new Map(context.recent)
      let inputs = normalizeTodayBriefInputs(body, workInProgress(rows, now))
      inputs = withRecentActivity(withSubagents(inputs, agents, now), recent, now)
      res.json(await deps.brief.ask(inputs, todayBriefFingerprint(pageInputs), { force, reconnect }))
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
  // 7.0.5 "Summaries per day" (Control Web Settings and COS Control use the same route).
  router.get('/today/brief/settings/cap', (_req, res) => {
    try { res.json(deps.brief.cap()) } catch { failed(res) }
  })
  router.put('/today/brief/settings/cap', (req, res) => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'dailyCap') || typeof body.dailyCap !== 'number' || !Number.isFinite(body.dailyCap)) {
      return res.status(400).json({ error: { code: 'invalid_today_brief_cap', message: 'Send { dailyCap: a number from 1 to 100 }.' } })
    }
    try { res.json(deps.brief.setDailyCap(body.dailyCap)) } catch { failed(res) }
  })
  return router
}
