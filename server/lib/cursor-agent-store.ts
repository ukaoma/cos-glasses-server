// Cursor Agent CLI store: `~/.cursor/chats/<hash>/<uuid>/` plus the jsonl
// project-folder slug Agent keys off `--workspace`.
//
// Continue attaches only when this helper resolves. IDE-only composers have a
// jsonl and no chats dir — Gate 0. Empty `hasConversation: false` stubs are
// not sessions. Canary H: passing realpath `meta.json.cwd` (`/private/tmp/...`)
// as `--workspace` creates a SECOND jsonl folder. Spawn must use the spelling
// whose slug already exists.

import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isValidNativeThreadId } from './native-thread-id.js'

export const MAX_CURSOR_CHAT_HASH_DIRS = 2048
export const MAX_CURSOR_CHAT_DIRS = 4096
export const MAX_CURSOR_PROJECT_DIRS = 2048

export interface CursorAgentSession {
  dir: string
  cwd: string
  hasConversation: boolean
  createdAtMs: number | null
}

export interface CursorAgentStoreDirs {
  cursorChatsDir: string
  cursorProjectsDir: string
}

export function encodeCursorWorkspaceSlug(workspace: string): string {
  const trimmed = workspace.trim()
  const withoutRoot = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  // Cursor's project-folder alphabet is [A-Za-z0-9-]. Every other run of
  // characters — underscores, dots, spaces, slashes — collapses to one hyphen.
  // Matching only `/` and whitespace left `_` and `.` in the slug, so
  // spawnWorkspace could never find the real folder (wk30_2026, .module, …).
  return withoutRoot.replace(/[^A-Za-z0-9]+/g, '-')
}

export function cursorWorkspaceSpellings(cwd: string): string[] {
  const trimmed = cwd.trim()
  if (!trimmed) return []
  const out = [trimmed]
  if (trimmed.startsWith('/private/tmp/')) {
    out.push(`/tmp/${trimmed.slice('/private/tmp/'.length)}`)
  } else if (trimmed.startsWith('/tmp/')) {
    out.push(`/private/tmp/${trimmed.slice('/tmp/'.length)}`)
  }
  return out
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function dirExists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function readDirNames(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).map(entry => entry.name)
}

function skipProjectFolder(folder: string): boolean {
  return folder.includes('var-folders') || folder.includes('private-var') || folder === 'empty-window'
}

export function resolveCursorAgentSession(
  threadId: string,
  chatsDir: string,
): CursorAgentSession | null {
  if (!isValidNativeThreadId(threadId)) return null
  if (!chatsDir || !dirExists(chatsDir)) return null

  let hashes: string[]
  try {
    hashes = readDirNames(chatsDir)
  } catch {
    return null
  }
  if (hashes.length > MAX_CURSOR_CHAT_HASH_DIRS) return null

  const matches: string[] = []
  let scanned = 0
  for (const hash of hashes) {
    const hashDir = join(chatsDir, hash)
    if (!dirExists(hashDir)) continue
    const candidate = join(hashDir, threadId)
    if (++scanned > MAX_CURSOR_CHAT_DIRS) return null
    if (!dirExists(candidate)) continue
    if (!existsSync(join(candidate, 'meta.json'))) continue
    matches.push(candidate)
    if (matches.length > 1) return null
  }
  if (matches.length !== 1) return null

  const dir = matches[0]!
  let raw: string
  try {
    raw = readFileSync(join(dir, 'meta.json'), 'utf8')
  } catch {
    return null
  }
  let meta: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    meta = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (meta.hasConversation !== true) return null
  const cwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : ''
  if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) return null
  const resolved = realpathOrNull(cwd)
  if (!resolved || !dirExists(resolved)) return null
  const createdAtMs = typeof meta.createdAtMs === 'number' && Number.isFinite(meta.createdAtMs)
    ? meta.createdAtMs
    : null
  return { dir, cwd, hasConversation: true, createdAtMs }
}

export function transcriptFoldersFor(
  threadId: string,
  projectsDir: string,
): string[] {
  if (!isValidNativeThreadId(threadId)) return []
  if (!projectsDir || !dirExists(projectsDir)) return []
  let folders: string[]
  try {
    folders = readDirNames(projectsDir)
  } catch {
    return []
  }
  if (folders.length > MAX_CURSOR_PROJECT_DIRS) return []

  const found: string[] = []
  for (const folder of folders) {
    if (skipProjectFolder(folder)) continue
    const file = join(projectsDir, folder, 'agent-transcripts', threadId, `${threadId}.jsonl`)
    try {
      if (!lstatSync(file).isFile()) continue
    } catch {
      continue
    }
    found.push(folder)
  }
  return found
}

export function spawnWorkspace(
  threadId: string,
  dirs: CursorAgentStoreDirs,
): string | null {
  const session = resolveCursorAgentSession(threadId, dirs.cursorChatsDir)
  if (!session) return null
  const folders = transcriptFoldersFor(threadId, dirs.cursorProjectsDir)
  if (folders.length !== 1) return null
  const expected = folders[0]!
  const sessionReal = realpathOrNull(session.cwd)
  if (!sessionReal) return null
  for (const candidate of cursorWorkspaceSpellings(session.cwd)) {
    if (encodeCursorWorkspaceSlug(candidate) !== expected) continue
    const candidateReal = realpathOrNull(candidate)
    if (!candidateReal || candidateReal !== sessionReal) continue
    if (!dirExists(candidate) && !dirExists(candidateReal)) continue
    const still = transcriptFoldersFor(threadId, dirs.cursorProjectsDir)
    if (still.length !== 1 || still[0] !== expected) return null
    return candidate
  }
  return null
}

export function cursorTranscriptPath(
  threadId: string,
  projectsDir: string,
): string | null {
  const folders = transcriptFoldersFor(threadId, projectsDir)
  if (folders.length !== 1) return null
  return join(projectsDir, folders[0]!, 'agent-transcripts', threadId, `${threadId}.jsonl`)
}
