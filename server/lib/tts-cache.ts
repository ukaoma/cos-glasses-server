// In-memory + disk cache and session manager for the TTS progressive-download
// path.
//
// Why this exists: the v5.9.2 voice playback path replaces the old "fetch then
// play full Blob" model with a server-prepared session URL the browser sets as
// audio.src. iOS WKWebView progressive-decodes the chunked MP3, dropping
// time-to-first-audio from up to 15s to ~1s on long messages.
//
// Three responsibilities, one module:
//   1. Sessions: a UUID minted by POST /api/tts/prepare, peeked (not consumed)
//      by GET /api/tts/play so iOS can issue HTTP Range refills against the
//      same URL. Short-lived (60s TTL), reaped periodically.
//   2. Memory cache: completed audio bodies keyed by sha256(text+voice+format).
//      Repeat REPLAYs of the same message hit the cache and serve in ~50ms
//      with no OpenAI round-trip. LRU-evicted, byte-bounded.
//   3. Disk mirror (v5.9.5): every completed entry is also written to
//      server/data/tts-cache/<hash>.{mp3,json} so cache state SURVIVES server
//      restarts. On startup we scan sidecars and rebuild the LRU index
//      lazily — bodies are only read on first hit, not at boot. Two
//      independent eviction policies cap the on-disk footprint:
//        - Size LRU at TTS_DISK_CACHE_MAX_MB (default 1250, ~1.25 GB)
//        - Rolling age TTL at TTS_DISK_CACHE_MAX_AGE_DAYS (default 30)
//
// Bounds tuned for our usage pattern (one user, sequential clicks, replies
// roughly 200 KB-2 MB of MP3): in-memory 50 entries / 100 MB total. Disk is
// far larger. In-flight memory entries are pinned (never evicted) so the
// response stream and cache writer can't be pulled out from under each other.

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-fs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface CacheEntry {
  /** The audio body. NULL when the entry exists in the disk index but has not
   *  been hydrated from disk yet — first getCached() call lazily reads the
   *  MP3 file and populates this. */
  bytes: Buffer | null
  sizeBytes: number
  complete: boolean
  lastAccess: number
  /** When the entry was first written to disk (epoch ms). Used for age TTL
   *  eviction. Memory-only entries (in-flight or never persisted) carry the
   *  creation timestamp so they don't get spuriously evicted as "stale". */
  completedAt: number
  /** Voice + format are recorded so a future stats endpoint or admin tool can
   *  surface what's actually in the cache without re-deriving from the hash. */
  voice: string
  format: string
  /** True iff the body is mirrored to disk. Hot in-flight entries flip this
   *  to true once completeEntry() finishes the disk write. */
  onDisk: boolean
}

interface SessionEntry {
  hash: string
  text: string
  voice: string
  format: string
  expiresAt: number
}

interface DiskSidecar {
  voice: string
  format: string
  sizeBytes: number
  completedAt: number
}

const MAX_ENTRIES = 50
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100 MB — in-memory cap
const SESSION_TTL_MS = 60_000

/** Disk cache configuration (env-overridable). Defaults sized for "I run this
 *  on my laptop and forget about it for months" rather than a service tier.
 *  When TTS_DISK_CACHE_DIR is an absolute path it's used as-is; relative
 *  values resolve against server/data/. */
const DISK_DIR = (() => {
  const override = process.env.TTS_DISK_CACHE_DIR
  if (override && override.startsWith('/')) return override
  return resolve(__dirname, '..', 'data', override || 'tts-cache')
})()
const MAX_DISK_BYTES = Number(process.env.TTS_DISK_CACHE_MAX_MB ?? 1250) * 1024 * 1024
const MAX_AGE_DAYS = Number(process.env.TTS_DISK_CACHE_MAX_AGE_DAYS ?? 30)
const MAX_AGE_MS = Math.max(0, MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
/** Sweeper cadence — once per 24 hours. unref()'d below so an idle server can
 *  still exit cleanly. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

const cache = new Map<string, CacheEntry>()
const sessions = new Map<string, SessionEntry>()

/** Per-hash list of pending waiters. Each waiter is `{ resolve }` only — a
 *  null resolve means "treat as miss" so we never throw across cache code.
 *  Drained by completeEntry (resolve with served entry) and abortEntry
 *  (resolve null). v5.9.6 — needed so racing GETs against the same in-flight
 *  hash piggyback on the first OpenAI call instead of double-billing. */
const inFlightWaiters = new Map<string, Array<(e: ServedCacheEntry | null) => void>>()

let totalBytes = 0      // in-memory bytes (excludes disk-only entries)
let totalDiskBytes = 0  // on-disk bytes (sum of all sidecar sizeBytes)

/** Stable, content-addressed cache key. Includes voice and format so picking
 *  a different voice for the same text correctly misses (and gets its own
 *  entry). Hash is sha256 truncated to 16 hex chars — collision probability is
 *  ~negligible for our scale. */
export function hashKey(text: string, voice: string, format: string): string {
  return createHash('sha256').update(`${voice}\0${format}\0${text}`).digest('hex').slice(0, 16)
}

function ensureDiskDir(): void {
  try {
    if (!existsSync(DISK_DIR)) mkdirSync(DISK_DIR, { recursive: true })
  } catch (err) {
    console.error('[tts-cache] Failed to create disk cache dir:', DISK_DIR, err)
  }
}

function bodyPath(hash: string): string { return resolve(DISK_DIR, `${hash}.mp3`) }
function sidecarPath(hash: string): string { return resolve(DISK_DIR, `${hash}.json`) }

/** Read a sidecar from disk. Returns null on missing/corrupt — caller treats
 *  that as "no entry" and either falls through to OpenAI or skips the file. */
function readSidecar(hash: string): DiskSidecar | null {
  try {
    const raw = readFileSync(sidecarPath(hash), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DiskSidecar>
    if (
      typeof parsed.voice !== 'string' ||
      typeof parsed.format !== 'string' ||
      typeof parsed.sizeBytes !== 'number' ||
      typeof parsed.completedAt !== 'number'
    ) return null
    return {
      voice: parsed.voice,
      format: parsed.format,
      sizeBytes: parsed.sizeBytes,
      completedAt: parsed.completedAt,
    }
  } catch {
    return null
  }
}

function deleteDiskEntry(hash: string): number {
  let freed = 0
  try {
    if (existsSync(bodyPath(hash))) {
      try { freed = statSync(bodyPath(hash)).size } catch { /* ignore */ }
      unlinkSync(bodyPath(hash))
    }
  } catch (err) {
    console.warn('[tts-cache] Failed to unlink mp3 for', hash, err)
  }
  try {
    if (existsSync(sidecarPath(hash))) unlinkSync(sidecarPath(hash))
  } catch (err) {
    console.warn('[tts-cache] Failed to unlink sidecar for', hash, err)
  }
  return freed
}

/** On startup, scan the disk cache directory and build the in-memory index
 *  from sidecars only. Bodies (potentially up to ~1 GB total) stay on disk
 *  and are read lazily on first hit — startup stays fast. */
function loadFromDisk(): void {
  ensureDiskDir()
  let scanned = 0
  let indexed = 0
  try {
    const files = readdirSync(DISK_DIR)
    for (const fname of files) {
      if (!fname.endsWith('.json')) continue
      scanned++
      const hash = fname.slice(0, -'.json'.length)
      const side = readSidecar(hash)
      if (!side) continue
      // Trust the sidecar's recorded size — it's what was streamed when the
      // entry was first written. Re-stat'ing every body at boot would slow
      // startup linearly with cache size for no useful win.
      cache.set(hash, {
        bytes: null,
        sizeBytes: side.sizeBytes,
        complete: true,
        lastAccess: side.completedAt,
        completedAt: side.completedAt,
        voice: side.voice,
        format: side.format,
        onDisk: true,
      })
      totalDiskBytes += side.sizeBytes
      indexed++
    }
    if (scanned > 0) {
      console.log(`[tts-cache] Disk index loaded: ${indexed}/${scanned} sidecars (${(totalDiskBytes / (1024 * 1024)).toFixed(1)} MB on disk)`)
    }
  } catch (err) {
    console.warn('[tts-cache] Disk scan failed:', err)
  }
}

/** Persist a completed entry to disk. Best-effort — disk failures are logged
 *  but never block the response, since the in-memory cache still serves. */
function persistEntry(hash: string, entry: CacheEntry): void {
  if (!entry.bytes) return
  ensureDiskDir()
  const sidecar: DiskSidecar = {
    voice: entry.voice,
    format: entry.format,
    sizeBytes: entry.sizeBytes,
    completedAt: entry.completedAt,
  }
  try {
    atomicWriteFileSync(bodyPath(hash), entry.bytes)
    atomicWriteFileSync(sidecarPath(hash), JSON.stringify(sidecar))
    if (!entry.onDisk) totalDiskBytes += entry.sizeBytes
    entry.onDisk = true
  } catch (err) {
    console.warn('[tts-cache] Disk persist failed for', hash, err)
  }
}

/** A served (post-hydration) view of a cache entry — guaranteed non-null body. */
export interface ServedCacheEntry {
  bytes: Buffer
  sizeBytes: number
  voice: string
  format: string
  completedAt: number
}

/** Look up a cached entry; bumps lastAccess for LRU on hit. Returns null on
 *  miss OR if the entry exists but is still in-flight (incomplete).
 *
 *  Disk-hydration: an entry whose bytes are NULL exists in the index from a
 *  previous server run. We read the body lazily here so startup stays fast.
 *  After hydration the entry counts toward the in-memory cap and gets the
 *  same LRU treatment as a freshly-generated one. The returned ServedCacheEntry
 *  has a non-null `bytes` so callers don't need to re-narrow. */
export function getCached(hash: string): ServedCacheEntry | null {
  const entry = cache.get(hash)
  if (!entry || !entry.complete) return null

  if (!entry.bytes) {
    // Disk-only entry — hydrate. If the body is gone (manual delete, disk
    // corruption) drop the index entry and force a regenerate.
    try {
      if (!existsSync(bodyPath(hash))) {
        cache.delete(hash)
        totalDiskBytes -= entry.sizeBytes
        return null
      }
      entry.bytes = readFileSync(bodyPath(hash))
      entry.sizeBytes = entry.bytes.length
      totalBytes += entry.sizeBytes
    } catch (err) {
      console.warn('[tts-cache] Failed to hydrate', hash, 'from disk:', err)
      cache.delete(hash)
      return null
    }
  }

  entry.lastAccess = Date.now()
  const bytes = entry.bytes
  if (!bytes) return null
  const served: ServedCacheEntry = {
    bytes,
    sizeBytes: entry.sizeBytes,
    voice: entry.voice,
    format: entry.format,
    completedAt: entry.completedAt,
  }
  evictIfNeeded()
  return served
}

/** Reserve a new in-flight cache slot. Returns the entry the caller will write
 *  bytes into, or NULL if another caller already has an in-flight entry for
 *  this hash — in which case the caller should await waitForInFlight() and
 *  serve from the resulting cache rather than running its own OpenAI call.
 *
 *  Why null-on-conflict: v5.9.6 introduces parallel pre-warm from /prepare
 *  AND the legacy on-demand path from /play. Without this guard, two
 *  concurrent calls for the same hash would each start their own OpenAI
 *  request, double-bill, and race to write garbled bytes into the cache.
 *  The null return lets generateIntoCache cleanly piggyback on the existing
 *  in-flight entry.
 *
 *  Already-complete entries DO get clobbered (the caller explicitly wants to
 *  regenerate, e.g. after a hash collision unlikely though it is — keeps
 *  startEntry's contract close to its v5.9.5 behavior for that case). */
export function startEntry(hash: string, voice = 'unknown', format = 'mp3'): CacheEntry | null {
  const existing = cache.get(hash)
  if (existing && !existing.complete) {
    // Another writer already owns the slot — refuse to clobber. Caller will
    // waitForInFlight on this hash to receive the bytes once they finish.
    return null
  }
  if (existing) {
    if (existing.bytes) totalBytes -= existing.sizeBytes
    if (existing.onDisk) {
      totalDiskBytes -= existing.sizeBytes
      deleteDiskEntry(hash)
    }
    cache.delete(hash)
  }
  const now = Date.now()
  const entry: CacheEntry = {
    bytes: Buffer.alloc(0),
    sizeBytes: 0,
    complete: false,
    lastAccess: now,
    completedAt: now,
    voice,
    format,
    onDisk: false,
  }
  cache.set(hash, entry)
  return entry
}

/** Append a chunk to an in-flight entry. Cheap concat; small chunk sizes from
 *  OpenAI streaming (typically 1-4 KB) keep this O(N) over the response. */
export function appendBytes(hash: string, chunk: Buffer): void {
  const entry = cache.get(hash)
  if (!entry || entry.complete || !entry.bytes) return
  entry.bytes = Buffer.concat([entry.bytes, chunk])
  entry.sizeBytes = entry.bytes.length
}

/** Mark an in-flight entry as complete, mirror to disk, and run eviction.
 *  Also drains any pending waitForInFlight promises with the served entry. */
export function completeEntry(hash: string): void {
  const entry = cache.get(hash)
  if (!entry || entry.complete) return
  entry.complete = true
  entry.lastAccess = Date.now()
  entry.completedAt = entry.lastAccess
  totalBytes += entry.sizeBytes
  const served = toServed(hash, entry)
  persistEntry(hash, entry)
  evictIfNeeded()
  drainWaiters(hash, served)
}

/** Discard an in-flight entry that was aborted (client disconnect, OpenAI
 *  error, etc.). Prevents serving partial data on the next request for the
 *  same hash — instead the next request regenerates from scratch. */
export function abortEntry(hash: string): void {
  const entry = cache.get(hash)
  if (!entry) return
  if (entry.complete && entry.bytes) totalBytes -= entry.sizeBytes
  if (entry.onDisk) {
    totalDiskBytes -= entry.sizeBytes
    deleteDiskEntry(hash)
  }
  cache.delete(hash)
  drainWaiters(hash, null)
}

function toServed(hash: string, entry: CacheEntry): ServedCacheEntry | null {
  if (!entry.bytes) return null
  return {
    bytes: entry.bytes,
    sizeBytes: entry.sizeBytes,
    voice: entry.voice,
    format: entry.format,
    completedAt: entry.completedAt,
  }
}

function drainWaiters(hash: string, served: ServedCacheEntry | null): void {
  const waiters = inFlightWaiters.get(hash)
  if (!waiters || waiters.length === 0) return
  inFlightWaiters.delete(hash)
  for (const r of waiters) {
    try { r(served) } catch (err) { console.warn('[tts-cache] waiter threw:', err) }
  }
}

/** Wait for an in-flight entry to complete. Returns the served entry on
 *  success, null on miss/abort/timeout. Idempotent for already-complete
 *  entries — resolves immediately with the cached value.
 *
 *  Why this exists (v5.9.6): the new fast-prefix path pre-warms OpenAI from
 *  inside POST /api/tts/prepare. The very next GET /api/tts/play/<session>
 *  for the same hash would see an incomplete entry, fall through, and bill
 *  OpenAI a SECOND time for the same audio. waitForInFlight lets the GET
 *  piggyback on the in-flight pre-warm — only one billable call per hash. */
export function waitForInFlight(
  hash: string,
  timeoutMs = 30_000,
): Promise<ServedCacheEntry | null> {
  const entry = cache.get(hash)
  if (!entry) return Promise.resolve(null)
  // Already complete — same fast path as getCached (also bumps lastAccess).
  if (entry.complete) return Promise.resolve(getCached(hash))
  // Truly in-flight — register a waiter, race a timeout.
  return new Promise((resolve) => {
    let done = false
    const finish = (v: ServedCacheEntry | null) => {
      if (done) return
      done = true
      resolve(v)
    }
    const list = inFlightWaiters.get(hash) ?? []
    list.push(finish)
    inFlightWaiters.set(hash, list)
    setTimeout(() => finish(null), timeoutMs).unref()
  })
}

/** Evict completed entries (LRU by lastAccess) until under both caps:
 *  - In-memory: MAX_ENTRIES + MAX_TOTAL_BYTES (drops bytes only — disk copy
 *    survives, lazily re-hydrated on next hit).
 *  - On-disk: MAX_DISK_BYTES (deletes the body + sidecar AND drops the entry
 *    from the index so we don't 404 phantom hits).
 *  NEVER touches in-flight entries — they're pinned until completeEntry/abortEntry. */
function evictIfNeeded(): void {
  // 1. Trim in-memory bytes only (disk survives).
  const completed = [...cache.entries()]
    .filter(([, e]) => e.complete && e.bytes != null)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)
  let memoryEntryCount = completed.length
  if (memoryEntryCount > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    for (const [, entry] of completed) {
      if (memoryEntryCount <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break
      if (!entry.bytes) continue
      totalBytes -= entry.sizeBytes
      memoryEntryCount--
      entry.bytes = null  // keep index/sidecar alive — disk copy survives
    }
  }
  // 2. Trim disk bytes if over the on-disk cap.
  if (totalDiskBytes > MAX_DISK_BYTES) {
    const onDisk = [...cache.entries()]
      .filter(([, e]) => e.onDisk)
      .sort((a, b) => a[1].completedAt - b[1].completedAt)
    for (const [hash, entry] of onDisk) {
      if (totalDiskBytes <= MAX_DISK_BYTES) break
      if (entry.bytes) totalBytes -= entry.sizeBytes
      totalDiskBytes -= entry.sizeBytes
      deleteDiskEntry(hash)
      cache.delete(hash)
    }
  }
}

/** Rolling age TTL — unconditionally remove entries older than MAX_AGE_DAYS
 *  regardless of cache fullness. Run once on startup and every 24h. Set
 *  TTS_DISK_CACHE_MAX_AGE_DAYS=0 to disable. */
function sweepStaleByAge(): void {
  if (MAX_AGE_MS <= 0) return
  const cutoff = Date.now() - MAX_AGE_MS
  let evicted = 0
  let freedBytes = 0
  for (const [hash, entry] of [...cache.entries()]) {
    if (!entry.complete) continue  // never evict in-flight
    if (entry.completedAt > cutoff) continue
    if (entry.bytes) totalBytes -= entry.sizeBytes
    if (entry.onDisk) {
      totalDiskBytes -= entry.sizeBytes
      deleteDiskEntry(hash)
    }
    cache.delete(hash)
    evicted++
    freedBytes += entry.sizeBytes
  }
  if (evicted > 0) {
    console.log(`[tts-cache] Age sweep: evicted ${evicted} entr${evicted === 1 ? 'y' : 'ies'} older than ${MAX_AGE_DAYS}d (${(freedBytes / (1024 * 1024)).toFixed(1)} MB freed)`)
  }
}

/** Allocate a new session UUID pointing at a (hash, text, voice, format)
 *  bundle. The play route consumes the session; expired sessions are reaped
 *  by the periodic sweeper below. */
export function createSession(s: Omit<SessionEntry, 'expiresAt'>): string {
  const uuid = randomUUID()
  sessions.set(uuid, { ...s, expiresAt: Date.now() + SESSION_TTL_MS })
  return uuid
}

/** Look up a session WITHOUT deleting it. Returns null if unknown or expired.
 *
 *  Why non-destructive (changed in v5.9.4): iOS WKWebView's HTML5 audio engine
 *  issues HTTP Range requests against `audio.src` to refill its play buffer
 *  every few seconds during longer responses. The original one-shot design
 *  caused the second (and every subsequent) request to 404, freezing playback
 *  partway through. Sessions still expire on the existing 60s TTL, so the
 *  practical exposure window is unchanged — they're just re-readable inside
 *  that window.
 *
 *  An explicit consumeSession() variant remains below for any future caller
 *  that wants strict one-shot semantics; today's /play handler does not. */
export function peekSession(uuid: string): SessionEntry | null {
  const s = sessions.get(uuid)
  if (!s) return null
  if (s.expiresAt < Date.now()) {
    sessions.delete(uuid)
    return null
  }
  return s
}

/** Strict one-shot lookup — kept for callers that want to invalidate the
 *  session immediately on first read. Not used by /play in v5.9.4+. */
export function consumeSession(uuid: string): SessionEntry | null {
  const s = peekSession(uuid)
  if (s) sessions.delete(uuid)
  return s
}

/** Periodic sweeper — run on a setInterval to clear out sessions the client
 *  never followed up on. Called by the route module on startup. */
export function reapExpiredSessions(): void {
  const now = Date.now()
  for (const [uuid, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(uuid)
  }
}

/** Diagnostics — exposed via GET /api/tts/budget for at-a-glance monitoring. */
export interface CacheStats {
  entries: number
  completed: number
  totalBytes: number
  totalMB: number
  sessions: number
  capEntries: number
  capBytes: number
  disk: {
    entries: number
    totalBytes: number
    totalMB: number
    capMB: number
    /** Days since the oldest disk entry was completed. NaN-safe: 0 when empty. */
    oldestAgeDays: number
    ttlDays: number
  }
}

export function getCacheStats(): CacheStats {
  let completed = 0
  let diskEntries = 0
  let oldestCompletedAt: number | null = null
  for (const e of cache.values()) {
    if (e.complete) completed++
    if (e.onDisk) {
      diskEntries++
      if (oldestCompletedAt === null || e.completedAt < oldestCompletedAt) {
        oldestCompletedAt = e.completedAt
      }
    }
  }
  const oldestAgeDays = oldestCompletedAt
    ? Math.round(((Date.now() - oldestCompletedAt) / (24 * 60 * 60 * 1000)) * 10) / 10
    : 0
  return {
    entries: cache.size,
    completed,
    totalBytes,
    totalMB: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
    sessions: sessions.size,
    capEntries: MAX_ENTRIES,
    capBytes: MAX_TOTAL_BYTES,
    disk: {
      entries: diskEntries,
      totalBytes: totalDiskBytes,
      totalMB: Math.round((totalDiskBytes / (1024 * 1024)) * 100) / 100,
      capMB: Math.round(MAX_DISK_BYTES / (1024 * 1024)),
      oldestAgeDays,
      ttlDays: MAX_AGE_DAYS,
    },
  }
}

// ── Module bootstrap ────────────────────────────────────────────
// Hydrate the disk index immediately so first GET /api/tts/play/:session
// after a restart can see the index and serve from disk. Then schedule the
// rolling age sweeper (unref()'d so it never blocks process exit).

loadFromDisk()
sweepStaleByAge()
if (MAX_AGE_MS > 0) {
  setInterval(sweepStaleByAge, SWEEP_INTERVAL_MS).unref()
}
