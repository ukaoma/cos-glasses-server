// Chunked upload sessions (contract §2 wire shape, §6 v1 decisions).
//
// A chunked upload is ONE staging file appended across many requests, then handed
// to the EXISTING ingest. This module owns only the bookkeeping — which upload,
// how many bytes are committed, which index comes next, when it expires. It never
// validates media, never writes into assets/, and never ingests: forking any of
// that would be a second place for the safety rules to rot (contract §6).
//
// Time and filesystem are injectable so the route tests can drive expiry and a
// failed write without real timers or a real disk fault. media-store.ts already
// uses that constructor-dependency style for compressVideoFile.

import { randomBytes } from 'node:crypto'
import { closeSync, ftruncateSync, openSync, statSync, writeSync } from 'node:fs'
import { getMediaStore, STAGED_TTL_MS, type MediaStagingFile } from './media-store.js'
import { MAX_CHUNKED_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from './rich-media-safety.js'

/** An in-flight chunked upload IS an unsubmitted upload, so it retires on the
 *  same retention clock as one — contract §2, "expire on the existing
 *  quarantine/retention clock". Fixed from init rather than sliding: the
 *  advertised 2 GiB ceiling at the client's own 250 KiB/s floor is ~2.4 hours,
 *  so 4 hours covers a legitimate worst case, while a sliding window would let
 *  a slow drip hold that disk indefinitely. */
export const CHUNKED_UPLOAD_TTL_MS = STAGED_TTL_MS

/** Every live session may hold up to `chunkedMaxBytes` of staging file, so this
 *  count is a DISK bound, not a throughput one. The client sends one chunk at a
 *  time from one device (§6, "sequential and in-order"); this leaves headroom
 *  for a retry and a second device without letting a looping client reserve
 *  unbounded disk. */
export const MAX_CONCURRENT_CHUNKED_UPLOADS = 8

const UPLOAD_ID_PATTERN = /^u_[0-9a-f]{24}$/

/** Ids are minted here, so they are validated here. A value that cannot have
 *  come from this module is treated as unknown (404) rather than reaching the
 *  registry map — the id is a path component. */
export function isValidUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_PATTERN.test(value)
}

export type UploadSessionErrorCode =
  | 'upload_not_found'
  | 'chunk_out_of_order'
  | 'attachment_too_large'
  | 'incomplete_upload'
  | 'upload_size_mismatch'
  | 'invalid_total_bytes'
  | 'chunk_bytes_required'
  | 'chunked_upload_unavailable'
  | 'upload_staging_failed'

/** `detail` is merged into the JSON error body by the route, so a 409 can carry
 *  `expectedIndex` and a 400 can carry the byte counts without the route
 *  re-deriving them from state it would have to look up again. */
export class UploadSessionError extends Error {
  constructor(
    readonly code: UploadSessionErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, number>> = {},
  ) {
    super(message)
    this.name = 'UploadSessionError'
  }
}

export interface UploadSession {
  uploadId: string
  /** Absolute path inside the media store's tmp/. Boot reconcile rm -rf's that
   *  directory, which is exactly why resume is within a boot only (§6). */
  stagingPath: string
  /** The client's DECLARED total from init, already bounded to the ceiling. */
  totalBytes: number
  receivedBytes: number
  nextIndex: number
  mime?: string
  label?: string
  capturedAt?: string
  sessionId?: string
  createdAtMs: number
  expiresAtMs: number
  /** Removes the staging file. Idempotent, and a no-op once ingest has moved
   *  the file out — same handle contract as MediaStore.createStagingFile(). */
  dispose: () => void
}

/** The resume-probe view (contract §2 GET). `expiresAt` is ISO 8601 to match
 *  every other expiresAt on the media wire (MediaAttachmentRef.expiresAt). */
export interface UploadSessionProgress {
  uploadId: string
  totalBytes: number
  receivedBytes: number
  nextIndex: number
  expiresAt: string
}

export interface CreateUploadInput {
  /** Untrusted client claim. Validated here because the ceiling is this
   *  module's business. */
  totalBytes: unknown
  mime?: string
  label?: string
  capturedAt?: string
  sessionId?: string
}

/** Filesystem seam. `writeAt` MUST leave the file exactly `position +
 *  bytes.length` bytes long — the truncation is load-bearing, see appendChunk. */
export interface UploadSessionFs {
  create: (path: string) => void
  writeAt: (path: string, bytes: Buffer, position: number) => void
  sizeOf: (path: string) => number
}

/**
 * fs.writeSync MAY RETURN SHORT, and discarding the count is the one path that defeats
 * finalize's assembled-size re-verification: writeAt then ftruncates to the ASSUMED
 * length, so the file ends up exactly the expected size with a zero-filled hole where
 * the unwritten tail belongs. The size check passes and a silently corrupt video is
 * published.
 *
 * Throwing is the correct response and needs no new client handling: the session
 * counters commit only after writeAt returns, so a throw leaves them untouched and the
 * client's retry at the same nextIndex overwrites from the same offset.
 *
 * Extracted rather than inlined so it is directly testable — inline, no test could
 * reach it without stubbing a module-level fs import, and a mutation removing it passed.
 */
export function assertFullWrite(written: number, expected: number): void {
  if (written !== expected) {
    throw new Error(`short chunk write: ${written} of ${expected} bytes`)
  }
}

/** The real implementation, exported so a test can DECORATE it (inject one
 *  failing write and delegate the rest) rather than re-implement it — a fake that
 *  restates writeAt would pass forever while this drifted. */
export const defaultUploadSessionFs: UploadSessionFs = {
  create: (path) => {
    // Created eagerly and synchronously so the file provably exists before init
    // answers: an upload whose staging file appears later cannot be swept, and
    // a resume probe would report progress against a path that is not there.
    closeSync(openSync(path, 'w', 0o600))
  },
  writeAt: (path, bytes, position) => {
    const fd = openSync(path, 'r+')
    try {
      // fs.writeSync MAY RETURN SHORT. Discarding the count and then truncating to
      // the assumed length is the one path that defeats finalize's assembled-size
      // re-verification: the file ends up exactly the expected length with a
      // zero-filled hole where the unwritten tail should be, so the size check
      // passes and a silently corrupt video is published. Throwing instead leaves
      // the counters untouched (they commit only after this returns), so the client's
      // retry at the same nextIndex overwrites from the same offset — the existing
      // idempotency path, no new client handling required.
      assertFullWrite(writeSync(fd, bytes, 0, bytes.length, position), bytes.length)
      // Truncate to the exact committed length. A previous attempt at this same
      // index may have written MORE bytes here (it is retried after a reconnect,
      // and the last chunk is short), which would otherwise leave a tail beyond
      // the counters and make the finalize size check fail on a healthy upload.
      ftruncateSync(fd, position + bytes.length)
    } finally {
      closeSync(fd)
    }
  },
  sizeOf: (path) => statSync(path).size,
}

export interface UploadSessionRegistryOptions {
  createStagingFile?: () => MediaStagingFile
  now?: () => number
  fs?: Partial<UploadSessionFs>
  ttlMs?: number
  /** The assembled ceiling — contract's `chunkedMaxBytes`. Test seam. */
  maxBytes?: number
  /** Per-chunk ceiling — contract's `chunkBytes`. Test seam. */
  maxChunkBytes?: number
  maxConcurrent?: number
}

export class UploadSessionRegistry {
  private readonly sessions = new Map<string, UploadSession>()
  private readonly createStaging: () => MediaStagingFile
  private readonly now: () => number
  private readonly fs: UploadSessionFs
  private readonly ttlMs: number
  private readonly maxBytes: number
  private readonly maxChunkBytes: number
  private readonly maxConcurrent: number

  constructor(options: UploadSessionRegistryOptions = {}) {
    this.createStaging = options.createStagingFile ?? (() => getMediaStore().createStagingFile())
    this.now = options.now ?? Date.now
    this.fs = { ...defaultUploadSessionFs, ...options.fs }
    this.ttlMs = options.ttlMs ?? CHUNKED_UPLOAD_TTL_MS
    this.maxBytes = options.maxBytes ?? MAX_CHUNKED_MEDIA_BYTES
    this.maxChunkBytes = options.maxChunkBytes ?? MEDIA_CHUNK_BYTES
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_CHUNKED_UPLOADS
  }

  create(input: CreateUploadInput): UploadSession {
    this.sweepExpired()
    const totalBytes = input.totalBytes
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new UploadSessionError('invalid_total_bytes', 'totalBytes must be a positive integer')
    }
    // The declared size is a CLAIM (§6). Bounding it here is the cheap refusal;
    // appendChunk still enforces it as bytes actually arrive.
    if (totalBytes > this.maxBytes) {
      throw new UploadSessionError(
        'attachment_too_large',
        `declared size exceeds ${this.maxBytes} byte ceiling`,
        { maxBytes: this.maxBytes },
      )
    }
    if (this.sessions.size >= this.maxConcurrent) {
      throw new UploadSessionError('chunked_upload_unavailable', 'too many uploads in flight')
    }

    const staged = this.createStaging()
    try {
      this.fs.create(staged.path)
    } catch (err) {
      staged.dispose()
      throw new UploadSessionError(
        'upload_staging_failed',
        `staging file could not be created: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
    const startedAt = this.now()
    const session: UploadSession = {
      uploadId: `u_${randomBytes(12).toString('hex')}`,
      stagingPath: staged.path,
      totalBytes,
      receivedBytes: 0,
      nextIndex: 0,
      ...(input.mime ? { mime: input.mime } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAtMs: startedAt,
      expiresAtMs: startedAt + this.ttlMs,
      dispose: staged.dispose,
    }
    this.sessions.set(session.uploadId, session)
    return session
  }

  /** Resume probe. Sweeps first, so an expired upload reads as unknown rather
   *  than reporting progress that can never be finalized. */
  peek(uploadId: string): UploadSession | undefined {
    this.sweepExpired()
    if (!isValidUploadId(uploadId)) return undefined
    return this.sessions.get(uploadId)
  }

  appendChunk(uploadId: string, index: number, bytes: Buffer): UploadSession {
    const session = this.require(uploadId)
    if (bytes.length === 0) {
      // A zero-byte chunk would advance nextIndex without progress, so a client
      // looping on it would never finish and never fail.
      throw new UploadSessionError('chunk_bytes_required', 'chunk body is empty')
    }
    // Repairable, so the session survives: the client can re-send this index at
    // the advertised chunk size.
    if (bytes.length > this.maxChunkBytes) {
      throw new UploadSessionError(
        'attachment_too_large',
        `chunk exceeds ${this.maxChunkBytes} byte chunk size`,
        { maxBytes: this.maxChunkBytes, expectedIndex: session.nextIndex },
      )
    }
    if (!Number.isSafeInteger(index) || index !== session.nextIndex) {
      // Strictly in-order (§6). A re-send of an ALREADY-committed index lands
      // here too and gets the recovery information it needs rather than a blind
      // second append of the same bytes.
      throw new UploadSessionError('chunk_out_of_order', `expected chunk ${session.nextIndex}`, {
        expectedIndex: session.nextIndex,
      })
    }
    // "whichever is lower" (§6). create() already bounds totalBytes to maxBytes,
    // so the DECLARED value is the operative half and the ceiling half is
    // unreachable through the public API — measured: replacing this min() with
    // `session.totalBytes` alone leaves the whole suite green, while replacing it
    // with `this.maxBytes` alone fails. It stays as the contract's literal rule,
    // and as what keeps this correct if init's bound ever loosens.
    const limit = Math.min(session.totalBytes, this.maxBytes)
    if (session.receivedBytes + bytes.length > limit) {
      // Fatal, not repairable: the assembled file can no longer match what was
      // declared, so the upload is dropped and its disk released immediately.
      this.drop(uploadId)
      throw new UploadSessionError('attachment_too_large', `upload exceeds ${limit} declared bytes`, {
        maxBytes: limit,
      })
    }

    this.fs.writeAt(session.stagingPath, bytes, session.receivedBytes)
    // Committed only after the write RETURNED. A throw above leaves the counters
    // untouched, so the retry of this same index writes at the same offset and
    // overwrites whatever the failed attempt left — that positional write, not
    // an open(path,'a'), is what makes re-sending the chunk at nextIndex
    // idempotent instead of duplicating bytes.
    session.receivedBytes += bytes.length
    session.nextIndex += 1
    return session
  }

  /** Completeness first (non-destructive: `incomplete_upload` means keep going),
   *  then hand the session over and forget it. The caller owns the staging file
   *  from that moment, so a duplicate finalize is a clean 404 rather than a
   *  second ingest of the same bytes. */
  finalize(uploadId: string): UploadSession {
    const session = this.require(uploadId)
    if (session.receivedBytes !== session.totalBytes) {
      throw new UploadSessionError('incomplete_upload', 'upload is not complete', {
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalBytes,
      })
    }
    // §6: re-verify the ASSEMBLED size before ingest. The counters are ours and
    // the file is the thing being ingested — when they disagree, the counters
    // are the ones that cannot be trusted, so refuse rather than ingest a
    // truncated or over-long body.
    let actualBytes: number
    try {
      actualBytes = this.fs.sizeOf(session.stagingPath)
    } catch (err) {
      this.drop(uploadId)
      throw new UploadSessionError(
        'upload_size_mismatch',
        `assembled upload could not be measured: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
    if (actualBytes !== session.totalBytes) {
      this.drop(uploadId)
      throw new UploadSessionError('upload_size_mismatch', 'assembled size does not match the declared total', {
        receivedBytes: actualBytes,
        totalBytes: session.totalBytes,
      })
    }
    this.sessions.delete(uploadId)
    return session
  }

  /** Forget the session AND release its staging file. */
  drop(uploadId: string): boolean {
    const session = this.sessions.get(uploadId)
    if (!session) return false
    this.sessions.delete(uploadId)
    try { session.dispose() } catch { /* already moved or gone */ }
    return true
  }

  /** Lazy sweep on every access rather than a second interval timer: tmp/ is
   *  wiped by MediaStore boot reconcile, so the only case a timer would add is a
   *  server that never touches media again before restarting. */
  sweepExpired(now = this.now()): number {
    let dropped = 0
    for (const [uploadId, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(uploadId)
        try { session.dispose() } catch { /* already moved or gone */ }
        dropped++
      }
    }
    return dropped
  }

  progressOf(session: UploadSession): UploadSessionProgress {
    return {
      uploadId: session.uploadId,
      totalBytes: session.totalBytes,
      receivedBytes: session.receivedBytes,
      nextIndex: session.nextIndex,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    }
  }

  size(): number {
    return this.sessions.size
  }

  private require(uploadId: string): UploadSession {
    const session = this.peek(uploadId)
    // A wiped, expired, or never-existent upload is the SAME answer (§6): 404,
    // never a partial success. A restart legitimately produces this.
    if (!session) throw new UploadSessionError('upload_not_found', 'unknown or expired upload')
    return session
  }
}

// ── Default singleton ────────────────────────────────────────────────────────

let defaultRegistry: UploadSessionRegistry | null = null

export function getUploadSessions(): UploadSessionRegistry {
  if (!defaultRegistry) defaultRegistry = new UploadSessionRegistry()
  return defaultRegistry
}

/** Test hook — mirrors _setMediaStoreForTests so a route test can install a
 *  registry with a fake clock and tiny ceilings. Returns the previous one. */
export function _setUploadSessionsForTests(
  registry: UploadSessionRegistry | null,
): UploadSessionRegistry | null {
  const prev = defaultRegistry
  defaultRegistry = registry
  return prev
}
