// Durable media store — the server-side home for image attachments.
// Layout (all under server/data/media/, dirs 0700 / files 0600):
//   index.json                                  — metadata index (atomic writes)
//   assets/<media-id>/original-normalized.jpg   — normalized phone asset
//   assets/<media-id>/thumb.jpg                 — thumbnail
//   assets/<media-id>/g2-N.pbm                  — RESERVED names; not generated
//                                                 until Release B picks a
//                                                 hardware-proven layout.
//
// Invariants:
//   * Published media is immutable — bytes and intrinsic metadata are never
//     replaced in place for an id a message can see.
//   * The public ref (shared/media-attachment.ts) never exposes storage paths;
//     lifecycle and paths live only in this index.
//   * All index mutations serialize through one promise chain.
//   * Uploads stage in tmp/, validate + normalize, then rename into assets/
//     and publish the index record — readers never see a half-written asset.
//   * Reservation/association are idempotent; replays can't duplicate or
//     prematurely release an asset. Associate wins over a delayed release.

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import {
  isValidMediaId,
  parseMediaAttachmentRef,
  type MediaAttachmentRef,
  type MediaKind,
} from '../../shared/media-attachment.js'
import {
  G2_VARIANT_H,
  G2_VARIANT_W,
  ImageSafetyError,
  normalizeImage,
  normalizeOutputArtifact,
  parsePngDimensions,
  renderG2Variant,
  sniffImageType,
  validateSourceImage,
} from './image-safety.js'

// Standalone state belongs under the same durable data root as conversations,
// archives, and run ledgers. COS_MEDIA_ROOT remains an explicit escape hatch
// for operators who keep high-volume image bytes on a separate local volume.
const DEFAULT_MEDIA_ROOT = process.env.COS_MEDIA_ROOT
  ? resolve(process.env.COS_MEDIA_ROOT)
  : dataPath('media')

// ── Retention policy (Release A contract) ────────────────────────────────────

export const STAGED_TTL_MS = 4 * 60 * 60_000          // unsubmitted uploads
export const RESERVED_TTL_MS = 7 * 24 * 60 * 60_000   // queued, not yet run
export const TRAFFIC_CONTENT_TTL_MS = 10 * 60_000     // traffic frame bytes
export const GENERATED_CONTENT_TTL_MS = 30 * 24 * 60 * 60_000 // agent-selected lens cache
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60_000         // expired/deleted rows
export const MEDIA_GC_INTERVAL_MS = 5 * 60_000
export const G2_LENS_VARIANT_CAPABILITY = 'png-288x144-v1'

// macOS File Provider/iCloud can transiently reject an otherwise-valid
// same-volume directory rename with errno -11 (EDEADLK). That exact failure
// surfaced during the first live output-image canary. Atomic publication is
// still the right boundary; retry the rename itself for a short bounded
// window instead of weakening it to copy-then-delete.
const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 75, 225, 675] as const

type RenameLike = (source: string, target: string) => void
type WaitLike = (ms: number) => Promise<void>

function isTransientAtomicRenameError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const value = err as { code?: unknown; errno?: unknown; message?: unknown }
  if (value.errno === -11 || value.errno === -35 || value.errno === -16 || value.errno === -4) return true
  const code = typeof value.code === 'string' ? value.code : ''
  if (code === 'EDEADLK' || code === 'EAGAIN' || code === 'EBUSY' || code === 'EINTR') return true
  return typeof value.message === 'string' && /Unknown system error -(?:11|35|16|4)\b/.test(value.message)
}

async function renameWithTransientRetry(
  source: string,
  target: string,
  rename: RenameLike = renameSync,
  wait: WaitLike = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(source, target)
      return
    } catch (err) {
      const delay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isTransientAtomicRenameError(err)) throw err
      console.warn(`[media-store] transient atomic rename failure; retrying in ${delay}ms`)
      await wait(delay)
    }
  }
}

/** Test seam for the File Provider rename recovery contract. */
export async function _renameWithTransientRetryForTests(
  source: string,
  target: string,
  rename: RenameLike,
  wait: WaitLike = async () => {},
): Promise<void> {
  await renameWithTransientRetry(source, target, rename, wait)
}

export type MediaLifecycle = 'staged' | 'reserved' | 'associated' | 'expired' | 'deleted'

export interface MediaRecord {
  ref: MediaAttachmentRef
  /** Relative to the media root. Never exposed through the API. */
  storagePath: string
  thumbPath: string
  bytes: number
  sha256: string
  lifecycle: MediaLifecycle
  /** True once asset bytes were removed (content TTL or GC) while the
   *  metadata record remains (e.g. expired traffic frames). */
  contentRemoved?: boolean
  sessionId?: string
  clientQueueItemId?: string
  runId?: string
  globalMsgNum?: number
  createdAtMs: number
  updatedAtMs: number
  reservedAtMs?: number
  associatedAtMs?: number
}

interface MediaIndexFile {
  v: 1
  records: Record<string, MediaRecord>
  savedAt: string
}

export type MediaStoreErrorCode =
  | 'media_not_found'
  | 'media_expired'
  | 'media_deleted'
  | 'media_unavailable'
  | 'media_conflict'

export class MediaStoreError extends Error {
  readonly code: MediaStoreErrorCode
  constructor(code: MediaStoreErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'MediaStoreError'
  }
}

export interface IngestInput {
  bytes: Buffer
  kind: MediaKind
  label?: string
  capturedAt?: string
  sessionId?: string
}

export type MediaContentResult =
  | { status: 'ok'; path: string; mime: MediaAttachmentRef['mime']; bytes: number }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'unavailable' }

function sanitizeRecord(raw: unknown): MediaRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ref = parseMediaAttachmentRef(r.ref)
  if (!ref) return null
  if (typeof r.storagePath !== 'string' || typeof r.thumbPath !== 'string') return null
  const lifecycle = r.lifecycle
  if (lifecycle !== 'staged' && lifecycle !== 'reserved' && lifecycle !== 'associated' &&
      lifecycle !== 'expired' && lifecycle !== 'deleted') return null
  // Paths are derived from the strictly validated id — reject drift.
  const expectedDir = join('assets', ref.id)
  if (!r.storagePath.startsWith(expectedDir) || !r.thumbPath.startsWith(expectedDir)) return null
  return {
    ref,
    storagePath: r.storagePath,
    thumbPath: r.thumbPath,
    bytes: typeof r.bytes === 'number' && r.bytes >= 0 ? r.bytes : 0,
    sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
    lifecycle,
    contentRemoved: r.contentRemoved === true,
    ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
    ...(typeof r.clientQueueItemId === 'string' ? { clientQueueItemId: r.clientQueueItemId } : {}),
    ...(typeof r.runId === 'string' ? { runId: r.runId } : {}),
    ...(typeof r.globalMsgNum === 'number' ? { globalMsgNum: r.globalMsgNum } : {}),
    createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : Date.now(),
    updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : Date.now(),
    ...(typeof r.reservedAtMs === 'number' ? { reservedAtMs: r.reservedAtMs } : {}),
    ...(typeof r.associatedAtMs === 'number' ? { associatedAtMs: r.associatedAtMs } : {}),
  }
}

export class MediaStore {
  private readonly root: string
  private readonly records = new Map<string, MediaRecord>()
  private readonly renderLensVariant: typeof renderG2Variant
  /** One cold-cache render per media id. Callers share the same promise. */
  private readonly g2InFlight = new Map<string, Promise<MediaContentResult>>()
  /** A corrupt/unreadable index makes the asset directory authoritative only
   *  for recovery. Never classify its entries as disposable orphans that boot. */
  private allowOrphanCleanup = true
  // ONE promise chain serializes every index mutation.
  private mutationChain: Promise<unknown> = Promise.resolve()
  private gcTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    root: string = DEFAULT_MEDIA_ROOT,
    dependencies: { renderG2Variant?: typeof renderG2Variant } = {},
  ) {
    this.root = root
    this.renderLensVariant = dependencies.renderG2Variant ?? renderG2Variant
    this.ensureDirs()
    this.loadIndex()
    this.reconcile()
  }

  // ── Filesystem layout ──────────────────────────────────────────────────────

  private ensureDirs(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(join(this.root, 'assets'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.root, 'tmp'), { recursive: true, mode: 0o700 })
  }

  private indexPath(): string {
    return join(this.root, 'index.json')
  }

  private absPath(rel: string): string {
    return join(this.root, rel)
  }

  // ── Index persistence ──────────────────────────────────────────────────────

  private loadIndex(): void {
    const path = this.indexPath()
    const result = loadJsonOrQuarantine<MediaIndexFile>(path)
    if (result.status === 'missing') {
      // loadJsonOrQuarantine also reports transient read/permission failures as
      // missing. If the file still exists, fail safe instead of deleting every
      // asset because an unreadable index yielded zero records.
      if (existsSync(path)) {
        this.allowOrphanCleanup = false
        console.error(
          '[media-store] media index exists but could not be read. ' +
          'Asset dirs are preserved and orphan cleanup is disabled this boot.',
        )
      } else {
        // A missing index beside surviving asset dirs can also be the result of
        // interrupted recovery. Prefer a small storage leak to unrecoverable
        // deletion; a healthy empty store has no asset entries to preserve.
        try {
          if (readdirSync(join(this.root, 'assets')).length > 0) {
            this.allowOrphanCleanup = false
            console.error(
              '[media-store] media index is missing while asset dirs exist. ' +
              'Asset dirs are preserved and orphan cleanup is disabled this boot.',
            )
          }
        } catch { /* reconcile will independently tolerate an unreadable asset dir */ }
      }
      return
    }
    if (result.status === 'corrupt') {
      this.allowOrphanCleanup = false
      console.error(
        `[media-store] CORRUPT media index quarantined to ${result.quarantinedAs}. ` +
        'Starting with an empty index; asset dirs are preserved and orphan cleanup is disabled this boot.',
        result.error,
      )
      return
    }
    if (!result.data || typeof result.data !== 'object' || result.data.v !== 1 ||
        !result.data.records || typeof result.data.records !== 'object' ||
        Array.isArray(result.data.records)) {
      this.allowOrphanCleanup = false
      const requestedQuarantinePath = `${path}.corrupt-${Date.now()}`
      let quarantinedAs = path
      try {
        renameSync(path, requestedQuarantinePath)
        quarantinedAs = requestedQuarantinePath
      } catch { /* preserve in place if quarantine fails */ }
      console.error(
        `[media-store] INVALID media index quarantined to ${quarantinedAs}. ` +
        'Asset dirs are preserved and orphan cleanup is disabled this boot.',
      )
      return
    }
    let invalidRecords = 0
    for (const raw of Object.values(result.data.records)) {
      const rec = sanitizeRecord(raw)
      if (rec) this.records.set(rec.ref.id, rec)
      else invalidRecords++
    }
    if (invalidRecords > 0) {
      this.allowOrphanCleanup = false
      const requestedQuarantinePath = `${path}.corrupt-${Date.now()}`
      let quarantinedAs = path
      try {
        renameSync(path, requestedQuarantinePath)
        quarantinedAs = requestedQuarantinePath
      } catch { /* preserve in place if quarantine fails */ }
      console.error(
        `[media-store] media index contained ${invalidRecords} invalid record(s); ` +
        `quarantined to ${quarantinedAs}. Asset dirs are preserved and orphan cleanup is disabled this boot.`,
      )
    }
  }

  private saveIndex(): void {
    const data: MediaIndexFile = {
      v: 1,
      records: Object.fromEntries(this.records),
      savedAt: new Date().toISOString(),
    }
    atomicWriteFileSync(this.indexPath(), JSON.stringify(data, null, 2))
  }

  /** Serialize an index mutation. All lifecycle transitions go through here. */
  private withLock<T>(op: () => T | Promise<T>): Promise<T> {
    const run = this.mutationChain.then(op, op)
    this.mutationChain = run.then(() => undefined, () => undefined)
    return run
  }

  // ── Boot reconciliation ────────────────────────────────────────────────────

  /** Quarantine-free reconcile: drop tmp leftovers, remove unpublished orphan
   *  asset dirs, and flag indexed records whose content is missing. Never
   *  throws — one bad asset must not take the server down. */
  private reconcile(): void {
    try {
      rmSync(join(this.root, 'tmp'), { recursive: true, force: true })
      mkdirSync(join(this.root, 'tmp'), { recursive: true, mode: 0o700 })
    } catch { /* best effort */ }
    if (this.allowOrphanCleanup) {
      try {
        for (const entry of readdirSync(join(this.root, 'assets'))) {
          try {
            if (!this.records.has(entry)) {
              // Unpublished orphan — the upload died between rename and index
              // publish. Remove; the client never received this id.
              rmSync(join(this.root, 'assets', entry), { recursive: true, force: true })
              console.warn(`[media-store] removed unpublished orphan asset ${entry}`)
            }
          } catch { /* skip this asset */ }
        }
      } catch { /* assets dir unreadable — leave for next boot */ }
    } else {
      console.warn('[media-store] preserving unindexed asset dirs for recovery this boot')
    }
    let dirty = false
    for (const rec of this.records.values()) {
      try {
        if (!rec.contentRemoved && rec.lifecycle !== 'deleted' && rec.lifecycle !== 'expired' &&
            !existsSync(this.absPath(rec.storagePath))) {
          rec.contentRemoved = true
          rec.updatedAtMs = Date.now()
          dirty = true
          console.warn(`[media-store] indexed content missing for ${rec.ref.id} — marked unavailable`)
        }
      } catch { /* skip */ }
    }
    if (dirty) {
      try { this.saveIndex() } catch (err) { console.error('[media-store] reconcile save failed:', err) }
    }
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────

  async ingestImage(input: IngestInput): Promise<MediaAttachmentRef> {
    // Validate + normalize OUTSIDE the index lock (CPU/subprocess-heavy).
    const validated = validateSourceImage(input.bytes)
    const normalized = await normalizeImage(validated)
    return this.publishNormalizedImage(input, normalized)
  }

  /** Trusted-local agent artifact ingress. Unlike the public upload path,
   * this accepts a bounded larger JPEG/PNG/WebP/HEIC/AVIF and immediately
   * converts it into the same normalized JPEG contract before publication. */
  async ingestOutputImage(input: IngestInput): Promise<MediaAttachmentRef> {
    if (input.kind !== 'generated_visual') {
      throw new ImageSafetyError('unsupported_format', 'output artifact ingress is generated_visual only')
    }
    const normalized = await normalizeOutputArtifact(input.bytes)
    return this.publishNormalizedImage(input, normalized)
  }

  private async publishNormalizedImage(
    input: IngestInput,
    normalized: Awaited<ReturnType<typeof normalizeImage>>,
  ): Promise<MediaAttachmentRef> {
    const id = `m_${randomBytes(12).toString('hex')}`
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const ref: MediaAttachmentRef = {
      id,
      kind: input.kind,
      mime: normalized.mime,
      width: normalized.width,
      height: normalized.height,
      createdAt: nowIso,
      ...(input.label ? { label: input.label.slice(0, 120) } : {}),
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      ...(input.kind === 'traffic_frame'
        ? { expiresAt: new Date(now + TRAFFIC_CONTENT_TTL_MS).toISOString() }
        : input.kind === 'generated_visual'
          ? { expiresAt: new Date(now + GENERATED_CONTENT_TTL_MS).toISOString() }
          : {}),
    }

    // Stage in tmp/<id>/, then atomically rename into assets/<id>/.
    const stageDir = join(this.root, 'tmp', id)
    mkdirSync(stageDir, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(join(stageDir, 'original-normalized.jpg'), normalized.normalized, { mode: 0o600 })
      writeFileSync(join(stageDir, 'thumb.jpg'), normalized.thumb, { mode: 0o600 })
      await renameWithTransientRetry(stageDir, join(this.root, 'assets', id))
    } catch (err) {
      try { rmSync(stageDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw err
    }

    const record: MediaRecord = {
      ref,
      storagePath: join('assets', id, 'original-normalized.jpg'),
      thumbPath: join('assets', id, 'thumb.jpg'),
      bytes: normalized.normalized.length,
      sha256: createHash('sha256').update(normalized.normalized).digest('hex'),
      lifecycle: 'staged',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAtMs: now,
      updatedAtMs: now,
    }
    await this.withLock(() => {
      this.records.set(id, record)
      this.saveIndex()
    })
    return ref
  }

  // ── Lookups (read-only, no lock needed) ───────────────────────────────────

  getRecord(id: string): MediaRecord | null {
    if (!isValidMediaId(id)) return null
    return this.records.get(id) ?? null
  }

  getRef(id: string): MediaAttachmentRef | null {
    return this.getRecord(id)?.ref ?? null
  }

  /** Resolve content for serving/model input, honoring lifecycle + TTLs. */
  getContent(id: string, variant: 'phone' | 'thumb' | 'g2' = 'phone'): MediaContentResult {
    const rec = this.getRecord(id)
    if (!rec || rec.lifecycle === 'deleted') return { status: 'not_found' }
    if (rec.lifecycle === 'expired' || this.isContentExpired(rec)) return { status: 'expired' }
    // TTL-controlled bytes report 'expired'; reserve 'unavailable' for
    // genuinely missing/corrupt durable content.
    if (rec.contentRemoved && (rec.ref.kind === 'traffic_frame' || rec.ref.kind === 'generated_visual')) {
      return { status: 'expired' }
    }
    if (rec.contentRemoved) return { status: 'unavailable' }
    if (variant === 'g2') {
      // Lens variant is generated lazily by getG2Content (async); this sync
      // path only reports an already-cached file.
      const g2Path = this.absPath(join('assets', rec.ref.id, 'g2-288.png'))
      if (!existsSync(g2Path)) return { status: 'unavailable' }
      try {
        if (!this.isValidG2Variant(readFileSync(g2Path))) return { status: 'unavailable' }
      } catch {
        return { status: 'unavailable' }
      }
      return { status: 'ok', path: g2Path, mime: 'image/png' as MediaAttachmentRef['mime'], bytes: 0 }
    }
    const rel = variant === 'thumb' ? rec.thumbPath : rec.storagePath
    const path = this.absPath(rel)
    if (!existsSync(path)) return { status: 'unavailable' }
    return { status: 'ok', path, mime: rec.ref.mime, bytes: variant === 'thumb' ? 0 : rec.bytes }
  }

  /** Release B — resolve the on-lens variant, generating and caching it on
   *  first request (exact 288x144 grayscale PNG; see renderG2Variant). The
   *  cached file lives beside the asset and follows its lifecycle (the whole
   *  asset dir is removed together). */
  async getG2Content(id: string): Promise<MediaContentResult> {
    const rec = this.getRecord(id)
    if (!rec || rec.lifecycle === 'deleted') return { status: 'not_found' }
    if (rec.lifecycle === 'expired' || this.isContentExpired(rec)) return { status: 'expired' }
    if (rec.contentRemoved) {
      return rec.ref.kind === 'traffic_frame' || rec.ref.kind === 'generated_visual'
        ? { status: 'expired' }
        : { status: 'unavailable' }
    }
    const g2Path = this.absPath(join('assets', rec.ref.id, 'g2-288.png'))
    if (existsSync(g2Path)) {
      try {
        if (this.isValidG2Variant(readFileSync(g2Path))) {
          return { status: 'ok', path: g2Path, mime: 'image/png' as MediaAttachmentRef['mime'], bytes: 0 }
        }
      } catch { /* repair below */ }
    }
    const srcPath = this.absPath(rec.storagePath)
    if (!existsSync(srcPath)) return { status: 'unavailable' }

    const existing = this.g2InFlight.get(id)
    if (existing) return existing
    const generation = Promise.resolve().then(() => this.generateOrRepairG2Content(id))
    this.g2InFlight.set(id, generation)
    try {
      return await generation
    } finally {
      if (this.g2InFlight.get(id) === generation) this.g2InFlight.delete(id)
    }
  }

  private isValidG2Variant(bytes: Buffer): boolean {
    if (sniffImageType(bytes) !== 'image/png') return false
    const dims = parsePngDimensions(bytes)
    return dims?.width === G2_VARIANT_W && dims.height === G2_VARIANT_H
  }

  private async generateOrRepairG2Content(id: string): Promise<MediaContentResult> {
    const rec = this.getRecord(id)
    if (!rec || rec.lifecycle === 'deleted') return { status: 'not_found' }
    if (rec.lifecycle === 'expired' || this.isContentExpired(rec)) return { status: 'expired' }
    if (rec.contentRemoved) {
      return rec.ref.kind === 'traffic_frame' || rec.ref.kind === 'generated_visual'
        ? { status: 'expired' }
        : { status: 'unavailable' }
    }

    const g2Path = this.absPath(join('assets', rec.ref.id, 'g2-288.png'))
    if (existsSync(g2Path)) {
      try {
        if (this.isValidG2Variant(readFileSync(g2Path))) {
          return { status: 'ok', path: g2Path, mime: 'image/png' as MediaAttachmentRef['mime'], bytes: 0 }
        }
      } catch { /* remove and regenerate below */ }
      try { rmSync(g2Path, { force: true }) } catch { /* atomic rename can still replace it */ }
      console.warn(`[media-store] invalid G2 cache for ${id} — regenerating`)
    }

    const srcPath = this.absPath(rec.storagePath)
    if (!existsSync(srcPath)) return { status: 'unavailable' }
    let tmpPath: string | null = null
    try {
      const g2 = await this.renderLensVariant(readFileSync(srcPath))
      if (!this.isValidG2Variant(g2)) {
        throw new ImageSafetyError(
          'normalization_failed',
          `G2 renderer returned a payload other than ${G2_VARIANT_W}x${G2_VARIANT_H} PNG`,
        )
      }

      // Rendering is asynchronous. Re-check lifecycle before publishing so a
      // concurrent delete/GC cannot resurrect bytes into a removed asset dir.
      const current = this.getRecord(id)
      if (!current || current.lifecycle === 'deleted') return { status: 'not_found' }
      if (current.lifecycle === 'expired' || this.isContentExpired(current)) return { status: 'expired' }
      if (current.contentRemoved || current.storagePath !== rec.storagePath || !existsSync(srcPath)) {
        return current.ref.kind === 'traffic_frame' || current.ref.kind === 'generated_visual'
          ? { status: 'expired' }
          : { status: 'unavailable' }
      }

      // Atomic publish. The random private tmp name also remains safe if two
      // server processes briefly overlap during a deployment.
      tmpPath = join(this.root, 'tmp', `g2-${rec.ref.id}-${randomBytes(6).toString('hex')}.png`)
      writeFileSync(tmpPath, g2, { mode: 0o600 })
      renameSync(tmpPath, g2Path)
      tmpPath = null
      return { status: 'ok', path: g2Path, mime: 'image/png' as MediaAttachmentRef['mime'], bytes: g2.length }
    } catch (err) {
      console.error(`[media-store] G2 variant render failed for ${id}:`, err)
      return { status: 'unavailable' }
    } finally {
      if (tmpPath) {
        try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
      }
    }
  }

  private isContentExpired(rec: MediaRecord, now = Date.now()): boolean {
    if (rec.ref.kind === 'traffic_frame' && now - rec.createdAtMs > TRAFFIC_CONTENT_TTL_MS) return true
    if (rec.ref.kind === 'generated_visual' && now - rec.createdAtMs > GENERATED_CONTENT_TTL_MS) return true
    if (rec.lifecycle === 'staged' && now - rec.createdAtMs > STAGED_TTL_MS) return true
    if (rec.lifecycle === 'reserved' && now - (rec.reservedAtMs ?? rec.createdAtMs) > RESERVED_TTL_MS) return true
    return false
  }

  /** Throwing resolver used by the query pipeline: id must be usable NOW. */
  resolveUsable(id: string, clientQueueItemId?: string): { record: MediaRecord; path: string } {
    const rec = this.getRecord(id)
    if (!rec || rec.lifecycle === 'deleted') {
      throw new MediaStoreError('media_not_found', `attachment ${id} not found`)
    }
    if (rec.lifecycle === 'expired' || this.isContentExpired(rec)) {
      throw new MediaStoreError('media_expired', `attachment ${id} expired`)
    }
    // An attachment id is never bearer authorization by itself: when a
    // reservation exists, the caller must present the matching queue identity.
    if (rec.lifecycle === 'reserved' && rec.clientQueueItemId &&
        clientQueueItemId !== rec.clientQueueItemId) {
      throw new MediaStoreError('media_conflict', `attachment ${id} is reserved by another queue item`)
    }
    const content = this.getContent(id, 'phone')
    if (content.status !== 'ok') {
      throw new MediaStoreError('media_unavailable', `attachment ${id} content unavailable`)
    }
    return { record: rec, path: content.path }
  }

  // ── Lifecycle transitions (idempotent, serialized) ────────────────────────

  /** Reserve staged media for a queued prompt. Safe to replay. */
  reserve(ids: string[], owner: { sessionId?: string; clientQueueItemId: string }): Promise<MediaAttachmentRef[]> {
    return this.withLock(() => {
      const now = Date.now()
      // Validate all before mutating any — reservation is all-or-nothing.
      for (const id of ids) {
        const rec = this.records.get(id)
        if (!rec || rec.lifecycle === 'deleted') throw new MediaStoreError('media_not_found', `attachment ${id} not found`)
        if (rec.lifecycle === 'expired' || this.isContentExpired(rec, now)) throw new MediaStoreError('media_expired', `attachment ${id} expired`)
        if (rec.lifecycle === 'reserved' && rec.clientQueueItemId && rec.clientQueueItemId !== owner.clientQueueItemId) {
          throw new MediaStoreError('media_conflict', `attachment ${id} already reserved by another queue item`)
        }
        // associated: replayed reserve after association is a no-op (associate wins).
      }
      const refs: MediaAttachmentRef[] = []
      let dirty = false
      for (const id of ids) {
        const rec = this.records.get(id)!
        refs.push(rec.ref)
        if (rec.lifecycle === 'staged' ||
            (rec.lifecycle === 'reserved' && rec.clientQueueItemId !== owner.clientQueueItemId)) {
          rec.lifecycle = 'reserved'
          rec.clientQueueItemId = owner.clientQueueItemId
          if (owner.sessionId) rec.sessionId = owner.sessionId
          rec.reservedAtMs = now
          rec.updatedAtMs = now
          dirty = true
        } else if (rec.lifecycle === 'reserved' && owner.sessionId && rec.sessionId !== owner.sessionId) {
          rec.sessionId = owner.sessionId
          rec.updatedAtMs = now
          dirty = true
        }
      }
      if (dirty) this.saveIndex()
      return refs
    })
  }

  /** Bind media to its final run/message. Safe to replay; wins over a
   *  delayed release. */
  associate(ids: string[], target: { sessionId?: string; runId?: string; globalMsgNum?: number }): Promise<void> {
    return this.withLock(() => {
      const now = Date.now()
      let dirty = false
      for (const id of ids) {
        const rec = this.records.get(id)
        if (!rec || rec.lifecycle === 'deleted') throw new MediaStoreError('media_not_found', `attachment ${id} not found`)
        if (rec.lifecycle === 'expired') throw new MediaStoreError('media_expired', `attachment ${id} expired`)
        let recDirty = false
        if (rec.lifecycle !== 'associated') {
          rec.lifecycle = 'associated'
          rec.associatedAtMs = now
          recDirty = true
        }
        if (target.sessionId && rec.sessionId !== target.sessionId) { rec.sessionId = target.sessionId; recDirty = true }
        if (target.runId && rec.runId !== target.runId) { rec.runId = target.runId; recDirty = true }
        if (target.globalMsgNum != null && rec.globalMsgNum !== target.globalMsgNum) { rec.globalMsgNum = target.globalMsgNum; recDirty = true }
        if (recDirty) {
          rec.updatedAtMs = now
          dirty = true
        }
      }
      if (dirty) this.saveIndex()
    })
  }

  /** Release staged/reserved media owned by the supplied queue identity
   *  (user cancelled before the run). Associated media is untouched —
   *  associate wins over a delayed release. Safe to replay. */
  release(ids: string[], owner: { sessionId?: string; clientQueueItemId?: string }): Promise<void> {
    return this.withLock(() => {
      const now = Date.now()
      let dirty = false
      for (const id of ids) {
        const rec = this.records.get(id)
        if (!rec || rec.lifecycle === 'deleted' || rec.lifecycle === 'expired' || rec.lifecycle === 'associated') continue
        if (rec.lifecycle === 'reserved' &&
            rec.clientQueueItemId && owner.clientQueueItemId !== rec.clientQueueItemId) {
          continue // not this caller's reservation
        }
        this.removeAssetFiles(rec)
        rec.lifecycle = 'expired'
        rec.updatedAtMs = now
        dirty = true
      }
      if (dirty) this.saveIndex()
    })
  }

  /** Hard delete — permitted only while unassociated (staged/reserved).
   *  Associated records follow conversation retention instead. */
  deleteUnassociated(id: string): Promise<boolean> {
    return this.withLock(() => {
      const rec = this.records.get(id)
      if (!rec || rec.lifecycle === 'deleted') return false
      if (rec.lifecycle === 'associated') {
        throw new MediaStoreError('media_conflict', 'associated media follows message retention')
      }
      this.removeAssetFiles(rec)
      rec.lifecycle = 'deleted'
      rec.contentRemoved = true
      rec.updatedAtMs = Date.now()
      this.saveIndex()
      return true
    })
  }

  private removeAssetFiles(rec: MediaRecord): void {
    try {
      rmSync(join(this.root, 'assets', rec.ref.id), { recursive: true, force: true })
    } catch { /* best effort */ }
    rec.contentRemoved = true
  }

  // ── Garbage collection ─────────────────────────────────────────────────────

  runGC(now = Date.now()): Promise<{ expired: number; contentDropped: number; pruned: number }> {
    return this.withLock(() => {
      let expired = 0
      let contentDropped = 0
      let pruned = 0
      for (const [id, rec] of this.records) {
        try {
          // Traffic frame content TTL — metadata survives, bytes go.
          if (rec.ref.kind === 'traffic_frame' && !rec.contentRemoved &&
              now - rec.createdAtMs > TRAFFIC_CONTENT_TTL_MS) {
            this.removeAssetFiles(rec)
            rec.updatedAtMs = now
            contentDropped++
          }
          // Agent-selected output images are a bounded local lens cache, not
          // a second permanent copy of generated/research/email artifacts.
          // Their generic metadata ref survives for honest "expired" UI.
          if (rec.ref.kind === 'generated_visual' && !rec.contentRemoved &&
              now - rec.createdAtMs > GENERATED_CONTENT_TTL_MS) {
            this.removeAssetFiles(rec)
            rec.updatedAtMs = now
            contentDropped++
          }
          // Staged / reserved lifecycle expiry.
          if ((rec.lifecycle === 'staged' && now - rec.createdAtMs > STAGED_TTL_MS) ||
              (rec.lifecycle === 'reserved' && now - (rec.reservedAtMs ?? rec.createdAtMs) > RESERVED_TTL_MS)) {
            this.removeAssetFiles(rec)
            rec.lifecycle = 'expired'
            rec.updatedAtMs = now
            expired++
          }
          // Tombstone pruning — expired/deleted rows that nothing references.
          if ((rec.lifecycle === 'expired' || rec.lifecycle === 'deleted') &&
              rec.globalMsgNum == null &&
              now - rec.updatedAtMs > TOMBSTONE_TTL_MS) {
            this.records.delete(id)
            pruned++
          }
        } catch (err) {
          console.error(`[media-store] GC error for ${id}:`, err)
        }
      }
      if (expired || contentDropped || pruned) this.saveIndex()
      return { expired, contentDropped, pruned }
    })
  }

  startGC(): void {
    if (this.gcTimer) return
    void this.runGC().catch((err) => console.error('[media-store] boot GC failed:', err))
    this.gcTimer = setInterval(() => {
      void this.runGC().catch((err) => console.error('[media-store] GC failed:', err))
    }, MEDIA_GC_INTERVAL_MS)
    this.gcTimer.unref?.()
  }

  stopGC(): void {
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = null
  }

  stats(): { total: number; byLifecycle: Record<string, number> } {
    const byLifecycle: Record<string, number> = {}
    for (const rec of this.records.values()) {
      byLifecycle[rec.lifecycle] = (byLifecycle[rec.lifecycle] ?? 0) + 1
    }
    return { total: this.records.size, byLifecycle }
  }
}

// ── Default singleton ────────────────────────────────────────────────────────

let defaultStore: MediaStore | null = null

export function getMediaStore(): MediaStore {
  if (!defaultStore) defaultStore = new MediaStore()
  return defaultStore
}

/** Test hook — point the singleton at a temp-dir store so route tests never
 *  touch server/data/media. Returns the previous store for restoration. */
export function _setMediaStoreForTests(store: MediaStore | null): MediaStore | null {
  const prev = defaultStore
  defaultStore = store
  return prev
}

export { ImageSafetyError }
