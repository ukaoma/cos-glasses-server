/**
 * 6.83.0: read the END of a session log without reading the whole file, and turn its rows into human-visible turns.
 * Codex rollouts reach 1.4 GB (canary C2), so the reader seeks from the end: at most `TAIL_BYTES`, starting at the first
 * whole line. Read-only; never writes beside the log.
 *
 * Row shapes (measured in canary C2 on 2026-10-20):
 *   Claude  {type:'user'|'assistant', sessionId, timestamp, isSidechain, isMeta, message:{role, content}}
 *   Cursor  {role, message:{content:[{type:'text', text:'<user_query>…</user_query>'}]}} (no timestamps: use mtime)
 *   Codex   {timestamp, type:'response_item', payload:{type:'message', role, content:[{text}]}} and function calls
 */
import { open, stat } from 'node:fs/promises'

export const TAIL_BYTES = 6_000_000
export type LogProvider = 'claude' | 'codex' | 'cursor'
export type TurnRole = 'user' | 'assistant' | 'tool' | 'todo' | 'ask'
export interface Turn { role: TurnRole; text: string; at: string | null }

/** Harness text that is not the person's ask nor the agent's answer. */
const NOISE = ['<environment_context>', '<user_instructions>', '# AGENTS.md', '<permissions instructions>', '<system-reminder>',
  '<command-name>', '<local-command', 'Caveat: The messages below', '<external_codex_apps_open_page>', '<turn_aborted>']
const noisy = (text: string) => { const head = text.slice(0, 300); return NOISE.some(n => head.includes(n)) }

export async function readTail(path: string, maxBytes = TAIL_BYTES): Promise<{ text: string; size: number; mtimeMs: number; truncated: boolean }> {
  const info = await stat(path)
  const start = Math.max(0, info.size - maxBytes)
  const handle = await open(path, 'r')
  try {
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    let text = buffer.subarray(0, read).toString('utf8')
    // Seeking lands mid-line: drop the partial first line so every row parses whole.
    if (start > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1) }
    return { text, size: info.size, mtimeMs: info.mtimeMs, truncated: start > 0 }
  } finally { await handle.close() }
}

function record(line: string): Record<string, any> | null {
  try { const v = JSON.parse(line); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}

/**
 * Turns from JSONL text. `onlySession`: a Claude file can replay rows of the session it was resumed from; only rows whose
 * own `sessionId` is this one count (canary C3 precision fix 4). Rows without a sessionId are kept.
 */
export function turnsFrom(text: string, provider: LogProvider, onlySession?: string): Turn[] {
  const out: Turn[] = []
  const want = onlySession?.toLowerCase()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const o = record(line)
    if (!o) continue
    const at = typeof o.timestamp === 'string' ? o.timestamp : null
    if (provider === 'claude' || provider === 'cursor') {
      if (provider === 'claude') {
        if (o.type !== 'user' && o.type !== 'assistant') continue
        if (want && typeof o.sessionId === 'string' && o.sessionId.toLowerCase() !== want) continue
      }
      if (o.isSidechain || o.isMeta) continue
      const m = o.message && typeof o.message === 'object' ? o.message : {}
      const role = (m.role || o.role || o.type) as string
      const content = m.content
      if (typeof content === 'string') { if (!noisy(content)) out.push({ role: role === 'assistant' ? 'assistant' : 'user', text: content, at }); continue }
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') {
          let tx: string = b.text
          if (provider === 'cursor') {
            tx = tx.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, '')
            const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(tx)
            if (q) tx = q[1]!
          }
          if (!noisy(tx)) out.push({ role: role === 'assistant' ? 'assistant' : 'user', text: tx, at })
        } else if (b.type === 'tool_use') {
          const input = b.input && typeof b.input === 'object' ? b.input : {}
          if (b.name === 'TodoWrite' || Array.isArray(input.todos)) out.push({ role: 'todo', text: JSON.stringify(input.todos ?? []).slice(0, 3000), at })
          else if (b.name === 'AskUserQuestion') out.push({ role: 'ask', text: JSON.stringify(input).slice(0, 1500), at })
          else out.push({ role: 'tool', text: String(b.name || 'tool'), at })
        }
      }
      continue
    }
    const p = o.payload && typeof o.payload === 'object' ? o.payload : {}
    if (o.type === 'response_item' && p.type === 'message') {
      const tx = (Array.isArray(p.content) ? p.content : []).map((b: any) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
      if ((p.role === 'user' || p.role === 'assistant') && !noisy(tx)) out.push({ role: p.role, text: tx, at })
    } else if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (p.name === 'update_plan') out.push({ role: 'todo', text: String(p.arguments ?? '').slice(0, 3000), at })
      else out.push({ role: 'tool', text: String(p.name || 'tool'), at })
    }
  }
  return out
}

/** The first line of a Codex rollout says whether it is a child thread (canary C3 precision fix 3). */
export interface CodexThreadKind { kind: 'thread' | 'guardian' | 'spawn' | 'other_child'; parent?: string }
export function codexThreadKind(firstLine: string): CodexThreadKind {
  const meta = record(firstLine)?.payload
  const source = meta && typeof meta === 'object' ? meta.source : undefined
  if (!source || typeof source !== 'object' || !('subagent' in source)) return { kind: 'thread' }
  const sub = (source as any).subagent
  if (sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn.parent_thread_id === 'string') {
    return { kind: 'spawn', parent: sub.thread_spawn.parent_thread_id.toLowerCase() }
  }
  if (sub && typeof sub === 'object' && sub.other === 'guardian') return { kind: 'guardian' }
  if (sub === 'guardian') return { kind: 'guardian' }
  return { kind: 'other_child' }
}
