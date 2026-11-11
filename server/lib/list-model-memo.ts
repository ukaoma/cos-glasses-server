/**
 * `reported_model` on LIST rows without the list ever waiting on a model read (step 2a, S1_CONTRACT_step2a.md B3).
 *
 * The 6.62.0 QA rule W11 (routes/agent-sessions.ts) keeps model reads off the list path: a list of 60 rows must not
 * hold a tail read per row. So list rows carry the model ONLY from this memo. After a list answers, `warmListModels`
 * reads the rows the memo missed in the background: at most 4 at a time, Claude and Codex only, and a file that keeps
 * changing is re-read at most once a minute (a Codex posture scan can be long). The value then appears on a later poll.
 *
 * The value and format are exactly the detail route's (session-continue-facts.ts): Claude a bare slug, Codex
 * `<model> <effort>`. Cursor rows are not warmed here (their model sits in Cursor's database; the detail route has it).
 */
import { stat } from 'node:fs/promises'
import { codexReportedModel, readCodexSessionPosture } from './codex-session-posture.js'
import { readClaudeReportedModel, sanitizeReportedModel } from './session-continue-facts.js'

export const LIST_MODEL_WARM_CONCURRENCY = 4
export const LIST_MODEL_REREAD_MS = 60_000
const MEMO_MAX = 2_000

interface Memo { mtimeMs: number; size: number; readAt: number; model: string | null }
const memo = new Map<string, Memo>()
const inflight = new Set<string>()
let running = 0
const queue: Array<() => Promise<void>> = []
export const listModelStats = { reads: 0 }

type Provider = 'claude' | 'codex' | 'cursor'
const keyOf = (provider: Provider, file: string) => `${provider}:${file}`

/** The memo's model for this file, or undefined. Never reads the file's contents. A value read within the last
 *  minute is served even if the file has moved on since (a busy session's model rarely changes mid-minute). */
export function cachedListModel(provider: Provider, file: string | undefined, fileMtimeMs: number | null, now = Date.now()): string | undefined {
  if (!file) return undefined
  const m = memo.get(keyOf(provider, file))
  if (!m || m.model === null) return undefined
  // `modified` on a row is an ISO time (whole milliseconds); the memo holds the stat's fractional mtime.
  if (fileMtimeMs === null || Math.floor(m.mtimeMs) === Math.floor(fileMtimeMs) || now - m.readAt < LIST_MODEL_REREAD_MS) return m.model
  return undefined
}

async function readModel(provider: Provider, file: string): Promise<string | null> {
  listModelStats.reads++
  if (provider === 'claude') return readClaudeReportedModel(file)
  if (provider === 'codex') return sanitizeReportedModel(codexReportedModel(await readCodexSessionPosture(file)))
  return null
}

function pump(): void {
  while (running < LIST_MODEL_WARM_CONCURRENCY && queue.length) {
    const job = queue.shift()!
    running++
    void job().finally(() => { running--; pump() })
  }
}

/** Queue background reads for the rows the memo misses. Returns at once; never throws. */
export function warmListModels(rows: ReadonlyArray<{ provider: Provider; file?: string }>, now = Date.now()): void {
  for (const row of rows) {
    if (row.provider === 'cursor' || !row.file) continue
    const key = keyOf(row.provider, row.file)
    if (inflight.has(key)) continue
    const m = memo.get(key)
    if (m && now - m.readAt < LIST_MODEL_REREAD_MS) continue
    inflight.add(key)
    const { provider, file } = row
    queue.push(async () => {
      try {
        const st = await stat(file)
        const prev = memo.get(key)
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) { prev.readAt = Date.now(); return }
        const model = await readModel(provider, file)
        memo.delete(key)
        memo.set(key, { mtimeMs: st.mtimeMs, size: st.size, readAt: Date.now(), model })
        while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
      } catch { /* unknown stays unknown */ } finally { inflight.delete(key) }
    })
  }
  pump()
}

/** Tests only. */
export async function __drainListModelWarmForTests(): Promise<void> {
  while (running > 0 || queue.length > 0) await new Promise(resolve => setTimeout(resolve, 5))
}
export function __resetListModelMemoForTests(): void { memo.clear(); inflight.clear(); queue.length = 0; listModelStats.reads = 0 }
