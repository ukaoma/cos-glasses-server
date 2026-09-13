// When a Claude or Codex session last DID something, and the last tool it called.
//
// 6.45.5. Miles, 2026-09-13, on the phone's Sessions list: the status and the order should
// be "reflective". They were not, because both came from the transcript FILE's write time.
// A Claude Desktop relaunch appends bookkeeping records (`queue-operation` and friends) to
// every open transcript, so 18 of 60 rows shared one relaunch timestamp and sorted as the
// newest work on the Mac while their last real turn was days old.
//
// The answer is in the records themselves: Claude writes a `timestamp` on every user and
// assistant record, and Codex on every `response_item`. The newest record is at the end,
// so the reader starts from the tail and widens only when the tail holds no conversation
// record. Records can be very large: measured on this Mac over seven days, the biggest
// single records were 1.7 MB (Claude) and 11.9 MB (Codex). Reads are memoized on the
// file's mtime and size, so a steady list poll re-reads nothing that did not change.
//
// Cursor agent transcripts carry no per-record clock, so they answer null and the client
// keeps using the file time, exactly as before.

import { open, stat } from 'node:fs/promises'
import { AGENT_SESSION_LIST_MAX, type AgentProvider } from './agent-session-store.js'

/** First window read from the end of a transcript. */
export const ACTIVITY_TAIL_BYTES = 256 * 1024
/** Largest window the reader widens to (x4 each step) when the tail holds no conversation record. */
export const ACTIVITY_TAIL_MAX_BYTES = 16 * 1024 * 1024
/** Memo entries kept, least recently used evicted first: several full lists' worth. */
export const ACTIVITY_MEMO_MAX = AGENT_SESSION_LIST_MAX * 6
/** Transcripts read at once on a cold list, so 80 rows never hold 80 descriptors. */
export const ACTIVITY_READ_CONCURRENCY = 8

export interface SessionActivity {
  /** ISO time of the newest user or assistant record (Claude) or response item (Codex). */
  lastActivityAt: string | null
  /** Name of the most recent tool call in the latest turn. */
  lastTool: string | null
}

const NONE: SessionActivity = Object.freeze({ lastActivityAt: null, lastTool: null })
const memo = new Map<string, { mtimeMs: number; size: number; value: SessionActivity }>()
let fileReads = 0

const CODEX_TOOL_KINDS: Record<string, (payload: Record<string, unknown>) => string | null> = {
  function_call: payload => (typeof payload.name === 'string' && payload.name ? payload.name : null),
  custom_tool_call: payload => (typeof payload.name === 'string' && payload.name ? payload.name : null),
  local_shell_call: () => 'local_shell',
  web_search_call: () => 'web_search',
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function claudeToolName(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; name?: unknown } | null
    if (block && block.type === 'tool_use' && typeof block.name === 'string' && block.name) return block.name
  }
  return null
}

/** A user record that starts a turn, as opposed to one that returns a tool result. */
function claudeTurnStart(obj: Record<string, unknown>): boolean {
  if (obj.type !== 'user' || obj.toolUseResult) return false
  const content = (obj.message as { content?: unknown } | undefined)?.content
  return !(Array.isArray(content) && content.some(block => (block as { type?: unknown } | null)?.type === 'tool_result'))
}

/**
 * Scan transcript text from the end. `startsMidFile` drops the first line, which a tail
 * read almost always cuts in half.
 *
 * The last tool is looked for only inside the latest turn: once the scan passes the user
 * message that started it, an older tool would describe work that is already over.
 */
export function activityFromTail(provider: AgentProvider, text: string, startsMidFile: boolean): SessionActivity {
  if (provider === 'cursor') return NONE
  const lines = text.split('\n')
  if (startsMidFile) lines.shift()
  let lastActivityAt: string | null = null
  let lastTool: string | null = null
  let turnOpen = true
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastActivityAt !== null && (lastTool !== null || !turnOpen)) break
    const line = lines[i].trim()
    if (!line) continue
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (provider === 'claude') {
      // Only conversation records count. Bookkeeping (`queue-operation`, `summary`,
      // `custom-title`, `mode`...) is exactly what a relaunch writes.
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      if (lastActivityAt === null) lastActivityAt = isoOrNull(obj.timestamp)
      if (turnOpen && lastTool === null && obj.type === 'assistant') lastTool = claudeToolName(obj.message)
      if (claudeTurnStart(obj)) turnOpen = false
    } else {
      if (obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') continue
      const payload = obj.payload as Record<string, unknown>
      if (lastActivityAt === null) lastActivityAt = isoOrNull(obj.timestamp)
      const toolName = CODEX_TOOL_KINDS[String(payload.type ?? '')]
      if (turnOpen && lastTool === null && toolName) lastTool = toolName(payload)
      if (payload.type === 'message' && payload.role === 'user') turnOpen = false
    }
  }
  return { lastActivityAt, lastTool }
}

/**
 * Read one transcript's activity, memoized on mtime and size. Starts with the last
 * ACTIVITY_TAIL_BYTES and widens x4 up to ACTIVITY_TAIL_MAX_BYTES only while no
 * conversation record has been found. Any failure answers null fields.
 */
export async function readSessionActivity(
  provider: AgentProvider,
  file: string,
  opts: { memoMax?: number } = {},
): Promise<SessionActivity> {
  if (provider === 'cursor' || !file) return NONE
  try {
    const st = await stat(file)
    const hit = memo.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      memo.delete(file)
      memo.set(file, hit)
      return hit.value
    }
    let value: SessionActivity = NONE
    const handle = await open(file, 'r')
    fileReads += 1
    try {
      for (let window = ACTIVITY_TAIL_BYTES; ; window *= 4) {
        const length = Math.min(st.size, window)
        const start = st.size - length
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        value = activityFromTail(provider, buffer.subarray(0, bytesRead).toString('utf8'), start > 0)
        if (value.lastActivityAt !== null || start === 0 || window >= ACTIVITY_TAIL_MAX_BYTES) break
      }
    } finally {
      await handle.close()
    }
    const max = Math.max(1, opts.memoMax ?? ACTIVITY_MEMO_MAX)
    memo.delete(file)
    while (memo.size >= max) {
      const oldest = memo.keys().next().value
      if (oldest === undefined) break
      memo.delete(oldest)
    }
    memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
    return value
  } catch {
    return NONE
  }
}

/**
 * The clock "working now" is judged by: the last real record when it is known and older
 * than the file write, else the write time. A relaunch's bookkeeping write moves the file
 * time with nobody working, and used to read as 30 seconds of work on every held session.
 */
export function activityClockMs(mtimeMs: number, activity: SessionActivity | null | undefined): number {
  const at = activity?.lastActivityAt ? Date.parse(activity.lastActivityAt) : Number.NaN
  return Number.isFinite(at) && at < mtimeMs ? at : mtimeMs
}

/** Map with at most `limit` promises in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

/** Test seams. */
export function clearSessionActivityMemo(): void {
  memo.clear()
}
export function sessionActivityFileReads(): number {
  return fileReads
}
