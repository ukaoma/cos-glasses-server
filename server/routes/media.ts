// Media attachment API (Release A) — authenticated upload, lifecycle, and
// content endpoints backed by server/lib/media-store.ts.
//
//   POST   /api/media                 — upload images (base64 JSON batch)
//   POST   /api/media/upload/init     — open a chunked upload (contract §2)
//   PUT    /api/media/upload/:id/:n   — append chunk n (raw bytes, in order)
//   GET    /api/media/upload/:id      — resume probe, safe to poll
//   POST   /api/media/upload/:id/finalize — assemble, then the SAME ingest
//   POST   /api/media/reserve         — bind staged media to a queue item
//   POST   /api/media/associate       — bind media to a run/message (replay-safe)
//   POST   /api/media/release         — drop staged/reserved media (cancel path)
//   GET    /api/media/:id             — metadata (public ref + availability)
//   GET    /api/media/:id/content     — bytes (?variant=phone|thumb)
//   DELETE /api/media/:id             — delete UNASSOCIATED media only
//
// Uploads accept uploaded bytes only — no remote URLs, no filesystem paths,
// no data-URI passthrough. The dedicated body parser (mediaBodyParser) is
// mounted BEFORE the global express.json() so a maximum valid batch
// (8 MiB decoded ≈ 10.7 MiB base64) doesn't trip the global 10 MB limit;
// the allowance stays scoped to /api/media.
//
// /api/media/file STREAMS to disk rather than buffering: see
// createMediaBinaryBodyParser below.

import { Router, json, type NextFunction, type Request, type Response } from 'express'
import { createReadStream, createWriteStream, openSync, statSync } from 'node:fs'
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  isValidMediaId,
  parseMediaIdList,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import {
  G2_LENS_VARIANT_CAPABILITY,
  getMediaStore,
  MediaStoreError,
  type MediaStagingFile,
} from '../lib/media-store.js'
import { currentMessageEra } from '../lib/message-era.js'
import {
  ImageSafetyError,
  MAX_BATCH_BYTES,
  isMediaProcessingReady,
  strictBase64Decode,
} from '../lib/image-safety.js'
import {
  MAX_OTHER_MEDIA_BYTES,
  MAX_VIDEO_MEDIA_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_SNIFF_BYTES,
  RichMediaSafetyError,
  isVideoUploadHead,
} from '../lib/rich-media-safety.js'
import {
  UploadSessionError,
  getUploadSessions,
  isValidUploadId,
  type UploadSessionErrorCode,
} from '../lib/upload-session.js'

// Route-scoped parser: 16 MB covers the max valid batch after base64 + JSON
// overhead. Mounted only for /api/media in server/index.ts — the global
// server limit is unchanged.
export const mediaBodyParser = json({ limit: '16mb' })

/** Chunked upload (contract §2) is registered on this router below, so health may
 *  advertise it. The flag lives beside the routes it describes precisely so the
 *  two cannot drift: flipping it without mounting them sends clients to 404s,
 *  and mounting them without flipping it advertises nothing. */
export const MEDIA_CHUNKED_UPLOAD_ENABLED = true

/** One streamed upload body, staged on disk. Held in a WeakMap keyed by the
 *  request so the handoff stays private to this module instead of widening the
 *  global express Request type. */
interface StagedUploadBody extends MediaStagingFile {
  bytes: number
}
const stagedUploadBodies = new WeakMap<Request, StagedUploadBody>()

export interface MediaBinaryParserOptions {
  /** Ceiling for ISO-BMFF video bodies. Test seam. */
  videoMaxBytes?: number
  /** Ceiling for everything else — images, PDFs, text. Test seam. */
  otherMaxBytes?: number
}

/** Streams a binary upload into the media store's tmp/ staging dir.
 *
 *  express.raw() buffered the whole body: at the 100 MB video cap that is a
 *  100 MB allocation per concurrent upload, and ffprobe/ffmpeg want a file on
 *  disk anyway, so the Buffer was pure overhead. The byte ceiling is enforced
 *  DURING streaming — an oversized body is refused about one chunk past the
 *  limit instead of after landing in full.
 *
 *  Video and other media now have DIFFERENT caps, so the ceiling starts at the
 *  larger of the two and tightens as soon as the leading magic bytes identify
 *  the kind. Classification is byte-based: a declared Content-Type must not be
 *  able to buy the bigger ceiling. */
export function createMediaBinaryBodyParser(options: MediaBinaryParserOptions = {}) {
  const videoMaxBytes = options.videoMaxBytes ?? MAX_VIDEO_MEDIA_BYTES
  const otherMaxBytes = options.otherMaxBytes ?? MAX_OTHER_MEDIA_BYTES
  const hardCeiling = Math.max(videoMaxBytes, otherMaxBytes)

  return function mediaBinaryUploadParser(req: Request, res: Response, next: NextFunction): void {
    // Mounted with app.use(), so it also sees verbs that carry no body.
    if (req.method !== 'POST' && req.method !== 'PUT') {
      next()
      return
    }

    // Answer, then stop listening. The client is mid-upload, so the request is
    // closed only once the response has flushed — otherwise it reads a
    // connection reset instead of the status.
    const refuse = (status: number, body: Record<string, unknown>): void => {
      res.status(status).json(body)
      res.once('finish', () => req.destroy())
    }

    // Content-Length is authoritative for body size when present, so an
    // obviously oversized upload is refused before a staging file even exists.
    const declaredLength = Number(req.header('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > hardCeiling) {
      refuse(413, { error: 'attachment_too_large', maxBytes: hardCeiling })
      return
    }

    const staged = getMediaStore().createStagingFile()
    let fd: number
    try {
      // Opened synchronously so the file provably exists before any bytes are
      // accepted. fs.createWriteStream opens LAZILY: an early reject that
      // destroys the stream and unlinks the path can lose that race, the
      // pending open then creates the file, and the staging file leaks.
      fd = openSync(staged.path, 'w', 0o600)
    } catch (err) {
      console.error('[media] could not open upload staging file:', err)
      staged.dispose()
      res.status(500).json({ error: 'attachment_staging_failed' })
      return
    }
    const sink = createWriteStream(staged.path, { fd, autoClose: true })
    const headChunks: Buffer[] = []
    let headBytes = 0
    let received = 0
    let ceiling = hardCeiling
    let settled = false

    const fail = (status: number, body: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      req.unpipe(sink)
      sink.destroy()
      staged.dispose()
      refuse(status, body)
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (headBytes < MEDIA_SNIFF_BYTES) {
        headChunks.push(chunk.subarray(0, MEDIA_SNIFF_BYTES - headBytes))
        headBytes = Math.min(MEDIA_SNIFF_BYTES, headBytes + chunk.length)
        if (headBytes >= MEDIA_SNIFF_BYTES) {
          ceiling = isVideoUploadHead(Buffer.concat(headChunks)) ? videoMaxBytes : otherMaxBytes
        }
      }
      if (received > ceiling) fail(413, { error: 'attachment_too_large', maxBytes: ceiling })
    })

    // Client hung up mid-upload: drop the partial file, answer nothing.
    const abandon = (): void => {
      if (settled) return
      settled = true
      sink.destroy()
      staged.dispose()
    }
    req.once('aborted', abandon)
    req.once('error', abandon)

    sink.once('error', (err) => {
      console.error('[media] upload staging write failed:', err)
      fail(500, { error: 'attachment_staging_failed' })
    })
    sink.once('finish', () => {
      if (settled) return
      settled = true
      stagedUploadBodies.set(req, { ...staged, bytes: received })
      // Handing off only after the body is fully drained is what keeps the
      // downstream JSON parsers off it: body-parser 2.x opens with
      // `onFinished.isFinished(req)`, true once `complete && !readable`, and
      // returns without reading. That matters because a .json attachment is a
      // supported format, so express.json() genuinely matches these uploads.
      // (The old `req._body = true` convention is body-parser 1.x and is not
      // consulted by the version shipped with Express 5 — verified in
      // node_modules/body-parser/lib/read.js.)
      next()
    })

    req.pipe(sink)
  }
}

/** Binary parser mounted only on /api/media/file, before global JSON. */
export const mediaBinaryBodyParser = createMediaBinaryBodyParser()

/** Claim the staged body for this request. Callers own disposal. */
function takeStagedUploadBody(req: Request): StagedUploadBody | undefined {
  const staged = stagedUploadBodies.get(req)
  if (staged) stagedUploadBodies.delete(req)
  return staged
}

/** One chunk's raw bytes, held per-request like the streamed single-shot body. */
const chunkBodies = new WeakMap<Request, Buffer>()

export interface MediaChunkParserOptions {
  /** Per-chunk ceiling — the contract's advertised `chunkBytes`. Test seam. */
  maxChunkBytes?: number
}

/** Raw-bytes parser for PUT /api/media/upload/:uploadId/:index.
 *
 *  This one BUFFERS where the single-shot parser streams, and the difference is
 *  deliberate: a chunk is bounded by the advertised chunkBytes (8 MiB), and
 *  holding the whole chunk before a single byte reaches the staging file is what
 *  makes the append atomic per chunk. A dropped connection therefore cannot
 *  leave a half-written chunk on disk, which is what lets the client re-send the
 *  chunk at `nextIndex` safely (§6). Streaming straight to the file would trade
 *  8 MiB of memory for a partial-write recovery problem on every reconnect.
 *
 *  Mounted as route-level middleware on the PUT below, so init/finalize keep the
 *  JSON parser and this can never see them. It is also safe to mount with
 *  app.use('/api/media/upload', …) ahead of the JSON parsers — the guard below
 *  makes a second pass a no-op. */
export function createMediaChunkBodyParser(options: MediaChunkParserOptions = {}) {
  const maxChunkBytes = options.maxChunkBytes ?? MEDIA_CHUNK_BYTES

  return function mediaChunkUploadParser(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'PUT') {
      next()
      return
    }
    if (chunkBodies.has(req)) {
      next()
      return
    }

    const refuse = (status: number, body: Record<string, unknown>): void => {
      res.status(status).json(body)
      res.once('finish', () => req.destroy())
    }

    // An upstream JSON parser already drained this body — verified: a PUT sent as
    // application/json arrives here with req.body set and readableEnded true.
    // Attaching 'end' to a finished stream would HANG the request, so convert it
    // into a legible refusal instead. Chunks must be raw bytes.
    if (req.readableEnded || req.body !== undefined) {
      refuse(400, {
        error: 'chunk_bytes_required',
        detail: 'chunk body must be sent as raw bytes (application/octet-stream)',
      })
      return
    }

    const declaredLength = Number(req.header('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxChunkBytes) {
      refuse(413, { error: 'attachment_too_large', maxBytes: maxChunkBytes })
      return
    }

    const parts: Buffer[] = []
    let received = 0
    let settled = false

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (received > maxChunkBytes) {
        settled = true
        parts.length = 0
        refuse(413, { error: 'attachment_too_large', maxBytes: maxChunkBytes })
        return
      }
      parts.push(chunk)
    })
    const abandon = (): void => {
      if (settled) return
      settled = true
      parts.length = 0
    }
    req.once('aborted', abandon)
    req.once('error', abandon)
    req.once('end', () => {
      if (settled) return
      settled = true
      chunkBodies.set(req, Buffer.concat(parts))
      next()
    })
  }
}

/** Chunk parser at the advertised chunk size. */
export const mediaChunkBodyParser = createMediaChunkBodyParser()

function takeChunkBody(req: Request): Buffer | undefined {
  const bytes = chunkBodies.get(req)
  // `!== undefined`, not truthiness: a zero-length chunk is a real (rejected)
  // body, and the registry owns that refusal.
  if (bytes !== undefined) chunkBodies.delete(req)
  return bytes
}

export const mediaRouter = Router()

const MEDIA_ERROR_STATUS: Record<string, number> = {
  media_not_found: 404,
  media_expired: 410,
  media_unavailable: 503,
  media_conflict: 409,
}

const SAFETY_ERROR_STATUS: Record<string, number> = {
  invalid_base64: 400,
  unsupported_format: 400,
  image_too_large: 400,
  dimensions_too_large: 400,
  corrupt_image: 400,
  media_processing_unavailable: 503,
  normalization_failed: 500,
  unsupported_attachment_format: 400,
  attachment_too_large: 413,
  corrupt_attachment: 400,
  attachment_processing_unavailable: 503,
  attachment_processing_failed: 500,
  video_too_long: 400,
}

const UPLOAD_ERROR_STATUS: Record<UploadSessionErrorCode, number> = {
  upload_not_found: 404,
  chunk_out_of_order: 409,
  attachment_too_large: 413,
  incomplete_upload: 400,
  upload_size_mismatch: 400,
  invalid_total_bytes: 400,
  chunk_bytes_required: 400,
  chunked_upload_unavailable: 503,
  upload_staging_failed: 500,
}

function sendMediaError(res: Response, err: unknown): void {
  // Chunked-upload failures go through the SAME funnel as every other media
  // error, so there is one place that decides the error body's shape.
  if (err instanceof UploadSessionError) {
    res.status(UPLOAD_ERROR_STATUS[err.code] ?? 500).json({ error: err.code, ...err.detail })
    return
  }
  if (err instanceof MediaStoreError) {
    res.status(MEDIA_ERROR_STATUS[err.code] ?? 500).json({ error: err.code })
    return
  }
  if (err instanceof ImageSafetyError) {
    const status = SAFETY_ERROR_STATUS[err.code] ?? 500
    res.status(status).json({
      error: err.code,
      ...(err.code === 'media_processing_unavailable' ? { mediaProcessingReady: false } : {}),
    })
    return
  }
  if (err instanceof RichMediaSafetyError) {
    res.status(SAFETY_ERROR_STATUS[err.code] ?? 500).json({ error: err.code, detail: err.message })
    return
  }
  console.error('[media] unexpected error:', err)
  res.status(500).json({ error: 'media_internal_error' })
}

function safeString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : undefined
}

// ── Upload ───────────────────────────────────────────────────────────────────

mediaRouter.post('/media', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {}
    const rawImages = Array.isArray(body.images) ? body.images : []
    if (rawImages.length === 0) {
      res.status(400).json({ error: 'no_images' })
      return
    }
    if (rawImages.length > MAX_ATTACHMENTS_PER_PROMPT) {
      res.status(400).json({ error: 'too_many_images', max: MAX_ATTACHMENTS_PER_PROMPT })
      return
    }
    // Release A: only phone photos enter through this route. Traffic frames
    // and generated visuals arrive via the Release C run-scoped publisher.
    const kind = body.kind === undefined || body.kind === 'user_photo' ? 'user_photo' : null
    if (!kind) {
      res.status(400).json({ error: 'unsupported_kind' })
      return
    }
    if (!(await isMediaProcessingReady())) {
      res.status(503).json({ error: 'media_processing_unavailable', mediaProcessingReady: false })
      return
    }

    // Decode + total-batch gate before any normalization work.
    const decoded: Array<{ bytes: Buffer; label?: string; capturedAt?: string }> = []
    let totalBytes = 0
    for (const raw of rawImages) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const bytes = strictBase64Decode(item.data)
      totalBytes += bytes.length
      if (totalBytes > MAX_BATCH_BYTES) {
        res.status(400).json({ error: 'batch_too_large', maxBytes: MAX_BATCH_BYTES })
        return
      }
      decoded.push({
        bytes,
        label: safeString(item.label, 120),
        capturedAt: safeString(item.capturedAt, 40),
      })
    }

    const sessionId = safeString(body.sessionId, 64)
    const store = getMediaStore()
    const attachments: MediaAttachmentRef[] = []
    for (const img of decoded) {
      attachments.push(await store.ingestImage({
        bytes: img.bytes,
        kind,
        label: img.label,
        capturedAt: img.capturedAt,
        sessionId,
      }))
    }
    res.json({ attachments })
  } catch (err) {
    sendMediaError(res, err)
  }
})

/** One document or video per binary request. The client may issue several
 * bounded requests, but composer admission still owns the shared five-item
 * prompt cap. Filename and MIME are hints only; the store sniffs and validates
 * the actual staged bytes. */
mediaRouter.post('/media/file', async (req: Request, res: Response) => {
  const staged = takeStagedUploadBody(req)
  try {
    if (!staged || staged.bytes === 0) {
      res.status(400).json({ error: 'attachment_bytes_required' })
      return
    }
    const rawLabel = safeString(req.header('x-cos-filename'), 360)
    let label: string | undefined
    if (rawLabel) {
      try { label = decodeURIComponent(rawLabel).slice(0, 120) } catch { label = rawLabel.slice(0, 120) }
    }
    const attachment = await getMediaStore().ingestRichMediaFromFile({
      sourcePath: staged.path,
      byteLength: staged.bytes,
      label,
      declaredMime: safeString(req.header('content-type'), 120),
      capturedAt: safeString(req.header('x-cos-captured-at'), 40),
      sessionId: safeString(req.header('x-cos-session-id'), 64),
    })
    res.json({ attachment })
  } catch (err) {
    sendMediaError(res, err)
  } finally {
    // No-op once ingest moved the file into the asset dir; the guard that
    // matters is the rejected-upload path, which must not leak a staged file.
    staged?.dispose()
  }
})

// ── Chunked upload (contract §2) ──────────────────────────────────────────────
//
// Registered ahead of the GET /media/:id reads below so a future single-segment
// param route can never shadow /media/upload/…. Compression does not unlock
// length — only this does: a 3-minute 4K original is ~570 MB and cannot pass any
// sane single-shot cap.

/** Read the label the same way POST /media/file does. The two paths must agree,
 *  or the same phone video gets a different label depending on its size. */
function uploadLabelFrom(req: Request): string | undefined {
  const rawLabel = safeString(req.header('x-cos-filename'), 360)
  if (!rawLabel) return undefined
  try { return decodeURIComponent(rawLabel).slice(0, 120) } catch { return rawLabel.slice(0, 120) }
}

mediaRouter.post('/media/upload/init', (req: Request, res: Response) => {
  try {
    const body = req.body ?? {}
    const session = getUploadSessions().create({
      totalBytes: body.totalBytes,
      // MIME arrives in the BODY, not Content-Type: this request's Content-Type
      // is application/json. It stays a hint either way — finalize sniffs the
      // assembled bytes.
      mime: safeString(body.mime, 120),
      label: uploadLabelFrom(req),
      capturedAt: safeString(req.header('x-cos-captured-at'), 40),
      sessionId: safeString(req.header('x-cos-session-id'), 64),
    })
    res.json({
      uploadId: session.uploadId,
      chunkBytes: MEDIA_CHUNK_BYTES,
      receivedBytes: session.receivedBytes,
    })
  } catch (err) {
    sendMediaError(res, err)
  }
})

mediaRouter.put('/media/upload/:uploadId/:index', mediaChunkBodyParser, (req: Request, res: Response) => {
  const bytes = takeChunkBody(req)
  try {
    if (!isValidUploadId(req.params.uploadId)) {
      // A malformed id cannot name a session this server minted, so it is the
      // same answer as an expired one — never a partial success (§6).
      throw new UploadSessionError('upload_not_found', 'unknown or expired upload')
    }
    if (bytes === undefined) {
      throw new UploadSessionError('chunk_bytes_required', 'chunk body was not read as raw bytes')
    }
    // Parsed strictly, then compared: a non-numeric segment is definitionally
    // not the expected index, so it answers 409 with the index to send.
    const rawIndex = req.params.index
    const index = typeof rawIndex === 'string' && /^\d{1,9}$/.test(rawIndex)
      ? Number(rawIndex)
      : Number.NaN
    const session = getUploadSessions().appendChunk(req.params.uploadId, index, bytes)
    res.json({ receivedBytes: session.receivedBytes, nextIndex: session.nextIndex })
  } catch (err) {
    sendMediaError(res, err)
  }
})

mediaRouter.get('/media/upload/:uploadId', (req: Request, res: Response) => {
  const sessions = getUploadSessions()
  const session = isValidUploadId(req.params.uploadId)
    ? sessions.peek(req.params.uploadId)
    : undefined
  if (!session) {
    res.status(404).json({ error: 'upload_not_found' })
    return
  }
  res.json(sessions.progressOf(session))
})

/**
 * Abandon an upload and release its resources NOW.
 *
 * WHY THIS EXISTS. Without it an abandoned session held one of only
 * MAX_CONCURRENT_CHUNKED_UPLOADS (8) slots plus up to chunkedMaxBytes of tmp/ for the
 * full 4-hour TTL, with no way to release it early. The client's recovery ladder fires
 * on a flaky phone link BY DESIGN, so give-ups are expected traffic rather than an edge
 * case: eight of them in one bad session — plausible on a large file — then made init
 * answer 503 for up to four hours, with the user seeing a feature that simply stopped
 * working and no way to clear it.
 *
 * IDEMPOTENT BY CONSTRUCTION. An unknown, already-cancelled, or expired id answers 200,
 * not 404. The client calls this best-effort while giving up on something that already
 * failed; making it fail again would invite a retry loop over a request whose only job
 * is to release resources. `dropped` reports whether this call was the one that freed
 * it, for logs — never as a signal the client must act on.
 *
 * A malformed id is still 400: that is a client bug worth surfacing, not a resource to
 * release.
 */
mediaRouter.delete('/media/upload/:uploadId', (req: Request, res: Response) => {
  if (!isValidUploadId(req.params.uploadId)) {
    res.status(400).json({ error: 'invalid_upload_id' })
    return
  }
  // drop() forgets the session AND disposes its staging file, so the slot and the disk
  // are both released here rather than waiting on the TTL sweep.
  const dropped = getUploadSessions().drop(req.params.uploadId)
  res.json({ ok: true, dropped })
})

mediaRouter.post('/media/upload/:uploadId/finalize', async (req: Request, res: Response) => {
  let claimed: { stagingPath: string; dispose: () => void } | null = null
  try {
    if (!isValidUploadId(req.params.uploadId)) {
      throw new UploadSessionError('upload_not_found', 'unknown or expired upload')
    }
    // Throws `incomplete_upload` WITHOUT consuming the session, so a client that
    // finalized early can keep sending chunks. Anything it returns is a session
    // this request now owns.
    const session = getUploadSessions().finalize(req.params.uploadId)
    claimed = session
    // The SAME ingest as POST /media/file — validation, the per-kind cap from
    // magic bytes, the atomic rename, and compression scheduling all stay in one
    // place. A second ingest path would be a second place for those to rot.
    const attachment = await getMediaStore().ingestRichMediaFromFile({
      sourcePath: session.stagingPath,
      byteLength: session.totalBytes,
      label: session.label,
      declaredMime: session.mime,
      capturedAt: session.capturedAt,
      sessionId: session.sessionId,
      // The one line that makes chunked upload actually work. Without it this
      // inherits the SINGLE-SHOT per-kind cap, so every chunked video transferred
      // in full and was then refused at finalize with a raw 413 — strictly worse
      // than the pre-flight refusal it replaced. Only video gets the chunked
      // ceiling; documents stay at the single-shot cap, because the text path reads
      // the whole file into a Buffer and a JS string.
      transfer: 'chunked',
    })
    res.json({ attachment })
  } catch (err) {
    sendMediaError(res, err)
  } finally {
    // No-op once ingest moved the file into the asset dir. The case that matters
    // is a REJECTED assembly (unsupported format, over the per-kind cap): ingest
    // is atomic, so nothing is half-published, and this is what stops the
    // assembled body leaking in tmp/.
    claimed?.dispose()
  }
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

mediaRouter.post('/media/reserve', async (req: Request, res: Response) => {
  try {
    const ids = parseMediaIdList(req.body?.ids)
    const clientQueueItemId = safeString(req.body?.clientQueueItemId, 120)
    if (ids.length === 0 || !clientQueueItemId) {
      res.status(400).json({ error: 'ids_and_client_queue_item_id_required' })
      return
    }
    const attachments = await getMediaStore().reserve(ids, {
      clientQueueItemId,
      sessionId: safeString(req.body?.sessionId, 64),
    })
    res.json({ ok: true, attachments })
  } catch (err) {
    sendMediaError(res, err)
  }
})

mediaRouter.post('/media/associate', async (req: Request, res: Response) => {
  try {
    const ids = parseMediaIdList(req.body?.ids)
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids_required' })
      return
    }
    const globalMsgNum = typeof req.body?.globalMsgNum === 'number' && req.body.globalMsgNum > 0
      ? Math.floor(req.body.globalMsgNum) : undefined
    await getMediaStore().associate(ids, {
      sessionId: safeString(req.body?.sessionId, 64),
      runId: safeString(req.body?.runId, 120),
      globalMsgNum,
      // Association always belongs to the server's active message era. Never
      // trust a client-supplied era to make media visible in historical turns.
      messageEra: currentMessageEra(),
    })
    res.json({ ok: true })
  } catch (err) {
    sendMediaError(res, err)
  }
})

mediaRouter.post('/media/release', async (req: Request, res: Response) => {
  try {
    const ids = parseMediaIdList(req.body?.ids)
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids_required' })
      return
    }
    await getMediaStore().release(ids, {
      sessionId: safeString(req.body?.sessionId, 64),
      clientQueueItemId: safeString(req.body?.clientQueueItemId, 120),
    })
    res.json({ ok: true })
  } catch (err) {
    sendMediaError(res, err)
  }
})

// ── Reads ────────────────────────────────────────────────────────────────────

mediaRouter.get('/media/:id', (req: Request, res: Response) => {
  const id = req.params.id
  if (!isValidMediaId(id)) {
    res.status(400).json({ error: 'invalid_media_id' })
    return
  }
  const store = getMediaStore()
  const rec = store.getRecord(id)
  if (!rec || rec.lifecycle === 'deleted') {
    res.status(404).json({ error: 'media_not_found' })
    return
  }
  const content = store.getContent(id, 'phone')
  res.json({
    attachment: rec.ref,
    contentAvailable: content.status === 'ok',
    ...(content.status === 'expired' ? { expired: true } : {}),
  })
})

mediaRouter.get('/media/:id/content', async (req: Request, res: Response) => {
  const id = req.params.id
  if (!isValidMediaId(id)) {
    res.status(400).json({ error: 'invalid_media_id' })
    return
  }
  // 'g2' (Release B) — exact 288x144 grayscale PNG for the lens, generated
  // lazily and cached beside the asset.
  const variant = req.query.variant === 'thumb' ? 'thumb' : req.query.variant === 'g2' ? 'g2' : 'phone'
  const content = variant === 'g2'
    ? await getMediaStore().getG2Content(id)
    : getMediaStore().getContent(id, variant)
  if (content.status === 'not_found') {
    res.status(404).json({ error: 'media_not_found' })
    return
  }
  if (content.status === 'expired') {
    res.status(410).json({ error: 'media_expired' })
    return
  }
  if (content.status === 'unavailable') {
    res.status(503).json({ error: 'media_unavailable' })
    return
  }
  try {
    // STREAMED, not buffered (2026-08-11). This was readFileSync + res.end(bytes),
    // which allocated the entire asset per request. The UPLOAD path was rewritten
    // specifically to stop holding a video in memory, and raising the video cap to
    // 100 MiB silently raised THIS route's peak allocation from 64 MiB to 100 MiB per
    // concurrent download — the same defect, on the way out.
    //
    // Content-Length comes from statSync, NOT rec.bytes: background compression
    // rewrites this file in place, so the record's size and the file's size can
    // disagree in the window between the rename and the index update. A wrong
    // Content-Length truncates or hangs the client, so the only safe source is the
    // file actually being sent.
    const size = statSync(content.path).size
    res.status(200)
    res.setHeader('Content-Type', content.mime)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (variant === 'g2') {
      res.setHeader('X-COS-G2-Variant', G2_LENS_VARIANT_CAPABILITY)
      // Even Hub loads the app from a different origin. Without an expose
      // header, browser fetch can receive this value but cannot read it.
      res.setHeader('Access-Control-Expose-Headers', 'X-COS-G2-Variant')
    }
    res.setHeader('Content-Length', String(size))

    const stream = createReadStream(content.path)
    // Once bytes are on the wire the status line is spent, so a failure here CANNOT
    // become a JSON error body — appending one would corrupt a partial asset.
    // Destroy the socket instead: a truncated response is an unambiguous failure to
    // the client, a silently corrupted one is not.
    stream.on('error', (streamErr) => {
      console.error(`[media] content stream failed: ${streamErr instanceof Error ? streamErr.message : streamErr}`)
      res.destroy()
    })
    // Client hung up mid-download: stop reading rather than pumping a dead socket.
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch (err) {
    // statSync/open failures land here, BEFORE any byte is written, so a structured
    // error response is still legal.
    sendMediaError(res, err)
  }
})

mediaRouter.delete('/media/:id', async (req: Request, res: Response) => {
  const id = req.params.id
  if (!isValidMediaId(id)) {
    res.status(400).json({ error: 'invalid_media_id' })
    return
  }
  try {
    const deleted = await getMediaStore().deleteUnassociated(id)
    if (!deleted) {
      res.status(404).json({ error: 'media_not_found' })
      return
    }
    res.json({ deleted: true })
  } catch (err) {
    sendMediaError(res, err)
  }
})
