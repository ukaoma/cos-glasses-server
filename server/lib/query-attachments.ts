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
  mediaCategoryOf,
  parseMediaIdList,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import { getMediaStore, MediaStoreError } from './media-store.js'
import { VIDEO_SUMMARY_FRAMES_MAX } from './rich-media-safety.js'
import { strictBase64Decode, ImageSafetyError } from './image-safety.js'
import type { ModelImageInput } from './model-image-input.js'
import { formatAttachmentSourceData, type AttachmentSourceData } from './prompt-reference-boundary.js'

export interface ResolvedQueryAttachments {
  inputs: ModelImageInput[]
  refs: MediaAttachmentRef[]
  /** Ids to associate with the final message when the run completes. */
  ids: string[]
  /** Provider-neutral quoted document data. Rebuilt at execution time; never
   * persisted in a durable job or public attachment ref. */
  promptBlock?: string
}

/**
 * Image inputs one prompt may carry.
 *
 * This MUST be at least VIDEO_SUMMARY_FRAMES_MAX, because a video contributes one
 * input per extracted frame with no clamp (see the video branch below) and exceeding
 * this throws a hard 400. It sat at 12 while frames went to 16 in 6.27.0, so every
 * video of 75 seconds or longer uploaded successfully, stored its frames, and then
 * failed the instant the user asked a question about it:
 *
 *   Math.round(75 / 6) = 13 frames > 12  ->  400 too_many_attachment_frames
 *
 * Frames are a video's ONLY visual representation, unlike PDF page images which are
 * an optional aid over canonical text — so this ceiling cannot be treated as a
 * budget to trim silently. It has to fit a whole video.
 */
const MAX_MODEL_IMAGE_INPUTS = VIDEO_SUMMARY_FRAMES_MAX
const MAX_ATTACHMENT_PROMPT_CHARS = 60_000

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
    const refs: MediaAttachmentRef[] = []
    const resolvedIds: string[] = []
    const sourceData: AttachmentSourceData[] = []
    const optionalDocumentImages: Array<{ path: string; attachment: MediaAttachmentRef }> = []
    let promptChars = 0

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
      const resolved = store.resolveModelDerivatives(id, clientQueueItemId)
      const category = mediaCategoryOf(resolved.record.ref)
      refs.push(resolved.record.ref)
      resolvedIds.push(id)
      if (category === 'image') {
        inputs.push({ path: resolved.originalPath, attachment: resolved.record.ref, deleteAfterRun: false })
      } else if (category === 'video') {
        for (const path of resolved.imagePaths) {
          inputs.push({ path, attachment: resolved.record.ref, deleteAfterRun: false })
        }
      } else {
        // PDF page images are an optional layout aid. Text remains canonical;
        // use only the remaining image budget instead of dropping user photos
        // or making a text-readable PDF fail because it has many pages.
        for (const path of resolved.imagePaths) optionalDocumentImages.push({ path, attachment: resolved.record.ref })
        if (resolved.text !== undefined) {
          const room = Math.max(0, MAX_ATTACHMENT_PROMPT_CHARS - promptChars)
          const content = resolved.text.slice(0, room)
          const truncated = content.length < resolved.text.length || resolved.record.ref.truncated === true
          sourceData.push({
            id,
            label: resolved.record.ref.label ?? 'Attached document',
            mime: resolved.record.ref.mime,
            content,
            ...(truncated ? { truncated: true } : {}),
          })
          promptChars += content.length
        }
      }
    }
    const requiredVisualCount = inputs.filter(input => mediaCategoryOf(input.attachment) !== 'document').length
    if (requiredVisualCount > MAX_MODEL_IMAGE_INPUTS) {
      throw new QueryAttachmentError(400, 'too_many_attachment_frames', `max ${MAX_MODEL_IMAGE_INPUTS} image/video frames per prompt`)
    }

    // 2. Legacy base64 — ingested through the SAME store (no bypass).
    for (const raw of legacyRaw) {
      if (typeof raw !== 'string' || raw.length === 0) continue
      const bytes = strictBase64Decode(raw)
      const ref = await store.ingestImage({ bytes, kind: 'user_photo', sessionId })
      const { path } = store.resolveUsable(ref.id)
      inputs.push({ path, attachment: ref, deleteAfterRun: false })
      refs.push(ref)
      resolvedIds.push(ref.id)
    }

    // PDF page renders are optional aids. Add them only after all required
    // photo and video inputs so a PDF can never evict a user's visual source.
    const remaining = Math.max(0, MAX_MODEL_IMAGE_INPUTS - inputs.length)
    for (const item of optionalDocumentImages.slice(0, remaining)) {
      inputs.push({ path: item.path, attachment: item.attachment, deleteAfterRun: false })
    }

    if (inputs.length > MAX_MODEL_IMAGE_INPUTS) {
      throw new QueryAttachmentError(400, 'too_many_attachment_frames', `max ${MAX_MODEL_IMAGE_INPUTS} image/video frames per prompt`)
    }

    return {
      inputs,
      refs,
      ids: resolvedIds,
      ...(sourceData.length > 0 ? { promptBlock: formatAttachmentSourceData(sourceData) } : {}),
    }
  } catch (err) {
    if (err instanceof QueryAttachmentError) throw err
    throw asQueryAttachmentError(err)
  }
}
