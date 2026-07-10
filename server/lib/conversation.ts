// Conversation session manager — disk-persisted multi-turn history
// Rolling buffer of last N exchanges per session, auto-expire after inactivity
// Sessions survive server restarts via JSON file on disk

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notifySessionStart, notifySessionEnd } from './telegram-notify.js'
import { appendToArchive, type SessionToArchive } from './archive.js'
import { updateGlassesSessionCache, scheduleCacheUpdate, setSessionProvider } from './session-cache-writer.js'
import { logSessionEnd, buildSessionLogEntry, writeSessionLog } from './session-log.js'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { localDay } from './local-day.js'
import { normalizeModelPreference, type ModelPreference } from '../../shared/model-preference.js'

export type { ModelPreference }

export interface Exchange {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  globalMsgNum?: number  // Client's global message number for this Q&A pair
}

interface Session {
  id: string
  exchanges: Exchange[]
  lastActivity: number
  createdAt: number
  modelPreference: ModelPreference | null
  contextBreaks: number[]  // timestamps where user said "new chat" — prompt history only sees exchanges after last break
}

const MAX_EXCHANGES = 100             // 50 Q&A pairs — deep history for browsing
const PROMPT_HISTORY_LIMIT = 20       // Only last 20 exchanges sent to Claude prompt
const CONTEXT_WINDOW_MS = 2 * 60 * 60_000  // 2 hours — prompt history window (no longer used for session deletion)

// Disk persistence
const __dirname = dirname(fileURLToPath(import.meta.url))
import { dataPath } from './data-dir.js'
const SESSION_FILE = dataPath('sessions.json')

const sessions = new Map<string, Session>()

// Wire session provider for cache writer (breaks circular import)
setSessionProvider(getActiveSessions)

// ── Disk I/O ───────────────────────────────────────────────

interface SessionsFile {
  sessions: Record<string, Session>
  savedAt: string
}

function loadFromDisk(): void {
  const result = loadJsonOrQuarantine<SessionsFile>(SESSION_FILE)
  if (result.status === 'missing') return // fresh start

  if (result.status === 'corrupt') {
    // Loud: previous behaviour silently discarded the corrupt file, which was
    // indistinguishable from "no sessions" — the exact fingerprint of the
    // Apr 15 loss. Always surface.
    console.error(
      `[conversation] CORRUPT sessions.json quarantined to ${result.quarantinedAs}. ` +
      `Starting empty. Recover by hand from that file if needed.`,
      result.error,
    )
    return
  }

  let loaded = 0
  for (const [id, session] of Object.entries(result.data.sessions)) {
    if (!session.contextBreaks) session.contextBreaks = []
    session.modelPreference = normalizeModelPreference(session.modelPreference) ?? null
    sessions.set(id, session)
    loaded++
  }

  if (loaded > 0) {
    console.log(`[conversation] Restored ${loaded} session(s) from disk (all ages preserved)`)
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveToDisk()
  }, 500)
}

function saveToDisk(): void {
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    const data: SessionsFile = {
      sessions: Object.fromEntries(sessions),
      savedAt: new Date().toISOString(),
    }
    // Atomic: tmp + rename. Guards against power loss / SIGKILL / disk-full
    // producing a torn JSON that `loadFromDisk` would quarantine on next boot.
    atomicWriteFileSync(SESSION_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[conversation] Failed to save sessions:', err)
  }
}

// Restore on module load
loadFromDisk()

// Daily archive-mirror — copies prior-day sessions to archive WITHOUT deleting from sessions.json.
// Runs once at boot + every 24h. Guarantees every session has an archived copy.
//
// Budget-safe: passes `skipLLM: true` to `appendToArchive` so the mirror never
// triggers `claude -p` — boot after a long idle period would otherwise spawn
// N × (chats+1) Sonnet calls. The mirror uses deterministic string fallbacks;
// explicit `endSession` / `clearSession` paths keep the LLM summaries.
//
// Serialized via `withArchiveLock` inside appendToArchive so parallel mirrors
// on the same date cannot clobber each other. `mirrored` is now counted from
// settled promises — the previous sync-after-async counter was always 0.
async function runDailyArchiveMirror(): Promise<void> {
  const todayLocal = localDay()
  const promises: Promise<string | null>[] = []

  for (const session of sessions.values()) {
    if (session.exchanges.length === 0) continue
    const sessionDay = localDay(session.lastActivity)
    if (sessionDay >= todayLocal) continue // today's sessions are still live — skip

    const p: Promise<string | null> = appendToArchive(sessionDay, {
      id: session.id,
      exchanges: session.exchanges,
      contextBreaks: session.contextBreaks,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    }, { skipLLM: true })
      .then(() => {
        console.log(`[conversation] Archive-mirrored session ${session.id} → ${sessionDay}`)
        return session.id
      })
      .catch((err) => {
        console.error(`[conversation] Archive-mirror failed for ${session.id}:`, err)
        return null
      })
    promises.push(p)
  }

  const results = await Promise.allSettled(promises)
  const mirrored = results.filter(
    (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null,
  ).length

  if (mirrored > 0) updateGlassesSessionCache()
}

// Fire-and-forget at boot so module load isn't blocked on disk + LLM fallback I/O.
runDailyArchiveMirror().catch(err => console.error('[conversation] mirror boot error:', err))
setInterval(() => {
  runDailyArchiveMirror().catch(err => console.error('[conversation] mirror interval error:', err))
}, 24 * 60 * 60_000)

// Track whether session is brand new (for first-query notification)
const newSessions = new Set<string>()

export function createSession(): string {
  const now = Date.now()
  const id = randomUUID().slice(0, 8)
  sessions.set(id, { id, exchanges: [], lastActivity: now, createdAt: now, modelPreference: null, contextBreaks: [] })
  newSessions.add(id)
  scheduleSave()
  scheduleCacheUpdate()
  return id
}

/** Get raw session object — needed for contextBreaks access */
export function getSessionRaw(sessionId: string): Session | undefined {
  return sessions.get(sessionId)
}

/** Insert a context break — prompt history will only see exchanges after this timestamp */
export function addContextBreak(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.contextBreaks.push(Date.now())
  session.lastActivity = Date.now()
  scheduleSave()
  scheduleCacheUpdate()
  return true
}

export function isNewSession(sessionId: string): boolean {
  return newSessions.has(sessionId)
}

export function markSessionNotified(sessionId: string): void {
  newSessions.delete(sessionId)
}

export function getOrCreateSession(sessionId?: string): string {
  if (sessionId && sessions.has(sessionId)) {
    return sessionId
  }
  return createSession()
}

export function getHistory(sessionId: string): Exchange[] {
  const session = sessions.get(sessionId)
  if (!session) return []
  session.lastActivity = Date.now()
  return [...session.exchanges]
}

/**
 * Remove the most recent user+assistant exchange pair from a session.
 * Called after photo analysis completes — the client already has the response,
 * but we strip it from the session so photo context doesn't leak into future prompts.
 */
export function removeLastExchangePair(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.exchanges.length < 2) return

  const last = session.exchanges[session.exchanges.length - 1]
  const secondLast = session.exchanges[session.exchanges.length - 2]

  if (last.role === 'assistant' && secondLast.role === 'user') {
    session.exchanges.splice(-2, 2)
    scheduleSave()
    scheduleCacheUpdate()
  }
}

/**
 * Extract the first complete sentence from text, capped at maxLen.
 * Returns empty string for empty/whitespace input.
 */
function extractFirstSentence(text: string, maxLen: number): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  // Find first sentence boundary — require 15+ chars before the period
  // to avoid false matches on numbered lists like "1. Menu board"
  const match = trimmed.match(/^(.{15,}?[.!?])(?:\s|$)/)
  if (match && match[1].length <= maxLen) {
    return match[1]
  }

  // No clean sentence boundary — truncate at last word boundary
  if (trimmed.length <= maxLen) return trimmed
  const truncated = trimmed.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > 0) {
    return truncated.slice(0, lastSpace) + '...'
  }
  return truncated + '...'
}

/**
 * Replace the last user+assistant exchange pair with condensed photo summaries.
 * Preserves original timestamps so time-window filters and archive ordering are unaffected.
 * Falls back to deletion if no usable summary can be extracted.
 */
export function replaceLastExchangeWithSummary(
  sessionId: string,
  originalQuery: string,
  fullResponse: string,
  imageCount: number,
): void {
  const session = sessions.get(sessionId)
  if (!session || session.exchanges.length < 2) return

  const last = session.exchanges[session.exchanges.length - 1]
  const secondLast = session.exchanges[session.exchanges.length - 2]

  if (last.role !== 'assistant' || secondLast.role !== 'user') return

  const summary = extractFirstSentence(fullResponse, 250)

  // No usable summary — fall back to deletion
  if (!summary) {
    session.exchanges.splice(-2, 2)
    scheduleSave()
    scheduleCacheUpdate()
    return
  }

  // Build condensed replacements
  const photoLabel = imageCount === 1 ? 'image' : `${imageCount} images`
  const queryText = originalQuery || 'What do you see?'
  secondLast.content = `[Photo context: ${photoLabel}] ${queryText}`
  last.content = `[Photo context] ${summary}`

  scheduleSave()
  scheduleCacheUpdate()
}

export function addExchange(sessionId: string, role: 'user' | 'assistant', content: string, globalMsgNum?: number): Exchange {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { id: sessionId, exchanges: [], lastActivity: Date.now(), createdAt: Date.now(), modelPreference: null, contextBreaks: [] }
    sessions.set(sessionId, session)
  }

  const exchange: Exchange = { role, content, timestamp: Date.now(), globalMsgNum }
  session.exchanges.push(exchange)
  session.lastActivity = Date.now()

  // Trim to rolling buffer
  while (session.exchanges.length > MAX_EXCHANGES) {
    session.exchanges.shift()
  }

  scheduleSave()
  scheduleCacheUpdate()
  return exchange
}

/** Remove exactly the exchange object returned by addExchange.
 * Identity matching prevents a failed duplicate prompt from deleting an older,
 * byte-identical turn in the same conversation. */
export function removeExchange(sessionId: string, exchange: Exchange): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  const index = session.exchanges.indexOf(exchange)
  if (index < 0) return false
  session.exchanges.splice(index, 1)
  session.lastActivity = Date.now()
  scheduleSave()
  scheduleCacheUpdate()
  return true
}

/** Clear a session — archive + log BEFORE deleting from the live Map.
 *  Async so callers can `await` archive completion before considering the
 *  session durable. If archive fails the session stays in the Map (retryable
 *  on next boot via `runDailyArchiveMirror`); previously the Map was deleted
 *  unconditionally even on archive failure — silent data loss. */
export async function clearSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (session && session.exchanges.length > 0) {
    const dateStr = localDay(session.lastActivity)
    try {
      await appendToArchive(dateStr, {
        id: session.id,
        exchanges: session.exchanges,
        contextBreaks: session.contextBreaks,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      })
      updateGlassesSessionCache()
    } catch (err) {
      console.error(
        `[conversation] clearSession archive failed for ${sessionId} — keeping in Map for retry:`,
        err,
      )
      return // do NOT delete — let the mirror retry next cycle
    }

    logSessionEnd({
      id: session.id,
      exchanges: session.exchanges,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      modelPreference: session.modelPreference,
      endReason: 'explicit_clear',
    })
  }

  sessions.delete(sessionId)
  scheduleSave()
  scheduleCacheUpdate()
}

export function getSessionModel(sessionId: string): ModelPreference | null {
  return sessions.get(sessionId)?.modelPreference ?? null
}

export function setSessionModel(sessionId: string, model: ModelPreference | null): void {
  const session = sessions.get(sessionId)
  if (session) {
    session.modelPreference = model
    scheduleSave()
  }
}

export interface PromptReference {
  query: string
  response: string
}

/**
 * Format conversation history for Claude's prompt.
 * Applies three filters:
 *   1. Context break — only exchanges AFTER the last break timestamp
 *   2. Time window — only exchanges within CONTEXT_WINDOW_MS of now
 *   3. Photo filtering — skip [Photo] user exchanges AND their paired assistant response
 * Then caps at PROMPT_HISTORY_LIMIT and optionally appends a referenced message.
 */
export function formatHistoryForPrompt(
  exchanges: Exchange[],
  contextBreaks: number[] = [],
  reference?: PromptReference,
): string {
  if (exchanges.length === 0 && !reference) return ''

  const now = Date.now()
  const lastBreak = contextBreaks.length > 0 ? contextBreaks[contextBreaks.length - 1] : 0
  const windowStart = now - CONTEXT_WINDOW_MS

  // Effective cutoff: whichever is more recent — last break or time window
  const cutoff = Math.max(lastBreak, windowStart)

  // Filter exchanges: after cutoff, skip photo exchanges
  const filtered: Exchange[] = []
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i]
    if (ex.timestamp < cutoff) continue

    // Skip photo user messages and their paired assistant response
    // Matches [Photo], [2 Photos], [3 Photos], etc.
    if (ex.role === 'user' && /^\[(?:\d+ )?Photos?\]/.test(ex.content)) {
      // Also skip the next exchange if it's an assistant response
      if (i + 1 < exchanges.length && exchanges[i + 1].role === 'assistant') {
        i++ // skip paired response
      }
      continue
    }

    filtered.push(ex)
  }

  // Cap at limit
  const recent = filtered.slice(-PROMPT_HISTORY_LIMIT)

  const parts: string[] = []

  if (recent.length > 0) {
    const lines = recent.map((e, i) => {
      const prefix = e.role === 'user' ? 'User' : 'COS'
      const num = e.globalMsgNum != null ? `Msg ${e.globalMsgNum}` : `${i + 1}`
      return `[${num}] ${prefix}: ${e.content}`
    })
    parts.push(`CONVERSATION HISTORY (recent exchanges):\n${lines.join('\n')}`)
  }

  if (reference) {
    parts.push(`REFERENCED MESSAGE:\nUser asked: ${reference.query}\nCOS responded: ${reference.response}`)
  }

  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : ''
}

// ── Session queries ──────────────────────────────────────────

export interface SessionSummary {
  id: string
  exchangeCount: number
  lastActivity: number
  createdAt: number
  modelPreference: ModelPreference | null
  lastQuery: string | null
}

export function getRecentSessions(withinMs: number): SessionSummary[] {
  const now = Date.now()
  const results: SessionSummary[] = []

  for (const session of sessions.values()) {
    if (now - session.lastActivity > withinMs) continue
    const lastUserExchange = [...session.exchanges].reverse().find(e => e.role === 'user')
    results.push({
      id: session.id,
      exchangeCount: session.exchanges.length,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
      modelPreference: session.modelPreference,
      lastQuery: lastUserExchange?.content ?? null,
    })
  }

  return results.sort((a, b) => b.lastActivity - a.lastActivity)
}

export function sessionExists(sessionId: string): boolean {
  return sessions.has(sessionId)
}

/** Explicitly end a session — archive, log, notify, and remove.
 *  Called by POST /api/sessions/:id/end (client "new session" / app background).
 *  Returns archive stats or null if session not found.
 *
 *  Archive-first: we AWAIT `appendToArchive` before `sessions.delete`. If the
 *  archive write fails, the session stays in the Map (and on disk) so the
 *  next mirror cycle retries it — this is the core guarantee v5.4.5 makes:
 *  no session leaves the Map without a successful archive write behind it. */
export async function endSession(sessionId: string): Promise<{ logged: boolean; exchangeCount: number; durationMin: number } | null> {
  const session = sessions.get(sessionId)
  if (!session) return null

  const durationMin = Math.round((session.lastActivity - session.createdAt) / 60_000)
  const exchangeCount = session.exchanges.length

  if (session.exchanges.length > 0) {
    const dateStr = localDay(session.lastActivity)
    try {
      await appendToArchive(dateStr, {
        id: session.id,
        exchanges: session.exchanges,
        contextBreaks: session.contextBreaks,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      })
      updateGlassesSessionCache()
    } catch (err) {
      console.error(
        `[conversation] endSession archive failed for ${sessionId} — keeping in Map for retry:`,
        err,
      )
      // Signal failure to the caller but DO NOT delete the session.
      return { logged: false, exchangeCount, durationMin }
    }

    // Log to JSONL (fire-and-forget — not on the data-durability path)
    logSessionEnd({
      id: session.id,
      exchanges: session.exchanges,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      modelPreference: session.modelPreference,
      endReason: 'explicit_end',
    })
  }

  notifySessionEnd(sessionId, exchangeCount, durationMin)
  sessions.delete(sessionId)
  scheduleSave()
  scheduleCacheUpdate()

  return { logged: exchangeCount > 0, exchangeCount, durationMin }
}

/** Log all active sessions on server shutdown — prevents data loss on restart */
export function logActiveSessionsOnShutdown(): void {
  for (const session of sessions.values()) {
    if (session.exchanges.length === 0) continue
    logSessionEnd({
      id: session.id,
      exchanges: session.exchanges,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      modelPreference: session.modelPreference,
      endReason: 'server_shutdown',
    })
  }
}

// ── Auto-snapshot: periodically write active sessions to .glasses_sessions.jsonl ──
// Runs every 5 minutes. No LLM calls, no network — just JSON serialize + file append.
// Cost: ~0 CPU, ~0 RAM, ~50KB disk per snapshot.
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let lastSnapshotCounts: Record<string, number> = {} // track exchange counts to skip unchanged sessions

export function startAutoSnapshot(intervalMs = 5 * 60_000): void {
  if (snapshotTimer) return
  snapshotTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.exchanges.length === 0) continue
      // Skip if exchange count hasn't changed since last snapshot
      const prevCount = lastSnapshotCounts[session.id] ?? 0
      if (session.exchanges.length === prevCount) continue

      const entry = buildSessionLogEntry({
        id: session.id,
        exchanges: session.exchanges,
        createdAt: session.createdAt,
        lastActivity: Date.now(), // Use NOW, not lastActivity — ensures lookup covers up to this moment
        modelPreference: session.modelPreference,
        endReason: 'explicit_end',
        slug: `[LIVE] ${(session.exchanges.find(e => e.role === 'user')?.content ?? '').slice(0, 50)}`,
      })
      writeSessionLog(entry)
      lastSnapshotCounts[session.id] = session.exchanges.length
    }
  }, intervalMs)
  console.log(`[conversation] Auto-snapshot started (every ${intervalMs / 1000}s)`)
}

/** Return all active sessions with exchanges, shaped for archiving */
export function getActiveSessions(): SessionToArchive[] {
  const result: SessionToArchive[] = []
  for (const session of sessions.values()) {
    if (session.exchanges.length === 0) continue
    result.push({
      id: session.id,
      exchanges: session.exchanges,
      contextBreaks: session.contextBreaks,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    })
  }
  return result
}
