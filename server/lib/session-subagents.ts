/**
 * 6.99.26 candidate: who a session has working for it, for the Today summary (lib/today-brief.ts). Read-only display
 * evidence: never imported by an attach, queue or write gate.
 *
 * Claude Code: nothing on the server read sub-agent NAMES before this (the hooks give counts only:
 * session-work-observation.ts). This reads the session's own transcript TAIL (the last 768 KB) and follows each Agent
 * or Task tool call:
 * - the call gives the name (`name`, else `subagent_type`) and the one-line task (`description`);
 * - its tool result says how it started: `async_launched` and `teammate_spawned` are running, any other result is a
 *   finished foreground agent, an error result is failed;
 * - a `<task-notification>` naming the call's tool-use id ends a background agent (completed, failed or killed);
 * - a `<teammate-message teammate_id="name">` moves a teammate: an `idle_notification` makes it idle, a shutdown
 *   approval makes it done, anything else is it reporting; a SendMessage to it from the session makes it running again.
 * Agents spawned before the tail are not seen; `partial` says the read started mid-file.
 *
 * Codex: codex-subagent-activity.ts readCodexSubagentDetails (the same spawn-edge table and child lifecycle reader the
 * list already uses for its counts).
 *
 * Opens are non-blocking and refuse symlinks (O_NONBLOCK | O_NOFOLLOW, then a regular-file check); a read is memoized
 * on mtime and size like readSessionActivity, and the memo holds only names, tasks, states and times.
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export type SubagentStatus = 'running' | 'idle' | 'done' | 'failed' | 'unknown'
export interface SubagentRow { name: string; task: string; status: SubagentStatus; at: number }
export interface SessionSubagents { rows: SubagentRow[]; running: number; idle: number; done: number; failed: number; total: number; partial: boolean }

export const SUBAGENTS_PER_SESSION = 6
export const CLAUDE_SUBAGENT_TAIL_BYTES = 768 * 1024
const MAX_TRACKED = 256
const MEMO_MAX = 64
const NAME_MAX = 60
const TASK_MAX = 160

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const AGENT_TOOLS = new Set(['Agent', 'Task'])

interface Tracked extends SubagentRow { team: boolean }

/** The plain text of a user line or a queued message: a string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string' ? (b as any).text : '')).join('\n')
}

const NOTIFICATION = /<task-notification>[\s\S]*?<tool-use-id>([^<\s]{1,120})<\/tool-use-id>[\s\S]*?<status>([a-z_]{1,24})<\/status>/g
const TEAMMATE = /<teammate-message\s+teammate_id="([^"]{1,80})"[^>]*>([\s\S]{0,600})/g

/**
 * Sub-agents from a transcript's tail, most recently moved first, at most `limit` rows, with counts over every one
 * the tail shows. `startsMidFile` drops the first (partial) line.
 */
export function parseClaudeSubagents(text: string, startsMidFile = false, limit = SUBAGENTS_PER_SESSION): SessionSubagents {
  // A read that starts mid-file has a cut first line; it fails to parse and is skipped like any bad line. It is not
  // dropped blindly: a tail that starts exactly on a line boundary would lose a whole event. `partial` says so either way.
  const lines = text.split('\n')
  const byTool = new Map<string, Tracked>()
  const byName = new Map<string, Tracked>()
  const move = (t: Tracked, status: SubagentStatus | null, at: number) => {
    if (at < t.at) return
    t.at = at
    if (status) t.status = status
  }
  for (const line of lines) {
    if (!line || line.length > 4_000_000) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row?.timestamp) || 0
    if (row?.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const b of row.message.content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        if (AGENT_TOOLS.has(b.name)) {
          if (byTool.size >= MAX_TRACKED) continue
          const name = clip(input.name, NAME_MAX) || clip(input.subagent_type, NAME_MAX) || 'agent'
          const t: Tracked = { name, task: clip(input.description, TASK_MAX), status: 'running', at, team: typeof input.name === 'string' && !!input.name.trim() }
          byTool.set(b.id, t)
          if (t.team) byName.set(name, t)
        } else if (b.name === 'SendMessage' && typeof input.to === 'string') {
          const t = byName.get(input.to.trim())
          if (t && t.status !== 'done' && t.status !== 'failed') move(t, 'running', at)
        }
      }
      continue
    }
    if (row?.type === 'user' && Array.isArray(row.message?.content)) {
      for (const b of row.message.content) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const t = byTool.get(b.tool_use_id)
        if (!t) continue
        const result = row.toolUseResult && typeof row.toolUseResult === 'object' ? row.toolUseResult : {}
        if (b.is_error === true) move(t, 'failed', at)
        else if (result.status === 'async_launched' || result.status === 'teammate_spawned') move(t, 'running', at)
        else move(t, 'done', at)
        if (result.status === 'teammate_spawned' && typeof result.name === 'string' && result.name.trim()) {
          t.team = true
          byName.set(clip(result.name, NAME_MAX), t)
        }
      }
    }
    // Notifications arrive as a user line, and as a queued message before it is delivered.
    const text = row?.type === 'user' ? textOf(row.message?.content) : row?.type === 'queue-operation' ? textOf(row.content) : ''
    if (!text || (text.indexOf('<task-notification>') < 0 && text.indexOf('<teammate-message') < 0)) continue
    for (const m of text.matchAll(NOTIFICATION)) {
      const t = byTool.get(m[1]!)
      if (t) move(t, m[2] === 'failed' ? 'failed' : 'done', at)
    }
    for (const m of text.matchAll(TEAMMATE)) {
      const t = byName.get(m[1]!)
      if (!t) continue
      const body = m[2] || ''
      if (/"type"\s*:\s*"shutdown_(?:approved|response)"[\s\S]*?"approve"\s*:\s*true|"type"\s*:\s*"shutdown_approved"/.test(body)) move(t, 'done', at)
      else if (/"type"\s*:\s*"idle_notification"/.test(body)) move(t, 'idle', at)
      else move(t, null, at)
    }
  }
  return summarize([...byTool.values()], startsMidFile, limit)
}

export function summarize(all: SubagentRow[], partial: boolean, limit = SUBAGENTS_PER_SESSION): SessionSubagents {
  const out: SessionSubagents = { rows: [], running: 0, idle: 0, done: 0, failed: 0, total: all.length, partial }
  for (const a of all) if (a.status !== 'unknown') out[a.status]++
  // Live ones first, then by when each last moved.
  const rank = (s: SubagentStatus) => (s === 'running' ? 0 : s === 'idle' ? 1 : 2)
  out.rows = [...all].sort((a, b) => rank(a.status) - rank(b.status) || b.at - a.at).slice(0, limit)
    .map(a => ({ name: a.name, task: a.task, status: a.status, at: a.at }))
  return out
}

const memo = new Map<string, { mtimeMs: number; size: number; value: SessionSubagents }>()

/** One Claude transcript's sub-agents, or null when it cannot be read. Never throws. */
export async function readClaudeSubagents(file: string, tailBytes = CLAUDE_SUBAGENT_TAIL_BYTES): Promise<SessionSubagents | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const st = await handle.stat()
    if (!st.isFile()) return null
    const hit = memo.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
    const length = Math.min(st.size, tailBytes), start = st.size - length
    const buffer = Buffer.alloc(length)
    const read = await handle.read(buffer, 0, length, start)
    const value = parseClaudeSubagents(buffer.subarray(0, read.bytesRead).toString('utf8'), start > 0)
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!)
    memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
    return value
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
