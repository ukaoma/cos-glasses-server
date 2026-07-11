// Media attachment API (Release A) — authenticated upload, lifecycle, and
// content endpoints backed by server/lib/media-store.ts.
//
//   POST   /api/media                 — upload images (base64 JSON batch)
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

import { Router, json, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
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
} from '../lib/media-store.js'
import {
  ImageSafetyError,
  MAX_BATCH_BYTES,
  isMediaProcessingReady,
  strictBase64Decode,
} from '../lib/image-safety.js'

// Route-scoped parser: 16 MB covers the max valid batch after base64 + JSON
// overhead. Mounted only for /api/media in server/index.ts — the global
// server limit is unchanged.
export const mediaBodyParser = json({ limit: '16mb' })

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
}

function sendMediaError(res: Response, err: unknown): void {
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
    // Read + send the buffer directly: content-length is exact and no
    // filesystem path semantics leak into the response.
    const bytes = readFileSync(content.path)
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
    res.setHeader('Content-Length', String(bytes.length))
    res.end(bytes)
  } catch (err) {
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
