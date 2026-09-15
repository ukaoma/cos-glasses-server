// The Fireflies importer: vendor meetings into the imported library.
//
// REFUSED ON A PIPELINE MAC. `meetingEngineMode()` decides, and on a Mac whose
// COS pipeline already files Fireflies meetings this returns 409
// operations_pipeline_owns_fireflies and writes nothing at all.
//
// HOW IT STOPS:
//   - one run at a time (a second gets 409 import_in_progress);
//   - the client's daily budget, plus a poll ceiling of half of it;
//   - a window (7, 30 or 90 days) and the vendor's newest-first order, so a
//     pass ends at the first meeting older than the window;
//   - a sticky invalid_key that refuses further runs until the key changes;
//   - a maintenance lease per page, and a drain defers the page instead of
//     fighting it.
//
// THE LEASE IS HELD OVER THE WRITE, NOT THE FETCH, and that is deliberate. A
// page fetch can legitimately take 30 s, and with vendor 5xx retries (5, 15 and
// 30 s) far longer. COS Control's drain timeout is 90 s (main.swift
// waitForRestartProof), so holding the lease across the network would turn a
// slow vendor into a failed Update Server. Nothing is written during the fetch,
// and the cursor is durable, so a drain that lands mid-fetch costs one repeated
// page and no data.
//
// COUNTS COME FROM A RE-LIST, never from a counter this code increments. After
// each write the library must return the hash, or the run stops with
// write_unlisted: a writer that believes it wrote and a library that cannot see
// the record is the one failure that would otherwise be silent.

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { getFirefliesBudget, getFirefliesClient, getFirefliesKeyStore } from './fireflies-key.js'
import {
  FirefliesClient,
  type FirefliesBudget,
  type FirefliesFailureState,
  type FirefliesKeyCheck,
  type FirefliesPlan,
  type FirefliesSkipReason,
  type FirefliesTranscriptRecord,
  normalizeFirefliesTranscript,
} from './fireflies-client.js'
import {
  DEFAULT_ORIGIN_DOMAIN,
  type ImportedMeetingLibrary,
  type ImportedRecordWrite,
  actionItemLines,
  getImportedMeetingLibrary,
  importHash,
  importRecordId,
  importsRoot,
  localDateParts,
  renderImportMarkdown,
} from './imported-meeting-library.js'
import { acquireMaintenanceWork, maintenanceAdmissionsOpen, type MaintenanceWorkLease } from './maintenance-lifecycle.js'
import { meetingEngineMode, type MeetingEngineMode } from './meeting-engine-mode.js'
import { triggerMeetingMergeRun } from './meeting-actions.js'
import { securePrivateDirectory } from './secure-user-config.js'

export const IMPORT_WINDOW_DAYS = [7, 30, 90] as const
export const DEFAULT_IMPORT_WINDOW_DAYS = 30
export const IMPORT_POLL_TICK_MS = 30_000
export const IMPORT_POLL_INTERVAL_MS = 6 * 60 * 60_000
/** A poll may spend at most this share of the day's cap. */
export const IMPORT_POLL_BUDGET_SHARE = 0.5
export const STILL_PROCESSING_BACKOFF_MS = 60 * 60_000
export const STILL_PROCESSING_MAX_ATTEMPTS = 24
/**
 * Hard bound on one run, in pages.
 *
 * Every other stop condition depends on the vendor behaving: the window ends a
 * pass only if a meeting is older than it, and the end of the list only if a
 * page comes back short. The daily cap bounds the capped plans, but a Business
 * plan has NO daily cap, so a vendor that answers every page with a full one
 * would page forever. 200 pages is 10,000 meetings, far past a 90-day backfill.
 */
export const IMPORT_MAX_PAGES_PER_RUN = 200
export const IMPORT_LEDGER_FILENAME = '.fireflies-ledger.json'
/** Bound on remembered hashes, so a ledger cannot grow without limit. */
export const IMPORT_LEDGER_MAX_HASHES = 20_000
export const MS_PER_DAY = 24 * 60 * 60_000

export type ImportState =
  | 'idle'
  | 'running'
  | 'ok'
  | 'partial'
  | 'invalid_key'
  | 'rate_limited'
  | 'vendor_down'
  | 'unreachable'
  | 'write_unlisted'
  | 'refused_pipeline'

export type ImportSkipReason =
  | FirefliesSkipReason
  | 'never_transcribed'
  | 'duration_unknown'
  | 'response_too_large'

/** What each skip reason means for the meeting behind it. */
export const IMPORT_SKIP_KIND: Record<ImportSkipReason, 'terminal' | 'retryable' | 'imported' | 'alarm'> = {
  missing_id: 'terminal',
  missing_date: 'terminal',
  date_string: 'terminal',
  malformed_sentences: 'terminal',
  still_processing: 'retryable',
  response_too_large: 'retryable',
  never_transcribed: 'terminal',
  id_shape_changed: 'alarm',
  duration_unknown: 'imported',
}

export interface ImportRunSummary {
  runId: string
  trigger: 'manual' | 'poll'
  windowDays: number
  startedAt: string
  finishedAt?: string
  state: ImportState
  stopReason?: string
  pages: number
  calls: number
  written: number
  seen: number
  failure?: { state: FirefliesFailureState; httpStatus?: number; retryAfterSeconds?: number; code?: string }
}

interface ImportLedger {
  version: 1
  window: { days: number }
  cursor: number
  vendorSeen: string[]
  completed: string[]
  skipped: Record<string, string[]>
  retryable: Record<string, { reason: ImportSkipReason; attempts: number; nextAt: string }>
  lastRun?: ImportRunSummary
  state: ImportState
  keepImporting: boolean
  keyFingerprint?: string
  lastPassCompletedAt?: string
  /** Set by a rate limit. The poll waits for it. */
  nextAttemptAt?: string
}

export class ImportRefusedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ImportRefusedError'
  }
}

function emptyLedger(): ImportLedger {
  return {
    version: 1,
    window: { days: DEFAULT_IMPORT_WINDOW_DAYS },
    cursor: 0,
    vendorSeen: [],
    completed: [],
    skipped: {},
    retryable: {},
    state: 'idle',
    // D7: importing stays on once a key is connected. The poll still refuses
    // without a key, in advise mode, and while admissions are closed.
    keepImporting: true,
  }
}

function bounded(values: string[]): string[] {
  return values.length <= IMPORT_LEDGER_MAX_HASHES ? values : values.slice(values.length - IMPORT_LEDGER_MAX_HASHES)
}

/** A stable key for a transcript too broken to have an identity of its own. */
function unusableKey(raw: unknown): string {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const shape = JSON.stringify({
    id: typeof item.id === 'string' ? item.id : null,
    date: typeof item.date === 'number' || typeof item.date === 'string' ? item.date : null,
    title: typeof item.title === 'string' ? item.title : null,
  })
  return createHash('sha256').update(`fireflies-unusable:${shape}`).digest('hex').slice(0, 16)
}

/** Vendor record to the pair of files the library writes. */
export function buildFirefliesImport(
  record: FirefliesTranscriptRecord,
  options: { originDomain?: string; importedAt: string },
): ImportedRecordWrite {
  const hash = importHash(record.id)
  const parts = localDateParts(record.dateMs)
  const originDomain = options.originDomain ?? DEFAULT_ORIGIN_DOMAIN
  const speakers = [...new Set(record.sentences.map(sentence => sentence.speakerName).filter(Boolean))]
  const attendees = record.participants.length > 0 ? record.participants : speakers

  const actionItems = actionItemLines(record.actionItems)
  const markdown = renderImportMarkdown({
    title: record.title,
    dateMs: record.dateMs,
    durationSeconds: record.durationSeconds,
    attendees,
    ...(record.overview ? { overview: record.overview } : {}),
    ...(actionItems.length > 0 ? { actionItems } : {}),
    sentences: record.sentences.map(sentence => ({
      speakerName: sentence.speakerName,
      text: sentence.text,
      startTime: sentence.startTime,
    })),
  })

  return {
    kind: 'fireflies',
    hash,
    dateMs: record.dateMs,
    markdown,
    // Key order matters: the list reads `originDomain` out of the first 4 KiB
    // rather than parsing a sidecar that can run to megabytes, so the small
    // fields go first and `sentences` goes last.
    sidecar: {
      schemaVersion: 1,
      kind: 'fireflies',
      recordId: importRecordId('fireflies', hash),
      originDomain,
      source: 'fireflies',
      firefliesId: record.id,
      date: parts.date,
      time: parts.time,
      dateMs: record.dateMs,
      durationSeconds: record.durationSeconds,
      durationSource: record.durationSource,
      // The engine never pairs a meeting whose length is unknown: an interval
      // with no end overlaps everything.
      pairable: record.durationSeconds != null,
      organizerEmail: record.organizerEmail,
      participants: record.participants,
      speakers,
      sentenceCount: record.sentences.length,
      importedAt: options.importedAt,
      title: record.title,
      // The vendor's own summary, kept unedited beside the rendered record.
      // The markdown collapses `##` and `**` to keep a sentence from forging a
      // section; the sidecar is where the original survives that.
      overview: record.overview,
      actionItems: record.actionItems,
      keywords: record.keywords,
      sentences: record.sentences,
    },
  }
}

export interface FirefliesImporterDeps {
  library: ImportedMeetingLibrary
  client: FirefliesClient
  budget: FirefliesBudget
  key: () => string | null
  ledgerPath?: string
  mode?: () => MeetingEngineMode
  acquireLease?: () => MaintenanceWorkLease
  admissionsOpen?: () => boolean
  now?: () => number
  /** WS4 hooks the engine runner here when a page is sealed. */
  onPageSealed?: (summary: { runId: string; written: string[] }) => void
  log?: (line: string) => void
}

export interface ImportStatus {
  mode: MeetingEngineMode
  state: ImportState
  running: boolean
  keyConfigured: boolean
  keepImporting: boolean
  planCap: FirefliesPlan
  windowDays: number
  cursor: number
  counts: {
    imported: number
    vendorSeen: number
    retryable: number
    skipped: Record<string, number>
  }
  skipKinds: Record<string, string>
  budget: { day: string; calls: number; cap: number | null; remaining: number | null }
  lastRun?: ImportRunSummary
  nextAttemptAt?: string
  lastPassCompletedAt?: string
}

export class FirefliesImporter {
  private readonly deps: FirefliesImporterDeps
  private readonly ledgerPath: string
  private readonly now: () => number
  private readonly mode: () => MeetingEngineMode
  private readonly acquireLease: () => MaintenanceWorkLease
  private readonly admissionsOpen: () => boolean
  private readonly log: (line: string) => void
  private ledger: ImportLedger
  private active: Promise<ImportRunSummary> | null = null
  private stopRequested = false
  private startedAtMs: number

  constructor(deps: FirefliesImporterDeps) {
    this.deps = deps
    this.ledgerPath = deps.ledgerPath ?? importsRoot(IMPORT_LEDGER_FILENAME)
    this.now = deps.now ?? (() => Date.now())
    this.mode = deps.mode ?? meetingEngineMode
    this.acquireLease = deps.acquireLease ?? (() => acquireMaintenanceWork('meeting_import'))
    this.admissionsOpen = deps.admissionsOpen ?? maintenanceAdmissionsOpen
    this.log = deps.log ?? ((line: string) => console.log(`[meeting-import] ${line}`))
    this.ledger = this.load()
    this.startedAtMs = this.now()
  }

  private load(): ImportLedger {
    let raw: string
    try {
      raw = readFileSync(this.ledgerPath, 'utf8')
    } catch {
      return emptyLedger()
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ImportLedger>
      const base = emptyLedger()
      return {
        ...base,
        ...parsed,
        version: 1,
        window: { days: typeof parsed.window?.days === 'number' ? parsed.window.days : base.window.days },
        cursor: typeof parsed.cursor === 'number' && parsed.cursor >= 0 ? Math.trunc(parsed.cursor) : 0,
        vendorSeen: Array.isArray(parsed.vendorSeen) ? parsed.vendorSeen.filter(v => typeof v === 'string') : [],
        completed: Array.isArray(parsed.completed) ? parsed.completed.filter(v => typeof v === 'string') : [],
        skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {},
        retryable: parsed.retryable && typeof parsed.retryable === 'object' ? parsed.retryable : {},
        keepImporting: parsed.keepImporting !== false,
        // A run that was in flight when the process died is not running now.
        state: parsed.state === 'running' ? 'partial' : (parsed.state ?? 'idle'),
      }
    } catch {
      return emptyLedger()
    }
  }

  private save(): void {
    this.ledger.vendorSeen = bounded(this.ledger.vendorSeen)
    this.ledger.completed = bounded(this.ledger.completed)
    // The ledger's OWN directory, not the default imports root: the path is
    // injectable, and securing a directory the ledger does not live in would
    // both miss the real one and touch a tree this instance was told to leave
    // alone.
    securePrivateDirectory(dirname(this.ledgerPath))
    durableAtomicWriteFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2), { mode: 0o600 })
  }

  private keyFingerprint(): string | undefined {
    const key = this.deps.key()
    return key ? FirefliesClient.fingerprint(key) : undefined
  }

  /** A key that is known bad stays refused until it changes. */
  private stickyInvalidKey(): boolean {
    if (this.ledger.state !== 'invalid_key') return false
    const fingerprint = this.keyFingerprint()
    return fingerprint != null && fingerprint === this.ledger.keyFingerprint
  }

  onKeyChanged(): void {
    if (this.ledger.state === 'invalid_key') {
      this.ledger.state = 'idle'
      delete this.ledger.keyFingerprint
      this.save()
    }
  }

  onKeyChecked(check: FirefliesKeyCheck): void {
    if (check.state === 'ok' && this.ledger.state === 'invalid_key') {
      this.ledger.state = 'idle'
      delete this.ledger.keyFingerprint
      this.save()
    }
    if (check.state === 'invalid_key') {
      this.ledger.state = 'invalid_key'
      this.ledger.keyFingerprint = this.keyFingerprint()
      this.save()
    }
  }

  isRunning(): boolean {
    return this.active !== null
  }

  whenIdle(): Promise<unknown> {
    return this.active ?? Promise.resolve()
  }

  stop(): void {
    this.stopRequested = true
  }

  settings(patch: { keepImporting?: unknown; planCap?: unknown }): ImportStatus {
    this.refuseInAdviseMode()
    if (patch.keepImporting !== undefined) {
      if (typeof patch.keepImporting !== 'boolean') {
        throw new ImportRefusedError(400, 'invalid_keep_importing', 'keepImporting must be true or false.')
      }
      this.ledger.keepImporting = patch.keepImporting
    }
    if (patch.planCap !== undefined) {
      if (patch.planCap !== 'free' && patch.planCap !== 'pro' && patch.planCap !== 'business') {
        throw new ImportRefusedError(400, 'invalid_plan_cap', 'planCap must be free, pro or business.')
      }
      this.deps.budget.setPlan(patch.planCap)
    }
    this.save()
    return this.status()
  }

  private refuseInAdviseMode(): void {
    // Anything that is not `imports` is a Mac whose own pipeline owns Fireflies.
    // Written as "not imports" rather than "is advise" because 6.47.0 added a
    // THIRD mode, `apply`, and a pipeline Mac in apply mode must refuse for
    // exactly the same reason an advise one does.
    if (this.mode() !== 'imports') {
      throw new ImportRefusedError(
        409,
        'operations_pipeline_owns_fireflies',
        'Your COS pipeline already brings in Fireflies meetings, so the server does not import them here.',
      )
    }
  }

  status(): ImportStatus {
    const mode = this.mode()
    const budget = this.deps.budget.snapshot()
    const skipped: Record<string, number> = {}
    for (const [reason, hashes] of Object.entries(this.ledger.skipped)) skipped[reason] = hashes.length
    return {
      mode,
      state: mode !== 'imports' ? 'refused_pipeline' : this.active ? 'running' : this.ledger.state,
      running: this.active !== null,
      keyConfigured: this.deps.key() != null,
      keepImporting: this.ledger.keepImporting,
      planCap: budget.plan,
      windowDays: this.ledger.window.days,
      cursor: this.ledger.cursor,
      counts: {
        // Derived from the library, never from a counter here. Scoped to the
        // imported kind so a later merge or split record cannot inflate it.
        imported: this.deps.library.listHashes({ kind: 'fireflies' }).size,
        vendorSeen: this.ledger.vendorSeen.length,
        retryable: Object.keys(this.ledger.retryable).length,
        skipped,
      },
      skipKinds: IMPORT_SKIP_KIND,
      budget: { day: budget.day, calls: budget.calls, cap: budget.cap, remaining: budget.remaining },
      ...(this.ledger.lastRun ? { lastRun: this.ledger.lastRun } : {}),
      ...(this.ledger.nextAttemptAt ? { nextAttemptAt: this.ledger.nextAttemptAt } : {}),
      ...(this.ledger.lastPassCompletedAt ? { lastPassCompletedAt: this.ledger.lastPassCompletedAt } : {}),
    }
  }

  /** Start a run. Returns as soon as it is admitted; the work continues. */
  run(options: { windowDays?: number; trigger?: 'manual' | 'poll'; callCeiling?: number } = {}): { runId: string } {
    this.refuseInAdviseMode()
    if (this.active) {
      throw new ImportRefusedError(409, 'import_in_progress', 'An import is already running.')
    }
    if (!this.deps.key()) {
      throw new ImportRefusedError(409, 'fireflies_key_missing', 'Add your Fireflies API key first.')
    }
    if (this.stickyInvalidKey()) {
      throw new ImportRefusedError(409, 'invalid_key', 'Fireflies refused this key. Enter a new one to try again.')
    }
    if (!this.admissionsOpen()) {
      throw new ImportRefusedError(503, 'maintenance_drain_active', 'The server is finishing a maintenance operation. Try again shortly.')
    }
    const windowDays = normalizeWindowDays(options.windowDays)
    const runId = randomUUID()
    this.stopRequested = false
    const run = this.execute(runId, windowDays, options.trigger ?? 'manual', options.callCeiling)
      .finally(() => { this.active = null })
    this.active = run
    // A rejected background run must never become an unhandled rejection.
    void run.catch(error => this.log(`run failed: ${error instanceof Error ? error.message : String(error)}`))
    return { runId }
  }

  private async execute(
    runId: string,
    windowDays: number,
    trigger: 'manual' | 'poll',
    callCeiling?: number,
  ): Promise<ImportRunSummary> {
    const startedAt = new Date(this.now()).toISOString()
    const summary: ImportRunSummary = {
      runId, trigger, windowDays, startedAt, state: 'running', pages: 0, calls: 0, written: 0, seen: 0,
    }
    // A new window starts a new pass; the same window resumes where the last
    // one stopped, which is what makes cap_exhausted recoverable rather than a
    // restart from zero.
    if (this.ledger.window.days !== windowDays) {
      this.ledger.window = { days: windowDays }
      this.ledger.cursor = 0
    }
    this.ledger.state = 'running'
    this.ledger.lastRun = summary
    this.save()

    const windowStartMs = this.now() - windowDays * MS_PER_DAY
    let stop: { state: ImportState; reason?: string } | null = null
    let passComplete = false

    while (!stop) {
      if (summary.pages >= IMPORT_MAX_PAGES_PER_RUN) { stop = { state: 'partial', reason: 'page_cap' }; break }
      if (this.stopRequested) { stop = { state: 'partial', reason: 'server_stopping' }; break }
      if (!this.admissionsOpen()) { stop = { state: 'partial', reason: 'maintenance_deferred' }; break }
      if (callCeiling != null && this.deps.budget.snapshot().calls >= callCeiling) {
        stop = { state: 'partial', reason: 'poll_budget_share' }
        break
      }

      const page = await this.deps.client.listPage({ skip: this.ledger.cursor })
      summary.calls += page.calls
      summary.pages += 1

      let lease: MaintenanceWorkLease
      try {
        lease = this.acquireLease()
      } catch {
        // A drain during the fetch. Nothing was written, the cursor is durable,
        // and the next run repeats this page.
        stop = { state: 'partial', reason: 'maintenance_deferred' }
        break
      }

      const written: string[] = []
      try {
        for (const entry of page.oversized) {
          const hash = entry.id ? importHash(entry.id) : unusableKey({ id: null, title: `skip:${entry.skip}` })
          this.markRetryable(hash, 'response_too_large')
        }

        let reachedWindowEdge = false
        for (const raw of page.transcripts) {
          summary.seen += 1
          const normalized = normalizeFirefliesTranscript(raw)
          if (!normalized.ok) {
            this.recordSkip(raw, normalized.reason)
            continue
          }
          const record = normalized.record
          const hash = importHash(record.id)
          if (!this.ledger.vendorSeen.includes(hash)) this.ledger.vendorSeen.push(hash)
          if (record.dateMs < windowStartMs) { reachedWindowEdge = true; continue }

          // A meeting that is retryable but arrived complete is imported NOW.
          // The backoff exists to stop attempts piling up on a meeting with no
          // transcript yet, and that is enforced where attempts are counted
          // (markRetryable). Applying it here as well would hold a transcript
          // the vendor has already handed over for up to an hour, for nothing.
          // Found by the mutation gate: removing this line broke no test,
          // because there is no case where skipping here is correct.
          const result = this.deps.library.writeRecord(buildFirefliesImport(record, {
            importedAt: new Date(this.now()).toISOString(),
          }))
          delete this.ledger.retryable[hash]
          if (record.durationSeconds == null) this.recordSkipHash(hash, 'duration_unknown')
          if (!this.ledger.completed.includes(hash)) this.ledger.completed.push(hash)
          if (result.written) { summary.written += 1; written.push(hash) }

          // The proof. A record the library cannot list is a record no surface
          // will ever show, and continuing would bury that in a success count.
          if (!this.deps.library.listHashes({ month: result.month }).has(hash)) {
            stop = { state: 'write_unlisted', reason: 'write_unlisted' }
            break
          }
        }

        if (!stop) {
          this.ledger.cursor = page.nextSkip
          if (page.failure) {
            stop = failureStop(page.failure.state, page.failure)
            summary.failure = page.failure
            if (page.failure.retryAfterSeconds != null) {
              this.ledger.nextAttemptAt = new Date(this.now() + page.failure.retryAfterSeconds * 1_000).toISOString()
            }
          } else if (page.endOfList || reachedWindowEdge) {
            passComplete = true
            stop = { state: 'ok', reason: page.endOfList ? 'end_of_list' : 'window_edge' }
          }
        }
        this.save()
      } finally {
        lease.release()
      }

      if (written.length > 0) this.deps.onPageSealed?.({ runId, written })
    }

    if (passComplete) {
      this.ledger.cursor = 0
      this.ledger.lastPassCompletedAt = new Date(this.now()).toISOString()
    }
    const pending = Object.keys(this.ledger.retryable).length
    let state = stop?.state ?? 'partial'
    if (state === 'ok' && pending > 0) state = 'partial'
    if (state === 'invalid_key') this.ledger.keyFingerprint = this.keyFingerprint()

    summary.state = state
    summary.finishedAt = new Date(this.now()).toISOString()
    if (stop?.reason) summary.stopReason = stop.reason
    else if (state === 'partial' && pending > 0) summary.stopReason = 'retryable_pending'
    this.ledger.state = state
    this.ledger.lastRun = summary
    this.save()
    this.log(`run ${runId} ${state} (pages ${summary.pages}, calls ${summary.calls}, written ${summary.written})`)
    return summary
  }

  /** Has this retryable meeting waited long enough to be tried again? */
  private retryableDue(hash: string): boolean {
    const entry = this.ledger.retryable[hash]
    if (!entry) return true
    const nextAt = Date.parse(entry.nextAt)
    return !Number.isFinite(nextAt) || nextAt <= this.now()
  }

  private markRetryable(hash: string, reason: ImportSkipReason): void {
    const entry = this.ledger.retryable[hash]
    if (entry && !this.retryableDue(hash)) return
    const attempts = (entry?.attempts ?? 0) + 1
    if (attempts >= STILL_PROCESSING_MAX_ATTEMPTS) {
      delete this.ledger.retryable[hash]
      this.recordSkipHash(hash, 'never_transcribed')
      return
    }
    this.ledger.retryable[hash] = {
      reason,
      attempts,
      nextAt: new Date(this.now() + STILL_PROCESSING_BACKOFF_MS).toISOString(),
    }
  }

  private recordSkip(raw: unknown, reason: FirefliesSkipReason): void {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const hash = typeof item.id === 'string' && item.id.trim() ? importHash(item.id.trim()) : unusableKey(raw)
    if (reason === 'still_processing') {
      this.markRetryable(hash, reason)
      return
    }
    this.recordSkipHash(hash, reason)
  }

  private recordSkipHash(hash: string, reason: ImportSkipReason): void {
    const list = this.ledger.skipped[reason] ?? []
    if (!list.includes(hash)) list.push(hash)
    this.ledger.skipped[reason] = bounded(list)
  }

  /** Should a poll fire right now, and if not, why not. */
  pollDue(): { due: boolean; reason?: string } {
    if (this.mode() !== 'imports') return { due: false, reason: 'refused_pipeline' }
    if (!this.ledger.keepImporting) return { due: false, reason: 'keep_importing_off' }
    if (this.active) return { due: false, reason: 'import_in_progress' }
    if (!this.deps.key()) return { due: false, reason: 'fireflies_key_missing' }
    if (this.stickyInvalidKey()) return { due: false, reason: 'invalid_key' }
    if (!this.admissionsOpen()) return { due: false, reason: 'admissions_closed' }
    const now = this.now()
    if (this.ledger.nextAttemptAt) {
      const at = Date.parse(this.ledger.nextAttemptAt)
      if (Number.isFinite(at) && at > now) return { due: false, reason: 'rate_limited' }
    }
    const ceiling = this.pollCallCeiling()
    if (ceiling != null && this.deps.budget.snapshot().calls >= ceiling) {
      return { due: false, reason: 'poll_budget_share' }
    }
    const lastStartedAt = this.ledger.lastRun?.startedAt ? Date.parse(this.ledger.lastRun.startedAt) : Number.NaN
    const since = Number.isFinite(lastStartedAt) ? lastStartedAt : this.startedAtMs
    if (now - since < IMPORT_POLL_INTERVAL_MS) return { due: false, reason: 'not_due' }
    return { due: true }
  }

  /** Half the day's cap, so a poll can never spend the budget a person wanted. */
  private pollCallCeiling(): number | null {
    const cap = this.deps.budget.snapshot().cap
    return cap == null ? null : Math.floor(cap * IMPORT_POLL_BUDGET_SHARE)
  }

  tick(): { fired: boolean; reason?: string; runId?: string } {
    const due = this.pollDue()
    if (!due.due) return { fired: false, ...(due.reason ? { reason: due.reason } : {}) }
    try {
      const started = this.run({
        windowDays: this.ledger.window.days,
        trigger: 'poll',
        ...(this.pollCallCeiling() != null ? { callCeiling: this.pollCallCeiling()! } : {}),
      })
      return { fired: true, runId: started.runId }
    } catch (error) {
      return { fired: false, reason: error instanceof ImportRefusedError ? error.code : 'run_failed' }
    }
  }
}

function failureStop(state: FirefliesFailureState, failure: { retryAfterSeconds?: number }): { state: ImportState; reason?: string } {
  switch (state) {
    case 'invalid_key': return { state: 'invalid_key', reason: 'invalid_key' }
    case 'rate_limited': return { state: 'rate_limited', reason: 'rate_limited' }
    case 'unreachable': return { state: 'unreachable', reason: 'unreachable' }
    case 'cap_exhausted': return { state: 'partial', reason: 'cap_exhausted' }
    // vendor_error has no state of its own in the contract every surface
    // renders. It is reported as vendor_down with its code on the run, which is
    // what a person can act on, rather than inventing an eleventh state.
    case 'vendor_error':
    case 'vendor_down':
    default: return { state: 'vendor_down', reason: state }
  }
}

export function normalizeWindowDays(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_IMPORT_WINDOW_DAYS
  const days = typeof value === 'number' ? value : Number(value)
  if (!IMPORT_WINDOW_DAYS.includes(days as (typeof IMPORT_WINDOW_DAYS)[number])) {
    throw new ImportRefusedError(400, 'invalid_window', `windowDays must be one of ${IMPORT_WINDOW_DAYS.join(', ')}.`)
  }
  return days
}

let importer: FirefliesImporter | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

export function getFirefliesImporter(): FirefliesImporter {
  if (!importer) {
    // Built on first use, never at import time: every getter below touches the
    // data home, and a module that does that on import cannot be unit tested.
    importer = new FirefliesImporter({
      library: getImportedMeetingLibrary(),
      client: getFirefliesClient(),
      budget: getFirefliesBudget(),
      key: () => getFirefliesKeyStore().key(),
      // A page of imports is new evidence for the merge engine. The runner queues, defers
      // under a drain or a live capture, and never throws back into the import loop.
      onPageSealed: () => triggerMeetingMergeRun('import_page_sealed'),
    })
  }
  return importer
}

export function startMeetingImportScheduler(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    try {
      getFirefliesImporter().tick()
    } catch (error) {
      console.error('[meeting-import] poll tick failed:', error)
    }
  }, IMPORT_POLL_TICK_MS)
  pollTimer.unref?.()
}

export function stopMeetingImportScheduler(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  importer?.stop()
}
