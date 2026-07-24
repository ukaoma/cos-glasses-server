import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getServerGenerationId, isManagedRuntime } from './managed-runtime.js'
import { serverMetrics } from './server-metrics.js'
import { getServerInstanceId } from './server-instance-id.js'

const GATE_VERSION = 2
const DEFAULT_LEASE_MS = 5 * 60_000
const MIN_LEASE_MS = 30_000
const MAX_LEASE_MS = 15 * 60_000
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/
const NONCE_RE = /^[A-Za-z0-9_-]{32,172}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const DEFAULT_GATE_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'COS Glasses',
  'control',
  'maintenance-gate.json',
)

export type MaintenanceWorkKind =
  | 'api_mutation'
  | 'durable_query'
  | 'legacy_query'
  | 'openai_query'
  | 'query_attachment_write'
  | 'one_shot_transcription'
  | 'recording_chunk'
  | 'meeting_save'
  | 'meeting_batch_finalization'
  | 'prompt_draft_write'
  | 'prompt_draft_warm'
  | 'prompt_draft_finalize'

export type MaintenanceWorkPhase = 'queued' | 'active'
export type MaintenanceOperationScope = 'same_boot' | 'cross_boot'
export type MaintenanceOperationKind =
  | 'same_boot_maintenance'
  | 'server_restart'
  | 'server_update'
  | 'server_rollback'
  | 'server_stop'
export type MaintenancePostcondition = 'same_boot_idle' | 'authorized_successor_adopted'

interface AdoptedSuccessor {
  serverInstanceId: string
  bootId: string
  generationId: string
  adoptedAt: string
}

interface DurableDrainGateV2 {
  version: typeof GATE_VERSION
  leaseId: string
  operationId: string
  operationKind: MaintenanceOperationKind
  scope: MaintenanceOperationScope
  postcondition: MaintenancePostcondition
  nonceSha256: string
  authorizedSuccessorGenerations: string[]
  serverInstanceId: string
  sourceBootId: string
  sourceGenerationId: string
  startedAt: string
  expiresAt: string | null
  adoptedSuccessor?: AdoptedSuccessor
}

type BlockedGateReason = 'legacy_v1' | 'unknown_schema' | 'invalid_schema' | 'corrupt_json'

interface WorkEntry {
  kind: MaintenanceWorkKind
  phase: MaintenanceWorkPhase
  startedAtMs: number
}

interface MaintenanceLifecycleOptions {
  path?: string
  now?: () => number
  bootId?: () => string
  serverInstanceId?: () => string | null
  generationId?: () => string | null
  managed?: () => boolean
}

export interface MaintenanceDrainRequest {
  serverInstanceId: string
  bootId: string
  generationId: string
  operationId: string
  operationKind: MaintenanceOperationKind
  scope: MaintenanceOperationScope
  postcondition: MaintenancePostcondition
  nonceSha256: string
  authorizedSuccessorGenerations: string[]
  ttlMs?: number
}

export interface MaintenanceOperationIdentity {
  serverInstanceId: string
  bootId: string
  generationId: string
  operationId: string
}

export interface MaintenanceOperationCredentials {
  leaseId?: string
  operationId?: string
  nonce?: string
}

export interface MaintenanceWorkLease {
  readonly id: string
  setPhase(phase: MaintenanceWorkPhase): void
  release(): void
}

export class MaintenanceLifecycleError extends Error {
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterSeconds?: number

  constructor(
    readonly code: string,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message)
    this.name = 'MaintenanceLifecycleError'
    this.status = options.status ?? 409
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

function isStringId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

function isOperationKind(value: unknown): value is MaintenanceOperationKind {
  return value === 'same_boot_maintenance'
    || value === 'server_restart'
    || value === 'server_update'
    || value === 'server_rollback'
    || value === 'server_stop'
}

function isScope(value: unknown): value is MaintenanceOperationScope {
  return value === 'same_boot' || value === 'cross_boot'
}

function isPostcondition(value: unknown): value is MaintenancePostcondition {
  return value === 'same_boot_idle' || value === 'authorized_successor_adopted'
}

function parseAdoptedSuccessor(value: unknown): AdoptedSuccessor | undefined | null {
  if (value == null) return undefined
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!isStringId(item.serverInstanceId)
    || !isStringId(item.bootId)
    || !isStringId(item.generationId)
    || typeof item.adoptedAt !== 'string'
    || !Number.isFinite(Date.parse(item.adoptedAt))) return null
  return item as unknown as AdoptedSuccessor
}

function parseGateV2(value: unknown): DurableDrainGateV2 | null {
  if (!value || typeof value !== 'object') return null
  const gate = value as Record<string, unknown>
  const adoptedSuccessor = parseAdoptedSuccessor(gate.adoptedSuccessor)
  const successors = Array.isArray(gate.authorizedSuccessorGenerations)
    ? gate.authorizedSuccessorGenerations
    : []
  if (gate.version !== GATE_VERSION
    || !isStringId(gate.leaseId)
    || !isStringId(gate.operationId)
    || !isOperationKind(gate.operationKind)
    || !isScope(gate.scope)
    || !isPostcondition(gate.postcondition)
    || typeof gate.nonceSha256 !== 'string'
    || !SHA256_RE.test(gate.nonceSha256)
    || successors.length < 1
    || successors.length > 8
    || successors.some(value => !isStringId(value))
    || new Set(successors).size !== successors.length
    || !isStringId(gate.serverInstanceId)
    || !isStringId(gate.sourceBootId)
    || !isStringId(gate.sourceGenerationId)
    || typeof gate.startedAt !== 'string'
    || !Number.isFinite(Date.parse(gate.startedAt))
    || adoptedSuccessor === null) return null

  if (gate.scope === 'same_boot') {
    if (gate.operationKind !== 'same_boot_maintenance'
      || gate.postcondition !== 'same_boot_idle'
      || typeof gate.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(gate.expiresAt))) return null
  } else if (gate.operationKind === 'same_boot_maintenance'
    || gate.postcondition !== 'authorized_successor_adopted'
    || gate.expiresAt !== null) return null

  return {
    ...(gate as unknown as DurableDrainGateV2),
    authorizedSuccessorGenerations: [...successors] as string[],
    ...(adoptedSuccessor ? { adoptedSuccessor } : {}),
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function assertOwnedSafeDirectory(path: string): void {
  const stat = lstatSync(path)
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error(`Unsafe maintenance state directory: ${path}`)
  }
}

function ensureOwnedSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertOwnedSafeDirectory(path)
  chmodSync(path, 0o700)
}

function assertOwnedSafeGateFile(path: string): void {
  const stat = lstatSync(path)
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe maintenance gate file: ${path}`)
  }
}

function persistGate(path: string, gate: DurableDrainGateV2): void {
  const directory = dirname(path)
  ensureOwnedSafeDirectory(directory)
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | null = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(gate)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
    chmodSync(path, 0o600)
    assertOwnedSafeGateFile(path)
    syncDirectory(directory)
  } catch (error) {
    if (fd != null) closeSync(fd)
    rmSync(temp, { force: true })
    throw error
  }
}

function removeGate(path: string): void {
  const directory = dirname(path)
  if (!existsSync(directory)) return
  assertOwnedSafeDirectory(directory)
  if (existsSync(path)) {
    assertOwnedSafeGateFile(path)
    rmSync(path)
  }
  syncDirectory(directory)
}

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

function secureDigestEqual(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * Process-wide admission gate and work ledger. Version-2 cross-boot gates are
 * committed operations, not expiring leases: they remain closed until an
 * explicitly authorized successor adopts the operation and proves the
 * controller-held nonce. Unknown/legacy state is decoded into a typed blocked
 * state instead of being deleted or interpreted optimistically.
 */
export class MaintenanceLifecycle {
  private readonly path: string
  private readonly now: () => number
  private readonly currentBootId: () => string
  private readonly currentServerInstanceId: () => string | null
  private readonly currentGenerationId: () => string | null
  private readonly managed: () => boolean
  private gate: DurableDrainGateV2 | null = null
  private blockedGateReason: BlockedGateReason | null = null
  private blockedGateVersion: number | null = null
  private readonly work = new Map<string, WorkEntry>()

  constructor(options: MaintenanceLifecycleOptions = {}) {
    this.path = options.path ?? process.env.COS_MAINTENANCE_GATE_PATH?.trim() ?? DEFAULT_GATE_PATH
    this.now = options.now ?? (() => Date.now())
    this.currentBootId = options.bootId ?? (() => serverMetrics.bootId)
    this.currentServerInstanceId = options.serverInstanceId ?? getServerInstanceId
    this.currentGenerationId = options.generationId ?? getServerGenerationId
    this.managed = options.managed ?? isManagedRuntime
    this.loadGateSync()
  }

  private loadGateSync(): void {
    let value: unknown
    try {
      assertOwnedSafeDirectory(dirname(this.path))
      assertOwnedSafeGateFile(this.path)
      value = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.blockedGateReason = 'corrupt_json'
      return
    }
    const version = value && typeof value === 'object'
      ? Number((value as Record<string, unknown>).version)
      : Number.NaN
    this.blockedGateVersion = Number.isInteger(version) ? version : null
    if (version === GATE_VERSION) {
      const parsed = parseGateV2(value)
      if (parsed) this.gate = parsed
      else this.blockedGateReason = 'invalid_schema'
    } else if (version === 1) {
      this.blockedGateReason = 'legacy_v1'
    } else {
      this.blockedGateReason = 'unknown_schema'
    }
    this.expireSameBootGateIfPermitted()
  }

  private expireSameBootGateIfPermitted(): void {
    if (!this.gate
      || this.gate.scope !== 'same_boot'
      || this.gate.sourceBootId !== this.currentBootId()
      || !this.gate.expiresAt
      || Date.parse(this.gate.expiresAt) > this.now()) return
    try {
      removeGate(this.path)
      this.gate = null
    } catch {
      this.blockedGateReason = 'invalid_schema'
    }
  }

  private credentialsMatch(credentials: MaintenanceOperationCredentials): {
    leaseMatches: boolean
    operationMatches: boolean
    nonceMatches: boolean
  } {
    const leaseMatches = Boolean(this.gate && credentials.leaseId === this.gate.leaseId)
    const operationMatches = Boolean(this.gate && credentials.operationId === this.gate.operationId)
    const nonceDigest = credentials.nonce && NONCE_RE.test(credentials.nonce)
      ? hashNonce(credentials.nonce)
      : ''
    const nonceMatches = Boolean(this.gate && secureDigestEqual(nonceDigest, this.gate.nonceSha256))
    return { leaseMatches, operationMatches, nonceMatches }
  }

  private requireValidGate(): DurableDrainGateV2 {
    this.expireSameBootGateIfPermitted()
    if (this.blockedGateReason || !this.gate) {
      throw new MaintenanceLifecycleError(
        'maintenance_gate_unavailable',
        'A valid maintenance operation gate is not available.',
        { status: 503 },
      )
    }
    return this.gate
  }

  private requireCredentials(credentials: MaintenanceOperationCredentials): DurableDrainGateV2 {
    const gate = this.requireValidGate()
    const proof = this.credentialsMatch(credentials)
    if (!proof.leaseMatches || !proof.operationMatches || !proof.nonceMatches) {
      throw new MaintenanceLifecycleError(
        'maintenance_operation_proof_invalid',
        'Maintenance operation credentials are not valid.',
      )
    }
    return gate
  }

  acquire(
    kind: MaintenanceWorkKind,
    options: { allowDuringDrain?: boolean; phase?: MaintenanceWorkPhase } = {},
  ): MaintenanceWorkLease {
    this.expireSameBootGateIfPermitted()
    // Unknown, corrupt, or unsafe durable state is never a continuation gate.
    // Only a valid decoded gate may allow already-admitted work to finish.
    if (this.blockedGateReason || (this.gate && !options.allowDuringDrain)) {
      const retryAfterSeconds = this.gate?.scope === 'same_boot' && this.gate.expiresAt
        && this.gate.sourceBootId === this.currentBootId()
        ? Math.max(1, Math.ceil((Date.parse(this.gate.expiresAt) - this.now()) / 1_000))
        : undefined
      throw new MaintenanceLifecycleError(
        'maintenance_drain_active',
        'Server is closed for a committed maintenance operation.',
        { status: 503, retryable: true, retryAfterSeconds },
      )
    }

    const id = randomUUID()
    this.work.set(id, { kind, phase: options.phase ?? 'active', startedAtMs: this.now() })
    let released = false
    return {
      id,
      setPhase: (phase) => {
        if (released) return
        const entry = this.work.get(id)
        if (entry) entry.phase = phase
      },
      release: () => {
        if (released) return
        released = true
        this.work.delete(id)
      },
    }
  }

  beginDrain(request: MaintenanceDrainRequest): string {
    this.expireSameBootGateIfPermitted()
    if (!this.managed()) {
      throw new MaintenanceLifecycleError('server_not_managed', 'Server is not managed.')
    }
    if (this.blockedGateReason) {
      throw new MaintenanceLifecycleError(
        'maintenance_gate_blocked',
        'Existing durable maintenance state requires local repair.',
        { status: 503 },
      )
    }
    if (this.gate) {
      throw new MaintenanceLifecycleError(
        'maintenance_operation_already_active',
        'A maintenance operation is already active.',
        { retryable: true },
      )
    }

    const current = {
      serverInstanceId: this.currentServerInstanceId(),
      bootId: this.currentBootId(),
      generationId: this.currentGenerationId(),
    }
    const successors = request.authorizedSuccessorGenerations
    if (!current.serverInstanceId || !current.generationId
      || request.serverInstanceId !== current.serverInstanceId
      || request.bootId !== current.bootId
      || request.generationId !== current.generationId) {
      throw new MaintenanceLifecycleError(
        'server_identity_mismatch',
        'Maintenance request does not match the running server identity.',
      )
    }
    if (!isStringId(request.operationId)
      || !isOperationKind(request.operationKind)
      || !isScope(request.scope)
      || !isPostcondition(request.postcondition)
      || !SHA256_RE.test(request.nonceSha256)
      || !Array.isArray(successors)
      || successors.length < 1
      || successors.length > 8
      || successors.some(value => !isStringId(value))
      || new Set(successors).size !== successors.length) {
      throw new MaintenanceLifecycleError('invalid_maintenance_operation', 'Maintenance operation is invalid.', { status: 400 })
    }
    if ((request.scope === 'same_boot'
      && (request.operationKind !== 'same_boot_maintenance'
        || request.postcondition !== 'same_boot_idle'
        || successors.length !== 1
        || successors[0] !== current.generationId))
      || (request.scope === 'cross_boot'
        && (request.operationKind === 'same_boot_maintenance'
          || request.postcondition !== 'authorized_successor_adopted'))) {
      throw new MaintenanceLifecycleError('invalid_maintenance_operation_contract', 'Maintenance operation scope and postcondition do not agree.', { status: 400 })
    }

    const started = this.now()
    const ttlMs = request.scope === 'same_boot'
      ? Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, request.ttlMs ?? DEFAULT_LEASE_MS))
      : null
    const gate: DurableDrainGateV2 = {
      version: GATE_VERSION,
      leaseId: randomUUID(),
      operationId: request.operationId,
      operationKind: request.operationKind,
      scope: request.scope,
      postcondition: request.postcondition,
      nonceSha256: request.nonceSha256,
      authorizedSuccessorGenerations: [...successors],
      serverInstanceId: current.serverInstanceId,
      sourceBootId: current.bootId,
      sourceGenerationId: current.generationId,
      startedAt: new Date(started).toISOString(),
      expiresAt: ttlMs == null ? null : new Date(started + ttlMs).toISOString(),
    }
    try {
      persistGate(this.path, gate)
    } catch {
      throw new MaintenanceLifecycleError(
        'maintenance_gate_persist_failed',
        'Could not durably commit the maintenance operation.',
        { status: 503, retryable: true },
      )
    }
    this.gate = gate
    return gate.leaseId
  }

  adoptDrain(identity: MaintenanceOperationIdentity, credentials: MaintenanceOperationCredentials): void {
    const gate = this.requireCredentials(credentials)
    const current = {
      serverInstanceId: this.currentServerInstanceId(),
      bootId: this.currentBootId(),
      generationId: this.currentGenerationId(),
    }
    if (gate.scope !== 'cross_boot'
      || identity.operationId !== gate.operationId
      || !current.serverInstanceId
      || !current.generationId
      || identity.serverInstanceId !== current.serverInstanceId
      || identity.bootId !== current.bootId
      || identity.generationId !== current.generationId
      || current.serverInstanceId !== gate.serverInstanceId
      || current.bootId === gate.sourceBootId
      || !gate.authorizedSuccessorGenerations.includes(current.generationId)) {
      throw new MaintenanceLifecycleError(
        'maintenance_successor_unauthorized',
        'Running server is not an authorized successor for this operation.',
      )
    }
    const next: DurableDrainGateV2 = {
      ...gate,
      adoptedSuccessor: {
        serverInstanceId: current.serverInstanceId,
        bootId: current.bootId,
        generationId: current.generationId,
        adoptedAt: new Date(this.now()).toISOString(),
      },
    }
    try {
      persistGate(this.path, next)
    } catch {
      throw new MaintenanceLifecycleError(
        'maintenance_adoption_persist_failed',
        'Could not durably adopt the maintenance operation.',
        { status: 503, retryable: true },
      )
    }
    this.gate = next
  }

  releaseDrain(identity: MaintenanceOperationIdentity, credentials: MaintenanceOperationCredentials): void {
    const gate = this.requireCredentials(credentials)
    const current = {
      serverInstanceId: this.currentServerInstanceId(),
      bootId: this.currentBootId(),
      generationId: this.currentGenerationId(),
    }
    const identityMatches = Boolean(current.serverInstanceId && current.generationId
      && identity.operationId === gate.operationId
      && identity.serverInstanceId === current.serverInstanceId
      && identity.bootId === current.bootId
      && identity.generationId === current.generationId
      && current.serverInstanceId === gate.serverInstanceId
      && gate.authorizedSuccessorGenerations.includes(current.generationId))
    const postconditionSatisfied = gate.scope === 'same_boot'
      ? gate.postcondition === 'same_boot_idle' && current.bootId === gate.sourceBootId
      : gate.postcondition === 'authorized_successor_adopted'
        && gate.adoptedSuccessor?.serverInstanceId === current.serverInstanceId
        && gate.adoptedSuccessor?.bootId === current.bootId
        && gate.adoptedSuccessor?.generationId === current.generationId
    if (!identityMatches || !postconditionSatisfied) {
      throw new MaintenanceLifecycleError(
        'maintenance_release_postcondition_failed',
        'Maintenance operation release postcondition is not satisfied.',
      )
    }
    try {
      removeGate(this.path)
    } catch {
      throw new MaintenanceLifecycleError(
        'maintenance_gate_release_failed',
        'Could not durably clear the maintenance operation.',
        { status: 503, retryable: true },
      )
    }
    this.gate = null
  }

  cancelDrain(identity: MaintenanceOperationIdentity, credentials: MaintenanceOperationCredentials): void {
    const gate = this.requireCredentials(credentials)
    if (identity.operationId !== gate.operationId
      || identity.serverInstanceId !== gate.serverInstanceId
      || identity.bootId !== gate.sourceBootId
      || identity.generationId !== gate.sourceGenerationId
      || this.currentServerInstanceId() !== gate.serverInstanceId
      || this.currentBootId() !== gate.sourceBootId
      || this.currentGenerationId() !== gate.sourceGenerationId) {
      throw new MaintenanceLifecycleError(
        'maintenance_cancel_identity_mismatch',
        'Only the source boot may cancel this maintenance operation.',
      )
    }
    try {
      removeGate(this.path)
    } catch {
      throw new MaintenanceLifecycleError(
        'maintenance_gate_cancel_failed',
        'Could not durably cancel the maintenance operation.',
        { status: 503, retryable: true },
      )
    }
    this.gate = null
  }

  snapshot(credentials: MaintenanceOperationCredentials = {}, extraActiveByKind: Record<string, number> = {}) {
    this.expireSameBootGateIfPermitted()
    const activeByKind: Record<string, number> = {}
    let queuedTransitions = 0
    let oldestStartedAtMs: number | null = null
    for (const entry of this.work.values()) {
      activeByKind[entry.kind] = (activeByKind[entry.kind] ?? 0) + 1
      if (entry.phase === 'queued') queuedTransitions++
      oldestStartedAtMs = oldestStartedAtMs == null
        ? entry.startedAtMs
        : Math.min(oldestStartedAtMs, entry.startedAtMs)
    }
    for (const [kind, rawCount] of Object.entries(extraActiveByKind)) {
      const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
      if (count > 0) activeByKind[kind] = (activeByKind[kind] ?? 0) + count
    }
    const activeTotal = Object.values(activeByKind).reduce((sum, count) => sum + count, 0)
    const currentBootId = this.currentBootId()
    const currentGenerationId = this.currentGenerationId()
    const currentServerInstanceId = this.currentServerInstanceId()
    const credentialProof = this.credentialsMatch(credentials)
    const sourceIdentityMatches = Boolean(this.gate
      && this.gate.serverInstanceId === currentServerInstanceId
      && this.gate.sourceBootId === currentBootId
      && this.gate.sourceGenerationId === currentGenerationId)
    const candidateAdopted = Boolean(this.gate?.adoptedSuccessor)
    const candidateIdentityMatches = Boolean(this.gate?.adoptedSuccessor
      && this.gate.adoptedSuccessor.serverInstanceId === currentServerInstanceId
      && this.gate.adoptedSuccessor.bootId === currentBootId
      && this.gate.adoptedSuccessor.generationId === currentGenerationId)
    const proofValid = credentialProof.leaseMatches
      && credentialProof.operationMatches
      && credentialProof.nonceMatches
      && sourceIdentityMatches
      && !this.blockedGateReason
    return {
      state: this.blockedGateReason ? `blocked_${this.blockedGateReason}` : this.gate ? 'draining' : 'accepting',
      admissionsOpen: !this.gate && !this.blockedGateReason,
      blockedGate: this.blockedGateReason ? {
        reason: this.blockedGateReason,
        version: this.blockedGateVersion,
      } : null,
      activeTotal,
      activeByKind,
      queuedTransitions,
      idle: activeTotal === 0,
      oldestWorkStartedAt: oldestStartedAtMs == null ? null : new Date(oldestStartedAtMs).toISOString(),
      operation: this.gate ? {
        version: this.gate.version,
        operationId: this.gate.operationId,
        operationKind: this.gate.operationKind,
        scope: this.gate.scope,
        postcondition: this.gate.postcondition,
        nonceSha256: this.gate.nonceSha256,
        authorizedSuccessorGenerations: [...this.gate.authorizedSuccessorGenerations],
        serverInstanceId: this.gate.serverInstanceId,
        sourceBootId: this.gate.sourceBootId,
        sourceGenerationId: this.gate.sourceGenerationId,
        startedAt: this.gate.startedAt,
        expiresAt: this.gate.expiresAt,
        carriedAcrossBoot: this.gate.sourceBootId !== currentBootId,
        adoptedSuccessor: this.gate.adoptedSuccessor ?? null,
      } : null,
      restartProof: {
        valid: proofValid,
        ...credentialProof,
        sourceIdentityMatches,
        candidateAdopted,
        candidateIdentityMatches,
        serverInstanceId: currentServerInstanceId,
        bootId: currentBootId,
        generationId: currentGenerationId,
      },
      safeToRestart: this.managed() && proofValid && activeTotal === 0,
    }
  }
}

export const maintenanceLifecycle = new MaintenanceLifecycle()

export function acquireMaintenanceWork(
  kind: MaintenanceWorkKind,
  options?: { allowDuringDrain?: boolean; phase?: MaintenanceWorkPhase },
): MaintenanceWorkLease {
  return maintenanceLifecycle.acquire(kind, options)
}

/** Read-only boot/background-worker admission check. */
export function maintenanceAdmissionsOpen(): boolean {
  return maintenanceLifecycle.snapshot().admissionsOpen
}

export function maintenanceErrorPayload(error: MaintenanceLifecycleError) {
  return {
    error: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterSeconds != null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  }
}
