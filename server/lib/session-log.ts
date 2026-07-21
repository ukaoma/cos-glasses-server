// Session end logger — writes .glasses_sessions.jsonl to COS_SCRIPTS_DIR
// so COS can query Glasses sessions by original UUID, date, domain, or content.
// Fires on: TTL expiry, explicit /api/sessions/:id/end, server shutdown.

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { Exchange } from './conversation.js'

// Resolve COS_SCRIPTS_DIR independently (same pattern as session-cache-writer)
let SCRIPTS_DIR: string | null = null
try {
  if (process.env.COS_SCRIPTS_DIR) {
    SCRIPTS_DIR = resolve(process.env.COS_SCRIPTS_DIR)
  }
} catch { /* no-op */ }

const LOG_FILE_NAME = '.glasses_sessions.jsonl'

// Domain classification — lightweight keyword vote, identical to session-cache-writer.ts.
// Customize the keyword lists for your own workspaces; defaults to a work/personal split.
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

export interface SessionLogEntry {
  // Identity
  session_id: string          // Original 8-char UUID (e.g. "dea05c6e")
  device_id: string           // "COS-Glasses"

  // Timing
  created_at: string          // ISO
  ended_at: string            // ISO
  duration_minutes: number
  end_reason: 'ttl_expiry' | 'explicit_end' | 'server_shutdown' | 'explicit_clear'

  // Classification
  domain: string              // general | personal (customizable)
  slug: string                // <60 char summary (first user query until archive generates LLM title)

  // Model
  model_preference: string | null

  // Counts
  user_message_count: number
  assistant_message_count: number
  total_message_count: number

  // Content — full paired Q&A for COS queries
  messages: Array<{
    query: string
    response: string
    timestamp: string         // ISO
  }>
}

export interface EndSessionInput {
  id: string
  exchanges: Exchange[]
  createdAt: number
  lastActivity: number
  modelPreference: string | null
  endReason: 'ttl_expiry' | 'explicit_end' | 'server_shutdown' | 'explicit_clear'
  slug?: string               // LLM-generated summary if available
}

/** Build a log entry from session data */
export function buildSessionLogEntry(input: EndSessionInput): SessionLogEntry {
  const userExchanges = input.exchanges.filter(e => e.role === 'user')
  const assistantExchanges = input.exchanges.filter(e => e.role === 'assistant')
  const userMessages = userExchanges.map(e => e.content)

  // Pair user+assistant into messages
  const messages: SessionLogEntry['messages'] = []
  for (let i = 0; i < input.exchanges.length; i++) {
    const ex = input.exchanges[i]
    if (ex.role === 'user') {
      const next = input.exchanges[i + 1]
      if (next && next.role === 'assistant') {
        messages.push({
          query: ex.content,
          response: next.content,
          timestamp: new Date(next.timestamp).toISOString(),
        })
        i++ // skip paired assistant
      }
    }
  }

  const firstUserContent = userMessages[0] ?? ''
  const slug = input.slug || (firstUserContent.length > 57
    ? firstUserContent.slice(0, 57) + '...'
    : firstUserContent || 'Empty session')

  return {
    session_id: input.id,
    device_id: 'COS-Glasses',
    created_at: new Date(input.createdAt).toISOString(),
    ended_at: new Date(input.lastActivity).toISOString(),
    duration_minutes: Math.round((input.lastActivity - input.createdAt) / 60_000),
    end_reason: input.endReason,
    domain: classifyDomain(userMessages),
    slug,
    model_preference: input.modelPreference,
    user_message_count: userExchanges.length,
    assistant_message_count: assistantExchanges.length,
    total_message_count: input.exchanges.length,
    messages,
  }
}

/** Append a session log entry to .glasses_sessions.jsonl */
export function writeSessionLog(entry: SessionLogEntry): boolean {
  if (!SCRIPTS_DIR) {
    console.warn('[session-log] COS_SCRIPTS_DIR not set — skipping session log')
    return false
  }

  const logPath = resolve(SCRIPTS_DIR, LOG_FILE_NAME)

  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(logPath, 0o600)
    console.log(`[session-log] Logged session ${entry.session_id} (${entry.end_reason}, ${entry.duration_minutes}m, ${entry.total_message_count} msgs)`)
    return true
  } catch (err) {
    console.error('[session-log] Failed to write session log:', err)
    return false
  }
}

/** End a session: build entry and write to JSONL */
export function logSessionEnd(input: EndSessionInput): SessionLogEntry | null {
  if (input.exchanges.length === 0) return null

  const entry = buildSessionLogEntry(input)
  writeSessionLog(entry)
  return entry
}
