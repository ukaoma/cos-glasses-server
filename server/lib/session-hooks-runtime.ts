// The composition root for session hooks: the one signal store, the ledger, the spool
// ingester, and the per-session facts the routes read.
//
// `COS_SESSION_HOOKS` (default: on whenever `COS_CLAUDE_SESSIONS_ENABLED=1`) gates the
// APPLY, never the drain: with the flag off the spool is still ledgered, unlinked and
// stamped, and nothing reaches a row. Control's env allowlist carries the flag across
// Update Server (main.swift `providerEnvironmentKeys`).

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { cosSpawnedPids } from './agent-session-ownership-store.js'
import { dataPath } from './data-dir.js'
import { SessionHookLedger } from './session-hook-ledger.js'
import { startSpoolIngester, type SpoolIngester, type SpoolStats } from './session-hook-spool.js'
import { SessionSignalStore, type SessionSignal } from './session-signal-store.js'
import { deriveSessionState, type DerivedSessionState, type RegistryFacts, type TranscriptFacts } from './session-state-derive.js'
import { ensureHookRuntimeFiles, ensureStableHookScript, hookStatus, type HookStatus } from './claude-hooks-installer.js'

export function sessionHooksEnabled(): boolean {
  const raw = process.env.COS_SESSION_HOOKS
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  return process.env.COS_CLAUDE_SESSIONS_ENABLED === '1'
}

export function spoolDir(): string {
  return process.env.COS_SESSION_HOOKS_SPOOL_DIR || dataPath('hook-spool')
}

export function deskIdleSeconds(): number {
  const raw = Number(process.env.COS_PERMISSION_BROKER_DESK_IDLE_S)
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 90
}

/** Replay this much ledger history into the store at boot. */
export const LEDGER_REPLAY_WINDOW_MS = 6 * 60 * 60_000

// A hook's ppid is the claude process when `sh -c` exec'd the script, or the `sh -c`
// wrapper when it did not. Ask ps for the parent once and remember it for a minute.
const parentCache = new Map<number, { parent: number | null; at: number }>()
const PARENT_CACHE_MS = 60_000

function parentPid(pid: number): number | null {
  const cached = parentCache.get(pid)
  if (cached && Date.now() - cached.at < PARENT_CACHE_MS) return cached.parent
  let parent: number | null = null
  try {
    const out = execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8', timeout: 1_000 })
    const n = Number(out.trim())
    parent = Number.isInteger(n) && n > 0 ? n : null
  } catch { parent = null }
  if (parentCache.size > 512) parentCache.clear()
  parentCache.set(pid, { parent, at: Date.now() })
  return parent
}

export function isCosSpawnedPid(pid: number | null): boolean {
  if (pid === null) return false
  const spawned = cosSpawnedPids()
  if (spawned.size === 0) return false
  if (spawned.has(pid)) return true
  const parent = parentPid(pid)
  return parent !== null && spawned.has(parent)
}

export const sessionSignalStore = new SessionSignalStore({ isCosSpawnedPid })

let ledger: SessionHookLedger | null = null
let ingester: SpoolIngester | null = null
let replayed: { rows: number; applied: number } | null = null
const deadScansById = new Map<string, number>()

export interface SessionHooksRuntime {
  store: SessionSignalStore
  stop(): void
}

export function startSessionHooksRuntime(options: { port: number }): SessionHooksRuntime {
  const dir = spoolDir()
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* the ingester reports it */ }
  ledger = new SessionHookLedger(dataPath('session-hook-events.jsonl'))
  const enabled = sessionHooksEnabled()
  const since = Date.now() - LEDGER_REPLAY_WINDOW_MS
  const replay = ledger.replay(since, env => { if (enabled) sessionSignalStore.apply(env) })
  replayed = { rows: replay.rows, applied: replay.applied }
  ingester = startSpoolIngester({
    dir,
    ledger,
    seenKeys: replay.keys,
    apply: enabled ? env => { sessionSignalStore.apply(env) } : undefined,
  })
  // Runtime files the script reads. The port can change per install; the token never does.
  try {
    ensureHookRuntimeFiles(options.port, deskIdleSeconds())
    if (hookStatus().state === 'script_outdated') ensureStableHookScript()
  } catch (error) {
    console.error(`[session-hooks] runtime files: ${error instanceof Error ? error.message : error}`)
  }
  const pruneTimer = setInterval(() => { sessionSignalStore.prune() }, 10 * 60_000)
  pruneTimer.unref()
  return {
    store: sessionSignalStore,
    stop() {
      clearInterval(pruneTimer)
      ingester?.stop()
    },
  }
}

export interface SessionHooksHealth {
  enabled: boolean
  installed: HookStatus['state']
  scriptSha: string | null
  lastEventAt: string | null
  spoolBacklog: number
  ledgerBytes: number
  ledgerError: string | null
  signals: number
  replayed: { rows: number; applied: number } | null
  spool: SpoolStats | null
}

export function sessionHooksHealthFields(): { sessionHooks: SessionHooksHealth } {
  const status = hookStatus()
  const spool = ingester?.stats() ?? null
  const ledgerStats = ledger?.stats() ?? null
  const newest = sessionSignalStore.newestEventAt()
  return {
    sessionHooks: {
      enabled: sessionHooksEnabled(),
      installed: status.state,
      scriptSha: status.scriptSha,
      lastEventAt: newest ? new Date(newest).toISOString() : null,
      spoolBacklog: spool?.backlog ?? 0,
      ledgerBytes: ledgerStats?.bytes ?? 0,
      ledgerError: ledgerStats?.lastError ?? spool?.lastError ?? null,
      signals: sessionSignalStore.size(),
      replayed,
      spool,
    },
  }
}

/** Signal for a row id that may be the registry's eight-character form. */
export function signalFor(sessionId: string): SessionSignal | undefined {
  if (!sessionHooksEnabled()) return undefined
  return sessionId.length >= 36 ? sessionSignalStore.get(sessionId) : sessionSignalStore.getByPrefix(sessionId)
}

/**
 * Derive with the two-scan memory kept here, keyed by full id when known. Rows the
 * caller has no facts for at all get nothing, so an older payload stays byte-identical.
 */
export function deriveForRow(input: { sessionId: string; registry?: RegistryFacts; transcript?: TranscriptFacts; now?: number }): DerivedSessionState | undefined {
  const signal = signalFor(input.sessionId)
  if (!signal && !input.registry && !input.transcript) return undefined
  const key = signal?.sessionId ?? input.sessionId
  const derived = deriveSessionState({
    signal,
    registry: input.registry,
    transcript: input.transcript,
    now: input.now ?? Date.now(),
    prevDeadScans: deadScansById.get(key) ?? 0,
  })
  if (deadScansById.size > 2_048) deadScansById.clear()
  deadScansById.set(key, derived.deadScans)
  return derived
}

export function __resetSessionHooksForTests(): void {
  sessionSignalStore.__resetForTests()
  deadScansById.clear()
  parentCache.clear()
}
