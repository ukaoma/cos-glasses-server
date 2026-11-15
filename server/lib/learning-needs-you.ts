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
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COS_SCRIPTS_DIR } from './python-bridge.js'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
// The one "Needs review" predicate, shared with the Memories pane (window.COSMemoryReview there). Plain script: it
// sets globalThis.COSMemoryReview when imported here.
import '../web-control/memory-review.js'

interface MemoryReviewApi {
  RULE_BAR: number
  barOf(block: unknown): number
  reviewState(gate: unknown, confidence?: unknown, decision?: unknown, bar?: unknown): 'needs_review' | 'learning' | 'history'
  itemState(item: unknown, decision?: unknown, blockBar?: unknown): 'needs_review' | 'learning' | 'history'
  needsReview(item: unknown, decision?: unknown, blockBar?: unknown): boolean
  normalizeBlock<T>(block: T): T
  openItems(block: unknown, decisions?: Record<string, string>): unknown[]
  count(block: unknown, decisions?: Record<string, string>): number | null
  total(block: unknown): number | null
  learningItems(block: unknown, decisions?: Record<string, string>): unknown[]
}
export const memoryReview = (globalThis as unknown as { COSMemoryReview: MemoryReviewApi }).COSMemoryReview

/** Control: needsYouCacheTTL = 90 s (HelperSources main.swift 10969). */
export const NEEDS_YOU_TTL_MS = 90_000
/**
 * The read's limit. The build after 7.0.46 (lead 22:0x): the read runs in the background, never under a request, so it
 * may take longer than Control's 10 s; but a result that took longer than the TTL would be stale on arrival, so it must
 * end inside the TTL. Two thirds of it (60 s): 5.5 times the 11 s measured on Miles's Mac under load (2026-11-14), with
 * 30 s of the window left. One read in flight at a time.
 */
export const NEEDS_YOU_TIMEOUT_MS = Math.round(NEEDS_YOU_TTL_MS * 2 / 3)
/** Control: needsYouStaleFlagLimit = 3600 s (main.swift 10970): an older stale block loses reward_enabled. */
export const NEEDS_YOU_STALE_FLAG_LIMIT_MS = 3_600_000
/** A saved count older than this is not shown at all (null), never as current: the same hour as Control's stale flag. */
export const NEEDS_YOU_SHOW_LIMIT_MS = NEEDS_YOU_STALE_FLAG_LIMIT_MS
/** The last good block, so an install or restart does not start blank (data dir, atomic, 0600). */
export const NEEDS_YOU_FILE = 'learning-needs-you.json'
// `learning`, `learning_count` and `bar` (2026-11-08): below-bar suggestions, shown under Learning and never counted.
const KEYS = ['count', 'gates', 'system_backlog', 'window_days', 'limit', 'partial', 'not_implemented', 'items', 'overflow', 'reward_enabled',
  'learning', 'learning_count', 'bar'] as const

export type NeedsYouBlock = Partial<Record<(typeof KEYS)[number], unknown>>

export interface NeedsYouDeps {
  scriptsDir?: string | null
  now?: () => number
  /** Runs `file args` with a timeout; resolves { code, stdout } and never rejects. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>
  /** Where the last good block is saved. Absent or null: memory only (the process singleton passes the data dir's file). */
  file?: string | null
}

/**
 * What the status op shows at once, never waiting on the CLI (the build after 7.0.46):
 * - not_set_up: COS_SCRIPTS_DIR is unset, so this server has no learning pipeline at all (a fact, not a failure);
 * - ok: the last good block and when it was read (in memory or saved), no older than NEEDS_YOU_SHOW_LIMIT_MS;
 * - unknown: nothing good to show (never read yet, every read failed, or the last one is over the limit).
 * Any other failure (the directory set but cos_python or the script missing, a non-zero exit, a timeout, bad JSON) is
 * unknown, never not_set_up.
 */
export type NeedsYouPeek =
  | { state: 'not_set_up' }
  | { state: 'ok'; block: NeedsYouBlock; at: number }
  | { state: 'unknown' }

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

/** The count Today, the rail and the To review tab show: the shown items that need review (memory-review.js count). */
export function needsYouCount(block: NeedsYouBlock | null): number | null {
  return memoryReview.count(block)
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
  const file = deps.file ?? null
  const scriptsDir = () => deps.scriptsDir !== undefined ? deps.scriptsDir : COS_SCRIPTS_DIR
  // Only a good read is kept (Control's fetchNeedsYouBlock, main.swift 10987-11001): a failed
  // read is never cached, and falls back to the last good block, which drops reward_enabled
  // once it is older than an hour so a stale flag cannot keep the ranking sentence alive.
  let good: { at: number; block: NeedsYouBlock } | null = null
  let loaded = false
  let inflight: Promise<NeedsYouBlock | null> | null = null

  function pick(payload: Record<string, unknown>): NeedsYouBlock | null {
    if (payload.count === undefined && payload.items === undefined) return null
    const block: NeedsYouBlock = {}
    for (const key of KEYS) if (payload[key] !== undefined) block[key] = payload[key]
    // An older learning_events.py lists below-bar suggestions as `low_confidence`; the predicate moves them to Learning.
    return Object.keys(block).length ? memoryReview.normalizeBlock(block) : null
  }

  async function readOnce(): Promise<NeedsYouBlock | null> {
    const dir = scriptsDir()
    if (!dir) return null
    const python = join(dir, 'cos_python')
    const script = join(dir, 'learning_events.py')
    if (!existsSync(python) || !existsSync(script)) return null
    const result = await run(python, [script, 'needs-you'], NEEDS_YOU_TIMEOUT_MS)
    if (result.code !== 0) return null
    const payload = parseJsonObject(result.stdout)
    return payload ? pick(payload) : null
  }

  /** The saved block, once per process. A missing, linked, foreign or malformed file is no block, never an error. */
  function loadSaved(): void {
    if (loaded) return
    loaded = true
    if (!file) return
    try {
      if (!existsSync(file) || !lstatSync(file).isFile()) return
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; at?: unknown; block?: unknown }
      if (saved?.v !== 1 || typeof saved.at !== 'number' || !Number.isFinite(saved.at) || saved.at > now()) return
      const block = saved.block && typeof saved.block === 'object' && !Array.isArray(saved.block) ? pick(saved.block as Record<string, unknown>) : null
      if (block && (!good || saved.at > good.at)) good = { at: saved.at, block }
    } catch { /* no saved block */ }
  }
  function save(): void {
    if (!file || !good) return
    try { durableAtomicWriteFileSync(file, JSON.stringify({ v: 1, at: good.at, block: good.block }) + '\n', { mode: 0o600 }) } catch (e) {
      console.warn('[needs-you] the last count was not saved:', e instanceof Error ? e.name : 'error')
    }
  }

  function stale(): NeedsYouBlock | null {
    if (!good) return null
    const block: NeedsYouBlock = { ...good.block }
    if (now() - good.at > NEEDS_YOU_STALE_FLAG_LIMIT_MS) delete block.reward_enabled
    return block
  }
  /** One CLI read, single flight; a good result is kept and saved. Never throws. */
  function refresh(): Promise<NeedsYouBlock | null> {
    if (inflight) return inflight
    inflight = readOnce().catch(() => null).then(block => {
      if (block) { good = { at: now(), block }; save(); return block }
      return stale()
    }).finally(() => { inflight = null })
    return inflight
  }
  /** A fresh block under NEEDS_YOU_TTL_MS old, else a new read, else the last good block; single flight; never throws. */
  function read(): Promise<NeedsYouBlock | null> {
    if (!scriptsDir()) return Promise.resolve(null)
    loadSaved()
    if (good && now() - good.at < NEEDS_YOU_TTL_MS) return Promise.resolve(good.block)
    return refresh()
  }
  /** At once, never waiting on the CLI: what to show now, and a background read when the block is past the TTL. */
  function peek(): NeedsYouPeek {
    if (!scriptsDir()) return { state: 'not_set_up' }
    loadSaved()
    if (!good || now() - good.at >= NEEDS_YOU_TTL_MS) void refresh()
    if (good && now() - good.at <= NEEDS_YOU_SHOW_LIMIT_MS) return { state: 'ok', block: stale()!, at: good.at }
    return { state: 'unknown' }
  }
  return { read, peek, refresh }
}

let singleton: ReturnType<typeof createNeedsYouReader> | null = null
export function getNeedsYouReader(): ReturnType<typeof createNeedsYouReader> {
  if (!singleton) singleton = createNeedsYouReader({ file: dataPath(NEEDS_YOU_FILE) })
  return singleton
}
