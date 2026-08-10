// GET /api/session-index        — COS conversation sessions, compact list
// GET /api/session-index/:id    — one session, full detail
//
// PORTED, NOT COPIED. This route lived only in the private cos-glasses-app repo
// and was never carried into the published package, so the companion's Sessions
// tab has been calling a 404 since the managed-runtime cutover — the same class of
// gap as the stranded voice profiles, the npmignore-excluded speaker model, and the
// stranded .cos-profile.json.
//
// WHY PORT RATHER THAN RETIRE. `/api/sessions/recent` looks like a duplicate and is
// not. It returns {id, exchangeCount, lastActivity, createdAt, modelPreference,
// lastQuery} from an IN-MEMORY map on a 24-hour window, so it carries no `domain`,
// no `device_id`, gives `lastQuery` where the companion wants `first_prompt`, dies
// on restart, and has no counterpart at all for the detail view's `tools_used`,
// `files_touched`, `git_branch` and token counts. The cache this route reads is
// disk-backed and already WRITTEN by the published package
// (lib/session-cache-writer.ts), so only the reader was missing.
//
// FOUR DEFECTS IN THE ORIGINAL, all fixed here and all measured on real data
// (37,700 servable entries across 5 cache files on this machine):
//
//  1. An unset COS_SCRIPTS_DIR returned `[]`, so a standalone npm install answered
//     200 with an empty list — indistinguishable from "you have no sessions". It is
//     now 503 with `reason: pythonBridgeState()`, matching routes/memory.ts.
//  2. `res.status(500).json({ error: err.message })` leaked filesystem paths. No
//     other router in this repo does that.
//  3. Synchronous `readdirSync`/`readFileSync` of 31.7 MB on EVERY request, the
//     detail endpoint included, which parsed all of it to find one row. This
//     process also streams live audio, so that blocked the event loop. Now async
//     and cached against file identity.
//  4. The filename filter matched iCloud sync-conflict duplicates. On this machine
//     `.session_index_cache_Ukaoma-Mac-Studio 3.json` shares 543 of its 602 rows
//     with the canonical file, so the merged list served 543 duplicates. Filtering
//     ` N` filenames out would be wrong in the other direction: ` 2.json` holds 245
//     rows that appear nowhere else. Dedupe therefore happens by session_id, newest
//     wins, and every file is still read.

import { Router } from 'express'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { COS_SCRIPTS_DIR, pythonBridgeState } from '../lib/python-bridge.js'

export const sessionIndexRouter = Router()

const CACHE_PREFIX = '.session_index_cache_'
/** Guard against a pathological cache file. 37,700 entries measured; 250k is slack. */
const MAX_ENTRIES = 250_000

export interface SessionEntry {
  session_id: string
  glasses_session_id: string
  slug: string
  created: string
  modified: string
  duration_minutes: number
  message_count: number
  first_prompt: string
  domain: string
  device_id: string
}

interface RawEntry extends Record<string, unknown> {
  session_id: string
  slug: string
}

/**
 * Parse-cache keyed on the identity of the files themselves.
 *
 * 31.7 MB of JSON is too much to re-parse per request, and this data changes only
 * when the Python side rewrites a cache file. The key is every file's name, size and
 * mtime, so any write invalidates it without a timer and without serving staleness.
 */
let parseCache: { key: string; entries: RawEntry[] } | null = null

async function cacheFileIdentity(dir: string): Promise<{ key: string; files: string[] }> {
  const names = (await readdir(dir))
    .filter(f => f.startsWith(CACHE_PREFIX) && f.endsWith('.json') && !f.endsWith('.lock'))
    .sort()
  const parts: string[] = []
  const files: string[] = []
  for (const name of names) {
    try {
      const st = await stat(join(dir, name))
      if (!st.isFile()) continue
      parts.push(`${name}:${st.size}:${st.mtimeMs}`)
      files.push(name)
    } catch { /* vanished between readdir and stat: normal, skip it */ }
  }
  return { key: parts.join('|'), files }
}

/**
 * Every entry across every cache file, deduplicated by session_id.
 *
 * Newest wins, measured by `modified` and then `_file_mtime`. Without this the
 * iCloud duplicate described in the header serves the same session twice.
 */
async function readAllSessionCaches(dir: string): Promise<RawEntry[]> {
  const { key, files } = await cacheFileIdentity(dir)
  if (parseCache && parseCache.key === key) return parseCache.entries

  const byId = new Map<string, RawEntry>()
  for (const name of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf-8'))
    } catch {
      // Unreadable or torn mid-write. One bad file must not empty the whole list.
      continue
    }
    const sessions = (parsed as { sessions?: unknown })?.sessions
    if (!sessions || typeof sessions !== 'object') continue
    for (const value of Object.values(sessions as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as RawEntry
      if (typeof entry.session_id !== 'string' || !entry.session_id) continue
      if (typeof entry.slug !== 'string' || !entry.slug) continue
      const existing = byId.get(entry.session_id)
      if (!existing || freshness(entry) > freshness(existing)) byId.set(entry.session_id, entry)
      if (byId.size >= MAX_ENTRIES) break
    }
  }
  const entries = [...byId.values()]
  parseCache = { key, entries }
  return entries
}

/** Sort key for "which copy of this session is the real one". */
function freshness(entry: RawEntry): number {
  const modified = typeof entry.modified === 'string' ? Date.parse(entry.modified) : Number.NaN
  if (Number.isFinite(modified)) return modified
  const fileMtime = Number(entry._file_mtime)
  return Number.isFinite(fileMtime) ? fileMtime : 0
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Unset COS_SCRIPTS_DIR means standalone: say so, never answer with an empty list. */
function unavailable(res: import('express').Response): void {
  res.status(503).json({
    available: false,
    reason: pythonBridgeState(),
    sessions: [],
    total: 0,
    devices: [],
  })
}

sessionIndexRouter.get('/session-index', async (req, res) => {
  if (!COS_SCRIPTS_DIR) { unavailable(res); return }
  try {
    const limit = boundedInteger(req.query.limit, 30, 1, 50)
    const domainFilter = str(req.query.domain, 'all') || 'all'
    const deviceFilter = str(req.query.device, 'all') || 'all'
    const sidFilter = str(req.query.sid)

    const all = await readAllSessionCaches(COS_SCRIPTS_DIR)
    const sessions: SessionEntry[] = []
    const devices = new Set<string>()

    for (const entry of all) {
      const domain = str(entry.domain, 'unknown') || 'unknown'
      const deviceId = str(entry.device_id, 'unknown') || 'unknown'
      const glassesId = str(entry.glasses_session_id)
      if (domainFilter !== 'all' && domain !== domainFilter) continue
      if (deviceFilter !== 'all' && deviceId !== deviceFilter) continue
      if (sidFilter && !glassesId.startsWith(sidFilter)) continue

      // Collected from the FILTERED set on purpose, so the device picker offers only
      // devices that can actually produce rows under the current filters.
      if (deviceId !== 'unknown') devices.add(deviceId)

      sessions.push({
        session_id: entry.session_id,
        glasses_session_id: glassesId,
        slug: entry.slug,
        created: str(entry.created),
        modified: str(entry.modified),
        duration_minutes: num(entry.duration_minutes),
        message_count: num(entry.message_count),
        first_prompt: str(entry.first_prompt),
        domain,
        device_id: deviceId,
      })
    }

    sessions.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''))
    res.set('Cache-Control', 'private, no-store')
    res.json({ sessions: sessions.slice(0, limit), total: sessions.length, devices: [...devices] })
  } catch (error) {
    // Detail to the operator's log, never to the client: err.message here is a
    // filesystem path.
    console.error(`[session-index] list failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read session index', reason: 'session_index_read_failed' })
  }
})

sessionIndexRouter.get('/session-index/:session_id', async (req, res) => {
  if (!COS_SCRIPTS_DIR) { unavailable(res); return }
  try {
    const wanted = String(req.params.session_id ?? '')
    if (!wanted) {
      res.status(400).json({ error: 'session_id required', reason: 'missing_session_id' })
      return
    }
    const all = await readAllSessionCaches(COS_SCRIPTS_DIR)
    // Exact id, then the original glasses UUID, then a UUID prefix — the companion
    // links by whichever it happens to hold.
    const entry = all.find(e => e.session_id === wanted)
      ?? all.find(e => str(e.glasses_session_id) === wanted)
      ?? all.find(e => wanted.length >= 6 && str(e.glasses_session_id).startsWith(wanted))
    if (!entry) {
      res.status(404).json({ error: 'Session not found', reason: 'session_not_found' })
      return
    }
    res.set('Cache-Control', 'private, no-store')
    res.json({
      session_id: entry.session_id,
      glasses_session_id: str(entry.glasses_session_id),
      slug: str(entry.slug),
      created: str(entry.created),
      modified: str(entry.modified),
      duration_minutes: num(entry.duration_minutes),
      user_message_count: num(entry.user_message_count),
      assistant_message_count: num(entry.assistant_message_count),
      message_count: num(entry.message_count),
      first_prompt: str(entry.first_prompt),
      tools_used: (entry.tools_used && typeof entry.tools_used === 'object') ? entry.tools_used : {},
      files_touched: Array.isArray(entry.files_touched) ? entry.files_touched : [],
      domain: str(entry.domain, 'unknown') || 'unknown',
      git_branch: str(entry.git_branch, 'unknown') || 'unknown',
      has_subagents: entry.has_subagents === true,
      total_input_tokens: num(entry.total_input_tokens),
      total_output_tokens: num(entry.total_output_tokens),
      file_size_bytes: num(entry.file_size_bytes),
      device_id: str(entry.device_id, 'unknown') || 'unknown',
    })
  } catch (error) {
    console.error(`[session-index] detail failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read session index', reason: 'session_index_read_failed' })
  }
})

/** Test seam: drop the parse cache between cases. */
export function __resetSessionIndexCache(): void {
  parseCache = null
}
