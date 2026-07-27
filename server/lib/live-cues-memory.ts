// Live Cues memory hops.
//
// callPython() cannot be used here: it shells exactly one script,
// cos_api_bridge.py, whose dispatch has no semantic_search or lightrag_search
// verb — an unknown verb returns nothing useful, indistinguishable from an
// empty result. Both hops spawn python directly against the exported
// PYTHON_BIN / COS_SCRIPTS_DIR with their own preflight, timeout, and parse.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import { logTokenAudit } from './token-audit.js'

export interface SemanticHit {
  title: string
  date: string
  domain: string
  score: number
  summary: string
}

export interface Hop1Result {
  ok: boolean
  snippets: string[]
  reason?: string
}

export interface Hop2Result {
  ok: boolean
  text: string | null
  reason?: string
  /** False when the python tree (which may hold claude -p grandchildren)
   *  could not be proven dead after a timeout kill. */
  treeClosed: boolean
}

const HOP1_TIMEOUT_MS = 15_000
const HOP2_TIMEOUT_MS = 40_000

// The LightRAG query pool is 200/day SHARED with /why, --explore, and prep,
// and it increments per LLM call (~2 per query), not per invocation. The
// reserve leaves headroom for interactive queries; it does NOT give cues an
// isolated pool (that would need a third pool in lightrag_adapter.py).
const LIGHTRAG_DAILY_CAP = 200

function lightragReserve(): number {
  const raw = Number(process.env.COS_LIVE_CUES_LIGHTRAG_RESERVE ?? 120)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 120
}

export function lightragBudgetAllows(): boolean {
  if (!COS_SCRIPTS_DIR) return false
  try {
    const counterPath = resolve(COS_SCRIPTS_DIR, '.lightrag_daily_calls.json')
    if (!existsSync(counterPath)) return true
    const parsed = JSON.parse(readFileSync(counterPath, 'utf-8')) as { date?: string; query?: number }
    const today = new Date().toISOString().slice(0, 10)
    if (parsed.date !== today) return true
    const spent = Number.isFinite(parsed.query) ? Number(parsed.query) : 0
    return (LIGHTRAG_DAILY_CAP - spent) > lightragReserve()
  } catch {
    // An unreadable counter fails toward NOT spending: the reserve exists to
    // protect the interactive pool, and blind spending defeats it.
    return false
  }
}

/** hop1 — Qdrant semantic search. No LLM spend; plain execFile timeout is fine. */
export function semanticSearchHop(query: string): Promise<Hop1Result> {
  const pythonBin = PYTHON_BIN
  const scriptsDir = COS_SCRIPTS_DIR
  if (!pythonBin || !scriptsDir) {
    return Promise.resolve({ ok: false, snippets: [], reason: 'no_cos_pipeline' })
  }
  const script = resolve(scriptsDir, 'semantic_search.py')
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, snippets: [], reason: 'no_memory_scripts' })
  }
  return new Promise(resolveHop => {
    execFile(
      pythonBin,
      // --min-score pinned explicitly: the CLI default is 0.25 but the
      // programmatic default is 0.35, and inheriting the wrong one silently
      // cuts recall.
      [script, query, '--json', '--limit', '5', '--min-score', '0.25'],
      { cwd: scriptsDir, timeout: HOP1_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error: Error | null, stdout: string | Buffer) => {
        if (error) {
          resolveHop({ ok: false, snippets: [], reason: 'qdrant_unreachable' })
          return
        }
        try {
          const hits = JSON.parse(String(stdout)) as SemanticHit[]
          const snippets = (Array.isArray(hits) ? hits : [])
            .slice(0, 5)
            .map(hit => `${hit.date ?? '?'} ${hit.title ?? 'Untitled'}: ${String(hit.summary ?? '').slice(0, 220)}`)
          resolveHop({ ok: true, snippets })
        } catch {
          resolveHop({ ok: false, snippets: [], reason: 'qdrant_parse_error' })
        }
      },
    )
  })
}

/** Strip the human chrome lightrag_search.py --explore prints around the
 *  answer. --explore returns before the --json branch — it can NEVER emit
 *  JSON, so this is a plain-text contract by construction. */
export function parseExploreOutput(raw: string): string {
  return raw
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (/^Exploring entity:/i.test(trimmed)) return false
      if (/^-{10,}$/.test(trimmed)) return false
      if (/^\[\d+(?:\.\d+)?s \| mode: /.test(trimmed)) return false
      if (/^(Query|Mode):/i.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

/** hop2 — LightRAG entity exploration. Spends claude -p from the shared query
 *  pool; spawned detached because the python child holds claude grandchildren
 *  a plain timeout kill would orphan. */
export function lightragExploreHop(
  entity: string,
  onProcess?: (proc: ChildProcess) => void,
): Promise<Hop2Result> {
  const pythonBin = PYTHON_BIN
  const scriptsDir = COS_SCRIPTS_DIR
  if (!pythonBin || !scriptsDir) {
    return Promise.resolve({ ok: false, text: null, reason: 'no_cos_pipeline', treeClosed: true })
  }
  const script = resolve(scriptsDir, 'lightrag_search.py')
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, text: null, reason: 'no_memory_scripts', treeClosed: true })
  }
  if (!lightragBudgetAllows()) {
    return Promise.resolve({ ok: false, text: null, reason: 'daily_graph_cap', treeClosed: true })
  }
  const startedAt = Date.now()
  return new Promise(resolveHop => {
    let settled = false
    let stdout = ''
    let timedOut = false

    const proc = spawn(pythonBin, [script, '--explore', entity], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: scriptsDir,
      env: { ...process.env },
      detached: true,
    })
    onProcess?.(proc)

    const finish = (result: Hop2Result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveHop(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      void terminateProviderProcess(proc).then(termination => {
        finish({ ok: false, text: null, reason: 'graph_timeout', treeClosed: termination.closed })
      })
    }, HOP2_TIMEOUT_MS)

    proc.on('error', () => finish({ ok: false, text: null, reason: 'graph_spawn_failed', treeClosed: !proc.pid }))
    proc.stdout?.on('data', chunk => {
      stdout += String(chunk)
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024)
    })

    proc.on('close', code => {
      if (timedOut) return
      const durationMs = Date.now() - startedAt
      if (code !== 0) {
        finish({ ok: false, text: null, reason: 'graph_failed', treeClosed: true })
        return
      }
      const text = parseExploreOutput(stdout)
      if (!text || /^LightRAG query failed/im.test(stdout)) {
        finish({ ok: false, text: null, reason: 'graph_empty', treeClosed: true })
        return
      }
      logTokenAudit({
        source: 'live-cues',
        model: 'lightrag',
        inputChars: entity.length,
        outputChars: text.length,
        durationMs,
        caller: 'live-cues-lightrag',
      })
      finish({ ok: true, text: text.slice(0, 4_000), treeClosed: true })
    })
  })
}
