import { getOrCreateSession } from './conversation.js'
import {
  QueryJobStore,
  QueryJobStoreError,
  type QueryJobAdmissionResult,
  type QueryJobSubscription,
} from './query-job-store.js'
import {
  QUERY_JOB_LIMITS,
  isTerminalQueryJobStatus,
  normalizeQueryJobError,
  parsePositiveInteger,
  type QueryJobProviderLinkage,
  type QueryJobOutputImageStats,
  type QueryJobRequest,
  type QueryJobSnapshot,
  type QueryJobStoreHealth,
} from './query-job-types.js'
import type { MaintenanceWorkLease } from './maintenance-lifecycle.js'

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
  onChunk: (text: string) => void
  onToolStatus: (text: string) => void
  onActivityLine: (line: { kind: 'input' | 'output'; text: string }) => void
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
}

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
}

export interface QueryJobCoordinatorHealth {
  activeRuns: number
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
    return this.getHealth()
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
          if (maintenanceLease) this.admittedMaintenance.set(admission.job.jobId, maintenanceLease)
          queueMicrotask(() => { void this.execute(admission.job.jobId) })
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

  private async execute(jobId: string): Promise<void> {
    const maintenanceLease = this.admittedMaintenance.get(jobId)
    this.admittedMaintenance.delete(jobId)
    const starting = await this.store.markStarting(jobId).catch(() => null)
    if (!starting?.applied) {
      maintenanceLease?.release()
      return
    }
    maintenanceLease?.setPhase('active')
    let execution
    try {
      execution = await this.store.getExecution(jobId)
    } catch {
      maintenanceLease?.release()
      return
    }
    let release: (() => void) | undefined
    try {
      release = await this.options.acquireSessionLock?.(execution.request.sessionId)
    } catch (error) {
      try {
        await this.store.fail(jobId, error)
      } finally {
        maintenanceLease?.release()
      }
      return
    }

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
    this.active.set(jobId, active)

    const callbacks = this.callbacksFor(active)
    try {
      const runnerPromise = this.runner({
        jobId,
        turnId: execution.job.turnId,
        request: execution.request,
        signal: active.controller.signal,
        callbacks,
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

  async cancel(jobId: string, generation: number): Promise<QueryJobSnapshot> {
    const result = await this.store.cancel(jobId, generation)
    if (result.applied) {
      const active = this.active.get(jobId)
      const request = active?.request ?? (await this.store.getExecution(jobId)).request
      await this.projectTerminal(result.job, request)
      if (active && active.generation === generation) {
        // The canceled record is durable and was published before this abort.
        active.controller.abort(Object.assign(new Error('Canceled by user.'), { code: 'canceled' }))
        this.finishActive(active)
      }
    }
    return result.job
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
  ): Promise<QueryJobSubscription> {
    return this.store.subscribe(jobId, generation, after, listener)
  }

  async shutdown(reason = 'server_shutdown'): Promise<void> {
    this.shuttingDown = true
    await this.admissionTail.catch(() => {})
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

  private finishActive(active: ActiveRun): void {
    if (active.terminalPersisted) return
    active.terminalPersisted = true
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

  private abandonActive(active: ActiveRun): void {
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

  getHealth(): QueryJobCoordinatorHealth {
    return {
      activeRuns: this.active.size,
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
