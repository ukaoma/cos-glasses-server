/**
 * 6.83.0 (canary C3): an incremental index of COS-WORK tags in the session logs on this Mac.
 *
 * Logs are append-only, so each file is read from the offset the last pass stopped at; after the first pass only new
 * bytes are scanned. A line is parsed only when it contains `COS-WORK`. The index stores hits, never text:
 * `{tag, kind, sid, at}`. It lives in `data/work-orchestrator/tag-index.json` (0600, atomic), and a missing or corrupt
 * index is rebuilt from zero.
 *
 * Which hits count (canary C3 precision fixes):
 *   - A Claude row is credited to its OWN `sessionId` (a resumed file replays older sessions' rows).
 *   - Claude subagent transcripts are not scanned (a subagent's mention is never membership).
 *   - Codex guardian threads and other non-spawn child threads are skipped; `thread_spawn` children are folded into
 *     their parent, which for membership means they add nothing (a subagent mention), so they are recorded as skipped.
 *   - Kinds: `prompt` (a user turn with this tag's handoff template), `status` (a valid status line in the session's own
 *     reply), `quoted` (a user turn that pastes some other handoff), `tool` (tool input or output), `mention` (anything
 *     else). Only `prompt` and `status` can ever be evidence of membership; discovery decides how much.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../atomic-fs.js'
import { codexSessionRootsOf, type AgentSessionRoots } from '../agent-session-store.js'
import { codexThreadKind, type LogProvider } from './session-log.js'
import { HANDOFF_TEMPLATE, isHandoffPrompt, statusLines, tagsIn } from './tags.js'

export type HitKind = 'prompt' | 'status' | 'quoted' | 'tool' | 'mention'
export interface TagHit { tag: string; kind: HitKind; sid: string; at: number | null }
interface FileEntry {
  size: number; mtimeMs: number; offset: number; provider: LogProvider; sid: string | null
  skip?: 'guardian' | 'spawn' | 'other_child'; hits: TagHit[]
}
interface IndexDoc { version: 1; files: Record<string, FileEntry> }

const NEEDLE = Buffer.from('COS-WORK')
const CHUNK = 8 * 1024 * 1024
/** A single row longer than this is not scanned (no handoff is that long; it keeps memory bounded). */
const MAX_LINE = 32 * 1024 * 1024
const MAX_HITS_PER_FILE = 400
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

async function entries(dir: string): Promise<string[]> { try { return await readdir(dir) } catch { return [] } }

/** Every log file this index covers, with the provider and (when the name gives it) the session id. */
export async function logFiles(roots: AgentSessionRoots): Promise<Array<{ path: string; provider: LogProvider; sid: string | null }>> {
  const out: Array<{ path: string; provider: LogProvider; sid: string | null }> = []
  for (const project of await entries(roots.claudeProjects)) {
    const dir = join(roots.claudeProjects, project)
    for (const name of await entries(dir)) {
      if (name.endsWith('.jsonl') && UUID.test(name.slice(0, -6))) out.push({ path: join(dir, name), provider: 'claude', sid: 'claude:' + name.slice(0, -6).toLowerCase() })
    }
  }
  const codexRoots = codexSessionRootsOf(roots)
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await entries(dir)) {
      const path = join(dir, name)
      if (name.endsWith('.jsonl')) { const m = ROLLOUT_ID.exec(name); if (m) out.push({ path, provider: 'codex', sid: 'codex:' + m[1]!.toLowerCase() }); continue }
      if (depth < 3 && /^\d+$/.test(name)) await walk(path, depth + 1)
    }
  }
  for (const root of codexRoots) await walk(root, 0)
  await walk(join(dirname(roots.codexSessions), 'archived_sessions'), 3)
  for (const project of await entries(roots.cursorProjects)) {
    const dir = join(roots.cursorProjects, project, 'agent-transcripts')
    for (const name of await entries(dir)) {
      if (name.endsWith('.jsonl') && UUID.test(name.slice(0, -6))) { out.push({ path: join(dir, name), provider: 'cursor', sid: 'cursor:' + name.slice(0, -6).toLowerCase() }); continue }
      if (UUID.test(name)) {
        const inner = join(dir, name, name + '.jsonl')
        if (existsSync(inner)) out.push({ path: inner, provider: 'cursor', sid: 'cursor:' + name.toLowerCase() })
      }
    }
  }
  return out
}

/** (role, kind, text) blocks of one row, across the three providers (canary discover.py `blocks`). */
function blocks(o: Record<string, any>): Array<{ role: string; kind: 'text' | 'tool'; text: string }> {
  const out: Array<{ role: string; kind: 'text' | 'tool'; text: string }> = []
  if (o.message && typeof o.message === 'object') {
    const role = String(o.message.role || o.type || o.role || '')
    const c = o.message.content
    if (typeof c === 'string') { out.push({ role, kind: 'text', text: c }); return out }
    for (const b of Array.isArray(c) ? c : []) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') out.push({ role, kind: 'text', text: b.text })
      else if (b.type === 'tool_result') out.push({ role, kind: 'tool', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') })
      else if (b.type === 'tool_use') out.push({ role, kind: 'tool', text: JSON.stringify(b.input ?? '') })
    }
    return out
  }
  const p = o.payload && typeof o.payload === 'object' ? o.payload : {}
  if (o.type === 'response_item' && p.type === 'message') {
    for (const b of Array.isArray(p.content) ? p.content : []) if (b && typeof b.text === 'string') out.push({ role: String(p.role || ''), kind: 'text', text: b.text })
  } else if (o.type === 'response_item') out.push({ role: 'tool', kind: 'tool', text: JSON.stringify(p) })
  // event_msg rows duplicate response items (agent_message / user_message): skipped.
  return out
}

export function classifyRow(o: Record<string, any>, provider: LogProvider, fileSid: string | null, fallbackAt: number | null): TagHit[] {
  let sid = fileSid
  if (provider === 'claude' && typeof o.sessionId === 'string' && UUID.test(o.sessionId)) sid = 'claude:' + o.sessionId.toLowerCase()
  if (!sid) return []
  if (o.isSidechain === true) return []
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  const at = Number.isFinite(ts) ? ts : fallbackAt
  const out: TagHit[] = []
  for (const b of blocks(o)) {
    if (!b.text.includes('COS-WORK')) continue
    const status = b.role === 'assistant' && b.kind === 'text' ? new Set(statusLines(b.text).map(s => s.tag)) : new Set<string>()
    for (const tag of tagsIn(b.text)) {
      let kind: HitKind
      if (status.has(tag)) kind = 'status'
      else if (b.role === 'user' && b.kind === 'text' && isHandoffPrompt(b.text, tag)) kind = 'prompt'
      else if (b.role === 'user' && b.kind === 'text' && b.text.includes(HANDOFF_TEMPLATE)) kind = 'quoted'
      else if (b.kind === 'tool') kind = 'tool'
      else kind = 'mention'
      out.push({ tag, kind, sid, at })
    }
  }
  return out
}

function mergeHits(into: TagHit[], add: TagHit[], cap = MAX_HITS_PER_FILE): TagHit[] {
  const key = (h: TagHit) => `${h.tag}\u0000${h.kind}\u0000${h.sid}`
  const map = new Map(into.map(h => [key(h), h]))
  for (const h of add) {
    const k = key(h), prev = map.get(k)
    if (!prev || (h.at ?? 0) > (prev.at ?? 0)) map.set(k, h)
  }
  return [...map.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, cap)
}

async function firstBytes(path: string, n: number): Promise<string> {
  const handle = await open(path, 'r')
  try { const buf = Buffer.alloc(n); const { bytesRead } = await handle.read(buf, 0, n, 0); return buf.subarray(0, bytesRead).toString('utf8') } finally { await handle.close() }
}

/** A Codex child thread's kind from the start of its first line (the line can be hundreds of KB of instructions). */
export async function codexKindOf(path: string): Promise<ReturnType<typeof codexThreadKind>> {
  const head = await firstBytes(path, 512 * 1024)
  const nl = head.indexOf('\n')
  if (nl >= 0) return codexThreadKind(head.slice(0, nl))
  if (/"source"\s*:\s*\{\s*"subagent"\s*:\s*\{\s*"other"\s*:\s*"guardian"/.test(head)) return { kind: 'guardian' }
  const spawn = /"thread_spawn"\s*:\s*\{\s*"parent_thread_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(head)
  if (spawn) return { kind: 'spawn', parent: spawn[1]!.toLowerCase() }
  return /"source"\s*:\s*\{\s*"subagent"/.test(head) ? { kind: 'other_child' } : { kind: 'thread' }
}

/** Scan [offset, size) of one file. Returns the new offset (just past the last whole line) and the hits found. */
export async function scanRange(path: string, provider: LogProvider, sid: string | null, offset: number, size: number, mtimeMs: number): Promise<{ offset: number; hits: TagHit[] }> {
  const handle = await open(path, 'r')
  const hits: TagHit[] = []
  let pos = offset
  let carry: Buffer = Buffer.alloc(0)
  let carryStart = offset
  try {
    while (pos < size) {
      const length = Math.min(CHUNK, size - pos)
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const lastNl = data.lastIndexOf(10)
      if (lastNl < 0) {
        carry = data.length > MAX_LINE ? Buffer.alloc(0) : Buffer.from(data)
        if (data.length > MAX_LINE) carryStart = pos
        continue
      }
      const whole = data.subarray(0, lastNl + 1)
      if (whole.indexOf(NEEDLE) >= 0) {
        let start = 0
        while (start < whole.length) {
          const end = whole.indexOf(10, start)
          const line = whole.subarray(start, end < 0 ? whole.length : end)
          start = end < 0 ? whole.length : end + 1
          if (line.indexOf(NEEDLE) < 0) continue
          let o: unknown
          try { o = JSON.parse(line.toString('utf8')) } catch { continue }
          if (o && typeof o === 'object' && !Array.isArray(o)) hits.push(...classifyRow(o as Record<string, any>, provider, sid, provider === 'cursor' ? mtimeMs : null))
        }
      }
      carryStart += whole.length
      carry = Buffer.from(data.subarray(lastNl + 1))
    }
  } finally { await handle.close() }
  return { offset: carryStart, hits }
}

export interface TagIndexOptions { roots: AgentSessionRoots; path: string; budgetMs?: number; now?: () => number }
export interface TagIndexStats { files: number; scannedFiles: number; scannedBytes: number; complete: boolean; ms: number; at: number }

export class TagIndex {
  private doc: IndexDoc
  private running: Promise<TagIndexStats> | null = null
  lastStats: TagIndexStats | null = null
  constructor(private readonly options: TagIndexOptions) { this.doc = this.load() }
  private load(): IndexDoc {
    try {
      const v = JSON.parse(readFileSync(this.options.path, 'utf8'))
      if (v && v.version === 1 && v.files && typeof v.files === 'object') return v
    } catch { /* missing or corrupt: rebuilt from zero */ }
    return { version: 1, files: {} }
  }
  private save(): void {
    try { mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 }); atomicWriteFileSync(this.options.path, JSON.stringify(this.doc)) } catch (e) {
      console.warn(`[work-orchestrator] tag index not saved: ${(e as Error).message}`)
    }
  }
  /** One pass at a time; a second caller shares the pass already running. */
  refresh(): Promise<TagIndexStats> {
    if (!this.running) this.running = this.pass().finally(() => { this.running = null })
    return this.running
  }
  private async pass(): Promise<TagIndexStats> {
    const now = this.options.now ?? Date.now
    const t0 = now(), budget = this.options.budgetMs ?? 60_000
    const files = await logFiles(this.options.roots)
    const seen = new Set<string>()
    let scannedFiles = 0, scannedBytes = 0, complete = true
    for (const f of files) {
      seen.add(f.path)
      let info
      try { info = await stat(f.path) } catch { continue }
      let entry = this.doc.files[f.path]
      // A file that shrank or was replaced is read again from the start.
      if (!entry || info.size < entry.offset || entry.provider !== f.provider) {
        entry = { size: 0, mtimeMs: 0, offset: 0, provider: f.provider, sid: f.sid, hits: [] }
        if (f.provider === 'codex') {
          try {
            const k = await codexKindOf(f.path)
            if (k.kind === 'guardian' || k.kind === 'other_child') entry.skip = k.kind
            else if (k.kind === 'spawn') entry.skip = 'spawn'
          } catch { /* unreadable: scanned as a thread */ }
        }
        this.doc.files[f.path] = entry
      }
      if (entry.skip) { entry.size = info.size; entry.mtimeMs = info.mtimeMs; entry.offset = info.size; continue }
      if (info.size === entry.size && info.mtimeMs === entry.mtimeMs && entry.offset >= info.size) continue
      if (now() - t0 > budget) { complete = false; continue }
      try {
        const r = await scanRange(f.path, f.provider, f.sid, entry.offset, info.size, info.mtimeMs)
        scannedBytes += info.size - entry.offset
        entry.offset = r.offset; entry.size = info.size; entry.mtimeMs = info.mtimeMs
        entry.hits = mergeHits(entry.hits, r.hits)
        scannedFiles++
      } catch { /* unreadable this pass: tried again next pass */ }
    }
    for (const path of Object.keys(this.doc.files)) if (!seen.has(path)) delete this.doc.files[path]
    if (scannedFiles) this.save()
    const stats = { files: files.length, scannedFiles, scannedBytes, complete, ms: now() - t0, at: now() }
    this.lastStats = stats
    return stats
  }
  /** Every hit, one per (tag, kind, session) with its newest time: a resumed file and its source can carry the same row. */
  hits(): TagHit[] { return mergeHits([], Object.values(this.doc.files).flatMap(e => e.skip ? [] : e.hits), Infinity) }
  /** The newest log file for a session id (`provider:uuid`), when the index knows one. */
  pathOf(sid: string): string | null {
    let best: { path: string; mtimeMs: number } | null = null
    for (const [path, e] of Object.entries(this.doc.files)) {
      if (e.skip || e.sid !== sid) continue
      if (!best || e.mtimeMs > best.mtimeMs) best = { path, mtimeMs: e.mtimeMs }
    }
    return best?.path ?? null
  }
  /** Codex child threads the index skipped (guardian and others), so the session list can leave them out too. */
  skippedSessions(): Set<string> {
    const out = new Set<string>()
    for (const e of Object.values(this.doc.files)) if (e.skip && e.sid) out.add(e.sid)
    return out
  }
}
