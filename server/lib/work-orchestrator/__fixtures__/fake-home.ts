/**
 * Test fixture: a fake home with Claude, Codex and Cursor logs in the shapes canary C2/C3 measured on 2026-10-20.
 * The home path deliberately contains a dot component and a space ("~/.Fake Home"), the properties a real install has
 * and a bare mkdtemp does not (gotchas: a fixture that cannot reproduce the production value is not coverage).
 */
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSessionRoots, type AgentSessionRoots } from '../../agent-session-store.js'

export const TEMPLATE_LINE = (tag: string) =>
  `\n\nWhen you finish this task, or if you need input or are blocked, make this the first line of your reply, in plain text (not bold, not in a code block), so COS can track it:\nCOS-WORK ${tag}: <done, needs input or blocked>: <one sentence of evidence>\nUse done only when the work is finished and checked.`

export interface FakeHome { home: string; roots: AgentSessionRoots; dataDir: string }

export function fakeHome(): FakeHome {
  const base = mkdtempSync(join(tmpdir(), 'orch-'))
  const home = join(base, '.Fake Home')
  mkdirSync(home, { recursive: true })
  const dataDir = join(home, '.cos-glasses', 'data')
  mkdirSync(dataDir, { recursive: true })
  return { home, roots: agentSessionRoots(home), dataDir }
}

const claudeRow = (sessionId: string, type: 'user' | 'assistant', content: unknown, timestamp: string) =>
  JSON.stringify({ type, sessionId, timestamp, isSidechain: false, message: { role: type, content } })

export function claudeLog(h: FakeHome, project: string, fileSession: string, rows: Array<{ session?: string; role: 'user' | 'assistant'; text?: string; content?: unknown; at: string }>): string {
  const dir = join(h.roots.claudeProjects, project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${fileSession}.jsonl`)
  writeFileSync(path, rows.map(r => claudeRow(r.session ?? fileSession, r.role, r.content ?? [{ type: 'text', text: r.text ?? '' }], r.at)).join('\n') + '\n')
  return path
}

export function appendClaude(path: string, session: string, role: 'user' | 'assistant', text: string, at: string): void {
  appendFileSync(path, claudeRow(session, role, [{ type: 'text', text }], at) + '\n')
}

export function codexLog(h: FakeHome, id: string, rows: Array<{ role: 'user' | 'assistant'; text: string; at: string }>, source: unknown = 'cli', day = '2026/10/20'): string {
  const dir = join(h.roots.codexSessions, ...day.split('/'))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-10-20T10-00-00-${id}.jsonl`)
  const meta = JSON.stringify({ timestamp: rows[0]?.at ?? '2026-10-20T10:00:00Z', type: 'session_meta', payload: { id, source, base_instructions: { text: 'x'.repeat(2000) } } })
  writeFileSync(path, [meta, ...rows.map(r => JSON.stringify({ timestamp: r.at, type: 'response_item', payload: { type: 'message', role: r.role, content: [{ type: r.role === 'user' ? 'input_text' : 'output_text', text: r.text }] } }))].join('\n') + '\n')
  return path
}

export function cursorLog(h: FakeHome, project: string, id: string, rows: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const dir = join(h.roots.cursorProjects, project, 'agent-transcripts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, rows.map(r => JSON.stringify({ role: r.role, message: { content: [{ type: 'text', text: r.role === 'user' ? `<user_query>${r.text}</user_query>` : r.text }] } })).join('\n') + '\n')
  return path
}

export const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4222-8333-${n.toString(16).padStart(12, '0')}`
