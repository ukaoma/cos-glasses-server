// Media attachment contract — the ONE shape both the browser client and the
// server exchange for image attachments (Release A of the image-attachments
// plan). The public ref deliberately carries NO storage path, URL, token,
// base64, checksum, or internal lifecycle state — those live only in the
// server media index. Anything that persists or transmits an attachment
// persists THIS shape (or just the id) and nothing else.

export type MediaKind = 'user_photo' | 'traffic_frame' | 'generated_visual'

export type MediaMime = 'image/jpeg' | 'image/png'

export interface MediaAttachmentRef {
  id: string
  kind: MediaKind
  mime: MediaMime
  width: number
  height: number
  createdAt: string
  label?: string
  capturedAt?: string
  expiresAt?: string
}

/** Hard cap on attachments per prompt — mirrored by upload validation,
 *  query resolution, and the phone composer. */
export const MAX_ATTACHMENTS_PER_PROMPT = 5

// ── Media IDs ────────────────────────────────────────────────────────────────
// One strict generated format, one strict validator. The id builds filesystem
// paths on the server, so the validator rejects anything that isn't exactly
// `m_` + 24 lowercase hex chars — no path characters can ever pass.

export const MEDIA_ID_RE = /^m_[a-f0-9]{24}$/

export function isValidMediaId(id: unknown): id is string {
  return typeof id === 'string' && MEDIA_ID_RE.test(id)
}

const VALID_KINDS: ReadonlySet<string> = new Set(['user_photo', 'traffic_frame', 'generated_visual'])
const VALID_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png'])
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
  const ref: MediaAttachmentRef = {
    id: r.id,
    kind: r.kind as MediaKind,
    mime: r.mime as MediaMime,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
  }
  if (typeof r.label === 'string' && r.label.length > 0) {
    ref.label = r.label.slice(0, MAX_LABEL_LEN)
  }
  if (isIsoTimestamp(r.capturedAt)) ref.capturedAt = r.capturedAt
  if (isIsoTimestamp(r.expiresAt)) ref.expiresAt = r.expiresAt
  return ref
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
