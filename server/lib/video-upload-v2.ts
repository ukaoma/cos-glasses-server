// Durable resumable video upload protocol.
//
// Unlike the legacy generic upload registry, this state lives outside media/tmp,
// survives a server restart, binds init to an idempotency key + server identity,
// and retains a terminal publication receipt until the phone acknowledges it.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { MediaAttachmentRef } from '../../shared/media-attachment.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { getMediaStore } from './media-store.js'
import { MAX_CHUNKED_MEDIA_BYTES, MAX_VIDEO_DURATION_MS } from './rich-media-safety.js'

export const VIDEO_UPLOAD_V2_PROTOCOL = 1
/** New sessions only. In-flight drafts keep the chunkBytes baked into their
 *  manifest — a 256 KiB upload that survives this upgrade must not be rewritten
 *  to 1 MiB mid-transfer. The phone parser currently rejects advertised sizes
 *  above 1 MiB and disables V2 entirely, so do not raise this without raising
 *  that cap first. */
export const VIDEO_UPLOAD_V2_CHUNK_BYTES = 1024 * 1024
export const VIDEO_UPLOAD_V2_MAX_FRAME_BYTES = 256 * 1024
export const VIDEO_UPLOAD_V2_MAX_FRAME_PACK_BYTES = 2 * 1024 * 1024
export const VIDEO_UPLOAD_PHONE_FRAMES_MIN = 8
export const VIDEO_UPLOAD_PHONE_FRAMES_MAX = 12
export const VIDEO_UPLOAD_SERVER_FRAMES_MIN = 8
export const VIDEO_UPLOAD_SERVER_FRAMES_MAX = 16
export const VIDEO_UPLOAD_V2_TTL_MS = 4 * 60 * 60_000
export const VIDEO_UPLOAD_V2_RECEIPT_TTL_MS = 24 * 60 * 60_000
export const VIDEO_UPLOAD_V2_MAX_CONCURRENT = 8
export const VIDEO_UPLOAD_V2_TOTAL_RESERVED_BYTES = 4 * 1024 * 1024 * 1024
export const VIDEO_UPLOAD_V2_FREE_DISK_RESERVE_BYTES = 512 * 1024 * 1024
export const VIDEO_UPLOAD_V2_ACCEPTED_MIMES = ['video/mp4', 'video/quicktime'] as const
/** Idle receiving drafts older than this are stranded. Live PUTs refresh
 *  updatedAtMs; a 1 MiB chunk on a clean link is seconds, not a minute. */
export const VIDEO_UPLOAD_V2_STRANDED_IDLE_MS = 60_000

const UPLOAD_ID_RE = /^vu_[0-9a-f]{24}$/
const CLIENT_REQUEST_RE = /^[A-Za-z0-9._:-]{16,160}$/
const MEDIA_ID_RE = /^m_[0-9a-f]{24}$/

export function videoUploadV2Enabled(): boolean {
  // Default ON since 6.37.0 (Miles 2026-08-25). Absent key = on; only a
  // literal '0' disables. NOTE: an in-flight upload sets blocksRestart, so a
  // drain caught mid-upload waits for it — that is the intended contract, not
  // a stuck gate, and must never be --forced.
  return process.env.COS_VIDEO_UPLOAD_V2 !== '0'
}

export function phoneVideoFramesEnabled(): boolean {
  return videoUploadV2Enabled() && process.env.COS_VIDEO_PHONE_FRAMES === '1'
}

export function isValidVideoUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_RE.test(value)
}

/** Sideload/kill leftover: receiving, no writer, no bytes for idleMs.
 *  Never true for finalizing or published — those are live work or receipts. */
export function isStrandedReceivingVideoUpload(input: {
  state: string
  updatedAtMs: number
  nowMs: number
  activeWriters?: number
  idleMs?: number
}): boolean {
  const idleMs = input.idleMs ?? VIDEO_UPLOAD_V2_STRANDED_IDLE_MS
  if (input.state !== 'receiving') return false
  if ((input.activeWriters ?? 0) > 0) return false
  if (!Number.isFinite(input.updatedAtMs) || !Number.isFinite(input.nowMs) || idleMs < 0) return false
  return input.nowMs - input.updatedAtMs >= idleMs
}

export type VideoUploadState = 'receiving' | 'finalizing' | 'published' | 'cancelled' | 'failed'

interface AcceptedPart {
  bytes: number
  sha256: string
}

export interface VideoUploadManifest {
  v: 1
  uploadId: string
  clientRequestId: string
  serverInstanceId: string
  state: VideoUploadState
  generation: number
  totalBytes: number
  chunkBytes: number
  chunkCount: number
  mime: typeof VIDEO_UPLOAD_V2_ACCEPTED_MIMES[number]
  label?: string
  capturedAt?: string
  sessionId?: string
  original: Record<string, AcceptedPart>
  frames: Record<string, AcceptedPart>
  mediaId?: string
  receipt?: MediaAttachmentRef
  acknowledged?: boolean
  failure?: string
  createdAtMs: number
  updatedAtMs: number
  expiresAtMs: number
}

export interface VideoUploadInitInput {
  clientRequestId: unknown
  serverInstanceId: unknown
  totalBytes: unknown
  mime: unknown
  label?: unknown
  capturedAt?: unknown
  sessionId?: unknown
}

export type VideoUploadErrorCode =
  | 'video_upload_disabled'
  | 'video_upload_not_found'
  | 'video_upload_conflict'
  | 'video_upload_busy'
  | 'video_upload_incomplete'
  | 'video_upload_invalid'
  | 'video_upload_quota'
  | 'video_upload_cancelled'
  | 'video_upload_failed'
  | 'server_identity_mismatch'

export class VideoUploadError extends Error {
  constructor(
    readonly code: VideoUploadErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'VideoUploadError'
  }
}

export interface VideoUploadProgress {
  protocol: 1
  uploadId: string
  serverInstanceId: string
  state: VideoUploadState
  totalBytes: number
  chunkBytes: number
  chunkCount: number
  receivedOriginalChunks: number[]
  missingOriginalChunks: number[]
  receivedFrames: number[]
  expiresAt: string
  acknowledged: boolean
  attachment?: MediaAttachmentRef
  failure?: string
}

export interface VideoUploadStatus {
  protocol: 1
  enabled: boolean
  receiving: number
  finalizing: number
  unacknowledgedPublished: number
  failed: number
  blocksRestart: boolean
  blocksRollback: boolean
}

export interface VideoUploadRegistryOptions {
  root?: string
  now?: () => number
  maxConcurrent?: number
  maxReservedBytes?: number
  freeDiskReserveBytes?: number
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
    : undefined
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseIndex(value: unknown): number | null {
  const raw = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null
}

/** Exact byte length this session expects for original index `index`.
 *  Non-final parts are the session's own chunkBytes (which may be 256 KiB on a
 *  draft that started before the 1 MiB advertisement). The last part is the
 *  remainder. Using the live constant here would accept a 1 MiB PUT into a
 *  256 KiB slot and fail assembly, or reject a legitimate leftover last chunk. */
function expectedOriginalPartBytes(manifest: VideoUploadManifest, index: number): number {
  if (index < 0 || index >= manifest.chunkCount) return 0
  if (index === manifest.chunkCount - 1) return manifest.totalBytes - index * manifest.chunkBytes
  return manifest.chunkBytes
}

function sameInit(manifest: VideoUploadManifest, input: Required<Pick<VideoUploadManifest,
  'serverInstanceId' | 'totalBytes' | 'mime'>> & Pick<VideoUploadManifest, 'label' | 'capturedAt' | 'sessionId'>): boolean {
  return manifest.serverInstanceId === input.serverInstanceId
    && manifest.totalBytes === input.totalBytes
    && manifest.mime === input.mime
    && (manifest.label ?? '') === (input.label ?? '')
    && (manifest.capturedAt ?? '') === (input.capturedAt ?? '')
    && (manifest.sessionId ?? '') === (input.sessionId ?? '')
}

function parseManifest(raw: unknown): VideoUploadManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !isValidVideoUploadId(r.uploadId)
    || typeof r.clientRequestId !== 'string' || !CLIENT_REQUEST_RE.test(r.clientRequestId)
    || typeof r.serverInstanceId !== 'string' || r.serverInstanceId.length < 8
    || !positiveSafeInteger(r.totalBytes) || r.totalBytes > MAX_CHUNKED_MEDIA_BYTES
    || !positiveSafeInteger(r.chunkBytes) || !positiveSafeInteger(r.chunkCount)
    || !VIDEO_UPLOAD_V2_ACCEPTED_MIMES.includes(r.mime as typeof VIDEO_UPLOAD_V2_ACCEPTED_MIMES[number])) return null
  const state = r.state
  if (state !== 'receiving' && state !== 'finalizing' && state !== 'published'
    && state !== 'cancelled' && state !== 'failed') return null
  const parts = (value: unknown): Record<string, AcceptedPart> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (!/^\d{1,9}$/.test(key) || !item || typeof item !== 'object') return []
      const p = item as Record<string, unknown>
      if (!positiveSafeInteger(p.bytes) || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) return []
      return [[key, { bytes: p.bytes, sha256: p.sha256 }]]
    }))
  }
  return {
    v: 1,
    uploadId: r.uploadId,
    clientRequestId: r.clientRequestId,
    serverInstanceId: r.serverInstanceId,
    state,
    generation: typeof r.generation === 'number' && Number.isSafeInteger(r.generation) ? r.generation : 0,
    totalBytes: r.totalBytes,
    chunkBytes: r.chunkBytes,
    chunkCount: r.chunkCount,
    mime: r.mime as VideoUploadManifest['mime'],
    ...(boundedString(r.label, 120) ? { label: boundedString(r.label, 120) } : {}),
    ...(boundedString(r.capturedAt, 40) ? { capturedAt: boundedString(r.capturedAt, 40) } : {}),
    ...(boundedString(r.sessionId, 64) ? { sessionId: boundedString(r.sessionId, 64) } : {}),
    original: parts(r.original),
    frames: parts(r.frames),
    ...(typeof r.mediaId === 'string' && MEDIA_ID_RE.test(r.mediaId) ? { mediaId: r.mediaId } : {}),
    ...(r.receipt && typeof r.receipt === 'object' ? { receipt: r.receipt as MediaAttachmentRef } : {}),
    acknowledged: r.acknowledged === true,
    ...(boundedString(r.failure, 160) ? { failure: boundedString(r.failure, 160) } : {}),
    createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : Date.now(),
    updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : Date.now(),
    expiresAtMs: typeof r.expiresAtMs === 'number' ? r.expiresAtMs : Date.now(),
  }
}

export class VideoUploadRegistry {
  private readonly root: string
  private readonly now: () => number
  private readonly maxConcurrent: number
  private readonly maxReservedBytes: number
  private readonly freeDiskReserveBytes: number
  private readonly manifests = new Map<string, VideoUploadManifest>()
  private readonly byClientRequest = new Map<string, string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly finalizers = new Map<string, Promise<VideoUploadProgress>>()
  private readonly activeWriters = new Map<string, number>()

  constructor(options: VideoUploadRegistryOptions = {}) {
    this.root = options.root ?? join(getMediaStore().rootDirectory(), 'video-upload-v1')
    this.now = options.now ?? Date.now
    this.maxConcurrent = options.maxConcurrent ?? VIDEO_UPLOAD_V2_MAX_CONCURRENT
    this.maxReservedBytes = options.maxReservedBytes ?? VIDEO_UPLOAD_V2_TOTAL_RESERVED_BYTES
    this.freeDiskReserveBytes = options.freeDiskReserveBytes ?? VIDEO_UPLOAD_V2_FREE_DISK_RESERVE_BYTES
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.load()
    this.reconcilePublished()
    this.sweepExpired()
  }

  init(input: VideoUploadInitInput): VideoUploadProgress {
    if (!videoUploadV2Enabled()) throw new VideoUploadError('video_upload_disabled', 'resumable video upload is disabled')
    const clientRequestId = boundedString(input.clientRequestId, 160)
    const serverInstanceId = boundedString(input.serverInstanceId, 160)
    if (!clientRequestId || !CLIENT_REQUEST_RE.test(clientRequestId) || !serverInstanceId) {
      throw new VideoUploadError('video_upload_invalid', 'valid clientRequestId and serverInstanceId are required')
    }
    if (!positiveSafeInteger(input.totalBytes) || input.totalBytes > MAX_CHUNKED_MEDIA_BYTES) {
      throw new VideoUploadError('video_upload_invalid', 'video size is invalid', { maxBytes: MAX_CHUNKED_MEDIA_BYTES })
    }
    if (!VIDEO_UPLOAD_V2_ACCEPTED_MIMES.includes(input.mime as VideoUploadManifest['mime'])) {
      throw new VideoUploadError('video_upload_invalid', 'only MP4 and MOV videos are accepted')
    }
    const normalized = {
      serverInstanceId,
      totalBytes: input.totalBytes,
      mime: input.mime as VideoUploadManifest['mime'],
      label: boundedString(input.label, 120),
      capturedAt: boundedString(input.capturedAt, 40),
      sessionId: boundedString(input.sessionId, 64),
    }
    const existingId = this.byClientRequest.get(clientRequestId)
    if (existingId) {
      const existing = this.manifests.get(existingId)
      if (existing && sameInit(existing, normalized)) return this.progress(existing)
      throw new VideoUploadError('video_upload_conflict', 'clientRequestId was already used for different video metadata')
    }
    this.sweepExpired()
    const active = [...this.manifests.values()].filter(item => item.state === 'receiving' || item.state === 'finalizing')
    if (active.length >= this.maxConcurrent) throw new VideoUploadError('video_upload_quota', 'too many video uploads are active')
    const reserved = active.reduce((sum, item) => sum + item.totalBytes, 0)
    if (reserved + normalized.totalBytes > this.maxReservedBytes) {
      throw new VideoUploadError('video_upload_quota', 'video upload disk quota is full')
    }
    try {
      const fs = statfsSync(this.root)
      const free = Number(fs.bavail) * Number(fs.bsize)
      if (free - normalized.totalBytes < this.freeDiskReserveBytes) {
        throw new VideoUploadError('video_upload_quota', 'not enough free disk for video upload')
      }
    } catch (error) {
      if (error instanceof VideoUploadError) throw error
      throw new VideoUploadError('video_upload_quota', 'free disk could not be verified')
    }
    const now = this.now()
    const uploadId = `vu_${randomBytes(12).toString('hex')}`
    const chunkCount = Math.ceil(normalized.totalBytes / VIDEO_UPLOAD_V2_CHUNK_BYTES)
    const manifest: VideoUploadManifest = {
      v: 1,
      uploadId,
      clientRequestId,
      serverInstanceId,
      state: 'receiving',
      generation: 1,
      totalBytes: normalized.totalBytes,
      chunkBytes: VIDEO_UPLOAD_V2_CHUNK_BYTES,
      chunkCount,
      mime: normalized.mime,
      ...(normalized.label ? { label: normalized.label } : {}),
      ...(normalized.capturedAt ? { capturedAt: normalized.capturedAt } : {}),
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
      original: {},
      frames: {},
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + VIDEO_UPLOAD_V2_TTL_MS,
    }
    mkdirSync(this.dir(uploadId), { recursive: false, mode: 0o700 })
    mkdirSync(this.originalDir(uploadId), { mode: 0o700 })
    mkdirSync(this.frameDir(uploadId), { mode: 0o700 })
    this.save(manifest)
    this.manifests.set(uploadId, manifest)
    this.byClientRequest.set(clientRequestId, uploadId)
    return this.progress(manifest)
  }

  get(uploadId: string, serverInstanceId?: string): VideoUploadProgress {
    const manifest = this.require(uploadId, serverInstanceId)
    return this.progress(manifest)
  }

  async putOriginal(uploadId: string, indexValue: unknown, bytes: Buffer, serverInstanceId?: string): Promise<VideoUploadProgress> {
    return this.putPart(uploadId, 'original', indexValue, bytes, serverInstanceId)
  }

  async putFrame(uploadId: string, indexValue: unknown, bytes: Buffer, serverInstanceId?: string): Promise<VideoUploadProgress> {
    if (!phoneVideoFramesEnabled()) throw new VideoUploadError('video_upload_disabled', 'phone frame acceleration is disabled')
    return this.putPart(uploadId, 'frames', indexValue, bytes, serverInstanceId)
  }

  async finalize(uploadId: string, serverInstanceId?: string): Promise<VideoUploadProgress> {
    const existing = this.finalizers.get(uploadId)
    if (existing) return existing
    const task = this.finalizeOnce(uploadId, serverInstanceId)
    this.finalizers.set(uploadId, task)
    try { return await task } finally {
      if (this.finalizers.get(uploadId) === task) this.finalizers.delete(uploadId)
    }
  }

  async acknowledge(uploadId: string, serverInstanceId?: string): Promise<VideoUploadProgress> {
    return this.withLock(uploadId, async () => {
      const manifest = this.require(uploadId, serverInstanceId)
      if (manifest.state !== 'published' || !manifest.receipt) {
        throw new VideoUploadError('video_upload_incomplete', 'upload has no terminal receipt')
      }
      manifest.acknowledged = true
      manifest.updatedAtMs = this.now()
      manifest.expiresAtMs = manifest.updatedAtMs + VIDEO_UPLOAD_V2_RECEIPT_TTL_MS
      this.save(manifest)
      this.removeBodies(manifest)
      return this.progress(manifest)
    })
  }

  async cancel(uploadId: string, serverInstanceId?: string): Promise<VideoUploadProgress | null> {
    return this.withLock(uploadId, async () => {
      const manifest = this.manifests.get(uploadId)
      if (!manifest) return null
      this.assertIdentity(manifest, serverInstanceId)
      if (manifest.state === 'published' && manifest.receipt) {
        await getMediaStore().deleteExactlyStaged(manifest.receipt.id)
      }
      manifest.state = 'cancelled'
      manifest.generation++
      manifest.updatedAtMs = this.now()
      manifest.expiresAtMs = manifest.updatedAtMs + VIDEO_UPLOAD_V2_RECEIPT_TTL_MS
      this.save(manifest)
      this.removeBodies(manifest)
      return this.progress(manifest)
    })
  }

  async clearStrandedReceiving(serverInstanceId?: string): Promise<{
    cancelled: string[]
    skipped: Array<{ uploadId: string; reason: string }>
  }> {
    const nowMs = this.now()
    const cancelled: string[] = []
    const skipped: Array<{ uploadId: string; reason: string }> = []
    for (const manifest of [...this.manifests.values()]) {
      if (manifest.state === 'finalizing') {
        skipped.push({ uploadId: manifest.uploadId, reason: 'finalizing' })
        continue
      }
      if (manifest.state !== 'receiving') continue
      const activeWriters = this.activeWriters.get(manifest.uploadId) ?? 0
      if (!isStrandedReceivingVideoUpload({
        state: manifest.state,
        updatedAtMs: manifest.updatedAtMs,
        nowMs,
        activeWriters,
      })) {
        skipped.push({
          uploadId: manifest.uploadId,
          reason: activeWriters > 0 ? 'active_writer' : 'recently_updated',
        })
        continue
      }
      try {
        const progress = await this.cancel(manifest.uploadId, serverInstanceId)
        if (progress) cancelled.push(manifest.uploadId)
      } catch (error) {
        if (error instanceof VideoUploadError && error.code === 'server_identity_mismatch') {
          skipped.push({ uploadId: manifest.uploadId, reason: 'identity_mismatch' })
          continue
        }
        throw error
      }
    }
    return { cancelled, skipped }
  }

  status(): VideoUploadStatus {
    this.sweepExpired()
    let receiving = 0; let finalizing = 0; let unacknowledgedPublished = 0; let failed = 0
    for (const item of this.manifests.values()) {
      if (item.state === 'receiving') receiving++
      else if (item.state === 'finalizing') finalizing++
      else if (item.state === 'published' && !item.acknowledged) unacknowledgedPublished++
      else if (item.state === 'failed') failed++
    }
    return {
      protocol: 1,
      enabled: videoUploadV2Enabled(),
      receiving,
      finalizing,
      unacknowledgedPublished,
      failed,
      blocksRestart: receiving + finalizing > 0,
      blocksRollback: receiving + finalizing + unacknowledgedPublished > 0,
    }
  }

  sweepExpired(at = this.now()): number {
    let swept = 0
    for (const manifest of [...this.manifests.values()]) {
      if (manifest.expiresAtMs > at || this.activeWriters.get(manifest.uploadId)) continue
      // A published asset belongs to MediaStore, not the upload registry. The
      // receipt is retained for 24 hours so a phone that lost the finalize
      // response can recover it, but a phone/WebView that never sends ACK must
      // not block server rollback forever. Expiring this manifest deliberately
      // leaves the staged/reserved/associated media record untouched; MediaStore
      // owns its normal lifecycle and GC from this point forward.
      if (manifest.state === 'receiving' || manifest.state === 'failed' || manifest.state === 'cancelled'
        || manifest.state === 'published') {
        this.manifests.delete(manifest.uploadId)
        this.byClientRequest.delete(manifest.clientRequestId)
        rmSync(this.dir(manifest.uploadId), { recursive: true, force: true })
        swept++
      }
    }
    return swept
  }

  private async putPart(
    uploadId: string,
    kind: 'original' | 'frames',
    indexValue: unknown,
    bytes: Buffer,
    serverInstanceId?: string,
  ): Promise<VideoUploadProgress> {
    const index = parseIndex(indexValue)
    if (index === null || bytes.length === 0) throw new VideoUploadError('video_upload_invalid', 'valid non-empty part required')
    const advertisedMax = kind === 'original' ? VIDEO_UPLOAD_V2_CHUNK_BYTES : VIDEO_UPLOAD_V2_MAX_FRAME_BYTES
    if (bytes.length > advertisedMax) throw new VideoUploadError('video_upload_invalid', 'part exceeds its byte ceiling', { maxBytes: advertisedMax })
    this.activeWriters.set(uploadId, (this.activeWriters.get(uploadId) ?? 0) + 1)
    try {
      return await this.withLock(uploadId, () => {
        const manifest = this.require(uploadId, serverInstanceId)
        if (manifest.state !== 'receiving') throw new VideoUploadError('video_upload_busy', `upload is ${manifest.state}`)
        if (kind === 'original' && index >= manifest.chunkCount) throw new VideoUploadError('video_upload_invalid', 'chunk index exceeds declared upload')
        if (kind === 'frames' && index >= VIDEO_UPLOAD_PHONE_FRAMES_MAX) throw new VideoUploadError('video_upload_invalid', 'frame index exceeds pack limit')
        if (kind === 'original') {
          const expected = expectedOriginalPartBytes(manifest, index)
          if (bytes.length !== expected) {
            throw new VideoUploadError('video_upload_invalid', 'part does not match the session chunk size', {
              expectedBytes: expected, receivedBytes: bytes.length, chunkBytes: manifest.chunkBytes,
            })
          }
        }
        const collection = manifest[kind]
        const key = String(index)
        const digest = sha256(bytes)
        const accepted = collection[key]
        if (accepted) {
          if (accepted.bytes === bytes.length && accepted.sha256 === digest) return this.progress(manifest)
          throw new VideoUploadError('video_upload_conflict', 'part index already contains different bytes')
        }
        if (kind === 'frames') {
          const packBytes = Object.values(manifest.frames).reduce((sum, part) => sum + part.bytes, 0)
          if (packBytes + bytes.length > VIDEO_UPLOAD_V2_MAX_FRAME_PACK_BYTES) {
            throw new VideoUploadError('video_upload_invalid', 'frame pack exceeds byte ceiling')
          }
        }
        const path = this.partPath(manifest, kind, index)
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          const written = writeSync(fd, bytes)
          if (written !== bytes.length) throw new Error(`short write: ${written}/${bytes.length}`)
          fsyncSync(fd)
        } finally { closeSync(fd) }
        collection[key] = { bytes: bytes.length, sha256: digest }
        manifest.updatedAtMs = this.now()
        this.save(manifest)
        return this.progress(manifest)
      })
    } finally {
      const count = (this.activeWriters.get(uploadId) ?? 1) - 1
      if (count <= 0) this.activeWriters.delete(uploadId)
      else this.activeWriters.set(uploadId, count)
    }
  }

  private async finalizeOnce(uploadId: string, serverInstanceId?: string): Promise<VideoUploadProgress> {
    const manifest = await this.withLock(uploadId, () => {
      const current = this.require(uploadId, serverInstanceId)
      if (current.state === 'published' && current.receipt) return current
      if (current.state === 'cancelled') throw new VideoUploadError('video_upload_cancelled', 'upload was cancelled')
      if (this.activeWriters.get(uploadId)) throw new VideoUploadError('video_upload_busy', 'upload still has an active writer')
      const missing = this.missingChunks(current)
      if (missing.length > 0) throw new VideoUploadError('video_upload_incomplete', 'video upload is incomplete', { missingOriginalChunks: missing })
      if (!current.mediaId) current.mediaId = `m_${randomBytes(12).toString('hex')}`
      current.state = 'finalizing'
      current.generation++
      current.updatedAtMs = this.now()
      this.save(current)
      return current
    })
    if (manifest.state === 'published' && manifest.receipt) return this.progress(manifest)

    const recovered = getMediaStore().findByVideoUploadId(uploadId)
    if (recovered) return this.commitReceipt(uploadId, recovered.ref)

    const assembledPath = join(this.dir(uploadId), 'original-assembled.bin')
    try {
      this.assembleOriginal(manifest, assembledPath)
      const ref = await getMediaStore().ingestRichMediaFromFile({
        sourcePath: assembledPath,
        byteLength: manifest.totalBytes,
        label: manifest.label,
        declaredMime: manifest.mime,
        capturedAt: manifest.capturedAt,
        sessionId: manifest.sessionId,
        transfer: 'chunked',
        mediaId: manifest.mediaId,
        videoUploadId: manifest.uploadId,
      })
      const current = this.manifests.get(uploadId)
      if (current?.state === 'cancelled') {
        await getMediaStore().deleteExactlyStaged(ref.id)
        throw new VideoUploadError('video_upload_cancelled', 'upload was cancelled during finalization')
      }
      return this.commitReceipt(uploadId, ref)
    } catch (error) {
      if (error instanceof VideoUploadError && error.code === 'video_upload_cancelled') throw error
      await this.withLock(uploadId, () => {
        const current = this.manifests.get(uploadId)
        if (current && current.state !== 'published' && current.state !== 'cancelled') {
          current.state = 'failed'
          current.failure = error instanceof Error ? error.message.slice(0, 160) : 'video finalization failed'
          current.updatedAtMs = this.now()
          this.save(current)
        }
      })
      throw error
    } finally {
      try { rmSync(assembledPath, { force: true }) } catch { /* ingest may have moved it */ }
    }
  }

  private async commitReceipt(uploadId: string, ref: MediaAttachmentRef): Promise<VideoUploadProgress> {
    return this.withLock(uploadId, () => {
      const current = this.require(uploadId)
      if (current.state === 'cancelled') throw new VideoUploadError('video_upload_cancelled', 'upload was cancelled')
      current.state = 'published'
      current.receipt = ref
      current.acknowledged = false
      current.updatedAtMs = this.now()
      current.expiresAtMs = current.updatedAtMs + VIDEO_UPLOAD_V2_RECEIPT_TTL_MS
      this.save(current)
      return this.progress(current)
    })
  }

  private assembleOriginal(manifest: VideoUploadManifest, target: string): void {
    rmSync(target, { force: true })
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let total = 0
    try {
      for (let index = 0; index < manifest.chunkCount; index++) {
        const bytes = readFileSync(this.partPath(manifest, 'original', index))
        const part = manifest.original[String(index)]
        if (!part || bytes.length !== part.bytes || sha256(bytes) !== part.sha256) {
          throw new VideoUploadError('video_upload_failed', `chunk ${index} failed integrity verification`)
        }
        const written = writeSync(fd, bytes)
        if (written !== bytes.length) throw new Error(`short assembly write: ${written}/${bytes.length}`)
        total += written
      }
      if (total !== manifest.totalBytes) throw new VideoUploadError('video_upload_failed', 'assembled video size mismatch')
      fsyncSync(fd)
    } finally { closeSync(fd) }
  }

  private load(): void {
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidVideoUploadId(entry.name)) continue
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(join(this.root, entry.name, 'manifest.json'), 'utf8')))
        if (!manifest) continue
        this.manifests.set(manifest.uploadId, manifest)
        this.byClientRequest.set(manifest.clientRequestId, manifest.uploadId)
      } catch { /* preserve unreadable draft on disk; do not invent state */ }
    }
  }

  private reconcilePublished(): void {
    for (const manifest of this.manifests.values()) {
      if (manifest.state !== 'finalizing' && manifest.state !== 'failed'
          && !(manifest.state === 'published' && !manifest.receipt)) continue
      const record = getMediaStore().findByVideoUploadId(manifest.uploadId)
      if (record) {
        manifest.state = 'published'
        manifest.receipt = record.ref
        manifest.acknowledged = false
        manifest.updatedAtMs = this.now()
        manifest.expiresAtMs = manifest.updatedAtMs + VIDEO_UPLOAD_V2_RECEIPT_TTL_MS
        this.save(manifest)
      } else if (manifest.state === 'finalizing') {
        // Finalize was claimed but media publication never completed. The
        // complete draft is durable, so reopen it for an idempotent retry.
        manifest.state = 'receiving'
        manifest.failure = undefined
        manifest.generation++
        manifest.updatedAtMs = this.now()
        this.save(manifest)
      }
    }
  }

  private require(uploadId: string, serverInstanceId?: string): VideoUploadManifest {
    if (!isValidVideoUploadId(uploadId)) throw new VideoUploadError('video_upload_not_found', 'unknown video upload')
    const manifest = this.manifests.get(uploadId)
    if (!manifest) throw new VideoUploadError('video_upload_not_found', 'unknown or expired video upload')
    this.assertIdentity(manifest, serverInstanceId)
    return manifest
  }

  private assertIdentity(manifest: VideoUploadManifest, serverInstanceId?: string): void {
    if (serverInstanceId && serverInstanceId !== manifest.serverInstanceId) {
      throw new VideoUploadError('server_identity_mismatch', 'video upload belongs to a different COS server')
    }
  }

  private progress(manifest: VideoUploadManifest): VideoUploadProgress {
    const receivedOriginalChunks = Object.keys(manifest.original).map(Number).sort((a, b) => a - b)
    const receivedFrames = Object.keys(manifest.frames).map(Number).sort((a, b) => a - b)
    return {
      protocol: 1,
      uploadId: manifest.uploadId,
      serverInstanceId: manifest.serverInstanceId,
      state: manifest.state,
      totalBytes: manifest.totalBytes,
      chunkBytes: manifest.chunkBytes,
      chunkCount: manifest.chunkCount,
      receivedOriginalChunks,
      missingOriginalChunks: this.missingChunks(manifest),
      receivedFrames,
      expiresAt: new Date(manifest.expiresAtMs).toISOString(),
      acknowledged: manifest.acknowledged === true,
      ...(manifest.receipt ? { attachment: manifest.receipt } : {}),
      ...(manifest.failure ? { failure: manifest.failure } : {}),
    }
  }

  private missingChunks(manifest: VideoUploadManifest): number[] {
    const missing: number[] = []
    for (let index = 0; index < manifest.chunkCount; index++) {
      if (!manifest.original[String(index)]) missing.push(index)
    }
    return missing
  }

  private save(manifest: VideoUploadManifest): void {
    durableAtomicWriteFileSync(join(this.dir(manifest.uploadId), 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  }

  private removeBodies(manifest: VideoUploadManifest): void {
    rmSync(this.originalDir(manifest.uploadId), { recursive: true, force: true })
    rmSync(this.frameDir(manifest.uploadId), { recursive: true, force: true })
  }

  private dir(uploadId: string): string { return join(this.root, uploadId) }
  private originalDir(uploadId: string): string { return join(this.dir(uploadId), 'original') }
  private frameDir(uploadId: string): string { return join(this.dir(uploadId), 'frames') }
  private partPath(manifest: VideoUploadManifest, kind: 'original' | 'frames', index: number): string {
    return join(kind === 'original' ? this.originalDir(manifest.uploadId) : this.frameDir(manifest.uploadId), `${index}.bin`)
  }

  private withLock<T>(uploadId: string, work: () => T | Promise<T>): Promise<T> {
    const prior = this.locks.get(uploadId) ?? Promise.resolve()
    const run = prior.then(work, work)
    this.locks.set(uploadId, run.then(() => undefined, () => undefined))
    return run
  }
}

let defaultRegistry: VideoUploadRegistry | null = null

export function getVideoUploadRegistry(): VideoUploadRegistry {
  if (!defaultRegistry) defaultRegistry = new VideoUploadRegistry()
  return defaultRegistry
}

export function _setVideoUploadRegistryForTests(registry: VideoUploadRegistry | null): VideoUploadRegistry | null {
  const previous = defaultRegistry
  defaultRegistry = registry
  return previous
}

export function videoUploadV2Capability(videoProcessingReady: boolean) {
  let registryReady = false
  let reason = 'disabled'
  if (videoUploadV2Enabled()) {
    try {
      getVideoUploadRegistry()
      registryReady = true
      reason = videoProcessingReady ? 'ready' : 'video_processing_unavailable'
    } catch {
      reason = 'storage_unavailable'
    }
  }
  return {
    available: registryReady && videoProcessingReady,
    protocol: VIDEO_UPLOAD_V2_PROTOCOL,
    chunkBytes: VIDEO_UPLOAD_V2_CHUNK_BYTES,
    maxOriginalBytes: MAX_CHUNKED_MEDIA_BYTES,
    maxDurationMs: MAX_VIDEO_DURATION_MS,
    acceptedMimes: [...VIDEO_UPLOAD_V2_ACCEPTED_MIMES],
    // The route and manifest format are present so the phone implementation can
    // be canaried without another wire change. Do not advertise frame packs as
    // usable until the server consumes them and physical WKWebView proof passes.
    phoneFramesAvailable: false,
    phoneFramesMin: VIDEO_UPLOAD_PHONE_FRAMES_MIN,
    phoneFramesMax: VIDEO_UPLOAD_PHONE_FRAMES_MAX,
    serverFramesMin: VIDEO_UPLOAD_SERVER_FRAMES_MIN,
    serverFramesMax: VIDEO_UPLOAD_SERVER_FRAMES_MAX,
    maxFrameBytes: VIDEO_UPLOAD_V2_MAX_FRAME_BYTES,
    maxPackBytes: VIDEO_UPLOAD_V2_MAX_FRAME_PACK_BYTES,
    maxSourcePixels: 33_177_600,
    reason,
  }
}
