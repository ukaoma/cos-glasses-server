// Per-chunk voiceprint embeddings, kept so a correction can become training.
//
// WHY THIS EXISTS. identifySpeaker() computes a 192-dim embedding for every
// audio chunk, uses it to pick a name, and throws it away. Nothing downstream
// keeps it: the chunk sidecar stores text/speaker/elapsed/similarity, and the
// calibration log stores ts/speaker/similarity/matched. So when a human later
// says "those six segments were actually me", the system can fix the transcript
// but cannot learn anything from the correction — the acoustic evidence is gone.
//
// Persisting it turns a correction into real training data:
//   correction → these chunks' embeddings → enrollEmbedding(name, …, 'correction:<id>')
//
// This only works forward. A meeting recorded before this ships can be
// relabelled but can never harden a profile, because its embeddings were
// discarded. That is the cost of every week this is not running.
//
// NOT AUDIO. An embedding is 192 floats describing vocal timbre. It cannot be
// played back and speech cannot be reconstructed from it, which is why its
// retention is treated separately from audio snippets — see RETENTION below.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'

export const CHUNK_EMBEDDING_DIR = 'chunk-embeddings'

/** Expected dimension for the shipped 3dspeaker model. A row of any other
 *  length is recorded but flagged, never silently averaged into a profile. */
export const EXPECTED_EMBEDDING_DIM = 192

/**
 * RETENTION — 14 days by default, overridable with COS_CHUNK_EMBEDDING_TTL_DAYS.
 *
 * This is deliberately longer than the 8 hours on record for audio snippets, and
 * the difference is the point: 8 hours cannot survive a weekend, so a Friday
 * meeting could never be corrected on Monday and the compounding loop would
 * only ever work on same-day review. Embeddings are also not audio — they are
 * non-invertible timbre vectors, so the privacy argument that motivates a short
 * audio window does not carry across unchanged.
 *
 * Flagged for Miles rather than assumed: if he wants these on the 8-hour clock
 * too, set the env var to a fraction and the correction loop becomes same-day
 * only.
 */
export function chunkEmbeddingTtlMs(): number {
  const raw = Number(process.env.COS_CHUNK_EMBEDDING_TTL_DAYS)
  const days = Number.isFinite(raw) && raw > 0 ? raw : 14
  return days * 24 * 60 * 60 * 1000
}

/** Master switch. Default ON: with this off, a correction can never train
 *  anything, which is the whole reason the store exists. */
export function chunkEmbeddingsEnabled(): boolean {
  return process.env.COS_CHUNK_EMBEDDINGS !== '0'
}

export interface ChunkEmbeddingRow {
  /** Chunk index within the session. This is the JOIN KEY to the chunk sidecar,
   *  which already carries `elapsed`, `text`, and the label. Time is deliberately
   *  NOT duplicated here: the only value available at capture time is the chunk's
   *  own duration, and storing that as an offset would be a wrong number in a
   *  field named like a right one. */
  i: number
  /** The label the identifier chose at capture time — what a correction corrects. */
  speaker: string
  similarity: number
  embedding: Float32Array
}

/**
 * Base64 of the raw little-endian float32 bytes.
 *
 * Chosen over a JSON number array for size and fidelity: 192 floats as JSON is
 * ~1.5 KB and rounds, while base64 is 1,024 chars and is exact. Over a
 * 400-chunk meeting that difference is roughly 200 KB.
 */
export function encodeEmbedding(embedding: Float32Array): string {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString('base64')
}

export function decodeEmbedding(encoded: string): Float32Array | null {
  try {
    const buf = Buffer.from(encoded, 'base64')
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
    // Copy rather than aliasing the Buffer's pool. Verified, not assumed: a
    // 768-byte base64 decode lands at an offset inside an 8192-byte pool slab.
    // Node's pool offset only advances, so a later allocation cannot corrupt an
    // existing view — the cost is RETENTION. An aliased view pins the whole 8 KB
    // slab to keep its 768 bytes, so holding a few hundred embeddings would pin
    // ~10x the memory they occupy. The copy owns exactly its own bytes.
    const copy = new ArrayBuffer(buf.byteLength)
    Buffer.from(copy).set(buf)
    return new Float32Array(copy)
  } catch {
    return null
  }
}

function sessionFile(sessionId: string): string | null {
  // Session ids come from the client; keep them to the shape the meeting store
  // already enforces so nothing can escape the directory.
  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return null
  const dir = dataPath(CHUNK_EMBEDDING_DIR)
  const path = join(dir, `${sessionId.replace(/:/g, '_')}.jsonl`)
  return resolve(path).startsWith(resolve(dir) + '/') ? path : null
}

/**
 * Append one chunk's embedding. JSONL, not a JSON array, so each write is a
 * single append with no read-modify-write of a growing file — a crash can lose
 * at most the final partial line, and readers skip it.
 *
 * Never throws: this runs inside the live capture path and losing an embedding
 * must never cost a chunk of transcript.
 */
export function appendChunkEmbedding(sessionId: string, row: ChunkEmbeddingRow): boolean {
  if (!chunkEmbeddingsEnabled()) return false
  const path = sessionFile(sessionId)
  if (!path) return false
  try {
    mkdirSync(dataPath(CHUNK_EMBEDDING_DIR), { recursive: true, mode: 0o700 })
    const line = JSON.stringify({
      i: row.i,
      speaker: row.speaker,
      similarity: Math.round(row.similarity * 1000) / 1000,
      dim: row.embedding.length,
      v: encodeEmbedding(row.embedding),
    })
    appendFileSync(path, line + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export interface ChunkEmbeddingReadResult {
  rows: ChunkEmbeddingRow[]
  /** Lines that could not be parsed or decoded. Reported rather than hidden: a
   *  correction built from a partial read would train on the wrong segments. */
  unusable: number
  /** True when the file is absent — the meeting predates this store, or the
   *  retention window has passed. Distinct from "present but empty". */
  missing: boolean
}

export function readChunkEmbeddings(sessionId: string): ChunkEmbeddingReadResult {
  const path = sessionFile(sessionId)
  if (!path || !existsSync(path)) return { rows: [], unusable: 0, missing: true }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { rows: [], unusable: 0, missing: true }
  }
  const rows: ChunkEmbeddingRow[] = []
  let unusable = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const embedding = typeof o.v === 'string' ? decodeEmbedding(o.v) : null
      if (!embedding || typeof o.i !== 'number' || typeof o.speaker !== 'string') { unusable++; continue }
      // A vector of the wrong dimension decodes cleanly and would be averaged
      // into a profile as if it were a voice. The model changed, or the row is
      // corrupt; either way it must never reach enrollment.
      if (embedding.length !== EXPECTED_EMBEDDING_DIM) { unusable++; continue }
      rows.push({
        i: o.i,
        speaker: o.speaker,
        similarity: typeof o.similarity === 'number' ? o.similarity : 0,
        embedding,
      })
    } catch {
      unusable++
    }
  }
  return { rows, unusable, missing: false }
}

/** The embeddings for a given label — the input to a correction. */
export function chunkEmbeddingsForSpeaker(sessionId: string, speaker: string): ChunkEmbeddingRow[] {
  return readChunkEmbeddings(sessionId).rows.filter(r => r.speaker === speaker)
}

/** The embeddings for an explicit set of chunk indices, for a partial
 *  correction where only some of a voice's segments were misattributed. */
export function chunkEmbeddingsForIndices(sessionId: string, indices: number[]): ChunkEmbeddingRow[] {
  const wanted = new Set(indices)
  return readChunkEmbeddings(sessionId).rows.filter(r => wanted.has(r.i))
}

export interface SweepResult {
  removed: string[]
  retained: string[]
}

/**
 * Delete session files past the retention window.
 *
 * A file whose mtime cannot be read is RETAINED — treating a failed stat as
 * "ancient" would delete the evidence a pending correction depends on.
 */
export function sweepExpiredChunkEmbeddings(nowMs: number, ttlMs = chunkEmbeddingTtlMs()): SweepResult {
  const dir = dataPath(CHUNK_EMBEDDING_DIR)
  const result: SweepResult = { removed: [], retained: [] }
  if (!existsSync(dir)) return result
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.jsonl'))
  } catch {
    return result
  }
  for (const name of names) {
    const path = join(dir, name)
    let mtimeMs = 0
    try { mtimeMs = statSync(path).mtimeMs } catch { result.retained.push(name); continue }
    if (mtimeMs > 0 && Number.isFinite(mtimeMs) && nowMs - mtimeMs > ttlMs) {
      try { unlinkSync(path); result.removed.push(name) } catch { result.retained.push(name) }
    } else {
      result.retained.push(name)
    }
  }
  return result
}

/** Counts for /api/health, so an operator can see the loop is banking evidence
 *  rather than having to trust that it is. */
export function chunkEmbeddingStoreStats(): {
  enabled: boolean
  sessions: number
  bytes: number
  ttlDays: number
  oldestAgeHours: number | null
} {
  const dir = dataPath(CHUNK_EMBEDDING_DIR)
  const ttlDays = Math.round((chunkEmbeddingTtlMs() / (24 * 60 * 60 * 1000)) * 10) / 10
  if (!existsSync(dir)) {
    return { enabled: chunkEmbeddingsEnabled(), sessions: 0, bytes: 0, ttlDays, oldestAgeHours: null }
  }
  let sessions = 0, bytes = 0, oldest = Number.POSITIVE_INFINITY
  try {
    for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      try {
        const st = statSync(join(dir, name))
        sessions++
        bytes += st.size
        oldest = Math.min(oldest, st.mtimeMs)
      } catch { /* skip unreadable */ }
    }
  } catch { /* report what we have */ }
  return {
    enabled: chunkEmbeddingsEnabled(),
    sessions,
    bytes,
    ttlDays,
    oldestAgeHours: Number.isFinite(oldest)
      ? Math.round(((Date.now() - oldest) / 3_600_000) * 10) / 10
      : null,
  }
}
