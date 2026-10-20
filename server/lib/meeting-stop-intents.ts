// The phone's Stop, as the server hears it (6.81.0).
//
// WHY THIS EXISTS. Until 6.81.0 the server learned that a G2 meeting had ended only from
// POST /api/meeting/save, and the phone sends that save only after its own finalize has
// read IndexedDB, reconciled the server's ledger and drained every chunk. iOS suspends
// IndexedDB while the companion is off screen, so a Stop pressed with the phone in a pocket
// sat unsaved until the app came back on screen (2026-10-20: 11:19 meeting qbbgyq, Stop at
// 12:43, `stop_blocked` and `foreground_reconcile_failed` "Load failed", saved only by a new
// WebView at 12:47; 14:07 meeting mip9qb, Stop at 15:13:50, saved at 15:14:37 only once
// the phone was visible). A fetch works while hidden; IndexedDB does not.
//
// WHAT A STOP INTENT IS. One small POST the phone can send the moment Stop is pressed,
// before any IndexedDB work: "this meeting has ended, and the last chunk I captured is
// index N". The server records it durably and from then on can finish the save itself
// once it holds every chunk 0..N (lib/meeting-autonomous-finalize.ts decides when).
//
// WHAT IT IS NOT. It never closes the session, never refuses a chunk, and never saves by
// itself. Chunks keep arriving into the same live session after it (that is the merge),
// and a chunk past N cancels it, because a meeting that is still recording must never be
// finalized.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from './local-first-meetings-contract.js'

export const STOP_INTENTS_FILE_NAME = 'meeting-stop-intents.json'
export const AUTONOMOUS_SAVE_LOG_NAME = 'meeting-autonomous-save.jsonl'

/** A finished intent stays readable this long, so a late phone can still be answered and logged. */
export const STOP_INTENT_TERMINAL_RETAIN_MS = 24 * 60 * 60_000
/**
 * A waiting intent outlives the session it describes by one retention horizon. By then the
 * stranded sweeper (4 h idle) has promoted or quarantined the session and owns it.
 */
export const STOP_INTENT_WAITING_RETAIN_MS = 2 * LOCAL_FIRST_MEETING_IDLE_RETENTION_MS

export type StopIntentState = 'waiting' | 'saved' | 'revoked' | 'stood_down'
/** `other`: an unpinned save (the stranded sweep's own POST, a manual curl). */
export type StopIntentSavedBy = 'server' | 'phone' | 'other'

export interface StopIntentWait {
  reason: string
  missingCount: number
  /** The first few missing indices, for the log. Never the whole list. */
  missingSample: number[]
  at: number
}

export interface StopIntent {
  sessionId: string
  /** The highest chunk index the phone captured. -1 = it captured nothing. */
  finalChunkIndex: number
  source: string
  title?: string
  domain?: string
  serverInstanceId: string
  /** Server clock, first receipt. The phone's clock is never read. */
  receivedAt: number
  updatedAt: number
  /** How many times the phone sent it (a hidden phone retries). */
  posts: number
  state: StopIntentState
  /** Why it is revoked or stood down. */
  reason?: string
  savedBy?: StopIntentSavedBy
  savedAt?: number
  filename?: string
  sidecarPath?: string
  chunkCount?: number
  canonicalCount?: number
  lastWait?: StopIntentWait | null
  /** Set when the phone first reports back after the server saved on its own. */
  phoneConfirmedAt?: number
  phoneConfirmedBy?: string
  /** Chunks the phone re-sent after the save that the saved meeting already held. */
  lateReplays?: number
  /** Chunks the phone sent after the save that the saved meeting did NOT hold. Should stay 0. */
  lateRefused?: number
  /** The state of an earlier Stop for this session that this one replaced. */
  replaced?: StopIntentState
}

export type RecordStopIntentResult =
  | { ok: true; intent: StopIntent; created: boolean; raised: boolean }
  | { ok: false; reason: 'terminal'; intent: StopIntent }

export interface StopIntentStore {
  readonly path: string
  get(sessionId: string): StopIntent | null
  /** Waiting intents, oldest first. */
  waiting(): StopIntent[]
  /**
   * Record or refresh the phone's Stop. Re-posting is idempotent; a higher final index
   * raises it (never lowers it: the server must never finalize before the highest index the
   * phone ever claimed has arrived).
   */
  record(input: { sessionId: string; finalChunkIndex: number; source: string; title?: string; domain?: string; serverInstanceId: string }): RecordStopIntentResult
  update(sessionId: string, patch: Partial<StopIntent>): StopIntent | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readIntents(path: string): Record<string, StopIntent> {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.intents)) return {}
    const out: Record<string, StopIntent> = {}
    for (const [id, raw] of Object.entries(parsed.intents)) {
      if (!/^[A-Za-z0-9:_-]{3,96}$/.test(id) || !isRecord(raw)) continue
      const intent = raw as unknown as StopIntent
      if (intent.sessionId !== id) continue
      if (!Number.isInteger(intent.finalChunkIndex) || intent.finalChunkIndex < -1) continue
      if (!Number.isFinite(intent.receivedAt) || !Number.isFinite(intent.updatedAt)) continue
      if (!['waiting', 'saved', 'revoked', 'stood_down'].includes(intent.state)) continue
      out[id] = intent
    }
    return out
  } catch {
    // A corrupt ledger is set aside, never silently trusted or deleted.
    try { renameSync(path, `${path}.corrupt.${Date.now()}`) } catch {}
    return {}
  }
}

export function createStopIntentStore(options: { path?: string; now?: () => number } = {}): StopIntentStore {
  const path = options.path ?? dataPath(STOP_INTENTS_FILE_NAME)
  const now = options.now ?? Date.now
  let cache: Record<string, StopIntent> | null = null

  const load = (): Record<string, StopIntent> => {
    if (!cache) cache = readIntents(path)
    return cache
  }
  const prune = (intents: Record<string, StopIntent>, at: number) => {
    for (const [id, intent] of Object.entries(intents)) {
      const retain = intent.state === 'waiting' ? STOP_INTENT_WAITING_RETAIN_MS : STOP_INTENT_TERMINAL_RETAIN_MS
      if (at - intent.updatedAt > retain) delete intents[id]
    }
  }
  // Persisted before the caller answers, so a 2xx means a restart still knows the Stop.
  const persist = (intents: Record<string, StopIntent>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(path, JSON.stringify({ schemaVersion: 1, intents }, null, 2), { mode: 0o600 })
  }

  return {
    path,
    get(sessionId) {
      const intent = load()[sessionId]
      return intent ? { ...intent } : null
    },
    waiting() {
      return Object.values(load())
        .filter(intent => intent.state === 'waiting')
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .map(intent => ({ ...intent }))
    },
    record(input) {
      const at = now()
      const intents = load()
      prune(intents, at)
      const prior = intents[input.sessionId]
      // A saved Stop is final. A revoked or stood-down one is history: the phone resumed and
      // stopped again, so this is a new Stop and replaces it.
      if (prior && prior.state === 'saved') return { ok: false, reason: 'terminal', intent: { ...prior } }
      const existing = prior?.state === 'waiting' ? prior : undefined
      if (existing) {
        const raised = input.finalChunkIndex > existing.finalChunkIndex
        const next: StopIntent = {
          ...existing,
          finalChunkIndex: Math.max(existing.finalChunkIndex, input.finalChunkIndex),
          title: input.title ?? existing.title,
          domain: input.domain ?? existing.domain,
          updatedAt: at,
          posts: existing.posts + 1,
        }
        intents[input.sessionId] = next
        persist(intents)
        return { ok: true, intent: { ...next }, created: false, raised }
      }
      const intent: StopIntent = {
        sessionId: input.sessionId,
        finalChunkIndex: input.finalChunkIndex,
        source: input.source,
        ...(input.title ? { title: input.title } : {}),
        ...(input.domain ? { domain: input.domain } : {}),
        serverInstanceId: input.serverInstanceId,
        receivedAt: at,
        updatedAt: at,
        posts: 1,
        state: 'waiting',
        lastWait: null,
        ...(prior ? { replaced: prior.state } : {}),
      }
      intents[input.sessionId] = intent
      persist(intents)
      return { ok: true, intent: { ...intent }, created: true, raised: false }
    },
    update(sessionId, patch) {
      const intents = load()
      const existing = intents[sessionId]
      if (!existing) return null
      const next: StopIntent = { ...existing, ...patch, sessionId, updatedAt: now() }
      intents[sessionId] = next
      try { persist(intents) } catch (error) {
        console.error(`[meeting/auto-save] Could not persist the stop intent for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      }
      return { ...next }
    },
  }
}

let defaultStore: StopIntentStore | null = null
/** The process-wide store, created on first use (never at import: tests import this module). */
export function getStopIntentStore(): StopIntentStore {
  if (!defaultStore) defaultStore = createStopIntentStore()
  return defaultStore
}

/** One JSON line per autonomous-save event, beside the server log line that says the same. */
export function appendAutonomousSaveLog(event: string, fields: Record<string, unknown>, path = dataPath(AUTONOMOUS_SAVE_LOG_NAME)): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 })
  } catch { /* the console line is the fallback record */ }
}

export interface SavedChunkText {
  text: string
  speaker: string
  elapsed: number
  [key: string]: unknown
}
export type SavedChunkReplay = { kind: 'canonical'; chunk: SavedChunkText } | { kind: 'empty' } | null

let sidecarCache: { path: string; mtimeMs: number; entries: Map<number, SavedChunkText> } | null = null

/**
 * What a meeting the server saved on its own holds at one chunk index, for answering a
 * phone that re-sends that chunk after the save (its upload response was lost while it was
 * hidden). `canonical`: the saved text. `empty`: the chunk arrived and was silence. `null`:
 * the saved meeting never held this index, so the replay is refused as before (410).
 *
 * Read from the saved sidecar, not from memory, so it survives a restart. One sidecar is
 * cached at a time: replays arrive in a burst for one meeting.
 */
export function savedChunkReplay(sidecarPath: string, chunkIndex: number, asrCompleted: readonly number[]): SavedChunkReplay {
  let entries: Map<number, SavedChunkText>
  try {
    const mtimeMs = statSync(sidecarPath).mtimeMs
    if (sidecarCache && sidecarCache.path === sidecarPath && sidecarCache.mtimeMs === mtimeMs) {
      entries = sidecarCache.entries
    } else {
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as { chunkEntries?: unknown }
      entries = new Map()
      for (const entry of Array.isArray(sidecar.chunkEntries) ? sidecar.chunkEntries : []) {
        const candidate = entry as { chunkIndex?: unknown; chunk?: unknown }
        const chunk = candidate?.chunk as Partial<SavedChunkText> | undefined
        if (!Number.isInteger(candidate?.chunkIndex) || !chunk) continue
        if (typeof chunk.text !== 'string' || !chunk.text || typeof chunk.speaker !== 'string') continue
        if (typeof chunk.elapsed !== 'number' || !Number.isFinite(chunk.elapsed)) continue
        entries.set(candidate.chunkIndex as number, chunk as SavedChunkText)
      }
      sidecarCache = { path: sidecarPath, mtimeMs, entries }
    }
  } catch {
    return null
  }
  const chunk = entries.get(chunkIndex)
  if (chunk) return { kind: 'canonical', chunk }
  return asrCompleted.includes(chunkIndex) ? { kind: 'empty' } : null
}
