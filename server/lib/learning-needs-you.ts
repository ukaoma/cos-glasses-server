// The Memories "To review" count for COS Control Web: the gated needs-you list from
// `learning_events.py needs-you`, read the way Control's helper reads it (HelperSources
// main.swift runNeedsYouCLI: 10 s timeout, the same keys, cached about 90 s).
//
// WHY THE SERVER RUNS IT. Server 6.45.1 strips `needs_you` from /api/context/status, and
// Control overlays it on the Mac from this CLI. The browser has no such overlay, so the web
// Memories page read `learning.to_review` (an object of counts) as the count and showed
// "To review (NaN)". The bridge's status now carries this block instead, or null when the
// CLI is unavailable, never a guess.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'

export const NEEDS_YOU_TIMEOUT_MS = 10_000
/** Control: needsYouCacheTTL = 90 s (HelperSources main.swift 10969). */
export const NEEDS_YOU_TTL_MS = 90_000
/** Control: needsYouStaleFlagLimit = 3600 s (main.swift 10970): an older stale block loses reward_enabled. */
export const NEEDS_YOU_STALE_FLAG_LIMIT_MS = 3_600_000
const KEYS = ['count', 'gates', 'system_backlog', 'window_days', 'limit', 'partial', 'not_implemented', 'items', 'overflow', 'reward_enabled'] as const

export type NeedsYouBlock = Partial<Record<(typeof KEYS)[number], unknown>>

export interface NeedsYouDeps {
  scriptsDir?: string | null
  now?: () => number
  /** Runs `file args` with a timeout; resolves { code, stdout } and never rejects. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>
}

/** The JSON object in the CLI's stdout: the whole of it, or the span from the first { to the last }. */
export function parseJsonObject(output: string): Record<string, unknown> | null {
  const text = output.trim()
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
    } catch { return null }
  }
  const whole = attempt(text)
  if (whole) return whole
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return start >= 0 && end > start ? attempt(text.slice(start, end + 1)) : null
}

/** Control's count for the rail and the To review tab: count, capped by limit when both are numbers. */
export function needsYouCount(block: NeedsYouBlock | null): number | null {
  if (!block) return null
  const count = typeof block.count === 'number' ? block.count : Array.isArray(block.items) ? block.items.length : null
  if (count === null) return null
  return typeof block.limit === 'number' ? Math.min(count, block.limit) : count
}

function defaultRun(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })
}

export function createNeedsYouReader(deps: NeedsYouDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  const run = deps.run ?? defaultRun
  // Only a good read is kept (Control's fetchNeedsYouBlock, main.swift 10987-11001): a failed
  // read is never cached, and falls back to the last good block, which drops reward_enabled
  // once it is older than an hour so a stale flag cannot keep the ranking sentence alive.
  let good: { at: number; block: NeedsYouBlock } | null = null
  let inflight: Promise<NeedsYouBlock | null> | null = null

  async function readOnce(): Promise<NeedsYouBlock | null> {
    const dir = deps.scriptsDir !== undefined ? deps.scriptsDir : COS_SCRIPTS_DIR
    if (!dir) return null
    const python = join(dir, 'cos_python')
    const script = join(dir, 'learning_events.py')
    if (!existsSync(python) || !existsSync(script)) return null
    const result = await run(python, [script, 'needs-you'], NEEDS_YOU_TIMEOUT_MS)
    if (result.code !== 0) return null
    const payload = parseJsonObject(result.stdout)
    if (!payload || (payload.count === undefined && payload.items === undefined)) return null
    const block: NeedsYouBlock = {}
    for (const key of KEYS) if (payload[key] !== undefined) block[key] = payload[key]
    return Object.keys(block).length ? block : null
  }

  function stale(): NeedsYouBlock | null {
    if (!good) return null
    const block: NeedsYouBlock = { ...good.block }
    if (now() - good.at > NEEDS_YOU_STALE_FLAG_LIMIT_MS) delete block.reward_enabled
    return block
  }
  /** A fresh block under NEEDS_YOU_TTL_MS old, else a new read, else the last good block; single flight; never throws. */
  function read(): Promise<NeedsYouBlock | null> {
    if (good && now() - good.at < NEEDS_YOU_TTL_MS) return Promise.resolve(good.block)
    if (inflight) return inflight
    inflight = readOnce().catch(() => null).then(block => {
      if (block) { good = { at: now(), block }; return block }
      return stale()
    }).finally(() => { inflight = null })
    return inflight
  }
  return { read }
}

let singleton: ReturnType<typeof createNeedsYouReader> | null = null
export function getNeedsYouReader(): ReturnType<typeof createNeedsYouReader> {
  if (!singleton) singleton = createNeedsYouReader()
  return singleton
}
