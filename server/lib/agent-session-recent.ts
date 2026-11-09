/**
 * "Recent activity first" for the Today summary (Miles, 2026-11-09): what was said INTO a session lately and where its
 * latest reply left off, with when, so the summary describes what a session is doing now instead of its first prompt.
 *
 * Why: each session's list `line` (composeDiscussionSummary) is its FIRST prompt plus the latest reply, cut at 180
 * characters. On 11/09 the Codex orchestrator's line led with an ask from 10/11, 29 days old, and the model wrote
 * "following up a transcription bakeoff" about a session that had just confirmed a release was live.
 *
 * readRecentActivity(provider, file, now) answers the last few asks (each with when and how it arrived), the latest
 * reply and when the session last moved. Read-only display evidence: never imported by an attach, queue or write gate.
 *
 * - Claude: the last 8 MB of the transcript, memoized on mtime and size like readClaudeSubagents. User turns follow
 *   parseAgentSession's rules: sidechains, `isMeta` and `isCompactSummary` rows are not asks (a peer row is, unwrapped
 *   by unwrapPeerMessage), the verify footer comes off (withoutTurnFooter), wrapper tags go (STRIPPABLE_TAG_RE) and a
 *   pasted JSON block becomes "[pasted data]". A peer row, or a row that carried a COS verify footer, arrived from
 *   another screen or session: `via: 'peer'`, never attributed to the person. A peer row that is agent-to-agent
 *   protocol (a cross-session or agent-message envelope) is not an ask at all.
 * - Codex: rollouts reach 32 GB with single lines of 44 MB (measured 11/09). An incremental forward scan keeps its byte
 *   offset in memory; the first pass reads at most the last 256 MB; a line over 1 MB is skipped without being decoded
 *   or parsed; reads are async, 4 MB at a time, and the scan yields between chunks. One scan per file at a time: a
 *   second caller waits on the first, and a scan the Today route stopped waiting for still finishes and fills the memo.
 *   Codex rows carry no sender marker, so only a COS verify footer marks one as sent in from another screen.
 * - Cursor: the existing tail peek (the last user query and reply); its transcript has no timestamps, so every time is
 *   the file's mtime.
 *
 * `startedAt` and `firstAsk` are set only for a session whose file was created within the last day, for the
 * "started today as" note. Opens refuse symlinks and non-regular files. Never throws: null when unreadable.
 */
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import {
  STRIPPABLE_TAG_RE, createdFromCodexFilename, firstClaudeUserTitle, firstCursorUserTitle, isWrapperPrompt, parseJsonLine,
  payloadText, codexUserText, peekCodexMeta, peekCursorDiscussion, proseSnippet, type AgentProvider,
} from './agent-session-store.js'
import { unwrapPeerMessage } from './session-stream-events.js'
import { stripG2TurnFooter } from './turn-footer.js'

export type RecentVia = 'typed' | 'peer'
export interface RecentAsk { at: number; text: string; via: RecentVia }
export interface RecentReply { at: number; text: string }
export interface RecentActivity {
  /** The newest asks into the session, oldest first, at most RECENT_ASKS_KEPT. */
  asks: RecentAsk[]
  /** The newest assistant reply (Codex: its newest final answer, not commentary). */
  reply: RecentReply | null
  /** The newest record's time (ms), 0 when none was seen. */
  movedAt: number
  /** Only for a session created within the last day: when, and its first ask. */
  startedAt?: number
  firstAsk?: string
}

export const RECENT_ASKS_KEPT = 3
export const CLAUDE_RECENT_TAIL_BYTES = 8 * 1024 * 1024
export const CODEX_FIRST_PASS_BYTES = 256 * 1024 * 1024
/** A line longer than this is skipped unparsed (a 44 MB Codex line holds tool output, never an ask). */
export const RECENT_LINE_MAX_BYTES = 1024 * 1024
export const RECENT_CHUNK_BYTES = 4 * 1024 * 1024
const TEXT_KEEP = 1000
const MEMO_MAX = 64
const DAY_MS = 24 * 60 * 60 * 1000

// ── text ───────────────────────────────────────────────────────────────────

const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/gi
const WRAPPER_BLOCKS = /<(task-notification|system-reminder|relevant-memories|cache-health|daily-bulletin|cos-alarms|device-handoff|now|memory-stored|local-command-stdout|local-command-stderr|command-name|command-message|command-args|user_query)\b[^>]*>[\s\S]*?<\/\1>/gi
/** A peer row that is agent-to-agent protocol, not words for the session. */
const AGENT_ENVELOPE = /^\s*(?:<(?:cross-session-message|agent-message)\b|Message Type:|Subagent hand-?back\b)/i
/** A paragraph that is pasted data: it opens with { or [ and holds a "key": pair. */
const JSON_PARAGRAPH = /^\s*[[{][\s\S]*"\s*:/

/** One ask's words: pasted data replaced, wrapper blocks and tags out, one line, bounded. '' when nothing is left. */
export function cleanAskText(raw: string): string {
  // Whole wrapper blocks go first (a background task's notification, a reminder, a slash command's parts). What is left
  // is then judged as parseAgentSession's collectTurn judges a turn: still a wrapper (it opens with a tag the block list
  // does not know), it is not an ask, and no tag is taken off so that its insides could read as words.
  let s = raw.replace(WRAPPER_BLOCKS, ' ').replace(PASTED, (_m, inner: string) => {
    const t = String(inner).trim()
    return t.startsWith('{') || t.startsWith('[') ? '\n\n[pasted data]\n\n' : ` ${t} `
  })
  if (!s.trim() || isWrapperPrompt(s)) return ''
  s = s.split(/\n\s*\n/).map(p => (JSON_PARAGRAPH.test(p) ? '[pasted data]' : p)).join('\n\n')
  s = s.replace(STRIPPABLE_TAG_RE, ' ').replace(/\s+/g, ' ').trim()
  if (!s || isWrapperPrompt(s) || s.startsWith('[Request interrupted') || s.startsWith('[image: source')) return ''
  return s.slice(0, TEXT_KEEP)
}

/** An ask's words and how it arrived: a footer means another screen (glasses, phone or web) sent it. */
function footerVia(text: string, peer: boolean): { text: string; via: RecentVia } {
  const f = stripG2TurnFooter(text)
  return { text: f.text, via: peer || f.turnId ? 'peer' : 'typed' }
}

const tsOf = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) || 0 : 0)

interface Collector { asks: RecentAsk[]; reply: RecentReply | null; movedAt: number }
const emptyCollector = (): Collector => ({ asks: [], reply: null, movedAt: 0 })
function addAsk(c: Collector, ask: RecentAsk) {
  c.asks.push(ask)
  if (c.asks.length > RECENT_ASKS_KEPT) c.asks.shift()
}
const moved = (c: Collector, at: number) => { if (at > c.movedAt) c.movedAt = at }

/** One Claude record into the collector (parseAgentSession's user-turn rules). */
export function collectClaudeRecord(c: Collector, obj: Record<string, unknown>): void {
  if (obj.isSidechain === true) return
  const at = tsOf(obj.timestamp)
  if (at && (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system')) moved(c, at)
  if (obj.type !== 'user' && obj.type !== 'assistant') return
  if (obj.type === 'user' && obj.toolUseResult) return
  const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
  const text = message ? payloadText(message) : null
  if (!text) return
  if (obj.type === 'assistant') {
    const prose = proseSnippet(text, TEXT_KEEP)
    if (prose) c.reply = { at, text: prose }
    return
  }
  const isPeer = (obj.origin as { kind?: unknown } | undefined)?.kind === 'peer'
  const peerWords = isPeer ? unwrapPeerMessage(text) : null
  // Injected rows (a slash-command body, a compaction preamble) are not asks; a peer row is, once unwrapped.
  if (peerWords === null && (obj.isMeta === true || obj.isCompactSummary === true)) return
  if (peerWords !== null && AGENT_ENVELOPE.test(peerWords)) return
  const { text: words, via } = footerVia(peerWords ?? text, peerWords !== null)
  const clean = cleanAskText(words)
  if (clean) addAsk(c, { at, text: clean, via })
}

/** One Codex rollout line into the collector. The caller has already checked its size. */
export function collectCodexLine(c: Collector, line: Buffer): void {
  const head = line.subarray(0, 512).toString('utf8')
  const stamp = /"timestamp":"([^"]{10,40})"/.exec(head)
  const at = stamp ? Date.parse(stamp[1]!) || 0 : 0
  if (at) moved(c, at)
  // Role and type sit before the content in a rollout line, so the head decides without decoding the rest.
  if (!head.includes('"type":"message"') || !(head.includes('"role":"user"') || head.includes('"role":"assistant"'))) return
  const obj = parseJsonLine(line.toString('utf8'))
  if (!obj || obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') return
  const p = obj.payload as Record<string, unknown>
  if (p.type !== 'message') return
  if (p.role === 'assistant') {
    if (p.phase === 'commentary') return
    const text = payloadText(p)
    const prose = text ? proseSnippet(text, TEXT_KEEP) : ''
    if (prose) c.reply = { at, text: prose }
    return
  }
  if (p.role !== 'user') return
  const text = codexUserText(p)
  if (!text || isWrapperPrompt(text)) return
  const { text: words, via } = footerVia(text, false)
  const clean = cleanAskText(words)
  if (clean) addAsk(c, { at, text: clean, via })
}

// ── reads ──────────────────────────────────────────────────────────────────

type Handle = Awaited<ReturnType<typeof open>>
async function openRegular(file: string): Promise<{ handle: Handle; size: number; mtimeMs: number; birthtimeMs: number; ino: number } | null> {
  let handle: Handle | null = null
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const st = await handle.stat()
    if (!st.isFile()) { await handle.close().catch(() => {}); return null }
    return { handle, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, ino: st.ino }
  } catch {
    await handle?.close().catch(() => {})
    return null
  }
}
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve))

const claudeMemo = new Map<string, { mtimeMs: number; size: number; value: Collector }>()
const remember = <V>(memo: Map<string, V>, key: string, value: V) => {
  if (!memo.has(key) && memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!)
  memo.set(key, value)
}

/** A Claude transcript's tail (8 MB), memoized on mtime and size. */
async function readClaude(file: string, tailBytes = CLAUDE_RECENT_TAIL_BYTES): Promise<{ c: Collector; birthtimeMs: number } | null> {
  const opened = await openRegular(file)
  if (!opened) return null
  const { handle, size, mtimeMs, birthtimeMs } = opened
  try {
    const hit = claudeMemo.get(file)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return { c: hit.value, birthtimeMs }
    const length = Math.min(size, tailBytes), start = size - length
    const buffer = Buffer.alloc(length)
    const read = await handle.read(buffer, 0, length, start)
    const data = buffer.subarray(0, read.bytesRead)
    const c = emptyCollector()
    let pos = 0, n = 0
    // A tail that starts mid-file has a cut first line: it fails to parse and is skipped like any bad line.
    while (pos < data.length) {
      let end = data.indexOf(0x0a, pos)
      if (end < 0) end = data.length
      if (end - pos > 0 && end - pos <= RECENT_LINE_MAX_BYTES) {
        const obj = parseJsonLine(data.subarray(pos, end).toString('utf8'))
        if (obj) collectClaudeRecord(c, obj)
      }
      pos = end + 1
      if (++n % 2000 === 0) await yieldLoop()
    }
    remember(claudeMemo, file, { mtimeMs, size, value: c })
    return { c, birthtimeMs }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

interface CodexScan { offset: number; size: number; partial: Buffer | null; skipping: boolean; c: Collector; running: Promise<void> | null; ino: number }
const codexMemo = new Map<string, CodexScan>()

/** Test seam: forget every memo (a new server process starts with none). */
export function resetRecentActivityMemo(): void { claudeMemo.clear(); codexMemo.clear() }
/** Test seam: the bytes of an unfinished line a Codex scan holds for its next read (never more than the line bound). */
export function codexScanHeldBytes(file: string): number { return codexMemo.get(file)?.partial?.length ?? 0 }

/**
 * Scan a Codex rollout forward from where the last scan stopped. A first pass, or a gap past `firstPassBytes`, starts
 * that far from the end and drops the line it lands inside.
 */
async function scanCodex(file: string, firstPassBytes: number, chunkBytes: number): Promise<CodexScan | null> {
  const opened = await openRegular(file)
  if (!opened) return null
  const { handle, size, ino } = opened
  try {
    let scan = codexMemo.get(file)
    if (scan && (scan.ino !== ino || size < scan.offset)) scan = undefined   // replaced or truncated: start over
    if (!scan) {
      scan = { offset: 0, size: 0, partial: null, skipping: false, c: emptyCollector(), running: null, ino }
      remember(codexMemo, file, scan)
    }
    if (scan.running) { await scan.running; return scan }
    const s = scan
    const run = (async () => {
      if (size - s.offset > firstPassBytes) {
        s.offset = size - firstPassBytes
        s.partial = null
        s.skipping = s.offset > 0   // landed mid-line: that line is not whole
      }
      while (s.offset < size) {
        const length = Math.min(chunkBytes, size - s.offset)
        const chunk = Buffer.alloc(length)
        const { bytesRead } = await handle.read(chunk, 0, length, s.offset)
        if (bytesRead <= 0) break
        s.offset += bytesRead
        let buf = chunk.subarray(0, bytesRead)
        if (s.partial) { buf = Buffer.concat([s.partial, buf]); s.partial = null }
        let pos = 0
        for (let nl = buf.indexOf(0x0a, pos); nl >= 0; nl = buf.indexOf(0x0a, pos)) {
          if (s.skipping) s.skipping = false
          else if (nl - pos > 0 && nl - pos <= RECENT_LINE_MAX_BYTES) collectCodexLine(s.c, buf.subarray(pos, nl))
          pos = nl + 1
        }
        const rest = buf.subarray(pos)
        // An unfinished line past the bound is never kept: the rest of it is skipped up to its newline. While skipping
        // (no newline in this chunk at all), nothing is kept either.
        if (!s.skipping) {
          if (rest.length > RECENT_LINE_MAX_BYTES) s.skipping = true
          else if (rest.length) s.partial = Buffer.from(rest)
        }
        await yieldLoop()
      }
      s.size = size
    })()
    s.running = run
    try { await run } finally { s.running = null }
    return s
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

export interface RecentReadOptions { claudeTailBytes?: number; codexFirstPassBytes?: number; chunkBytes?: number }

/** What was said into one session lately, its latest reply and when it last moved, or null when it cannot be read. */
export async function readRecentActivity(provider: AgentProvider, file: string, now = Date.now(), opts: RecentReadOptions = {}): Promise<RecentActivity | null> {
  try {
    let c: Collector, createdAt = 0, firstAsk = ''
    if (provider === 'claude') {
      const r = await readClaude(file, opts.claudeTailBytes)
      if (!r) return null
      c = r.c
      createdAt = r.birthtimeMs
      if (createdAt && now - createdAt < DAY_MS) firstAsk = (await firstClaudeUserTitle(file)) ?? ''
    } else if (provider === 'codex') {
      const s = await scanCodex(file, opts.codexFirstPassBytes ?? CODEX_FIRST_PASS_BYTES, opts.chunkBytes ?? RECENT_CHUNK_BYTES)
      if (!s) return null
      c = s.c
      createdAt = Date.parse(createdFromCodexFilename(file.split('/').pop() ?? '') ?? '') || 0
      if (createdAt && now - createdAt < DAY_MS) firstAsk = (await peekCodexMeta(file))?.title ?? ''
    } else {
      const st = await stat(file).catch(() => null)
      if (!st?.isFile()) return null
      const peek = await peekCursorDiscussion(file)
      const at = st.mtimeMs
      c = { asks: [], reply: null, movedAt: at }
      const ask = peek.lastUser ? cleanAskText(peek.lastUser) : ''
      if (ask) c.asks.push({ at, text: ask, via: 'typed' })
      const reply = peek.latestAssistant ? proseSnippet(peek.latestAssistant, TEXT_KEEP) : ''
      if (reply) c.reply = { at, text: reply }
      createdAt = st.birthtimeMs
      if (createdAt && now - createdAt < DAY_MS) firstAsk = (await firstCursorUserTitle(file)) ?? ''
    }
    // Copies, so a caller can never edit the memo.
    const out: RecentActivity = {
      asks: c.asks.filter(a => a.at <= now).map(a => ({ ...a })),
      reply: c.reply && c.reply.at <= now ? { ...c.reply } : null,
      movedAt: c.movedAt,
    }
    if (firstAsk && createdAt) { out.startedAt = createdAt; out.firstAsk = firstAsk }
    return out
  } catch {
    return null
  }
}
