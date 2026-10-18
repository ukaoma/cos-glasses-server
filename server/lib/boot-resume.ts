// 6.78.0 (MVP-C): crash-loop parking for work the server resumes on boot. Pi Durable's
// `restartLimit` and `retryTask`, built into COS's own code.
//
// THE LOOP IT STOPS. Two kinds of work are resumed on every boot with no counter:
//   - meeting finalization (routes/meeting.ts resumeMeetingFinalizationJobs), on every boot;
//   - never-started query jobs (query-job-store.ts boot requeue), handed back on every boot
//     for up to 60 minutes.
// If the work itself kills the process, launchd restarts the server about every 10 s and
// every lens goes dark until it stops.
//
// THE RULE. One small ledger in its own file (<data>/boot-resume-ledger.json), so no existing
// store's schema changes and an older build simply ignores it:
//   openBoot           once per process, before any boot resume (startAdmittedRuntime, after
//                      the listeners bind): did the last process exit cleanly? Only a boot
//                      that follows a crash counts. The graceful-shutdown path (SIGTERM/SIGINT,
//                      Update Server, phone Restart) marks a clean exit, so routine restarts
//                      never count. A missing or quarantined ledger reads as a CLEAN previous
//                      boot: the guard never invents a crash it did not see.
//   admit              before resuming one item: the count is written BEFORE the item runs,
//                      so a resume that kills the process is counted. One count per item per
//                      boot. Counts are CONSECUTIVE: a crashed boot adds one only when the
//                      item's previous count is under CRASH_LOOP_WINDOW_MS old; otherwise the
//                      count restarts at 1, so unrelated crashes days apart never park
//                      anything. A new phase means progress, so the count starts over. An
//                      item counted on more than RESTART_LIMIT crashed boots is parked: not
//                      resumed, and left in its own store for Retry.
//   forget             when the item's own store finishes or removes it.
//   retry              the person's Retry: the count starts over and the item is unparked.
//   markCleanShutdown  first thing in the graceful-shutdown path. A clean exit means no crash
//                      loop, so it also resets the counts of every item admitted this boot.
//                      Parked items stay parked; only Retry unparks them.
//
// FAILS OPEN. The guard must never be the thing that crash-loops the server. A corrupt
// ledger is quarantined and read as empty, and any read or write error admits the item and
// logs `boot_resume.fail_open`. Bounded: unparked entries untouched for 7 days are dropped,
// and the file keeps at most 500 entries.
//
// FLAG. COS_CRASH_LOOP_PARKING, read at call time with the shared 6.78.0 reader: `1` /
// `true` / `on` force it on, `0` / `false` / `off` force it off, anything else (unset
// included) is the DEFAULT, which is ON. Off is 6.77.0 behaviour exactly: every item is admitted and the ledger is
// never read or written.
//
// This module imports only node builtins, atomic-fs and the pure env-switch, so the Pi
// Durable canaries (CL-1, CL-2) can load `createBootResumeGate` without reaching a
// live-state module.
import { mkdirSync, renameSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { durableAtomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { readSwitch } from './env-switch.js'

/** Consecutive crashed boots an item may be resumed on. The next one parks it. */
export const RESTART_LIMIT = 3
/** Crashed boots count as consecutive only when each comes within this of the item's last count. */
export const CRASH_LOOP_WINDOW_MS = 30 * 60_000
/**
 * 6.78.0 (P7 S5): a parked meeting finalization gets ONE second chance, on the first boot at
 * least this long after it was parked. A kernel panic storm can park a meeting that was never
 * the cause, and Control has no Retry for it yet. A second park is permanent (until the
 * person's Retry). Query jobs never auto-unpark: the app shows them and offers Retry.
 */
export const AUTO_UNPARK_AFTER_MS = 30 * 60_000
/** The kinds that get the one automatic second chance. */
const AUTO_UNPARK_KINDS: ReadonlySet<string> = new Set(['meeting_finalization'])
/** The ledger's file name under the data directory. */
export const BOOT_RESUME_LEDGER_FILE = 'boot-resume-ledger.json'
/** The kinds of boot-resumed work the server gates. */
export const BOOT_RESUME_KINDS = ['meeting_finalization', 'query_job'] as const
export type BootResumeKind = typeof BOOT_RESUME_KINDS[number]
/** `error.code` and parked `reason` of an item stopped by the limit. */
export const RESTART_LIMIT_CODE = 'restart_limit'
/** `error.cause` of a query job the limit stopped. */
export const CRASH_LOOP_PARKED_CAUSE = 'crash_loop_parked'

const MAX_ENTRIES = 500
const STALE_MS = 7 * 86_400_000

export function isBootResumeKind(value: unknown): value is BootResumeKind {
  return typeof value === 'string' && (BOOT_RESUME_KINDS as readonly string[]).includes(value)
}

/** Default ON, read through the one 6.78.0 switch reader (lib/env-switch.ts). */
export function isCrashLoopParkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_CRASH_LOOP_PARKING, true)
}

/** What the person reads on the lens and phone: fits a 32-column footer lead. No dashes or arrows. */
export function restartLimitMessage(limit = RESTART_LIMIT): string {
  return `Stopped after ${limit} server crashes.`
}

/** The terminal error of a query job the limit stopped (status `interrupted`). */
export function crashLoopParkedError(limit = RESTART_LIMIT): { code: string; message: string; retryable: true; cause: string } {
  return { code: RESTART_LIMIT_CODE, message: restartLimitMessage(limit), retryable: true, cause: CRASH_LOOP_PARKED_CAUSE }
}

export interface BootResumeEntry {
  kind: string
  id: string
  phase: string
  attempts: number
  parked: boolean
  reason: string | null
  parkedAt: string | null
  retriedAt: string | null
  /** When the last crashed boot counted it (the consecutive-window anchor). */
  lastAttemptAt: string | null
  /** 6.78.0 (P7 S5): when the one automatic second chance unparked it. Set once, never cleared. */
  autoRetriedAt: string | null
  updatedAt: string
}

/** One row of `parked[]` in /api/maintenance/status. */
export interface ParkedBootResume {
  kind: string
  id: string
  phase: string
  attempts: number
  parkedAt: string | null
  reason: string | null
}

export interface BootResumeStatus {
  enabled: boolean
  /** Null until this process has opened its boot (or when the switch is off). */
  crashedBoot: boolean | null
  limit: number
  parked: ParkedBootResume[]
}

export interface BootResumeGate {
  readonly limit: number
  /** Once per process, before any boot resume. Idempotent. */
  openBoot(): void
  /** Before resuming one item. False: parked, do not resume it. */
  admit(kind: string, id: string, phase: string): boolean
  markCleanShutdown(): void
  status(): BootResumeStatus
  status(kind: string, id: string): BootResumeEntry | null
  forget(kind: string, id: string): void
  /** The person's Retry. The entry after the reset, or null when there was none. */
  retry(kind: string, id: string): BootResumeEntry | null
  isParked(kind: string, id: string): boolean
}

export type BootResumeLog = (level: 'info' | 'warn', event: string, detail: Record<string, unknown>) => void

export interface BootResumeGateOptions {
  path: string
  limit?: number
  /** Read on every call (the switch is not cached). */
  env?: NodeJS.ProcessEnv
  now?: () => number
  log?: BootResumeLog
  /** Tests only: the durable writer. */
  writeFile?: (path: string, data: string) => void
}

interface LedgerFile {
  version: 1
  cleanShutdown: boolean
  entries: Record<string, BootResumeEntry>
}

/** The server's log channel, in the `[event] {json}` shape other server breadcrumbs use. */
const defaultLog: BootResumeLog = (level, event, detail) => {
  const line = `[${event}] ${JSON.stringify(detail)}`
  if (level === 'warn') console.warn(line)
  else console.log(line)
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'error'
}

function parseEntry(key: string, raw: unknown): BootResumeEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  const split = key.indexOf(':')
  const kind = typeof e.kind === 'string' && e.kind ? e.kind : split > 0 ? key.slice(0, split) : ''
  const id = typeof e.id === 'string' && e.id ? e.id : split > 0 ? key.slice(split + 1) : ''
  if (!kind || !id || keyOf(kind, id) !== key) return null
  if (typeof e.phase !== 'string' || typeof e.parked !== 'boolean') return null
  if (typeof e.attempts !== 'number' || !Number.isSafeInteger(e.attempts) || e.attempts < 0) return null
  const text = (value: unknown) => typeof value === 'string' ? value : null
  return {
    kind, id, phase: e.phase, attempts: e.attempts, parked: e.parked,
    reason: text(e.reason), parkedAt: text(e.parkedAt), retriedAt: text(e.retriedAt),
    lastAttemptAt: text(e.lastAttemptAt),
    autoRetriedAt: text(e.autoRetriedAt),
    updatedAt: text(e.updatedAt) ?? new Date(0).toISOString(),
  }
}

function parseLedger(raw: unknown): LedgerFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const entries: Record<string, BootResumeEntry> = {}
  if (value.entries !== undefined) {
    if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return null
    for (const [key, item] of Object.entries(value.entries as Record<string, unknown>)) {
      const entry = parseEntry(key, item)
      if (entry) entries[key] = entry
    }
  }
  return { version: 1, cleanShutdown: value.cleanShutdown === true, entries }
}

/** Drop unparked entries untouched for 7 days, then keep at most 500 (parked first, newest first). */
function prune(file: LedgerFile, nowMs: number): void {
  for (const [key, entry] of Object.entries(file.entries)) {
    if (entry.parked) continue
    const touched = Date.parse(entry.updatedAt)
    if (!Number.isFinite(touched) || nowMs - touched > STALE_MS) delete file.entries[key]
  }
  const keys = Object.keys(file.entries)
  if (keys.length <= MAX_ENTRIES) return
  const time = (entry: BootResumeEntry) => Date.parse(entry.updatedAt) || 0
  const ranked = keys.sort((a, b) => {
    const x = file.entries[a]!, y = file.entries[b]!
    return Number(y.parked) - Number(x.parked) || time(y) - time(x)
  })
  for (const key of ranked.slice(MAX_ENTRIES)) delete file.entries[key]
}

function parkedView(entry: BootResumeEntry): ParkedBootResume {
  return { kind: entry.kind, id: entry.id, phase: entry.phase, attempts: entry.attempts, parkedAt: entry.parkedAt, reason: entry.reason }
}

class LedgerGate implements BootResumeGate {
  readonly limit: number
  private readonly path: string
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly log: BootResumeLog
  private readonly writeFile: (path: string, data: string) => void
  private file: LedgerFile | null = null
  private loaded: 'missing' | 'ok' | 'corrupt' | 'unreadable' = 'missing'
  private opened = false
  private crashedBoot: boolean | null = null
  /** Items already counted (or seen parked) by this process: one count per item per boot. */
  private readonly seenThisBoot = new Set<string>()

  constructor(options: BootResumeGateOptions) {
    this.path = options.path
    this.limit = Math.max(1, Math.floor(options.limit ?? RESTART_LIMIT))
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.log = options.log ?? defaultLog
    this.writeFile = options.writeFile ?? ((path, data) => durableAtomicWriteFileSync(path, data, { mode: 0o600 }))
  }

  private enabled(): boolean {
    return isCrashLoopParkingEnabled(this.env)
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private failOpen(op: string, error: unknown): void {
    try { this.log('warn', 'boot_resume.fail_open', { op, error: errorCode(error) }) } catch { /* logging never throws upward */ }
  }

  /** Loaded once, on first use. A corrupt or wrong-shaped file is set aside and read as empty. */
  private ledger(): LedgerFile {
    if (this.file) return this.file
    let file: LedgerFile = { version: 1, cleanShutdown: false, entries: {} }
    try {
      const result = loadJsonOrQuarantine<unknown>(this.path)
      if (result.status === 'ok') {
        const parsed = parseLedger(result.data)
        if (parsed) {
          file = parsed
          this.loaded = 'ok'
        } else {
          this.loaded = 'corrupt'
          let quarantinedAs: string | null = `${this.path}.corrupt-${this.now()}`
          try { renameSync(this.path, quarantinedAs) } catch { quarantinedAs = null }
          this.failOpen('load', Object.assign(new Error('ledger shape'), { code: 'ledger_shape' }))
          if (quarantinedAs) this.log('warn', 'boot_resume.fail_open', { op: 'quarantine', quarantinedAs: basename(quarantinedAs) })
        }
      } else if (result.status === 'corrupt') {
        this.loaded = 'corrupt'
        this.log('warn', 'boot_resume.fail_open', { op: 'quarantine', quarantinedAs: basename(result.quarantinedAs) })
      }
      // `missing`: no ledger yet. It reads as a CLEAN previous boot (openBoot counts a crash
      // only from a ledger read back intact), so a loop already running when this build was
      // installed starts counting on the next crashed boot and parks one boot later.
    } catch (error) {
      this.loaded = 'unreadable'
      this.failOpen('load', error)
    }
    this.file = file
    return file
  }

  /** Durable write. False (and logged) on any error: the caller fails open. */
  private save(op: string): boolean {
    try {
      const file = this.ledger()
      prune(file, this.now())
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      this.writeFile(this.path, `${JSON.stringify(file)}\n`)
      return true
    } catch (error) {
      this.failOpen(op, error)
      return false
    }
  }

  openBoot(): void {
    if (!this.enabled() || this.opened) return
    this.opened = true
    try {
      const file = this.ledger()
      // Only a ledger this build read back intact can say the last exit was a crash.
      this.crashedBoot = this.loaded === 'ok' && !file.cleanShutdown
      file.cleanShutdown = false
      this.save('open')
      const entries = Object.values(file.entries)
      this.log('info', 'boot_resume.open', {
        crashedBoot: this.crashedBoot,
        ledger: this.loaded,
        entries: entries.length,
        parked: entries.filter(entry => entry.parked).length,
      })
    } catch (error) {
      this.crashedBoot = false
      this.failOpen('open', error)
    }
  }

  admit(kind: string, id: string, phase: string): boolean {
    if (!this.enabled()) return true
    try {
      this.openBoot()
      const file = this.ledger()
      const key = keyOf(kind, id)
      const before = file.entries[key]
      let entry: BootResumeEntry | undefined = before ? { ...before } : undefined
      let changed = false
      if (before?.parked) {
        if (!this.secondChanceDue(before)) {
          this.seenThisBoot.add(key)
          this.log('warn', 'boot_resume.parked', { kind, id, phase: before.phase, attempts: before.attempts, newly: false })
          return false
        }
        // The one automatic second chance (P7 S5): unparked with a fresh count, then counted
        // below like any item, so a crash on this boot is attempt 1 of a new run of three.
        const at = this.iso()
        entry = { ...before, attempts: 0, parked: false, reason: null, parkedAt: null, lastAttemptAt: null, autoRetriedAt: at, updatedAt: at }
        changed = true
        this.log('info', 'boot_resume.auto_unpark', { kind, id, phase: before.phase, parkedAt: before.parkedAt })
      }
      if (entry && entry.phase !== phase) {
        // Progress since the last count: it starts over.
        entry.phase = phase
        entry.attempts = 0
        changed = true
      }
      const counts = this.crashedBoot === true && !this.seenThisBoot.has(key)
      this.seenThisBoot.add(key)
      if (counts) {
        entry ??= { kind, id, phase, attempts: 0, parked: false, reason: null, parkedAt: null, retriedAt: null, lastAttemptAt: null, autoRetriedAt: null, updatedAt: this.iso() }
        const last = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : Number.NaN
        const consecutive = Number.isFinite(last) && this.now() - last < CRASH_LOOP_WINDOW_MS
        entry.attempts = consecutive ? entry.attempts + 1 : 1
        entry.lastAttemptAt = this.iso()
        changed = true
      }
      if (!changed || !entry) return true
      entry.updatedAt = this.iso()
      if (entry.attempts > this.limit) {
        entry.parked = true
        entry.reason = RESTART_LIMIT_CODE
        entry.parkedAt = entry.updatedAt
      }
      file.entries[key] = entry
      if (!this.save('admit')) {
        // FAILS OPEN: an unrecorded count must never park anything. (An unrecorded second
        // chance still runs: failing open admits the item.)
        if (before) file.entries[key] = before
        else delete file.entries[key]
        return true
      }
      if (entry.parked) {
        this.log('warn', 'boot_resume.parked', { kind, id, phase, attempts: entry.attempts, limit: this.limit, newly: true })
        return false
      }
      return true
    } catch (error) {
      this.failOpen('admit', error)
      return true
    }
  }

  /** A parked meeting finalization's one automatic second chance, 30 minutes after its park. */
  private secondChanceDue(entry: BootResumeEntry): boolean {
    if (!AUTO_UNPARK_KINDS.has(entry.kind) || entry.autoRetriedAt !== null) return false
    const parkedAt = entry.parkedAt ? Date.parse(entry.parkedAt) : Number.NaN
    return Number.isFinite(parkedAt) && this.now() - parkedAt >= AUTO_UNPARK_AFTER_MS
  }

  markCleanShutdown(): void {
    // Only the process that opened its boot owns the marker. One that never resumed
    // anything leaves the previous exit's record as it found it.
    if (!this.enabled() || !this.opened) return
    try {
      const file = this.ledger()
      file.cleanShutdown = true
      // No crash loop: every item this boot admitted starts over. Parked items stay parked.
      for (const key of this.seenThisBoot) {
        const entry = file.entries[key]
        if (!entry || entry.parked) continue
        file.entries[key] = { ...entry, attempts: 0, lastAttemptAt: null, updatedAt: this.iso() }
      }
      this.save('clean_shutdown')
    } catch (error) {
      this.failOpen('clean_shutdown', error)
    }
  }

  status(): BootResumeStatus
  status(kind: string, id: string): BootResumeEntry | null
  status(kind?: string, id?: string): BootResumeStatus | BootResumeEntry | null {
    if (kind !== undefined && id !== undefined) {
      if (!this.enabled()) return null
      try {
        const entry = this.ledger().entries[keyOf(kind, id)]
        return entry ? { ...entry } : null
      } catch {
        return null
      }
    }
    if (!this.enabled()) return { enabled: false, crashedBoot: null, limit: this.limit, parked: [] }
    try {
      const parked = Object.values(this.ledger().entries)
        .filter(entry => entry.parked)
        .sort((a, b) => (a.parkedAt ?? '').localeCompare(b.parkedAt ?? '') || a.id.localeCompare(b.id))
        .map(parkedView)
      return { enabled: true, crashedBoot: this.crashedBoot, limit: this.limit, parked }
    } catch {
      return { enabled: true, crashedBoot: this.crashedBoot, limit: this.limit, parked: [] }
    }
  }

  forget(kind: string, id: string): void {
    if (!this.enabled()) return
    try {
      const file = this.ledger()
      const key = keyOf(kind, id)
      if (!(key in file.entries)) return
      delete file.entries[key]
      this.save('forget')
    } catch (error) {
      this.failOpen('forget', error)
    }
  }

  retry(kind: string, id: string): BootResumeEntry | null {
    if (!this.enabled()) return null
    try {
      const file = this.ledger()
      const key = keyOf(kind, id)
      const before = file.entries[key]
      if (!before) return null
      const at = this.iso()
      const entry: BootResumeEntry = { ...before, attempts: 0, parked: false, reason: null, parkedAt: null, retriedAt: at, lastAttemptAt: null, updatedAt: at }
      file.entries[key] = entry
      // A failed write still unparks in memory (fails open); the next boot may need Retry again.
      this.save('retry')
      this.log('info', 'boot_resume.retry', { kind, id, phase: entry.phase, wasParked: before.parked, attemptsBefore: before.attempts })
      return { ...entry }
    } catch (error) {
      this.failOpen('retry', error)
      return null
    }
  }

  isParked(kind: string, id: string): boolean {
    if (!this.enabled()) return false
    try {
      return this.ledger().entries[keyOf(kind, id)]?.parked === true
    } catch {
      return false
    }
  }
}

/** One gate per process at boot (index.ts); one per simulated boot in the canaries. Never throws. */
export function createBootResumeGate(options: BootResumeGateOptions): BootResumeGate {
  return new LedgerGate(options)
}

// ── The process's gate ──────────────────────────────────────────────────────────────────
// index.ts installs one gate at boot. Before that (and in any test that installs none) every
// caller gets a gate that admits everything and writes nothing, which is 6.77.0 behaviour.

const NOT_INSTALLED: BootResumeGate = {
  limit: RESTART_LIMIT,
  openBoot: () => {},
  admit: () => true,
  markCleanShutdown: () => {},
  status: ((kind?: string, id?: string) => kind !== undefined && id !== undefined
    ? null
    : { enabled: false, crashedBoot: null, limit: RESTART_LIMIT, parked: [] }) as BootResumeGate['status'],
  forget: () => {},
  retry: () => null,
  isParked: () => false,
}

let installed: BootResumeGate | null = null
const resumers = new Map<BootResumeKind, (id: string) => void>()

/**
 * Install the process's gate, and what a Retry of each kind re-runs (a meeting finalization
 * is resumed again; a query job runs again when the app Retries it, so it has none). Null resets
 * both, for tests.
 */
export function installBootResumeGate(
  gate: BootResumeGate | null,
  options: { resume?: Partial<Record<BootResumeKind, (id: string) => void>> } = {},
): BootResumeGate {
  installed = gate
  resumers.clear()
  for (const kind of BOOT_RESUME_KINDS) {
    const resume = options.resume?.[kind]
    if (resume) resumers.set(kind, resume)
  }
  return gate ?? NOT_INSTALLED
}

/** The process's gate, or a pass-through one before index.ts installs it. */
export function bootResumeGate(): BootResumeGate {
  return installed ?? NOT_INSTALLED
}

/** After a Retry: re-run the item's resume, if its kind has one. True when it ran. Never throws. */
export function resumeRetriedItem(kind: BootResumeKind, id: string): boolean {
  const resume = resumers.get(kind)
  if (!resume) return false
  try {
    resume(id)
    return true
  } catch (error) {
    defaultLog('warn', 'boot_resume.fail_open', { op: 'resume_after_retry', kind, id, error: errorCode(error) })
    return false
  }
}
