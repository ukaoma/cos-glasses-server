// The composition root for session hooks: the one signal store, the ledger, the spool
// ingester, and the per-session facts the routes read.
//
// `COS_SESSION_HOOKS` (default: on whenever `COS_CLAUDE_SESSIONS_ENABLED=1`) gates the
// APPLY, never the drain: with the flag off the spool is still ledgered, unlinked and
// stamped, and nothing reaches a row. Control's env allowlist carries the flag across
// Update Server (main.swift `providerEnvironmentKeys`).

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cosSpawnedPids } from './agent-session-ownership-store.js'
import { REGISTRY_FILENAME, claudeSessionsDir } from './claude-session-registry.js'
import { MAX_REGISTRY_FILES } from './thread-occupancy.js'
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

// 6.48.1: which kind of process a session is, read off its registry record while it is alive.
// `claude -p` registers as `entrypoint: sdk-cli`; a Desktop tab as `claude-desktop`; a terminal
// as `cli`. The record may land a beat after the SessionStart hook, so the read is retried on
// the session's next few events (a synchronous, bounded registry scan each) and then given
// up. Once known it rides the LEDGER ROW (QA, 2026-09-15): a replay after a restart restores
// it, so a tab that ended inside the replay window is not listed as a print run for want of
// a registry record that the reaper has since removed.
const ENTRYPOINT_ATTEMPTS = 6
const entrypointAttempts = new Map<string, number>()

/** The entrypoint to write on this event's ledger row: the store's, else one registry read while attempts remain. */
function entrypointFor(sessionId: string, child: boolean): string | null {
  const known = sessionSignalStore.get(sessionId)?.entrypoint ?? null
  if (known || child) return known
  const tried = entrypointAttempts.get(sessionId) ?? 0
  if (tried >= ENTRYPOINT_ATTEMPTS) return null
  entrypointAttempts.set(sessionId, tried + 1)
  if (entrypointAttempts.size > 512) entrypointAttempts.clear()
  return registryEntrypointSync(sessionId)
}

/** One synchronous pass over `~/.claude/sessions/<pid>.json`; null when no record names the session. */
export function registryEntrypointSync(sessionId: string, dir = claudeSessionsDir()): string | null {
  return registryRecordSync(sessionId, dir)?.entrypoint ?? null
}

export interface RegistryRecordFacts {
  pid: number | null
  entrypoint: string | null
  status: string | null
  statusUpdatedAt: number | null
}

/**
 * The registry record naming a session, read synchronously and bounded; null when none
 * does. A COS Continue child (`claude -p --resume <id>`) registers under the SAME session
 * id as the tab it resumes, so when two records name the session the one whose pid COS
 * did not spawn is the tab's and wins; the child's is used only when it is alone.
 */
export function registryRecordSync(sessionId: string, dir = claudeSessionsDir()): RegistryRecordFacts | null {
  let names: string[]
  try { names = readdirSync(dir).filter(n => REGISTRY_FILENAME.test(n)).slice(0, MAX_REGISTRY_FILES) } catch { return null }
  const wanted = sessionId.toLowerCase()
  let childRecord: RegistryRecordFacts | null = null
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>
      if (typeof raw.sessionId !== 'string' || raw.sessionId.toLowerCase() !== wanted) continue
      const record: RegistryRecordFacts = {
        pid: typeof raw.pid === 'number' ? raw.pid : null,
        entrypoint: typeof raw.entrypoint === 'string' && raw.entrypoint ? raw.entrypoint : null,
        status: typeof raw.status === 'string' ? raw.status : null,
        statusUpdatedAt: typeof raw.statusUpdatedAt === 'number' ? raw.statusUpdatedAt : null,
      }
      if (isCosSpawnedPid(record.pid)) { childRecord ??= record; continue }
      return record
    } catch { /* a torn write; the next read retries */ }
  }
  return childRecord
}

/**
 * THE ENGINE'S OWN END OF TURN (6.48.1, QA round). Claude Code does not end a turn at
 * the `end_turn` row or at the Stop hook: it ends it when every Stop hook has RETURNED,
 * and only then writes `stop_hook_summary`, dequeues anything typed meanwhile, and flips
 * the registry to `idle`. On the release Mac the COS repo's own Stop hooks run 12-38 s
 * (`transcript_summary_hook.py`), so "Stop + 2 s" was 13-38 s early: a prompt typed at
 * the desk in that window is QUEUED and dequeues after the hooks, and a follow-up
 * delivered at Stop + 2 s would have been a second writer. The registry's `idle` with
 * `statusUpdatedAt` at or after the Stop is the only signal that says the hooks are done
 * (measured: it flips 4-39 ms after the summary row).
 *
 * True only when a live record names the session AND says idle AND moved at or after
 * `stopAt`. No record (a print run that already exited) is answered by the caller.
 */
export function registryIdleAfterStop(sessionId: string, stopAt: number, dir = claudeSessionsDir()): boolean | null {
  const record = registryRecordSync(sessionId, dir)
  if (!record) return null
  return record.status === 'idle' && typeof record.statusUpdatedAt === 'number' && record.statusUpdatedAt >= stopAt
}

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
  const replay = ledger.replay(since, (env, _key, child, entrypoint) => {
    if (!enabled) return
    sessionSignalStore.apply(env, child)
    if (entrypoint) sessionSignalStore.setEntrypoint(env.sessionId, entrypoint)
  })
  replayed = { rows: replay.rows, applied: replay.applied }
  ingester = startSpoolIngester({
    dir,
    ledger,
    seenKeys: replay.keys,
    isChild: env => isCosSpawnedPid(env.ppid),
    entrypointOf: enabled ? (env, child) => entrypointFor(env.sessionId, child) : undefined,
    apply: enabled ? (env, child, entrypoint) => {
      sessionSignalStore.apply(env, child)
      if (entrypoint) sessionSignalStore.setEntrypoint(env.sessionId, entrypoint)
    } : undefined,
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

/** 6.48.1: the drain kick's counters, registered by the composition root when thread attach is on. */
type DrainKickStats = { passes: number; kicks: number; folded: number; inFlight: boolean; waiting: number }
let drainKickStats: (() => DrainKickStats) | null = null
export function registerDrainKickStats(read: () => DrainKickStats): void {
  drainKickStats = read
}

export interface SessionHooksHealth {
  enabled: boolean
  /** The Stop-driven drain (6.48.1): null when thread attach is off. */
  drain: DrainKickStats | null
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
      drain: drainKickStats ? drainKickStats() : null,
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
export function deriveForRow(input: { sessionId: string; registry?: RegistryFacts; transcript?: TranscriptFacts; now?: number; remember?: boolean; attachedTurn?: boolean }): DerivedSessionState | undefined {
  // Off means off: with the feature disabled every row is byte-identical to 6.47.0.
  if (!sessionHooksEnabled()) return undefined
  const signal = signalFor(input.sessionId)
  if (!signal && !input.registry && !input.transcript && !input.attachedTurn) return undefined
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
    attachedTurn: input.attachedTurn === true,
  })
  // A reader with no registry facts (the live feed derives from the signal alone) must
  // not touch the two-scan memory the row readers keep: a derive that saw no registry
  // would reset a dead pid's count between two list requests.
  if (input.remember === false || !input.registry) return derived
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
  entrypointAttempts.clear()
  drainKickStats = null
  statusCache = null
}
