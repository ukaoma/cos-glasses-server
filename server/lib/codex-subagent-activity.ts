// Read-only display evidence. Never imported by attachment, queue or write gates.
// Open spawn edges describe relationships, not work: completed children remain open.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, realpath, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const exec = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SUBAGENT_FRESH_MS = 5 * 60_000
const MAX_ROWS = 512
const MAX_TAIL = 4 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
export interface SubagentActivity {
  active: number
  completed: number
  unknown: number
  total: number
  checked_at: number
  partial: boolean
}
export type ChildState = 'active' | 'completed' | 'unknown'

/** Latest explicit turn lifecycle wins; ordinary output alone never starts a turn. */
interface ChildEvidence { lifecycle: 'open' | 'completed' | 'unknown'; latest: number }
function parseChildEvidence(text: string, now: number, startsMidFile = false): ChildEvidence {
  const lines = text.split('\n')
  if (startsMidFile) lines.shift()
  let latest = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: any
    try { row = JSON.parse(lines[i]) } catch { continue }
    const at = Date.parse(row?.timestamp)
    if (Number.isFinite(at) && at <= now + 5000 && at > 0) latest = Math.max(latest, at)
    if (row?.type !== 'event_msg') continue
    const kind = row.payload?.type
    if (['task_complete', 'task_failed', 'turn_aborted', 'turn_cancelled'].includes(kind)) return { lifecycle: Number.isFinite(at) && at > 0 && at <= now + 5000 ? 'completed' : 'unknown', latest }
    if (kind === 'task_started') {
      // A crashed/interrupted writer with no terminal event must age into uncertainty.
      return { lifecycle: Number.isFinite(at) && at > 0 && at <= now + 5000 ? 'open' : 'unknown', latest }
    }
  }
  return { lifecycle: 'unknown', latest }
}
function stateOf(evidence: ChildEvidence, now: number): ChildState {
  if (evidence.lifecycle === 'completed') return 'completed'
  return evidence.lifecycle === 'open' && evidence.latest <= now + 5000 && now - evidence.latest <= SUBAGENT_FRESH_MS ? 'active' : 'unknown'
}
export function childStateFromTail(text: string, now: number, startsMidFile = false): ChildState {
  return stateOf(parseChildEvidence(text, now, startsMidFile), now)
}

const fileMemo = new Map<string, { mtime: number; size: number; evidence: ChildEvidence }>()
async function childState(file: string, root: string, now: number, budget: { bytes: number }): Promise<ChildState> {
  try {
    const canonical = await realpath(file)
    const rel = relative(await realpath(root), canonical)
    if (!rel || rel.startsWith('..') || rel.startsWith('/') || !canonical.endsWith('.jsonl')) return 'unknown'
    const st = await stat(canonical)
    if (!st.isFile()) return 'unknown'
    const hit = fileMemo.get(canonical)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return stateOf(hit.evidence, now)
    const handle = await open(canonical, 'r')
    let evidence: ChildEvidence = { lifecycle: 'unknown', latest: 0 }
    try {
      for (let limit = 256 * 1024; ; limit *= 4) {
        if (budget.bytes <= 0) return 'unknown'
        const length = Math.min(st.size, limit, budget.bytes), start = st.size - length
        budget.bytes -= length
        const buffer = Buffer.alloc(length)
        const read = await handle.read(buffer, 0, length, start)
        evidence = parseChildEvidence(buffer.subarray(0, read.bytesRead).toString('utf8'), now, start > 0)
        if (evidence.lifecycle !== 'unknown' || start === 0 || limit >= MAX_TAIL) break
      }
    } finally { await handle.close() }
    // Cache only lifecycle metadata, never transcript text. Freshness is recomputed.
    if (fileMemo.size >= MAX_ROWS) fileMemo.delete(fileMemo.keys().next().value!)
    fileMemo.set(canonical, { mtime: st.mtimeMs, size: st.size, evidence })
    return stateOf(evidence, now)
  } catch { return 'unknown' }
}

/** One bounded read-only SQLite snapshot per list/detail read. */
export async function readCodexSubagents(
  parents: readonly string[], sessionsRoot: string, now = Date.now(),
): Promise<Map<string, SubagentActivity>> {
  const ids = [...new Set(parents.filter(id => UUID.test(id)).map(id => id.toLowerCase()))].slice(0, 80)
  const out = new Map<string, SubagentActivity>()
  if (!ids.length) return out
  try {
    const home = dirname(sessionsRoot)
    const files = (await readdir(home)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a,b) => Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))
    if (!files.length) return out // older installations do not advertise this capability
    // UUID validation above is the SQL parameter boundary; no prompt/path reaches SQL.
    const values = ids.map(id => `'${id}'`).join(',')
    const query = `WITH RECURSIVE children(root,id,depth,trail) AS (
      SELECT parent_thread_id,child_thread_id,1,','||parent_thread_id||','||child_thread_id||',' FROM thread_spawn_edges WHERE status='open' AND parent_thread_id IN (${values})
      UNION ALL SELECT c.root,e.child_thread_id,c.depth+1,c.trail||e.child_thread_id||',' FROM children c JOIN thread_spawn_edges e ON e.parent_thread_id=c.id WHERE e.status='open' AND c.depth<16 AND instr(c.trail,','||e.child_thread_id||',')=0
    ) SELECT DISTINCT c.root,c.id,t.rollout_path,t.archived,c.depth FROM children c LEFT JOIN threads t ON t.id=c.id LIMIT ${MAX_ROWS+1}`
    const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', '-json', join(home,files[0]), query], { timeout: 2000, maxBuffer: 2*1024*1024 })
    const rows = JSON.parse(stdout || '[]') as Array<{root:string;id:string;rollout_path?:string;archived?:number;depth:number}>
    for (const id of ids) out.set(id, {active:0,completed:0,unknown:0,total:0,checked_at:now,partial:rows.length>MAX_ROWS})
    const seen = new Set<string>()
    const budget = { bytes: MAX_SNAPSHOT_BYTES }
    // Sequential bounded reads avoid descriptor storms; most children are memo hits.
    for (const row of rows.slice(0, MAX_ROWS)) {
      const key = row.root+':'+row.id, summary = out.get(row.root)
      if (!summary || seen.has(key)) continue
      seen.add(key); summary.total++
      if (row.depth >= 16) summary.partial = true
      const state = row.archived === 1 ? 'completed' : typeof row.rollout_path === 'string' ? await childState(row.rollout_path, sessionsRoot, now, budget) : 'unknown'
      summary[state === 'active' ? 'active' : state === 'completed' ? 'completed' : 'unknown']++
    }
  } catch {
    // Do not convert a schema/read failure into a fabricated zero-agent count.
    for (const id of ids) out.set(id, {active:0,completed:0,unknown:0,total:0,checked_at:now,partial:true})
  }
  return out
}
