/**
 * 6.99.13, Drop it with files: a drop's files live in the media store, the same store an Ask's files use.
 *
 * The web composer uploads first (POST /api/media for a photo, POST /api/media/file for anything else), which leaves a
 * `staged` record that the store expires after STAGED_TTL_MS (4 hours). A drop pins its uploads (MediaStore.pinForDrop):
 * the record becomes `associated` with the drop's id, which no TTL and no GC pass touches, so the bytes stay under
 * data/media/assets/<id>/ for as long as the drop holds them, and open through GET /api/media/:id/content like any
 * Ask's files. Undo removes them (MediaStore.unpinDrop). Nothing is copied and nothing leaves the server's data dir.
 *
 * Errors become DropErrors whose words say what happened and what to do.
 */
import { MediaStoreError, type MediaStore } from './media-store.js'
import { DropError, type DropAttachmentPins } from './drop-service.js'
import { DROP_LIMITS, type DropAttachment } from './drop-store.js'
import { mediaCategoryOf, type MediaAttachmentRef } from '../../shared/media-attachment.js'

const REFUSALS: Record<string, { code: string; status: number; message: string }> = {
  media_not_found: { code: 'attachment_not_found', status: 404, message: 'A file is no longer on this Mac. Add it again, then Drop.' },
  media_deleted: { code: 'attachment_not_found', status: 404, message: 'A file is no longer on this Mac. Add it again, then Drop.' },
  media_expired: { code: 'attachment_expired', status: 410, message: 'A file expired before it was dropped (uploads wait 4 hours). Add it again, then Drop.' },
  media_conflict: { code: 'attachment_in_use', status: 409, message: 'A file was already sent with something else. Add it again to drop it.' },
  media_unavailable: { code: 'attachment_unavailable', status: 503, message: 'This Mac could not read a file. Add it again, then Drop.' },
}

/** The name a person sees for a file: its own label, else what kind it is. Control characters never reach the store. */
export function attachmentName(ref: MediaAttachmentRef): string {
  const label = (ref.label ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DROP_LIMITS.attachmentName)
  if (label) return label
  const category = mediaCategoryOf(ref)
  return category === 'image' ? 'Photo' : category === 'video' ? 'Video' : 'File'
}

/** `bytes` is the stored size (a photo's public ref carries none); the ref's own count when the record has none. */
export function toDropAttachment(ref: MediaAttachmentRef, bytes?: number): DropAttachment {
  const size = [bytes, ref.bytes].find(n => Number.isSafeInteger(n) && (n as number) > 0) ?? 0
  return { id: ref.id, name: attachmentName(ref), mime: ref.mime, size }
}

export function mediaDropAttachments(store: () => MediaStore): DropAttachmentPins {
  return {
    async pin(ids, dropId) {
      try {
        const media = store()
        return (await media.pinForDrop(ids, dropId)).map(ref => toDropAttachment(ref, media.getRecord(ref.id)?.bytes))
      } catch (e) {
        const refusal = e instanceof MediaStoreError ? REFUSALS[e.code] : undefined
        if (refusal) throw new DropError(refusal.code, refusal.status, refusal.message)
        throw new DropError('attachment_unavailable', 503, REFUSALS.media_unavailable.message)
      }
    },
    async unpin(ids, dropId) {
      return store().unpinDrop(ids, dropId)
    },
  }
}
