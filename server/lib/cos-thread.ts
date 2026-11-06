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
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, writeSync, fsyncSync, fchmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
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
export const DIGEST_HEADER = 'Earlier in this COS thread (a summary carried over; ask COS to search History or Messages for more):'
const DAY_MS = 24 * 60 * 60_000

export type NextReason = 'continue' | 'empty' | 'size' | 'missing_session' | 'manual'
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
}
interface RolloverRow { kind: 'rollover'; threadId: string; at: string; reason: NextReason; fromSessionId: string | null; digest: string | null }
interface CloseRow { kind: 'close'; threadId: string; at: string; reason: string }
type LedgerRow = ThreadRow | TurnRow | RolloverRow | CloseRow

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
    for (const row of rows) this.apply(row)
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
  private readLedger(): LedgerRow[] {
    if (!existsSync(this.ledgerFile)) return []
    const stat = lstatSync(this.ledgerFile)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CosThreadError('cos_thread_unsafe', 503)
    const text = readFileSync(this.ledgerFile, 'utf8')
    // A torn last row (a crash mid-append) must not swallow the next one: end the file with a newline first.
    if (text.length && !text.endsWith('\n')) this.appendRaw('\n')
    const rows: LedgerRow[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as LedgerRow
        if (isRow(row)) rows.push(row)
      } catch { /* a torn row is skipped */ }
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
  private apply(row: LedgerRow): void {
    if (row.kind === 'thread') {
      this.threads.set(row.id, { id: row.id, startedAt: row.at, endedAt: null, asks: 0, segments: 0, title: '' })
      this.order.push(row.id)
      this.current = { id: row.id, startedAt: row.at, lastAskAt: null, asks: 0, segments: 0, sessionId: null, nativeSessionId: null, provider: null, from: row.from ?? null }
      return
    }
    if (row.kind === 'turn') {
      this.clientIds.add(row.clientId)
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
    }
  }

  private appendRaw(text: string): void {
    const fd = openSync(this.ledgerFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, text)
      fsyncSync(fd)
    } finally { closeSync(fd) }
  }
  /** Ledger first, then memory, then the snapshot: a crash between them leaves a ledger the next open rebuilds from. */
  private append(...rows: LedgerRow[]): void {
    this.appendRaw(rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    for (const row of rows) this.apply(row)
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
      answerHead: t.answerHead || this.safeAnswerFor(t) || '',
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

  view(): CosThreadAnswer {
    const { reason, tokens } = this.evaluate()
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
  recordTurn(input: CosThreadTurnInput): CosThreadAnswer {
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
    })
    this.append(...rows)
    return this.view()
  }

  search(q: string, limit: number): CosThreadSearchAnswer {
    const needle = q.toLowerCase()
    const hits: CosThreadSearchHit[] = []
    let scanned = 0
    for (let i = this.turns.length - 1; i >= 0 && hits.length < limit; i--) {
      const t = this.turns[i]!
      scanned += 1
      if (t.query.toLowerCase().includes(needle) || t.answerHead.toLowerCase().includes(needle)) {
        hits.push({ threadId: t.threadId, sessionId: t.sessionId, at: t.at, query: t.query, answerHead: t.answerHead, messageNo: t.messageNo })
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

function isRow(row: unknown): row is LedgerRow {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  if (typeof r.at !== 'string') return false
  if (r.kind === 'thread') return typeof r.id === 'string'
  if (r.kind === 'turn') return typeof r.threadId === 'string' && typeof r.sessionId === 'string' && typeof r.clientId === 'string'
    && typeof r.query === 'string' && typeof r.answerHead === 'string' && Number.isInteger(r.segment)
  if (r.kind === 'rollover' || r.kind === 'close') return typeof r.threadId === 'string'
  return false
}

/** Opens the store once, on the first request that needs it (Drop it on). Null while it cannot open. */
export function lazyCosThread(open: () => CosThread): () => CosThread | null {
  let thread: CosThread | null = null
  return () => {
    if (thread) return thread
    try { thread = open() } catch (e) {
      console.error('[cos-thread] store unavailable:', e instanceof CosThreadError ? e.code : e instanceof Error ? e.name : 'error')
      return null
    }
    return thread
  }
}
