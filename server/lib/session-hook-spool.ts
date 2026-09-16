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

/** A code, never a message: raw fs messages carry the home path and health is public. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && code) return code
  return error instanceof Error ? error.name || 'Error' : 'error'
}

/** A hook killed mid-write leaves `.tmp.*`; reap those older than this. */
export const TMP_MAX_AGE_MS = 10 * 60_000
/** The startup drain never loops more times than a full spool needs. */
export const STARTUP_MAX_PASSES = Math.ceil(2_000 / SPOOL_BATCH) + 1

export interface SpoolIngesterOptions {
  dir: string
  ledger: SessionHookLedger
  /** Apply a parsed envelope to the store. Absent when the feature is off. */
  apply?: (env: HookEnvelope, child: boolean, entrypoint: string | null) => void
  /** Classify the envelope's ppid at INGEST time, while the pid is still alive. */
  isChild?: (env: HookEnvelope) => boolean
  /**
   * The session's registry `entrypoint`, read at INGEST time while the record is alive
   * (6.48.1). Written onto the ledger row so a replay after a restart knows a print run
   * from a tab without a registry that has since been reaped.
   */
  entrypointOf?: (env: HookEnvelope, child: boolean) => string | null
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
  /** Files a sweep visited and could not remove (ledger refused, unreadable). */
  stuck: number
  /** Non-`.json` names in the spool that are not ours; they count against the script's cap. */
  foreign: number
  applyErrors: number
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
  const stats: SpoolStats = { ingested: 0, rejected: 0, salvaged: 0, duplicates: 0, stuck: 0, foreign: 0, applyErrors: 0, backlog: 0, lastSweepAt: null, lastEventAt: null, lastError: null }
  let ticking = false
  let stopped = false
  let watcher: FSWatcher | null = null
  let pruneCounter = 0
  let lastStampAt = 0
  let loggedStuck = false

  try { mkdirSync(rejectedDir, { recursive: true, mode: 0o700 }) } catch { /* the sweep reports it */ }

  // The stamp is a metadata change inside the watched directory, so it would wake the
  // watcher, which would sweep, which would stamp: touched at most once per sweep interval.
  const stamp = () => {
    const t = now()
    if (t - lastStampAt < sweepMs) return
    lastStampAt = t
    const path = join(dir, LAST_DRAIN_STAMP)
    try {
      if (existsSync(path)) { const d = new Date(t); utimesSync(path, d, d) } else writeFileSync(path, '', { mode: 0o600 })
    } catch { /* a missing stamp only makes the script cautious */ }
  }

  /** Spool order: the millisecond stamp, then the pid, both as numbers (a pid wrap must not reorder). */
  const spoolOrder = (a: string, b: string): number => {
    const ma = SPOOL_FILE_RE.exec(a)!, mb = SPOOL_FILE_RE.exec(b)!
    return (Number(ma[1]) - Number(mb[1])) || (Number(ma[2]) - Number(mb[2])) || a.localeCompare(b)
  }

  const listSpool = (): string[] => {
    let names: string[]
    try { names = readdirSync(dir) } catch (error) {
      stats.lastError = errorCode(error)
      return []
    }
    // A `.json` whose name the script never writes (a partial rename) is moved aside so the
    // count the script sees stays honest and `backlog` never hides it. Anything else that is
    // not ours (a stray file someone dropped here) is left where it is and only counted.
    let foreign = 0
    for (const n of names) {
      if (SPOOL_FILE_RE.test(n) || n === 'rejected' || n === LAST_DRAIN_STAMP) continue
      if (n.startsWith('.tmp.')) {
        try { if (now() - statSync(join(dir, n)).mtimeMs > TMP_MAX_AGE_MS) unlinkSync(join(dir, n)) } catch { /* fine */ }
        continue
      }
      if (n.startsWith('.')) continue
      if (!n.endsWith('.json')) { foreign++; continue }
      try { renameSync(join(dir, n), join(rejectedDir, `${n}.unrecognized`)) ; stats.rejected++ } catch { /* fine */ }
    }
    stats.foreign = foreign
    return names.filter(n => SPOOL_FILE_RE.test(n)).sort(spoolOrder)
  }

  const reject = (name: string, reason: string) => {
    stats.rejected++
    try { renameSync(join(dir, name), join(rejectedDir, `${name}.${reason}`)) } catch {
      try { unlinkSync(join(dir, name)) } catch { /* gone already */ }
    }
  }

  /** True when the file is gone afterwards (ingested, rejected or deduped); false when it stays. */
  const ingestOne = (name: string): boolean => {
    const path = join(dir, name)
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch {
      // Raced a rename, or unreadable: the next sweep sees it or not; it is not progress.
      return !existsSync(path)
    }
    let parsed: ReturnType<typeof parseHookEnvelope>
    try { parsed = parseHookEnvelope(text) } catch (error) {
      stats.lastError = errorCode(error)
      reject(name, 'parse_threw')
      return true
    }
    let env: HookEnvelope | null = null
    if (parsed.ok) {
      env = parsed.envelope
    } else if (parsed.salvaged) {
      // A cut Stop still turns the row idle; nothing else in the file is trusted.
      env = { ts: parsed.salvaged.ts, ppid: null, event: parsed.salvaged.event, sessionId: parsed.salvaged.sessionId, payload: { session_id: parsed.salvaged.sessionId } }
      stats.salvaged++
    }
    if (!env) { reject(name, parsed.ok ? 'unknown' : parsed.reason); return true }
    if (seen.has(name)) {
      stats.duplicates++
      try { unlinkSync(path) } catch { /* fine */ }
      return true
    }
    // Classified NOW, while the child pid is alive; the ledger row remembers the verdict so a
    // replay after a restart (when the spawn ledger is empty) applies the same rule.
    let child = false
    try { child = options.isChild?.(env) ?? false } catch { child = false }
    let entrypoint: string | null = null
    try { entrypoint = options.entrypointOf?.(env, child) ?? null } catch { entrypoint = null }
    let appended = false
    try { appended = ledger.append(name, env, child, entrypoint) } catch (error) { stats.lastError = errorCode(error) }
    if (!appended) {
      // Keep the file: the ledger is the durable record and it refused. Health shows why.
      stats.lastError = ledger.stats().lastError ?? stats.lastError
      return false
    }
    seen.add(name)
    try { options.apply?.(env, child, entrypoint) } catch (error) {
      stats.applyErrors++
      console.error(`[hook-spool] apply failed for ${name}: ${error instanceof Error ? error.message : error}`)
    }
    stats.ingested++
    stats.lastEventAt = env.ts
    try { unlinkSync(path) } catch { /* a re-read is deduped by `seen` */ }
    return true
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

  /** Returns the number of files REMOVED this pass; a stuck file is not progress. */
  const sweep = (): number => {
    if (ticking || stopped) return 0
    ticking = true
    let removed = 0
    let stuck = 0
    try {
      const names = listSpool()
      for (const name of names.slice(0, batch)) {
        if (ingestOne(name)) removed++
        else stuck++
      }
      stats.stuck = stuck
      stats.backlog = Math.max(0, names.length - removed)
      stats.lastSweepAt = now()
      if (stuck > 0 && !loggedStuck) {
        loggedStuck = true
        console.error(`[hook-spool] ${stuck} file(s) could not be drained (${stats.lastError ?? 'unknown'}); they stay in ${dir}`)
      }
      if (stuck === 0) loggedStuck = false
      stamp()
      if (++pruneCounter % 30 === 0) pruneRejected()
    } finally {
      ticking = false
    }
    return removed
  }

  // Startup drain: the backlog, in bounded passes, before anyone asks. Bounded twice: a pass
  // that removed nothing ends it (a refusing ledger must never spin the boot), and no
  // backlog needs more passes than a full spool.
  for (let pass = 0; pass < STARTUP_MAX_PASSES && !stopped; pass++) {
    if (sweep() === 0) break
  }

  const timer = setInterval(sweep, sweepMs)
  timer.unref()
  try {
    // Only a spool file is a wake-up. The stamp and the rejected dir change metadata here
    // too, and reacting to them would be a self-sustaining loop.
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (typeof filename === 'string' && SPOOL_FILE_RE.test(filename)) sweep()
    })
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
