// The recent conversation of a session, as the messages a person reads: who spoke and
// what they said, tool calls and sub-agents left out (6.50.0).
//
// WHY THIS EXISTS. Miles, 2026-09-16, on the G2: "if I come into a session that's been
// running, I can scroll up and see what was happening, what was the original prompt
// that led off to all of this activity." COS Control already shows exactly that ("last
// 120 of 338 turns · tools omitted"), but its helper reads the transcript file on the
// Mac itself. The lens cannot read the Mac's files; it gets the live stream (the current
// turn only) and the 2,000-character digest. This is the same history, served.
//
// WHY A READER OF ITS OWN, NOT THE DIGEST'S WINDOWS. `parseAgentSession` reads an
// oversized transcript as a 256 KiB head plus a 768 KiB tail, which is right for a
// digest and wrong for history: measured on the 42 MB session this was written in, the
// 768 KiB tail held TWO prompts (3 user rows, 6 assistant text rows), because tool
// results dominate the bytes. Twenty transcripts on this Mac are over 32 MB. So this
// reads backward from the end in growing windows until it has the messages it was asked
// for, or has covered the file, or reaches its cap.
//
// THE RULES MATCH THE DIGEST'S, from the same helpers: a sidechain (sub-agent) row is
// not the conversation; a tool result is not a message; an injected row (`isMeta`, a
// compaction summary) is not something anyone said, EXCEPT a peer-inbox row, which is a
// live Continue the user dictated (6.49.1) and is unwrapped to their words; wrapper
// prompts are dropped; the text is shaped by `latestAssistantReply`, the function the
// lens already renders replies through (lines kept, fences and harness tags out, 4,000
// characters with a visible ellipsis).

import { open, stat } from 'node:fs/promises'
import {
  latestAssistantReply,
  isWrapperPrompt,
  parseJsonLine,
  payloadText,
  type AgentProvider,
} from './agent-session-store.js'
import { unwrapPeerMessage } from './session-stream-events.js'

export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  /** The record's ISO timestamp, when the provider writes one (Cursor does not). */
  at?: string
}

/** What a client may ask for in one read. Forty messages is ~10 lens pages of words. */
export const SESSION_TURNS_MAX = 40

/**
 * The windows read backward from the end of the transcript, smallest first.
 *
 * MEASURED on the 42 MB session this was written in: 768 KiB held 2 prompts, 1.75 MiB
 * held 11, 4 MiB held 17 (20 user rows, 56 assistant text rows). So 2 MiB covers an
 * ordinary request for 20 messages in one read, and the larger windows exist for a
 * turn whose tool output is unusually heavy. 24 MiB is the ceiling: past it the answer
 * is what was found, marked as more-before, never a whole-file parse on a request path.
 */
export const SESSION_TURNS_WINDOWS: readonly number[] = [2 * 1024 * 1024, 8 * 1024 * 1024, 24 * 1024 * 1024]

function iso(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value)) ? value : undefined
}

/** A Cursor user row wraps the ask in `<user_query>`; the rest is scaffolding. */
function cursorQuery(text: string): string {
  const start = text.indexOf('<user_query>')
  const end = text.indexOf('</user_query>')
  return start >= 0 && end > start ? text.slice(start + '<user_query>'.length, end) : text
}

/**
 * User rows that no person typed (6.50.1, QA on 6.50.0): Claude's interrupt marker
 * ("[Request interrupted by user]", 7 in one session) and the AGENTS.md block Codex
 * writes as a user message (a 4,000-character "# AGENTS.md instructions for …" row in
 * 3 of the last 60 rollouts). Each read as "YOU" on the lens.
 */
const NOT_TYPED_BY_THE_USER = /^\s*(?:\[Request interrupted by user|# AGENTS\.md instructions\b)/

function shaped(role: SessionTurn['role'], raw: string, at: string | undefined): SessionTurn | null {
  if (isWrapperPrompt(raw)) return null
  if (role === 'user' && NOT_TYPED_BY_THE_USER.test(raw)) return null
  const text = latestAssistantReply(raw)
  if (!text) return null
  return at ? { role, text, at } : { role, text }
}

/**
 * One transcript record as a message a person reads, or null.
 *
 * Pure. The per-provider shapes are the ones `parseAgentSession` reads.
 */
export function sessionTurnFromRecord(provider: AgentProvider, obj: Record<string, unknown>): SessionTurn | null {
  if (provider === 'claude') {
    if (obj.isSidechain === true) return null
    if (obj.type !== 'user' && obj.type !== 'assistant') return null
    if (obj.type === 'user' && obj.toolUseResult) return null
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const text = message ? payloadText(message) : null
    if (!text) return null
    const at = iso(obj.timestamp)
    if (obj.type === 'assistant') return shaped('assistant', text, at)
    // A peer-inbox message. Only a live Continue (`origin.kind: 'peer'`, 6.49.x) is the
    // user's own words; every other message in that frame is another agent talking
    // (a teammate's report, an idle notification, another session's SendMessage),
    // written as a plain user row with no origin. QA found 20 of those in one session
    // rendering as "YOU".
    const peer = unwrapPeerMessage(text)
    if (peer !== null) return (obj.origin as { kind?: unknown } | undefined)?.kind === 'peer' ? shaped('user', peer, at) : null
    if (obj.isMeta === true || obj.isCompactSummary === true) return null
    return shaped('user', text, at)
  }
  if (provider === 'codex') {
    if (obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') return null
    const payload = obj.payload as Record<string, unknown>
    if (String(payload.type ?? '') !== 'message') return null
    if (payload.role !== 'user' && payload.role !== 'assistant') return null
    const text = payloadText(payload)
    if (!text) return null
    return shaped(payload.role, text, iso(obj.timestamp))
  }
  if (obj.role !== 'user' && obj.role !== 'assistant') return null
  const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
  const text = message ? payloadText(message) : null
  if (!text) return null
  return shaped(obj.role, obj.role === 'user' ? cursorQuery(text) : text, iso(obj.timestamp))
}

/** The newest `limit` messages among these lines (file order in, file order out). */
export function recentSessionTurns(provider: AgentProvider, lines: readonly string[], limit: number): SessionTurn[] {
  const out: SessionTurn[] = []
  for (const line of lines) {
    const obj = parseJsonLine(line)
    if (!obj) continue
    const turn = sessionTurnFromRecord(provider, obj)
    if (turn) out.push(turn)
  }
  return limit > 0 ? out.slice(-limit) : []
}

export interface RecentTurnsRead {
  turns: SessionTurn[]
  /** True when the transcript holds messages before the first one returned. */
  more: boolean
  /** Bytes of the transcript this read covered (tests assert the window growth by it). */
  bytesRead: number
}

/**
 * The newest `limit` messages of a transcript, read backward in growing windows.
 * Never parses more than the last window's bytes.
 */
export async function readRecentSessionTurns(
  provider: AgentProvider,
  path: string,
  limit: number,
  windows: readonly number[] = SESSION_TURNS_WINDOWS,
): Promise<RecentTurnsRead> {
  const want = Math.max(0, Math.min(SESSION_TURNS_MAX, Math.floor(limit)))
  const { size } = await stat(path)
  if (want === 0 || size === 0) return { turns: [], more: false, bytesRead: 0 }
  const handle = await open(path, 'r')
  try {
    let found: SessionTurn[] = []
    let start = size
    for (const window of windows) {
      start = Math.max(0, size - window)
      // One byte BEFORE the window as well, so the first line is known to be whole or
      // not: after a newline it splits off as '' and the record starting AT the window
      // is kept; otherwise it is the tail of a record that began earlier and is
      // dropped. Dropping the first line unconditionally lost a whole record whenever a
      // window began exactly on a line start (found by its own test).
      const from = start > 0 ? start - 1 : 0
      const length = size - from
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, from)
      const lines = buffer.toString('utf-8').split('\n')
      if (start > 0) lines.shift()
      // One more than wanted, so `more` can be answered from what was read.
      found = recentSessionTurns(provider, lines, want + 1)
      if (found.length > want || start === 0) break
    }
    const more = found.length > want || start > 0
    return { turns: found.slice(-want), more, bytesRead: size - start }
  } finally {
    await handle.close()
  }
}

/** `?turns=N`: an integer, clamped to 1..SESSION_TURNS_MAX; null when absent, zero or
 *  malformed. Clamped rather than refused above the max, so a client asking for more
 *  than this server serves gets the most it can have instead of looking like an older
 *  server with no history at all. */
export function parseTurnsParam(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null
  const n = Number(value)
  return n >= 1 ? Math.min(n, SESSION_TURNS_MAX) : null
}
