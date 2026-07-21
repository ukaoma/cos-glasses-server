import crypto from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { dataPath } from './data-dir.js'
import type { ClaudeModelPreference } from '../../shared/model-preference.js'

const DEFAULT_MAX_RUNS = 100
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000
const ERROR_PREVIEW_CHARS = 160
const RUNNING_STALE_MS = 30 * 60_000
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number]
export const DEFAULT_CLAUDE_EFFORT_LEVEL: ClaudeEffortLevel = 'high'

function getProcessStartedAtMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000)
}

export type ClaudeRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'client_disconnected'

export interface ClaudeRunRecord {
  runId: string
  cosSessionId: string
  cliSessionId?: string
  status: ClaudeRunStatus
  createdAt: string
  updatedAt: string
  model: ClaudeModelPreference
  cliCommand: string
  effortLevel: ClaudeEffortLevel | 'ultracode'
  cliModelId?: string
  resolvedModelId?: string
  cwd: string
  resumed: boolean
  trustMode: 'full-access'
  timeoutMs: number
  wallMaxMs: number
  queryPreview?: string
  outputPreview?: string
  errorCode?: string
  errorPreview?: string
  durationMs?: number
  exitCode?: number | null
}

interface ClaudeRunEvent {
  runId: string
  ts: string
  patch: Partial<ClaudeRunRecord>
}

export interface ClaudeRunConfig {
  cliCommand: string
  persistenceEnabled: boolean
  cwd: string
  trustMode: 'full-access'
  defaultEffortLevel: ClaudeEffortLevel
  historyLimit: number
  historyTtlDays: number
  contentPreviewsEnabled: boolean
}

export function areClaudeContentPreviewsEnabled(): boolean {
  return process.env.COS_CLAUDE_RUN_CONTENT_PREVIEWS === '1'
}

export function getClaudeExecutionCwd(): string {
  return resolve(COS_SCRIPTS_DIR ?? process.cwd())
}

export function getClaudeEffortLevel(): ClaudeEffortLevel {
  const raw = process.env.COS_CLAUDE_EFFORT_LEVEL?.trim()
  if (!raw) return DEFAULT_CLAUDE_EFFORT_LEVEL
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(raw)) {
    return raw as ClaudeEffortLevel
  }
  console.warn(
    `[claude-run-ledger] Invalid COS_CLAUDE_EFFORT_LEVEL="${raw}"; ` +
    `using ${DEFAULT_CLAUDE_EFFORT_LEVEL}. Valid: ${CLAUDE_EFFORT_LEVELS.join(', ')}`,
  )
  return DEFAULT_CLAUDE_EFFORT_LEVEL
}

export function getClaudeRunConfig(): ClaudeRunConfig {
  return {
    cliCommand: 'claude -p',
    persistenceEnabled: true,
    cwd: getClaudeExecutionCwd(),
    trustMode: 'full-access',
    defaultEffortLevel: getClaudeEffortLevel(),
    historyLimit: getMaxRuns(),
    historyTtlDays: Math.round(getTtlMs() / (24 * 60 * 60_000)),
    contentPreviewsEnabled: areClaudeContentPreviewsEnabled(),
  }
}

export function getClaudeLedgerPath(): string {
  return resolve(process.env.COS_CLAUDE_RUN_LEDGER_FILE || dataPath('claude-runs.jsonl'))
}

function getMaxRuns(): number {
  const raw = Number(process.env.COS_CLAUDE_RUN_LEDGER_MAX ?? DEFAULT_MAX_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS
}

function getTtlMs(): number {
  const rawDays = Number(process.env.COS_CLAUDE_RUN_LEDGER_TTL_DAYS ?? 7)
  return Number.isFinite(rawDays) && rawDays > 0 ? rawDays * 24 * 60 * 60_000 : DEFAULT_TTL_MS
}

function appendEvent(event: ClaudeRunEvent): void {
  try {
    const path = getClaudeLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (err) {
    console.warn('[claude-run-ledger] write skipped:', err)
  }
}

function readEvents(): ClaudeRunEvent[] {
  const path = getClaudeLedgerPath()
  if (!existsSync(path)) return []
  try {
    const events: ClaudeRunEvent[] = []
    for (const line of readFileSync(path, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)) {
      try {
        const event = JSON.parse(line) as ClaudeRunEvent
        if (typeof event.runId === 'string' && typeof event.ts === 'string' && typeof event.patch === 'object') {
          events.push(event)
        }
      } catch {
        // Skip torn/corrupt JSONL rows; valid prior records should stay visible.
      }
    }
    return events
  } catch {
    return []
  }
}

function hydrateRuns(): ClaudeRunRecord[] {
  const runs = new Map<string, ClaudeRunRecord>()
  const order = new Map<string, number>()
  let eventIndex = 0
  for (const event of readEvents()) {
    eventIndex += 1
    const existing = runs.get(event.runId)
    const next = { ...(existing ?? {}), ...event.patch, runId: event.runId } as ClaudeRunRecord
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
          status: 'client_disconnected' as ClaudeRunStatus,
          errorCode: run.errorCode ?? 'claude.interrupted',
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

export function redactForClaudeLedger(value: string, maxChars = ERROR_PREVIEW_CHARS): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:sk|sess|ghp|github_pat|glpat)-[A-Za-z0-9_\-]{12,}\b/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}\b/gi, 'Bearer [token]')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[blob]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

export function classifyClaudeError(message: string): string {
  const text = message.toLowerCase()
  if (/command not found|enoent|not found/.test(text)) return 'claude.cli_unavailable'
  if (/permission|denied|sandbox|read-only|operation not permitted/.test(text)) return 'claude.permission_denied'
  if (/auth|login|sign in|unauthorized|forbidden|token/.test(text)) return 'claude.auth_error'
  if (/timeout|timed out|wall clock|no output/.test(text)) return 'claude.timeout'
  if (/exit\s+\d+/.test(text)) return 'claude.nonzero_exit'
  return 'claude.error'
}

export function startClaudeRun(input: {
  cosSessionId: string
  model: ClaudeModelPreference
  cwd: string
  resumed: boolean
  cliSessionId?: string
  timeoutMs: number
  wallMaxMs: number
  query: string
  effortLevel?: ClaudeEffortLevel | 'ultracode'
  cliModelId?: string
}): ClaudeRunRecord {
  const now = new Date().toISOString()
  const run: ClaudeRunRecord = {
    runId: `claude-${crypto.randomUUID().slice(0, 8)}`,
    cosSessionId: input.cosSessionId,
    cliSessionId: input.cliSessionId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    model: input.model,
    cliCommand: 'claude -p',
    effortLevel: input.effortLevel ?? getClaudeEffortLevel(),
    cliModelId: input.cliModelId,
    cwd: input.cwd,
    resumed: input.resumed,
    trustMode: 'full-access',
    timeoutMs: input.timeoutMs,
    wallMaxMs: input.wallMaxMs,
  }
  if (areClaudeContentPreviewsEnabled()) {
    run.queryPreview = redactForClaudeLedger(input.query)
  }
  appendEvent({ runId: run.runId, ts: now, patch: run })
  return run
}

export function updateClaudeRun(runId: string, patch: Partial<Omit<ClaudeRunRecord, 'runId' | 'createdAt'>>): ClaudeRunRecord | null {
  const ts = new Date().toISOString()
  appendEvent({ runId, ts, patch: { ...patch, updatedAt: ts } })
  return getClaudeRun(runId)
}

export function finishClaudeRun(runId: string, input: {
  status: Exclude<ClaudeRunStatus, 'running'>
  startedAtMs: number
  output?: string
  error?: string
  exitCode?: number | null
}): ClaudeRunRecord | null {
  const patch: Partial<ClaudeRunRecord> = {
    status: input.status,
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    exitCode: input.exitCode,
  }
  if (input.output && areClaudeContentPreviewsEnabled()) {
    patch.outputPreview = redactForClaudeLedger(input.output)
  }
  if (input.error) {
    patch.errorCode = classifyClaudeError(input.error)
    if (areClaudeContentPreviewsEnabled()) {
      patch.errorPreview = redactForClaudeLedger(input.error)
    }
  }
  return updateClaudeRun(runId, patch)
}

export function listClaudeRuns(limit = 20, cosSessionId?: string, model?: ClaudeModelPreference): ClaudeRunRecord[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), getMaxRuns()) : 20
  return hydrateRuns()
    .filter(run => !cosSessionId || run.cosSessionId === cosSessionId)
    .filter(run => !model || run.model === model)
    .slice(0, safeLimit)
}

export function getClaudeRun(runId: string): ClaudeRunRecord | null {
  return hydrateRuns().find(run => run.runId === runId) ?? null
}
