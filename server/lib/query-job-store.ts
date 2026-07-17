import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mergeMediaAttachmentRefs,
  parseMediaAttachmentRefs,
} from '../../shared/media-attachment.js'
import {
  QUERY_JOB_LIMITS,
  QUERY_JOB_SCHEMA_VERSION,
  boundedText,
  isTerminalQueryJobStatus,
  normalizeQueryJobError,
  parseQueryJobOutputImageStats,
  parseQueryJobRequest,
  requestFingerprint,
  sanitizeQueryJobActivity,
  type QueryJobActivity,
  type QueryJobActivityKind,
  type QueryJobError,
  type QueryJobEvent,
  type QueryJobEventType,
  type QueryJobProviderLinkage,
  type QueryJobReplay,
  type QueryJobRequest,
  type QueryJobSnapshot,
  type QueryJobStatus,
  type QueryJobStoreHealth,
} from './query-job-types.js'

const PARTITION_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const MAX_JOURNAL_RECORD_BYTES = 512 * 1024
const MAX_CHUNK_DELTA_CHARS = 16_000
export const QUERY_JOB_ORPHAN_FENCE_MS = 21 * 60_000

interface QueryJobJournalRecord {
  schemaVersion: typeof QUERY_JOB_SCHEMA_VERSION
  recordId: string
  partitionDay: string
  persistedAt: string
  bootId: string
  jobId: string
  clientJobId: string
  generation: number
  turnId: string
  requestFingerprint: string
  eventSeq: number
  type: QueryJobEventType
  status: QueryJobStatus
  request?: QueryJobRequest
  patch: Record<string, unknown>
  eventData: Record<string, unknown>
}

interface HydratedQueryJob {
  request: QueryJobRequest
  snapshot: QueryJobSnapshot
  events: QueryJobEvent[]
  lastBootId: string
}

interface QueryJobIdentity {
  jobId: string
  clientJobId: string
  generation: number
  sessionId: string
  fingerprint: string
  status: QueryJobStatus
  updatedAt: string
  orphanFenceUntil?: string
}

export interface QueryJobMutationResult {
  applied: boolean
  job: QueryJobSnapshot
  event?: QueryJobEvent
}

export interface QueryJobAdmissionResult {
  created: boolean
  job: QueryJobSnapshot
}

export interface QueryJobExecutionRecord {
  request: QueryJobRequest
  job: QueryJobSnapshot
}

export interface QueryJobSubscription {
  replay: QueryJobReplay
  unsubscribe: () => void
}

export interface QueryJobJournalStorage {
  prepare(root: string): Promise<void>
  listPartitions(root: string): Promise<string[]>
  readPartition(root: string, partition: string): Promise<string>
  removePartition(root: string, partition: string): Promise<void>
  append(root: string, partitionDay: string, line: string): Promise<void>
}

/** Default journal implementation. The store serializes calls; this adapter
 * supplies the OS durability boundary (append + fsync) and private modes. */
export class NodeQueryJobJournalStorage implements QueryJobJournalStorage {
  async prepare(root: string): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
  }

  async listPartitions(root: string): Promise<string[]> {
    try {
      return (await readdir(root)).filter(name => PARTITION_RE.test(name)).sort()
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
  }

  readPartition(root: string, partition: string): Promise<string> {
    return readFile(join(root, partition), 'utf8')
  }

  async removePartition(root: string, partition: string): Promise<void> {
    await rm(join(root, partition), { force: true })
  }

  async append(root: string, partitionDay: string, line: string): Promise<void> {
    await this.prepare(root)
    const path = join(root, `${partitionDay}.jsonl`)
    const handle = await open(path, 'a+', 0o600)
    try {
      await handle.chmod(0o600)
      const existing = await handle.stat()
      if (existing.size > 0) {
        const tail = Buffer.allocUnsafe(1)
        const { bytesRead } = await handle.read(tail, 0, 1, existing.size - 1)
        // Preserve a torn row as malformed evidence, then put the next valid
        // record on a fresh line so hydration can recover it independently.
        if (bytesRead === 1 && tail[0] !== 0x0a) await handle.write('\n')
      }
      await handle.write(`${line}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

export interface QueryJobStoreOptions {
  root: string
  bootId: string
  storage?: QueryJobJournalStorage
  now?: () => Date
  retentionDays?: number
  maxHydratedJobs?: number
  maxReplayEvents?: number
  maxActivityEntries?: number
}

export class QueryJobStoreError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'QueryJobStoreError'
  }
}

export class QueryJobPersistenceError extends QueryJobStoreError {
  constructor(code = 'query_job_persistence_failed', message = code) {
    super(code, message)
    this.name = 'QueryJobPersistenceError'
  }
}

export class QueryJobNotFoundError extends QueryJobStoreError {
  constructor(readonly jobId: string) {
    super('query_job_not_found')
    this.name = 'QueryJobNotFoundError'
  }
}

export class QueryJobGenerationMismatchError extends QueryJobStoreError {
  constructor(readonly jobId: string, readonly expected: number, readonly received: number) {
    super('query_job_generation_mismatch')
    this.name = 'QueryJobGenerationMismatchError'
  }
}

export class QueryJobIdentityConflictError extends QueryJobStoreError {
  constructor(readonly clientJobId: string, readonly generation: number) {
    super('job_identity_conflict')
    this.name = 'QueryJobIdentityConflictError'
  }
}

export class QueryJobActiveGenerationError extends QueryJobStoreError {
  constructor(readonly clientJobId: string) {
    super('job_generation_active')
    this.name = 'QueryJobActiveGenerationError'
  }
}

export class QueryJobGenerationOrderError extends QueryJobStoreError {
  constructor(readonly clientJobId: string) {
    super('job_generation_out_of_order')
    this.name = 'QueryJobGenerationOrderError'
  }
}

export class QueryJobProviderOrphanFenceError extends QueryJobStoreError {
  constructor(readonly retryAfterMs: number) {
    super('provider_orphan_fence', 'A prior provider may still be exiting. Retry after the orphan fence clears.')
    this.name = 'QueryJobProviderOrphanFenceError'
  }
}

export class QueryJobAnswerCommittingError extends QueryJobStoreError {
  constructor() {
    super('query_job_answer_committing', 'The answer is already committing and can no longer be canceled.')
    this.name = 'QueryJobAnswerCommittingError'
  }
}

export class QueryJobNotTerminalError extends QueryJobStoreError {
  constructor() {
    super('query_job_not_terminal')
    this.name = 'QueryJobNotTerminalError'
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function identityKey(clientJobId: string, generation: number): string {
  return `${clientJobId}:${generation}`
}

function localPartitionDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function retainedCutoffDay(now: Date, retainedDays: number): string {
  const localDay = localPartitionDay(now)
  const noon = new Date(`${localDay}T12:00:00Z`)
  // A partition begins at local midnight, while each job's retentionUntil is
  // acceptedAt + N full days. Keep the boundary partition for one additional
  // local day so a 23:59 admission is never deleted at 00:00 before its TTL.
  noon.setUTCDate(noon.getUTCDate() - Math.max(0, retainedDays))
  return noon.toISOString().slice(0, 10)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && code.slice(0, 80) || 'query_job_persistence_failed'
}

function safeOptional(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return sanitizeQueryJobActivity(value).text.slice(0, max)
}

const ALLOWED_TRANSITIONS: Record<QueryJobStatus, ReadonlySet<QueryJobStatus>> = {
  accepted: new Set(['starting', 'failed', 'canceled', 'interrupted']),
  starting: new Set(['running', 'answer_ready', 'completed', 'failed', 'canceled', 'interrupted']),
  running: new Set(['answer_ready', 'completed', 'failed', 'canceled', 'interrupted']),
  // Provider generation has crossed its durable commit barrier. From here the
  // answer may only become completed; cancellation, provider errors, process
  // shutdown, and post-processing failures must never discard durable text.
  answer_ready: new Set(['completed']),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  interrupted: new Set(),
}

export class QueryJobStore {
  private readonly storage: QueryJobJournalStorage
  private readonly now: () => Date
  private readonly retentionDays: number
  private readonly maxHydratedJobs: number
  private readonly maxReplayEvents: number
  private readonly maxActivityEntries: number
  private readonly jobs = new Map<string, HydratedQueryJob>()
  private readonly identitiesByJobId = new Map<string, QueryJobIdentity>()
  private readonly identitiesByKey = new Map<string, QueryJobIdentity>()
  private readonly emitter = new EventEmitter()
  private appendTail: Promise<void> = Promise.resolve()
  private initPromise: Promise<QueryJobStoreHealth> | null = null
  private partitions: string[] = []
  private subscriberCount = 0
  private readonly health: QueryJobStoreHealth

  constructor(private readonly options: QueryJobStoreOptions) {
    this.storage = options.storage ?? new NodeQueryJobJournalStorage()
    this.now = options.now ?? (() => new Date())
    this.retentionDays = Math.max(1, options.retentionDays ?? QUERY_JOB_LIMITS.retainedDays)
    this.maxHydratedJobs = Math.max(1, options.maxHydratedJobs ?? QUERY_JOB_LIMITS.hydratedJobs)
    this.maxReplayEvents = Math.max(1, options.maxReplayEvents ?? QUERY_JOB_LIMITS.replayEvents)
    this.maxActivityEntries = Math.max(1, options.maxActivityEntries ?? QUERY_JOB_LIMITS.activityEntries)
    this.emitter.setMaxListeners(1_000)
    this.health = {
      state: 'new',
      bootId: options.bootId,
      hydratedJobs: 0,
      retainedIdentities: 0,
      subscribers: 0,
      malformedRows: 0,
      journalFailures: 0,
      interruptedOnBoot: 0,
      evictedHydratedJobs: 0,
      lastErrorCode: null,
      lastSuccessfulWriteAt: null,
      rootFingerprint: createHash('sha256').update(options.root).digest('hex').slice(0, 16),
      counts: {
        accepted: 0, starting: 0, running: 0, answer_ready: 0,
        completed: 0, failed: 0, canceled: 0, interrupted: 0,
      },
    }
  }

  async init(): Promise<QueryJobStoreHealth> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.initialize()
    return this.initPromise
  }

  private async initialize(): Promise<QueryJobStoreHealth> {
    try {
      await this.storage.prepare(this.options.root)
      const cutoff = retainedCutoffDay(this.now(), this.retentionDays)
      const existing = await this.storage.listPartitions(this.options.root)
      for (const partition of existing) {
        if (partition.slice(0, 10) < cutoff) await this.storage.removePartition(this.options.root, partition)
      }
      this.partitions = await this.storage.listPartitions(this.options.root)
      for (const partition of this.partitions) await this.hydratePartition(partition)
      this.health.state = 'ready'

      // A local child process cannot survive a server boot. Persist the
      // classification once; never invoke a runner during hydration. An
      // answer_ready record is different: provider generation has already
      // crossed the durable commit point, so finish it from the journaled
      // answer instead of throwing away a reply merely because bridge
      // post-processing was interrupted by the restart.
      const priorBootJobs = [...this.jobs.values()].filter(job =>
        !isTerminalQueryJobStatus(job.snapshot.status) && job.lastBootId !== this.options.bootId)
      for (const job of priorBootJobs) {
        const snapshot = job.snapshot
        if (snapshot.status === 'answer_ready') {
          await this.complete(snapshot.jobId, {
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
        } else {
          const result = await this.interrupt(snapshot.jobId, 'server_restarted')
          if (result.applied) this.health.interruptedOnBoot++
        }
      }
      this.trimHydratedJobs()
      this.refreshHealth()
      return this.getHealth()
    } catch (error) {
      this.markPersistenceFailure(error)
      throw error instanceof QueryJobPersistenceError
        ? error : new QueryJobPersistenceError(errorCode(error), error instanceof Error ? error.message : String(error))
    }
  }

  private async hydratePartition(partition: string, onlyJobId?: string): Promise<void> {
    let text: string
    try {
      text = await this.storage.readPartition(this.options.root, partition)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as unknown
        const record = this.parseJournalRecord(parsed)
        if (!record || (onlyJobId && record.jobId !== onlyJobId)) {
          if (!record && !onlyJobId) this.health.malformedRows++
          continue
        }
        this.applyRecord(record, false)
      } catch {
        if (!onlyJobId) this.health.malformedRows++
      }
    }
  }

  private parseJournalRecord(raw: unknown): QueryJobJournalRecord | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (r.schemaVersion !== QUERY_JOB_SCHEMA_VERSION
      || typeof r.recordId !== 'string'
      || typeof r.partitionDay !== 'string'
      || typeof r.persistedAt !== 'string'
      || typeof r.bootId !== 'string'
      || typeof r.jobId !== 'string'
      || typeof r.clientJobId !== 'string'
      || !Number.isSafeInteger(r.generation)
      || typeof r.turnId !== 'string'
      || typeof r.requestFingerprint !== 'string'
      || !Number.isSafeInteger(r.eventSeq)
      || typeof r.type !== 'string'
      || typeof r.status !== 'string'
      || !r.patch || typeof r.patch !== 'object'
      || !r.eventData || typeof r.eventData !== 'object') return null
    const statuses: QueryJobStatus[] = ['accepted', 'starting', 'running', 'answer_ready', 'completed', 'failed', 'canceled', 'interrupted']
    const eventTypes: QueryJobEventType[] = [...statuses, 'chunk', 'tool_status', 'activity_line', 'acknowledged']
    if (!statuses.includes(r.status as QueryJobStatus) || !eventTypes.includes(r.type as QueryJobEventType)) return null
    return r as unknown as QueryJobJournalRecord
  }

  private applyRecord(record: QueryJobJournalRecord, publish: boolean): QueryJobEvent | undefined {
    let hydrated = this.jobs.get(record.jobId)
    if (!hydrated) {
      if (record.type !== 'accepted' || !record.request || record.eventSeq !== 1) return undefined
      let request: QueryJobRequest
      try { request = parseQueryJobRequest(record.request) } catch { return undefined }
      const fingerprint = requestFingerprint(request)
      if (fingerprint !== record.requestFingerprint
        || request.clientJobId !== record.clientJobId
        || request.generation !== record.generation) return undefined
      const acceptedAt = record.persistedAt
      const retentionUntil = new Date(new Date(acceptedAt).getTime() + this.retentionDays * 86_400_000).toISOString()
      hydrated = {
        request,
        events: [],
        lastBootId: record.bootId,
        snapshot: {
          schemaVersion: QUERY_JOB_SCHEMA_VERSION,
          jobId: record.jobId,
          clientJobId: record.clientJobId,
          generation: record.generation,
          turnId: record.turnId,
          requestFingerprint: fingerprint,
          status: 'accepted',
          eventSeq: 0,
          oldestEventSeq: 1,
          sessionId: request.sessionId,
          ...(request.model ? { requestedModel: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          ...(request.messageEra ? { messageEra: request.messageEra } : {}),
          ...(request.globalMsgNum ? { globalMsgNum: request.globalMsgNum } : {}),
          ...(request.handoffCode ? { handoffCode: request.handoffCode } : {}),
          attachments: clone(request.attachmentRefs),
          partialText: '',
          partialTruncated: false,
          activity: [],
          acceptedAt,
          updatedAt: acceptedAt,
          retentionUntil,
        },
      }
      this.jobs.set(record.jobId, hydrated)
    }
    if (record.eventSeq <= hydrated.snapshot.eventSeq) return undefined
    if (record.type !== 'accepted'
      && record.type !== 'acknowledged'
      && isTerminalQueryJobStatus(hydrated.snapshot.status)) return undefined
    if (record.type !== 'accepted' && record.status !== hydrated.snapshot.status
      && !ALLOWED_TRANSITIONS[hydrated.snapshot.status].has(record.status)) return undefined

    const snapshot = hydrated.snapshot
    snapshot.status = record.status
    snapshot.eventSeq = record.eventSeq
    snapshot.updatedAt = record.persistedAt
    hydrated.lastBootId = record.bootId

    const patch = record.patch
    if (record.type === 'running') {
      snapshot.startedAt = typeof patch.startedAt === 'string' ? patch.startedAt : record.persistedAt
      this.applyLinkage(snapshot, patch)
    } else if (record.type === 'chunk') {
      if (typeof patch.partialText === 'string') snapshot.partialText = patch.partialText
      snapshot.partialTruncated = patch.partialTruncated === true
    } else if (record.type === 'tool_status' || record.type === 'activity_line') {
      this.applyActivity(snapshot, record)
    } else if (record.type === 'answer_ready') {
      snapshot.answerReadyAt = typeof patch.answerReadyAt === 'string' ? patch.answerReadyAt : record.persistedAt
      if (typeof patch.partialText === 'string') snapshot.partialText = patch.partialText
      snapshot.partialTruncated = patch.partialTruncated === true
      this.applyLinkage(snapshot, patch)
    } else if (record.type === 'completed') {
      snapshot.completedAt = typeof patch.completedAt === 'string' ? patch.completedAt : record.persistedAt
      if (typeof patch.response === 'string') snapshot.response = patch.response
      snapshot.responseTruncated = patch.responseTruncated === true
      if (typeof patch.partialText === 'string') snapshot.partialText = patch.partialText
      snapshot.partialTruncated = patch.partialTruncated === true
      snapshot.attachments = mergeMediaAttachmentRefs(snapshot.attachments, patch.attachments)
      const outputImageStats = parseQueryJobOutputImageStats(patch.outputImageStats)
      if (outputImageStats) snapshot.outputImageStats = outputImageStats
      else delete snapshot.outputImageStats
      this.applyLinkage(snapshot, patch)
      delete snapshot.error
    } else if (record.type === 'failed' || record.type === 'canceled' || record.type === 'interrupted') {
      snapshot.completedAt = typeof patch.completedAt === 'string' ? patch.completedAt : record.persistedAt
      snapshot.error = normalizeQueryJobError(patch.error, record.type)
      if (typeof patch.orphanFenceUntil === 'string') snapshot.orphanFenceUntil = patch.orphanFenceUntil
    } else if (record.type === 'acknowledged') {
      snapshot.acknowledgedAt = typeof patch.acknowledgedAt === 'string'
        ? patch.acknowledgedAt : record.persistedAt
    }

    const event: QueryJobEvent = {
      type: record.type,
      eventSeq: record.eventSeq,
      jobId: record.jobId,
      clientJobId: record.clientJobId,
      generation: record.generation,
      status: record.status,
      at: record.persistedAt,
      data: clone(record.eventData),
    }
    hydrated.events.push(event)
    if (hydrated.events.length > this.maxReplayEvents) hydrated.events.shift()
    snapshot.oldestEventSeq = hydrated.events[0]?.eventSeq ?? snapshot.eventSeq + 1

    const identity: QueryJobIdentity = {
      jobId: record.jobId,
      clientJobId: record.clientJobId,
      generation: record.generation,
      sessionId: hydrated.request.sessionId,
      fingerprint: record.requestFingerprint,
      status: record.status,
      updatedAt: record.persistedAt,
      ...(snapshot.orphanFenceUntil ? { orphanFenceUntil: snapshot.orphanFenceUntil } : {}),
    }
    this.identitiesByJobId.set(identity.jobId, identity)
    this.identitiesByKey.set(identityKey(identity.clientJobId, identity.generation), identity)
    this.refreshHealth()
    if (publish) this.emitter.emit(record.jobId, clone(event))
    return event
  }

  private applyLinkage(snapshot: QueryJobSnapshot, raw: Record<string, unknown>): void {
    const provider = raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : undefined
    if (provider) snapshot.provider = provider
    const fields = ['resolvedModel', 'cliSessionId', 'claudeRunId', 'codexRunId', 'codexThreadId'] as const
    for (const field of fields) {
      const value = safeOptional(raw[field])
      if (value) snapshot[field] = value
    }
    const providerOwnershipConfirmedAt = safeOptional(raw.providerOwnershipConfirmedAt)
    if (providerOwnershipConfirmedAt) snapshot.providerOwnershipConfirmedAt = providerOwnershipConfirmedAt
  }

  private applyActivity(snapshot: QueryJobSnapshot, record: QueryJobJournalRecord): void {
    const kind: QueryJobActivityKind = record.eventData.kind === 'input' || record.eventData.kind === 'output'
      ? record.eventData.kind : record.eventData.kind === 'gap' ? 'gap' : 'status'
    const safe = sanitizeQueryJobActivity(record.eventData.text)
    const previous = snapshot.activity.at(-1)
    if (previous && previous.kind === kind && previous.text === safe.text) {
      previous.repeatCount = (previous.repeatCount ?? 1) + 1
      previous.eventSeq = record.eventSeq
      previous.at = record.persistedAt
      return
    }
    snapshot.activity.push({ eventSeq: record.eventSeq, at: record.persistedAt, kind, text: safe.text })
    if (snapshot.activity.length > this.maxActivityEntries) snapshot.activity.shift()
  }

  private async appendRecord(record: QueryJobJournalRecord): Promise<void> {
    const serialized = JSON.stringify(record)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_RECORD_BYTES) {
      throw new QueryJobPersistenceError('query_job_record_too_large')
    }
    try {
      await this.storage.append(this.options.root, record.partitionDay, serialized)
      const partition = `${record.partitionDay}.jsonl`
      if (!this.partitions.includes(partition)) this.partitions.push(partition)
      this.partitions.sort()
      this.health.lastSuccessfulWriteAt = this.now().toISOString()
    } catch (error) {
      this.markPersistenceFailure(error)
      throw new QueryJobPersistenceError(errorCode(error), error instanceof Error ? error.message : String(error))
    }
  }

  private markPersistenceFailure(error: unknown): void {
    this.health.state = 'degraded'
    this.health.journalFailures++
    this.health.lastErrorCode = errorCode(error)
  }

  private assertWritable(): void {
    if (this.health.state === 'degraded') throw new QueryJobPersistenceError('query_job_store_degraded')
    if (this.health.state !== 'ready') throw new QueryJobPersistenceError('query_job_store_not_ready')
  }

  private async ensureInitialized(): Promise<void> {
    if (this.health.state === 'ready' || this.health.state === 'degraded') return
    await this.init()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendTail.catch(() => {}).then(operation)
    this.appendTail = result.then(() => {}, () => {})
    return result
  }

  async admit(raw: unknown): Promise<QueryJobAdmissionResult> {
    await this.ensureInitialized()
    const request = parseQueryJobRequest(raw)
    const fingerprint = requestFingerprint(request)
    const existingIdentity = this.identitiesByKey.get(identityKey(request.clientJobId, request.generation))
    if (existingIdentity) await this.ensureHydrated(existingIdentity.jobId)

    return this.enqueue(async () => {
      this.assertWritable()
      const key = identityKey(request.clientJobId, request.generation)
      const duplicate = this.identitiesByKey.get(key)
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) {
          throw new QueryJobIdentityConflictError(request.clientJobId, request.generation)
        }
        const hydrated = this.jobs.get(duplicate.jobId)
        if (!hydrated) throw new QueryJobNotFoundError(duplicate.jobId)
        return { created: false, job: clone(hydrated.snapshot) }
      }

      const identities = [...this.identitiesByJobId.values()]
      const lineage = identities.filter(item => item.clientJobId === request.clientJobId)
      if (lineage.some(item => !isTerminalQueryJobStatus(item.status))) {
        throw new QueryJobActiveGenerationError(request.clientJobId)
      }
      const nowMs = this.now().getTime()
      // Provider sessions, not phone queue ids, are the concurrency boundary.
      // A restarted client can allocate a fresh clientJobId; it must not bypass
      // an orphan fence and resume the same provider session too early.
      const sessionLineage = identities.filter(item => item.sessionId === request.sessionId)
      const fencedUntil = sessionLineage.reduce((latest, item) => {
        if (item.status !== 'interrupted' || !item.orphanFenceUntil) return latest
        const value = new Date(item.orphanFenceUntil).getTime()
        return Number.isFinite(value) ? Math.max(latest, value) : latest
      }, 0)
      if (fencedUntil > nowMs) throw new QueryJobProviderOrphanFenceError(fencedUntil - nowMs)
      const highestGeneration = lineage.reduce((max, item) => Math.max(max, item.generation), 0)
      if (request.generation <= highestGeneration) throw new QueryJobGenerationOrderError(request.clientJobId)

      const now = this.now().toISOString()
      const jobId = randomUUID()
      const turnId = randomUUID()
      const record: QueryJobJournalRecord = {
        schemaVersion: QUERY_JOB_SCHEMA_VERSION,
        recordId: randomUUID(),
        partitionDay: localPartitionDay(this.now()),
        persistedAt: now,
        bootId: this.options.bootId,
        jobId,
        clientJobId: request.clientJobId,
        generation: request.generation,
        turnId,
        requestFingerprint: fingerprint,
        eventSeq: 1,
        type: 'accepted',
        status: 'accepted',
        request,
        patch: {},
        eventData: { requestFingerprint: fingerprint },
      }
      await this.appendRecord(record)
      this.applyRecord(record, true)
      this.trimHydratedJobs(jobId)
      return { created: true, job: clone(this.jobs.get(jobId)!.snapshot) }
    })
  }

  async markStarting(jobId: string): Promise<QueryJobMutationResult> {
    return this.transition(jobId, 'starting', 'starting', {}, {})
  }

  async markRunning(jobId: string, linkage: QueryJobProviderLinkage): Promise<QueryJobMutationResult> {
    const safe = this.safeLinkage(linkage)
    const startedAt = this.now().toISOString()
    return this.transition(jobId, 'running', 'running', { ...safe, startedAt }, { ...safe })
  }

  /** Persist stable provider ownership while the job remains running. The
   * bridge awaits this boundary before sending user input to the child. */
  async updateLinkage(jobId: string, linkage: QueryJobProviderLinkage): Promise<QueryJobMutationResult> {
    const safe = this.safeLinkage(linkage)
    const providerOwnershipConfirmedAt = this.now().toISOString()
    return this.mutateSameStatus(jobId, 'running', {
      ...safe,
      providerOwnershipConfirmedAt,
    }, {
      ...safe,
      providerOwnershipConfirmedAt,
    })
  }

  async appendPartial(
    jobId: string,
    delta: string,
    partialText: string,
    alreadyTruncated = false,
  ): Promise<QueryJobMutationResult> {
    const partial = boundedText(partialText, QUERY_JOB_LIMITS.partialChars)
    const boundedDelta = boundedText(delta, MAX_CHUNK_DELTA_CHARS)
    const partialTruncated = partial.truncated || alreadyTruncated
    return this.mutateSameStatus(jobId, 'chunk', {
      partialText: partial.text,
      partialTruncated,
    }, {
      text: boundedDelta.text,
      partialText: partial.text,
      partialTruncated,
      deltaTruncated: boundedDelta.truncated,
    })
  }

  async appendActivity(
    jobId: string,
    kind: Exclude<QueryJobActivityKind, 'gap'>,
    text: string,
  ): Promise<QueryJobMutationResult> {
    const safe = sanitizeQueryJobActivity(text)
    const type: QueryJobEventType = kind === 'status' ? 'tool_status' : 'activity_line'
    return this.mutateSameStatus(jobId, type, {}, { kind, text: safe.text, truncated: safe.truncated })
  }

  async markAnswerReady(
    jobId: string,
    fullText: string,
    linkage: QueryJobProviderLinkage = {},
  ): Promise<QueryJobMutationResult> {
    const partial = boundedText(fullText, QUERY_JOB_LIMITS.partialChars)
    const safeLinkage = this.safeLinkage(linkage)
    const answerReadyAt = this.now().toISOString()
    return this.transition(jobId, 'answer_ready', 'answer_ready', {
      ...safeLinkage,
      answerReadyAt,
      partialText: partial.text,
      partialTruncated: partial.truncated,
    }, {
      ...safeLinkage,
      partialText: partial.text,
      partialTruncated: partial.truncated,
    })
  }

  async complete(
    jobId: string,
    input: { text: string; attachments?: unknown; outputImageStats?: unknown } & QueryJobProviderLinkage,
  ): Promise<QueryJobMutationResult> {
    const response = boundedText(input.text, QUERY_JOB_LIMITS.terminalResponseChars)
    const partial = boundedText(input.text, QUERY_JOB_LIMITS.partialChars)
    const linkage = this.safeLinkage(input)
    const attachments = parseMediaAttachmentRefs(input.attachments)
    const outputImageStats = parseQueryJobOutputImageStats(input.outputImageStats)
    const completedAt = this.now().toISOString()
    return this.transition(jobId, 'completed', 'completed', {
      ...linkage,
      completedAt,
      response: response.text,
      responseTruncated: response.truncated,
      partialText: partial.text,
      partialTruncated: partial.truncated,
      attachments,
      ...(outputImageStats ? { outputImageStats } : {}),
    }, {
      ...linkage,
      response: response.text,
      responseTruncated: response.truncated,
      attachments,
      ...(outputImageStats ? { outputImageStats } : {}),
    })
  }

  async fail(jobId: string, error: unknown): Promise<QueryJobMutationResult> {
    const current = await this.getSnapshot(jobId)
    if (current.status === 'answer_ready') {
      return this.complete(jobId, {
        text: current.partialText,
        attachments: current.attachments,
        outputImageStats: current.outputImageStats,
        provider: current.provider,
        resolvedModel: current.resolvedModel,
        cliSessionId: current.cliSessionId,
        claudeRunId: current.claudeRunId,
        codexRunId: current.codexRunId,
        codexThreadId: current.codexThreadId,
      })
    }
    const normalized = normalizeQueryJobError(error)
    return this.transition(jobId, 'failed', 'failed', {
      error: normalized, completedAt: this.now().toISOString(),
    }, { error: normalized })
  }

  async cancel(jobId: string, generation: number): Promise<QueryJobMutationResult> {
    const current = await this.getSnapshot(jobId, generation)
    if (isTerminalQueryJobStatus(current.status)) return { applied: false, job: current }
    // answer_ready is the durable commit point: the provider has stopped
    // generating and bridge post-processing may already be mutating the
    // canonical conversation. Refusing late cancellation prevents a canceled
    // journal from racing a completed conversation/display notification.
    if (current.status === 'answer_ready') throw new QueryJobAnswerCommittingError()
    const error: QueryJobError = { code: 'canceled', message: 'Canceled by user.' }
    return this.transition(jobId, 'canceled', 'canceled', {
      error, completedAt: this.now().toISOString(),
    }, { error })
  }

  async interrupt(jobId: string, reason = 'server_interrupted'): Promise<QueryJobMutationResult> {
    const current = await this.getSnapshot(jobId)
    if (isTerminalQueryJobStatus(current.status)) return { applied: false, job: current }
    if (current.status === 'answer_ready') {
      return this.complete(jobId, {
        text: current.partialText,
        attachments: current.attachments,
        outputImageStats: current.outputImageStats,
        provider: current.provider,
        resolvedModel: current.resolvedModel,
        cliSessionId: current.cliSessionId,
        claudeRunId: current.claudeRunId,
        codexRunId: current.codexRunId,
        codexThreadId: current.codexThreadId,
      })
    }
    const error: QueryJobError = {
      code: 'interrupted',
      message: reason === 'server_restarted'
        ? 'Server restarted. Prompt preserved; provider was not restarted.'
        : sanitizeQueryJobActivity(reason).text,
      retryable: true,
    }
    // Only a job with a persisted provider-process ledger id can own an
    // orphan after this server process dies. Accepted/starting/context-build
    // jobs are safe to retry immediately after restart.
    // Only the explicit pre-stdin ownership barrier proves an interrupted
    // child can still own this session. Fence hard restarts and graceful
    // shutdowns alike; a new clientJobId must not bypass provider ownership.
    const providerWasSpawned = Boolean(current.providerOwnershipConfirmedAt)
    const orphanFenceUntil = providerWasSpawned
      ? new Date(this.now().getTime() + QUERY_JOB_ORPHAN_FENCE_MS).toISOString()
      : undefined
    return this.transition(jobId, 'interrupted', 'interrupted', {
      error, completedAt: this.now().toISOString(),
      ...(orphanFenceUntil ? { orphanFenceUntil } : {}),
    }, { error, ...(orphanFenceUntil ? { orphanFenceUntil } : {}) })
  }

  async acknowledge(jobId: string, generation: number): Promise<QueryJobMutationResult> {
    const snapshot = await this.getSnapshot(jobId, generation)
    if (!isTerminalQueryJobStatus(snapshot.status)) throw new QueryJobNotTerminalError()
    if (snapshot.acknowledgedAt) return { applied: false, job: snapshot }
    await this.ensureHydrated(jobId)
    return this.enqueue(async () => {
      this.assertWritable()
      const hydrated = this.jobs.get(jobId)
      if (!hydrated) throw new QueryJobNotFoundError(jobId)
      if (hydrated.snapshot.acknowledgedAt) return { applied: false, job: clone(hydrated.snapshot) }
      if (!isTerminalQueryJobStatus(hydrated.snapshot.status)) throw new QueryJobNotTerminalError()
      const acknowledgedAt = this.now().toISOString()
      return this.persistMutation(
        hydrated,
        hydrated.snapshot.status,
        'acknowledged',
        { acknowledgedAt },
        { acknowledgedAt },
      )
    })
  }

  private safeLinkage(linkage: QueryJobProviderLinkage): QueryJobProviderLinkage {
    return {
      ...(linkage.provider === 'claude' || linkage.provider === 'codex' ? { provider: linkage.provider } : {}),
      ...(safeOptional(linkage.resolvedModel, 64) ? { resolvedModel: safeOptional(linkage.resolvedModel, 64) } : {}),
      ...(safeOptional(linkage.cliSessionId) ? { cliSessionId: safeOptional(linkage.cliSessionId) } : {}),
      ...(safeOptional(linkage.claudeRunId) ? { claudeRunId: safeOptional(linkage.claudeRunId) } : {}),
      ...(safeOptional(linkage.codexRunId) ? { codexRunId: safeOptional(linkage.codexRunId) } : {}),
      ...(safeOptional(linkage.codexThreadId) ? { codexThreadId: safeOptional(linkage.codexThreadId) } : {}),
    }
  }

  private async transition(
    jobId: string,
    status: QueryJobStatus,
    type: QueryJobEventType,
    patch: Record<string, unknown>,
    eventData: Record<string, unknown>,
  ): Promise<QueryJobMutationResult> {
    await this.ensureInitialized()
    await this.ensureHydrated(jobId)
    return this.enqueue(async () => {
      this.assertWritable()
      const hydrated = this.jobs.get(jobId)
      if (!hydrated) throw new QueryJobNotFoundError(jobId)
      if (isTerminalQueryJobStatus(hydrated.snapshot.status)) {
        return { applied: false, job: clone(hydrated.snapshot) }
      }
      if (hydrated.snapshot.status === status || !ALLOWED_TRANSITIONS[hydrated.snapshot.status].has(status)) {
        return { applied: false, job: clone(hydrated.snapshot) }
      }
      return this.persistMutation(hydrated, status, type, patch, eventData)
    })
  }

  private async mutateSameStatus(
    jobId: string,
    type: QueryJobEventType,
    patch: Record<string, unknown>,
    eventData: Record<string, unknown>,
  ): Promise<QueryJobMutationResult> {
    await this.ensureInitialized()
    await this.ensureHydrated(jobId)
    return this.enqueue(async () => {
      this.assertWritable()
      const hydrated = this.jobs.get(jobId)
      if (!hydrated) throw new QueryJobNotFoundError(jobId)
      if (isTerminalQueryJobStatus(hydrated.snapshot.status)) {
        return { applied: false, job: clone(hydrated.snapshot) }
      }
      return this.persistMutation(hydrated, hydrated.snapshot.status, type, patch, eventData)
    })
  }

  private async persistMutation(
    hydrated: HydratedQueryJob,
    status: QueryJobStatus,
    type: QueryJobEventType,
    patch: Record<string, unknown>,
    eventData: Record<string, unknown>,
  ): Promise<QueryJobMutationResult> {
    const snapshot = hydrated.snapshot
    const persistedAt = this.now().toISOString()
    const record: QueryJobJournalRecord = {
      schemaVersion: QUERY_JOB_SCHEMA_VERSION,
      recordId: randomUUID(),
      partitionDay: localPartitionDay(this.now()),
      persistedAt,
      bootId: this.options.bootId,
      jobId: snapshot.jobId,
      clientJobId: snapshot.clientJobId,
      generation: snapshot.generation,
      turnId: snapshot.turnId,
      requestFingerprint: snapshot.requestFingerprint,
      eventSeq: snapshot.eventSeq + 1,
      type,
      status,
      patch,
      eventData,
    }
    await this.appendRecord(record)
    const event = this.applyRecord(record, true)
    if (!event) throw new QueryJobStoreError('query_job_reducer_rejected_persisted_record')
    return { applied: true, job: clone(hydrated.snapshot), event: clone(event) }
  }

  private async ensureHydrated(jobId: string): Promise<void> {
    if (this.jobs.has(jobId)) return
    if (!this.identitiesByJobId.has(jobId)) throw new QueryJobNotFoundError(jobId)
    for (const partition of this.partitions) await this.hydratePartition(partition, jobId)
    if (!this.jobs.has(jobId)) throw new QueryJobNotFoundError(jobId)
    this.trimHydratedJobs(jobId)
  }

  async getSnapshot(jobId: string, generation?: number): Promise<QueryJobSnapshot> {
    await this.ensureInitialized()
    await this.ensureHydrated(jobId)
    const snapshot = this.jobs.get(jobId)!.snapshot
    if (generation != null && snapshot.generation !== generation) {
      throw new QueryJobGenerationMismatchError(jobId, snapshot.generation, generation)
    }
    return clone(snapshot)
  }

  async getExecution(jobId: string): Promise<QueryJobExecutionRecord> {
    await this.ensureInitialized()
    await this.ensureHydrated(jobId)
    const hydrated = this.jobs.get(jobId)!
    return { request: clone(hydrated.request), job: clone(hydrated.snapshot) }
  }

  /** Enumerate retained identities for boot-time projection repair. Hydration
   * remains bounded: each record is cloned and the normal LRU trim can evict
   * earlier terminal jobs as the scan advances. */
  async listRetainedExecutions(): Promise<QueryJobExecutionRecord[]> {
    await this.ensureInitialized()
    const out: QueryJobExecutionRecord[] = []
    for (const jobId of [...this.identitiesByJobId.keys()]) {
      try {
        out.push(await this.getExecution(jobId))
      } catch (error) {
        if (!(error instanceof QueryJobNotFoundError)) throw error
      }
    }
    return out
  }

  async findByClientGeneration(clientJobId: string, generation: number): Promise<QueryJobSnapshot | undefined> {
    await this.ensureInitialized()
    const identity = this.identitiesByKey.get(identityKey(clientJobId.toLowerCase(), generation))
    if (!identity) return undefined
    return this.getSnapshot(identity.jobId, generation)
  }

  async replay(jobId: string, generation: number, after: number): Promise<QueryJobReplay> {
    await this.getSnapshot(jobId, generation)
    return this.buildReplay(jobId, after)
  }

  private buildReplay(jobId: string, after: number): QueryJobReplay {
    const hydrated = this.jobs.get(jobId)!
    const snapshot = clone(hydrated.snapshot)
    const oldestEventSeq = hydrated.events[0]?.eventSeq ?? snapshot.eventSeq + 1
    const latestEventSeq = snapshot.eventSeq
    if (after > latestEventSeq) {
      return { events: [], gap: true, reason: 'cursor_ahead', oldestEventSeq, latestEventSeq, snapshot }
    }
    if (after < oldestEventSeq - 1) {
      return { events: [], gap: true, reason: 'buffer_overflow', oldestEventSeq, latestEventSeq, snapshot }
    }
    return {
      events: clone(hydrated.events.filter(event => event.eventSeq > after)),
      gap: false,
      oldestEventSeq,
      latestEventSeq,
      snapshot,
    }
  }

  async subscribe(
    jobId: string,
    generation: number,
    after: number,
    listener: (event: QueryJobEvent) => void,
  ): Promise<QueryJobSubscription> {
    await this.getSnapshot(jobId, generation)
    let closed = false
    const wrapped = (event: QueryJobEvent) => {
      if (!closed && event.generation === generation && event.eventSeq > after) listener(clone(event))
    }
    this.emitter.on(jobId, wrapped)
    this.subscriberCount++
    this.refreshHealth()
    // Register first, then take the synchronous replay snapshot. An append can
    // therefore be in replay OR arrive live (and clients dedupe by eventSeq),
    // but can never fall into an await-sized gap between the two.
    const replay = this.buildReplay(jobId, after)
    return {
      replay,
      unsubscribe: () => {
        if (closed) return
        closed = true
        this.emitter.off(jobId, wrapped)
        this.subscriberCount = Math.max(0, this.subscriberCount - 1)
        this.refreshHealth()
      },
    }
  }

  private trimHydratedJobs(protectedJobId?: string): void {
    if (this.jobs.size <= this.maxHydratedJobs) return
    const candidates = [...this.jobs.values()]
      .filter(job => job.snapshot.jobId !== protectedJobId)
      .sort((a, b) => {
        const aTerminal = isTerminalQueryJobStatus(a.snapshot.status) ? 0 : 1
        const bTerminal = isTerminalQueryJobStatus(b.snapshot.status) ? 0 : 1
        return aTerminal - bTerminal || a.snapshot.updatedAt.localeCompare(b.snapshot.updatedAt)
      })
    while (this.jobs.size > this.maxHydratedJobs && candidates.length > 0) {
      const evicted = candidates.shift()!
      this.jobs.delete(evicted.snapshot.jobId)
      this.health.evictedHydratedJobs++
    }
    this.refreshHealth()
  }

  private refreshHealth(): void {
    const counts = {
      accepted: 0, starting: 0, running: 0, answer_ready: 0,
      completed: 0, failed: 0, canceled: 0, interrupted: 0,
    } satisfies Record<QueryJobStatus, number>
    for (const identity of this.identitiesByJobId.values()) counts[identity.status]++
    this.health.hydratedJobs = this.jobs.size
    this.health.retainedIdentities = this.identitiesByJobId.size
    this.health.subscribers = this.subscriberCount
    this.health.counts = counts
  }

  getHealth(): QueryJobStoreHealth {
    this.refreshHealth()
    return clone(this.health)
  }
}
