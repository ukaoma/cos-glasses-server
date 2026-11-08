/**
 * Extra folders COS may preview from (preview engine phase 1, Miles 2026-11-08, decision 2).
 *
 * A link card or a sent file is served only when its canonical path is inside the session's own workspace OR inside
 * one of the folders named here. Nothing else ever opens. The list starts EMPTY.
 *
 * Stored the way "Show files and images your sessions make" is (lib/session-files-setting.ts): a small private JSON
 * file in the data folder, written atomically with mode 0600. Only a file that is not there (first use) gets the
 * default (no folders). A saved file that is damaged, unreadable or not this schema fails CLOSED: no extra folders,
 * source 'damaged'. Settings says so, and saving from it writes a good file again.
 *
 * Each folder must be absolute (or ~/...), exist, be a directory, and must not be or contain a broad root: /, /Users,
 * home, ~/Documents, ~/Library, ~/.cos-glasses, /Volumes, the temp roots (the same exact roots a session workspace may
 * never be). A folder inside ~/Library, ~/.cos-glasses or ~/.ssh is refused too. Stored canonical (realpath), and
 * re-checked on every read, so a folder deleted or replaced by a link later simply stops counting.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { securePrivateDirectory } from './secure-user-config.js'
import { broadWorkspaceRoots } from './agent-session-output-images.js'

export const PREVIEW_FOLDERS_FILE = 'web-preview-folders.json'
export const PREVIEW_FOLDERS_MAX = 20
const FOLDER_CHARS_MAX = 1024

export type PreviewFoldersSource = 'settings' | 'default' | 'damaged'
export interface PreviewFoldersSetting { folders: string[]; source: PreviewFoldersSource }
export type FolderRefusal = 'not_absolute' | 'missing' | 'not_folder' | 'broad' | 'private' | 'too_long' | 'too_many'
export interface FolderError { index: number; code: FolderRefusal; message: string }
export interface PreviewFoldersStore {
  read(): PreviewFoldersSetting
  set(input: unknown): { ok: true; setting: PreviewFoldersSetting } | { ok: false; errors: FolderError[] }
}

const MESSAGES: Record<FolderRefusal, string> = {
  not_absolute: 'Use a full folder path, like ~/cos-worktrees.',
  missing: 'That folder is not on this Mac.',
  not_folder: 'That is a file, not a folder.',
  broad: 'That folder is too broad. Name a project folder inside it.',
  private: 'COS never previews from that folder.',
  too_long: 'That path is too long.',
  too_many: `At most ${PREVIEW_FOLDERS_MAX} folders.`,
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/** One folder as typed, checked. Pure apart from the filesystem reads. */
export function checkFolder(input: unknown, home = homedir()): { ok: true; path: string } | { ok: false; code: FolderRefusal } {
  if (typeof input !== 'string') return { ok: false, code: 'not_absolute' }
  const raw = input.trim()
  if (!raw) return { ok: false, code: 'not_absolute' }
  if (raw.length > FOLDER_CHARS_MAX || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: 'too_long' }
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  if (!isAbsolute(expanded)) return { ok: false, code: 'not_absolute' }
  let canonical: string
  try { canonical = realpathSync(resolve(expanded)) } catch { return { ok: false, code: 'missing' } }
  try { if (!statSync(canonical).isDirectory()) return { ok: false, code: 'not_folder' } } catch { return { ok: false, code: 'missing' } }
  // Never a broad root, and never a folder that CONTAINS one (/ contains everything, /private contains /private/tmp).
  for (const broad of broadWorkspaceRoots(home)) if (within(canonical, broad)) return { ok: false, code: 'broad' }
  for (const p of ['Library', '.cos-glasses', '.ssh']) {
    const base = join(home, p)
    let real = base
    try { real = realpathSync(base) } catch { /* absent: the literal still counts */ }
    if (within(base, canonical) || within(real, canonical)) return { ok: false, code: 'private' }
  }
  return { ok: true, path: canonical }
}

/** How Settings shows a folder: ~/x inside home, the full path elsewhere. */
export function folderDisplay(path: string, home = homedir()): string {
  const rel = relative(home, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? '~/' + rel.split(sep).join('/') : path
}

export function createPreviewFoldersSetting(deps: { file: () => string; home?: () => string }): PreviewFoldersStore {
  const home = () => deps.home?.() ?? homedir()
  type Saved = { kind: 'absent' } | { kind: 'damaged' } | { kind: 'saved'; folders: string[] }
  const saved = (): Saved => {
    let text: string
    try { text = readFileSync(deps.file(), 'utf8') } catch (e) {
      return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'damaged' }
    }
    try {
      const raw = JSON.parse(text) as { schema?: unknown; folders?: unknown }
      if (raw && typeof raw === 'object' && raw.schema === 1 && Array.isArray(raw.folders) && raw.folders.length <= PREVIEW_FOLDERS_MAX
        && raw.folders.every(f => typeof f === 'string')) return { kind: 'saved', folders: raw.folders as string[] }
    } catch { /* damaged */ }
    return { kind: 'damaged' }
  }
  const store: PreviewFoldersStore = {
    read() {
      const s = saved()
      if (s.kind === 'damaged') return { folders: [], source: 'damaged' }
      if (s.kind === 'absent') return { folders: [], source: 'default' }
      // Re-checked on every read: a folder that is gone, became a link to a broad root, or is now private never counts.
      const out: string[] = []
      for (const f of s.folders) {
        const c = checkFolder(f, home())
        if (c.ok && c.path === f && !out.includes(c.path)) out.push(c.path)
      }
      return { folders: out, source: 'settings' }
    },
    set(input) {
      if (!Array.isArray(input)) return { ok: false, errors: [{ index: -1, code: 'not_absolute', message: 'Send { folders: [ ... ] }.' }] }
      if (input.length > PREVIEW_FOLDERS_MAX) return { ok: false, errors: [{ index: -1, code: 'too_many', message: MESSAGES.too_many }] }
      const errors: FolderError[] = [], folders: string[] = []
      input.forEach((f, index) => {
        const c = checkFolder(f, home())
        if (!c.ok) errors.push({ index, code: c.code, message: MESSAGES[c.code] })
        else if (!folders.includes(c.path)) folders.push(c.path)
      })
      if (errors.length) return { ok: false, errors }
      const file = deps.file()
      securePrivateDirectory(dirname(file))
      durableAtomicWriteFileSync(file, JSON.stringify({ schema: 1, folders }) + '\n', { mode: 0o600 })
      return { ok: true, setting: store.read() }
    },
  }
  return store
}

/** The server's list, in the data folder. */
export const previewFoldersSetting = createPreviewFoldersSetting({ file: () => dataPath(PREVIEW_FOLDERS_FILE) })
