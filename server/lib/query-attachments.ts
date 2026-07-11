// Query-side attachment resolution (Release A). Converts an /api/query
// request body's image inputs into ModelImageInput[]:
//
//   attachmentIds[]   — durable media-store assets uploaded via /api/media.
//                       Validated against lifecycle + the reservation's
//                       clientQueueItemId (an id alone is never bearer auth).
//   images[]/image    — legacy base64. NOT a bypass: bytes are ingested
//                       through the same media store (validation,
//                       normalization, lifecycle tracking, limits) and then
//                       resolved exactly like uploaded attachments.
//
// Every resolved input is durable (deleteAfterRun: false) — the store's
// retention owns the files; model runs never delete them.

import {
  MAX_ATTACHMENTS_PER_PROMPT,
  isValidMediaId,
  parseMediaIdList,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import { getMediaStore, MediaStoreError } from './media-store.js'
import { strictBase64Decode, ImageSafetyError } from './image-safety.js'
import type { ModelImageInput } from './model-image-input.js'

export interface ResolvedQueryAttachments {
  inputs: ModelImageInput[]
  refs: MediaAttachmentRef[]
  /** Ids to associate with the final message when the run completes. */
  ids: string[]
}

export class QueryAttachmentError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'QueryAttachmentError'
  }
}

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

function asQueryAttachmentError(err: unknown): QueryAttachmentError {
  if (err instanceof MediaStoreError) {
    return new QueryAttachmentError(MEDIA_ERROR_STATUS[err.code] ?? 500, err.code, err.message)
  }
  if (err instanceof ImageSafetyError) {
    return new QueryAttachmentError(SAFETY_ERROR_STATUS[err.code] ?? 500, err.code, err.message)
  }
  return new QueryAttachmentError(500, 'attachment_resolution_failed', err instanceof Error ? err.message : String(err))
}

export interface QueryImageBody {
  attachmentIds?: unknown
  clientQueueItemId?: unknown
  images?: unknown
  image?: unknown
  sessionId?: unknown
}

/** Resolve all image inputs for one query. Throws QueryAttachmentError with
 *  an HTTP status + typed code — callers respond BEFORE opening the SSE
 *  stream. Returns empty inputs when the request carries no images. */
export async function resolveQueryAttachments(body: QueryImageBody): Promise<ResolvedQueryAttachments> {
  try {
    const store = getMediaStore()
    const clientQueueItemId = typeof body.clientQueueItemId === 'string' && body.clientQueueItemId.trim()
      ? body.clientQueueItemId.trim().slice(0, 120)
      : undefined
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim().slice(0, 64)
      : undefined

    const inputs: ModelImageInput[] = []

    // Reject over-limit requests BEFORE the shared parser caps them. Silent
    // truncation would run a successful vision query while dropping a user's
    // sixth image, which is materially worse than a typed 400.
    const validUniqueIds = Array.isArray(body.attachmentIds)
      ? [...new Set(body.attachmentIds.filter(isValidMediaId))]
      : []
    const legacyRaw: unknown[] = Array.isArray(body.images)
      ? body.images
      : typeof body.image === 'string' && body.image.length > 0 ? [body.image] : []
    const validLegacyCount = legacyRaw.filter((raw) => typeof raw === 'string' && raw.length > 0).length
    if (validUniqueIds.length + validLegacyCount > MAX_ATTACHMENTS_PER_PROMPT) {
      throw new QueryAttachmentError(400, 'too_many_images', `max ${MAX_ATTACHMENTS_PER_PROMPT} images per prompt`)
    }

    // 1. Durable attachment ids.
    const ids = parseMediaIdList(body.attachmentIds)
    for (const id of ids) {
      const { record, path } = store.resolveUsable(id, clientQueueItemId)
      inputs.push({ path, attachment: record.ref, deleteAfterRun: false })
    }

    // 2. Legacy base64 — ingested through the SAME store (no bypass).
    for (const raw of legacyRaw) {
      if (typeof raw !== 'string' || raw.length === 0) continue
      const bytes = strictBase64Decode(raw)
      const ref = await store.ingestImage({ bytes, kind: 'user_photo', sessionId })
      const { path } = store.resolveUsable(ref.id)
      inputs.push({ path, attachment: ref, deleteAfterRun: false })
    }

    return {
      inputs,
      refs: inputs.map((i) => i.attachment),
      ids: inputs.map((i) => i.attachment.id),
    }
  } catch (err) {
    if (err instanceof QueryAttachmentError) throw err
    throw asQueryAttachmentError(err)
  }
}
