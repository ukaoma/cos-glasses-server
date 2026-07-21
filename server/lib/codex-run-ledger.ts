import crypto from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { cosBrainDir } from './launch-dir.js'
import { CODEX_ENGINE_SESSION_TTL_MS, type CodexTrustMode } from './codex-engine-sessions.js'
import {
  CODEX_FRONTIER_MODEL,
  CODEX_HIGH_REASONING_EFFORT,
  type CodexModelPreference,
} from '../../shared/model-preference.js'
import { dataPath } from './data-dir.js'
import {
  getCodexModelCatalogSnapshot,
  resolveCodexModelOption,
} from './codex-model-catalog.js'

const DEFAULT_MAX_RUNS = 100
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000
const ERROR_PREVIEW_CHARS = 160
const RUNNING_STALE_MS = 30 * 60_000

function getProcessStartedAtMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000)
}

export type CodexRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'client_disconnected'

export interface CodexRunRecord {
  runId: string
  cosSessionId: string
  codexThreadId?: string
  status: CodexRunStatus
  createdAt: string
  updatedAt: string
  model: CodexModelPreference
  cliModel: string
  reasoningEffort: string
  cwd: string
  ephemeral: boolean
  resumed?: boolean
  trustMode: CodexTrustMode
  expiresAt?: string
  resumeCommand?: string
  queryPreview?: string
  outputPreview?: string
  errorCode?: string
  errorPreview?: string
  durationMs?: number
  exitCode?: number | null
}

interface CodexRunEvent {
  runId: string
  ts: string
  patch: Partial<CodexRunRecord>
}

export interface CodexRunConfig {
  cliModel: string
  catalogSource: string
  availableModels: Array<{ preference: CodexModelPreference; model: string; displayName: string }>
  reasoningEffort: string
  persistenceEnabled: boolean
  cwd: string
  trustMode: CodexTrustMode
  engineSessionTtlMinutes: number
  historyLimit: number
  historyTtlDays: number
  contentPreviewsEnabled: boolean
}

export function isCodexPersistenceEnabled(): boolean {
  return process.env.COS_CODEX_PERSIST_SESSIONS !== '0'
}

export function areCodexContentPreviewsEnabled(): boolean {
  return process.env.COS_CODEX_RUN_CONTENT_PREVIEWS === '1'
}

export function getCodexExecutionCwd(): string {
  const configured = process.env.CODEX_GLASSES_WORKDIR?.trim()
  if (configured) return resolve(configured)
  if (COS_SCRIPTS_DIR) return resolve(COS_SCRIPTS_DIR, '..', '..')
  // A Starter-Kit COS in the directory the user launched npx from — Codex
  // loads its AGENTS.md brain natively when run there.
  const brain = cosBrainDir()
  if (brain) return brain
  // Last resort when neither CODEX_GLASSES_WORKDIR nor COS_SCRIPTS_DIR is set:
  // the server's own working dir (codex glasses is an optional, env-configured feature).
  return process.cwd()
}

export function getCodexTrustMode(): CodexTrustMode {
  return process.env.COS_CODEX_SANDBOX === 'workspace-write' ? 'workspace-write' : 'read-only'
}

export function getCodexRunConfig(): CodexRunConfig {
  const catalog = getCodexModelCatalogSnapshot()
  const frontier = resolveCodexModelOption(CODEX_FRONTIER_MODEL)
  return {
    cliModel: frontier.id || 'codex-cli-default',
    catalogSource: catalog.source,
    availableModels: catalog.options.map(option => ({
      preference: option.preference,
      model: option.id || 'codex-cli-default',
      displayName: option.displayName,
    })),
    reasoningEffort: CODEX_HIGH_REASONING_EFFORT,
    persistenceEnabled: isCodexPersistenceEnabled(),
    cwd: getCodexExecutionCwd(),
    trustMode: getCodexTrustMode(),
    engineSessionTtlMinutes: Math.round(CODEX_ENGINE_SESSION_TTL_MS / 60_000),
    historyLimit: getMaxRuns(),
    historyTtlDays: Math.round(getTtlMs() / (24 * 60 * 60_000)),
    contentPreviewsEnabled: areCodexContentPreviewsEnabled(),
  }
}

export function getCodexLedgerPath(): string {
  return resolve(process.env.COS_CODEX_RUN_LEDGER_FILE || dataPath('codex-runs.jsonl'))
}

function getMaxRuns(): number {
  const raw = Number(process.env.COS_CODEX_RUN_LEDGER_MAX ?? DEFAULT_MAX_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS
}

function getTtlMs(): number {
  const rawDays = Number(process.env.COS_CODEX_RUN_LEDGER_TTL_DAYS ?? 7)
  return Number.isFinite(rawDays) && rawDays > 0 ? rawDays * 24 * 60 * 60_000 : DEFAULT_TTL_MS
}

function appendEvent(event: CodexRunEvent): void {
  try {
    const path = getCodexLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (err) {
    console.warn('[codex-run-ledger] write skipped:', err)
  }
}

function readEvents(): CodexRunEvent[] {
  const path = getCodexLedgerPath()
  if (!existsSync(path)) return []
  try {
    const events: CodexRunEvent[] = []
    for (const line of readFileSync(path, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)) {
      try {
        const event = JSON.parse(line) as CodexRunEvent
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

function hydrateRuns(): CodexRunRecord[] {
  const runs = new Map<string, CodexRunRecord>()
  const order = new Map<string, number>()
  let eventIndex = 0
  for (const event of readEvents()) {
    eventIndex += 1
    const existing = runs.get(event.runId)
    const next = { ...(existing ?? {}), ...event.patch, runId: event.runId } as CodexRunRecord
    if (next.codexThreadId && !next.resumeCommand) {
      next.resumeCommand = `codex exec resume ${next.codexThreadId}`
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
        const interruptedRun: CodexRunRecord = {
          ...run,
          status: 'client_disconnected',
          errorCode: run.errorCode ?? 'codex.interrupted',
        }
        return interruptedRun
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

export function redactForCodexLedger(value: string, maxChars = ERROR_PREVIEW_CHARS): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:sk|sess|ghp|github_pat|glpat)-[A-Za-z0-9_\-]{12,}\b/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}\b/gi, 'Bearer [token]')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[blob]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

export function classifyCodexError(message: string): string {
  const text = message.toLowerCase()
  if (/command not found|enoent|not found/.test(text)) return 'codex.cli_unavailable'
  if (/permission|denied|sandbox|read-only|operation not permitted/.test(text)) return 'codex.permission_denied'
  if (/auth|login|sign in|unauthorized|forbidden|token/.test(text)) return 'codex.auth_error'
  if (/timeout|timed out|wall clock|no output/.test(text)) return 'codex.timeout'
  if (/exit\s+\d+/.test(text)) return 'codex.nonzero_exit'
  return 'codex.error'
}

export function extractCodexThreadId(event: any): string | undefined {
  const type = String(event?.type ?? '').toLowerCase()
  if (!/(thread|session).*(started|created)|^(thread|session)\.started$/.test(type)) return undefined
  const candidate = event?.thread_id ?? event?.threadId ?? event?.session_id ?? event?.sessionId ?? event?.id
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

export function startCodexRun(input: {
  cosSessionId: string
  model: CodexModelPreference
  cwd: string
  ephemeral: boolean
  resumed?: boolean
  trustMode?: CodexTrustMode
  codexThreadId?: string
  expiresAt?: string
  query: string
  cliModel?: string
  reasoningEffort?: string
}): CodexRunRecord {
  const now = new Date().toISOString()
  const run: CodexRunRecord = {
    runId: `codex-${crypto.randomUUID().slice(0, 8)}`,
    cosSessionId: input.cosSessionId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    model: input.model,
    cliModel: input.cliModel ?? (resolveCodexModelOption(input.model).id || 'codex-cli-default'),
    reasoningEffort: input.reasoningEffort ?? CODEX_HIGH_REASONING_EFFORT,
    cwd: input.cwd,
    ephemeral: input.ephemeral,
    resumed: input.resumed,
    trustMode: input.trustMode ?? getCodexTrustMode(),
    codexThreadId: input.codexThreadId,
    expiresAt: input.expiresAt,
  }
  if (areCodexContentPreviewsEnabled()) {
    run.queryPreview = redactForCodexLedger(input.query)
  }
  appendEvent({ runId: run.runId, ts: now, patch: run })
  return run
}

export function updateCodexRun(runId: string, patch: Partial<Omit<CodexRunRecord, 'runId' | 'createdAt'>>): CodexRunRecord | null {
  const ts = new Date().toISOString()
  const safePatch = { ...patch, updatedAt: ts }
  if (safePatch.codexThreadId && !safePatch.resumeCommand) {
    safePatch.resumeCommand = `codex exec resume ${safePatch.codexThreadId}`
  }
  appendEvent({ runId, ts, patch: safePatch })
  return getCodexRun(runId)
}

export function finishCodexRun(runId: string, input: {
  status: Exclude<CodexRunStatus, 'running'>
  startedAtMs: number
  output?: string
  error?: string
  exitCode?: number | null
}): CodexRunRecord | null {
  const patch: Partial<CodexRunRecord> = {
    status: input.status,
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    exitCode: input.exitCode,
  }
  if (input.output && areCodexContentPreviewsEnabled()) {
    patch.outputPreview = redactForCodexLedger(input.output)
  }
  if (input.error) {
    patch.errorCode = classifyCodexError(input.error)
    if (areCodexContentPreviewsEnabled()) {
      patch.errorPreview = redactForCodexLedger(input.error)
    }
  }
  return updateCodexRun(runId, patch)
}

export function listCodexRuns(limit = 20, cosSessionId?: string): CodexRunRecord[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), getMaxRuns()) : 20
  const runs = hydrateRuns()
  return (cosSessionId ? runs.filter(run => run.cosSessionId === cosSessionId) : runs).slice(0, safeLimit)
}

export function getCodexRun(runId: string): CodexRunRecord | null {
  return hydrateRuns().find(run => run.runId === runId) ?? null
}
