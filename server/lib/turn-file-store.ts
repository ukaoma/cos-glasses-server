// Any file, for a session turn only (Miles, 2026-11-07: "We still don't have the ability to take picture, or add photo
// or files from the web").
//
// The media store takes what a MODEL can read (photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4, MOV): it extracts text and
// frames, and an Ask, a Drop or Prep hands those to a model. A Claude or Codex session on this Mac is different: it gets
// the file's path (lib/session-turn-attachments.ts) and opens it with its own tools, so a .zip, a .docx, a log or a
// HEIC is useful there. This keeps those, and only those, beside the media store:
//
//   - Same upload: POST /api/media/file. Only when the upload says `X-COS-Purpose: session-turn` AND the media store
//     refuses the file as a format it cannot read does the file land here instead (routes/media.ts).
//   - Same ids (m_ + 24 hex), but never in the media index: an Ask, a Drop, Prep or GET /api/media/:id cannot find one
//     (media_not_found), so a file no model can read never reaches a model. Only the turn and fork routes resolve them.
//   - Same cap as the media store's own for a file that is not a video: 64 MB (MAX_OTHER_MEDIA_BYTES).
//   - Kept 4 hours until a turn takes it, then 30 days. Swept on each new file.
//   - Each file is `<root>/<id>/file/<its own name, made safe>`, so the agent sees a real name and extension, and the
//     record is `<root>/<id>/meta.json`, one folder up. No name a person gives a file can reach the record: on the
//     default case-insensitive macOS disk a file named META.JSON beside the record WAS the record, and the record write
//     replaced its bytes (QA, 6.99.27). Nothing here ever serves the bytes back over HTTP.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR } from './data-dir.js'
import { atomicWriteFileSync } from './atomic-fs.js'
import { MAX_OTHER_MEDIA_BYTES, RichMediaSafetyError } from './rich-media-safety.js'
import { isValidMediaId, type MediaAttachmentRef } from '../../shared/media-attachment.js'
import { MediaStoreError } from './media-store.js'

export const TURN_FILE_MAX_BYTES = MAX_OTHER_MEDIA_BYTES
export const TURN_FILE_STAGED_TTL_MS = 4 * 60 * 60_000
export const TURN_FILE_KEPT_TTL_MS = 30 * 24 * 60 * 60_000
const PAYLOAD_DIR = 'file'

interface TurnFileMeta {
  id: string
  name: string
  label: string
  mime: string
  bytes: number
  createdAtMs: number
  associatedAtMs?: number
  runId?: string
}

/** What the upload answers: an id and what it is. Never a path. */
export interface TurnFileRef {
  id: string
  kind: 'session_file'
  mime: string
  bytes: number
  label: string
  createdAt: string
}

/** A filename the agent can read, that cannot climb out of its folder or carry control characters. */
export function safeTurnFileName(label: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  let name = String(label ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029/\\:]+/g, ' ').replace(/\s+/g, ' ').trim()
  name = name.replace(/^[.\s]+/, '').trimEnd()
  if (!name) name = 'file'
  if (name.length > 120) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, 120 - ext.length).trimEnd() + ext
  }
  return name
}

function safeMime(declared: string | undefined): string {
  const m = String(declared ?? '').toLowerCase().split(';', 1)[0]!.trim()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(m) ? m : 'application/octet-stream'
}

export class TurnFileStore {
  readonly root: string
  private readonly now: () => number
  constructor(root: string = join(DATA_DIR, 'turn-files'), now: () => number = Date.now) {
    this.root = resolve(root)
    this.now = now
  }

  private dirOf(id: string): string { return join(this.root, id) }
  /** The file's own folder, apart from the record (see the header). */
  private payloadDirOf(id: string): string { return join(this.root, id, PAYLOAD_DIR) }

  private readMeta(id: string): TurnFileMeta | null {
    if (!isValidMediaId(id)) return null
    const path = join(this.dirOf(id), 'meta.json')
    if (!existsSync(path)) return null
    try {
      const m = JSON.parse(readFileSync(path, 'utf8')) as TurnFileMeta
      if (m.id !== id || typeof m.name !== 'string' || m.name !== safeTurnFileName(m.name) || typeof m.createdAtMs !== 'number') return null
      return m
    } catch { return null }
  }

  private expired(m: TurnFileMeta, now: number): boolean {
    return typeof m.associatedAtMs === 'number' ? now - m.associatedAtMs > TURN_FILE_KEPT_TTL_MS : now - m.createdAtMs > TURN_FILE_STAGED_TTL_MS
  }

  /** Takes a staged upload (moved, else copied). Throws MediaStoreError('attachment_too_large') past the cap. */
  ingestFromFile(input: { sourcePath: string; byteLength: number; label?: string; declaredMime?: string }): TurnFileRef {
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) throw new RichMediaSafetyError('corrupt_attachment', 'attachment is empty')
    if (input.byteLength > TURN_FILE_MAX_BYTES) throw new RichMediaSafetyError('attachment_too_large', `attachment exceeds ${TURN_FILE_MAX_BYTES} byte limit`)
    this.sweep()
    const id = 'm_' + randomBytes(12).toString('hex')
    const dir = this.dirOf(id)
    const payloadDir = this.payloadDirOf(id)
    mkdirSync(payloadDir, { recursive: true, mode: 0o700 })
    const name = safeTurnFileName(input.label)
    const target = join(payloadDir, name)
    try {
      renameSync(input.sourcePath, target)
    } catch {
      copyFileSync(input.sourcePath, target)
    }
    const now = this.now()
    const meta: TurnFileMeta = { id, name, label: String(input.label ?? '').slice(0, 120) || name, mime: safeMime(input.declaredMime), bytes: input.byteLength, createdAtMs: now }
    atomicWriteFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
    return { id, kind: 'session_file', mime: meta.mime, bytes: meta.bytes, label: meta.label, createdAt: new Date(now).toISOString() }
  }

  /** The file's ref (in the media ref's shape, for the turn's line) and path, or a media-store error. */
  resolveUsable(id: string): { record: { ref: MediaAttachmentRef }; path: string } {
    const m = this.readMeta(id)
    if (!m) throw new MediaStoreError('media_not_found', `attachment ${id} not found`)
    if (this.expired(m, this.now())) throw new MediaStoreError('media_expired', `attachment ${id} expired`)
    const path = join(this.payloadDirOf(id), m.name)
    if (!resolve(path).startsWith(this.payloadDirOf(id) + sep) || !existsSync(path)) throw new MediaStoreError('media_unavailable', `attachment ${id} content unavailable`)
    // Shaped as a ref only for the line the agent reads (kind and mime are not in the media contract and never leave
    // this server as one).
    const ref = { id, kind: 'session_file', category: 'file', mime: m.mime, width: 0, height: 0, createdAt: new Date(m.createdAtMs).toISOString(), bytes: m.bytes, label: m.label } as unknown as MediaAttachmentRef
    return { record: { ref }, path }
  }

  has(id: string): boolean { return this.readMeta(id) !== null }

  /** Kept for 30 days from now: a turn took it. */
  async associate(ids: string[], target: { runId?: string }): Promise<void> {
    const now = this.now()
    for (const id of ids) {
      const m = this.readMeta(id)
      if (!m) throw new MediaStoreError('media_not_found', `attachment ${id} not found`)
      if (this.expired(m, now)) throw new MediaStoreError('media_expired', `attachment ${id} expired`)
      m.associatedAtMs = now
      if (target.runId) m.runId = target.runId.slice(0, 160)
      atomicWriteFileSync(join(this.dirOf(id), 'meta.json'), JSON.stringify(m))
    }
  }

  /** Removes expired files and folders that are not ours. Never throws. */
  sweep(): number {
    let removed = 0
    if (!existsSync(this.root)) return 0
    const now = this.now()
    let names: string[] = []
    try { names = readdirSync(this.root) } catch { return 0 }
    for (const name of names) {
      const dir = join(this.root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        const m = this.readMeta(name)
        // A folder with no readable meta is a crashed upload once it is past the staged TTL.
        const stale = m ? this.expired(m, now) : now - statSync(dir).mtimeMs > TURN_FILE_STAGED_TTL_MS
        if (stale) { rmSync(dir, { recursive: true, force: true }); removed++ }
      } catch { /* one bad folder never stops the sweep */ }
    }
    return removed
  }
}

let defaultStore: TurnFileStore | null = null
export function getTurnFileStore(): TurnFileStore {
  if (!defaultStore) defaultStore = new TurnFileStore()
  return defaultStore
}
/** Test hook. */
export function _setTurnFileStoreForTests(store: TurnFileStore | null): TurnFileStore | null {
  const prev = defaultStore
  defaultStore = store
  return prev
}
