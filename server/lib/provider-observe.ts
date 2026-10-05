// What COS can SEE of each engine's sessions (6.62.0, provider parity), for `/api/health`.
//
// Two jobs. First, the Codex hooks and the Cursor observer as health fields beside the Claude
// ones (`sessionHooks.codex`, `sessionHooks.cursorObserver`). Claude's `sessionHooks.state`,
// `installed` and `hookHaltReady` are untouched and stay Claude-only (B2): Control 0.5.254
// keys its banner and its Install check off them.
//
// Second, `providers.<engine>.observe`: one short source code per observation (hooks, live
// state, child agents, compaction, reasoning), so a client can say why a row is quiet. Each is
// the name of the evidence, or `none`.
//
// READ FROM A SNAPSHOT, NEVER ON THE HEALTH REQUEST. Codex's trust needs a spawn of its
// app-server, and the files live in the user's home. The composition root starts a background
// refresh (`startProviderObserveRefresh`); the install routes refresh after they write. A
// process that never started it (every test) reports `checkedAt: null` and reads no home file.

import { CODEX_TRUST_REFRESH_MS, cachedCodexHookTrust, codexHookStatus, codexPresent, refreshCodexHookTrust, type CodexHookStatus, type CodexHookTrust } from './codex-hooks-installer.js'
import { sweepStaleCursorSpawnDirs } from './cursor-spawn-env.js'
import { cursorObserverStatus } from './cursor-observer-installer.js'
import { setCodexDeskCancelReady } from './session-cancel.js'

export interface CodexHooksHealth {
  /** Codex's binary resolves and it has a home. Nothing else here is read when it is not. */
  present: boolean
  installed: boolean
  /** The install state word (`CodexHookStatus.state`), or null when Codex is not present. */
  state: CodexHookStatus['state'] | null
  /**
   * Codex's own word through `hooks/list` (K3): the newest answer for CODEX_TRUST_CACHE_MS, kept
   * through a failed read (QA W4); `unknown` until read, past the TTL, or when not installed.
   */
  trust: CodexHookTrust
  /**
   * QA W4: why `trust` says what it says when it is not a fresh answer: the newest read's failure
   * code (`timeout`, `rpc_error`, `spawn_failed`, `no_binary`), `not_listed`, `stale`,
   * `unchecked`, or `not_installed`. Null for a fresh answer.
   */
  trustReason: string | null
  /** The stable script is this package's: the only script whose Codex halt reply Codex honours. */
  scriptOk: boolean
  /** When the file status was last read; null when this process never read it. */
  checkedAt: string | null
  trustCheckedAt: string | null
}

export interface CursorObserverHealth {
  installed: boolean
  /** The node binary the observer commands name still exists (W18). */
  nodeOk: boolean
  checkedAt: string | null
}

interface Snapshot {
  codex: { present: boolean; status: CodexHookStatus | null; at: number } | null
  cursor: { installed: boolean; nodeOk: boolean; at: number } | null
}

const snapshot: Snapshot = { codex: null, cursor: null }

/** Re-read both files now (cheap: two small JSON files and two hashes). Trust is separate. */
export function refreshProviderHookFiles(nowMs = Date.now()): void {
  try {
    const present = codexPresent()
    snapshot.codex = { present, status: present ? codexHookStatus() : null, at: nowMs }
  } catch { /* the previous snapshot stands */ }
  try {
    const cursor = cursorObserverStatus()
    snapshot.cursor = { installed: cursor.installed, nodeOk: cursor.nodeOk, at: nowMs }
  } catch { /* the previous snapshot stands */ }
}

const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null)

export function codexHooksHealthField(nowMs = Date.now()): CodexHooksHealth {
  const codex = snapshot.codex
  const trust = cachedCodexHookTrust(nowMs)
  return {
    present: codex?.present === true,
    installed: codex?.status?.installed === true,
    state: codex?.status?.state ?? null,
    trust: codex?.status?.installed === true ? trust.trust : 'unknown',
    trustReason: codex?.status?.installed === true ? trust.trustReason : 'not_installed',
    scriptOk: codex?.status?.scriptOk === true,
    checkedAt: iso(codex?.at),
    trustCheckedAt: iso(trust.checkedAt),
  }
}

export function cursorObserverHealthField(): CursorObserverHealth {
  const cursor = snapshot.cursor
  return { installed: cursor?.installed === true, nodeOk: cursor?.nodeOk === true, checkedAt: iso(cursor?.at) }
}

/**
 * 6.62.0 (plan 3.8): can the Codex hooks stop a desk Codex run right now? Installed, trusted by
 * Codex itself, and this package's script (whose Codex reply is the deny-only one).
 */
export function codexDeskHaltReady(nowMs = Date.now()): boolean {
  const field = codexHooksHealthField(nowMs)
  return field.present && field.installed && field.scriptOk && (field.trust === 'trusted' || field.trust === 'managed')
}

export type ObserveSource = string

export interface ProviderObserve {
  /** The hook pipeline this engine's sessions report through: a state word, or `none`. */
  hooks: ObserveSource
  /** Where a row's running/idle comes from. */
  liveState: ObserveSource
  /** Where child agents are counted from. */
  children: ObserveSource
  /** Where "compacting context" comes from. */
  compaction: ObserveSource
  /** Where the reasoning line on the live feed comes from. */
  reasoning: ObserveSource
}

/**
 * `providers.<engine>.observe` (plan 1.10). `claudeHooks` is Claude's install state word and
 * whether its hooks can stop a run (they are what Cursor runs too).
 */
export function providerObserveFields(claudeHooks: { state: string; ready: boolean }, nowMs = Date.now()): Record<'claude' | 'codex' | 'cursor', { observe: ProviderObserve }> {
  const codex = codexHooksHealthField(nowMs)
  const cursor = cursorObserverHealthField()
  const codexHooksRun = codex.installed && (codex.trust === 'trusted' || codex.trust === 'managed')
  return {
    claude: {
      observe: {
        hooks: claudeHooks.state,
        liveState: claudeHooks.ready ? 'hook' : 'registry',
        children: claudeHooks.ready ? 'hook' : 'none',
        compaction: claudeHooks.ready ? 'hook' : 'none',
        // By design: Claude's thinking blocks are never put on the lens (session-stream-events).
        reasoning: 'none',
      },
    },
    codex: {
      observe: {
        hooks: !codex.present ? 'absent' : codex.installed ? codex.trust : (codex.state ?? 'unknown'),
        liveState: codexHooksRun ? 'hook' : 'transcript',
        children: 'state_db',
        // The rollout writes a compaction only when it is over; only the hook sees one start.
        compaction: codexHooksRun ? 'hook' : 'rollout_end',
        reasoning: 'rollout',
      },
    },
    cursor: {
      observe: {
        hooks: claudeHooks.ready ? 'claude_hooks' : claudeHooks.state,
        liveState: claudeHooks.ready ? 'hook' : 'file_time',
        children: cursor.installed && cursor.nodeOk ? 'observer' : 'none',
        compaction: cursor.installed && cursor.nodeOk ? 'observer' : 'none',
        reasoning: cursor.installed && cursor.nodeOk ? 'observer' : 'none',
      },
    },
  }
}

/** File status every half minute; Codex trust every CODEX_TRUST_REFRESH_MS (a third of its cache window). */
export const PROVIDER_FILES_REFRESH_MS = 30_000

let refreshTimer: ReturnType<typeof setInterval> | null = null
let lastTrustAt = 0

/**
 * The composition root's background refresh. Never on a request path; never in a test that
 * does not call it. The trust read runs only while our hooks are installed in Codex's file.
 */
export function startProviderObserveRefresh(): () => void {
  // The desk cancel reads Codex readiness from the same snapshot health shows (plan 3.8).
  setCodexDeskCancelReady(() => codexDeskHaltReady())
  // QA W20: per-spawn Cursor config folders a crash or a restart left behind are reaped at
  // boot, not only when the next Cursor spawn happens to run.
  try {
    const swept = sweepStaleCursorSpawnDirs()
    if (swept > 0) console.log(`[provider-observe] removed ${swept} stale Cursor spawn folder(s)`)
  } catch (error) {
    console.warn(`[provider-observe] Cursor spawn sweep skipped: ${error instanceof Error ? error.name : 'error'}`)
  }
  const tick = () => {
    refreshProviderHookFiles()
    const now = Date.now()
    if (snapshot.codex?.status?.installed === true && now - lastTrustAt >= CODEX_TRUST_REFRESH_MS) {
      lastTrustAt = now
      void refreshCodexHookTrust().catch(() => { /* the last answer stands */ })
    }
  }
  tick()
  refreshTimer = setInterval(tick, PROVIDER_FILES_REFRESH_MS)
  refreshTimer.unref?.()
  return () => { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null }
}

/**
 * After an install or uninstall: the files now, and a FRESH trust read in the background. A read
 * already in flight began before the write and is superseded, never reused (QA W4).
 */
export function refreshAfterInstall(): void {
  refreshProviderHookFiles()
  if (snapshot.codex?.status?.installed === true) {
    lastTrustAt = Date.now()
    void refreshCodexHookTrust({ fresh: true }).catch(() => { /* the last answer stands */ })
  }
}

export function __resetProviderObserveForTests(): void {
  snapshot.codex = null
  snapshot.cursor = null
  lastTrustAt = 0
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}
