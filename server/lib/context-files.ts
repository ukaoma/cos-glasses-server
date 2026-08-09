// Memory and Threads from plain markdown, with no venv, bridge, or vector store.
//
// WHY. Meetings became adoptable when the requirement collapsed to "markdown files
// in folders" — any domain name, any capitalisation, spaces allowed, with the only
// structural demand being a YYYY-MM directory because that is the shape the lister
// reads. Memory and Threads never got that treatment: the COS Data picker requires
// `operations/scripts/cos_api_bridge.py` AND an executable `venv/bin/python3`, and
// below that sit Docker and OpenAI embeddings. So the honest answer to "how do I
// start using memory?" was "clone a workspace and run a vector database."
//
// BACKWARDS COMPATIBILITY IS STRUCTURAL, NOT PROMISED. This module is only ever
// reached from `standaloneNoop` — the branch `callPython` takes when the bridge is
// ABSENT. An install with a working bridge never enters this code at all, so its
// behaviour cannot change. That is deliberate: the alternative, a resolver that
// merges both sources, would put new code in the path of an existing setup.
//
// The files are also the IMPORT surface. Someone brings notes in their own shape,
// COS reads them immediately, and later indexes those same files into their own
// vector store. The files were always the substrate — which is exactly why an
// amendment must write only here and never to the derived store.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

/** Where a file-tier install keeps its notes, relative to the chosen COS Data dir. */
const MEMORY_DIRS = ['memory', 'memories'] as const
const THREAD_DIRS = ['threads', 'thread'] as const

/** Bounded so a large folder cannot make a G2 browse slow or a payload huge. */
const MAX_FILES_SCANNED = 2_000
const MAX_BODY_CHARS = 32_000
const SUMMARY_CHARS = 240

/**
 * Date embedded in a filename, e.g. `2026-08-09-decision.md` or
 * `2026-08-09_thing.md`. Used for ordering before falling back to mtime, because a
 * filename date survives a file copy and mtime does not.
 */
const FILENAME_DATE = /(\d{4})-(\d{2})-(\d{2})/

export interface FileMemory {
  id: string
  type: string
  summary: string
  content: string
  created_at: string
  domain: string
  refs: Record<string, string[]>
  reference_available: true
}

export interface FileThread {
  id: string
  name: string
  domain: string
  is_manual: boolean
  topics: string[]
  meeting_count: number
  first_seen: string
  last_seen: string
  velocity: string
  age_days: number
  is_stale: boolean
  is_resolved: boolean
  meetings: Array<{ name: string; date: string }>
  manual_updates: Array<{ content: string; timestamp: string; source: string }>
  stakeholders: string[]
  milestones: string[]
  sources: string[]
  target_date: string
  serves_goal: string
  created_at: string
  created_by: string
  access_count: number
  reference_available: true
}

/** First existing candidate directory, or null. */
function findDir(root: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = join(root, name)
    try { if (statSync(candidate).isDirectory()) return candidate } catch { /* next */ }
  }
  return null
}

/** Extensions the readers treat as notes. */
const NOTE_EXTENSIONS = ['.md', '.markdown', '.txt']

/**
 * Every markdown file under `dir`, recursively, bounded, FOLLOWING SYMLINKS.
 *
 * Any nesting is accepted on purpose — a user's notes may be organised by year, by
 * project, or not at all, and rejecting a shape is what made COS Data unusable for
 * anyone but its author.
 *
 * SYMLINKS ARE FIRST-CLASS, and that is a correction. A `Dirent` reports a symlink
 * as `isSymbolicLink()`, NOT as `isDirectory()` or `isFile()`, so the first version
 * of this walk silently skipped every linked file and linked subfolder. Queen hit
 * exactly that on 2026-08-09: she wired `operations/memory` at her real note store
 * with a symlink, which worked only because `findDir` uses `statSync` and follows
 * links — anything linked one level deeper would have vanished with no error.
 *
 * Attaching notes that live somewhere else is a PRIMARY use case, not an edge case,
 * so a link has to behave like the thing it points at.
 *
 * Cycles are the cost of following them: `a -> ../a` recurses forever. Every
 * directory is recorded by its resolved real path and visited once, which also
 * stops the same store being counted twice when two links reach it.
 *
 * There is deliberately NO depth limit. An earlier draft capped nesting at 16 as
 * "bounding a pathological tree", but real-path identity already makes cycles
 * terminate and MAX_FILES_SCANNED already bounds the work — so the cap's only real
 * effect was to silently hide notes nested deeper than that. That is the same
 * invisible-skip defect this function was just fixed for, moved further out, and a
 * mutation removing the cap changed no test, which is how it got noticed.
 */
function walkMarkdown(
  dir: string,
  budget = { left: MAX_FILES_SCANNED },
  seen: Set<string> = new Set(),
): string[] {
  const out: string[] = []
  // Identity by real path, so a link and its target are the same directory.
  let real: string
  try { real = realpathSync(dir) } catch { return out }
  if (seen.has(real)) return out
  seen.add(real)

  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (budget.left <= 0) break
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    const isNote = NOTE_EXTENSIONS.includes(extname(entry.name).toLowerCase())
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, budget, seen))
    } else if (entry.isFile()) {
      if (!isNote) continue
      budget.left -= 1
      out.push(full)
    } else if (entry.isSymbolicLink()) {
      // Resolve to decide: a linked folder is walked, a linked note is read.
      let target: import('node:fs').Stats
      try { target = statSync(full) } catch { continue }   // broken link, skip quietly
      if (target.isDirectory()) {
        out.push(...walkMarkdown(full, budget, seen))
      } else if (target.isFile() && isNote) {
        budget.left -= 1
        out.push(full)
      }
    }
  }
  return out
}

/** Minimal YAML-ish front matter. Absent or malformed degrades to {}. */
function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const raw = text.slice(3, end)
  const data: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (key) data[key] = value
  }
  return { data, body: text.slice(end + 4).replace(/^\n+/, '') }
}

/** ISO date for ordering: front matter, else filename, else mtime. */
function resolveDate(path: string, front: Record<string, string>): string {
  const explicit = front.date || front.created_at || front.created
  if (explicit && /^\d{4}-\d{2}-\d{2}/.test(explicit)) return explicit
  const m = FILENAME_DATE.exec(basename(path))
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  try { return new Date(statSync(path).mtimeMs).toISOString() } catch { return '' }
}

/**
 * Stable id for a file-backed record.
 *
 * Derived from the path so it survives restarts and can be resolved back to a file
 * without an index. Prefixed `file_` so it can never be mistaken for a `mem_` id
 * from the vector store — two different stores must not share an id space.
 */
function fileId(root: string, path: string): string {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\//, '') : basename(path)
  const safe = rel.replace(/[^A-Za-z0-9._-]+/g, '_')
  // MEMORY_ID_PATTERN caps the id at 120 characters after the prefix and
  // `cleanContextText` truncates at 128, so a deep path must be shortened HERE.
  // Truncating alone would collide across two long sibling paths and resolve the
  // wrong note, so the discarded head is folded into a short hash.
  if (safe.length <= 100) return `file_${safe}`
  let hash = 5381
  for (let i = 0; i < safe.length; i++) hash = ((hash * 33) ^ safe.charCodeAt(i)) >>> 0
  return `file_${hash.toString(36)}_${safe.slice(-88)}`
}

function firstHeading(body: string): string {
  for (const line of body.split('\n')) {
    const m = /^#{1,3}\s+(.+)$/.exec(line.trim())
    if (m) return m[1].trim()
  }
  return ''
}

function summarise(body: string): string {
  const flat = body.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim()
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS)}…`
}

/** Newest first, by resolved date then path for determinism. */
function byNewest<T extends { created_at: string; id: string }>(a: T, b: T): number {
  return b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)
}

function envPath(name: string): string | null {
  const raw = process.env[name]?.trim()
  return raw ? resolve(raw) : null
}

/**
 * Where this install keeps plain-text notes, or null.
 *
 * Candidates in priority order, first one holding a `memory/` or `threads/`
 * folder wins. Env is read on every call rather than captured at import, so a
 * COS Control settings change followed by a restart-free re-read behaves, and so
 * tests can point it somewhere without module-load ordering games.
 *
 * `COS_MEETINGS_ROOT` contributes its PARENT as well as itself, because a direct
 * meetings library is `.../personal/meetings` while notes sit beside it at
 * `.../personal/memory`.
 *
 * The data home is last and is the zero-configuration answer: someone with no
 * COS repo at all can `mkdir ~/.cos-glasses/memory` and start browsing. It is
 * also the only candidate guaranteed to survive a server update, which is where
 * anything durable belongs.
 */
export function resolveContextFilesRoot(): string | null {
  // An EXPLICIT setting is exclusive, including when it turns out to hold nothing.
  // Falling through from an empty explicit root to the data home would mean a
  // user who pointed us at one folder could be served notes from another, and it
  // would make every test's answer depend on whether `~/.cos-glasses/memory`
  // happens to exist on the machine running it.
  const explicit = envPath('COS_CONTEXT_DIR')
  if (explicit) {
    return hasFileMemory(explicit) || hasFileThreads(explicit) ? explicit : null
  }
  const meetings = envPath('COS_MEETINGS_ROOT')
  const scripts = envPath('COS_SCRIPTS_DIR')
  const dataHome = envPath('COS_DATA_DIR') ?? join(homedir(), '.cos-glasses')
  const candidates = [
    envPath('COS_OPERATIONS_DIR'),
    meetings,
    meetings ? dirname(meetings) : null,
    scripts ? dirname(scripts) : null,
    dataHome,
  ]
  for (const candidate of candidates) {
    if (candidate && (hasFileMemory(candidate) || hasFileThreads(candidate))) return candidate
  }
  return null
}

/** Markdown files under `dir` with content, counted without reading any of them. */
function countMarkdown(dir: string | null): number {
  if (!dir) return 0
  let total = 0
  for (const path of walkMarkdown(dir)) {
    // `size > 0` instead of a read: this runs on the status route, which the
    // companion polls, and reading every note to produce one integer is how a
    // browse surface becomes a performance problem. A whitespace-only file is
    // counted here but skipped by the readers, so the total can exceed the
    // browsable list by the number of blank files. That is the only known
    // discrepancy and it is bounded by files the user created empty.
    try { if (statSync(path).size > 0) total += 1 } catch { /* vanished */ }
  }
  return total
}

/**
 * Counts for the status surface.
 *
 * Memory is counted by path. Threads are READ, because the status header needs
 * the active/resolved split and `status: resolved` lives in front matter — and a
 * thread store is one file per project, so tens of files, not thousands. The
 * MAX_FILES_SCANNED bound still applies.
 */
export function fileTierStatus(root: string | null): {
  memory: { present: boolean; total: number }
  threads: { present: boolean; total: number; active: number; resolved: number }
} {
  const memoryDir = root ? findDir(root, MEMORY_DIRS) : null
  const threads = root && hasFileThreads(root) ? readFileThreads(root, MAX_FILES_SCANNED) : []
  return {
    memory: { present: !!memoryDir, total: countMarkdown(memoryDir) },
    threads: {
      present: !!root && hasFileThreads(root),
      total: threads.length,
      active: threads.filter(t => !t.is_resolved).length,
      resolved: threads.filter(t => t.is_resolved).length,
    },
  }
}

/** Is a file-backed memory store present under this root? */
export function hasFileMemory(root: string | null): boolean {
  return !!root && findDir(root, MEMORY_DIRS) !== null
}

/** Is a file-backed thread store present under this root? */
export function hasFileThreads(root: string | null): boolean {
  return !!root && findDir(root, THREAD_DIRS) !== null
}

/**
 * Memories from markdown, newest first.
 *
 * `type` comes from front matter when present, else the containing folder name,
 * else 'note' — a folder called `decisions/` is a reasonable signal and asking the
 * user to add front matter before anything works would defeat the point.
 */
export function readFileMemories(root: string, limit = 30): FileMemory[] {
  const dir = findDir(root, MEMORY_DIRS)
  if (!dir) return []
  const out: FileMemory[] = []
  for (const path of walkMarkdown(dir)) {
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { continue }
    const { data, body } = parseFrontMatter(text)
    const trimmed = body.trim()
    if (!trimmed) continue
    const parent = basename(join(path, '..'))
    out.push({
      id: data.id || fileId(root, path),
      type: (data.type || (parent && parent !== basename(dir) ? parent : '') || 'note').toLowerCase(),
      summary: data.summary || firstHeading(trimmed) || summarise(trimmed),
      content: trimmed.slice(0, MAX_BODY_CHARS),
      created_at: resolveDate(path, data),
      domain: data.domain || '',
      refs: {},
      reference_available: true,
    })
  }
  return out.sort(byNewest).slice(0, Math.max(1, limit))
}

/** One file-backed memory by its `file_` id, or null. */
export function readFileMemoryById(root: string, id: string): FileMemory | null {
  // Scanning rather than path-reconstructing: the id is sanitised, so mapping it
  // back to a path would mean trusting a lossy transform to address the filesystem.
  return readFileMemories(root, MAX_FILES_SCANNED).find(m => m.id === id) ?? null
}

/** Total count and per-type split, for the overview surface. */
export function fileMemoryOverview(root: string): { total: number; by_type: Record<string, number> } {
  const all = readFileMemories(root, MAX_FILES_SCANNED)
  const by_type: Record<string, number> = {}
  for (const m of all) by_type[m.type] = (by_type[m.type] ?? 0) + 1
  return { total: all.length, by_type }
}

/**
 * Threads from markdown, newest first.
 *
 * Every derived field a vector-tier thread carries is present and honestly empty —
 * velocity '', meeting_count 0 — rather than absent, so the same display code
 * renders both tiers without branching. A file thread has no computed velocity
 * because nothing computed it; that is a real difference, not a missing value to
 * be invented.
 */
export function readFileThreads(root: string, limit = 30): FileThread[] {
  const dir = findDir(root, THREAD_DIRS)
  if (!dir) return []
  const out: FileThread[] = []
  for (const path of walkMarkdown(dir)) {
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { continue }
    const { data, body } = parseFrontMatter(text)
    const trimmed = body.trim()
    if (!trimmed) continue
    const created = resolveDate(path, data)
    const topics = (data.topics || data.tags || '')
      .split(/[,;]/).map(t => t.trim()).filter(Boolean)
    out.push({
      id: data.id || fileId(root, path),
      name: data.name || data.title || firstHeading(trimmed) || basename(path, extname(path)),
      domain: data.domain || '',
      is_manual: true,
      topics,
      meeting_count: 0,
      first_seen: created,
      last_seen: created,
      velocity: '',
      age_days: 0,
      is_stale: false,
      is_resolved: (data.status || '').toLowerCase() === 'resolved',
      meetings: [],
      manual_updates: [{ content: trimmed.slice(0, MAX_BODY_CHARS), timestamp: created, source: 'file' }],
      stakeholders: (data.stakeholders || '').split(/[,;]/).map(s => s.trim()).filter(Boolean),
      milestones: [],
      sources: [],
      target_date: data.target_date || '',
      serves_goal: data.goal || data.serves_goal || '',
      created_at: created,
      created_by: data.created_by || 'file',
      access_count: 0,
      reference_available: true,
    })
  }
  return out.sort(byNewest).slice(0, Math.max(1, limit))
}

/** One file-backed thread by id, or null. */
export function readFileThreadById(root: string, id: string): FileThread | null {
  return readFileThreads(root, MAX_FILES_SCANNED).find(t => t.id === id) ?? null
}

/** Does this root hold anything the file tier can serve? */
export function fileTierState(root: string | null): 'ready' | 'empty' | 'absent' {
  if (!root || !existsSync(root)) return 'absent'
  const dirs = [findDir(root, MEMORY_DIRS), findDir(root, THREAD_DIRS)].filter((d): d is string => !!d)
  if (dirs.length === 0) return 'absent'
  // Existence, not content: `walkMarkdown` stops at the first hit, so this stays
  // a couple of readdir calls even on a large tree. 'empty' is a HEALTHY state —
  // a configured store with nothing in it yet — and must be distinguishable from
  // 'absent', which is what the picker and the wizard branch on.
  const any = dirs.some(dir => walkMarkdown(dir, { left: 1 }).length > 0)
  return any ? 'ready' : 'empty'
}
