/**
 * 6.99.16: the COS thread. One persistent, size-capped conversation behind the COS chat's Ask (routes/cos-thread.ts).
 *
 * Why: every Ask from the COS chat used to start a brand-new session, and a fresh session already starts at about
 * 100K tokens of context (CLAUDE.md, gotchas, memory, tool definitions; 101,720 and 103,116 on the first call in two
 * session logs read on 2026-11-05). Continuing a session while its prompt cache is warm is cheaper than starting
 * fresh; what makes a forever thread expensive is size. So: one thread continues the same session until that
 * session's context passes a cap (COS_THREAD_CAP_TOKENS, default 150,000, about 50K of conversation on top of the
 * baseline), then the next Ask starts a fresh session carrying a short mechanical digest (no model call).
 *
 * Storage, so a thread can always be recovered and searched:
 *   DATA_DIR/cos-thread/ledger.jsonl  append-only, every row ever written (authoritative)
 *   DATA_DIR/cos-thread/state.json    a snapshot of the current thread, written atomically after each ledger append;
 *                                     rebuilt from the ledger when it is missing, corrupt or behind the ledger.
 * Directory 0700, files 0600. Ledger rows:
 *   { kind: 'thread', id, at, from? }                      a thread starts (from: the thread New thread closed)
 *   { kind: 'turn', threadId, segment, sessionId, clientId, at, query, answerHead, messageNo, provider, native? }
 *   { kind: 'rollover', threadId, at, reason, fromSessionId, digest }
 *   { kind: 'close', threadId, at, reason }
 *
 * `sessionId` is the COS conversation id (the one POST /api/query-jobs takes and reports). Its Claude Code log is
 * found through the CLI session the bridge holds for it (`native`), read from the tail only.
 *
 * 7.0.39 (persistent thread, candidate 1; lanes/S1_cos_thread_server_design.md, W1_cos_thread_routes_proposal.md):
 * the thread's whole history, read a page at a time (history(), entry()). Every turn row ever written, in every thread
 * past and present, is indexed by its byte place in the ledger, so a page is a handful of positioned reads and memory
 * holds only the index, however long the thread grows. A cursor is the place between two entries (`c1.<n>`: before
 * the n-th turn), stable across restarts because the ledger is append-only. Nothing here logs words.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, writeSync, fsyncSync, fchmodSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { localDay } from './local-day.js'
import { securePrivateDirectory } from './secure-user-config.js'

export const COS_THREAD_PROTOCOL = 1
export const COS_THREAD_DEFAULT_CAP = 150_000
export const COS_THREAD_CAP_MIN = 20_000
export const COS_THREAD_CAP_MAX = 1_000_000
export const DIGEST_MAX_CHARS = 6000
export const DIGEST_TURNS = 8
export const DIGEST_DROPS = 12
export const DIGEST_QUERY_CHARS = 200
export const DIGEST_ANSWER_CHARS = 300
export const DIGEST_DROP_CHARS = 160
export const SEARCH_MEMORY_TURNS = 5000
export const ANSWER_HEAD_CHARS = 2000
/** Kept in memory per turn for search; the ledger keeps the whole query. */
export const MEMORY_QUERY_CHARS = 4000
export const LOG_TAIL_BYTES = 512 * 1024
/** History pages (7.0.39): entries per page by default and at most, and the most bytes one page may carry. */
export const HISTORY_DEFAULT_LIMIT = 40
export const HISTORY_MAX_LIMIT = 100
export const HISTORY_MAX_BYTES = 256 * 1024
/** The history route's own protocol, advertised as `capabilities.dropIt.thread.history`. */
export const COS_THREAD_HISTORY_PROTOCOL = 1
/** One entry's full answer, at most (a longer one is cut and reads `full: false`). */
export const ENTRY_MAX_ANSWER_CHARS = 1_000_000
/** The archive fallback for a full answer: days read after the turn's own day, each file's size, and all of them. */
export const ARCHIVE_LOOKAHEAD_DAYS = 31
export const ARCHIVE_FILE_MAX_BYTES = 32 * 1024 * 1024
export const ARCHIVE_TOTAL_MAX_BYTES = 96 * 1024 * 1024
export const DIGEST_HEADER = 'Earlier in this COS thread (a summary carried over; ask COS to search History or Messages for more):'
const DAY_MS = 24 * 60 * 60_000

/** thread_only (7.0.39): the next Ask is a cosThread one and the thread's conversation is not a thread conversation yet. */
export type NextReason = 'continue' | 'empty' | 'size' | 'missing_session' | 'manual' | 'thread_only'
export interface CosThreadView {
  id: string
  startedAt: string
  lastAskAt: string | null
  asks: number
  segments: number
  sessionId: string | null
  provider: string | null
  contextTokens: number | null
}
export interface CosThreadNext {
  mode: 'continue' | 'fresh'
  sessionId: string | null
  reason: NextReason
  digest: string | null
}
export interface CosThreadAnswer {
  protocol: 1
  capTokens: number
  thread: CosThreadView
  next: CosThreadNext
}
export interface CosThreadTurnInput {
  clientId: string
  sessionId: string
  query: string
  answer?: string
  messageNo?: number
  provider?: string
}
export interface CosThreadSearchHit {
  threadId: string
  sessionId: string
  at: string
  query: string
  answerHead: string
  messageNo: number | null
}
export interface CosThreadSearchAnswer { hits: CosThreadSearchHit[]; scanned: number }
export interface CosThreadSummary {
  id: string
  startedAt: string
  endedAt: string | null
  asks: number
  segments: number
  title: string
}
/** One chat in the thread's history (7.0.39). `answer` is the preview the ledger keeps (2,000 characters); `full` says
 * whether it is the whole answer, and `answerChars` its whole length when known. */
export interface CosThreadChatEntry {
  id: string
  at: string
  kind: 'chat'
  question: string
  answer: string
  answerChars: number | null
  full: boolean
  threadId: string
  /** 7.0.39 candidate 2: a chat the server recorded from its job (cosThread) carries its job status; a running one is the
   * page's cue to reattach through /api/query-jobs/by-client. Rows from before candidate 2 read 'completed'. */
  status: CosThreadChatStatus
  messageNo: number | null
  /** Present on a chat the server recorded from its job: the job's identity, for reattach and Retry. */
  clientJobId?: string
  generation?: number
}
export type CosThreadChatStatus = 'running' | 'completed' | 'failed' | 'interrupted'
/** What the job runtime hands the thread at a job's start and end (lib/query-job-runtime.ts). */
export interface CosThreadJobInput { clientJobId: string; generation: number; sessionId: string; query: string; provider?: string }
export interface CosThreadJobEnd extends CosThreadJobInput { status: 'completed' | 'failed' | 'canceled' | 'interrupted'; text: string }
/** A running chat with no end recorded this long after it started reads 'interrupted' (its job is long gone). */
export const RUNNING_STALE_MS = 6 * 60 * 60_000
/** A page of history: entries oldest to newest. `older` reads further back (null: this is the start). `newest` is the
 * cursor for `after=`. `more`: an `after=` page stopped at its limit or its byte cap and more entries follow. */
export interface CosThreadHistoryPage {
  protocol: 1
  entries: CosThreadChatEntry[]
  older: string | null
  newest: string
  more: boolean
  /** Entries already sent whose outcome changed since the cursor; always empty until breadcrumbs (candidate 3). */
  updated: CosThreadChatEntry[]
}
/** `maxBytes` exists for tests only (the route never sends it): one entry is at most about 120 KB, under the cap. */
export interface CosThreadHistoryQuery { before?: number; after?: number; afterAnswers?: number; limit: number; maxBytes?: number }
/** What a full-answer read needs to look the answer up elsewhere. */
export interface CosThreadEntryLookup { sessionId: string; clientId: string; messageNo: number | null; at: string; query: string }
/** A drop as the digest carries it: its words and where it was filed. */
export interface DigestDrop { text: string; createdAt: string; filed: string }
/** found: the session and its log exist. tokens: the last assistant message's context, null when unreadable. */
export interface ContextReading { found: boolean; tokens: number | null }

export class CosThreadError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

// ── rows ──────────────────────────────────────────────
interface ThreadRow { kind: 'thread'; id: string; at: string; from?: string }
interface TurnRow {
  kind: 'turn'; threadId: string; segment: number; sessionId: string; clientId: string; at: string
  query: string; answerHead: string; messageNo: number | null; provider: string | null; native?: string
  /** 7.0.39: written by the server from a cosThread job (its generation at the first record). */
  job?: { generation: number }
}
/** 7.0.39: a job's end for a thread chat. The whole answer of a completed one is in answers/<YYYY-MM>.jsonl at `ref`. */
interface AnswerRow {
  kind: 'answer'; clientId: string; generation: number; at: string; status: CosThreadChatStatus
  answerHead: string; answerChars: number; ref?: AnswerRef
}
interface AnswerRef { file: string; offset: number; length: number; sha256: string }
interface AnswerState { seq: number; generation: number; status: CosThreadChatStatus; answerHead: string; answerChars: number; ref?: AnswerRef }
interface RolloverRow { kind: 'rollover'; threadId: string; at: string; reason: NextReason; fromSessionId: string | null; digest: string | null }
interface CloseRow { kind: 'close'; threadId: string; at: string; reason: string }
type LedgerRow = ThreadRow | TurnRow | RolloverRow | CloseRow | AnswerRow

interface CurrentThread {
  id: string
  startedAt: string
  lastAskAt: string | null
  asks: number
  segments: number
  sessionId: string | null
  nativeSessionId: string | null
  provider: string | null
  /** The thread New thread closed to start this one; its turns are carried until this one has its own. */
  from: string | null
}
interface StateFile { schema: 1; ledgerRows: number; current: CurrentThread }
/** A turn row's place in the ledger (7.0.39). */
interface HistoryRef { clientId: string; offset: number; length: number }
interface RowPlace { offset: number; length: number }
interface MemoryTurn { threadId: string; sessionId: string; clientId: string; at: string; query: string; answerHead: string; messageNo: number | null }

// ── validation ────────────────────────────────────────
const CLIENT_ID_RE = /^[A-Za-z0-9:_-]{8,80}$/
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/
const PROVIDER_RE = /^[a-z0-9-]{1,32}$/
const TURN_KEYS = new Set(['clientId', 'sessionId', 'query', 'answer', 'messageNo', 'provider'])

/** The turn body, or null when any field is out of contract (the route answers 400 invalid_turn). */
export function parseTurnInput(raw: unknown): CosThreadTurnInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  if (Object.keys(b).some(k => !TURN_KEYS.has(k))) return null
  if (typeof b.clientId !== 'string' || !CLIENT_ID_RE.test(b.clientId)) return null
  if (typeof b.sessionId !== 'string' || !SESSION_ID_RE.test(b.sessionId)) return null
  if (typeof b.query !== 'string' || b.query.length < 1 || b.query.length > 20_000 || !b.query.trim()) return null
  if (b.answer !== undefined && b.answer !== null && (typeof b.answer !== 'string' || b.answer.length > 40_000)) return null
  if (b.messageNo !== undefined && b.messageNo !== null && (typeof b.messageNo !== 'number' || !Number.isSafeInteger(b.messageNo) || b.messageNo < 1)) return null
  if (b.provider !== undefined && b.provider !== null && (typeof b.provider !== 'string' || !PROVIDER_RE.test(b.provider))) return null
  return {
    clientId: b.clientId,
    sessionId: b.sessionId,
    query: b.query,
    ...(typeof b.answer === 'string' ? { answer: b.answer } : {}),
    ...(typeof b.messageNo === 'number' ? { messageNo: b.messageNo } : {}),
    ...(typeof b.provider === 'string' ? { provider: b.provider } : {}),
  }
}

/** COS_THREAD_CAP_TOKENS: a whole number from 20,000 to 1,000,000; anything else is the default 150,000. */
export function cosThreadCapTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COS_THREAD_CAP_TOKENS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return COS_THREAD_DEFAULT_CAP
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= COS_THREAD_CAP_MIN && n <= COS_THREAD_CAP_MAX ? n : COS_THREAD_DEFAULT_CAP
}

// ── context tokens from a Claude Code session log ─────
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COS_CLAUDE_PROJECTS_DIR?.trim()
  if (override) return override
  const config = env.CLAUDE_CONFIG_DIR?.trim()
  return join(config || join(homedir(), '.claude'), 'projects')
}

/** `<projectsDir>/<any project dir>/<id>.jsonl`, or null. A symlink or a non-file never counts. */
export function findSessionLog(projectsDir: string, id: string): string | null {
  if (!SESSION_LOG_ID_RE.test(id)) return null
  let dirs: string[]
  try { dirs = readdirSync(projectsDir) } catch { return null }
  for (const dir of dirs) {
    const file = join(projectsDir, dir, `${id}.jsonl`)
    try {
      const stat = lstatSync(file)
      if (stat.isFile()) return file
    } catch { /* not in this project */ }
  }
  return null
}
const SESSION_LOG_ID_RE = /^[A-Za-z0-9-]{8,80}$/

/** The last tail of a file, at most `max` bytes. */
function readTail(file: string, max: number): { text: string; truncated: boolean } {
  // O_NONBLOCK: a FIFO planted at the log path must not stop the event loop (hazard-invariants.test.ts).
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw new CosThreadError('cos_thread_unsafe', 503) }
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, max)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read)
      if (n <= 0) break
      read += n
    }
    return { text: buffer.subarray(0, read).toString('utf8'), truncated: size > length }
  } finally { closeSync(fd) }
}

/**
 * The context of a session's last assistant message: input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens. Reads only the last 512 KB. Sidechain (subagent) messages are skipped.
 */
export function contextTokensFromLog(file: string, tailBytes = LOG_TAIL_BYTES): number | null {
  let tail: { text: string; truncated: boolean }
  try { tail = readTail(file, tailBytes) } catch { return null }
  const lines = tail.text.split('\n')
  if (tail.truncated) lines.shift()  // the first line was cut in the middle
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line || !line.includes('"usage"')) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (!row || row.type !== 'assistant' || row.isSidechain === true) continue
    const usage = row.message?.usage
    if (!usage || typeof usage !== 'object') continue
    const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
    if (!parts.some(v => typeof v === 'number')) continue
    return parts.reduce((sum: number, v) => sum + (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0), 0)
  }
  return null
}

export interface ClaudeContextReaderOptions {
  projectsDir?: () => string
  /** The COS conversation still exists. Absent: assumed to. */
  sessionExists?: (sessionId: string) => boolean
  /** The CLI session the bridge holds for a COS conversation right now. */
  nativeFor?: (sessionId: string) => string | undefined
}
/** Reads a COS conversation's context from its Claude Code log (the live CLI session first, then the one recorded). */
export function claudeContextReader(options: ClaudeContextReaderOptions = {}): (sessionId: string, native: string | null) => ContextReading {
  const located = new Map<string, string>()
  return (sessionId, native) => {
    if (options.sessionExists && !options.sessionExists(sessionId)) return { found: false, tokens: null }
    const dir = (options.projectsDir ?? defaultClaudeProjectsDir)()
    const ids = [...new Set([options.nativeFor?.(sessionId), native, sessionId].filter((v): v is string => !!v))]
    for (const id of ids) {
      let file = located.get(id) ?? null
      if (file && !existsSync(file)) { located.delete(id); file = null }
      file ??= findSessionLog(dir, id)
      if (!file) continue
      located.set(id, file)
      return { found: true, tokens: contextTokensFromLog(file) }
    }
    return { found: false, tokens: null }
  }
}

// ── the digest ────────────────────────────────────────
function oneLine(s: string, n: number): string {
  const flat = String(s || '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + '…' : flat
}
export interface DigestTurn { query: string; answerHead: string; messageNo: number | null }

/** Mechanical, no model: the last turns (oldest first) and the recent drops, at most 6000 characters. Null when empty. */
export function buildDigest(turns: readonly DigestTurn[], drops: readonly DigestDrop[]): string | null {
  let t = turns.slice(-DIGEST_TURNS)
  let d = drops.slice(0, DIGEST_DROPS)
  if (!t.length && !d.length) return null
  const render = () => {
    const lines = [DIGEST_HEADER]
    if (t.length) {
      lines.push('', 'Recent asks, oldest first:')
      for (const turn of t) {
        lines.push(`- ${turn.messageNo ? `#${turn.messageNo} ` : ''}You asked: ${oneLine(turn.query, DIGEST_QUERY_CHARS)}`)
        const answer = oneLine(turn.answerHead, DIGEST_ANSWER_CHARS)
        if (answer) lines.push(`  COS answered: ${answer}`)
      }
    }
    if (d.length) {
      lines.push('', 'Recent drops, oldest first:')
      for (const drop of d) lines.push(`- ${oneLine(drop.text, DIGEST_DROP_CHARS)} (${oneLine(drop.filed, 80)})`)
    }
    return lines.join('\n')
  }
  let text = render()
  // Over the cap: the oldest drops go first (down to 4), then the oldest turns (down to 2), then a hard cut.
  while (text.length > DIGEST_MAX_CHARS && (d.length > 4 || t.length > 2)) {
    if (d.length > 4) d = d.slice(1)
    else t = t.slice(1)
    text = render()
  }
  return text.length > DIGEST_MAX_CHARS ? text.slice(0, DIGEST_MAX_CHARS - 1) + '…' : text
}

const DEST_LABEL: Record<string, string> = {
  new_card: 'filed as a new Work card', existing_card: 'added to a Work card', thread: 'added to a thread', memory: 'saved to memory',
  session: 'sent to a session', note: 'saved as a note', reminder: 'set as a reminder', ask: 'asked COS',
}
/** Where a drop was filed, in words: its first link's label when it has one. */
export function describeDropFiling(drop: { state: string; dest: string | null; links?: ReadonlyArray<{ label?: string }> }): string {
  if (drop.state === 'routing') return 'still being filed'
  if (drop.state === 'asking' || drop.state === 'held') return drop.state === 'held' ? 'held for a session' : 'waiting on a choice'
  const where = drop.dest ? DEST_LABEL[drop.dest] ?? 'filed' : 'filed'
  const label = drop.links?.find(l => typeof l.label === 'string' && l.label.trim())?.label
  return label ? `${where}: ${oneLine(label, 60)}` : where
}

// ── the store ─────────────────────────────────────────
export interface CosThreadDeps {
  /** DATA_DIR/cos-thread */
  dir: string
  now?: () => number
  capTokens?: () => number
  context?: (sessionId: string, native: string | null) => ContextReading
  /** Drops created at or after `sinceIso`, newest first, undone ones left out, at most `limit`. */
  drops?: (sinceIso: string, limit: number) => DigestDrop[]
  /** The CLI session for a COS conversation, recorded with each turn so a restart can still find the log. */
  nativeFor?: (sessionId: string) => string | undefined
  /** A turn recorded without its answer: the answer from the live conversation, when it is still there. */
  answerFor?: (sessionId: string, clientId: string, messageNo: number | null) => string | undefined
  newId?: () => string
}

export class CosThread {
  private readonly ledgerFile: string
  private readonly stateFile: string
  private readonly now: () => number
  private current!: CurrentThread
  private ledgerRows = 0
  private readonly clientIds = new Set<string>()
  private readonly turns: MemoryTurn[] = []
  private readonly threads = new Map<string, CosThreadSummary>()
  private readonly order: string[] = []
  /** Every turn row, in ledger order: the history index. Never trimmed. */
  private readonly history: HistoryRef[] = []
  private readonly historyByClient = new Map<string, number>()
  /** 7.0.39 candidate 2: the latest job end per chat, and how many ends were recorded (the `after` cursor's second part). */
  private readonly answers = new Map<string, AnswerState>()
  private answerSeq = 0

  constructor(private readonly deps: CosThreadDeps) {
    this.now = deps.now ?? Date.now
    securePrivateDirectory(deps.dir)
    this.ledgerFile = join(deps.dir, 'ledger.jsonl')
    this.stateFile = join(deps.dir, 'state.json')
    this.load()
  }

  private iso(): string { return new Date(this.now()).toISOString() }
  private newId(): string { return this.deps.newId?.() ?? `th_${randomBytes(8).toString('hex')}` }
  cap(): number { return this.deps.capTokens?.() ?? cosThreadCapTokens() }

  // ── loading ─────────────────────────────────────────
  private load(): void {
    const rows = this.readLedger()
    for (const { row, place } of rows) this.apply(row, place)
    this.ledgerRows = rows.length
    if (!this.order.length) {
      this.append({ kind: 'thread', id: this.newId(), at: this.iso() })
      return
    }
    // The snapshot is used only when it matches the ledger; otherwise the ledger rebuild stands and is written out.
    const snapshot = this.readState()
    if (snapshot && snapshot.ledgerRows === this.ledgerRows && snapshot.current.id === this.current.id) this.current = snapshot.current
    else this.writeState()
  }
  private readLedger(): Array<{ row: LedgerRow; place: RowPlace }> {
    if (!existsSync(this.ledgerFile)) return []
    const stat = lstatSync(this.ledgerFile)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CosThreadError('cos_thread_unsafe', 503)
    const bytes = readFileSync(this.ledgerFile)
    // A torn last row (a crash mid-append) must not swallow the next one: end the file with a newline first.
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) this.appendRaw('')  // appendRaw adds the missing newline
    const rows: Array<{ row: LedgerRow; place: RowPlace }> = []
    // Split on the newline BYTE so each row's place is its byte offset in the file (7.0.39 history index).
    let start = 0
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0a, start)
      if (end === -1) end = bytes.length
      const line = bytes.subarray(start, end).toString('utf8')
      if (line.trim()) {
        try {
          const row = JSON.parse(line) as LedgerRow
          if (isRow(row)) rows.push({ row, place: { offset: start, length: end - start } })
        } catch { /* a torn row is skipped */ }
      }
      start = end + 1
    }
    return rows
  }
  private readState(): StateFile | null {
    try {
      const stat = lstatSync(this.stateFile)
      if (stat.isSymbolicLink() || !stat.isFile()) return null
      const value = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile
      if (value?.schema !== 1 || !Number.isInteger(value.ledgerRows) || !value.current || typeof value.current.id !== 'string') return null
      return value
    } catch { return null }
  }
  private writeState(): void {
    const value: StateFile = { schema: 1, ledgerRows: this.ledgerRows, current: this.current }
    durableAtomicWriteFileSync(this.stateFile, JSON.stringify(value) + '\n', { mode: 0o600 })
  }

  /** One row into memory: the same code builds the state live and from the ledger, so a rebuild cannot drift. */
  private apply(row: LedgerRow, place?: RowPlace): void {
    if (row.kind === 'thread') {
      this.threads.set(row.id, { id: row.id, startedAt: row.at, endedAt: null, asks: 0, segments: 0, title: '' })
      this.order.push(row.id)
      this.current = { id: row.id, startedAt: row.at, lastAskAt: null, asks: 0, segments: 0, sessionId: null, nativeSessionId: null, provider: null, from: row.from ?? null }
      return
    }
    if (row.kind === 'turn') {
      this.clientIds.add(row.clientId)
      if (place && !this.historyByClient.has(row.clientId)) {
        this.historyByClient.set(row.clientId, this.history.length)
        this.history.push({ clientId: row.clientId, offset: place.offset, length: place.length })
      }
      this.turns.push({ threadId: row.threadId, sessionId: row.sessionId, clientId: row.clientId, at: row.at, query: row.query.slice(0, MEMORY_QUERY_CHARS), answerHead: row.answerHead, messageNo: row.messageNo })
      if (this.turns.length > SEARCH_MEMORY_TURNS) this.turns.splice(0, this.turns.length - SEARCH_MEMORY_TURNS)
      const summary = this.threads.get(row.threadId)
      if (summary) {
        summary.asks += 1
        summary.segments = Math.max(summary.segments, row.segment)
        if (!summary.title) summary.title = oneLine(row.query, 80)
      }
      if (this.current?.id === row.threadId) {
        this.current = {
          ...this.current,
          asks: this.current.asks + 1,
          segments: Math.max(this.current.segments, row.segment),
          lastAskAt: row.at,
          sessionId: row.sessionId,
          nativeSessionId: row.native ?? (row.sessionId === this.current.sessionId ? this.current.nativeSessionId : null),
          provider: row.provider ?? this.current.provider,
        }
      }
      return
    }
    if (row.kind === 'close') {
      const summary = this.threads.get(row.threadId)
      if (summary) summary.endedAt = row.at
      return
    }
    if (row.kind === 'answer') {
      const prior = this.answers.get(row.clientId)
      if (prior && supersededBy(prior, row) === false) return
      this.answerSeq += 1
      this.answers.set(row.clientId, {
        seq: this.answerSeq, generation: row.generation, status: row.status, answerHead: row.answerHead, answerChars: row.answerChars,
        ...(row.ref ? { ref: row.ref } : {}),
      })
    }
  }

  /**
   * Appends `text` and answers where it starts, read from the file itself (7.0.39). The history index takes its offsets
   * from this, so a short, failed or foreign write never shifts a later row. A file that does not end with a newline
   * (a write torn mid-row) gets one first, so the new rows never join the torn one.
   */
  private appendRaw(text: string, file = this.ledgerFile): { start: number } {
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
    try {
      fchmodSync(fd, 0o600)
      const size = fstatSync(fd).size
      let lead = ''
      if (size > 0) {
        const last = Buffer.alloc(1)
        if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) lead = '\n'
      }
      writeSync(fd, lead + text)
      fsyncSync(fd)
      return { start: size + lead.length }
    } finally { closeSync(fd) }
  }
  /** Ledger first, then memory, then the snapshot: a crash between them leaves a ledger the next open rebuilds from. */
  private append(...rows: LedgerRow[]): void {
    const lines = rows.map(r => JSON.stringify(r))
    const text = lines.join('\n') + '\n'
    let offset = this.appendRaw(text).start
    rows.forEach((row, i) => {
      const length = Buffer.byteLength(lines[i]!)
      this.apply(row, { offset, length })
      offset += length + 1
    })
    this.ledgerRows += rows.length
    this.writeState()
  }

  // ── reading ─────────────────────────────────────────
  private evaluate(): { reason: NextReason; tokens: number | null } {
    const t = this.current
    if (!t.sessionId) return { reason: t.from ? 'manual' : 'empty', tokens: null }
    const reading = (this.deps.context ?? claudeContextReader())(t.sessionId, t.nativeSessionId)
    if (!reading.found) return { reason: 'missing_session', tokens: null }
    if (reading.tokens !== null && reading.tokens > this.cap()) return { reason: 'size', tokens: reading.tokens }
    return { reason: 'continue', tokens: reading.tokens }
  }

  private turnsOf(threadId: string): MemoryTurn[] { return this.turns.filter(t => t.threadId === threadId) }

  /** What a fresh session would carry for the thread as it is now. */
  private digestFor(thread: CurrentThread): string | null {
    let turns = this.turnsOf(thread.id)
    if (!turns.length && thread.from) turns = this.turnsOf(thread.from)
    const recent = turns.slice(-DIGEST_TURNS).map(t => ({
      query: t.query,
      answerHead: t.answerHead || this.answers.get(t.clientId)?.answerHead || this.safeAnswerFor(t) || '',
      messageNo: t.messageNo,
    }))
    const since = Math.min(Date.parse(thread.startedAt) || this.now(), this.now() - DAY_MS)
    let drops: DigestDrop[] = []
    try { drops = this.deps.drops?.(new Date(since).toISOString(), DIGEST_DROPS) ?? [] } catch { drops = [] }
    // The reader answers newest first; the digest reads oldest first.
    return buildDigest(recent, drops.slice(0, DIGEST_DROPS).reverse())
  }
  private safeAnswerFor(t: MemoryTurn): string | undefined {
    try { return this.deps.answerFor?.(t.sessionId, t.clientId, t.messageNo)?.slice(0, ANSWER_HEAD_CHARS) } catch { return undefined }
  }

  /**
   * The thread and what the next Ask should do. 7.0.39: with `isThreadSession` (GET /cos-thread?threadOnly=1, a page that
   * sends cosThread), a conversation that is not a thread conversation (one from before the update, numbered, in
   * Messages) is never continued: the next Ask starts a thread conversation carrying the digest. Without it, as before.
   */
  view(options: { isThreadSession?: (sessionId: string) => boolean } = {}): CosThreadAnswer {
    const { reason, tokens } = this.evaluate()
    const sid = this.current.sessionId
    if (reason === 'continue' && sid && options.isThreadSession && !options.isThreadSession(sid)) return this.answer('thread_only', tokens)
    return this.answer(reason, tokens)
  }
  private answer(reason: NextReason, tokens: number | null): CosThreadAnswer {
    const t = this.current
    const proceed = reason === 'continue'
    return {
      protocol: COS_THREAD_PROTOCOL,
      capTokens: this.cap(),
      thread: { id: t.id, startedAt: t.startedAt, lastAskAt: t.lastAskAt, asks: t.asks, segments: t.segments, sessionId: t.sessionId, provider: t.provider, contextTokens: tokens },
      next: proceed
        ? { mode: 'continue', sessionId: t.sessionId, reason, digest: null }
        : { mode: 'fresh', sessionId: null, reason, digest: this.digestFor(t) },
    }
  }

  // ── writing ─────────────────────────────────────────
  /** New thread: the current one closes (rollover `manual` with what it would carry), a new one starts with no session. */
  startNew(): CosThreadAnswer {
    const old = this.current
    const at = this.iso()
    const digest = this.digestFor(old)
    // An empty thread passes on what it was carrying, so pressing New twice never loses the summary.
    const from = old.asks > 0 ? old.id : old.from ?? undefined
    this.append(
      { kind: 'rollover', threadId: old.id, at, reason: 'manual', fromSessionId: old.sessionId, digest },
      { kind: 'close', threadId: old.id, at, reason: 'manual' },
      { kind: 'thread', id: this.newId(), at, ...(from ? { from } : {}) },
    )
    return this.answer('manual', null)
  }

  /** One Ask. Idempotent on clientId. A different session than the thread's is a rollover onto a new segment. */
  recordTurn(input: CosThreadTurnInput, jobGeneration?: number): CosThreadAnswer {
    if (this.clientIds.has(input.clientId)) return this.view()
    const t = this.current
    const at = this.iso()
    const rows: LedgerRow[] = []
    let segment = Math.max(t.segments, 1)
    if (t.sessionId !== null && t.sessionId !== input.sessionId) {
      const { reason } = this.evaluate()
      rows.push({ kind: 'rollover', threadId: t.id, at, reason, fromSessionId: t.sessionId, digest: this.digestFor(t) })
      segment = t.segments + 1
    }
    let native: string | undefined
    try { native = this.deps.nativeFor?.(input.sessionId) } catch { native = undefined }
    rows.push({
      kind: 'turn', threadId: t.id, segment, sessionId: input.sessionId, clientId: input.clientId, at,
      query: input.query, answerHead: (input.answer ?? '').slice(0, ANSWER_HEAD_CHARS), messageNo: input.messageNo ?? null,
      provider: input.provider ?? null, ...(native ? { native } : {}),
      ...(jobGeneration !== undefined ? { job: { generation: jobGeneration } } : {}),
    })
    this.append(...rows)
    return this.view()
  }

  // ── thread jobs (7.0.39 candidate 2) ────────────────
  /** A cosThread job started: its question becomes the thread's turn (idempotent on clientJobId, so a replay, a Retry or a
   * page's own POST /cos-thread/turn never adds a second). */
  recordJobStarted(job: CosThreadJobInput): void {
    if (this.clientIds.has(job.clientJobId)) return
    this.recordTurn({ clientId: job.clientJobId, sessionId: job.sessionId, query: job.query, ...(job.provider ? { provider: job.provider } : {}) }, job.generation)
  }

  /**
   * A cosThread job ended (any terminal status). The turn is written first when the start never was (a crash before it,
   * or the boot re-projection), then one answer row per generation. A completed answer goes whole into
   * answers/<YYYY-MM>.jsonl; the ledger keeps its first 2,000 characters and where the whole one is. A failed, cancelled
   * or interrupted one keeps only its partial answer's first 2,000 characters (the whole partial stays in the job).
   * Idempotent: the coordinator's boot re-projection calls this again for every retained terminal job.
   */
  recordJobEnd(end: CosThreadJobEnd): void {
    this.recordJobStarted(end)
    const status: CosThreadChatStatus = end.status === 'completed' ? 'completed' : end.status === 'failed' ? 'failed' : 'interrupted'
    const text = typeof end.text === 'string' ? end.text : ''
    const prior = this.answers.get(end.clientJobId)
    if (prior && supersededBy(prior, { generation: end.generation, status, answerChars: text.length }) === false) return
    const at = this.iso()
    let ref: AnswerRef | undefined
    if (status === 'completed' && text.length > ANSWER_HEAD_CHARS) ref = this.writeAnswer(end.clientJobId, end.generation, at, text)
    this.append({ kind: 'answer', clientId: end.clientJobId, generation: end.generation, at, status, answerHead: text.slice(0, ANSWER_HEAD_CHARS), answerChars: text.length, ...(ref ? { ref } : {}) })
  }

  /** The whole answer, appended to this month's answer file (0600, folder 0700); where it is and its hash. */
  private writeAnswer(clientId: string, generation: number, at: string, text: string): AnswerRef {
    const file = `answers/${localDay(Date.parse(at)).slice(0, 7)}.jsonl`
    const path = join(this.deps.dir, file)
    securePrivateDirectory(dirname(path))
    const line = JSON.stringify({ clientId, generation, at, text })
    const { start } = this.appendRaw(line + '\n', path)
    return { file, offset: start, length: Buffer.byteLength(line), sha256: createHash('sha256').update(text).digest('hex') }
  }

  /** A whole answer back from its file, checked against its hash; undefined when it cannot be read as written. */
  private readAnswer(ref: AnswerRef, clientId: string): string | undefined {
    if (!/^answers\/\d{4}-\d{2}\.jsonl$/.test(ref.file)) return undefined
    let fd: number
    try { fd = openSync(join(this.deps.dir, ref.file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) } catch { return undefined }
    try {
      if (!fstatSync(fd).isFile()) return undefined
      const buffer = Buffer.alloc(ref.length)
      let read = 0
      while (read < ref.length) {
        const n = readSync(fd, buffer, read, ref.length - read, ref.offset + read)
        if (n <= 0) break
        read += n
      }
      const row = JSON.parse(buffer.subarray(0, read).toString('utf8')) as { clientId?: unknown; text?: unknown }
      if (row.clientId !== clientId || typeof row.text !== 'string') return undefined
      return createHash('sha256').update(row.text).digest('hex') === ref.sha256 ? row.text : undefined
    } catch { return undefined } finally { closeSync(fd) }
  }

  // ── history (7.0.39) ─────────────────────────────────
  /** Turn rows at these indexes, read from the ledger by place. A row that is not the turn the index says it is (the file
   * changed under us) is a 503, never a wrong entry. */
  private readTurns(indexes: number[]): TurnRow[] {
    if (!indexes.length) return []
    let fd: number
    // O_NOFOLLOW: a ledger swapped for a symlink is refused (ELOOP), and reads as unsafe, never as a 500.
    try { fd = openSync(this.ledgerFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) } catch {
      throw new CosThreadError('cos_thread_unsafe', 503)
    }
    try {
      if (!fstatSync(fd).isFile()) throw new CosThreadError('cos_thread_unsafe', 503)
      return indexes.map(i => {
        const ref = this.history[i]!
        const buffer = Buffer.alloc(ref.length)
        let read = 0
        while (read < ref.length) {
          const n = readSync(fd, buffer, read, ref.length - read, ref.offset + read)
          if (n <= 0) break
          read += n
        }
        let row: unknown
        try { row = JSON.parse(buffer.subarray(0, read).toString('utf8')) } catch { row = null }
        if (!isRow(row) || row.kind !== 'turn' || row.clientId !== ref.clientId) throw new CosThreadError('cos_thread_history_stale', 503)
        return row
      })
    } finally { closeSync(fd) }
  }

  private chatEntry(row: TurnRow): CosThreadChatEntry {
    const base = { id: `t:${row.clientId}`, at: row.at, kind: 'chat' as const, question: row.query, threadId: row.threadId, messageNo: row.messageNo }
    const ended = this.answers.get(row.clientId)
    if (row.job || ended) {
      // Recorded from a job (7.0.39 candidate 2): its end decides the status and the answer.
      const job = { clientJobId: row.clientId, generation: ended?.generation ?? row.job?.generation ?? 1 }
      if (!ended) {
        const stale = this.now() - Date.parse(row.at) > RUNNING_STALE_MS
        return { ...base, answer: '', answerChars: null, full: false, status: stale ? 'interrupted' : 'running', ...job }
      }
      const whole = ended.status === 'completed' && ended.answerChars === ended.answerHead.length
      return { ...base, answer: ended.answerHead, answerChars: ended.answerChars, full: whole, status: ended.status, ...job }
    }
    // The ledger keeps the first ANSWER_HEAD_CHARS of the answer. Shorter than that, it is the whole answer; at the cap
    // or empty (a turn recorded without its answer), the whole one has to be looked up (entry()).
    const whole = row.answerHead.length > 0 && row.answerHead.length < ANSWER_HEAD_CHARS
    return { ...base, answer: row.answerHead, answerChars: whole ? row.answerHead.length : null, full: whole, status: 'completed' }
  }

  /** The whole answer the thread store itself holds for a chat (a completed cosThread job), when it has one. */
  storedAnswer(clientId: string): string | undefined {
    const ended = this.answers.get(clientId)
    if (!ended || ended.status !== 'completed') return undefined
    if (!ended.ref) return ended.answerChars === ended.answerHead.length ? ended.answerHead : undefined
    return this.readAnswer(ended.ref, clientId)
  }

  /** The number of chats in the whole history (every thread). */
  historySize(): number { return this.history.length }

  /**
   * A page of the whole history, oldest to newest within the page. No cursor: the newest page. `before`: the page
   * ending just before that place. `after`: what was added from that place on. Capped at `limit` entries and at
   * HISTORY_MAX_BYTES of entries (always at least one entry when any is due). A place past the end reads as the end.
   */
  historyPage(query: CosThreadHistoryQuery): CosThreadHistoryPage {
    const n = this.history.length
    const limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(query.limit)))
    const size = (e: CosThreadChatEntry) => Buffer.byteLength(JSON.stringify(e))
    const cap = query.maxBytes ?? HISTORY_MAX_BYTES
    if (query.after !== undefined) {
      const from = Math.min(Math.max(0, query.after), n)
      const end = Math.min(n, from + limit)
      const rows = this.readTurns(range(from, end))
      const entries: CosThreadChatEntry[] = []
      let bytes = 0
      for (const row of rows) {
        const e = this.chatEntry(row)
        const b = size(e)
        if (entries.length && bytes + b > cap) break
        entries.push(e); bytes += b
      }
      const stop = from + entries.length
      // Chats already sent (before `from`) whose job ended since the cursor was given: the page replaces them by id.
      const updated: CosThreadChatEntry[] = []
      if (query.afterAnswers !== undefined) {
        const changed = [...this.answers.entries()]
          .filter(([clientId, a]) => a.seq > query.afterAnswers! && (this.historyByClient.get(clientId) ?? Infinity) < from)
          .sort((a, b) => a[1].seq - b[1].seq)
          .map(([clientId]) => this.historyByClient.get(clientId)!)
        for (const row of this.readTurns(changed)) {
          const e = this.chatEntry(row)
          const b = size(e)
          if (entries.length + updated.length && bytes + b > cap) break
          updated.push(e); bytes += b
        }
      }
      return { protocol: 1, entries, older: from > 0 ? cursorOf(from) : null, newest: cursorOf(stop, this.answerSeq), more: stop < n, updated }
    }
    const end = Math.min(Math.max(0, query.before ?? n), n)
    const start = Math.max(0, end - limit)
    const rows = this.readTurns(range(start, end))
    const kept: CosThreadChatEntry[] = []
    let bytes = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = this.chatEntry(rows[i]!)
      const b = size(e)
      if (kept.length && bytes + b > cap) break
      kept.push(e); bytes += b
    }
    kept.reverse()
    const first = end - kept.length
    return { protocol: 1, entries: kept, older: first > 0 ? cursorOf(first) : null, newest: cursorOf(end, this.answerSeq), more: end < n, updated: [] }
  }

  /** One chat by its clientId, with what a full-answer lookup needs. Null when the history has no such chat. */
  entry(clientId: string): { entry: CosThreadChatEntry; lookup: CosThreadEntryLookup } | null {
    const index = this.historyByClient.get(clientId)
    if (index === undefined) return null
    const row = this.readTurns([index])[0]!
    return {
      entry: this.chatEntry(row),
      lookup: { sessionId: row.sessionId, clientId: row.clientId, messageNo: row.messageNo, at: row.at, query: row.query },
    }
  }

  /** The whole answer from the live conversation, when it still holds it (the store's own answerFor). */
  liveAnswer(lookup: CosThreadEntryLookup): string | undefined {
    try { return this.deps.answerFor?.(lookup.sessionId, lookup.clientId, lookup.messageNo) } catch { return undefined }
  }

  search(q: string, limit: number): CosThreadSearchAnswer {
    const needle = q.toLowerCase()
    const hits: CosThreadSearchHit[] = []
    let scanned = 0
    for (let i = this.turns.length - 1; i >= 0 && hits.length < limit; i--) {
      const t = this.turns[i]!
      scanned += 1
      // 7.0.39: a cosThread chat's answer is on its answer row, not its turn row.
      const answerHead = t.answerHead || this.answers.get(t.clientId)?.answerHead || ''
      if (t.query.toLowerCase().includes(needle) || answerHead.toLowerCase().includes(needle)) {
        hits.push({ threadId: t.threadId, sessionId: t.sessionId, at: t.at, query: t.query, answerHead, messageNo: t.messageNo })
      }
    }
    return { hits, scanned }
  }

  /** Newest first. A thread with no asks is listed only while it is the current one. */
  list(limit: number): { threads: CosThreadSummary[] } {
    const out: CosThreadSummary[] = []
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.threads.get(this.order[i]!)
      if (!s || (s.asks === 0 && s.id !== this.current.id)) continue
      out.push({ ...s })
    }
    return { threads: out }
  }
}

/**
 * Whether a job end replaces the one already recorded for a chat. A later generation (a Retry) always does; an earlier
 * one never does. The SAME generation does when its status or length differs: a boot ends a job caught mid-start
 * `interrupted` and then resumes that generation to `completed` (canary (a), cos-thread-never-lost.test.ts). An identical
 * end (the boot's re-projection of a job already recorded) is skipped, so re-projection is idempotent.
 */
function supersededBy(prior: { generation: number; status: CosThreadChatStatus; answerChars: number }, next: { generation: number; status: CosThreadChatStatus; answerChars: number }): boolean {
  if (next.generation !== prior.generation) return next.generation > prior.generation
  return next.status !== prior.status || next.answerChars !== prior.answerChars
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i < to; i++) out.push(i)
  return out
}
/** A history cursor: the place before the n-th chat, and (on `newest`, 7.0.39 candidate 2) how many job ends were
 * recorded then, so `after=` can return chats that ended since. Opaque to clients. */
export function cursorOf(place: number, answers?: number): string { return answers === undefined ? `c1.${place}` : `c1.${place}.${answers}` }
const CURSOR_RE = /^c1\.(\d{1,9})(?:\.(\d{1,9}))?$/
/** The place a cursor names, or null when it is not one of ours. */
export function parseCursor(raw: unknown): number | null { return parseCursorParts(raw)?.place ?? null }
/** Both parts; `answers` is absent on a cursor without one (an `older` cursor, or one from candidate 1). */
export function parseCursorParts(raw: unknown): { place: number; answers?: number } | null {
  if (typeof raw !== 'string') return null
  const m = CURSOR_RE.exec(raw)
  return m ? { place: Number(m[1]), ...(m[2] !== undefined ? { answers: Number(m[2]) } : {}) } : null
}

/**
 * The turn's own local day and the `lookahead` calendar days after it, in order. Stepped by calendar day (noon local),
 * never by 24 hours, so a daylight-saving change neither repeats a day nor skips one (Q1 2026-11-14).
 */
export function archiveDays(atMs: number, lookahead: number): string[] {
  const start = new Date(atMs)
  const out: string[] = []
  for (let d = 0; d <= lookahead; d++) out.push(localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, 12).getTime()))
  return out
}

/**
 * 7.0.39: a chat's whole answer from the day archive, for a turn the live conversation no longer holds. Read only: a
 * day file is parsed only when it is a plain file under ARCHIVE_FILE_MAX_BYTES, all of them together stay under
 * ARCHIVE_TOTAL_MAX_BYTES, and nothing is quarantined or created. A session is archived on the day it was last used,
 * so the days read run from the turn's own local day forward, ARCHIVE_LOOKAHEAD_DAYS at most and never past today.
 * The match is the session and the message number (or, for a turn without one, its question).
 */
export function archivedAnswer(
  archiveDir: string, lookup: CosThreadEntryLookup, now = Date.now(),
  limits: { fileMax?: number; totalMax?: number; lookaheadDays?: number } = {},
): string | undefined {
  const fileMax = limits.fileMax ?? ARCHIVE_FILE_MAX_BYTES
  const lookahead = limits.lookaheadDays ?? ARCHIVE_LOOKAHEAD_DAYS
  const atMs = Date.parse(lookup.at)
  if (!Number.isFinite(atMs)) return undefined
  const today = localDay(now)
  let budget = limits.totalMax ?? ARCHIVE_TOTAL_MAX_BYTES
  for (const date of archiveDays(atMs, lookahead)) {
    if (date > today) break
    const file = join(archiveDir, `${date}.json`)
    let size: number
    try {
      const stat = lstatSync(file)
      if (!stat.isFile()) continue
      size = stat.size
    } catch { continue }
    if (size > fileMax || size > budget) continue
    budget -= size
    let day: any
    try { day = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    const chats = Array.isArray(day?.chats) ? day.chats : []
    for (const chat of chats) {
      if (chat?.sessionId !== lookup.sessionId || !Array.isArray(chat.exchanges)) continue
      const ex = chat.exchanges as Array<{ role?: unknown; content?: unknown; globalMsgNum?: unknown }>
      for (let i = 0; i < ex.length; i++) {
        const user = ex[i]
        if (user?.role !== 'user') continue
        const next = ex[i + 1]
        if (next?.role !== 'assistant' || typeof next.content !== 'string') continue
        const hit = lookup.messageNo !== null
          ? user.globalMsgNum === lookup.messageNo || next.globalMsgNum === lookup.messageNo
          : user.content === lookup.query
        if (hit) return next.content
      }
    }
  }
  return undefined
}

function isRow(row: unknown): row is LedgerRow {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  if (typeof r.at !== 'string') return false
  if (r.kind === 'thread') return typeof r.id === 'string'
  if (r.kind === 'turn') return typeof r.threadId === 'string' && typeof r.sessionId === 'string' && typeof r.clientId === 'string'
    && typeof r.query === 'string' && typeof r.answerHead === 'string' && Number.isInteger(r.segment)
  if (r.kind === 'rollover' || r.kind === 'close') return typeof r.threadId === 'string'
  if (r.kind === 'answer') return typeof r.clientId === 'string' && Number.isSafeInteger(r.generation) && (r.generation as number) >= 1
    && typeof r.answerHead === 'string' && Number.isSafeInteger(r.answerChars)
    && (r.status === 'completed' || r.status === 'failed' || r.status === 'interrupted')
  return false
}

/** Opens the store once, on the first request that needs it (Drop it on). Null while it cannot open. 7.0.39: the opener
 * is also what the job runtime records thread jobs through (cosThreadStore), so there is one store per process. */
export function lazyCosThread(open: () => CosThread): () => CosThread | null {
  let thread: CosThread | null = null
  const get = () => {
    if (thread) return thread
    try { thread = open() } catch (e) {
      console.error('[cos-thread] store unavailable:', e instanceof CosThreadError ? e.code : e instanceof Error ? e.name : 'error')
      return null
    }
    return thread
  }
  registeredStore = get
  return get
}
let registeredStore: (() => CosThread | null) | null = null
/** The process's thread store for the job runtime (7.0.39): the one lazyCosThread opened, or null when none is set up. */
export function cosThreadStore(): CosThread | null { return registeredStore?.() ?? null }
/** Tests only. */
export function __resetCosThreadStoreForTests(): void { registeredStore = null }
