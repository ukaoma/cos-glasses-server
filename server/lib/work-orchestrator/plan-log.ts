/**
 * 6.83.0: every Work chat plan, from any client, leaves one JSONL row and one server log line: the sessions sent with
 * their availability, what was left out and why, the usage snapshot's age per provider, the assignments (mode and
 * target, never prompt text), the planner, the outcome and the time taken. Bounded: past 2 MB the file keeps its newest
 * half. Ids and enums only; no question, prompt, summary or pick-up text is written.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from '../atomic-fs.js'

export const PLAN_LOG_MAX_BYTES = 2 * 1024 * 1024

export interface PlanLogRow {
  at: string; workID: string; mode: string; planner: string; effort: string; orchestrator: boolean
  sessions: Array<{ id: string; automatic: boolean; available?: boolean; reason?: string; discoveredBy?: string[] }>
  leftOut: Array<{ id: string; reason: string }>
  usageAgeSec: Record<string, number | null>
  usageState: Record<string, string>
  assignments: Array<{ mode: string; target: string }>
  outcome: 'planned' | 'invalid_answer' | 'unavailable' | 'aborted'
  ms: number
}

export function appendPlanLog(path: string, row: PlanLogRow): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let size = 0
    try { size = statSync(path).size } catch { /* new file */ }
    if (size > PLAN_LOG_MAX_BYTES) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      atomicWriteFileSync(path, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n')
    }
    appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 })
  } catch (e) { console.warn(`[work-orchestrator] plan log not written: ${(e as Error).message}`) }
  const sent = row.sessions.map(s => `${s.id.slice(0, 15)}${s.automatic ? '' : '(no-continue)'}${s.reason ? `[${s.reason}]` : ''}`).join(',') || 'none'
  const usage = Object.entries(row.usageState).map(([p, s]) => `${p}=${s}/${row.usageAgeSec[p] ?? '-'}s`).join(' ') || 'none'
  console.log(`[work-orchestrator] plan work=${row.workID} outcome=${row.outcome} planner=${row.planner}/${row.effort} orchestrator=${row.orchestrator} sessions=${sent} leftOut=${row.leftOut.length} usage=${usage} assignments=${row.assignments.map(a => `${a.mode}:${a.target.slice(0, 15)}`).join(',') || 'none'} ms=${row.ms}`)
}
