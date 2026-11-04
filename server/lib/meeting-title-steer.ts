// Title steer (6.99.0): a name the person types for a meeting WHILE it is recording.
//
// WHY. A live Mac recording or glasses meeting is listed as "Mac recording 10:39 PM" until the title model names it at
// save. Miles wants to rename it live in COS Control. The typed name is a STEER, not the final title: it shows
// everywhere at once, and at save the title model receives it as a strong hint (the pipeline keeps his names, companies
// and topic and may sharpen the wording). When a save carries no title of its own the steer becomes the title.
//
// WHAT THIS MODULE IS. One small durable ledger: sessionId -> { title, revision, updatedAt }. The shape is the one
// meeting-ask's context store uses: a per-session revision, and a write that names the revision it read
// (`expectedRevision`) so two clients editing never silently overwrite each other (409 `title_changed`).
//
// WHAT IT IS NOT. It never decides whether a session is live (the route does, from the session map), never touches the
// transcript, and never logs the title: titles carry names and companies. Callers log a LENGTH only.

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export const TITLE_STEER_FILE_NAME = 'meeting-title-steer.json'
/** Longest steer, in characters (code points) after normalization. */
export const TITLE_STEER_MAX_CHARS = 120
/** An entry untouched this long is dropped. A meeting is saved or abandoned well inside it. */
export const TITLE_STEER_RETAIN_MS = 7 * 24 * 60 * 60_000
const SESSION_ID = /^[A-Za-z0-9:_-]{3,96}$/

export class TitleSteerError extends Error {
  constructor(readonly reason: 'invalid_session_id' | 'invalid_title' | 'invalid_revision' | 'title_changed' | 'session_not_live' | 'steer_persistence_failed', readonly status: number) {
    super(reason)
  }
}

/** What GET and PUT answer, and what a client holds: the title (null = none), the revision to send back, when it changed. */
export interface TitleSteerView {
  sessionId: string
  title: string | null
  revision: number
  updatedAt: string | null
}

interface TitleSteerEntry { title: string | null; revision: number; updatedAt: number }

/**
 * The advertised capability flag. `1` is the protocol version of this contract; an older server omits the key, which is
 * how a client knows not to show the rename control.
 */
export const TITLE_STEER_CAPABILITY = 1 as const

/**
 * NFKC, control characters to spaces, invisible direction/zero-width marks dropped, whitespace collapsed, trimmed.
 * Returns '' for "no title". Throws invalid_title for a non-string, or one still over the cap after trimming.
 * Characters, not UTF-16 units: an emoji counts once.
 */
export function normalizeTitleSteer(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') throw new TitleSteerError('invalid_title', 400)
  const text = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (Array.from(text).length > TITLE_STEER_MAX_CHARS) throw new TitleSteerError('invalid_title', 400)
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readEntries(path: string): Record<string, TitleSteerEntry> {
  if (!existsSync(path)) return Object.create(null)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.entries)) return Object.create(null)
    // Null prototype: a session id like `constructor` or `__proto__` fits the id pattern and must read as absent, not as Object's own members.
    const out: Record<string, TitleSteerEntry> = Object.create(null)
    for (const [id, raw] of Object.entries(parsed.entries)) {
      if (!SESSION_ID.test(id) || !isRecord(raw)) continue
      const { title, revision, updatedAt } = raw
      if (!Number.isSafeInteger(revision) || (revision as number) < 1 || !Number.isFinite(updatedAt)) continue
      if (title !== null && typeof title !== 'string') continue
      // A hand-edited or older file must not smuggle in what a PUT would refuse.
      let clean: string | null = null
      if (typeof title === 'string') { try { clean = normalizeTitleSteer(title) || null } catch { continue } }
      out[id] = { title: clean, revision: revision as number, updatedAt: updatedAt as number }
    }
    return out
  } catch {
    // A corrupt ledger is set aside, never silently trusted or deleted.
    try { renameSync(path, `${path}.corrupt.${Date.now()}`) } catch { /* the next write replaces it */ }
    return Object.create(null)
  }
}

export interface TitleSteerStore {
  readonly path: string
  /** The current steer, or { title: null, revision: 0, updatedAt: null } when none was ever set. */
  get(sessionId: string): TitleSteerView
  /** Just the text a save may use (null when none or cleared). Never throws, whatever the id. */
  title(sessionId: string): string | null
  /**
   * Set (a non-empty title) or clear ('' or null) the steer. `expectedRevision` must equal the current revision (0 when
   * none), else 409 title_changed. Clearing where nothing was ever set is a no-op that keeps revision 0. Persisted
   * before it returns; a failed write changes nothing.
   */
  set(sessionId: string, rawTitle: unknown, expectedRevision: unknown): TitleSteerView
}

export function createTitleSteerStore(options: { path?: string; now?: () => number } = {}): TitleSteerStore {
  const path = options.path ?? dataPath(TITLE_STEER_FILE_NAME)
  const now = options.now ?? Date.now
  let cache: Record<string, TitleSteerEntry> | null = null

  const load = (): Record<string, TitleSteerEntry> => {
    if (!cache) cache = readEntries(path)
    return cache
  }
  const prune = (entries: Record<string, TitleSteerEntry>, at: number) => {
    for (const [id, entry] of Object.entries(entries)) if (at - entry.updatedAt > TITLE_STEER_RETAIN_MS) delete entries[id]
  }
  const view = (sessionId: string, entry: TitleSteerEntry | undefined): TitleSteerView => entry
    ? { sessionId, title: entry.title, revision: entry.revision, updatedAt: new Date(entry.updatedAt).toISOString() }
    : { sessionId, title: null, revision: 0, updatedAt: null }

  return {
    path,
    get(sessionId) {
      if (!SESSION_ID.test(sessionId)) throw new TitleSteerError('invalid_session_id', 400)
      const entries = load()
      prune(entries, now())
      return view(sessionId, entries[sessionId])
    },
    title(sessionId) {
      const entries = load()
      prune(entries, now())
      // No id check: the ledger has a null prototype and its keys are all valid ids, so an odd id simply is not there.
      return entries[sessionId]?.title ?? null
    },
    set(sessionId, rawTitle, expectedRevision) {
      if (!SESSION_ID.test(sessionId)) throw new TitleSteerError('invalid_session_id', 400)
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new TitleSteerError('invalid_revision', 400)
      const title = normalizeTitleSteer(rawTitle)
      const at = now()
      const entries = load()
      prune(entries, at)
      const current = entries[sessionId]
      if ((current?.revision ?? 0) !== expectedRevision) throw new TitleSteerError('title_changed', 409)
      if (!current && !title) return view(sessionId, undefined)
      const next: TitleSteerEntry = { title: title || null, revision: (current?.revision ?? 0) + 1, updatedAt: at }
      // Persist a copy first: a failed write must leave the cache, and so the revision, where it was.
      const draft: Record<string, TitleSteerEntry> = Object.assign(Object.create(null), entries)
      draft[sessionId] = next
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        durableAtomicWriteFileSync(path, JSON.stringify({ schemaVersion: 1, entries: draft }, null, 2), { mode: 0o600 })
      } catch {
        throw new TitleSteerError('steer_persistence_failed', 503)
      }
      entries[sessionId] = next
      return view(sessionId, next)
    },
  }
}

let defaultStore: TitleSteerStore | null = null
/** The process-wide store, created on first use (never at import: tests import this module). */
export function getTitleSteerStore(): TitleSteerStore {
  if (!defaultStore) defaultStore = createTitleSteerStore()
  return defaultStore
}

/** The title a save files under: the one the request sent when it has text, else the steer (undefined when neither). */
export function effectiveSaveTitle(sentTitle: unknown, steer: string | null): string | undefined {
  if (typeof sentTitle === 'string' && sentTitle.trim()) return sentTitle
  return steer ?? undefined
}
