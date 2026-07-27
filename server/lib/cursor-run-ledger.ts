import crypto from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CURSOR_ENGINE_SESSION_TTL_MS } from './cursor-engine-sessions.js'
import {
  CURSOR_GROK_MODEL,
  type CursorModelPreference,
} from '../../shared/model-preference.js'
import {
  getCursorModelCatalogSnapshot,
  resolveCursorModelOption,
} from './cursor-model-catalog.js'
import { getCodexExecutionCwd } from './codex-run-ledger.js'

const DEFAULT_MAX_RUNS = 100
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000
const ERROR_PREVIEW_CHARS = 160
const RUNNING_STALE_MS = 30 * 60_000

function getProcessStartedAtMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000)
}

export type CursorRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'client_disconnected'

export interface CursorRunRecord {
  runId: string
  turnId?: string
  clientJobId?: string
  cosSessionId: string
  cursorChatId?: string
  status: CursorRunStatus
  createdAt: string
  updatedAt: string
  model: CursorModelPreference
  cliModel: string
  cwd: string
  resumed?: boolean
  expiresAt?: string
  resumeCommand?: string
  queryPreview?: string
  outputPreview?: string
  errorCode?: string
  errorPreview?: string
  durationMs?: number
  exitCode?: number | null
  messageEra?: string
  globalMsgNum?: number
  hasPersistedTerminalPatch?: boolean
}

interface CursorRunEvent {
  runId: string
  ts: string
  patch: Partial<CursorRunRecord>
}

export interface CursorRunConfig {
  cliModel: string
  catalogSource: string
  availableModels: Array<{ preference: CursorModelPreference; model: string; displayName: string }>
  persistenceEnabled: boolean
  cwd: string
  engineSessionTtlMinutes: number
  historyLimit: number
  historyTtlDays: number
  contentPreviewsEnabled: boolean
}

export function isCursorPersistenceEnabled(): boolean {
  return process.env.COS_CURSOR_PERSIST_SESSIONS !== '0'
}

export function areCursorContentPreviewsEnabled(): boolean {
  return process.env.COS_CURSOR_RUN_CONTENT_PREVIEWS === '1'
}

/** Same workspace resolver as Codex — Cursor --workspace uses this path. */
export function getCursorExecutionCwd(): string {
  return getCodexExecutionCwd()
}

export function getCursorRunConfig(): CursorRunConfig {
  const catalog = getCursorModelCatalogSnapshot()
  const grok = resolveCursorModelOption(CURSOR_GROK_MODEL)
  return {
    cliModel: grok?.id || 'cursor-cli-default',
    catalogSource: catalog.source,
    availableModels: catalog.options.map(option => ({
      preference: option.preference,
      model: option.id || 'cursor-cli-default',
      displayName: option.displayName,
    })),
    persistenceEnabled: isCursorPersistenceEnabled(),
    cwd: getCursorExecutionCwd(),
    engineSessionTtlMinutes: Math.round(CURSOR_ENGINE_SESSION_TTL_MS / 60_000),
    historyLimit: getMaxRuns(),
    historyTtlDays: Math.round(getTtlMs() / (24 * 60 * 60_000)),
    contentPreviewsEnabled: areCursorContentPreviewsEnabled(),
  }
}

export function getCursorLedgerPath(): string {
  return resolve(process.env.COS_CURSOR_RUN_LEDGER_FILE || resolve(import.meta.dirname, '..', 'data', 'cursor-runs.jsonl'))
}

function getMaxRuns(): number {
  const raw = Number(process.env.COS_CURSOR_RUN_LEDGER_MAX ?? DEFAULT_MAX_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS
}

function getTtlMs(): number {
  const rawDays = Number(process.env.COS_CURSOR_RUN_LEDGER_TTL_DAYS ?? 7)
  return Number.isFinite(rawDays) && rawDays > 0 ? rawDays * 24 * 60 * 60_000 : DEFAULT_TTL_MS
}

function appendEvent(event: CursorRunEvent): void {
  try {
    const path = getCursorLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + '\n')
  } catch (err) {
    console.warn('[cursor-run-ledger] write skipped:', err)
  }
}

function readEvents(): CursorRunEvent[] {
  const path = getCursorLedgerPath()
  if (!existsSync(path)) return []
  try {
    const events: CursorRunEvent[] = []
    for (const line of readFileSync(path, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)) {
      try {
        const event = JSON.parse(line) as CursorRunEvent
        if (typeof event.runId === 'string' && typeof event.ts === 'string' && typeof event.patch === 'object') {
          events.push(event)
        }
      } catch {
        // Skip torn/corrupt JSONL rows.
      }
    }
    return events
  } catch {
    return []
  }
}

function hydrateRuns(): CursorRunRecord[] {
  const runs = new Map<string, CursorRunRecord>()
  const order = new Map<string, number>()
  let eventIndex = 0
  for (const event of readEvents()) {
    eventIndex += 1
    const existing = runs.get(event.runId)
    const next = { ...(existing ?? {}), ...event.patch, runId: event.runId } as CursorRunRecord
    if (next.cursorChatId && !next.resumeCommand) {
      next.resumeCommand = `agent --resume ${next.cursorChatId}`
    }
    runs.set(event.runId, next)
    order.set(event.runId, eventIndex)
  }

  const cutoff = Date.now() - getTtlMs()
  return Array.from(runs.values())
    .filter(run => run.createdAt && Date.parse(run.updatedAt || run.createdAt) >= cutoff)
    .map(run => {
      const updatedMs = Date.parse(run.updatedAt || run.createdAt)
      const predatesCurrentProcess = updatedMs < getProcessStartedAtMs() - 1000
      if (run.status === 'running' && (predatesCurrentProcess || Date.now() - updatedMs > RUNNING_STALE_MS)) {
        return {
          ...run,
          status: 'client_disconnected' as const,
          errorCode: run.errorCode ?? 'cursor.interrupted',
        }
      }
      return run
    })
    .sort((a, b) => {
      const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt)
      if (byCreated !== 0) return byCreated
      return (order.get(b.runId) ?? 0) - (order.get(a.runId) ?? 0)
    })
    .slice(0, getMaxRuns())
}

export function redactForCursorLedger(value: string, maxChars = ERROR_PREVIEW_CHARS): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:sk|sess|ghp|github_pat|glpat|keycurs)-[A-Za-z0-9_\-]{12,}\b/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}\b/gi, 'Bearer [token]')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[blob]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

export function classifyCursorError(message: string): string {
  const text = message.toLowerCase()
  if (/command not found|enoent|not found|agent binary/.test(text)) return 'cursor.cli_unavailable'
  if (/permission|denied|sandbox|read-only|operation not permitted/.test(text)) return 'cursor.permission_denied'
  if (/auth|login|sign in|unauthorized|forbidden|token|(?:api|http|error)\s*(?:error)?\s*[:=-]?\s*(?:401|403)\b/.test(text)) {
    return 'cursor.auth_error'
  }
  if (/timeout|timed out|wall clock|no output/.test(text)) return 'cursor.timeout'
  if (/exit\s+\d+/.test(text)) return 'cursor.nonzero_exit'
  return 'cursor.error'
}

export function startCursorRun(input: {
  turnId?: string
  clientJobId?: string
  cosSessionId: string
  model: CursorModelPreference
  cwd: string
  resumed?: boolean
  cursorChatId?: string
  expiresAt?: string
  query: string
  cliModel?: string
  messageEra?: string
  globalMsgNum?: number
}): CursorRunRecord {
  const now = new Date().toISOString()
  const run: CursorRunRecord = {
    runId: `cursor-${crypto.randomUUID().slice(0, 8)}`,
    turnId: input.turnId,
    clientJobId: input.clientJobId,
    cosSessionId: input.cosSessionId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    model: input.model,
    cliModel: input.cliModel ?? (resolveCursorModelOption(input.model)?.id || 'cursor-cli-default'),
    cwd: input.cwd,
    resumed: input.resumed,
    cursorChatId: input.cursorChatId,
    expiresAt: input.expiresAt,
    messageEra: input.messageEra,
    globalMsgNum: input.globalMsgNum,
    hasPersistedTerminalPatch: false,
  }
  if (areCursorContentPreviewsEnabled()) {
    run.queryPreview = redactForCursorLedger(input.query)
  }
  appendEvent({ runId: run.runId, ts: now, patch: run })
  return run
}

export function updateCursorRun(runId: string, patch: Partial<Omit<CursorRunRecord, 'runId' | 'createdAt'>>): CursorRunRecord | null {
  const ts = new Date().toISOString()
  const safePatch = { ...patch, updatedAt: ts }
  if (safePatch.cursorChatId && !safePatch.resumeCommand) {
    safePatch.resumeCommand = `agent --resume ${safePatch.cursorChatId}`
  }
  appendEvent({ runId, ts, patch: safePatch })
  return getCursorRun(runId)
}

export function finishCursorRun(runId: string, input: {
  status: Exclude<CursorRunStatus, 'running'>
  startedAtMs: number
  output?: string
  error?: string
  exitCode?: number | null
}): CursorRunRecord | null {
  const patch: Partial<CursorRunRecord> = {
    status: input.status,
    hasPersistedTerminalPatch: true,
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    exitCode: input.exitCode,
  }
  if (input.output && areCursorContentPreviewsEnabled()) {
    patch.outputPreview = redactForCursorLedger(input.output)
  }
  if (input.error) {
    patch.errorCode = classifyCursorError(input.error)
    if (areCursorContentPreviewsEnabled()) {
      patch.errorPreview = redactForCursorLedger(input.error)
    }
  }
  return updateCursorRun(runId, patch)
}

export function listCursorRuns(limit = 20, cosSessionId?: string): CursorRunRecord[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), getMaxRuns()) : 20
  const runs = hydrateRuns()
  return (cosSessionId ? runs.filter(run => run.cosSessionId === cosSessionId) : runs).slice(0, safeLimit)
}

export function getCursorRun(runId: string): CursorRunRecord | null {
  return hydrateRuns().find(run => run.runId === runId) ?? null
}
