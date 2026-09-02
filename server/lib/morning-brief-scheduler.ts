// Morning brief — the scheduler.
//
// One 30-second tick, unref'd so it never keeps a shutting-down process alive.
// Each tick asks the pure decision function whether the scheduled slot has
// arrived for the configured zone, then fires by submitting a durable query
// job to the same coordinator that every phone-originated prompt uses. From
// that point on the brief is an ordinary job: it survives the phone being
// asleep, it is projected into the conversation store with a message number
// when it completes, and the companion's history hydration picks it up like
// any other reply.
//
// HOW IT STOPS (the question every new provider caller must answer):
//  - one scheduled fire per local calendar day, remembered in a ledger that is
//    written BEFORE the job is admitted;
//  - a failed admission retries at most `scheduledAttemptsPerDay` times, two
//    minutes apart, then the day is given up;
//  - a crash between the ledger write and the admission is RESUMED by client
//    identity (deterministic per day), never re-run;
//  - "Run now" is capped per day and refused while a brief is already running;
//  - the whole thing is inert when durable jobs are off (COS Control's
//    "Background jobs" switch) or maintenance admissions are closed.

import { createHash, randomUUID } from 'node:crypto'
import {
  MORNING_BRIEF_LIMITS,
  applyMorningBriefPatch,
  loadMorningBriefConfig,
  loadMorningBriefLedger,
  saveMorningBriefConfig,
  saveMorningBriefLedger,
  type MorningBriefConfig,
  type MorningBriefLedger,
  type MorningBriefRun,
  type MorningBriefStorePaths,
  type MorningBriefTrigger,
  serverTimezone,
} from './morning-brief-config.js'
import { composeMorningBriefPrompt } from './morning-brief-prompt.js'
import {
  briefSections,
  sectionOutcomes,
  type MorningBriefCoverage,
  type MorningBriefCoverageService,
  type MorningBriefSectionOutcome,
} from './morning-brief-coverage.js'
import type { MessageReservation } from './message-reservations.js'
import { decideScheduledFire, localClock, nextScheduledFire } from './morning-brief-schedule.js'
import type { QueryJobSnapshot } from './query-job-types.js'
import { isTerminalQueryJobStatus } from './query-job-types.js'

export interface MorningBriefSubmission {
  job: Pick<QueryJobSnapshot, 'jobId' | 'clientJobId' | 'generation' | 'status' | 'sessionId'>
  created: boolean
}

export interface MorningBriefSchedulerDeps {
  paths: MorningBriefStorePaths
  submit: (request: Record<string, unknown>) => Promise<MorningBriefSubmission>
  findByClientGeneration: (clientJobId: string, generation: number) => Promise<QueryJobSnapshot | undefined>
  getSnapshot: (jobId: string) => Promise<QueryJobSnapshot>
  createSession: () => string
  currentMessageEra: () => string
  /** Highest stamped number in the active era across live sessions and archives. */
  currentMessageMax: () => number
  ownerName: () => string
  durableJobsEnabled: () => boolean
  admissionsOpen: () => boolean
  /** Per-source reach (counts behind each source). Absent on a bare harness. */
  coverage?: MorningBriefCoverageService
  now?: () => number
  tickMs?: number
  log?: (line: string) => void
}

export class MorningBriefRunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'MorningBriefRunError'
  }
}

export interface MorningBriefRunView extends Omit<MorningBriefRun, 'sections'> {
  status: string
  completedAt?: string
  error?: { code: string; message: string }
  /** First ~120 chars of the answer, for a list row. Never the whole brief. */
  preview?: string
  /** Which asked-for sections the answer opened, once the run is terminal. */
  sections?: MorningBriefSectionOutcome[]
}

export interface MorningBriefStatus {
  protocolVersion: 1
  enabled: boolean
  time: string
  timezone: string
  serverTimezone: string
  days: number[]
  nextRunAt: string | null
  lastRun: MorningBriefRunView | null
  /** Why the scheduler would not fire right now, for a status line. */
  gate: 'ready' | 'durable_jobs_off' | 'admissions_closed' | 'disabled'
}

export type TickResult =
  | { fired: true; run: MorningBriefRun }
  | { fired: false; reason: string }

/** Deterministic v4-shaped client id for one local day, so a retry after a
 * crashed submission admits as the SAME job. The store dedupes on it. */
export function scheduledClientJobId(day: string, timezone: string): string {
  const digest = createHash('sha256').update(`morning-brief|${timezone}|${day}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function errorParts(error: unknown): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'submit_failed'
  const message = error instanceof Error ? error.message : String(error)
  return { code: code.slice(0, 64), message: message.slice(0, 300) }
}

export class MorningBriefScheduler {
  private config: MorningBriefConfig
  private ledger: MorningBriefLedger
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight: Promise<TickResult> | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void
  readonly quarantinedConfig?: string

  constructor(private readonly deps: MorningBriefSchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[morning-brief] ${line}`))
    const loaded = loadMorningBriefConfig(deps.paths, new Date(this.now()))
    this.config = loaded.config
    this.quarantinedConfig = loaded.quarantinedAs
    if (loaded.fresh) {
      // Persist the defaults so every surface reads one file from the start
      // and so `updatedAt` is a real first-seen time.
      try { saveMorningBriefConfig(deps.paths, this.config) } catch (error) {
        this.log(`could not persist default config: ${(error as Error).message}`)
      }
    }
    this.ledger = loadMorningBriefLedger(deps.paths)
  }

  start(): void {
    if (this.timer) return
    const tickMs = Math.max(1_000, this.deps.tickMs ?? 30_000)
    this.timer = setInterval(() => { void this.tick() }, tickMs)
    this.timer.unref?.()
    this.log(`scheduled ${this.config.enabled ? `daily at ${this.config.time} ${this.config.timezone}` : 'off'} · next ${nextScheduledFire(this.config, this.now()) ?? 'none'}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getConfig(): MorningBriefConfig {
    return structuredClone(this.config)
  }

  updateConfig(patch: unknown): MorningBriefConfig {
    const next = applyMorningBriefPatch(this.config, patch, new Date(this.now()))
    saveMorningBriefConfig(this.deps.paths, next)
    this.config = next
    this.log(`config updated · ${next.enabled ? `daily at ${next.time} ${next.timezone}` : 'off'} · next ${nextScheduledFire(next, this.now()) ?? 'none'}`)
    return structuredClone(next)
  }

  previewPrompt(trigger: MorningBriefTrigger = 'scheduled'): string {
    const clock = localClock(this.now(), this.config.timezone)
    return composeMorningBriefPrompt({ config: this.config, day: clock.day, ownerName: this.deps.ownerName(), trigger })
  }

  /** One scheduler pass. Serialised: a slow submission never overlaps the next tick. */
  tick(): Promise<TickResult> {
    if (this.tickInFlight) return this.tickInFlight
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null })
    return this.tickInFlight
  }

  private async runTick(): Promise<TickResult> {
    if (!this.deps.durableJobsEnabled()) return { fired: false, reason: 'durable_jobs_off' }
    if (!this.deps.admissionsOpen()) return { fired: false, reason: 'admissions_closed' }
    const decision = decideScheduledFire(this.config, this.ledger.runs, this.now())
    if (!decision.fire) return { fired: false, reason: decision.reason }
    const run = await this.fire('scheduled', decision.day, decision.attempt, decision.resume)
    return { fired: true, run }
  }

  /** "Run now" from a settings surface. Bounded per day; refused while a brief is live. */
  async runNow(): Promise<MorningBriefRun> {
    if (!this.deps.durableJobsEnabled()) {
      throw new MorningBriefRunError(409, 'durable_jobs_off', 'Turn on Background jobs in COS Control to run the brief.')
    }
    if (!this.deps.admissionsOpen()) {
      throw new MorningBriefRunError(503, 'admissions_closed', 'The server is in maintenance. Try again in a moment.')
    }
    const clock = localClock(this.now(), this.config.timezone)
    const today = this.ledger.runs.filter(run => run.day === clock.day)
    for (const run of today) {
      if (!run.jobId) continue
      const snapshot = await this.deps.getSnapshot(run.jobId).catch(() => undefined)
      if (snapshot && !isTerminalQueryJobStatus(snapshot.status)) {
        throw new MorningBriefRunError(409, 'brief_in_progress', 'A brief is already running. It will land in the inbox when it finishes.')
      }
    }
    const manual = today.filter(run => run.trigger === 'manual' && run.jobId).length
    if (manual >= MORNING_BRIEF_LIMITS.manualRunsPerDay) {
      throw new MorningBriefRunError(429, 'manual_runs_exhausted', `Run now is limited to ${MORNING_BRIEF_LIMITS.manualRunsPerDay} briefs a day.`)
    }
    const run = await this.fire('manual', clock.day, manual + 1)
    if (run.submitError) {
      throw new MorningBriefRunError(503, run.submitError.code, run.submitError.message)
    }
    return run
  }

  private async fire(trigger: MorningBriefTrigger, day: string, attempt: number, resume?: MorningBriefRun): Promise<MorningBriefRun> {
    const clientJobId = trigger === 'scheduled'
      ? scheduledClientJobId(day, this.config.timezone)
      : randomUUID()

    // Resume: a ledger row with no job id. Adopt an admission the coordinator
    // may already hold for this identity before considering a fresh submit.
    if (resume) {
      const existing = await this.deps.findByClientGeneration(clientJobId, 1).catch(() => undefined)
      if (existing) {
        const adopted: MorningBriefRun = { ...resume, jobId: existing.jobId, lastKnownStatus: existing.status }
        this.replaceRun(adopted)
        this.log(`adopted ${trigger} brief for ${day} as job ${existing.jobId}`)
        return adopted
      }
    }

    const sessionId = resume?.sessionId ?? this.deps.createSession()
    const messageEra = this.deps.currentMessageEra()
    const globalMsgNum = resume?.globalMsgNum ?? this.deps.currentMessageMax() + 1
    const run: MorningBriefRun = {
      id: resume?.id ?? randomUUID(),
      day,
      trigger,
      attempt,
      firedAt: new Date(this.now()).toISOString(),
      clientJobId,
      generation: 1,
      sessionId,
      messageEra,
      globalMsgNum,
      sections: resume?.sections ?? briefSections(this.config, day),
    }
    // Ledger first. A crash after this line is a resume, not a second brief.
    this.replaceRun(run)

    const prompt = composeMorningBriefPrompt({ config: this.config, day, ownerName: this.deps.ownerName(), trigger })
    try {
      const admission = await this.deps.submit({
        clientJobId,
        generation: 1,
        query: prompt,
        sessionId,
        messageEra,
        globalMsgNum,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.effort ? { effort: this.config.effort } : {}),
        activityToolMode: 'status',
        attachmentIds: [],
        attachmentRefs: [],
      })
      const accepted: MorningBriefRun = { ...run, jobId: admission.job.jobId, lastKnownStatus: admission.job.status }
      this.replaceRun(accepted)
      this.log(`${trigger} brief for ${day} admitted as job ${admission.job.jobId} (#${globalMsgNum}${admission.created ? '' : ', already held'})`)
      return accepted
    } catch (error) {
      const failed: MorningBriefRun = { ...run, submitError: errorParts(error) }
      this.replaceRun(failed)
      this.log(`${trigger} brief for ${day} attempt ${attempt} failed to submit: ${failed.submitError!.code}`)
      return failed
    }
  }

  private replaceRun(run: MorningBriefRun): void {
    const index = this.ledger.runs.findIndex(existing => existing.id === run.id)
    if (index >= 0) this.ledger.runs[index] = run
    else this.ledger.runs.push(run)
    if (this.ledger.runs.length > MORNING_BRIEF_LIMITS.retainedRuns) {
      this.ledger.runs = this.ledger.runs.slice(-MORNING_BRIEF_LIMITS.retainedRuns)
    }
    try {
      saveMorningBriefLedger(this.deps.paths, this.ledger)
    } catch (error) {
      this.log(`ledger write failed: ${(error as Error).message}`)
    }
  }

  /** Ledger rows newest first, each with the job's live status folded in. */
  async listRuns(limit = 14): Promise<MorningBriefRunView[]> {
    const rows = this.ledger.runs.slice(-Math.max(1, Math.min(limit, MORNING_BRIEF_LIMITS.retainedRuns))).reverse()
    const views: MorningBriefRunView[] = []
    for (const run of rows) {
      const pending = run.sections?.length ? run.sections.map(section => ({ ...section, state: 'pending' as const })) : undefined
      if (!run.jobId) {
        views.push({ ...run, sections: pending, status: run.submitError ? 'submit_failed' : 'submitting', ...(run.submitError ? { error: run.submitError } : {}) })
        continue
      }
      const snapshot = await this.deps.getSnapshot(run.jobId).catch(() => undefined)
      if (!snapshot) {
        views.push({ ...run, sections: pending, status: run.lastKnownStatus ?? 'unknown' })
        continue
      }
      if (snapshot.status !== run.lastKnownStatus && isTerminalQueryJobStatus(snapshot.status)) {
        this.replaceRun({ ...run, lastKnownStatus: snapshot.status })
      }
      const answer = snapshot.response ?? snapshot.partialText ?? ''
      const sections = run.sections?.length && snapshot.status === 'completed'
        ? sectionOutcomes(run.sections, snapshot.response ?? '')
        : pending
      views.push({
        ...run,
        sections,
        status: snapshot.status,
        ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
        ...(snapshot.error ? { error: { code: snapshot.error.code, message: snapshot.error.message } } : {}),
        ...(answer ? { preview: answer.replace(/\s+/g, ' ').trim().slice(0, 120) } : {}),
      })
    }
    return views
  }

  /** Per-source reach for the settings surfaces. `null` when the harness has
   * no probes. `force` re-runs the probes instead of serving the cache. */
  async coverage(force = false): Promise<MorningBriefCoverage | null> {
    if (!this.deps.coverage) return null
    try {
      return await this.deps.coverage.describe(this.config, force)
    } catch (error) {
      this.log(`coverage failed: ${(error as Error).message}`)
      return null
    }
  }

  /**
   * Numbers this scheduler has minted for runs that are not terminal yet: the
   * ledger row exists BEFORE the job does, and the job's own reservation
   * (query-job-store identities) ends the moment its terminal projection
   * writes the exchange. Bounded to a day so a crashed row cannot pin the
   * counter forever; the resume path reuses the same number anyway.
   */
  liveReservations(era: string): MessageReservation[] {
    const floor = this.now() - 24 * 60 * 60_000
    const out: MessageReservation[] = []
    for (const run of this.ledger.runs) {
      if (typeof run.globalMsgNum !== 'number' || run.submitError) continue
      if (run.lastKnownStatus && isTerminalQueryJobStatus(run.lastKnownStatus as never)) continue
      const fired = Date.parse(run.firedAt)
      if (!Number.isFinite(fired) || fired < floor) continue
      if (era !== run.messageEra) continue
      out.push({ globalMsgNum: run.globalMsgNum, messageEra: run.messageEra, owner: `brief:${run.day}` })
    }
    return out
  }

  async status(): Promise<MorningBriefStatus> {
    const [lastRun] = await this.listRuns(1)
    const gate: MorningBriefStatus['gate'] = !this.deps.durableJobsEnabled()
      ? 'durable_jobs_off'
      : !this.deps.admissionsOpen()
        ? 'admissions_closed'
        : !this.config.enabled ? 'disabled' : 'ready'
    return {
      protocolVersion: 1,
      enabled: this.config.enabled,
      time: this.config.time,
      timezone: this.config.timezone,
      serverTimezone: serverTimezone(),
      days: [...this.config.days],
      nextRunAt: nextScheduledFire(this.config, this.now()),
      lastRun: lastRun ?? null,
      gate,
    }
  }

  /** Public-health shape: no prompt, no session ids, no job ids. */
  async capability(): Promise<{
    protocolVersion: 1
    enabled: boolean
    time: string
    timezone: string
    nextRunAt: string | null
    lastRunAt: string | null
    lastRunStatus: string | null
    gate: MorningBriefStatus['gate']
  }> {
    const status = await this.status()
    return {
      protocolVersion: 1,
      enabled: status.enabled,
      time: status.time,
      timezone: status.timezone,
      nextRunAt: status.nextRunAt,
      lastRunAt: status.lastRun?.firedAt ?? null,
      lastRunStatus: status.lastRun?.status ?? null,
      gate: status.gate,
    }
  }
}
