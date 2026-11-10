// Session end logger — writes .glasses_sessions.jsonl to COS_SCRIPTS_DIR
// so COS can query Glasses sessions by original UUID, date, domain, or content.
// Fires on: TTL expiry, explicit /api/sessions/:id/end, server shutdown.

import { appendFileSync, chmodSync, closeSync, createReadStream, fstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import type { Exchange } from './conversation.js'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

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

/** Where the ledger lives, or null when COS_SCRIPTS_DIR is not set. */
export function sessionLogPath(): string | null {
  return SCRIPTS_DIR ? resolve(SCRIPTS_DIR, LOG_FILE_NAME) : null
}

/** Append a session log entry to .glasses_sessions.jsonl. Unconditional: callers that may
 * repeat an unchanged session go through writeSessionLogIfChanged instead. */
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

// ── Write-once-per-content ledger state (S1, 2026-11-09) ──────────────────────────────
// Before this, every server shutdown appended EVERY session with exchanges (about 300 on
// Miles's Mac, since sessions.json keeps all ages), and the first auto-snapshot after
// each boot appended them all again, because its "unchanged" check lived only in memory.
// 72 boots in 14 days grew the ledger to 1.94 GB: 118,221 entries for 588 sessions, one
// session copied 1,254 times. The state below survives restarts, so an unchanged session
// is never appended twice. It is keyed by the ledger path, so pointing COS_SCRIPTS_DIR
// elsewhere starts a fresh state instead of suppressing writes to the new file.

/** Why an entry is being written. A snapshot or a shutdown is a copy of a live session;
 * an end (TTL, explicit end, clear) closes it. */
export type SessionLogKind = 'snapshot' | 'shutdown' | 'end'

interface LedgerStateRow { sig: string; kind: SessionLogKind; at: number }
/** `ino`: the ledger file the rows describe. A different or missing file (compaction, a restore, a
 * deletion) means the rows no longer describe what is on disk, so they are dropped (Q1 review S5). */
interface LedgerState { version: 1; logPath: string; ino?: number; sessions: Record<string, LedgerStateRow> }

function ledgerInode(logPath: string): number | null {
  try { return statSync(logPath).ino } catch { return null }
}

/** Most sessions the state remembers; the oldest by last write are dropped past this. */
export const SESSION_LOG_STATE_CAP = 5_000
const STATE_FILE_NAME = 'session-log-state.json'

let ledgerState: LedgerState | null = null
let ledgerStateDirty = false
let ledgerStateFlushTimer: ReturnType<typeof setTimeout> | null = null

function stateFilePath(): string {
  return dataPath(STATE_FILE_NAME)
}

function loadLedgerState(logPath: string): LedgerState {
  if (ledgerState && ledgerState.logPath === logPath) return ledgerState
  const fresh: LedgerState = { version: 1, logPath, sessions: {} }
  try {
    const result = loadJsonOrQuarantine<LedgerState>(stateFilePath())
    const loaded = result.status === 'ok' ? result.data : null
    if (loaded && loaded.version === 1 && loaded.logPath === logPath
      && loaded.sessions && typeof loaded.sessions === 'object') {
      ledgerState = loaded
      return loaded
    }
  } catch { /* unreadable state: start fresh; the worst case is one more copy per session */ }
  ledgerState = fresh
  return fresh
}

/** What makes two entries for one session the same: its messages, counts and model.
 * Timestamps the writer invents (a snapshot's ended_at is "now") are not part of it. */
export function sessionLogSignature(entry: SessionLogEntry): string {
  return createHash('sha256').update(JSON.stringify([
    entry.total_message_count,
    entry.user_message_count,
    entry.assistant_message_count,
    entry.model_preference,
    entry.created_at,
    entry.messages,
  ])).digest('hex').slice(0, 32)
}

/** Persist the state now (atomic). Called at the end of a shutdown or snapshot pass. */
export function flushSessionLogState(): void {
  if (ledgerStateFlushTimer) { clearTimeout(ledgerStateFlushTimer); ledgerStateFlushTimer = null }
  if (!ledgerState || !ledgerStateDirty) return
  const rows = Object.entries(ledgerState.sessions)
  if (rows.length > SESSION_LOG_STATE_CAP) {
    rows.sort((a, b) => b[1].at - a[1].at)
    ledgerState.sessions = Object.fromEntries(rows.slice(0, SESSION_LOG_STATE_CAP))
  }
  try {
    mkdirSync(dirname(stateFilePath()), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(stateFilePath(), JSON.stringify(ledgerState), { mode: 0o600 })
    ledgerStateDirty = false
  } catch (err) {
    console.error('[session-log] Failed to save ledger state:', err)
  }
}

function scheduleStateFlush(): void {
  if (ledgerStateFlushTimer) return
  ledgerStateFlushTimer = setTimeout(() => { ledgerStateFlushTimer = null; flushSessionLogState() }, 1_000)
  ledgerStateFlushTimer.unref?.()
}

/** 'unconfigured': COS_SCRIPTS_DIR is not set, so there is no ledger. That is the default for
 * every new install (COS Control's generated .env does not set it), not a failure. */
export type SessionLogWriteResult = 'written' | 'unchanged' | 'unconfigured' | 'failed'

let unconfiguredNoted = false
/** Say once per process that there is no ledger (Q1 review M2: the auto-snapshot printed it per
 * session every 5 minutes on a new install). */
function noteUnconfigured(): void {
  if (unconfiguredNoted) return
  unconfiguredNoted = true
  console.log('[session-log] COS_SCRIPTS_DIR not set: no .glasses_sessions.jsonl ledger on this install (said once)')
}

/** Append the entry unless this session's content was already written.
 *  - snapshot / shutdown: skipped when the last write for the session (any kind) had the same content.
 *  - end: skipped only when the last write was itself an end with the same content, so a real end
 *    always lands once even after a snapshot of the same content (its slug and end_reason differ). */
export function writeSessionLogIfChanged(entry: SessionLogEntry, kind: SessionLogKind): SessionLogWriteResult {
  const logPath = sessionLogPath()
  if (!logPath) { noteUnconfigured(); return 'unconfigured' }
  const state = loadLedgerState(logPath)
  const ino = ledgerInode(logPath)
  if (state.ino !== undefined && state.ino !== ino) {
    state.sessions = {}
    state.ino = undefined
    ledgerStateDirty = true
  }
  const sig = sessionLogSignature(entry)
  const prev = state.sessions[entry.session_id]
  if (prev && prev.sig === sig && (kind !== 'end' || prev.kind === 'end')) return 'unchanged'
  if (!writeSessionLog(entry)) return 'failed'
  state.ino = ledgerInode(logPath) ?? undefined
  state.sessions[entry.session_id] = { sig, kind, at: Date.now() }
  ledgerStateDirty = true
  scheduleStateFlush()
  return 'written'
}

function kindForReason(reason: EndSessionInput['endReason']): SessionLogKind {
  return reason === 'server_shutdown' ? 'shutdown' : 'end'
}

/** End a session: build entry and write to JSONL (once per content; see writeSessionLogIfChanged). */
export function logSessionEnd(input: EndSessionInput): SessionLogEntry | null {
  if (input.exchanges.length === 0) return null

  const entry = buildSessionLogEntry(input)
  writeSessionLogIfChanged(entry, kindForReason(input.endReason))
  return entry
}

// ── Reader (S1, 2026-11-09) ───────────────────────────────────────────────────────────
// /api/sessions/lookup read the whole ledger with readFileSync(...).toString(). At 1.94 GB
// that throws (the string is longer than V8 allows), the catch treated it as "no log
// file", and every lookup silently answered from live sessions only, after blocking the
// event loop for the read. This reader streams and reads only the bytes appended since the
// last call. It keeps, per session, what the old loop kept: the FIRST line's range, plus the
// latest end any line reported. Which of the two a lookup uses is the route's old rule
// (lookupRangesFromHistory below), unchanged.

export interface SessionLogRange {
  /** created_at of the session's first line in the file. Never widened (the old loop never moved it). */
  start: number
  /** ended_at of that first line. */
  firstEnd: number
  /** The latest ended_at of any line for the session. */
  end: number
}

interface RangeIndex { logPath: string; ino: number; offset: number; ranges: Map<string, SessionLogRange> }
let rangeIndex: RangeIndex | null = null
let rangeIndexBuild: Promise<Map<string, SessionLogRange>> | null = null

const ENTRY_PREFIX = /^\{"session_id":"((?:[^"\\]|\\.)*)","device_id":"(?:[^"\\]|\\.)*","created_at":"([^"]*)","ended_at":"([^"]*)"/

/** The identity and time range of one ledger line, or null for a line that is not an entry. */
export function parseSessionLogLine(line: string): { sessionId: string; start: number; end: number } | null {
  let sessionId: string | undefined
  let createdAt: string | undefined
  let endedAt: string | undefined
  const prefix = ENTRY_PREFIX.exec(line.slice(0, 512))
  if (prefix) {
    try { sessionId = JSON.parse(`"${prefix[1]}"`) } catch { sessionId = undefined }
    createdAt = prefix[2]
    endedAt = prefix[3]
  }
  if (sessionId === undefined) {
    try {
      const d = JSON.parse(line)
      if (d && typeof d.session_id === 'string') {
        sessionId = d.session_id
        createdAt = typeof d.created_at === 'string' ? d.created_at : undefined
        endedAt = typeof d.ended_at === 'string' ? d.ended_at : undefined
      }
    } catch { return null }
  }
  if (!sessionId || !createdAt) return null
  const start = new Date(createdAt).getTime()
  if (!Number.isFinite(start)) return null
  const endParsed = endedAt ? new Date(endedAt).getTime() : NaN
  const end = Number.isFinite(endParsed) ? endParsed : start + 7_200_000
  return { sessionId, start, end }
}

function mergeRange(ranges: Map<string, SessionLogRange>, id: string, start: number, end: number): void {
  const existing = ranges.get(id)
  if (!existing) { ranges.set(id, { start, firstEnd: end, end }); return }
  if (end > existing.end) existing.end = end
}

/**
 * The ranges /api/sessions/lookup matches against, in first-seen order: the route's rule from
 * before S1, unchanged (Q1 review M1, 2026-11-09). A session's range starts at its first line.
 * Its end may be widened by later lines ONLY when the session is not in memory. A session still
 * in memory (restored from sessions.json, however old) keeps its first line's end, because every
 * boot snapshot of it is stamped ended_at = now: widening would let an October session claim
 * November timestamps, and the glasses companion stores the answer for good.
 * Sessions in `live` are skipped (the route lists them first, extended to now).
 */
export function lookupRangesFromHistory(
  history: ReadonlyMap<string, SessionLogRange>,
  inMemory: (sessionId: string) => boolean,
  live: ReadonlySet<string> = new Set(),
): Array<{ sid: string; start: number; end: number }> {
  const out: Array<{ sid: string; start: number; end: number }> = []
  for (const [sid, range] of history) {
    if (live.has(sid)) continue
    out.push({ sid, start: range.start, end: inMemory(sid) ? range.firstEnd : Math.max(range.firstEnd, range.end) })
  }
  return out
}

/** Index lines in [from, to) of the file into `ranges`. Returns the offset just past the
 * last complete line, so a half-written last line is read again next time. */
async function indexBytes(path: string, from: number, to: number, ranges: Map<string, SessionLogRange>): Promise<number> {
  if (to <= from) return from
  let offset = from
  let carry: Buffer[] = []
  let carryLen = 0
  const stream = createReadStream(path, { start: from, end: to - 1, highWaterMark: 1 << 20 })
  for await (const raw of stream) {
    let chunk = raw as Buffer
    let nl = chunk.indexOf(10)
    while (nl !== -1) {
      const piece = chunk.subarray(0, nl)
      // Only the first 512 bytes are needed for the fast path; keep the whole line only
      // while it is short or when the fast path fails (legacy key order).
      const lineBuf = carryLen ? Buffer.concat([...carry, piece]) : piece
      const lineLen = carryLen + piece.length
      carry = []; carryLen = 0
      const head = lineBuf.subarray(0, Math.min(lineBuf.length, 512)).toString('utf8')
      let parsed = ENTRY_PREFIX.test(head) ? parseSessionLogLine(head) : null
      if (!parsed && lineBuf.length <= 64 * 1024 * 1024) parsed = parseSessionLogLine(lineBuf.toString('utf8'))
      if (parsed) mergeRange(ranges, parsed.sessionId, parsed.start, parsed.end)
      offset += lineLen + 1
      chunk = chunk.subarray(nl + 1)
      nl = chunk.indexOf(10)
    }
    if (chunk.length) { carry.push(Buffer.from(chunk)); carryLen += chunk.length }
  }
  return offset
}

/** One time range per session from the ledger, read incrementally. A shrunk or replaced
 * file (compaction) is re-read from the start. A missing file is an empty map. */
export async function readSessionLogRanges(path: string | null = sessionLogPath()): Promise<Map<string, SessionLogRange>> {
  if (!path) return new Map()
  if (rangeIndexBuild) return rangeIndexBuild
  rangeIndexBuild = (async () => {
    let size: number
    let ino: number
    try {
      const fd = openSync(path, 'r')
      try { const st = fstatSync(fd); size = st.size; ino = st.ino } finally { closeSync(fd) }
    } catch {
      rangeIndex = null
      return new Map<string, SessionLogRange>()
    }
    if (!rangeIndex || rangeIndex.logPath !== path || rangeIndex.ino !== ino || rangeIndex.offset > size) {
      rangeIndex = { logPath: path, ino, offset: 0, ranges: new Map() }
    }
    const index = rangeIndex
    index.offset = await indexBytes(path, index.offset, size, index.ranges)
    return index.ranges
  })()
  try {
    return await rangeIndexBuild
  } finally {
    rangeIndexBuild = null
  }
}

/** Size of the ledger in bytes, or null when it does not exist (diagnostics). */
export function sessionLogSize(): number | null {
  const path = sessionLogPath()
  if (!path) return null
  try { return statSync(path).size } catch { return null }
}

/** Tests only: forget the in-memory state and reader index. */
export function __resetSessionLogForTests(): void {
  if (ledgerStateFlushTimer) clearTimeout(ledgerStateFlushTimer)
  ledgerStateFlushTimer = null
  ledgerState = null
  ledgerStateDirty = false
  unconfiguredNoted = false
  rangeIndex = null
  rangeIndexBuild = null
}
