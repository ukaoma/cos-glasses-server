import crypto from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { OLLAMA_MODEL, type OllamaModelPreference } from '../../shared/model-preference.js'

const DEFAULT_MAX_RUNS = 100
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000
const ERROR_PREVIEW_CHARS = 160
const RUNNING_STALE_MS = 30 * 60_000

export type OllamaRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'client_disconnected'

export interface OllamaRunRecord {
  runId: string
  turnId?: string
  clientJobId?: string
  cosSessionId: string
  status: OllamaRunStatus
  createdAt: string
  updatedAt: string
  model: OllamaModelPreference
  ollamaModel: string
  origin: string
  queryPreview?: string
  outputPreview?: string
  errorCode?: string
  errorPreview?: string
  durationMs?: number
}

interface OllamaRunEvent {
  runId: string
  ts: string
  patch: Partial<OllamaRunRecord>
}

function getProcessStartedAtMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000)
}

export function getOllamaLedgerPath(): string {
  return resolve(process.env.COS_OLLAMA_RUN_LEDGER_FILE || resolve(import.meta.dirname, '..', 'data', 'ollama-runs.jsonl'))
}

function getMaxRuns(): number {
  const raw = Number(process.env.COS_OLLAMA_RUN_LEDGER_MAX ?? DEFAULT_MAX_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS
}

function getTtlMs(): number {
  const rawDays = Number(process.env.COS_OLLAMA_RUN_LEDGER_TTL_DAYS ?? 7)
  return Number.isFinite(rawDays) && rawDays > 0 ? rawDays * 24 * 60 * 60_000 : DEFAULT_TTL_MS
}

function appendEvent(event: OllamaRunEvent): void {
  try {
    const path = getOllamaLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + '\n')
  } catch (err) {
    console.warn('[ollama-run-ledger] write skipped:', err)
  }
}

function readEvents(): OllamaRunEvent[] {
  const path = getOllamaLedgerPath()
  if (!existsSync(path)) return []
  try {
    const events: OllamaRunEvent[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n').map(row => row.trim()).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as OllamaRunEvent
        if (typeof event.runId === 'string' && typeof event.ts === 'string' && typeof event.patch === 'object') {
          events.push(event)
        }
      } catch {
        // Skip torn JSONL rows.
      }
    }
    return events
  } catch {
    return []
  }
}

export function redactForOllamaLedger(value: string, maxChars = ERROR_PREVIEW_CHARS): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

export function classifyOllamaError(message: string): string {
  const text = message.toLowerCase()
  if (/unreachable|econnrefused|fetch failed|enotfound/.test(text)) return 'ollama.unavailable'
  if (/no models|not ready/.test(text)) return 'ollama.no_model'
  if (/text-only|photo|image/.test(text)) return 'ollama.text_only'
  // BOTH tool codes must precede the /aborted/ branch below. A cancelled tool
  // reads "aborted" and would otherwise be reported to the user as a timeout,
  // and the round-cap message would fall all the way through to the generic
  // 'ollama.error' and surface as "Ollama failed (ollama.error)" — which tells
  // the user nothing about what actually stopped the turn.
  if (/tool round cap/.test(text)) return 'ollama.tool_cap'
  if (/tool aborted|tool call aborted/.test(text)) return 'ollama.tool_abort'
  if (/timeout|timed out|aborted/.test(text)) return 'ollama.timeout'
  return 'ollama.error'
}

export function startOllamaRun(input: {
  turnId?: string
  clientJobId?: string
  cosSessionId: string
  ollamaModel: string
  origin: string
  query: string
}): OllamaRunRecord {
  const now = new Date().toISOString()
  const run: OllamaRunRecord = {
    runId: `ollama-${crypto.randomUUID().slice(0, 8)}`,
    turnId: input.turnId,
    clientJobId: input.clientJobId,
    cosSessionId: input.cosSessionId,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    model: OLLAMA_MODEL,
    ollamaModel: input.ollamaModel,
    origin: input.origin,
    queryPreview: redactForOllamaLedger(input.query),
  }
  appendEvent({ runId: run.runId, ts: now, patch: run })
  return run
}

export function finishOllamaRun(runId: string, input: {
  status: Exclude<OllamaRunStatus, 'running'>
  startedAtMs: number
  output?: string
  error?: string
}): OllamaRunRecord | null {
  const patch: Partial<OllamaRunRecord> = {
    status: input.status,
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
  }
  if (input.output) patch.outputPreview = redactForOllamaLedger(input.output)
  if (input.error) {
    patch.errorCode = classifyOllamaError(input.error)
    patch.errorPreview = redactForOllamaLedger(input.error)
  }
  const ts = new Date().toISOString()
  appendEvent({ runId, ts, patch: { ...patch, updatedAt: ts } })
  return getOllamaRun(runId)
}

export function getOllamaRun(runId: string): OllamaRunRecord | null {
  return listOllamaRuns(getMaxRuns()).find(run => run.runId === runId) ?? null
}

export function listOllamaRuns(limit = 20, sessionId?: string): OllamaRunRecord[] {
  const runs = new Map<string, OllamaRunRecord>()
  const order = new Map<string, number>()
  let eventIndex = 0
  for (const event of readEvents()) {
    eventIndex += 1
    const existing = runs.get(event.runId)
    const next = { ...(existing ?? {}), ...event.patch, runId: event.runId } as OllamaRunRecord
    runs.set(event.runId, next)
    order.set(event.runId, eventIndex)
  }
  const cutoff = Date.now() - getTtlMs()
  return Array.from(runs.values())
    .filter(run => run.createdAt && Date.parse(run.updatedAt || run.createdAt) >= cutoff)
    .filter(run => !sessionId || run.cosSessionId === sessionId)
    .map(run => {
      const updatedMs = Date.parse(run.updatedAt || run.createdAt)
      const predatesCurrentProcess = updatedMs < getProcessStartedAtMs() - 1000
      if (run.status === 'running' && (predatesCurrentProcess || Date.now() - updatedMs > RUNNING_STALE_MS)) {
        return {
          ...run,
          status: 'client_disconnected' as const,
          errorCode: run.errorCode ?? 'ollama.timeout',
        }
      }
      return run
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
}
