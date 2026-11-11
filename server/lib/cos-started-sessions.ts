/**
 * Sessions a COS job started in the last 7 days (Miles, 2026-11-10 23:16, via the lead: "Yes, keep for 7 days").
 *
 * The 0b spike found that a session started from Work or Ask drops out of GET /api/agent-sessions within hours on a
 * busy Mac (the per-agent cap of 20 showed only the newest 4.2 hours of Claude sessions). The list keeps these, like a
 * COS pin, inside the same bounded keep ceiling (agent-session-store.ts KEPT_LIST_MAX).
 *
 * Read from the query-job journal (data/query-jobs/<YYYY-MM-DD>.jsonl): each job's `running` or `completed` record
 * names its provider and native session (`cliSessionId` for Claude and Cursor, `codexThreadId` for Codex). Only ids,
 * times and the request's kind are read, never prompts or answers.
 *
 * Only jobs a PERSON started count (Q1, 2026-11-10 23:3x). Every job records a session id (54 of 54 in the 8 days
 * measured), so the job's `accepted` record decides. It is an ALLOWLIST (Q1's nit, lead 23:44), so a new kind of
 * background job fails safe: a job counts only when its request has no `origin` (Ask from phone, lens or web, Work
 * starts, Continue) or `origin.kind === 'task'` (a dispatched task), and no `maintenanceWorkflow`. That leaves out
 * the scheduler's routines (the morning brief: 6 of 54), meeting consolidation (2 of 54) and any kind added later.
 * A session id whose job's request record is not in the window is left out too (only a job that ran for more than
 * a day; failing safe). Each day file is memoized on mtime and size, and a file that keeps
 * changing (a job writing its deltas) is re-read at most every 30 seconds, so the 5-second list poll stays cheap.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from './data-dir.js'

export const COS_STARTED_WINDOW_MS = 7 * 24 * 3600 * 1000
export const COS_STARTED_REREAD_MS = 30_000
type Provider = 'claude' | 'codex' | 'cursor'
interface Seen { provider: Provider; id: string; at: number; jobId: string }
interface DayMemo { mtimeMs: number; size: number; readAt: number; seen: Seen[]; person: string[] }

const memo = new Map<string, DayMemo>()
export const cosStartedStats = { reads: 0 }
export function __resetCosStartedForTests(): void { memo.clear(); cosStartedStats.reads = 0 }

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/

/** True only for a request a person started: no origin, or a dispatched task; never a maintenance workflow. */
export function isPersonJobRequest(request: unknown): boolean {
  if (!request || typeof request !== 'object') return false
  const r = request as { origin?: unknown; maintenanceWorkflow?: unknown }
  if (r.maintenanceWorkflow != null) return false
  if (r.origin == null) return true
  return typeof r.origin === 'object' && (r.origin as { kind?: unknown }).kind === 'task'
}

function idsIn(text: string): { seen: Seen[]; person: string[] } {
  const out: Seen[] = []
  const person: string[] = []
  for (const line of text.split('\n')) {
    const hasRequest = line.includes('"request"')
    if (!hasRequest && !line.includes('SessionId') && !line.includes('ThreadId')) continue
    let record: any
    try { record = JSON.parse(line) } catch { continue }
    const jobId = typeof record?.jobId === 'string' ? record.jobId : ''
    if (hasRequest && jobId && isPersonJobRequest(record?.request)) person.push(jobId)
    const patch = record?.patch
    if (!patch || typeof patch !== 'object') continue
    const provider = patch.provider
    const at = Date.parse(record.persistedAt ?? '')
    const id = provider === 'codex' ? patch.codexThreadId : patch.cliSessionId
    if ((provider === 'claude' || provider === 'codex' || provider === 'cursor') && typeof id === 'string' && SAFE_ID.test(id)) {
      out.push({ provider, id: id.toLowerCase(), at: Number.isFinite(at) ? at : 0, jobId })
    }
  }
  return { seen: out, person }
}

/** Native session ids per provider that a COS job started within `windowMs` of `now`. Never throws. */
export async function cosStartedSessionIds(now = Date.now(), dir = dataPath('query-jobs'), windowMs = COS_STARTED_WINDOW_MS): Promise<Record<Provider, Set<string>>> {
  const result: Record<Provider, Set<string>> = { claude: new Set(), codex: new Set(), cursor: new Set() }
  let names: string[]
  try { names = await readdir(dir) } catch { return result }
  // One day of slack: a job's day file is its own partition day, and the window is measured from its record time.
  const oldestDay = new Date(now - windowMs - 24 * 3600 * 1000).toISOString().slice(0, 10)
  const memos: DayMemo[] = []
  for (const name of names) {
    const day = DAY_FILE.exec(name)?.[1]
    if (!day || day < oldestDay) continue
    const file = join(dir, name)
    try {
      const st = await stat(file)
      if (!st.isFile()) continue
      let m = memo.get(file)
      const changed = !m || m.mtimeMs !== st.mtimeMs || m.size !== st.size
      if (changed && (!m || now - m.readAt >= COS_STARTED_REREAD_MS)) {
        cosStartedStats.reads++
        m = { mtimeMs: st.mtimeMs, size: st.size, readAt: now, ...idsIn(await readFile(file, 'utf8')) }
        memo.set(file, m)
      }
      if (m) memos.push(m)
    } catch { /* a day file that cannot be read adds nothing */ }
  }
  // A job's request and its session id can sit in different day files, so person-started jobs are gathered first.
  const person = new Set(memos.flatMap(m => m.person))
  for (const m of memos) {
    for (const s of m.seen) if (now - s.at <= windowMs && person.has(s.jobId)) result[s.provider].add(s.id)
  }
  for (const key of memo.keys()) if (!names.includes(key.split('/').pop() || '')) memo.delete(key)
  return result
}
