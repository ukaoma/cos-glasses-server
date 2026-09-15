// The durable trail of hook events: `session-hook-events.jsonl`, one projected row per
// envelope, rotated once at 10 MB, replayed on boot to warm the signal store.
//
// The ledger keeps the PROJECTION (`projectHookPayload`), never the raw payload: a
// PostToolUse response or a full reply would churn the ring in minutes. Each row carries
// the spool filename as its key so a crash between append and unlink replays without
// applying the same event twice.

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import type { HookEnvelope, HookEventName } from './session-hook-events.js'
import { projectHookPayload, isHookEventName, SESSION_ID_RE } from './session-hook-events.js'

export const LEDGER_ROTATE_BYTES = 10 * 1024 * 1024

export interface LedgerRow {
  key: string
  ts: number
  ppid: number | null
  event: HookEventName
  session_id: string
  /** Classified at ingest, while the pid was alive: a COS-spawned child's event. */
  child?: boolean
  payload: Record<string, unknown>
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && code ? code : (error instanceof Error ? error.name || 'Error' : 'error')
}

function readText(path: string): string {
  if (!existsSync(path)) return ''
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

function oldestTs(text: string): number | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ts = (JSON.parse(line) as { ts?: unknown }).ts
      if (typeof ts === 'number') return ts
    } catch { continue }
  }
  return null
}

export class SessionHookLedger {
  readonly path: string
  private lastError: string | null = null
  private appended = 0

  constructor(path: string) {
    this.path = path
  }

  /** Append one row. Returns false (and remembers why) when the disk refused. */
  append(key: string, env: HookEnvelope, child = false): boolean {
    let row: LedgerRow
    try {
      row = {
        key,
        ts: env.ts,
        ppid: env.ppid,
        event: env.event,
        session_id: env.sessionId,
        ...(child ? { child: true } : {}),
        payload: projectHookPayload(env.event, env.payload),
      }
    } catch (error) {
      // A pathological payload must not escape into the sweep; the caller rejects the file.
      this.lastError = codeOf(error)
      return false
    }
    try {
      this.rotateIfNeeded()
      appendFileSync(this.path, JSON.stringify(row) + '\n', { mode: 0o600 })
      this.appended++
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = codeOf(error)
      return false
    }
  }

  private rotateIfNeeded(): void {
    let size = 0
    try { size = statSync(this.path).size } catch { return }
    if (size < LEDGER_ROTATE_BYTES) return
    try { renameSync(this.path, this.path + '.1') } catch { /* the next append tries again */ }
  }

  /**
   * Replay rows newer than `sinceMs`. The rotated `.1` is read too whenever the current
   * file does not reach back to `sinceMs` (a rotation inside the window would otherwise
   * hide the rows that matter most, and forget their keys). Malformed lines are skipped;
   * a boot must never fail on a torn last line.
   */
  replay(sinceMs: number, apply: (env: HookEnvelope, key: string, child: boolean) => void): { rows: number; applied: number; keys: Set<string> } {
    const keys = new Set<string>()
    let rows = 0
    let applied = 0
    const current = readText(this.path)
    const oldest = oldestTs(current)
    const texts = oldest !== null && oldest > sinceMs ? [readText(this.path + '.1'), current] : [current]
    for (const line of texts.join('\n').split('\n')) {
      if (!line.trim()) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      if (!row || typeof row !== 'object') continue
      const r = row as Partial<LedgerRow>
      rows++
      if (typeof r.key !== 'string' || typeof r.ts !== 'number' || !isHookEventName(r.event)) continue
      if (typeof r.session_id !== 'string' || !SESSION_ID_RE.test(r.session_id)) continue
      keys.add(r.key)
      if (r.ts < sinceMs) continue
      const payload = r.payload && typeof r.payload === 'object' ? r.payload as Record<string, unknown> : {}
      apply({ ts: r.ts, ppid: typeof r.ppid === 'number' ? r.ppid : null, event: r.event, sessionId: r.session_id.toLowerCase(), payload: { session_id: r.session_id, ...payload } }, r.key, r.child === true)
      applied++
    }
    return { rows, applied, keys }
  }

  stats(): { bytes: number; appended: number; lastError: string | null } {
    let bytes = 0
    try { bytes = statSync(this.path).size } catch { /* none yet */ }
    return { bytes, appended: this.appended, lastError: this.lastError }
  }
}
