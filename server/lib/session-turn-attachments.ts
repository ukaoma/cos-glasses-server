// Files with a turn into a Claude or Codex session on this Mac (Miles, 2026-11-07: "Sometimes I need to pass context
// via a screenshot, photo or file").
//
// A session turn is words on the provider's stdin: there is no attachment slot in `claude -p --resume` or
// `codex exec resume`, and both agents read local files with their own tools. So a turn carries `attachmentIds`
// (media-store ids from the same POST /api/media and /api/media/file every web upload uses), and the SERVER writes
// where each file is on this Mac under the words. The browser never sees a path: the ids are opaque, and the block is
// added on the Mac, at the turns route, right before delivery.
//
// What this is not: a second upload path, or a way to read any file. An id resolves only through the media store's own
// lifecycle check (resolveUsable: deleted, expired and reserved-by-another all refuse), and the path is the store's own.
//
// Absent `attachmentIds` is the old turn, byte for byte: nothing is resolved and the prompt is untouched.

import {
  MAX_ATTACHMENTS_PER_PROMPT,
  isValidMediaId,
  mediaCategoryOf,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import { getMediaStore, MediaStoreError } from './media-store.js'
import { getTurnFileStore } from './turn-file-store.js'

/** What the turns route needs from the media store. The real store satisfies it; tests pass a fake. */
export interface TurnAttachmentStore {
  resolveUsable(id: string, clientQueueItemId?: string): { record: { ref: MediaAttachmentRef }; path: string }
  /** Moves staged media out of the 4 hour unsubmitted TTL, so a file the session may read again later stays. */
  associate(ids: string[], target: { runId?: string }): Promise<void>
}

/**
 * The store a turn reads by default: the media store first, then (6.99.27) the turn files a session upload kept when
 * the media store could not read their format (lib/turn-file-store.ts). An id lives in at most one of them.
 */
export function defaultTurnAttachmentStore(): TurnAttachmentStore {
  const media = getMediaStore(), files = getTurnFileStore()
  return {
    resolveUsable(id) {
      try {
        return media.resolveUsable(id)
      } catch (error) {
        if (error instanceof MediaStoreError && error.code === 'media_not_found' && files.has(id)) return files.resolveUsable(id)
        throw error
      }
    },
    async associate(ids, target) {
      const mine = ids.filter(id => files.has(id))
      const rest = ids.filter(id => !mine.includes(id))
      if (rest.length) await media.associate(rest, target)
      if (mine.length) await files.associate(mine, target)
    },
  }
}

export type TurnAttachmentIds = { ok: true; ids: string[] } | { ok: false }

/**
 * The body's `attachmentIds`. Absent (or null) is no files. Anything else must be an array of at most five valid,
 * distinct media ids; a sixth, a bad id or a duplicate refuses the whole turn rather than dropping a file in silence
 * (query-attachments.ts holds the same rule for Asks).
 */
export function parseTurnAttachmentIds(raw: unknown): TurnAttachmentIds {
  if (raw === undefined || raw === null) return { ok: true, ids: [] }
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_PROMPT) return { ok: false }
  const ids: string[] = []
  for (const id of raw) {
    if (!isValidMediaId(id) || ids.includes(id)) return { ok: false }
    ids.push(id)
  }
  return { ok: true, ids }
}

/** The heading the agent reads. Stable, so a transcript can be matched against what was sent. */
export const TURN_ATTACHMENTS_HEADING = '[Files attached from COS Control. They are on this Mac; open each with your file tools.]'

function oneLine(s: string, max: number): string {
  // A filename is the user's, never the prompt's structure: no line breaks, no control characters.
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function sizeWords(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** One line per file: what it is, its name, and where it is. */
export function turnAttachmentLine(ref: MediaAttachmentRef, path: string): string {
  // A turn file (lib/turn-file-store.ts) carries category 'file' and the type the browser declared: a photo sent as it
  // was taken (a HEIC, a full-size PNG) is still called a photo.
  const category = mediaCategoryOf(ref) as string
  const mime = String(ref.mime)
  const what = category === 'image' || /^image\//.test(mime) ? 'Photo' : category === 'video' || /^video\//.test(mime) ? 'Video' : 'File'
  const name = oneLine(ref.label ?? '', 120)
  const facts = [ref.mime, category === 'image' && ref.width && ref.height ? `${ref.width}x${ref.height}` : '', sizeWords(ref.bytes)].filter(Boolean).join(', ')
  return `- ${what}${name ? ` "${name}"` : ''}${facts ? ` (${facts})` : ''}: ${path}`
}

export type ComposedTurn = { ok: true; prompt: string; ids: string[] } | { ok: false; code: string }

function storeCode(error: unknown): string {
  const code = error instanceof MediaStoreError ? error.code : (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code in TURN_ATTACHMENT_COPY ? code : 'media_unavailable'
}

/** Each file's ref and path, or the first refusal. Reads only through the store's lifecycle check. */
function resolveAll(ids: readonly string[], store: TurnAttachmentStore): { ok: true; files: Array<{ ref: MediaAttachmentRef; path: string }> } | { ok: false; code: string } {
  const files: Array<{ ref: MediaAttachmentRef; path: string }> = []
  for (const id of ids) {
    try {
      const { record, path } = store.resolveUsable(id)
      files.push({ ref: record.ref, path })
    } catch (error) {
      return { ok: false, code: storeCode(error) }
    }
  }
  return { ok: true, files }
}

/**
 * For a parked turn (POST .../queued-turns): every file readable now, and associated with the turn so it is kept while
 * the turn waits (the staged TTL is 4 hours; a parked turn can wait longer). Nothing about the files is returned.
 */
export async function keepTurnAttachments(ids: readonly string[], runId: string, store: TurnAttachmentStore): Promise<{ ok: true } | { ok: false; code: string }> {
  if (ids.length === 0) return { ok: true }
  const resolved = resolveAll(ids, store)
  if (!resolved.ok) return resolved
  try {
    await store.associate([...ids], { runId })
  } catch (error) {
    return { ok: false, code: storeCode(error) }
  }
  return { ok: true }
}

/** The words a refusal shows, by the media store's code. Never a path. */
export const TURN_ATTACHMENT_COPY: Record<string, string> = {
  media_not_found: 'A file you attached is no longer on your Mac. Remove it, attach it again, then send.',
  media_expired: 'A file you attached was kept for 4 hours and has gone. Remove it, attach it again, then send.',
  media_conflict: 'A file you attached belongs to another message. Remove it, attach it again, then send.',
  media_unavailable: 'Your Mac could not read a file you attached. Remove it, attach it again, then send.',
  attachments_too_long: 'Your message and the list of files are too long together. Shorten the message, then send.',
}

/**
 * The prompt the session gets: the words, then one line per file with its path on this Mac. Every id must resolve, or
 * nothing is sent (a turn that silently lost a screenshot answers a different question). On success the files are
 * associated with the turn, so they outlive the 4 hour staged TTL.
 */
export async function composeTurnPrompt(
  prompt: string,
  ids: readonly string[],
  opts: { runId: string; maxChars: number; store?: TurnAttachmentStore },
): Promise<ComposedTurn> {
  if (ids.length === 0) return { ok: true, prompt, ids: [] }
  const store: TurnAttachmentStore = opts.store ?? defaultTurnAttachmentStore()
  const resolved = resolveAll(ids, store)
  if (!resolved.ok) return resolved
  const lines = resolved.files.map(f => turnAttachmentLine(f.ref, f.path))
  const composed = `${prompt}\n\n${TURN_ATTACHMENTS_HEADING}\n${lines.join('\n')}`
  if (composed.length > opts.maxChars) return { ok: false, code: 'attachments_too_long' }
  try {
    await store.associate([...ids], { runId: opts.runId })
  } catch (error) {
    return { ok: false, code: storeCode(error) }
  }
  return { ok: true, prompt: composed, ids: [...ids] }
}
