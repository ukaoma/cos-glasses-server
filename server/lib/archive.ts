// Daily archive system — persists conversation history beyond session TTL
// Archives are stored as JSON files per day in ~/.cos-glasses/data/archive/
// Each day's archive contains one or more "chats" (split by context breaks)
// Summaries are generated via `claude -p --model sonnet`, budget-capped per day.

import { chmodSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { logTokenAudit } from './token-audit.js'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { consumeArchiveLLMBudget } from './archive-budget.js'
import { mergeMediaAttachmentRefs, type MediaAttachmentRef } from '../../shared/media-attachment.js'
import { secureExistingPrivateFile } from './secure-user-config.js'

import type { Exchange } from './conversation.js'

import { dataPath } from './data-dir.js'
const ARCHIVE_DIR = dataPath('archive')

// ── Interfaces ──────────────────────────────────────────────

export interface ArchivedChat {
  id: number
  sessionId: string            // Original 8-char UUID from conversation.ts (added v3.9.0)
  exchanges: Exchange[]
  startedAt: number
  endedAt: number
  exchangeCount: number
  summary: string
}

export interface DailyArchive {
  date: string             // YYYY-MM-DD
  summary: string          // <60 char day summary
  chats: ArchivedChat[]
  archivedAt: string       // ISO timestamp
}

export interface ArchiveDateSummary {
  date: string
  summary: string
  chatCount: number
  exchangeCount: number
}

export interface ArchiveChatSummary {
  index: number
  summary: string
  exchangeCount: number
  startedAt: number
}

// ── Internal: session structure for archiving ────────────────

export interface SessionToArchive {
  id: string
  exchanges: Exchange[]
  contextBreaks: number[]
  createdAt: number
  lastActivity: number
}

// ── Directory management ────────────────────────────────────

function ensureArchiveDir(): string {
  mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 })
  chmodSync(ARCHIVE_DIR, 0o700)
  return ARCHIVE_DIR
}

function archivePath(date: string): string {
  return resolve(ensureArchiveDir(), `${date}.json`)
}

// ── Read/Write ──────────────────────────────────────────────

export function loadArchive(date: string): DailyArchive | null {
  const path = archivePath(date)
  secureExistingPrivateFile(path)
  const result = loadJsonOrQuarantine<DailyArchive>(path)
  if (result.status === 'corrupt') {
    // Loud — a silent return masked archive corruption as "day unavailable"
    console.error(
      `[archive] Corrupt archive for ${date} quarantined to ${result.quarantinedAs}. ` +
      `Raw bytes are recoverable by hand from that file.`,
      result.error,
    )
    return null
  }
  if (result.status === 'missing') return null
  // Defense: a valid-JSON but wrong-shape day file (no chats[]) would make the
  // readers throw 500 AND drop listArchiveDates into its catch → the whole
  // Message History list vanishes on one bad file. Coerce to an empty day.
  const data = result.data
  if (data && !Array.isArray(data.chats)) data.chats = []
  return data
}

function saveArchive(archive: DailyArchive): void {
  ensureArchiveDir()
  atomicWriteFileSync(archivePath(archive.date), JSON.stringify(archive, null, 2))
}

// Per-date write lock — prevents `runDailyArchiveMirror` from racing parallel
// appends on the same day file. Each appendToArchive chains behind the current
// in-flight write for that date. Lock map is cleaned up when the chain resolves.
const archiveWriteLocks = new Map<string, Promise<void>>()

function withArchiveLock<T>(date: string, op: () => Promise<T>): Promise<T> {
  const prev = archiveWriteLocks.get(date) ?? Promise.resolve()
  const next = prev.then(op, op) // run op regardless of prior success/failure
  // Store a void-typed tail in the lock map so a rejection here doesn't cause
  // unhandled-rejection noise — op's result is returned to the caller via `next`.
  const tail: Promise<void> = next.then(() => undefined, () => undefined)
  archiveWriteLocks.set(date, tail)
  tail.finally(() => {
    if (archiveWriteLocks.get(date) === tail) archiveWriteLocks.delete(date)
  })
  return next
}

// ── Chat splitting ──────────────────────────────────────────

/** Split a session's exchanges into chats using contextBreaks[] timestamps */
export function splitSessionIntoChats(session: SessionToArchive): ArchivedChat[] {
  const { exchanges, contextBreaks } = session
  if (exchanges.length === 0) return []

  // Build break points (sorted)
  const breaks = [...contextBreaks].sort((a, b) => a - b)
  const chats: ArchivedChat[] = []
  let chatId = 0

  // Find chat boundaries
  const boundaries: number[] = [0] // start index of each chat
  for (const breakTs of breaks) {
    // Find first exchange after this break
    const idx = exchanges.findIndex(e => e.timestamp > breakTs)
    if (idx > 0 && !boundaries.includes(idx)) {
      boundaries.push(idx)
    }
  }

  // Build chats from boundaries
  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b]
    const endIdx = b + 1 < boundaries.length ? boundaries[b + 1] : exchanges.length
    const chatExchanges = exchanges.slice(startIdx, endIdx)
    if (chatExchanges.length === 0) continue

    chats.push({
      id: chatId++,
      sessionId: session.id,
      exchanges: chatExchanges,
      startedAt: chatExchanges[0].timestamp,
      endedAt: chatExchanges[chatExchanges.length - 1].timestamp,
      exchangeCount: chatExchanges.length,
      summary: '', // filled by generateChatSummary
    })
  }

  return chats
}

// ── Summary generation ──────────────────────────────────────

/** Deterministic fallback used when LLM is budget-skipped or errors out. */
function fallbackChatSummary(exchanges: Exchange[]): string {
  const firstQuery = exchanges.find(e => e.role === 'user')?.content ?? ''
  if (!firstQuery.trim()) return 'Empty chat'
  return firstQuery.length > 57 ? firstQuery.slice(0, 57) + '...' : firstQuery
}

function fallbackDaySummary(chats: ArchivedChat[]): string {
  const summaries = chats.map(c => {
    const first = c.exchanges.find(e => e.role === 'user')?.content ?? ''
    return first.length > 30 ? first.slice(0, 27) + '...' : first
  }).filter(Boolean)
  return summaries.slice(0, 2).join(', ').slice(0, 60) || 'Day activity'
}

/**
 * Run the archive summarizer without invoking a shell.
 *
 * The archived query text is user-controlled. It must travel over stdin, never
 * through a command string, so shell metacharacters remain inert data.
 */
function runClaudeArchiveSummary(input: string, instruction: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', 'sonnet', instruction], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish(new Error('Archive summary timed out'))
    }, 15_000)
    timer.unref?.()

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString().slice(0, 16_384 - stdout.length)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length)
    })
    proc.on('error', error => finish(error))
    proc.on('close', code => {
      if (code === 0) finish()
      else finish(new Error(`Archive summary exited ${code}: ${stderr.trim()}`))
    })

    // Ignore EPIPE here; the close/error handlers above own the final outcome.
    proc.stdin.on('error', () => {})
    proc.stdin.end(input)
  })
}

/** Generate a <60 char summary for a single chat via claude -p.
 *  Budget-capped: if MAX_DAILY_ARCHIVE_LLM_CALLS is exhausted or `skipLLM` is
 *  passed, returns a deterministic string fallback. */
export async function generateChatSummary(exchanges: Exchange[], skipLLM = false): Promise<string> {
  if (skipLLM || !consumeArchiveLLMBudget()) {
    return fallbackChatSummary(exchanges)
  }

  const userQueries = exchanges
    .filter(e => e.role === 'user')
    .map(e => e.content)
    .slice(0, 10) // cap to avoid token overflow
    .join('\n')

  if (!userQueries.trim()) return 'Empty chat'

  const startMs = Date.now()
  try {
    const stdout = await runClaudeArchiveSummary(
      userQueries,
      'Summarize these COS Glasses queries into a single title under 60 characters. Just the title, no quotes, no explanation.',
    )
    const result = stdout.trim()

    logTokenAudit({
      source: 'g2-archive',
      model: 'sonnet',
      inputChars: userQueries.length + 100,
      outputChars: result.length,
      durationMs: Date.now() - startMs,
      caller: 'chat_summary',
    })

    // Validate: must be reasonable length
    if (result.length > 0 && result.length <= 80) {
      return result.slice(0, 60)
    }
  } catch {
    // Fall through to fallback
  }

  return fallbackChatSummary(exchanges)
}

/** Generate a <60 char summary for a full day's chats. Same budget semantics. */
export async function generateDaySummary(chats: ArchivedChat[], skipLLM = false): Promise<string> {
  if (skipLLM || !consumeArchiveLLMBudget()) {
    return fallbackDaySummary(chats)
  }

  const allQueries = chats
    .flatMap(c => c.exchanges.filter(e => e.role === 'user').map(e => e.content))
    .slice(0, 15)
    .join('\n')

  if (!allQueries.trim()) return 'No activity'

  const startMs = Date.now()
  try {
    const stdout = await runClaudeArchiveSummary(
      allQueries,
      'Summarize these COS Glasses queries from one day into a daily title under 60 characters. Just the title, no quotes.',
    )
    const result = stdout.trim()

    logTokenAudit({
      source: 'g2-archive',
      model: 'sonnet',
      inputChars: allQueries.length + 100,
      outputChars: result.length,
      durationMs: Date.now() - startMs,
      caller: 'day_summary',
    })

    if (result.length > 0 && result.length <= 80) {
      return result.slice(0, 60)
    }
  } catch {
    // Fall through to fallback
  }

  return fallbackDaySummary(chats)
}

// ── Archive operations ──────────────────────────────────────

export interface AppendToArchiveOpts {
  /** When true, skip all `claude -p` summary calls — use deterministic string
   *  fallbacks instead. Used by the daily archive-mirror path to prevent a
   *  cost spike on boot after long idle periods. */
  skipLLM?: boolean
}

/** Append an archived session (split into chats) to a daily archive file.
 *  Serialized per date via `withArchiveLock` so concurrent callers cannot
 *  race on load→mutate→save and clobber each other's writes. */
export async function appendToArchive(
  date: string,
  session: SessionToArchive,
  opts: AppendToArchiveOpts = {},
): Promise<void> {
  return withArchiveLock(date, async () => {
    const existing = loadArchive(date)
    const newChats = splitSessionIntoChats(session)

    // Generate summaries for new chats
    for (const chat of newChats) {
      chat.summary = await generateChatSummary(chat.exchanges, opts.skipLLM)
    }

    if (existing) {
      // Merge: re-number chat IDs
      const nextId = existing.chats.length
      for (let i = 0; i < newChats.length; i++) {
        newChats[i].id = nextId + i
      }
      existing.chats.push(...newChats)
      existing.summary = await generateDaySummary(existing.chats, opts.skipLLM)
      existing.archivedAt = new Date().toISOString()
      saveArchive(existing)
    } else {
      const archive: DailyArchive = {
        date,
        summary: await generateDaySummary(newChats, opts.skipLLM),
        chats: newChats,
        archivedAt: new Date().toISOString(),
      }
      saveArchive(archive)
    }
  })
}

// ── Query functions ─────────────────────────────────────────

/** List all archive dates with summaries */
export function listArchiveDates(): ArchiveDateSummary[] {
  try {
    ensureArchiveDir()
    const files = readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse() // newest first

    return files.map(f => {
      const date = f.replace('.json', '')
      const archive = loadArchive(date)
      if (!archive) return null
      return {
        date: archive.date,
        summary: archive.summary,
        chatCount: archive.chats.length,
        exchangeCount: archive.chats.reduce((sum, c) => sum + c.exchangeCount, 0),
      }
    }).filter(Boolean) as ArchiveDateSummary[]
  } catch {
    return []
  }
}

/** Get chat summaries for a specific day */
export function getArchiveChats(date: string): ArchiveChatSummary[] {
  const archive = loadArchive(date)
  if (!archive) return []
  return archive.chats.map(c => ({
    index: c.id,
    summary: c.summary,
    exchangeCount: c.exchangeCount,
    startedAt: c.startedAt,
  }))
}

/** Get paired Q&A messages for a specific chat within a day. Request refs on
 * the user turn and model-output refs on the assistant turn surface together. */
export function getArchiveChatMessages(
  date: string,
  chatIndex: number,
): Array<{ query: string; text: string; timestamp: number; attachments?: MediaAttachmentRef[] }> {
  const archive = loadArchive(date)
  if (!archive) return []
  const chat = archive.chats.find(c => c.id === chatIndex)
  if (!chat) return []

  const messages: Array<{ query: string; text: string; timestamp: number; attachments?: MediaAttachmentRef[] }> = []
  for (let i = 0; i < chat.exchanges.length; i++) {
    const ex = chat.exchanges[i]
    if (ex.role === 'user') {
      const next = chat.exchanges[i + 1]
      if (next && next.role === 'assistant') {
        const attachments = mergeMediaAttachmentRefs(ex.attachments, next.attachments)
        messages.push({
          query: ex.content,
          text: next.content,
          timestamp: next.timestamp,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        i++ // skip assistant
      }
    }
  }
  return messages
}

/** Get all messages for a day (flat, across all chats) — for phone browser.
 *  `sessionId` is included so the today/all-messages endpoint can dedup on
 *  (sessionId, timestamp) instead of bare timestamp (collision-prone). */
export function getArchiveDayMessages(
  date: string,
): Array<{ query: string; text: string; timestamp: number; chatIndex: number; sessionId: string; no?: number; attachments?: MediaAttachmentRef[] }> {
  const archive = loadArchive(date)
  if (!archive) return []

  const messages: Array<{ query: string; text: string; timestamp: number; chatIndex: number; sessionId: string; no?: number; attachments?: MediaAttachmentRef[] }> = []
  for (const chat of archive.chats) {
    for (let i = 0; i < chat.exchanges.length; i++) {
      const ex = chat.exchanges[i]
      if (ex.role === 'user') {
        const next = chat.exchanges[i + 1]
        if (next && next.role === 'assistant') {
          const attachments = mergeMediaAttachmentRefs(ex.attachments, next.attachments)
          messages.push({
            query: ex.content,
            text: next.content,
            timestamp: next.timestamp,
            chatIndex: chat.id,
            sessionId: chat.sessionId,
            ...((ex.globalMsgNum ?? next.globalMsgNum) != null ? { no: ex.globalMsgNum ?? next.globalMsgNum } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          })
          i++
        }
      }
    }
  }
  return messages
}

// ── Startup check ───────────────────────────────────────────

/** Check if yesterday needs archiving (handles overnight server restarts) */
export function checkYesterdayArchive(): void {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const existing = loadArchive(yesterday)
  if (!existing) {
    // No yesterday archive exists — but we can't archive sessions that are already expired
    // This is a no-op unless we add persistent session storage beyond TTL
    // The main trigger is the session expiry hook in conversation.ts
    console.log(`[archive] No archive for ${yesterday} — sessions may have already expired`)
  }
}

// Run on module load
checkYesterdayArchive()
