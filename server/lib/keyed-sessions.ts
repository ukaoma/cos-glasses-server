// Key lanes K1 P3 (plan v4 7.3, W11): the CLI sessions that ran on a key, `data/keyed-sessions.json`.
//
// A Lane B Claude turn writes its transcript into the shared ~/.claude/projects, where COS
// Control's Continue and Fork, a handoff pickup, and an attach would otherwise resume it on the
// subscription. Every Claude CLI session id (and, from P4, Codex thread id) created under a
// profile is recorded here with its profile id, and those entry points refuse it with 409
// `keyed_session`.
//
// The file is written only by a keyed turn, so with key lanes never used it never exists and
// every check below is one failed stat. Reading never creates. Remove all keys (plan 12) keeps
// this file on purpose: a keyed transcript stays refused after the keys are gone. A manual
// `claude --resume` in a terminal is documented, not blocked.
import { statSync } from 'node:fs'
import { dataPath } from './data-dir.js'
import { readPrivateJsonFile, writePrivateJsonFile } from './key-store.js'
import { registerKeyLanesStatusProvider } from './key-lanes.js'
import type { RelayEngine } from './key-relay-contract.js'

export const KEYED_SESSIONS_FILE = 'keyed-sessions.json'
/** Far past any real use; the oldest entries go first past it. */
export const MAX_KEYED_SESSIONS = 20_000
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** The 409 body every refusing entry point returns (plan 7.3, 11.3). */
export const KEYED_SESSION_REFUSAL = {
  error: 'keyed_session',
  message: 'This session ran on your key. Continue it from COS.',
} as const

export interface KeyedSessionRecord {
  /** The Claude CLI session id or Codex thread id. */
  id: string
  engine: RelayEngine
  profileId: string
  /** The COS conversation the turn belonged to, when known. */
  cosSessionId?: string
  recordedAt: string
}

interface KeyedSessionsFile {
  v: 1
  sessions: KeyedSessionRecord[]
}

export function keyedSessionsPath(): string {
  return dataPath(KEYED_SESSIONS_FILE)
}

function isRecord(v: unknown): v is KeyedSessionRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<KeyedSessionRecord>
  return typeof r.id === 'string' && SESSION_ID_RE.test(r.id)
    && (r.engine === 'claude' || r.engine === 'codex')
    && typeof r.profileId === 'string'
    && typeof r.recordedAt === 'string'
}

// Ids recorded this boot. A failed write still refuses for the rest of the boot.
const memory = new Map<string, KeyedSessionRecord>()
let cache: { stamp: string; records: KeyedSessionRecord[] } | null = null

function fileRecords(): KeyedSessionRecord[] {
  const file = keyedSessionsPath()
  let stamp: string
  try {
    const st = statSync(file)
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    cache = null
    return []
  }
  if (cache?.stamp === stamp) return cache.records
  const parsed = readPrivateJsonFile(file) as Partial<KeyedSessionsFile> | undefined
  const records = parsed && Array.isArray(parsed.sessions) ? parsed.sessions.filter(isRecord) : []
  cache = { stamp, records }
  return records
}

export function listKeyedSessions(): KeyedSessionRecord[] {
  const byId = new Map<string, KeyedSessionRecord>()
  for (const r of fileRecords()) byId.set(r.id, r)
  for (const r of memory.values()) if (!byId.has(r.id)) byId.set(r.id, r)
  return [...byId.values()]
}

/** True once anything was ever recorded. The cheap short-circuit every refusing site starts with. */
export function anyKeyedSessions(): boolean {
  return memory.size > 0 || fileRecords().length > 0
}

export function isKeyedSession(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false
  if (memory.has(id)) return true
  return fileRecords().some(r => r.id === id)
}

/** True when any keyed CLI session belongs to this COS conversation. */
export function isKeyedCosSession(cosSessionId: unknown): boolean {
  if (typeof cosSessionId !== 'string' || !cosSessionId) return false
  return listKeyedSessions().some(r => r.cosSessionId === cosSessionId)
}

export function keyedSessionIds(): string[] {
  return listKeyedSessions().map(r => r.id)
}

/**
 * Record a session created under a profile. Idempotent per id. 0600, atomic. Called by the
 * bridge the moment the CLI names its session, before any answer text.
 */
export function recordKeyedSession(input: {
  id: string
  engine: RelayEngine
  profileId: string
  cosSessionId?: string
}, now: () => Date = () => new Date()): void {
  if (!SESSION_ID_RE.test(input.id)) return
  const record: KeyedSessionRecord = {
    id: input.id,
    engine: input.engine,
    profileId: input.profileId,
    ...(input.cosSessionId ? { cosSessionId: input.cosSessionId } : {}),
    recordedAt: now().toISOString(),
  }
  if (!memory.has(input.id)) memory.set(input.id, record)
  const records = fileRecords()
  if (records.some(r => r.id === input.id)) return
  const next = [...records, record].slice(-MAX_KEYED_SESSIONS)
  try {
    const body: KeyedSessionsFile = { v: 1, sessions: next }
    writePrivateJsonFile(keyedSessionsPath(), body)
    cache = null
  } catch (err) {
    // The id stays refused in memory for this boot; the next keyed turn retries the write.
    console.error(`[keyed-sessions] could not persist a keyed session: ${err instanceof Error ? err.message : err}`)
  }
}

/** Tests only. */
export function __resetKeyedSessionsForTests(): void {
  memory.clear()
  cache = null
}

// P1's status route reads this while lanes are enabled. In-memory registration only.
registerKeyLanesStatusProvider({ keyedSessionIds })
