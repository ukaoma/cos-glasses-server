/**
 * Prep v1.1 (6.99.19): the durable Prep store at dataPath('prep').
 *
 *   drafts/<draftId>.json            one PrepDraft, written whole (fsync + rename, mode 0600)
 *   files/<draftId>/<fileId>.bin     the original bytes, copied out of /api/media at add time (the media stage expires in 4 h)
 *   files/<draftId>/<fileId>.txt     the extracted text a run and a bind read (ready files only)
 *   runs/<draftId>/<clientRequestId>.txt   a run's exact prompt, saved before the job is submitted
 *   binds/<draftId>/<sessionId>/<revision>.json   the exact Meeting Ask rows a bind attaches, saved before its intent
 *
 * Drafts are read back from disk on first use, so a restarted server (a fresh instance) serves the same drafts. Writes
 * are synchronous inside one server process; prep-runtime.ts serializes each draft's read-modify-write. Nothing is
 * auto-deleted in v1. A draft file that cannot be read is skipped and logged, never deleted.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { ASK_SESSION } from './ask-session-id.js'
import { PREP_DRAFT_ID, PREP_FILE_ID, PREP_PROVIDERS, PREP_UUID_V4, type PrepDraft, type PrepOccurrence } from '../../shared/prep.js'

export class PrepError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly draft?: PrepDraft, readonly extra: Record<string, unknown> = {}) {
    super(code)
    this.name = 'PrepError'
  }
}

/**
 * v1.1 #16: "occ:v2:" + sha256("occ:v2:" + provider|account|calendarId|eventId or ""|externalId or ""|startsAt exact
 * UTC ISO). Every part, no quantization, so distinct occurrences never coalesce. Finds a draft; never binds one.
 */
export function prepOccurrenceKey(o: Pick<PrepOccurrence, 'provider' | 'account' | 'calendarId' | 'eventId' | 'externalId' | 'startsAt'>): string {
  const text = 'occ:v2:' + [o.provider, o.account ?? '', o.calendarId, o.eventId ?? '', o.externalId ?? '', new Date(Date.parse(o.startsAt)).toISOString()].join('|')
  return 'occ:v2:' + createHash('sha256').update(text).digest('hex')
}

/**
 * The provider identity, or null. All of provider, calendarId, eventId or externalId, and startsAt must be present
 * (account is optional and part of the key); anything less is no identity at all, never a guess from title or time.
 * A client-sent `key` is ignored and recomputed. A non-object is a 400.
 */
export function parsePrepOccurrence(raw: unknown): PrepOccurrence | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PrepError('invalid_occurrence')
  const o = raw as Record<string, unknown>
  const id = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 512 ? v : null
  const iso = (v: unknown) => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null
  const provider = PREP_PROVIDERS.includes(o.provider as never) ? o.provider as PrepOccurrence['provider'] : null
  const account = id(o.account), calendarId = id(o.calendarId), eventId = id(o.eventId), externalId = id(o.externalId)
  const startsAt = iso(o.startsAt)
  if (!provider || !calendarId || (!eventId && !externalId) || !startsAt) return null
  const base = { provider, account, calendarId, eventId, externalId, startsAt }
  return { key: prepOccurrenceKey(base), ...base, endsAt: iso(o.endsAt) }
}

/** The loader skips a draft file larger than this; writes stop well short of it. */
export const DRAFT_LOAD_BYTES = 5_000_000
export const DRAFT_WRITE_BYTES = 4_000_000

export class PrepStore {
  readonly root: string
  private cache: Map<string, PrepDraft> | null = null

  constructor(root = dataPath('prep')) { this.root = resolve(root) }

  private dir(...parts: string[]): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (lstatSync(this.root).isSymbolicLink()) throw new PrepError('prep_store_unsafe', 503)
    let p = this.root
    for (const part of parts) {
      p = join(p, part)
      mkdirSync(p, { recursive: true, mode: 0o700 })
      if (lstatSync(p).isSymbolicLink()) throw new PrepError('prep_store_unsafe', 503)
    }
    return p
  }

  private load(): Map<string, PrepDraft> {
    if (this.cache) return this.cache
    const drafts = new Map<string, PrepDraft>()
    const dir = this.dir('drafts')
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      try {
        const path = join(dir, name), st = lstatSync(path)
        if (!PREP_DRAFT_ID.test(id) || !st.isFile() || st.size > DRAFT_LOAD_BYTES) throw new Error('unsafe')
        const draft = JSON.parse(readFileSync(path, 'utf8')) as PrepDraft
        if (draft?.id !== id || !Number.isSafeInteger(draft.revision) || !Array.isArray(draft.files)) throw new Error('shape')
        draft.snapshots ??= []
        draft.fileOperations ??= []
        drafts.set(id, draft)
      } catch {
        // Kept on disk for a person to look at; it simply is not served.
        console.warn(`[prep] skipped an unreadable draft file (${id.slice(0, 12)})`)
      }
    }
    this.cache = drafts
    return drafts
  }

  get(id: string): PrepDraft | undefined {
    if (!PREP_DRAFT_ID.test(id)) return undefined
    const d = this.load().get(id)
    return d ? structuredClone(d) : undefined
  }

  list(): PrepDraft[] { return [...this.load().values()].map(d => structuredClone(d)) }

  byClientDraftId(clientDraftId: string): PrepDraft | undefined {
    for (const d of this.load().values()) if (d.clientDraftId === clientDraftId) return structuredClone(d)
    return undefined
  }

  write(draft: PrepDraft): PrepDraft {
    if (!PREP_DRAFT_ID.test(draft.id)) throw new PrepError('invalid_draft_id')
    const encoded = JSON.stringify(draft)
    // Never write a draft the loader would refuse: it would vanish on the next restart.
    if (Buffer.byteLength(encoded, 'utf8') > DRAFT_WRITE_BYTES) throw new PrepError('prep_draft_too_large', 507)
    try {
      durableAtomicWriteFileSync(join(this.dir('drafts'), draft.id + '.json'), encoded, { mode: 0o600 })
    } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('prep_write_failed', 507)
    }
    this.load().set(draft.id, structuredClone(draft))
    return structuredClone(draft)
  }

  private blobPath(draftId: string, fileId: string, ext: 'bin' | 'txt'): string {
    if (!PREP_DRAFT_ID.test(draftId) || !PREP_FILE_ID.test(fileId)) throw new PrepError('invalid_file_id')
    return join(this.dir('files', draftId), `${fileId}.${ext}`)
  }

  putOriginal(draftId: string, fileId: string, bytes: Buffer): void {
    try { durableAtomicWriteFileSync(this.blobPath(draftId, fileId, 'bin'), bytes, { mode: 0o600 }) } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('prep_write_failed', 507)
    }
  }

  putText(draftId: string, fileId: string, text: string): void {
    try { durableAtomicWriteFileSync(this.blobPath(draftId, fileId, 'txt'), text, { mode: 0o600 }) } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('prep_write_failed', 507)
    }
  }

  readOriginal(draftId: string, fileId: string): Buffer {
    try { return readFileSync(this.blobPath(draftId, fileId, 'bin')) } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('file_not_found', 404)
    }
  }

  /** The stored text, or '' when the file has none (not ready, or never extracted). */
  readText(draftId: string, fileId: string): string {
    try { return readFileSync(this.blobPath(draftId, fileId, 'txt'), 'utf8') } catch (e) {
      if (e instanceof PrepError) throw e
      return ''
    }
  }

  /** The exact prompt of a run, saved before its job is submitted so a retry after a crash resubmits the same bytes. */
  putPrompt(draftId: string, clientRequestId: string, prompt: string): void {
    try { durableAtomicWriteFileSync(this.promptPath(draftId, clientRequestId), prompt, { mode: 0o600 }) } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('prep_write_failed', 507)
    }
  }

  readPrompt(draftId: string, clientRequestId: string): string | null {
    try { return readFileSync(this.promptPath(draftId, clientRequestId), 'utf8') } catch (e) {
      if (e instanceof PrepError) throw e
      return null
    }
  }

  private promptPath(draftId: string, clientRequestId: string): string {
    if (!PREP_DRAFT_ID.test(draftId) || !PREP_UUID_V4.test(clientRequestId)) throw new PrepError('invalid_client_request_id')
    return join(this.dir('runs', draftId), `${clientRequestId}.txt`)
  }

  /**
   * The exact Meeting Ask rows one bind attaches, saved before the binding intent, so a retry after a crash re-applies
   * the frozen revision rather than whatever the draft holds by then.
   */
  putBindPayload(draftId: string, sessionId: string, revision: number, rows: unknown[]): void {
    try { durableAtomicWriteFileSync(this.bindPath(draftId, sessionId, revision), JSON.stringify(rows), { mode: 0o600 }) } catch (e) {
      if (e instanceof PrepError) throw e
      throw new PrepError('prep_write_failed', 507)
    }
  }

  readBindPayload(draftId: string, sessionId: string, revision: number): unknown[] | null {
    try {
      const rows = JSON.parse(readFileSync(this.bindPath(draftId, sessionId, revision), 'utf8'))
      return Array.isArray(rows) ? rows : null
    } catch (e) {
      if (e instanceof PrepError) throw e
      return null
    }
  }

  /** Keyed by (draft, meeting, revision): a replay of one bind can never read another bind's rows. */
  private bindPath(draftId: string, sessionId: string, revision: number): string {
    if (!PREP_DRAFT_ID.test(draftId) || !ASK_SESSION.test(sessionId) || !Number.isSafeInteger(revision) || revision < 0) throw new PrepError('invalid_session_id')
    return join(this.dir('binds', draftId, sessionId), `${revision}.json`)
  }

  /** Bytes on disk under the store root (drafts, originals, text). Walked on each add: at most 300 drafts x 10 files. */
  usageBytes(): number {
    let total = 0
    const walk = (p: string) => {
      for (const name of readdirSync(p)) {
        const child = join(p, name), st = lstatSync(child)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) walk(child)
        else if (st.isFile()) total += st.size
      }
    }
    walk(this.dir())
    return total
  }
}
