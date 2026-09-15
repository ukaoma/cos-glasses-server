// The spool ingester: reads the one-file-per-event spool `bin/hooks/cos-session-hook`
// writes, ledgers each event, applies it to the signal store, and unlinks the file.
//
// THE FILE IS THE BUS. The hook script never talks to this server, so a session's
// hooks keep spooling while the managed runtime restarts or is stopped for a week; the
// startup drain applies the backlog in filename order (millisecond timestamp, then pid)
// and `state_since` comes from each file's own stamp, not its arrival.
//
// Same poll discipline as `session-transcript-watcher.ts`: a `fs.watch` on the directory
// is only a wake-up, the 2 s readdir sweep is the guaranteed path, one sweep at a time
// (`ticking`), timer unref'd so it never holds the process open. A sweep applies at most
// BATCH files, so a 2,000-file backlog is drained in bounded slices of the event loop.
//
// Off is still a drain. With `COS_SESSION_HOOKS=0` the ingester runs with `apply` set to
// nothing: it ledgers, unlinks and stamps `.last-drain`, because the script's own guard
// stops spooling when that stamp goes stale, and a spool nobody reads must not grow.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { HookEnvelope } from './session-hook-events.js'
import { parseHookEnvelope } from './session-hook-events.js'
import type { SessionHookLedger } from './session-hook-ledger.js'

export const SPOOL_SWEEP_MS = 2_000
export const SPOOL_BATCH = 200
export const REJECTED_KEEP = 1_000
export const REJECTED_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export const LAST_DRAIN_STAMP = '.last-drain'

const SPOOL_FILE_RE = /^(\d{10,16})-(\d+)-([A-Za-z]+)\.json$/

export interface SpoolIngesterOptions {
  dir: string
  ledger: SessionHookLedger
  /** Apply a parsed envelope to the store. Absent when the feature is off. */
  apply?: (env: HookEnvelope) => void
  /** Keys already in the ledger at boot, so a replayed file is not applied twice. */
  seenKeys?: Set<string>
  sweepMs?: number
  batch?: number
  now?: () => number
}

export interface SpoolStats {
  ingested: number
  rejected: number
  salvaged: number
  duplicates: number
  backlog: number
  lastSweepAt: number | null
  lastEventAt: number | null
  lastError: string | null
}

export interface SpoolIngester {
  sweep(): number
  stop(): void
  stats(): SpoolStats
}

export function startSpoolIngester(options: SpoolIngesterOptions): SpoolIngester {
  const { dir, ledger } = options
  const now = options.now ?? (() => Date.now())
  const sweepMs = options.sweepMs ?? SPOOL_SWEEP_MS
  const batch = options.batch ?? SPOOL_BATCH
  const seen = options.seenKeys ?? new Set<string>()
  const rejectedDir = join(dir, 'rejected')
  const stats: SpoolStats = { ingested: 0, rejected: 0, salvaged: 0, duplicates: 0, backlog: 0, lastSweepAt: null, lastEventAt: null, lastError: null }
  let ticking = false
  let stopped = false
  let watcher: FSWatcher | null = null
  let pruneCounter = 0

  try { mkdirSync(rejectedDir, { recursive: true, mode: 0o700 }) } catch { /* the sweep reports it */ }

  const stamp = () => {
    const path = join(dir, LAST_DRAIN_STAMP)
    try {
      if (existsSync(path)) { const t = new Date(now()); utimesSync(path, t, t) } else writeFileSync(path, '', { mode: 0o600 })
    } catch { /* a missing stamp only makes the script cautious */ }
  }

  const listSpool = (): string[] => {
    let names: string[]
    try { names = readdirSync(dir) } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
      return []
    }
    return names.filter(n => SPOOL_FILE_RE.test(n)).sort()
  }

  const reject = (name: string, reason: string) => {
    stats.rejected++
    try { renameSync(join(dir, name), join(rejectedDir, `${name}.${reason}`)) } catch {
      try { unlinkSync(join(dir, name)) } catch { /* gone already */ }
    }
  }

  const ingestOne = (name: string): void => {
    const path = join(dir, name)
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { return /* raced a rename; the next sweep sees it or not */ }
    const parsed = parseHookEnvelope(text)
    let env: HookEnvelope | null = null
    if (parsed.ok) {
      env = parsed.envelope
    } else if (parsed.salvaged) {
      // A cut Stop still turns the row idle; nothing else in the file is trusted.
      env = { ts: parsed.salvaged.ts, ppid: null, event: parsed.salvaged.event, sessionId: parsed.salvaged.sessionId, payload: { session_id: parsed.salvaged.sessionId } }
      stats.salvaged++
    }
    if (!env) { reject(name, parsed.ok ? 'unknown' : parsed.reason); return }
    if (seen.has(name)) {
      stats.duplicates++
      try { unlinkSync(path) } catch { /* fine */ }
      return
    }
    if (!ledger.append(name, env)) {
      // Keep the file: the ledger is the durable record and it refused. Health shows why.
      stats.lastError = ledger.stats().lastError
      return
    }
    seen.add(name)
    try { options.apply?.(env) } catch (error) {
      console.error(`[hook-spool] apply failed for ${name}: ${error instanceof Error ? error.message : error}`)
    }
    stats.ingested++
    stats.lastEventAt = env.ts
    try { unlinkSync(path) } catch { /* a re-read is deduped by `seen` */ }
  }

  const pruneRejected = () => {
    let names: string[]
    try { names = readdirSync(rejectedDir).sort() } catch { return }
    const cutoff = now() - REJECTED_MAX_AGE_MS
    const excess = Math.max(0, names.length - REJECTED_KEEP)
    names.forEach((n, index) => {
      const path = join(rejectedDir, n)
      let old = false
      try { old = statSync(path).mtimeMs < cutoff } catch { return }
      if (index < excess || old) { try { unlinkSync(path) } catch { /* fine */ } }
    })
  }

  const sweep = (): number => {
    if (ticking || stopped) return 0
    ticking = true
    let done = 0
    try {
      const names = listSpool()
      stats.backlog = names.length
      for (const name of names.slice(0, batch)) { ingestOne(name); done++ }
      stats.backlog = Math.max(0, names.length - done)
      stats.lastSweepAt = now()
      stamp()
      if (++pruneCounter % 30 === 0) pruneRejected()
    } finally {
      ticking = false
    }
    return done
  }

  // Startup drain: the whole backlog, in bounded batches, before anyone asks.
  while (sweep() === batch && !stopped) { /* keep draining */ }

  const timer = setInterval(sweep, sweepMs)
  timer.unref()
  try {
    watcher = watch(dir, { persistent: false }, () => { sweep() })
    watcher.on('error', () => { /* the interval is the guaranteed path */ })
  } catch { watcher = null }

  return {
    sweep,
    stop() {
      stopped = true
      clearInterval(timer)
      try { watcher?.close() } catch { /* fine */ }
    },
    stats: () => ({ ...stats }),
  }
}
