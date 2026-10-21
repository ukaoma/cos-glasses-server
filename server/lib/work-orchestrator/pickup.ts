/**
 * 6.83.0 (M2 planner input, canary C2): a bounded, deterministic "where it stopped, what is next" note from the tail of
 * a session's log. No model call. The note goes only into the planner input; it is redacted (secrets and customer
 * identifiers) before it leaves this module, and never longer than PICKUP_MAX_CHARS.
 */
import { readTail, turnsFrom, type LogProvider, type Turn } from './session-log.js'
import { redactNote } from './redact.js'
import { statusLines } from './tags.js'

export const PICKUP_MAX_CHARS = 1500

/** User turns the harness writes, not the person: task notifications, compaction summaries, interrupts. */
const HARNESS = ['Perform any necessary follow-up actions', 'Briefly inform the user about the task result', '<task-notification>',
  'This session is being continued from a previous conversation', '[Request interrupted', 'The following is the Codex agent history']

export interface LiveOverlay { busy?: boolean; waitingOnUser?: boolean }

const clip = (s: string, n: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…'
}

export function pendingTodos(turns: Turn[]): string[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role !== 'todo') continue
    let items: unknown
    try { items = JSON.parse(t.text) } catch { items = undefined }
    if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = undefined } }
    if (items && typeof items === 'object' && !Array.isArray(items)) items = (items as any).plan ?? (items as any).todos
    if (!Array.isArray(items)) return []
    return items.filter(it => it && typeof it === 'object' && !['completed', 'done'].includes(String((it as any).status ?? '').toLowerCase()))
      .map(it => `${String((it as any).status || 'open')}: ${String((it as any).content ?? (it as any).step ?? (it as any).activeForm ?? '')}`)
  }
  return []
}

export function questionsIn(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(/(?<=[.?!])\s+|\n/)) {
    const l = piece.trim().replace(/^[-*#> ]+/, '').replace(/[-*#> ]+$/, '')
    if (l.endsWith('?') && l.length > 12 && l.length < 300 && !/^(https?:|what i |why )/i.test(l)) out.push(l)
  }
  return out.slice(-4)
}

export interface PickupNote { note: string; lastActivity: string | null; state: 'running' | 'mid_turn' | 'after_tools' | 'finished' | 'empty' }

/** The note from turns already read. `mtimeMs` stands in for Cursor's missing timestamps. */
export function pickupFromTurns(turns: Turn[], options: { live?: LiveOverlay; mtimeMs?: number; home?: string } = {}): PickupNote {
  const r = (s: string) => redactNote(s, options.home)
  const human = turns.filter(t => t.role === 'user' && t.text.trim() && !/^\s*[<{]/.test(t.text) && !HARNESS.some(h => t.text.trimStart().startsWith(h)))
  const replies = turns.filter(t => t.role === 'assistant' && t.text.trim())
  if (!human.length && !replies.length) return { note: 'No readable turns in the log tail.', lastActivity: null, state: 'empty' }
  const lastUser = human[human.length - 1]
  const lastReply = replies[replies.length - 1]
  const iUser = turns.lastIndexOf(lastUser!), iReply = turns.lastIndexOf(lastReply!)
  const toolsAfter = iReply >= 0 ? turns.slice(iReply + 1).filter(t => t.role === 'tool').length : 0
  let state: PickupNote['state'] = iUser > iReply ? 'mid_turn' : toolsAfter ? 'after_tools' : 'finished'
  let stateLine = state === 'mid_turn' ? 'Stopped mid-turn: the last ask has no reply yet.'
    : state === 'after_tools' ? `Stopped after ${toolsAfter} tool call(s) with no closing reply.` : 'Stopped after a reply (turn finished).'
  if (options.live?.busy) { state = 'running'; stateLine = 'Still running: a turn is in flight now, so this is a moving snapshot.' }
  else if (options.live?.waitingOnUser) stateLine += ' The session list says it is waiting on the user.'
  const stamp = lastReply?.at ?? lastUser?.at ?? null
  const lastActivity = stamp ?? (options.mtimeMs ? new Date(options.mtimeMs).toISOString() : null)
  const when = stamp ? `${stamp.slice(0, 16).replace('T', ' ')} UTC` : options.mtimeMs ? `${new Date(options.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC (file time)` : 'unknown'
  const parts = [`State: ${stateLine} Last activity ${when}.`]
  parts.push('Last ask: ' + clip(r(lastUser?.text ?? ''), 300))
  parts.push('Last result: ' + clip(r(lastReply?.text ?? ''), 520))
  const status = lastReply ? statusLines(lastReply.text)[0] : undefined
  if (status) parts.push('Status line: ' + clip(r(`${status.status}: ${status.evidence}`), 160))
  const todos = pendingTodos(turns)
  if (todos.length) parts.push('Open todos: ' + clip(r(todos.join('; ')), 220))
  const qs = lastReply ? questionsIn(lastReply.text) : []
  parts.push('Open questions: ' + (qs.length ? clip(r(qs.join(' | ')), 260) : 'none found in the last reply.'))
  let note = parts.join('\n')
  if (note.length > PICKUP_MAX_CHARS) note = note.slice(0, PICKUP_MAX_CHARS - 1) + '…'
  return { note, lastActivity, state }
}

export async function pickupNote(path: string, provider: LogProvider, sessionID: string, live?: LiveOverlay, home?: string): Promise<PickupNote> {
  const tail = await readTail(path)
  const turns = turnsFrom(tail.text, provider, provider === 'claude' ? sessionID : undefined)
  return pickupFromTurns(turns, { live, mtimeMs: tail.mtimeMs, home })
}
