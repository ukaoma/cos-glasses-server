// 6.82.0 Routines: the skill-routine scheduler (routine #2 onward; the morning brief keeps its own).
//
// One 30-second tick, unref'd. Each tick (1) reads back the outcome of every run still open and
// feeds the breaker, then (2) asks the brief's own pure decision table whether each routine's slot
// has arrived, and fires by submitting a durable query job to the same coordinator every phone
// prompt uses. From there a run is an ordinary job: it survives the phone sleeping, lands in the
// inbox with a message number, and carries `origin: { kind: 'routine', id }`.
//
// How it stops: see routines-config.ts. In short: switch, master switch, per-routine daily cap,
// server-wide ceiling, breaker with cooldown, one slot per day, bounded submit attempts.

import { randomUUID } from 'node:crypto'
import {
  ROUTINE_LIMITS,
  RoutineConfigError,
  applyRoutinePatch,
  composeSkillRoutinePrompt,
  loadRoutinesFile,
  loadRoutinesLedger,
  newRoutineId,
  routineScheduledClientJobId,
  routinesEnabledByEnv,
  saveRoutinesFile,
  saveRoutinesLedger,
  type RoutineBreakerState,
  type RoutineRun,
  type RoutineStorePaths,
  type RoutineTrigger,
  type RoutinesFile,
  type RoutinesLedger,
  type SkillRoutine,
} from './routines-config.js'
import { decideScheduledFire, localClock, nextScheduledFire } from './morning-brief-schedule.js'
import type { MessageReservation } from './message-reservations.js'
import type { QueryJobSnapshot } from './query-job-types.js'
import { isTerminalQueryJobStatus } from './query-job-types.js'

export interface RoutineSubmission {
  job: Pick<QueryJobSnapshot, 'jobId' | 'clientJobId' | 'generation' | 'status' | 'sessionId'>
  created: boolean
}

export interface RoutineSchedulerDeps {
  paths: RoutineStorePaths
  submit: (request: Record<string, unknown>) => Promise<RoutineSubmission>
  findByClientGeneration: (clientJobId: string, generation: number) => Promise<QueryJobSnapshot | undefined>
  getSnapshot: (jobId: string) => Promise<QueryJobSnapshot>
  createSession: () => string
  currentMessageEra: () => string
  currentMessageMax: () => number
  ownerName: () => string
  durableJobsEnabled: () => boolean
  admissionsOpen: () => boolean
  /** True when the workspace skill catalog has this skill. */
  skillExists: (name: string) => boolean
  /** Master switch. Defaults to COS_ROUTINES (only an explicit 0/false/off/no turns it off). */
  masterEnabled?: () => boolean
  now?: () => number
  tickMs?: number
  log?: (line: string) => void
}

export class RoutineRunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RoutineRunError'
  }
}

export type RoutineGate = 'ready' | 'routines_off' | 'durable_jobs_off' | 'admissions_closed' | 'disabled' | 'breaker_open' | 'skill_missing'

export interface RoutineRunView extends RoutineRun {
  status: string
  completedAt?: string
  error?: { code: string; message: string }
  preview?: string
}

export interface RoutineBreakerView {
  state: 'closed' | 'open' | 'half_open'
  consecutiveFailures: number
  failures: number
  cooldownMinutes: number
  openUntil?: string
  lastFailure?: { code: string; message: string; at: string }
}

export interface SkillRoutineView extends SkillRoutine {
  nextRunAt: string | null
  gate: RoutineGate
  skillFound: boolean
  breakerState: RoutineBreakerView
  today: { day: string; runs: number; cap: number }
  lastRun: RoutineRunView | null
}

export type RoutineTickResult = { fired: string[]; skipped: Record<string, string>; reason?: string }

const FAILED_STATUSES = new Set(['failed', 'interrupted'])

function errorParts(error: unknown): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'submit_failed'
  const message = error instanceof Error ? error.message : String(error)
  return { code: code.slice(0, 64), message: message.slice(0, 300) }
}

export class RoutineScheduler {
  private file: RoutinesFile
  private ledger: RoutinesLedger
  private timer: ReturnType<typeof setInterval> | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private tickInFlight: Promise<RoutineTickResult> | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly masterEnabled: () => boolean
  readonly quarantinedFile?: string

  constructor(private readonly deps: RoutineSchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.log(`[routines] ${line}`))
    this.masterEnabled = deps.masterEnabled ?? (() => routinesEnabledByEnv())
    const loaded = loadRoutinesFile(deps.paths)
    this.file = loaded.file
    this.quarantinedFile = loaded.quarantinedAs
    this.ledger = loadRoutinesLedger(deps.paths)
  }

  start(): void {
    if (this.timer) return
    const tickMs = Math.max(1_000, this.deps.tickMs ?? 30_000)
    this.timer = setInterval(() => {
      this.tick().catch(error => this.log(`tick failed: ${error instanceof Error ? error.message : String(error)}`))
    }, tickMs)
    this.timer.unref?.()
    this.log(`${this.file.routines.length} skill routine(s)${this.masterEnabled() ? '' : ' · off by COS_ROUTINES'}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn)
    this.serial = next.then(() => undefined, () => undefined)
    return next
  }

  // ── Config ──────────────────────────────────────────────────────────────

  routines(): SkillRoutine[] {
    return structuredClone(this.file.routines)
  }

  private find(id: string): SkillRoutine {
    const routine = this.file.routines.find(r => r.id === id)
    if (!routine) throw new RoutineConfigError('routine_not_found', 'That routine does not exist.', 404)
    return routine
  }

  private persist(): void {
    saveRoutinesFile(this.deps.paths, this.file)
  }

  create(body: unknown): Promise<SkillRoutine> {
    return this.serialize(async () => {
      if (this.file.routines.length >= ROUTINE_LIMITS.maxRoutines) {
        throw new RoutineConfigError('too_many_routines', `A server holds at most ${ROUTINE_LIMITS.maxRoutines} skill routines.`, 409)
      }
      const routine = applyRoutinePatch(null, body, { now: new Date(this.now()), skillExists: this.deps.skillExists })
      while (this.file.routines.some(r => r.id === routine.id)) routine.id = newRoutineId()
      this.file.routines.push(routine)
      this.persist()
      this.log(`created ${routine.id} (/${routine.skill}) · ${routine.enabled ? `${routine.time} ${routine.timezone}` : 'off'}`)
      return structuredClone(routine)
    })
  }

  update(id: string, body: unknown): Promise<SkillRoutine> {
    return this.serialize(async () => {
      const current = this.find(id)
      const patch = body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : body
      const reset = patch && typeof patch === 'object' && (patch as Record<string, unknown>).resetBreaker === true
      if (patch && typeof patch === 'object') delete (patch as Record<string, unknown>).resetBreaker
      const next = applyRoutinePatch(current, patch, { now: new Date(this.now()), skillExists: this.deps.skillExists })
      next.id = current.id
      next.createdAt = current.createdAt
      this.file.routines = this.file.routines.map(r => r.id === id ? next : r)
      if (reset) {
        delete this.file.breakers[id]
        this.log(`breaker reset for ${id}`)
      }
      this.persist()
      return structuredClone(next)
    })
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      this.find(id)
      this.file.routines = this.file.routines.filter(r => r.id !== id)
      delete this.file.breakers[id]
      this.persist()
      this.log(`deleted ${id}`)
    })
  }

  // ── Breaker ─────────────────────────────────────────────────────────────

  private breaker(id: string): RoutineBreakerState {
    return this.file.breakers[id] ?? { consecutiveFailures: 0 }
  }

  breakerOpen(id: string): boolean {
    const until = this.breaker(id).openUntil
    return !!until && Date.parse(until) > this.now()
  }

  private breakerView(routine: SkillRoutine): RoutineBreakerView {
    const state = this.breaker(routine.id)
    const open = this.breakerOpen(routine.id)
    return {
      state: open ? 'open' : state.consecutiveFailures >= routine.breaker.failures ? 'half_open' : 'closed',
      consecutiveFailures: state.consecutiveFailures,
      failures: routine.breaker.failures,
      cooldownMinutes: routine.breaker.cooldownMinutes,
      ...(open && state.openUntil ? { openUntil: state.openUntil } : {}),
      ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
    }
  }

  /** Count one finished run. Success closes the breaker; a failure counts toward opening it. */
  private recordOutcome(routineId: string, ok: boolean, failure?: { code: string; message: string }): void {
    const routine = this.file.routines.find(r => r.id === routineId)
    if (!routine) return
    const prior = this.breaker(routineId)
    if (ok) {
      this.file.breakers[routineId] = { consecutiveFailures: 0, ...(prior.lastFailure ? { lastFailure: prior.lastFailure } : {}) }
    } else {
      const at = new Date(this.now()).toISOString()
      const next: RoutineBreakerState = {
        consecutiveFailures: prior.consecutiveFailures + 1,
        lastFailure: { code: failure?.code ?? 'failed', message: failure?.message ?? '', at },
      }
      if (next.consecutiveFailures >= routine.breaker.failures) {
        next.openedAt = at
        next.openUntil = new Date(this.now() + routine.breaker.cooldownMinutes * 60_000).toISOString()
        this.log(`breaker OPEN for ${routineId} after ${next.consecutiveFailures} failed runs · until ${next.openUntil}`)
      }
      this.file.breakers[routineId] = next
    }
    try { this.persist() } catch (error) { this.log(`breaker write failed: ${(error as Error).message}`) }
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  private replaceRun(run: RoutineRun): void {
    const index = this.ledger.runs.findIndex(existing => existing.id === run.id)
    if (index >= 0) this.ledger.runs[index] = run
    else this.ledger.runs.push(run)
    if (this.ledger.runs.length > ROUTINE_LIMITS.retainedRuns) this.ledger.runs = this.ledger.runs.slice(-ROUTINE_LIMITS.retainedRuns)
    try { saveRoutinesLedger(this.deps.paths, this.ledger) } catch (error) { this.log(`ledger write failed: ${(error as Error).message}`) }
  }

  private runsFor(id: string): RoutineRun[] {
    return this.ledger.runs.filter(run => run.routineId === id)
  }

  /** Admitted runs today in the routine's own zone, both triggers. A failed submit never ran and is not counted. */
  private admittedToday(routine: SkillRoutine): number {
    const day = localClock(this.now(), routine.timezone).day
    return this.runsFor(routine.id).filter(run => run.day === day && run.jobId).length
  }

  /** Admitted runs across every skill routine in the trailing 24 hours (the server-wide ceiling). */
  private admittedLastDay(): number {
    const floor = this.now() - 24 * 60 * 60_000
    return this.ledger.runs.filter(run => run.jobId && Date.parse(run.firedAt) >= floor).length
  }

  /** Read back every open run; a terminal one is counted by the breaker exactly once. */
  private async reconcile(): Promise<void> {
    for (const run of [...this.ledger.runs]) {
      if (run.outcome || !run.jobId) continue
      const snapshot = await this.deps.getSnapshot(run.jobId).catch(() => undefined)
      if (!snapshot || !isTerminalQueryJobStatus(snapshot.status)) continue
      const outcome: RoutineRun['outcome'] = snapshot.status === 'completed' ? 'completed' : snapshot.status === 'canceled' ? 'canceled' : 'failed'
      this.replaceRun({ ...run, lastKnownStatus: snapshot.status, outcome })
      if (outcome === 'canceled') continue
      this.recordOutcome(run.routineId, outcome === 'completed', snapshot.error
        ? { code: snapshot.error.code, message: snapshot.error.message }
        : FAILED_STATUSES.has(snapshot.status) ? { code: snapshot.status, message: '' } : undefined)
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  private gateFor(routine: SkillRoutine): RoutineGate {
    if (!this.masterEnabled()) return 'routines_off'
    if (!this.deps.durableJobsEnabled()) return 'durable_jobs_off'
    if (!this.deps.admissionsOpen()) return 'admissions_closed'
    if (!routine.enabled) return 'disabled'
    if (this.breakerOpen(routine.id)) return 'breaker_open'
    if (!this.deps.skillExists(routine.skill)) return 'skill_missing'
    return 'ready'
  }

  tick(): Promise<RoutineTickResult> {
    if (this.tickInFlight) return this.tickInFlight
    this.tickInFlight = this.serialize(() => this.runTick()).finally(() => { this.tickInFlight = null })
    return this.tickInFlight
  }

  private async runTick(): Promise<RoutineTickResult> {
    await this.reconcile()
    const result: RoutineTickResult = { fired: [], skipped: {} }
    if (!this.masterEnabled()) return { ...result, reason: 'routines_off' }
    if (!this.deps.durableJobsEnabled()) return { ...result, reason: 'durable_jobs_off' }
    if (!this.deps.admissionsOpen()) return { ...result, reason: 'admissions_closed' }
    for (const routine of this.file.routines) {
      if (this.breakerOpen(routine.id)) { result.skipped[routine.id] = 'breaker_open'; continue }
      // The decision table reads only this routine's scheduled rows itself (Run now never takes the slot).
      const decision = decideScheduledFire(routine, this.runsFor(routine.id), this.now())
      if (!decision.fire) { result.skipped[routine.id] = decision.reason; continue }
      if (!decision.resume && this.admittedToday(routine) >= routine.dailyCap) { result.skipped[routine.id] = 'daily_cap_reached'; continue }
      if (!decision.resume && this.admittedLastDay() >= ROUTINE_LIMITS.globalRunsPerDay) { result.skipped[routine.id] = 'global_cap_reached'; continue }
      const run = await this.fire(routine, 'scheduled', decision.day, decision.attempt, decision.resume)
      if (run.jobId) result.fired.push(routine.id)
      else result.skipped[routine.id] = run.submitError?.code ?? 'submit_failed'
    }
    return result
  }

  runNow(id: string): Promise<RoutineRun> {
    return this.serialize(async () => {
      await this.reconcile()
      const routine = this.find(id)
      if (!this.masterEnabled()) throw new RoutineRunError(409, 'routines_off', 'Routines are off on this Mac (COS_ROUTINES=0).')
      if (!this.deps.durableJobsEnabled()) throw new RoutineRunError(409, 'durable_jobs_off', 'Turn on Background jobs in COS Control to run routines.')
      if (!this.deps.admissionsOpen()) throw new RoutineRunError(503, 'admissions_closed', 'The server is in maintenance. Try again in a moment.')
      if (this.breakerOpen(id)) {
        const until = this.breaker(id).openUntil
        throw new RoutineRunError(423, 'breaker_open', `Paused after ${this.breaker(id).consecutiveFailures} failed runs. Reset it, or wait until ${until}.`, { openUntil: until })
      }
      if (!this.deps.skillExists(routine.skill)) throw new RoutineRunError(409, 'skill_missing', `/${routine.skill} is no longer in this COS workspace.`)
      for (const run of this.runsFor(id)) {
        if (!run.jobId || run.outcome) continue
        const snapshot = await this.deps.getSnapshot(run.jobId).catch(() => undefined)
        if (snapshot && !isTerminalQueryJobStatus(snapshot.status)) {
          throw new RoutineRunError(409, 'routine_in_progress', 'This routine is already running. It lands in the inbox when it finishes.')
        }
      }
      if (this.admittedToday(routine) >= routine.dailyCap) {
        throw new RoutineRunError(429, 'daily_cap_reached', `This routine is capped at ${routine.dailyCap} run${routine.dailyCap === 1 ? '' : 's'} a day.`)
      }
      if (this.admittedLastDay() >= ROUTINE_LIMITS.globalRunsPerDay) {
        throw new RoutineRunError(429, 'global_cap_reached', `Routines together are capped at ${ROUTINE_LIMITS.globalRunsPerDay} runs a day.`)
      }
      const day = localClock(this.now(), routine.timezone).day
      const manual = this.runsFor(id).filter(run => run.day === day && run.trigger === 'manual').length
      const run = await this.fire(routine, 'manual', day, manual + 1)
      if (run.submitError) throw new RoutineRunError(503, run.submitError.code, run.submitError.message)
      return run
    })
  }

  private async fire(routine: SkillRoutine, trigger: RoutineTrigger, day: string, attempt: number, resume?: RoutineRun): Promise<RoutineRun> {
    const clientJobId = trigger === 'scheduled' ? routineScheduledClientJobId(routine.id, day, routine.timezone) : randomUUID()
    if (trigger === 'scheduled') {
      const existing = await this.deps.findByClientGeneration(clientJobId, 1).catch(() => undefined)
      if (existing) {
        const prior = resume ?? this.runsFor(routine.id).filter(r => r.day === day && r.trigger === 'scheduled').at(-1)
        const { submitError: _dropped, ...carried } = prior ?? {}
        const adopted: RoutineRun = {
          ...carried,
          id: prior?.id ?? randomUUID(),
          routineId: routine.id,
          day,
          trigger,
          attempt,
          firedAt: prior?.firedAt ?? existing.acceptedAt,
          clientJobId,
          generation: 1,
          sessionId: prior?.sessionId ?? existing.sessionId,
          messageEra: prior?.messageEra ?? existing.messageEra ?? this.deps.currentMessageEra(),
          globalMsgNum: prior?.globalMsgNum ?? existing.globalMsgNum ?? this.deps.currentMessageMax() + 1,
          jobId: existing.jobId,
          lastKnownStatus: existing.status,
        }
        this.replaceRun(adopted)
        this.log(`adopted ${routine.id} for ${day} as job ${existing.jobId}`)
        return adopted
      }
    }
    const sessionId = resume?.sessionId ?? this.deps.createSession()
    const messageEra = this.deps.currentMessageEra()
    const globalMsgNum = resume?.globalMsgNum ?? this.deps.currentMessageMax() + 1
    const run: RoutineRun = {
      id: resume?.id ?? randomUUID(),
      routineId: routine.id,
      day,
      trigger,
      attempt,
      firedAt: new Date(this.now()).toISOString(),
      clientJobId,
      generation: 1,
      sessionId,
      messageEra,
      globalMsgNum,
    }
    // Ledger first: a crash after this line is a resume, not a second run.
    this.replaceRun(run)
    try {
      const admission = await this.deps.submit({
        clientJobId,
        generation: 1,
        query: composeSkillRoutinePrompt(routine, day, this.deps.ownerName(), trigger),
        sessionId,
        messageEra,
        globalMsgNum,
        // Always explicit: a job with no model would run on the user's default, which can be Opus.
        model: routine.model,
        ...(routine.effort ? { effort: routine.effort } : {}),
        activityToolMode: 'status',
        attachmentIds: [],
        attachmentRefs: [],
        origin: { kind: 'routine', id: routine.id },
      })
      const accepted: RoutineRun = { ...run, jobId: admission.job.jobId, lastKnownStatus: admission.job.status }
      this.replaceRun(accepted)
      this.log(`${trigger} ${routine.id} (/${routine.skill}) for ${day} admitted as job ${admission.job.jobId} (#${globalMsgNum})`)
      return accepted
    } catch (error) {
      const failed: RoutineRun = { ...run, submitError: errorParts(error), outcome: 'failed' }
      this.replaceRun(failed)
      this.recordOutcome(routine.id, false, failed.submitError)
      this.log(`${trigger} ${routine.id} for ${day} attempt ${attempt} failed to submit: ${failed.submitError!.code}`)
      return failed
    }
  }

  // ── Views ───────────────────────────────────────────────────────────────

  async listRuns(id?: string, limit = 14): Promise<RoutineRunView[]> {
    const pool = id ? this.runsFor(id) : this.ledger.runs
    const rows = pool.slice(-Math.max(1, Math.min(limit, ROUTINE_LIMITS.retainedRuns))).reverse()
    const views: RoutineRunView[] = []
    for (const run of rows) {
      if (!run.jobId) {
        views.push({ ...run, status: run.submitError ? 'submit_failed' : 'submitting', ...(run.submitError ? { error: run.submitError } : {}) })
        continue
      }
      const snapshot = await this.deps.getSnapshot(run.jobId).catch(() => undefined)
      if (!snapshot) { views.push({ ...run, status: run.lastKnownStatus ?? 'unknown' }); continue }
      const answer = snapshot.response ?? snapshot.partialText ?? ''
      views.push({
        ...run,
        status: snapshot.status,
        ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
        ...(snapshot.error ? { error: { code: snapshot.error.code, message: snapshot.error.message } } : {}),
        ...(answer ? { preview: answer.replace(/\s+/g, ' ').trim().slice(0, 120) } : {}),
      })
    }
    return views
  }

  async view(routine: SkillRoutine): Promise<SkillRoutineView> {
    const [lastRun] = await this.listRuns(routine.id, 1)
    const day = localClock(this.now(), routine.timezone).day
    return {
      ...structuredClone(routine),
      nextRunAt: routine.enabled && !this.breakerOpen(routine.id) ? nextScheduledFire(routine, this.now()) : null,
      gate: this.gateFor(routine),
      skillFound: this.deps.skillExists(routine.skill),
      breakerState: this.breakerView(routine),
      today: { day, runs: this.admittedToday(routine), cap: routine.dailyCap },
      lastRun: lastRun ?? null,
    }
  }

  async views(): Promise<SkillRoutineView[]> {
    const out: SkillRoutineView[] = []
    for (const routine of this.file.routines) out.push(await this.view(routine))
    return out
  }

  async get(id: string): Promise<SkillRoutineView> {
    return this.view(this.find(id))
  }

  masterSwitchOn(): boolean {
    return this.masterEnabled()
  }

  /** Numbers minted for runs not terminal yet (the brief's rule): the ledger row exists before the job. */
  liveReservations(era: string): MessageReservation[] {
    const floor = this.now() - 24 * 60 * 60_000
    const out: MessageReservation[] = []
    for (const run of this.ledger.runs) {
      if (typeof run.globalMsgNum !== 'number' || run.submitError) continue
      if (run.lastKnownStatus && isTerminalQueryJobStatus(run.lastKnownStatus as never)) continue
      const fired = Date.parse(run.firedAt)
      if (!Number.isFinite(fired) || fired < floor) continue
      if (era !== run.messageEra) continue
      out.push({ globalMsgNum: run.globalMsgNum, messageEra: run.messageEra, owner: `routine:${run.routineId}:${run.day}` })
    }
    return out
  }
}
