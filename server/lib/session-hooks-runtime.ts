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
import { ensureHookRuntimeFiles, ensureStableHookScript, hookSpoolDir, hookStatus, type HookStatus } from './claude-hooks-installer.js'

export function sessionHooksEnabled(): boolean {
  const raw = process.env.COS_SESSION_HOOKS
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  return process.env.COS_CLAUDE_SESSIONS_ENABLED === '1'
}

export function spoolDir(): string {
  return hookSpoolDir()
}

export function deskIdleSeconds(): number {
  const raw = Number(process.env.COS_PERMISSION_BROKER_DESK_IDLE_S)
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 90
}

/** Replay this much ledger history into the store at boot. */
export const LEDGER_REPLAY_WINDOW_MS = 6 * 60 * 60_000

// A hook's ppid is the claude process itself: macOS `sh -c '<script> <Event>'` execs the
// single command, and every recorded session (fixtures, 2026-09-15) shows one ppid across all
// of its events. The `ps` parent lookup below is the fallback for a shell that does not exec;
// it runs once per pid and is remembered for a minute.
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

// A child's synchronous SessionEnd is spooled ~150 ms before the child exits, and the spawn
// ledger forgets the pid the moment it does; the sweep that reads the file can run after.
// So every pid the ledger ever vouched for is remembered here for a grace window.
const recentCosPids = new Map<number, number>()
export const COS_PID_TOMBSTONE_MS = 60_000

export function isCosSpawnedPid(pid: number | null, nowMs = Date.now()): boolean {
  if (pid === null) return false
  const spawned = cosSpawnedPids()
  for (const p of spawned.keys()) recentCosPids.set(p, nowMs)
  if (recentCosPids.size > 256) {
    for (const [p, at] of recentCosPids) if (nowMs - at > COS_PID_TOMBSTONE_MS) recentCosPids.delete(p)
  }
  const remembered = (p: number) => { const at = recentCosPids.get(p); return at !== undefined && nowMs - at <= COS_PID_TOMBSTONE_MS }
  if (spawned.has(pid) || remembered(pid)) return true
  if (spawned.size === 0 && recentCosPids.size === 0) return false
  const parent = parentPid(pid)
  return parent !== null && (spawned.has(parent) || remembered(parent))
}

export const sessionSignalStore = new SessionSignalStore({ isCosSpawnedPid })

let ledger: SessionHookLedger | null = null
let ingester: SpoolIngester | null = null
let replayed: { rows: number; applied: number } | null = null
/** The two-scan memory: consecutive dead observations and when the first one was. */
const deadById = new Map<string, { scans: number; since: number | null; at: number }>()
const DEAD_MEMORY_MS = 60 * 60_000

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
  const replay = ledger.replay(since, (env, _key, child) => { if (enabled) sessionSignalStore.apply(env, child) })
  replayed = { rows: replay.rows, applied: replay.applied }
  ingester = startSpoolIngester({
    dir,
    ledger,
    seenKeys: replay.keys,
    isChild: env => isCosSpawnedPid(env.ppid),
    apply: enabled ? (env, child) => { sessionSignalStore.apply(env, child) } : undefined,
  })
  // Runtime files the script reads. The port can change per install; the token never does.
  // The script is copied only when MISSING here: a boot must never downgrade what a newer
  // `--hooks install` put at the stable path.
  try {
    ensureHookRuntimeFiles(options.port, deskIdleSeconds())
    ensureStableHookScript(undefined, undefined, true)
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
  /** The install state word; `installed` below is its boolean. */
  state: HookStatus['state']
  installed: boolean
  scriptSha: string | null
  tokenPresent: boolean
  lastEventAt: string | null
  spoolBacklog: number
  spoolStuck: number
  applyErrors: number
  ledgerBytes: number
  /** Error CODES only (ENOSPC, EACCES); a message would carry the home path onto public health. */
  ledgerError: string | null
  spoolError: string | null
  signals: number
  replayed: { rows: number; applied: number } | null
  spool: SpoolStats | null
}

// Health is polled by three clients every few seconds; the status read (settings parse,
// two hashes) is cheap but not free, and it cannot change faster than this.
let statusCache: { at: number; value: HookStatus } | null = null
const STATUS_CACHE_MS = 5_000

export function cachedHookStatus(nowMs = Date.now()): HookStatus {
  if (statusCache && nowMs - statusCache.at < STATUS_CACHE_MS) return statusCache.value
  const value = hookStatus()
  statusCache = { at: nowMs, value }
  return value
}

export function invalidateHookStatus(): void {
  statusCache = null
}

export function sessionHooksHealthFields(): { sessionHooks: SessionHooksHealth } {
  const status = cachedHookStatus()
  const spool = ingester?.stats() ?? null
  const ledgerStats = ledger?.stats() ?? null
  const newest = sessionSignalStore.newestEventAt()
  return {
    sessionHooks: {
      enabled: sessionHooksEnabled(),
      state: status.state,
      installed: status.installed,
      scriptSha: status.scriptSha,
      tokenPresent: status.tokenPresent,
      lastEventAt: newest ? new Date(newest).toISOString() : null,
      spoolBacklog: spool?.backlog ?? 0,
      spoolStuck: spool?.stuck ?? 0,
      applyErrors: spool?.applyErrors ?? 0,
      ledgerBytes: ledgerStats?.bytes ?? 0,
      ledgerError: ledgerStats?.lastError ?? null,
      spoolError: spool?.lastError ?? null,
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
  // Off means off: with the feature disabled every row is byte-identical to 6.47.0.
  if (!sessionHooksEnabled()) return undefined
  const signal = signalFor(input.sessionId)
  if (!signal && !input.registry && !input.transcript) return undefined
  const now = input.now ?? Date.now()
  const key = signal?.sessionId ?? input.sessionId.toLowerCase()
  const prev = deadById.get(key)
  const derived = deriveSessionState({
    signal,
    registry: input.registry,
    transcript: input.transcript,
    now,
    prevDeadScans: prev?.scans ?? 0,
    prevDeadSince: prev?.since ?? null,
  })
  if (deadById.size > 2_048) {
    for (const [k, v] of deadById) if (now - v.at > DEAD_MEMORY_MS) deadById.delete(k)
  }
  deadById.set(key, { scans: derived.deadScans, since: derived.deadSince, at: now })
  return derived
}

export function __resetSessionHooksForTests(): void {
  sessionSignalStore.__resetForTests()
  deadById.clear()
  parentCache.clear()
  recentCosPids.clear()
  statusCache = null
}
