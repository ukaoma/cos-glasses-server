// Media attachment contract — the ONE shape both the browser client and the
// server exchange for image attachments (Release A of the image-attachments
// plan). The public ref deliberately carries NO storage path, URL, token,
// base64, checksum, or internal lifecycle state — those live only in the
// server media index. Anything that persists or transmits an attachment
// persists THIS shape (or just the id) and nothing else.

export type MediaKind = 'user_photo' | 'user_document' | 'user_video' | 'traffic_frame' | 'generated_visual'

export type MediaCategory = 'image' | 'document' | 'video'

export type MediaMime =
  | 'image/jpeg'
  | 'image/png'
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/json'
  | 'application/pdf'
  | 'video/mp4'
  | 'video/quicktime'

export interface MediaAttachmentRef {
  id: string
  kind: MediaKind
  mime: MediaMime
  width: number
  height: number
  createdAt: string
  /** Additive discriminator. Legacy image refs deliberately omit it so
   * durable request fingerprints remain byte-compatible. */
  category?: MediaCategory
  bytes?: number
  durationMs?: number
  frameCount?: number
  textChars?: number
  truncated?: boolean
  label?: string
  capturedAt?: string
  expiresAt?: string
}

/** Hard cap on attachments per prompt — mirrored by upload validation,
 *  query resolution, and the phone composer. */
export const MAX_ATTACHMENTS_PER_PROMPT = 5

/**
 * Sanity bounds for the PARSER, not policy.
 *
 * `parseMediaAttachmentRef` is a whitelist that drops any field failing its
 * bound, and every field here is optional — so a value the writer sets correctly
 * and the parser rejects vanishes with no error anywhere. That is not theoretical:
 * both of these were live defects found 2026-08-11.
 *
 *   - `bytes` was hardcoded `64 * 1024 * 1024` while the server had already moved
 *     the video ceiling to 100 MiB and chunked uploads to 2 GiB, so every video
 *     over 64 MiB silently lost its byte count.
 *   - `frameCount` was hardcoded `8` while VIDEO_SUMMARY_FRAMES_MAX went to 16, so
 *     every video over ~90 seconds silently lost its frame count.
 *
 * These are deliberately GENEROUS: their job is to reject garbage from outside,
 * while the real limits are enforced at ingest (rich-media-safety.ts) and
 * advertised on /api/health. A parser bound that doubles as policy is how the
 * policy ends up in two places and drifts.
 *
 * `shared/` must not import from `server/`, so these mirror the server ceilings
 * and are pinned to them by media-attachment-bounds.test.ts — the same pattern as
 * ADVERTISED_VIDEO_COMPRESSION_LABEL. Change one, the test fails.
 */
export const MAX_PLAUSIBLE_MEDIA_BYTES = 2 * 1024 * 1024 * 1024  // mirrors MAX_CHUNKED_MEDIA_BYTES
export const MAX_PARSED_VIDEO_FRAMES = 16                        // mirrors VIDEO_SUMMARY_FRAMES_MAX
export const MAX_PARSED_DURATION_MS = 24 * 60 * 60_000           // a day; ingest enforces the real cap

// ── Media IDs ────────────────────────────────────────────────────────────────
// One strict generated format, one strict validator. The id builds filesystem
// paths on the server, so the validator rejects anything that isn't exactly
// `m_` + 24 lowercase hex chars — no path characters can ever pass.

export const MEDIA_ID_RE = /^m_[a-f0-9]{24}$/

export function isValidMediaId(id: unknown): id is string {
  return typeof id === 'string' && MEDIA_ID_RE.test(id)
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  'user_photo', 'user_document', 'user_video', 'traffic_frame', 'generated_visual',
])
const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png'])
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf',
])
const VIDEO_MIMES: ReadonlySet<string> = new Set(['video/mp4', 'video/quicktime'])
const VALID_MIMES: ReadonlySet<string> = new Set([...IMAGE_MIMES, ...DOCUMENT_MIMES, ...VIDEO_MIMES])
const MAX_LABEL_LEN = 120
// ISO-8601 subset — what `new Date().toISOString()` emits.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(new Date(v).getTime())
}

function isDimension(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65_535
}

/** Validate an UNTRUSTED value into a MediaAttachmentRef, or null.
 *  TypeScript types alone are not validation — every persistence and API
 *  boundary that accepts a ref from outside must run it through here.
 *  Returns a fresh object containing only the known fields (drops extras). */
export function parseMediaAttachmentRef(raw: unknown): MediaAttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isValidMediaId(r.id)) return null
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return null
  if (typeof r.mime !== 'string' || !VALID_MIMES.has(r.mime)) return null
  if (!isDimension(r.width) || !isDimension(r.height)) return null
  if (!isIsoTimestamp(r.createdAt)) return null
  const inferredCategory = r.kind === 'user_document'
    ? 'document'
    : r.kind === 'user_video'
      ? 'video'
      : 'image'
  if ((inferredCategory === 'image' && !IMAGE_MIMES.has(r.mime))
    || (inferredCategory === 'document' && !DOCUMENT_MIMES.has(r.mime))
    || (inferredCategory === 'video' && !VIDEO_MIMES.has(r.mime))) return null
  if (r.category !== undefined && r.category !== inferredCategory) return null
  const ref: MediaAttachmentRef = {
    id: r.id,
    kind: r.kind as MediaKind,
    mime: r.mime as MediaMime,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
  }
  // Do not add category to legacy image refs that never carried it. Their
  // canonical JSON is part of persisted durable-query fingerprints.
  if (r.category === inferredCategory) ref.category = inferredCategory
  if (typeof r.bytes === 'number' && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= MAX_PLAUSIBLE_MEDIA_BYTES) {
    ref.bytes = r.bytes
  }
  if (typeof r.durationMs === 'number' && Number.isSafeInteger(r.durationMs) && r.durationMs >= 0 && r.durationMs <= MAX_PARSED_DURATION_MS) {
    ref.durationMs = r.durationMs
  }
  if (typeof r.frameCount === 'number' && Number.isSafeInteger(r.frameCount) && r.frameCount >= 0 && r.frameCount <= MAX_PARSED_VIDEO_FRAMES) {
    ref.frameCount = r.frameCount
  }
  if (typeof r.textChars === 'number' && Number.isSafeInteger(r.textChars) && r.textChars >= 0 && r.textChars <= 100_000) {
    ref.textChars = r.textChars
  }
  if (r.truncated === true) ref.truncated = true
  if (typeof r.label === 'string' && r.label.length > 0) {
    ref.label = r.label.slice(0, MAX_LABEL_LEN)
  }
  if (isIsoTimestamp(r.capturedAt)) ref.capturedAt = r.capturedAt
  if (isIsoTimestamp(r.expiresAt)) ref.expiresAt = r.expiresAt
  return ref
}

export function mediaCategoryOf(ref: Pick<MediaAttachmentRef, 'kind' | 'category'>): MediaCategory {
  if (ref.category) return ref.category
  if (ref.kind === 'user_document') return 'document'
  if (ref.kind === 'user_video') return 'video'
  return 'image'
}

export function isImageAttachmentRef(ref: MediaAttachmentRef): boolean {
  return mediaCategoryOf(ref) === 'image'
}

export function attachmentHistoryPrefix(refs: readonly MediaAttachmentRef[]): string {
  if (refs.length === 0) return ''
  if (refs.length > 1) return `[${refs.length} Attachments]`
  const category = mediaCategoryOf(refs[0])
  return category === 'image' ? '[Photo]' : category === 'video' ? '[Video]' : '[File]'
}

export function defaultAttachmentRequest(refs: readonly MediaAttachmentRef[]): string {
  if (refs.length === 0) return ''
  const categories = new Set(refs.map(mediaCategoryOf))
  if (categories.size > 1 || refs.length > 1) return 'Review these attachments.'
  return categories.has('document')
    ? 'Summarize this file.'
    : categories.has('video')
      ? 'Review this video.'
      : 'What do you see?'
}

/** Validate an untrusted array of refs, dropping only the invalid entries
 *  (a bad ref must never take the whole conversation record with it). */
export function parseMediaAttachmentRefs(raw: unknown): MediaAttachmentRef[] {
  if (!Array.isArray(raw)) return []
  const out: MediaAttachmentRef[] = []
  for (const item of raw) {
    const ref = parseMediaAttachmentRef(item)
    if (ref) out.push(ref)
    if (out.length >= MAX_ATTACHMENTS_PER_PROMPT) break
  }
  return out
}

/** Validate, merge, and de-duplicate attachment refs from multiple untrusted
 *  exchange surfaces. A completed Q&A pair can carry request refs on the user
 *  turn and generated/research refs on the assistant turn; readers should see
 *  one bounded list without trusting either persisted shape. First occurrence
 *  wins so the request-side ref remains stable when the server echoes it back
 *  in completion metadata. */
export function mergeMediaAttachmentRefs(...sources: unknown[]): MediaAttachmentRef[] {
  const out: MediaAttachmentRef[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      const ref = parseMediaAttachmentRef(item)
      if (!ref || seen.has(ref.id)) continue
      seen.add(ref.id)
      out.push(ref)
      if (out.length >= MAX_ATTACHMENTS_PER_PROMPT) return out
    }
  }
  return out
}

/** Validate an untrusted list of media IDs (dedup, cap, strict format). */
export function parseMediaIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (!isValidMediaId(item) || out.includes(item)) continue
    out.push(item)
    if (out.length >= MAX_ATTACHMENTS_PER_PROMPT) break
  }
  return out
}
