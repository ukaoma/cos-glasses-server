// Which model a Cursor session runs on, read from Cursor's own stores (6.62.0, plans 1.8 + 3.3).
//
// WHY. `agent -p --resume <id>` WITHOUT `--model` runs the GLOBAL CLI default, not the
// chat's model (canary C5: a composer chat resumed as grok when the default was grok). So
// a Continue that keeps the session's model has to read it and pass it. Flat slugs only:
// bracket ids (`grok-4.7[effort=low,fast=true]`) fail pre-flight (C5d).
//
// TWO STORES, TWO READS.
//   IDE composer  `globalStorage/state.vscdb`, table `cursorDiskKV`, key
//                 `composerData:<id>`, field `modelConfig` = `{modelName, selectedModels:
//                 [{modelId, parameters: [{id: 'reasoning_effort', value}, {id: 'fast'}]}]}`.
//                 The database is 8.9 GB: EXACT keys only, never a LIKE scan, in a query of
//                 its OWN (never shared with the names query, so a slow read here cannot blank
//                 the titles), 2 s timeout, 60 s cache per id (validation W17: 18 ms for 20).
//   CLI chat      `~/.cursor/chats/<hash>/<id>/store.db`: the newest blob naming
//                 `providerOptions.cursor.modelName`, already a flat slug. Opened
//                 `?mode=ro&immutable=1` (plain `mode=ro` fails SQLITE_CANTOPEN on these),
//                 which ignores the WAL, so the answer can trail by one turn. Cached on the
//                 file's (mtime, size). Its `meta` row also says whether COS created the chat
//                 in Ask mode, which a Run Everything Continue must name (W14).
//
// Every failure is "unknown": the field is omitted and the Continue falls back to
// composer-2.5-fast with a note. A read here never blocks a list.

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isValidNativeThreadId } from './native-thread-id.js'

const execFileAsync = promisify(execFile)

export const SQLITE3_BIN = '/usr/bin/sqlite3'
export const COMPOSER_MODEL_TTL_MS = 60_000
export const COMPOSER_MODEL_TIMEOUT_MS = 2_000
/** Keep the IN list bounded; a list page asks for at most a few dozen composers. */
const MAX_COMPOSER_IDS_PER_QUERY = 64
const MAX_CACHE_ENTRIES = 512

/** The fallback model when a session's own model cannot be read or is not listed. */
export const CURSOR_CONTINUE_FALLBACK_MODEL = 'composer-2.5-fast'

export interface CursorModelConfig {
  modelName?: unknown
  maxMode?: unknown
  selectedModels?: unknown
}

export interface ComposerFacts {
  modelConfig: CursorModelConfig | null
  /** `workspaceIdentifier.uri.fsPath`: the folder the composer runs in, when recorded. */
  workspace: string | null
}

const SLUG_PART_RE = /^[a-z0-9][a-z0-9.]*$/i
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i

function paramValue(parameters: unknown, id: string): string | null {
  if (!Array.isArray(parameters)) return null
  for (const entry of parameters) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { id?: unknown; value?: unknown }
    if (row.id !== id) continue
    if (typeof row.value === 'string') return row.value.trim()
    if (typeof row.value === 'boolean') return row.value ? 'true' : 'false'
  }
  return null
}

/**
 * Flat slugs for an IDE composer's model, most specific first: family, then
 * `-<reasoning_effort>`, then `-fast` (`grok-4.7` + xhigh + fast = `grok-4.7-xhigh-fast`).
 * The caller validates against the full `agent models` list and takes the first listed.
 */
export function cursorSlugCandidates(config: CursorModelConfig | null | undefined): string[] {
  if (!config || typeof config !== 'object') return []
  const selected = Array.isArray(config.selectedModels) ? config.selectedModels[0] as { modelId?: unknown; parameters?: unknown } | undefined : undefined
  const family = typeof selected?.modelId === 'string' && selected.modelId.trim()
    ? selected.modelId.trim()
    : typeof config.modelName === 'string' ? config.modelName.trim() : ''
  if (!family || !SLUG_RE.test(family)) return []
  const effort = paramValue(selected?.parameters, 'reasoning_effort')
  const fastRaw = paramValue(selected?.parameters, 'fast') ?? paramValue(selected?.parameters, 'speed')
  const fast = fastRaw === 'true' || fastRaw === 'fast'
  const usableEffort = effort && SLUG_PART_RE.test(effort) ? effort.toLowerCase() : null
  const out: string[] = []
  const push = (slug: string) => { if (SLUG_RE.test(slug) && !out.includes(slug)) out.push(slug) }
  if (usableEffort && fast) push(`${family}-${usableEffort}-fast`)
  if (usableEffort) push(`${family}-${usableEffort}`)
  if (fast) push(`${family}-fast`)
  push(family)
  return out
}

/** The first candidate the installed Cursor lists, or null. */
export function pickListedCursorModel(candidates: readonly string[], isKnown: (id: string) => boolean): string | null {
  for (const candidate of candidates) {
    try {
      if (isKnown(candidate)) return candidate
    } catch {
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// IDE composer: state.vscdb
// ---------------------------------------------------------------------------

const composerCache = new Map<string, { at: number; facts: ComposerFacts | null }>()

/** Tests only. */
export function __resetCursorSessionModelCachesForTests(): void {
  composerCache.clear()
  chatCache.clear()
  cursorModelReadStats.composerQueries = 0
  cursorModelReadStats.chatQueries = 0
}

export const cursorModelReadStats = { composerQueries: 0, chatQueries: 0 }

export type SqliteRunner = (args: readonly string[], timeoutMs: number) => Promise<string>

export const realSqliteRunner: SqliteRunner = async (args, timeoutMs) => {
  const { stdout } = await execFileAsync(SQLITE3_BIN, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Model config and workspace for each composer id, from ONE exact-key query. Ids that are
 * not native thread ids are dropped before they reach SQL. Cached 60 s per id, including a
 * miss, so a composer with no row is not re-queried on every poll.
 */
export async function readComposerFacts(
  ids: readonly string[],
  dbPath: string,
  options: { now?: number; run?: SqliteRunner } = {},
): Promise<Map<string, ComposerFacts | null>> {
  const now = options.now ?? Date.now()
  const out = new Map<string, ComposerFacts | null>()
  const wanted: string[] = []
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.toLowerCase() : ''
    if (!isValidNativeThreadId(id) || out.has(id) || wanted.includes(id)) continue
    const hit = composerCache.get(id)
    if (hit && now - hit.at < COMPOSER_MODEL_TTL_MS) out.set(id, hit.facts)
    else if (wanted.length < MAX_COMPOSER_IDS_PER_QUERY) wanted.push(id)
  }
  if (wanted.length === 0 || !dbPath) return out
  try {
    const st = await stat(dbPath)
    if (!st.isFile()) return out
  } catch {
    return out
  }
  const keys = wanted.map(id => `'composerData:${id}'`).join(',')
  const sql = `SELECT key AS k, json_extract(value, '$.modelConfig') AS mc, json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS ws FROM cursorDiskKV WHERE key IN (${keys})`
  let stdout: string
  try {
    cursorModelReadStats.composerQueries += 1
    stdout = await (options.run ?? realSqliteRunner)(['-readonly', '-json', dbPath, sql], COMPOSER_MODEL_TIMEOUT_MS)
  } catch {
    // Not cached: a timeout on a busy database should be retried on the next poll.
    return out
  }
  const found = new Map<string, ComposerFacts>()
  try {
    const rows = JSON.parse(stdout.trim() || '[]') as Array<{ k?: unknown; mc?: unknown; ws?: unknown }>
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = typeof row.k === 'string' ? row.k : ''
      const id = key.startsWith('composerData:') ? key.slice('composerData:'.length).toLowerCase() : ''
      if (!isValidNativeThreadId(id)) continue
      const mc = parseJsonText(row.mc)
      found.set(id, {
        modelConfig: mc && typeof mc === 'object' && !Array.isArray(mc) ? mc as CursorModelConfig : null,
        workspace: typeof row.ws === 'string' && row.ws.startsWith('/') && !row.ws.includes('\0') ? row.ws : null,
      })
    }
  } catch {
    return out
  }
  for (const id of wanted) {
    const facts = found.get(id) ?? null
    composerCache.delete(id)
    composerCache.set(id, { at: now, facts })
    out.set(id, facts)
  }
  while (composerCache.size > MAX_CACHE_ENTRIES) {
    const oldest = composerCache.keys().next()
    if (oldest.done) break
    composerCache.delete(oldest.value)
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI chat: store.db
// ---------------------------------------------------------------------------

export interface CliChatFacts {
  /** The newest `providerOptions.cursor.modelName`, a flat slug. */
  model: string | null
  /** The chat's `meta` mode (`ask`, `default`, …). */
  mode: string | null
}

const chatCache = new Map<string, { mtimeMs: number; size: number; facts: CliChatFacts | null }>()
const MODEL_NAME_RE = /"modelName"\s*:\s*"([^"\\]{1,100})"/g

function hexToText(hex: string): string | null {
  const clean = hex.trim()
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) return null
  try {
    return Buffer.from(clean, 'hex').toString('utf8')
  } catch {
    return null
  }
}

/** The chat's model and mode, or null when `store.db` cannot be read. */
export async function readCliChatFacts(
  chatDir: string,
  options: { run?: SqliteRunner } = {},
): Promise<CliChatFacts | null> {
  if (typeof chatDir !== 'string' || !chatDir.startsWith('/')) return null
  const dbPath = join(chatDir, 'store.db')
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(dbPath)
    if (!st.isFile()) return null
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  const hit = chatCache.get(dbPath)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.facts
  // A URI, so the path is percent-encoded: a chat dir under a folder with spaces is ordinary.
  const uri = `file:${encodeURI(dbPath).replace(/\?/g, '%3F').replace(/#/g, '%23')}?mode=ro&immutable=1`
  const run = options.run ?? realSqliteRunner
  let facts: CliChatFacts | null = null
  try {
    cursorModelReadStats.chatQueries += 1
    const blob = await run([uri, "SELECT CAST(data AS TEXT) FROM blobs WHERE instr(CAST(data AS TEXT), '\"modelName\"') > 0 ORDER BY rowid DESC LIMIT 1"], COMPOSER_MODEL_TIMEOUT_MS)
    let model: string | null = null
    for (const match of blob.matchAll(MODEL_NAME_RE)) {
      const candidate = match[1]!.trim()
      if (SLUG_RE.test(candidate)) model = candidate
    }
    let mode: string | null = null
    try {
      // The CLI stores the meta row as HEX of its JSON (measured on CLI 2026.10.01); a row
      // written as plain JSON is read as it is.
      const raw = (await run([uri, "SELECT CAST(value AS TEXT) FROM meta ORDER BY rowid ASC LIMIT 1"], COMPOSER_MODEL_TIMEOUT_MS)).trim()
      const text = raw.startsWith('{') ? raw : hexToText(raw)
      const meta = parseJsonText(text ?? '') as { mode?: unknown } | null
      if (meta && typeof meta.mode === 'string' && /^[a-z-]{1,24}$/i.test(meta.mode)) mode = meta.mode.toLowerCase()
    } catch {
      mode = null
    }
    facts = { model, mode }
  } catch {
    return null
  }
  chatCache.delete(dbPath)
  chatCache.set(dbPath, { mtimeMs, size, facts })
  while (chatCache.size > MAX_CACHE_ENTRIES) {
    const oldest = chatCache.keys().next()
    if (oldest.done) break
    chatCache.delete(oldest.value)
  }
  return facts
}

/**
 * The most recent write to a CLI chat (its `store.db`, the WAL beside it, or its agent
 * transcript), in epoch ms, or null. SYNCHRONOUS: the occupancy gate it feeds is.
 */
export function cliChatLastWriteMs(chatDir: string, transcriptPath: string | null): number | null {
  let latest: number | null = null
  for (const path of [join(chatDir, 'store.db'), join(chatDir, 'store.db-wal'), transcriptPath]) {
    if (!path) continue
    try {
      const mtimeMs = statSync(path).mtimeMs
      if (latest === null || mtimeMs > latest) latest = mtimeMs
    } catch { /* absent is fine */ }
  }
  return latest
}
