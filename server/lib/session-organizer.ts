/**
 * The session organizer (Sessions chat-style layout, step 2a; contract
 * operations/personal/wk46_2026/sessions_chat_layout/S1_CONTRACT_step2a.md).
 *
 * COS's own folders, COS pins and renamed titles for agent sessions, shared by Control Web and the Mac app. It only
 * ADDS: nothing an agent wrote is changed (a COS pin is not a Claude star), and a list without this store is today's.
 *
 * - One file, data/session-organizer.json, 0600, written durably (temp file, fsync, rename) on every change.
 * - Keyed `<provider>:<canonical id>`, lowercase. The caller canonicalizes (Claude Desktop ids map to their CLI id)
 *   BEFORE it reaches this module, so this module never guesses identity.
 * - One change per call, applied in memory and written at once; `rev` rises by one per change. Nothing takes a whole
 *   store, so two devices editing different things never overwrite each other.
 * - Folder names and titles never reach a log line: logs carry counts and reason codes only.
 * - A file that exists but cannot be READ makes the store unavailable (no writes), so a transient read error can
 *   never be followed by a write that replaces real data with an empty store. A file that reads but does not parse,
 *   or has the wrong shape, is moved aside as `.corrupt-<time>` and the store starts empty.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export const ORGANIZER_FILE = 'session-organizer.json'
export const ORGANIZER_LIMITS = { folders: 200, entries: 5_000, folderName: 60, title: 120 } as const
export type OrganizerProvider = 'claude' | 'codex' | 'cursor'
const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])
const FOLDER_ID_RE = /^f_[0-9a-f]{16}$/

export interface OrganizerFolder { name: string; created_at: string }
/** `desktop_id`: for a Claude session, the Claude Desktop id it was written under when one is known (Q1 FIX 2). A row
 *  matches an entry by its key OR by this id, so an entry survives the Desktop alias appearing or changing. */
export interface OrganizerEntry { folder_id?: string; cos_pinned?: true; title?: string; desktop_id?: string; updated_at: string }
interface OrganizerFile {
  version: 1
  rev: number
  folders: Record<string, OrganizerFolder>
  sessions: Record<string, OrganizerEntry>
}

export class OrganizerError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason) }
}

/** What a list row or search hit carries from the store (each omitted when absent). */
export interface OrganizerRowFields { folder_id?: string; cos_pinned?: true; title_override?: string }

/** Trim, drop control characters and line breaks, collapse inner whitespace. Empty means refused. */
export function cleanOrganizerText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || [...cleaned].length > max) return null
  return cleaned
}

export function organizerKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId.trim().toLowerCase()}`
}

function emptyFile(): OrganizerFile { return { version: 1, rev: 0, folders: {}, sessions: {} } }

function validShape(value: unknown): value is OrganizerFile {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<OrganizerFile>
  if (v.version !== 1 || typeof v.rev !== 'number' || !Number.isInteger(v.rev) || v.rev < 0) return false
  if (!v.folders || typeof v.folders !== 'object' || Array.isArray(v.folders)) return false
  if (!v.sessions || typeof v.sessions !== 'object' || Array.isArray(v.sessions)) return false
  for (const [id, folder] of Object.entries(v.folders)) {
    if (!FOLDER_ID_RE.test(id) || !folder || typeof folder.name !== 'string' || typeof folder.created_at !== 'string') return false
  }
  for (const [key, entry] of Object.entries(v.sessions)) {
    const provider = key.split(':', 1)[0]
    if (!PROVIDERS.has(provider) || key.length <= provider.length + 1 || !entry || typeof entry.updated_at !== 'string') return false
    if (entry.folder_id !== undefined && (typeof entry.folder_id !== 'string' || !v.folders[entry.folder_id])) return false
    if (entry.cos_pinned !== undefined && entry.cos_pinned !== true) return false
    if (entry.title !== undefined && typeof entry.title !== 'string') return false
    if (entry.desktop_id !== undefined && typeof entry.desktop_id !== 'string') return false
  }
  return true
}

export type OrganizerLog = (line: string) => void

export class SessionOrganizer {
  private state: OrganizerFile = emptyFile()
  private available = true

  constructor(private readonly path: string = dataPath(ORGANIZER_FILE), private readonly log: OrganizerLog = line => console.warn(line),
    private readonly now: () => Date = () => new Date()) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      // Exists but unreadable (permission, I/O): never write over it.
      this.available = false
      this.log(`[session-organizer] unavailable: the store exists but could not be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})`)
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    if (validShape(parsed)) { this.state = parsed; return }
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.log('[session-organizer] the store did not parse; moved aside and started empty (reason=corrupt_store)')
    } catch {
      this.available = false
      this.log('[session-organizer] unavailable: the store did not parse and could not be moved aside (reason=corrupt_store)')
    }
  }

  isAvailable(): boolean { return this.available }
  rev(): number { return this.state.rev }
  isEmpty(): boolean { return Object.keys(this.state.folders).length === 0 && Object.keys(this.state.sessions).length === 0 }

  private requireAvailable(): void {
    if (!this.available) throw new OrganizerError(503, 'organizer_unavailable')
  }

  private commit(next: OrganizerFile): void {
    next.rev = this.state.rev + 1
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.path, JSON.stringify(next), { mode: 0o600 })
    this.state = next
  }

  private clone(): OrganizerFile { return structuredClone(this.state) }

  private counts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const entry of Object.values(this.state.sessions)) {
      if (entry.folder_id) counts.set(entry.folder_id, (counts.get(entry.folder_id) ?? 0) + 1)
    }
    return counts
  }

  listFolders(): Array<{ id: string; name: string; created_at: string; count: number }> {
    const counts = this.counts()
    return Object.entries(this.state.folders)
      .map(([id, f]) => ({ id, name: f.name, created_at: f.created_at, count: counts.get(id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
  }

  private nameTaken(name: string, except?: string): boolean {
    const lower = name.toLocaleLowerCase()
    return Object.entries(this.state.folders).some(([id, f]) => id !== except && f.name.toLocaleLowerCase() === lower)
  }

  createFolder(rawName: unknown): { id: string; name: string; created_at: string; count: number } {
    this.requireAvailable()
    const name = cleanOrganizerText(rawName, ORGANIZER_LIMITS.folderName)
    if (!name) throw new OrganizerError(400, 'invalid_name')
    if (Object.keys(this.state.folders).length >= ORGANIZER_LIMITS.folders) throw new OrganizerError(409, 'too_many_folders')
    if (this.nameTaken(name)) throw new OrganizerError(409, 'folder_name_taken')
    let id = ''
    do { id = `f_${randomBytes(8).toString('hex')}` } while (this.state.folders[id])
    const next = this.clone()
    const created_at = this.now().toISOString()
    next.folders[id] = { name, created_at }
    this.commit(next)
    return { id, name, created_at, count: 0 }
  }

  renameFolder(id: string, rawName: unknown): { id: string; name: string; created_at: string; count: number } {
    this.requireAvailable()
    const folder = this.state.folders[id]
    if (!folder) throw new OrganizerError(404, 'folder_not_found')
    const name = cleanOrganizerText(rawName, ORGANIZER_LIMITS.folderName)
    if (!name) throw new OrganizerError(400, 'invalid_name')
    if (this.nameTaken(name, id)) throw new OrganizerError(409, 'folder_name_taken')
    const next = this.clone()
    next.folders[id] = { ...folder, name }
    this.commit(next)
    return { id, name, created_at: folder.created_at, count: this.counts().get(id) ?? 0 }
  }

  /** Removes the folder. Its sessions leave it; no session is ever deleted. Returns how many left. */
  deleteFolder(id: string): number {
    this.requireAvailable()
    if (!this.state.folders[id]) throw new OrganizerError(404, 'folder_not_found')
    const next = this.clone()
    delete next.folders[id]
    let released = 0
    const stamp = this.now().toISOString()
    for (const [key, entry] of Object.entries(next.sessions)) {
      if (entry.folder_id !== id) continue
      released++
      delete entry.folder_id
      entry.updated_at = stamp
      if (!entry.cos_pinned && entry.title === undefined) delete next.sessions[key]
    }
    this.commit(next)
    return released
  }

  /**
   * One session's change. `key` must already be canonical (organizerKey on the canonical id). Keys left out of
   * `change` are untouched; `null` clears. An entry left with nothing in it is removed.
   */
  updateSession(key: string, change: { folder_id?: unknown; cos_pinned?: unknown; title?: unknown }, ids: { desktopId?: string } = {}): OrganizerRowFields {
    this.requireAvailable()
    const touchesFolder = Object.prototype.hasOwnProperty.call(change, 'folder_id')
    const touchesPin = Object.prototype.hasOwnProperty.call(change, 'cos_pinned')
    const touchesTitle = Object.prototype.hasOwnProperty.call(change, 'title')
    if (!touchesFolder && !touchesPin && !touchesTitle) throw new OrganizerError(400, 'empty_change')
    let folderId: string | null | undefined
    if (touchesFolder) {
      if (change.folder_id === null) folderId = null
      else if (typeof change.folder_id === 'string' && this.state.folders[change.folder_id]) folderId = change.folder_id
      else throw new OrganizerError(404, 'folder_not_found')
    }
    if (touchesPin && typeof change.cos_pinned !== 'boolean') throw new OrganizerError(400, 'invalid_pin')
    let title: string | null | undefined
    if (touchesTitle) {
      if (change.title === null) title = null
      else {
        title = cleanOrganizerText(change.title, ORGANIZER_LIMITS.title)
        if (!title) throw new OrganizerError(400, 'invalid_title')
      }
    }
    const desktopId = ids.desktopId?.trim().toLowerCase() || undefined
    // Q1 FIX 2: an entry written under the same Desktop id but another key (its CLI alias appeared or changed since)
    // moves to this key, so one session never has two entries.
    const movedFrom = !this.state.sessions[key] && desktopId
      ? Object.keys(this.state.sessions).find(k => k.startsWith('claude:') && this.state.sessions[k].desktop_id === desktopId)
      : undefined
    const existing = this.state.sessions[key] ?? (movedFrom ? this.state.sessions[movedFrom] : undefined)
    if (!existing && Object.keys(this.state.sessions).length >= ORGANIZER_LIMITS.entries) throw new OrganizerError(409, 'too_many_entries')
    const next = this.clone()
    const entry: OrganizerEntry = { ...(existing ? structuredClone(existing) : {}), updated_at: this.now().toISOString() }
    if (movedFrom) delete next.sessions[movedFrom]
    if (desktopId) entry.desktop_id = desktopId
    if (folderId === null) delete entry.folder_id; else if (folderId) entry.folder_id = folderId
    if (touchesPin) { if (change.cos_pinned === true) entry.cos_pinned = true; else delete entry.cos_pinned }
    if (title === null) delete entry.title; else if (title) entry.title = title
    if (!entry.folder_id && !entry.cos_pinned && entry.title === undefined) delete next.sessions[key]
    else next.sessions[key] = entry
    this.commit(next)
    return this.fieldsFor(key)
  }

  /** The fields for the first of these keys that has an entry, or for an entry written under one of `desktopIds`. */
  fieldsForAny(keys: readonly string[], desktopIds: readonly string[] = []): OrganizerRowFields {
    for (const key of keys) if (this.state.sessions[key]) return this.fieldsFor(key)
    if (desktopIds.length) {
      const wanted = new Set(desktopIds.map(id => id.toLowerCase()))
      for (const [key, entry] of Object.entries(this.state.sessions)) {
        if (entry.desktop_id && key.startsWith('claude:') && wanted.has(entry.desktop_id)) return this.fieldsFor(key)
      }
    }
    return {}
  }

  /** The fields a row for this canonical key carries (empty when none). */
  fieldsFor(key: string): OrganizerRowFields {
    const entry = this.state.sessions[key]
    if (!entry) return {}
    return {
      ...(entry.folder_id ? { folder_id: entry.folder_id } : {}),
      ...(entry.cos_pinned ? { cos_pinned: true as const } : {}),
      ...(entry.title !== undefined ? { title_override: entry.title } : {}),
    }
  }

  /** Canonical ids per provider that the list keeps at any age and outside its caps: COS pins and folder members. */
  keptIds(): Record<OrganizerProvider, Set<string>> {
    const kept: Record<OrganizerProvider, Set<string>> = { claude: new Set(), codex: new Set(), cursor: new Set() }
    for (const [key, entry] of Object.entries(this.state.sessions)) {
      if (!entry.cos_pinned && !entry.folder_id) continue
      const at = key.indexOf(':')
      kept[key.slice(0, at) as OrganizerProvider].add(key.slice(at + 1))
      // The list maps a Desktop id to its current CLI id, so an entry follows its session when the alias changes.
      if (entry.desktop_id) kept.claude.add(entry.desktop_id)
    }
    return kept
  }

  /** Keys whose renamed title contains `query` (case-insensitive), for search. */
  titleMatches(query: string): Array<{ provider: OrganizerProvider; session_id: string }> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const out: Array<{ provider: OrganizerProvider; session_id: string }> = []
    for (const [key, entry] of Object.entries(this.state.sessions)) {
      if (entry.title === undefined || !entry.title.toLocaleLowerCase().includes(needle)) continue
      const at = key.indexOf(':')
      out.push({ provider: key.slice(0, at) as OrganizerProvider, session_id: key.slice(at + 1) })
    }
    return out
  }
}

let shared: SessionOrganizer | null = null
/** The server's one organizer, loaded on first use. */
export function sessionOrganizer(): SessionOrganizer {
  if (!shared) shared = new SessionOrganizer()
  return shared
}
/** Tests only. */
export function __resetSessionOrganizerForTests(next: SessionOrganizer | null = null): void { shared = next }
