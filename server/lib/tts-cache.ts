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
  /** One-shot OpenAI opt-in for this session (play cold-miss must honor it). */
  preferOpenAI?: boolean
  /** Settings forced Local/Kokoro — do not auto-escape to OpenAI on play miss. */
  forceLocal?: boolean
  /** Idle deadline. Pushed out on every read; never past `hardExpiresAt`. */
  expiresAt: number
  /** Absolute deadline, fixed at creation. Reading never extends it. */
  hardExpiresAt: number
}

interface DiskSidecar {
  voice: string
  format: string
  sizeBytes: number
  completedAt: number
}

const MAX_ENTRIES = 50
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100 MB — in-memory cap
/**
 * IDLE timeout, not a lifetime. Refreshed on every read.
 *
 * It was a fixed 60s from creation, which silently capped PLAYBACK at 60
 * seconds: iOS WKWebView re-requests `audio.src` every few seconds to refill
 * its decode buffer, and once the session expired those refills 404'd and the
 * audio simply stopped. Measured on this machine, 250 characters is 14 seconds
 * of speech and 4,000 characters is 211 -- so any reply over roughly 1,100
 * characters outlived its own session and cut off mid-sentence.
 *
 * v5.9.4 made reads non-destructive for exactly this reason and stopped one
 * step short, noting "sessions still expire on the existing 60s TTL, so the
 * practical exposure window is unchanged". That was true, and it is also what
 * left the ceiling in place.
 */
/**
 * SHARED PHYSICAL CONSTANTS for every TTS deadline in this file.
 *
 * These sit at the top because three separate deadlines are derived from them,
 * and on 2026-08-23 two of those deadlines were derived from a DIFFERENT
 * speech rate than the third. Both cannot be right, and the tests could not see
 * the contradiction because each restated its own copy of the rate.
 */

/** The longest a single chunk can be. Mirrors the chunker in routes/tts.ts. */
export const LATER_CHUNK_CHARS = 900

/** The most text one reply can be asked to speak locally. */
export const MAX_LOCAL_TTS_CHARS = 40_000

/**
 * Characters spoken per second by the SLOWEST voice, not the average.
 *
 * Measured on device 2026-08-23: am_echo ~19 chars/sec, bm_george as low as
 * 10.6 on one segment. Every deadline below uses 10, because a window sized on
 * the fast voice does not cover the slow one -- which is the entire class of
 * bug these constants exist to end.
 *
 * CAVEAT, stated because it is load-bearing: this is one segment of one voice
 * out of 28 shipped Kokoro voices. It errs safe for a WINDOW (too slow means
 * too generous) but it has not been censused, and a voice slower than 10 would
 * undersize every deadline here at once.
 */
export const SLOWEST_SPEECH_CHARS_PER_SEC = 10

/**
 * The slowest rate playback can actually run at.
 *
 * NOT the slowest option the picker offers -- that is 0.75x. This is the clamp
 * floor in the client's getPreferredSpeed(), which exists so a poisoned
 * localStorage value cannot produce an absurd rate. Deadlines must survive the
 * clamp, not just the menu.
 */
export const MIN_PLAYBACK_RATE = 0.5

/** Wall-clock ms to speak `chars` at the slowest voice and slowest rate. */
export function worstCaseSpeechMs(chars: number): number {
  return (chars / SLOWEST_SPEECH_CHARS_PER_SEC / MIN_PLAYBACK_RATE) * 1000
}

export const SESSION_IDLE_MS = (() => {
  // COMPUTED from the shared constants, not written down.
  //
  // A session that is being read must outlast the gap between two reads. The
  // client warms segment i+1 at the START of segment i and does not touch it
  // again until segment i FINISHES, so that gap is one full segment:
  //
  //   worstCaseSpeechMs(LATER_CHUNK_CHARS)  =  900 / 10 / 0.5  =  180s
  //
  // The previous value, 120s, was derived from ~19 chars/sec -- the FAST voice.
  // Once bm_george was measured at 10.6 the derivation was stale, and 900 chars
  // at 0.5x is 180s against a 120s window. That is the same defect this file
  // has now hit three times, so the value is computed here rather than chosen.
  //
  // x1.5 of margin absorbs a stalled segment or a slow refill without letting an
  // abandoned capability linger: 4.5 minutes, not 90.
  return Math.ceil(worstCaseSpeechMs(LATER_CHUNK_CHARS) * 1.5)
})()

/**
 * Absolute ceiling, never refreshed.
 *
 * The session UUID IS the auth for an unauthenticated play route, so a purely
 * sliding window could be kept alive indefinitely by polling. This bounds the
 * exposure of a leaked URL.
 *
 * COMPUTED from the largest reply the system can be asked to speak, at the
 * slowest voice and slowest rate, plus one segment of margin -- which is exactly
 * what initialGraceMs computes, so the ceiling is defined as "the largest grace
 * that can legally be issued":
 *
 *   worstCaseSpeechMs(40,000) + worstCaseSpeechMs(900)
 *     = 40000/10/0.5 + 900/10/0.5  =  8000s + 180s  =  136.3 minutes
 *
 * The previous 90 minutes was derived from ~19 chars/sec. After the slow voice
 * was measured at 10.6 that stopped covering its own input: initialGraceMs
 * exceeded the ceiling for any reply over ~26,400 characters, so the ceiling
 * silently truncated the grace and a maximal reply's last segments died before
 * playback reached them -- the segment-5 failure relocated to segment 31 of 46.
 *
 * This is a long-lived bearer capability and that is a real trade, stated rather
 * than buried: a 40,000-character reply genuinely takes over two hours to speak
 * at 0.5x, and the capability must outlive the audio it serves. The bound is
 * still absolute and still unextendable by reading.
 *
 * There is no separate arithmetic to keep in sync. Change a shared constant and
 * both this and the grace move together, and the test below asserts the ceiling
 * covers the largest grace.
 */
export const SESSION_MAX_LIFETIME_MS = Math.ceil(
  worstCaseSpeechMs(MAX_LOCAL_TTS_CHARS) + worstCaseSpeechMs(LATER_CHUNK_CHARS),
)

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
export function hashKey(
  engine: string,
  mappedVoice: string,
  format: string,
  text: string,
  instructions?: string,
): string {
  let material = `${engine}\0${mappedVoice}\0${format}\0${text}`
  if (engine === 'openai' && instructions && instructions.trim().length > 0) {
    material += `\0${instructions.trim()}`
  }
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
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

/** Allocate a new random v4 session UUID pointing at one
 *  (hash, text, voice, format) bundle. The play route may reread it for native
 *  Range refills during the 60-second TTL; expired sessions are rejected and
 *  reaped by the periodic sweeper below. */
/**
 * How long a session that has NEVER been read stays alive.
 *
 * WHY THIS IS NOT SESSION_IDLE_MS. Every segment of a reply is minted at
 * /prepare, but the client only touches segment k when segment k-1 STARTS
 * playing. For a 9-segment reply that first touch can be minutes away:
 *
 *   measured on device, 6,781 chars at 1.25x
 *     seg 4  first touched at t+101s   played
 *     seg 5  first touched at t+147s   FAILED
 *     seg 6  first touched at t+215s   FAILED
 *     seg 7  never reached             FAILED
 *
 * With a flat 120s idle deadline running from MINT, segment 5 was already dead
 * when the client first asked for it, and the 404 arrived as
 * NotSupportedError. Playback stopped at exactly segment 5 on every run.
 *
 * So the idle clock must not start before anyone could reasonably read it. An
 * unread session gets a grace window derived from how long the WHOLE reply takes
 * to speak at the slowest voice and slowest rate; the 120s idle window applies
 * from the first read onward, when it means what it says.
 */
export function initialGraceMs(totalChars: number): number {
  // The margin is ONE SEGMENT, not one idle window. The last segment is first
  // touched when the second-to-last STARTS playing, so the window has to reach
  // one segment past the end of the reply. An earlier version added
  // SESSION_IDLE_MS here and described it as covering that gap -- which it does
  // not, since a segment can be 180s at this file's own slowest rate.
  const lastSegmentMs = worstCaseSpeechMs(LATER_CHUNK_CHARS)
  return Math.max(SESSION_IDLE_MS, worstCaseSpeechMs(totalChars) + lastSegmentMs)
}

export function createSession(
  s: Omit<SessionEntry, 'expiresAt' | 'hardExpiresAt'>,
  opts: { graceMs?: number } = {},
): string {
  const uuid = randomUUID()
  const now = Date.now()
  // Number.isFinite, not just ??. Math.max(120000, NaN) is NaN, and NaN fails
  // every comparison in peekSession, so a NaN grace would leave the session
  // governed only by the ceiling. Cheap to close, silent if left open.
  const requested = opts.graceMs
  const grace = Number.isFinite(requested)
    ? Math.max(SESSION_IDLE_MS, requested as number)
    : SESSION_IDLE_MS
  sessions.set(uuid, {
    ...s,
    // Belt and braces, NOT the thing that enforces the ceiling. Mutation shows
    // removing this Math.min changes nothing observable: peekSession and
    // reapExpiredSessions both test hardExpiresAt independently, so a grace
    // beyond the ceiling is already unreachable. Kept because a stored deadline
    // that lies about its own limit invites a future reader to trust it -- but
    // do not mistake it for the guard.
    expiresAt: Math.min(now + grace, now + SESSION_MAX_LIFETIME_MS),
    hardExpiresAt: now + SESSION_MAX_LIFETIME_MS,
  })
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
  const now = Date.now()
  // Absolute ceiling first: a hard expiry must not be extendable by reading.
  if (s.hardExpiresAt <= now || s.expiresAt < now) {
    sessions.delete(uuid)
    return null
  }
  // SLIDING, and it may only ever EXTEND a deadline -- never shorten one.
  //
  // The Math.max is the whole point, and its absence was a defect that survived
  // into review. `warmNext(i)` reads segment i+1 at the START of segment i, and
  // then nothing touches it again until segment i FINISHES, one full segment
  // later. If that first read collapsed the derived grace to SESSION_IDLE_MS,
  // the warm would SPEND the grace instead of using it, and any segment whose
  // playback exceeds 120s would expire before its turn:
  //
  //   900 chars at 10.6 chars/sec = 85s of audio
  //   at 0.5x                     = 170s of wall time   >  120s
  //
  // Verified by replaying the real warm pattern: with a plain assignment the
  // 6,781-char reply lost segment 1 at t+170s while holding a 1,476s grace.
  //
  // Every security property is unchanged. The ceiling still binds independently
  // below. Reading still buys nothing back -- for a session with a long grace,
  // max() returns the grace deadline it already had, so a read cannot extend a
  // capability's life by even a millisecond. Once now + SESSION_IDLE_MS passes
  // the original grace, this becomes an ordinary sliding window again.
  s.expiresAt = Math.min(Math.max(s.expiresAt, now + SESSION_IDLE_MS), s.hardExpiresAt)
  return s
}

/** Rebind a live session to a new cache hash (openai -> local fallback). */
export function rebindSessionHash(uuid: string, hash: string): boolean {
  const s = sessions.get(uuid)
  if (!s) return false
  if (s.expiresAt < Date.now()) {
    sessions.delete(uuid)
    return false
  }
  s.hash = hash
  return true
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
    if (s.hardExpiresAt <= now || s.expiresAt < now) sessions.delete(uuid)
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
