// Writes .session_index_cache_COS-Glasses.json to COS_SCRIPTS_DIR
// so the TUI Sessions view picks up glasses sessions alongside desktop ones.
// Transforms active sessions + archived chats into SessionHistoryEntry format.

import { writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DailyArchive } from './archive.js'

// Lazy import to break circular dependency:
// conversation.ts imports us → we import conversation.ts → sessions Map not yet initialized
let _getActiveSessions: (() => any[]) | null = null
function getActiveSessions(): any[] {
  if (!_getActiveSessions) {
    // Dynamic import would be async; instead, caller injects via setSessionProvider()
    return []
  }
  return _getActiveSessions()
}

/** Called by conversation.ts after sessions Map is initialized */
export function setSessionProvider(fn: () => any[]): void {
  _getActiveSessions = fn
}

// Import COS_SCRIPTS_DIR independently — don't crash server if missing
let SCRIPTS_DIR: string | null = null
try {
  if (process.env.COS_SCRIPTS_DIR) {
    SCRIPTS_DIR = resolve(process.env.COS_SCRIPTS_DIR)
  }
} catch { /* no-op */ }

const DEVICE_ID = 'COS-Glasses'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { dataPath } from './data-dir.js'
const ARCHIVE_DIR = dataPath('archive')
const MAX_ARCHIVE_AGE_DAYS = 30

interface SessionCacheEntry {
  session_id: string
  glasses_session_id: string   // Original UUID (e.g. "dea05c6e") — preserved for COS lookups
  slug: string
  created: string
  modified: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  message_count: number
  first_prompt: string
  tools_used: Record<string, number>
  files_touched: string[]
  domain: string
  git_branch: string
  has_subagents: boolean
  total_input_tokens: number
  total_output_tokens: number
  file_size_bytes: number
  device_id: string
}

// Domain classification from user message text — lightweight keyword vote.
// Customize the keyword lists for your own workspaces.
const DOMAIN_TEXT_RULES: [string[], string][] = [
  [['personal', 'family', 'home', 'health', 'glasses', 'oura', 'even g2'], 'personal'],
]

function classifyDomain(userMessages: string[]): string {
  const votes: Record<string, number> = {}
  const text = userMessages.join(' ').toLowerCase()

  for (const [keywords, domain] of DOMAIN_TEXT_RULES) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        votes[domain] = (votes[domain] || 0) + 1
      }
    }
  }

  let best = ''
  let bestCount = 0
  for (const [domain, count] of Object.entries(votes)) {
    if (count > bestCount) {
      best = domain
      bestCount = count
    }
  }

  return best || 'personal'
}

function buildEntryFromArchiveChat(
  chat: DailyArchive['chats'][0],
  date: string,
  chatIndex: number,
): SessionCacheEntry {
  const userExchanges = chat.exchanges.filter(e => e.role === 'user')
  const assistantExchanges = chat.exchanges.filter(e => e.role === 'assistant')
  const userMessages = userExchanges.map(e => e.content)
  const firstUserContent = userMessages[0] ?? ''

  // Preserve original session UUID if archived (added in v3.9.0), else fallback to index-based ID
  const originalId = (chat as any).sessionId || ''

  return {
    session_id: `glasses-${date}-${chatIndex}`,
    glasses_session_id: originalId,
    slug: chat.summary || firstUserContent.slice(0, 60) || 'Glasses chat',
    created: new Date(chat.startedAt).toISOString(),
    modified: new Date(chat.endedAt).toISOString(),
    duration_minutes: Math.round((chat.endedAt - chat.startedAt) / 60_000),
    user_message_count: userExchanges.length,
    assistant_message_count: assistantExchanges.length,
    message_count: chat.exchangeCount,
    first_prompt: firstUserContent.slice(0, 200),
    tools_used: {},
    files_touched: [],
    domain: classifyDomain(userMessages),
    git_branch: 'n/a',
    has_subagents: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    file_size_bytes: 0,
    device_id: DEVICE_ID,
  }
}

function buildEntryFromActiveSession(session: {
  id: string
  exchanges: Array<{ role: string; content: string; timestamp: number }>
  createdAt: number
  lastActivity: number
}): SessionCacheEntry {
  const userExchanges = session.exchanges.filter(e => e.role === 'user')
  const assistantExchanges = session.exchanges.filter(e => e.role === 'assistant')
  const userMessages = userExchanges.map(e => e.content)
  const firstUserContent = userMessages[0] ?? ''

  return {
    session_id: `glasses-${session.id}`,
    glasses_session_id: session.id,
    slug: firstUserContent.slice(0, 60) || 'Active glasses session',
    created: new Date(session.createdAt).toISOString(),
    modified: new Date(session.lastActivity).toISOString(),
    duration_minutes: Math.round((session.lastActivity - session.createdAt) / 60_000),
    user_message_count: userExchanges.length,
    assistant_message_count: assistantExchanges.length,
    message_count: session.exchanges.length,
    first_prompt: firstUserContent.slice(0, 200),
    tools_used: {},
    files_touched: [],
    domain: classifyDomain(userMessages),
    git_branch: 'n/a',
    has_subagents: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    file_size_bytes: 0,
    device_id: DEVICE_ID,
  }
}

function loadArchivedSessions(): SessionCacheEntry[] {
  const entries: SessionCacheEntry[] = []
  const cutoff = Date.now() - MAX_ARCHIVE_AGE_DAYS * 86_400_000

  try {
    const files = readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')).sort()
    for (const fname of files) {
      const date = fname.replace('.json', '')
      // Skip archives older than 30 days
      const fileDate = new Date(date + 'T00:00:00Z').getTime()
      if (fileDate < cutoff) continue

      try {
        const raw = readFileSync(resolve(ARCHIVE_DIR, fname), 'utf-8')
        const archive: DailyArchive = JSON.parse(raw)
        for (let i = 0; i < archive.chats.length; i++) {
          entries.push(buildEntryFromArchiveChat(archive.chats[i], date, i))
        }
      } catch {
        // Skip corrupt archive files
      }
    }
  } catch {
    // Archive dir doesn't exist yet — fine
  }

  return entries
}

// S1 (2026-11-09): said once per process. COS Control's generated .env has no COS_SCRIPTS_DIR, so
// on a new install this ran after every exchange (5 s debounce) and printed each time.
let scriptsDirMissingNoted = false

export function updateGlassesSessionCache(): void {
  if (!SCRIPTS_DIR) {
    if (!scriptsDirMissingNoted) {
      scriptsDirMissingNoted = true
      console.warn('[session-cache] COS_SCRIPTS_DIR not set — skipping cache writes (said once)')
    }
    return
  }

  const sessions: Record<string, SessionCacheEntry> = {}

  // 1. Archived sessions
  const archived = loadArchivedSessions()
  for (const entry of archived) {
    sessions[entry.session_id] = entry
  }

  // 2. Active sessions — always included (mutually exclusive with archives;
  //    conversation.ts deletes sessions from memory after archiving)
  const active = getActiveSessions()
  for (const session of active) {
    const entry = buildEntryFromActiveSession(session)
    sessions[entry.session_id] = entry
  }

  // 3. Atomic write: .tmp then rename
  const cachePath = resolve(SCRIPTS_DIR, '.session_index_cache_COS-Glasses.json')
  const tmpPath = cachePath + '.tmp'

  try {
    const cache = {
      sessions,
      device_id: DEVICE_ID,
      updated_at: new Date().toISOString(),
      session_count: Object.keys(sessions).length,
    }
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2))
    renameSync(tmpPath, cachePath)
  } catch (err) {
    console.error('[session-cache] Failed to write cache:', err)
  }
}

// ── Debounced update ─────────────────────────────────────────

let cacheTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleCacheUpdate(): void {
  if (cacheTimer) return
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    updateGlassesSessionCache()
  }, 5_000) // 5s debounce
}

/** Flush any pending debounced cache write immediately */
export function flushCacheWrite(): void {
  if (cacheTimer) {
    clearTimeout(cacheTimer)
    cacheTimer = null
    updateGlassesSessionCache()
  }
}

// ── Init (called from index.ts after all modules are loaded) ─
export function initSessionCache(): void {
  updateGlassesSessionCache()
  console.log('[session-cache] Initial cache written')
}

// ── SIGTERM/SIGINT safety ────────────────────────────────────

process.on('SIGTERM', () => {
  flushCacheWrite()
})

process.on('SIGINT', () => {
  flushCacheWrite()
})
