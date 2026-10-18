import { getOrCreateSession } from './conversation.js'
import {
  QueryJobNotFoundError,
  QueryJobPersistenceError,
  QueryJobProviderOrphanFenceError,
  QueryJobSteerConflictError,
  QueryJobStore,
  QueryJobStoreError,
  type QueryJobAdmissionResult,
  type QueryJobMutationResult,
  type QueryJobSubscription,
} from './query-job-store.js'
import {
  QUERY_JOB_LIMITS,
  QUERY_JOB_STEER_LIMITS,
  QueryJobValidationError,
  isTerminalQueryJobStatus,
  normalizeQueryJobError,
  parsePositiveInteger,
  parseSteerId,
  parseSteerText,
  steerFallback,
  steerReadState,
  steerTextSha256,
  type QueryJobProviderLinkage,
  type QueryJobOutputImageStats,
  type QueryJobRequest,
  type QueryJobSnapshot,
  type QueryJobStatus,
  type QueryJobSteer,
  type QueryJobSteerState,
  type QueryJobStoreHealth,
} from './query-job-types.js'
import { SteerPort, steerClock, steerCutoffMs, type PendingSteer, type QueryProvider } from './claude-steer.js'
import type { MaintenanceWorkLease } from './maintenance-lifecycle.js'
import { applyTrailToolMode, type JobTrailDraft } from './job-trail.js'
import { crashLoopParkedError, type BootResumeGate } from './boot-resume.js'
import { restartNoticeEnabled } from './query-job-feature.js'

const CLIENT_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface QueryJobRunnerStart extends QueryJobProviderLinkage {
  sessionId?: string
}

export interface QueryJobRunnerCompletion extends QueryJobProviderLinkage {
  text: string
  attachments?: unknown
  outputImageStats?: QueryJobOutputImageStats
}

export interface QueryJobRunnerCallbacks {
  onStart: (start: QueryJobRunnerStart) => void | Promise<void>
  /** Persist provider-run ownership before the bridge writes the prompt to
   * stdin. PIDs are deliberately excluded; only stable public ledger ids fit. */
  /** True only when provider ownership was durably fsynced for this active
   * generation. False means cancel/shutdown won; no prompt may be written. */
  onProviderProcess: (linkage: QueryJobProviderLinkage) => boolean | Promise<boolean>
  /** 6.58.2: a link the provider names mid-run (the Claude session id). Persisted only while
   * the job runs (like every link update it restamps providerOwnershipConfirmedAt); unlike
   * onProviderProcess it gates nothing, and a job that already ended keeps what it had. */
  onLinkage?: (linkage: QueryJobProviderLinkage) => Promise<void>
  onChunk: (text: string) => void
  onToolStatus: (text: string) => void
  onActivityLine: (line: { kind: 'input' | 'output'; text: string }) => void
  /** One readable step of the run (6.52.0). Filtered by the job's `activityToolMode`
   * here, redacted by the store, journaled as a `trail` event. Never on the display bus. */
  onTrail: (draft: JobTrailDraft) => void
  /** True only when this callback durably won the answer-ready transition. */
  onAnswerReady: (text: string, linkage?: QueryJobProviderLinkage) => boolean | Promise<boolean>
  /** True only when this callback won and durably projected the terminal. */
  onDone: (completion: QueryJobRunnerCompletion) => boolean | Promise<boolean>
  onError: (error: unknown) => boolean | Promise<boolean>
}

export interface QueryJobRunnerContext {
  jobId: string
  turnId: string
  request: QueryJobRequest
  signal: AbortSignal
  callbacks: QueryJobRunnerCallbacks
  /** 6.78.0: present only when this run is steerable (see QueryJobSteerOptions). */
  steer?: SteerPort
}

/**
 * 6.78.0 Messages steer. A run is steerable only when ALL hold: the switch is on
 * (COS_MESSAGES_STEER), the client asked (`request.steerable`), it is not a dispatch, the
 * provider (resolved as model-router resolves it) is Claude, and the installed CLI takes
 * `--input-format stream-json --replay-user-messages`.
 */
export interface QueryJobSteerOptions {
  enabled: () => boolean
  provider: (request: QueryJobRequest) => QueryProvider
  cliSupported: () => Promise<boolean>
}

/** 6.78.0: what POST /query-jobs/:jobId/steer and the steer lookup answer (contract messages-steer.json). */
export interface QueryJobSteerReply {
  steerId: string
  state: QueryJobSteerState
  fallback: 'queue_follow_up' | null
  jobStatus: QueryJobStatus
}

export class QueryJobSteerLimitError extends Error {
  readonly code = 'steer_limit'
  constructor() {
    super(`This run already has ${QUERY_JOB_STEER_LIMITS.steersPerJob} steers.`)
    this.name = 'QueryJobSteerLimitError'
  }
}

export class QueryJobSteerUnknownError extends Error {
  readonly code = 'steer_unknown'
  constructor() {
    super('No steer with this id.')
    this.name = 'QueryJobSteerUnknownError'
  }
}

function steerReply(steer: QueryJobSteer, job: Pick<QueryJobSnapshot, 'status'>): QueryJobSteerReply {
  const state = steerReadState(steer.state, job.status)
  // The fallback reads the journaled state: a delivered steer reads not_applied on an ended
  // job, and must still never be resent (P7 S1).
  return { steerId: steer.steerId, state, fallback: steerFallback(steer.state, job.status), jobStatus: job.status }
}

export type QueryJobRunner = (context: QueryJobRunnerContext) => Promise<void>

export interface QueryJobCoordinatorOptions {
  /** Optional because the current model router remains the authoritative
   * session-lock owner. A future provider runner may supply a lease here. */
  acquireSessionLock?: (sessionId: string) => (() => void) | Promise<() => void>
  /** Defaults to the exact legacy conversation allocator. */
  resolveSessionId?: (requested?: string) => string
  partialFlushMs?: number
  partialFlushChars?: number
  providerTimeoutMs?: number
  /** Idempotent projection of a terminal journal record into canonical
   * conversation state. The journal remains authoritative if this fails. */
  projectTerminal?: (job: QueryJobSnapshot, request: QueryJobRequest) => void | Promise<void>
  /** Acquired synchronously before serialized admission and retained through
   * the provider terminal, so maintenance proof covers queued transitions. */
  acquireMaintenanceWork?: () => MaintenanceWorkLease
  /** Longest single wait while a job is held (orphan fence, or a maintenance drain
   * refusing its start lease) before the coordinator looks again. Bounded so a Mac
   * that slept through the end of a fence does not wait out a stale timer. */
  holdRecheckMs?: number
  /** 6.78.0: the process's crash-loop gate (lib/boot-resume.ts), read when it is used. */
  bootResumeGate?: () => Pick<BootResumeGate, 'admit' | 'retry' | 'forget' | 'limit'>
  /** 6.78.0 restart truth: defaults to COS_RESTART_NOTICE (on), read at shutdown. */
  restartNotice?: () => boolean
  /** 6.78.0: the longest shutdown waits for steps a run already reported to reach the journal. */
  shutdownDrainMs?: number
  /** 6.78.0: Messages steer. Absent (the default) means no run is ever steerable. */
  steer?: QueryJobSteerOptions
}

/**
 * 6.78.0 restart truth: how long a graceful shutdown lets the steps, chunks and activity a run
 * already reported reach the journal before it writes the interrupt, so the notice names them.
 * All active runs drain at once, so this bounds the whole wait, far inside index.ts's 8-second
 * force exit. A run whose writes are stuck (a broken disk) is interrupted when it runs out.
 */
export const SHUTDOWN_CALLBACK_DRAIN_MS = 1_000

/** Margin past the fence before the start is retried, so the retry lands after it. */
const FENCE_HOLD_SLACK_MS = 250

/** Clock time as a phone and the lens can read it: rounded UP to the minute (never a
 * start time that has already passed), and ICU's narrow no-break space before AM/PM,
 * which some Node builds emit, as a plain space. */
export function holdClock(ms: number): string {
  return new Date(Math.ceil(ms / 60_000) * 60_000)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/[\u202f\u00a0]/g, ' ')
}

/**
 * The two lines a job held by an orphan fence shows (6.61.3), journaled as tool-status
 * activity: the reason, then the time. The glasses header shows the LATEST line cut to
 * 18 characters (the client's normalizeHeaderActivityLabel), so the line that stays there
 * must fit whole: `Starts 12:53 PM` is 15. The phone's job log shows both. A clock time,
 * never a countdown: the lines are journaled once, and a countdown is wrong when read.
 */
export function orphanFenceHoldStatus(startsAtMs: number): [string, string] {
  return ['An earlier run may still be running', `Starts ${holdClock(startsAtMs)}`]
}

/** What a job shows while a maintenance drain (Update Server) refuses its start. 18 chars. */
export const DRAIN_HOLD_STATUS = 'Waiting for update'

interface ActiveRun {
  jobId: string
  generation: number
  request: QueryJobRequest
  controller: AbortController
  release?: () => void
  maintenanceLease?: MaintenanceWorkLease
  released: boolean
  callbackTail: Promise<void>
  partialText: string
  partialTruncated: boolean
  pendingDelta: string
  partialTimer: ReturnType<typeof setTimeout> | null
  terminalPersisted: boolean
  persistenceFailed: boolean
  terminalPromise: Promise<void>
  resolveTerminal: () => void
  providerTimeoutPromise: Promise<void>
  resolveProviderTimeout: () => void
  providerTimeoutTimer: ReturnType<typeof setTimeout> | null
  /** 6.78.0: the run's steer port, present only when the run is steerable. */
  steer?: SteerPort
  /** 6.78.0: when the coordinator deadline fires, on the monotonic steer clock (`steerClock`), once the run is running. */
  deadlineAt?: number
}

export interface QueryJobCoordinatorHealth {
  activeRuns: number
  /** Admitted jobs this process has not started yet (6.61.3): waiting for an earlier run
   * in their session, an orphan fence, or a drain refusing their start. Durable and
   * `accepted`, so a restart re-queues them; not provider work. */
  heldRuns: number
  shuttingDown: boolean
  callbackPersistenceFailures: number
  terminalProjectionFailures: number
  store: QueryJobStoreHealth
}

export class QueryJobCoordinatorError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'QueryJobCoordinatorError'
  }
}

/** Owns provider lifetime independently of every HTTP subscriber. The runner
 * sees one coordinator AbortSignal; route disconnects never reach it. */
export class QueryJobCoordinator {
  private readonly resolveSessionId: (requested?: string) => string
  private readonly partialFlushMs: number
  private readonly partialFlushChars: number
  private readonly providerTimeoutMs: number
  private readonly active = new Map<string, ActiveRun>()
  private readonly admittedMaintenance = new Map<string, MaintenanceWorkLease>()
  /** Held jobs, each with the function that ends its current wait early. */
  private readonly holds = new Map<string, () => void>()
  /** Admitted jobs inside execute that have not started (or given up) yet. */
  private readonly waiting = new Set<string>()
  /** 6.78.0: steer ports by job, registered before a steerable run's runner starts. */
  private readonly steerPorts = new Map<string, SteerPort>()
  private readonly holdRecheckMs: number
  private admissionTail: Promise<void> = Promise.resolve()
  private shuttingDown = false
  private callbackPersistenceFailures = 0
  private terminalProjectionFailures = 0

  constructor(
    readonly store: QueryJobStore,
    private readonly runner: QueryJobRunner,
    private readonly options: QueryJobCoordinatorOptions = {},
  ) {
    this.resolveSessionId = options.resolveSessionId ?? getOrCreateSession
    this.partialFlushMs = Math.max(0, options.partialFlushMs ?? 50)
    this.partialFlushChars = Math.max(1, options.partialFlushChars ?? 1_024)
    this.providerTimeoutMs = Math.max(1_000, options.providerTimeoutMs ?? 21 * 60_000)
    this.holdRecheckMs = Math.max(10, options.holdRecheckMs ?? 30_000)
  }

  async init(): Promise<QueryJobCoordinatorHealth> {
    await this.store.init()
    // The journal is authoritative. Repair the derived conversation
    // projection after a crash before advertising the runtime as ready.
    if (this.options.projectTerminal) {
      for (const execution of await this.store.listRetainedExecutions()) {
        if (isTerminalQueryJobStatus(execution.job.status)) {
          await this.projectTerminal(execution.job, execution.request)
        }
      }
    }
    // 6.61.3: work the last boot admitted but never started runs now, with no
    // phone needed to send it again, in admission order. Each takes its own start
    // lease in execute.
    const parked: string[] = []
    for (const { jobId, sessionId } of this.store.takeRequeuedOnBoot()) {
      // 6.78.0: counted BEFORE its start is queued, so a start that kills the process is
      // counted. Past the limit the job is parked: never started again by a boot.
      if (!this.admitBootRequeue(jobId)) { parked.push(jobId); continue }
      queueMicrotask(() => { void this.execute(jobId, sessionId) })
    }
    for (const jobId of parked) await this.parkBootRequeue(jobId)
    return this.getHealth()
  }

  /** Keyed by lineage (clientJobId), so the app's Retry (a new generation) is the same item. */
  private admitBootRequeue(jobId: string): boolean {
    const gate = this.options.bootResumeGate?.()
    if (!gate) return true
    try {
      return gate.admit('query_job', this.store.lineageOf(jobId) ?? jobId, 'start')
    } catch {
      return true
    }
  }

  /**
   * A parked job ends `interrupted` with `restart_limit` and `interruption.resumable: false`, so
   * the app shows it and offers Retry (never Resume: its run never started).
   */
  private async parkBootRequeue(jobId: string): Promise<void> {
    try {
      const result = await this.store.interruptParked(jobId, crashLoopParkedError(this.options.bootResumeGate?.().limit))
      if (!result.applied) return
      console.warn(`[query-jobs] ${jobId.slice(0, 8)} parked: its start crashed the server on every boot; Retry runs it again`)
      const execution = await this.store.getExecution(jobId)
      await this.projectTerminal(execution.job, execution.request)
    } catch (error) {
      // Left `accepted`: the next boot offers it again and the gate keeps it parked.
      console.error(`[query-jobs] ${jobId.slice(0, 8)} could not be parked:`, error)
    }
  }

  private bootResumeLineage(op: 'retry' | 'forget', clientJobId: string): void {
    try {
      const gate = this.options.bootResumeGate?.()
      if (op === 'retry') gate?.retry('query_job', clientJobId)
      else gate?.forget('query_job', clientJobId)
    } catch { /* the gate fails open on its own; never fail an admission or a start */ }
  }

  /** Admission serialization makes first-run session allocation idempotent:
   * two simultaneous retries without a sessionId cannot allocate two sessions
   * and conflict solely because the client had not learned the first one. */
  submit(raw: unknown): Promise<QueryJobAdmissionResult> {
    const maintenanceLease = this.options.acquireMaintenanceWork?.()
    let resolve!: (value: QueryJobAdmissionResult) => void
    let reject!: (reason?: unknown) => void
    const result = new Promise<QueryJobAdmissionResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const operation = this.admissionTail.catch(() => {}).then(async () => {
      try {
        if (this.shuttingDown) throw new QueryJobCoordinatorError('query_job_coordinator_shutting_down')
        const normalized = await this.assignSession(raw)
        const admission = await this.store.admit(normalized)
        resolve(admission)
        if (admission.created) {
          // 6.78.0: a new generation of a lineage is the person's Retry (the app's Retry or
          // Resume, or a Messages retry): a parked lineage is unparked and its count starts over.
          if (admission.job.generation > 1) this.bootResumeLineage('retry', admission.job.clientJobId)
          if (maintenanceLease) this.admittedMaintenance.set(admission.job.jobId, maintenanceLease)
          queueMicrotask(() => { void this.execute(admission.job.jobId, admission.job.sessionId) })
        } else {
          maintenanceLease?.release()
        }
      } catch (error) {
        maintenanceLease?.release()
        reject(error)
      }
    })
    this.admissionTail = operation.then(() => {}, () => {})
    return result
  }

  private async assignSession(raw: unknown): Promise<unknown> {
    if (!raw || typeof raw !== 'object') return raw
    const input = raw as Record<string, unknown>
    if (typeof input.sessionId === 'string' && input.sessionId.trim()) return input

    const clientJobId = typeof input.clientJobId === 'string' && CLIENT_JOB_ID_RE.test(input.clientJobId)
      ? input.clientJobId.toLowerCase() : undefined
    const generation = parsePositiveInteger(input.generation)
    let sessionId: string | undefined
    if (clientJobId && generation != null && generation > 0) {
      sessionId = (await this.store.findByClientGeneration(clientJobId, generation))?.sessionId
    }
    sessionId ??= this.resolveSessionId(undefined)
    return { ...input, sessionId }
  }

  /**
   * Mark a job starting, holding it first while its session is orphan-fenced (6.61.3).
   *
   * THE CONTRACT: a prompt the Mac accepted runs to an answer whether or not the
   * phone stays connected. The job is durable before this runs, so the hold needs
   * no subscriber, and a phone that drops reads the answer when it reconnects.
   *
   * The lease is RELEASED for the hold, so a fence (itself left by a restart) cannot
   * block the next Update Server for 21 minutes. Nothing is lost if that restart lands
   * mid-hold: the job is still `accepted`, and the next boot re-queues it. The start
   * takes a fresh lease, which a drain refuses; the job then stays held and retries,
   * rather than starting a provider under a closing server.
   *
   * Returns null when this process will not run the job: it went terminal (a cancel
   * during the hold), the coordinator is shutting down, or the store refused.
   */
  private async startWhenClear(
    jobId: string,
    admitted: MaintenanceWorkLease | undefined,
  ): Promise<{ lease?: MaintenanceWorkLease } | null> {
    const id = jobId.slice(0, 8)
    let lease = admitted
    let heldSinceMs: number | null = null
    let drainNoted = false
    let fenceNoted = false
    for (;;) {
      if (this.shuttingDown) {
        lease?.release()
        if (heldSinceMs != null) console.info(`[query-jobs] ${id} held job left accepted for the next boot (shutdown)`)
        return null
      }
      if (!lease && this.options.acquireMaintenanceWork) {
        try {
          lease = this.options.acquireMaintenanceWork()
        } catch (error) {
          if (!drainNoted) {
            drainNoted = true
            heldSinceMs ??= Date.now()
            console.warn(`[query-jobs] ${id} held: start lease refused (${(error as { code?: unknown })?.code ?? 'error'}); retrying every ${Math.round(this.holdRecheckMs / 1000)}s`)
            await this.appendStatusOnce(jobId, [DRAIN_HOLD_STATUS])
          }
          await this.holdFor(jobId, this.holdRecheckMs)
          continue
        }
      }
      try {
        const starting = await this.store.markStarting(jobId, () => !this.shuttingDown)
        if (starting.applied) {
          // 6.78.0: a started job is never handed back by a boot again, so its count is done.
          this.bootResumeLineage('forget', starting.job.clientJobId)
          if (heldSinceMs != null) console.info(`[query-jobs] ${id} starting after a ${Math.round((Date.now() - heldSinceMs) / 1000)}s hold`)
          return { lease }
        }
        lease?.release()
        if (heldSinceMs != null) console.info(`[query-jobs] ${id} held job ended without starting (${starting.job.status})`)
        return null
      } catch (error) {
        if (!(error instanceof QueryJobProviderOrphanFenceError)) {
          lease?.release()
          console.error(`[query-jobs] ${id} could not start; left accepted for the next boot:`, error)
          return null
        }
        if (!fenceNoted) {
          fenceNoted = true
          heldSinceMs ??= Date.now()
          console.warn(`[query-jobs] ${id} held: a provider of its session may still be running; starts after ${new Date(Date.now() + error.retryAfterMs).toISOString()}`)
          // Journaled while the lease still covers this job.
          await this.appendStatusOnce(jobId, orphanFenceHoldStatus(Date.now() + error.retryAfterMs))
        }
        lease?.release()
        lease = undefined
        await this.holdFor(jobId, Math.min(error.retryAfterMs + FENCE_HOLD_SLACK_MS, this.holdRecheckMs))
      }
    }
  }

  /** Append status lines unless they are already the job's latest ones: a restart in the
   * middle of a hold must not repeat them. A failed append never stops the hold. */
  private async appendStatusOnce(jobId: string, lines: readonly string[]): Promise<void> {
    try {
      const statuses = (await this.store.getSnapshot(jobId)).activity
        .filter(entry => entry.kind === 'status')
        .map(entry => entry.text)
      if (lines.every((line, index) => statuses[statuses.length - lines.length + index] === line)) return
      for (const line of lines) await this.store.appendActivity(jobId, 'status', line)
    } catch (error) {
      console.warn(`[query-jobs] ${jobId.slice(0, 8)} hold status not journaled:`, error)
    }
  }

  /** One bounded wait for a held job, ended early by cancel or shutdown. */
  private holdFor(jobId: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const end = () => {
        clearTimeout(timer)
        if (this.holds.get(jobId) === end) this.holds.delete(jobId)
        resolve()
      }
      const timer = setTimeout(end, Math.max(0, ms))
      timer.unref?.()
      this.holds.set(jobId, end)
    })
  }

  private async execute(jobId: string, sessionId: string): Promise<void> {
    // The session lock is REQUESTED before anything awaits, so the jobs of one session
    // line up for it in admission order (submit and the boot requeue call this in that
    // order, and the lock is first-come-first-served). A job waiting for it is still
    // `accepted`, so a restart re-queues it instead of interrupting it.
    const lockRequest = this.options.acquireSessionLock?.(sessionId)
    const admitted = this.admittedMaintenance.get(jobId)
    this.admittedMaintenance.delete(jobId)
    this.waiting.add(jobId)
    let release: (() => void) | undefined
    let maintenanceLease: MaintenanceWorkLease | undefined
    let steerMode = false
    let execution
    try {
      if (lockRequest) {
        // Released while it waits: a run queued behind a long one, or a held one, must not
        // hold Update Server's drain open. startWhenClear takes a fresh lease to start.
        admitted?.release()
        try {
          release = await lockRequest
        } catch (error) {
          await this.store.fail(jobId, error).catch(() => {})
          return
        }
      }
      try {
        execution = await this.store.getExecution(jobId)
      } catch {
        if (!lockRequest) admitted?.release()
        release?.()
        return
      }
      // 6.78.0: decided before the start (the CLI probe is cached), so nothing awaits between
      // the start and the runner but the steer seeding below.
      // With the switch off nothing is awaited here, so a 6.77.0 start keeps its exact timing.
      if (this.options.steer?.enabled()) steerMode = await this.steerable(execution.request)
      const started = await this.startWhenClear(jobId, lockRequest ? undefined : admitted)
      if (!started) {
        release?.()
        return
      }
      maintenanceLease = started.lease
      if (this.shuttingDown) {
        // markStarting won its write just before shutdown began. Never spawn under a
        // closing server: the job stays `starting`, the next boot interrupts it (no
        // provider owned the session, so no fence) and the phone can retry it.
        maintenanceLease?.release()
        release?.()
        return
      }
    } finally {
      this.waiting.delete(jobId)
    }
    maintenanceLease?.setPhase('active')

    let resolveTerminal!: () => void
    const terminalPromise = new Promise<void>(resolve => { resolveTerminal = resolve })
    let resolveProviderTimeout!: () => void
    const providerTimeoutPromise = new Promise<void>(resolve => { resolveProviderTimeout = resolve })
    const active: ActiveRun = {
      jobId,
      generation: execution.job.generation,
      request: execution.request,
      controller: new AbortController(),
      release,
      maintenanceLease,
      released: false,
      callbackTail: Promise.resolve(),
      partialText: '',
      partialTruncated: false,
      pendingDelta: '',
      partialTimer: null,
      terminalPersisted: false,
      persistenceFailed: false,
      terminalPromise,
      resolveTerminal,
      providerTimeoutPromise,
      resolveProviderTimeout,
      providerTimeoutTimer: null,
    }
    if (steerMode) {
      active.steer = this.steerPortFor(active)
      this.steerPorts.set(jobId, active.steer)
    }
    this.active.set(jobId, active)
    if (active.steer) {
      // Registered first, then seeded, so a steer journaled meanwhile is offered by one side or
      // both (the port drops a repeat): the ones accepted while the job waited, then, for a
      // Retry or Resume, the ones an interrupted or failed generation did not get to apply.
      await this.seedSteers(active).catch(error => { this.handleCallbackPersistenceFailure(active, error) })
      if (active.terminalPersisted || active.persistenceFailed) return
      if (this.shuttingDown) {
        // As above: never spawn under a closing server. The job stays `starting` for the boot.
        this.abandonActive(active)
        return
      }
    }

    const callbacks = this.callbacksFor(active)
    try {
      const runnerPromise = this.runner({
        jobId,
        turnId: execution.job.turnId,
        request: execution.request,
        signal: active.controller.signal,
        callbacks,
        ...(active.steer ? { steer: active.steer } : {}),
      })

      const runnerFailed = runnerPromise.then(
        () => new Promise<never>(() => {}),
        error => Promise.reject(error),
      )
      // Provider lifetime ends only at a terminal callback, never merely when
      // runnerPromise resolves after child spawn. The timeout is armed by the
      // durable onStart boundary, after model-router acquires its per-session
      // lock; queued jobs therefore retain their full execution budget.
      const outcome = await Promise.race([
        active.terminalPromise.then(() => 'terminal' as const),
        active.providerTimeoutPromise.then(() => 'timeout' as const),
        runnerFailed,
      ])
      if (outcome === 'timeout' && !active.terminalPersisted && !active.persistenceFailed) {
        const snapshot = await this.store.getSnapshot(active.jobId)
        if (snapshot.status === 'answer_ready') {
          // Generation is finished; only bridge post-processing missed its
          // deadline. Preserve the already-durable answer instead of turning
          // a successful model run into a failure.
          await this.completeActive(active, {
            text: snapshot.partialText,
            attachments: snapshot.attachments,
            outputImageStats: snapshot.outputImageStats,
            provider: snapshot.provider,
            resolvedModel: snapshot.resolvedModel,
            cliSessionId: snapshot.cliSessionId,
            claudeRunId: snapshot.claudeRunId,
            codexRunId: snapshot.codexRunId,
            codexThreadId: snapshot.codexThreadId,
            cursorRunId: snapshot.cursorRunId,
          })
          // Generation is already durable, but bridge post-processing missed
          // its deadline. Abort that tail after committing the answer so the
          // coordinator-owned session lease is always released.
          active.controller.abort(Object.assign(new Error('Post-answer processing exceeded the durable job deadline.'), {
            code: 'postprocess_timeout',
          }))
        } else {
          const error = { code: 'provider_timeout', message: 'Provider exceeded the durable job deadline.', retryable: true }
          await this.failActive(active, error)
          // Timeout is an authorized coordinator abort. The failed terminal
          // was durable and projected before the child receives cancellation.
          active.controller.abort(Object.assign(new Error(error.message), { code: error.code }))
        }
      }
    } catch (error) {
      await active.callbackTail.catch(() => {})
      if (!active.persistenceFailed) await this.failActive(active, error).catch(() => {})
    } finally {
      if (active.providerTimeoutTimer) clearTimeout(active.providerTimeoutTimer)
      active.providerTimeoutTimer = null
    }
  }

  private callbacksFor(active: ActiveRun): QueryJobRunnerCallbacks {
    return {
      onStart: async (start) => {
        if (start.sessionId && start.sessionId !== active.request.sessionId) {
          const error = Object.assign(new Error('Provider returned a different COS session.'), {
            code: 'session_identity_mismatch',
          })
          active.controller.abort(error)
          await this.failActive(active, error)
          return
        }
        await this.enqueueCallback(active, async () => {
          const result = await this.store.markRunning(active.jobId, start)
          if (result.job.status === 'running') this.armProviderDeadline(active)
          if (isTerminalQueryJobStatus(result.job.status)) this.finishActive(active)
        })
      },
      onProviderProcess: linkage => this.providerProcessReady(active, linkage),
      onLinkage: linkage => this.enqueueCallback(active, async () => {
        await this.store.updateLinkage(active.jobId, linkage)
      }),
      onChunk: (text) => { this.queuePartial(active, text) },
      onToolStatus: (text) => {
        if (active.request.activityToolMode === 'off') text = 'Processing...'
        void this.enqueueCallback(active, async () => {
          await this.store.appendActivity(active.jobId, 'status', text)
        })
      },
      onActivityLine: (line) => {
        if (active.request.activityToolMode !== 'preview') return
        void this.enqueueCallback(active, async () => {
          await this.store.appendActivity(active.jobId, line.kind, line.text)
        })
      },
      onTrail: (draft) => {
        // The user's opt-out is decided HERE, from the job's own request: `off` keeps no
        // tool steps, `status` keeps steps without raw output (see applyTrailToolMode).
        const allowed = applyTrailToolMode(draft, active.request.activityToolMode)
        if (!allowed) return
        void this.enqueueCallback(active, async () => {
          await this.store.appendTrail(active.jobId, allowed)
        })
      },
      onAnswerReady: (text, linkage = {}) => this.answerReady(active, text, linkage),
      onDone: completion => this.completeActive(active, completion),
      onError: error => this.failActive(active, error),
    }
  }

  private enqueueCallback(active: ActiveRun, operation: () => Promise<void>): Promise<void> {
    if (active.terminalPersisted || active.persistenceFailed) return active.callbackTail
    const result = active.callbackTail.then(operation)
    active.callbackTail = result.catch(error => { this.handleCallbackPersistenceFailure(active, error) })
    return result
  }

  private handleCallbackPersistenceFailure(active: ActiveRun, error: unknown): void {
    if (active.persistenceFailed) return
    active.persistenceFailed = true
    this.callbackPersistenceFailures++
    if (active.partialTimer) clearTimeout(active.partialTimer)
    active.partialTimer = null
    // Persistence loss is an internal safety failure. Abort provider work, but
    // do not publish or manufacture an unpersisted terminal state.
    active.controller.abort(error)
    active.resolveTerminal()
    this.abandonActive(active)
  }

  private armProviderDeadline(active: ActiveRun): void {
    if (active.providerTimeoutTimer || active.terminalPersisted || active.persistenceFailed) return
    // On the monotonic steer clock (P7 S7): decideSteer compares it with the bridge's wall clock.
    active.deadlineAt = steerClock() + this.providerTimeoutMs
    active.providerTimeoutTimer = setTimeout(() => active.resolveProviderTimeout(), this.providerTimeoutMs)
    active.providerTimeoutTimer.unref?.()
  }

  private queuePartial(active: ActiveRun, value: string): void {
    if (active.terminalPersisted || active.persistenceFailed || typeof value !== 'string' || value.length === 0) return
    const remaining = Math.max(0, QUERY_JOB_LIMITS.partialChars - active.partialText.length)
    if (remaining > 0) active.partialText += value.slice(0, remaining)
    if (value.length > remaining) active.partialTruncated = true
    active.pendingDelta += value
    if (active.pendingDelta.length >= this.partialFlushChars || this.partialFlushMs === 0) {
      void this.flushPartial(active)
      return
    }
    if (active.partialTimer) return
    active.partialTimer = setTimeout(() => {
      active.partialTimer = null
      void this.flushPartial(active)
    }, this.partialFlushMs)
    active.partialTimer.unref?.()
  }

  private flushPartial(active: ActiveRun, authoritativeText?: string): Promise<void> {
    if (active.partialTimer) clearTimeout(active.partialTimer)
    active.partialTimer = null
    if (typeof authoritativeText === 'string') {
      const bounded = authoritativeText.slice(0, QUERY_JOB_LIMITS.partialChars)
      const previous = active.partialText
      active.partialText = bounded
      active.partialTruncated = authoritativeText.length > QUERY_JOB_LIMITS.partialChars
      if (bounded.startsWith(previous)) active.pendingDelta += bounded.slice(previous.length)
      else if (!active.pendingDelta) active.pendingDelta = bounded
    }
    if (!active.pendingDelta) return active.callbackTail
    const delta = active.pendingDelta
    active.pendingDelta = ''
    return this.enqueueCallback(active, async () => {
      await this.store.appendPartial(active.jobId, delta, active.partialText, active.partialTruncated)
    })
  }

  private async providerProcessReady(
    active: ActiveRun,
    linkage: QueryJobProviderLinkage,
  ): Promise<boolean> {
    if (active.terminalPersisted || active.persistenceFailed) return false
    let owned = false
    await this.enqueueCallback(active, async () => {
      const result = await this.store.updateLinkage(active.jobId, linkage)
      owned = result.applied && result.job.status === 'running'
      if (isTerminalQueryJobStatus(result.job.status)) this.finishActive(active)
    })
    return owned && !active.terminalPersisted && !active.persistenceFailed
  }

  private async answerReady(
    active: ActiveRun,
    text: string,
    linkage: QueryJobProviderLinkage,
  ): Promise<boolean> {
    if (active.terminalPersisted || active.persistenceFailed) return false
    await this.flushPartial(active, text)
    if (active.terminalPersisted || active.persistenceFailed) return false
    let owned = false
    await this.enqueueCallback(active, async () => {
      const result = await this.store.markAnswerReady(active.jobId, text, linkage)
      owned = result.applied && result.job.status === 'answer_ready'
      if (isTerminalQueryJobStatus(result.job.status)) this.finishActive(active)
    })
    return owned && !active.terminalPersisted && !active.persistenceFailed
  }

  private async completeActive(active: ActiveRun, completion: QueryJobRunnerCompletion): Promise<boolean> {
    try {
      if (active.terminalPersisted || active.persistenceFailed) return false
      await this.flushPartial(active, completion.text)
      await active.callbackTail
      if (active.persistenceFailed) return false
      let snapshot = await this.store.getSnapshot(active.jobId)
      if (isTerminalQueryJobStatus(snapshot.status)) {
        this.finishActive(active)
        return false
      }
      if (snapshot.status !== 'answer_ready') {
        await this.store.markAnswerReady(active.jobId, completion.text, completion)
      }
      const result = await this.store.complete(active.jobId, completion)
      snapshot = result.job
      const projected = isTerminalQueryJobStatus(snapshot.status)
        ? await this.projectTerminal(snapshot, active.request)
        : false
      if (isTerminalQueryJobStatus(snapshot.status)) this.finishActive(active)
      return result.applied && snapshot.status === 'completed' && projected
    } catch (error) {
      // Bridge finalize paths can be fire-and-forget. A journal failure must
      // become coordinator health/abort state, never an unhandled rejection or
      // a compatibility display for a reply that was not durably terminal.
      this.handleCallbackPersistenceFailure(active, error)
      return false
    }
  }

  private async failActive(active: ActiveRun, error: unknown): Promise<boolean> {
    try {
      if (active.terminalPersisted || active.persistenceFailed) return false
      if (active.partialTimer) clearTimeout(active.partialTimer)
      active.partialTimer = null
      await active.callbackTail.catch(() => {})
      if (active.persistenceFailed) return false
      const snapshot = await this.store.getSnapshot(active.jobId)
      if (isTerminalQueryJobStatus(snapshot.status)) {
        this.finishActive(active)
        return false
      }
      const result = await this.store.fail(active.jobId, normalizeQueryJobError(error))
      const projected = isTerminalQueryJobStatus(result.job.status)
        ? await this.projectTerminal(result.job, active.request)
        : false
      if (isTerminalQueryJobStatus(result.job.status)) this.finishActive(active)
      return result.applied && result.job.status === 'failed' && projected
    } catch (persistenceError) {
      this.handleCallbackPersistenceFailure(active, persistenceError)
      return false
    }
  }

  async cancel(jobId: string, generation: number): Promise<QueryJobMutationResult> {
    const result = await this.store.cancel(jobId, generation)
    if (result.applied) {
      // A held job is not active: end its wait so it sees the cancel now.
      this.holds.get(jobId)?.()
      const active = this.active.get(jobId)
      const request = active?.request ?? (await this.store.getExecution(jobId)).request
      await this.projectTerminal(result.job, request)
      if (active && active.generation === generation) {
        // The canceled record is durable and was published before this abort.
        active.controller.abort(Object.assign(new Error('Canceled by user.'), { code: 'canceled' }))
        this.finishActive(active)
      }
    }
    return result
  }

  finishIfActive(jobId: string): void {
    const active = this.active.get(jobId)
    if (active) this.finishActive(active)
  }

  getSnapshot(jobId: string, generation?: number): Promise<QueryJobSnapshot> {
    return this.store.getSnapshot(jobId, generation)
  }

  async getByClientGeneration(clientJobId: string, generation: number): Promise<QueryJobSnapshot | undefined> {
    return this.store.findByClientGeneration(clientJobId, generation)
  }

  async acknowledge(jobId: string, generation: number): Promise<QueryJobSnapshot> {
    return (await this.store.acknowledge(jobId, generation)).job
  }

  subscribe(
    jobId: string,
    generation: number,
    after: number,
    listener: Parameters<QueryJobStore['subscribe']>[3],
    trail?: Parameters<QueryJobStore['subscribe']>[4],
    steer?: Parameters<QueryJobStore['subscribe']>[5],
  ): Promise<QueryJobSubscription> {
    if (steer) return this.store.subscribe(jobId, generation, after, listener, trail, steer)
    return trail
      ? this.store.subscribe(jobId, generation, after, listener, trail)
      : this.store.subscribe(jobId, generation, after, listener)
  }

  /**
   * 6.78.0 Messages steer, in the plan's order: validate; look the steer id up across the
   * lineage (the same text replays, other text is a conflict) BEFORE the generation check;
   * decide and journal (fsynced) `accepted`, `too_late` or `unsupported`; then, for an
   * accepted steer, write it through the run's port. The reply is the state after the write:
   * a steer the port could no longer take is journaled `too_late` and answered so.
   */
  async steer(jobId: string, raw: unknown): Promise<QueryJobSteerReply> {
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const generation = parsePositiveInteger(body.generation)
    if (generation == null || generation < 1) throw new QueryJobValidationError('invalid_generation')
    const steerId = parseSteerId(body.steerId)
    const text = parseSteerText(body.text)
    await this.store.init()
    const clientJobId = this.store.lineageOf(jobId)
    if (!clientJobId) throw new QueryJobNotFoundError(jobId)
    const known = await this.store.findSteer(clientJobId, steerId)
    if (known) {
      if (known.textSha256 !== steerTextSha256(text)) throw new QueryJobSteerConflictError()
      return steerReply(known.steer, known.job)
    }
    const job = await this.store.getSnapshot(jobId, generation)
    if (await this.store.steerCount(jobId) >= QUERY_JOB_STEER_LIMITS.steersPerJob) throw new QueryJobSteerLimitError()
    const decided = await this.decideSteer(job)
    let result = await this.store.appendSteer(jobId, { steerId, state: decided, text, create: true })
    if (result.applied && result.steer.state === 'accepted') {
      const port = this.steerPorts.get(jobId)
      if (port && port.offer({ steerId, text }) === 'closed') {
        result = await this.store.appendSteer(jobId, { steerId, state: 'too_late' })
      }
    }
    return steerReply(result.steer, result.job)
  }

  /** 6.78.0: GET /query-jobs/steers/:steerId?clientJobId=, from the newest generation. */
  async steerStatus(clientJobId: string, rawSteerId: unknown): Promise<QueryJobSteerReply> {
    const steerId = parseSteerId(rawSteerId)
    const known = await this.store.findSteer(clientJobId, steerId)
    if (!known) throw new QueryJobSteerUnknownError()
    return steerReply(known.steer, known.job)
  }

  private async steerable(request: QueryJobRequest): Promise<boolean> {
    const options = this.options.steer
    if (!options || !options.enabled() || request.steerable !== true || request.dispatch) return false
    try {
      if (options.provider(request) !== 'claude') return false
      return await options.cliSupported()
    } catch {
      return false
    }
  }

  /** The state a new steer is journaled with (before the port is tried). */
  private async decideSteer(job: QueryJobSnapshot): Promise<'accepted' | 'too_late' | 'unsupported'> {
    if (isTerminalQueryJobStatus(job.status) || job.status === 'answer_ready') return 'too_late'
    const active = this.active.get(job.jobId)
    if (!active) {
      // Not started yet (waiting its turn, fenced, or held by a drain): it reads the predicate.
      const execution = await this.store.getExecution(job.jobId)
      return await this.steerable(execution.request) ? 'accepted' : 'unsupported'
    }
    const port = active.steer
    if (!port) return 'unsupported'
    if (port.isClosed) return 'too_late'
    // Monotonic, as the timers that end the run are (P7 S7): after a Mac sleep Date.now()
    // has jumped and every steer would read too late.
    const now = steerClock()
    const wallMax = port.wallMax()
    const margin = steerCutoffMs(wallMax ?? this.providerTimeoutMs)
    const wallLeft = port.wallRemainingMs(now)
    if (wallLeft !== null && wallLeft < margin) return 'too_late'
    if (active.deadlineAt !== undefined && active.deadlineAt - now < margin) return 'too_late'
    return 'accepted'
  }

  /** A steer port whose events journal through the run's ordered callback tail. */
  private steerPortFor(active: ActiveRun): SteerPort {
    const journal = (operation: () => Promise<unknown>) => {
      void this.enqueueCallback(active, async () => {
        try {
          await operation()
        } catch (error) {
          // A broken journal is the run's failure; a steer bookkeeping refusal is not.
          if (error instanceof QueryJobPersistenceError || !(error instanceof QueryJobStoreError)) throw error
          console.warn(`[query-jobs] ${active.jobId.slice(0, 8)} steer not journaled:`, (error as Error).message)
        }
      })
    }
    const jobId = active.jobId
    return new SteerPort({
      onIncluded: steers => journal(async () => {
        for (const steer of steers) {
          await this.store.appendSteer(jobId, steer.carriedFrom !== undefined
            ? { steerId: steer.steerId, state: 'included', text: steer.text, carriedFrom: steer.carriedFrom, create: true }
            : { steerId: steer.steerId, state: 'included' })
        }
      }),
      onDelivered: steerId => journal(() => this.store.appendSteer(jobId, { steerId, state: 'delivered' })),
      onFolded: steerIds => journal(async () => {
        for (const steerId of steerIds) await this.store.appendSteer(jobId, { steerId, state: 'folded' })
      }),
      onCheckpoint: text => journal(() => this.store.appendSteerCheckpoint(jobId, text)),
    })
  }

  /** Offer the run's port what it must start with: this job's accepted steers, then carried ones. */
  private async seedSteers(active: ActiveRun): Promise<void> {
    const port = active.steer!
    const own: PendingSteer[] = (await this.store.queuedSteers(active.jobId))
      .filter(steer => steer.state === 'accepted' && steer.carriedFrom === undefined)
      .map(steer => ({ steerId: steer.steerId, text: steer.text }))
    for (const steer of own) port.offer(steer)
    if (active.generation > 1) {
      for (const steer of await this.store.listCarryableSteers(active.request.clientJobId, active.generation)) port.offer(steer)
    }
  }

  async shutdown(reason = 'server_shutdown'): Promise<void> {
    this.shuttingDown = true
    // Held jobs stay `accepted` in the journal; the next boot re-queues them.
    for (const end of [...this.holds.values()]) end()
    await this.admissionTail.catch(() => {})
    // 6.78.0 restart truth: the notice is built from the journal, so the steps a run reported
    // before this point reach it first (bounded; see SHUTDOWN_CALLBACK_DRAIN_MS). Off, the
    // interrupt is written at once, as 6.77.0 did, ahead of any queued step.
    if ((this.options.restartNotice ?? restartNoticeEnabled)()) await this.drainCallbacks([...this.active.values()])
    for (const active of [...this.active.values()]) {
      try {
        const result = await this.store.interrupt(active.jobId, reason)
        if (result.applied || isTerminalQueryJobStatus(result.job.status)) {
          await this.projectTerminal(result.job, active.request)
          active.controller.abort(Object.assign(new Error(reason), { code: 'interrupted' }))
          this.finishActive(active)
        }
      } catch (error) {
        this.handleCallbackPersistenceFailure(active, error)
      }
    }
  }

  /** Every run's queued callback writes, all at once, for at most the drain bound. Never throws. */
  private async drainCallbacks(runs: ActiveRun[]): Promise<void> {
    if (runs.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(resolve, Math.max(0, this.options.shutdownDrainMs ?? SHUTDOWN_CALLBACK_DRAIN_MS))
      timer.unref?.()
    })
    try {
      await Promise.race([Promise.all(runs.map(run => run.callbackTail.catch(() => {}))), bound])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private finishActive(active: ActiveRun): void {
    if (active.terminalPersisted) return
    active.terminalPersisted = true
    this.releaseSteerPort(active)
    active.resolveTerminal()
    if (active.providerTimeoutTimer) clearTimeout(active.providerTimeoutTimer)
    active.providerTimeoutTimer = null
    if (active.partialTimer) clearTimeout(active.partialTimer)
    active.partialTimer = null
    this.active.delete(active.jobId)
    if (!active.released) {
      active.released = true
      active.release?.()
      active.maintenanceLease?.release()
    }
  }

  private releaseSteerPort(active: ActiveRun): void {
    if (!active.steer) return
    active.steer.close()
    if (this.steerPorts.get(active.jobId) === active.steer) this.steerPorts.delete(active.jobId)
  }

  private abandonActive(active: ActiveRun): void {
    this.releaseSteerPort(active)
    if (active.providerTimeoutTimer) clearTimeout(active.providerTimeoutTimer)
    active.providerTimeoutTimer = null
    if (active.partialTimer) clearTimeout(active.partialTimer)
    active.partialTimer = null
    this.active.delete(active.jobId)
    if (!active.released) {
      active.released = true
      active.release?.()
      active.maintenanceLease?.release()
    }
  }

  private async projectTerminal(job: QueryJobSnapshot, request: QueryJobRequest): Promise<boolean> {
    if (!this.options.projectTerminal || !isTerminalQueryJobStatus(job.status)) return true
    try {
      await this.options.projectTerminal(job, request)
      return true
    } catch (error) {
      this.terminalProjectionFailures++
      console.error(`[query-jobs] terminal conversation projection failed for ${job.jobId}:`, error)
      return false
    }
  }

  /** Message numbers held by admitted, not-yet-terminal jobs (see
   * lib/message-reservations.ts). Sync: read straight off the store's identities. */
  liveMessageReservations(): Array<{ jobId: string; sessionId: string; messageEra?: string; globalMsgNum: number }> {
    return this.store.listLiveMessageReservations()
  }

  getHealth(): QueryJobCoordinatorHealth {
    return {
      activeRuns: this.active.size,
      heldRuns: this.waiting.size,
      shuttingDown: this.shuttingDown,
      callbackPersistenceFailures: this.callbackPersistenceFailures,
      terminalProjectionFailures: this.terminalProjectionFailures,
      store: this.store.getHealth(),
    }
  }
}

export function queryJobErrorCode(error: unknown): string {
  if (error instanceof QueryJobStoreError || error instanceof QueryJobCoordinatorError) return error.code
  return normalizeQueryJobError(error).code
}
