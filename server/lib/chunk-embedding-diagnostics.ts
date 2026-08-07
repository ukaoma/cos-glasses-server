// Why a chunk was labelled the way it was.
//
// `chunk-embedding-store.ts` has retained a per-chunk embedding for every
// identified chunk, for 14 days, since 6.21.15 — and until now NOTHING in
// production read it back. The reader helpers existed; no route called them.
//
// That store is the difference between a reviewer (human or agent) who can only
// restate what the panel already shows and one who can answer the question that
// actually matters on a face-mounted microphone: not "who is this", but "how
// close did we get, and to WHAT". A row that missed its match by 0.02 against
// one profile is a very different problem from a row sitting equidistant
// between three, and the panel cannot tell them apart today.
//
// WHAT THIS DELIBERATELY DOES NOT RETURN: the raw 192-float vectors. They are
// ~1 KB of base64 each, they mean nothing to a reader, and a 400-chunk meeting
// would be 400 KB of noise. Similarity against each enrolled profile is the
// diagnostic; the vector is just how it is computed.

import {
  chunkEmbeddingsForIndices,
  readChunkEmbeddings,
  type ChunkEmbeddingRow,
} from './chunk-embedding-store.js'
import { rawCosineSimilarity, readVoiceProfiles } from './speaker-embeddings.js'

/** Profiles scored per chunk. More than this is noise in a review context. */
const TOP_MATCHES = 5

export interface ProfileMatch {
  speaker: string
  /** Best cosine against any embedding held for that profile. */
  similarity: number
  /** How many embeddings that profile holds, so a strong score against a
   *  1-sample profile is not read as equal to one against 20. */
  embeddings: number
}

export interface ChunkDiagnostic {
  chunk: number
  /** The label the identifier chose live, which is what a correction corrects. */
  chosen: string
  /** The score it chose on, as recorded at capture time. */
  chosenSimilarity: number
  /** Best-scoring profiles NOW, recomputed against the current store — which
   *  can differ from capture time if the profile has been trained since. */
  matches: ProfileMatch[]
  /** Gap between the top two current matches. A small margin means the choice
   *  was nearly a coin flip, and that is invisible in the panel today. */
  margin: number | null
}

export interface ChunkDiagnosticsResult {
  sessionId: string
  /** False when the store holds nothing for this session — aged out past the
   *  14-day TTL, captured before 6.21.15, or embeddings disabled. Distinct from
   *  an empty result set so a caller never reads "no data" as "no match". */
  retained: boolean
  chunks: ChunkDiagnostic[]
  /** Chunks asked for that the store does not hold. */
  missing: number[]
  /** Profiles the scores were computed against, so a reader can see the
   *  candidate pool rather than assume it. */
  profileCount: number
}

/**
 * Score one embedding against every enrolled profile.
 *
 * Best-of rather than mean: a profile holds up to 20 embeddings spanning
 * different rooms and microphones, and averaging them buries the one recorded
 * in conditions like these.
 */
function scoreAgainstProfiles(embedding: Float32Array): ProfileMatch[] {
  const store = readVoiceProfiles()
  const scored: ProfileMatch[] = []
  for (const profile of store.profiles) {
    let best = -1
    for (const candidate of profile.embeddings) {
      // The profile store holds plain number[]; the chunk store holds
      // Float32Array. Convert at the boundary rather than widening the
      // similarity function, which is on the live identification hot path.
      const value = rawCosineSimilarity(embedding, new Float32Array(candidate))
      if (value > best) best = value
    }
    if (best > -1) {
      scored.push({
        speaker: profile.name,
        similarity: Number(best.toFixed(4)),
        embeddings: profile.embeddings.length,
      })
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, TOP_MATCHES)
}

function toDiagnostic(row: ChunkEmbeddingRow): ChunkDiagnostic {
  const matches = scoreAgainstProfiles(row.embedding)
  return {
    chunk: row.i,
    chosen: row.speaker,
    chosenSimilarity: Number(row.similarity.toFixed(4)),
    matches,
    margin: matches.length >= 2
      ? Number((matches[0].similarity - matches[1].similarity).toFixed(4))
      : null,
  }
}

/**
 * Diagnostics for specific chunks, or for the whole session when `indices` is
 * empty.
 *
 * Bounded by `limit` because a long meeting holds hundreds of chunks and each
 * one is scored against every profile — a whole-session call on a 400-chunk
 * meeting with 77 profiles is 30,000 cosine comparisons. Fine to ask for, worth
 * capping by default.
 */
export function chunkDiagnostics(
  sessionId: string,
  indices: number[] = [],
  limit = 50,
): ChunkDiagnosticsResult {
  const profileCount = readVoiceProfiles().profiles.length

  if (indices.length > 0) {
    const rows = chunkEmbeddingsForIndices(sessionId, indices)
    const found = new Set(rows.map(r => r.i))
    return {
      sessionId,
      retained: readChunkEmbeddings(sessionId).rows.length > 0,
      chunks: rows.slice(0, limit).map(toDiagnostic),
      missing: indices.filter(i => !found.has(i)),
      profileCount,
    }
  }

  const all = readChunkEmbeddings(sessionId).rows
  return {
    sessionId,
    retained: all.length > 0,
    chunks: all.slice(0, limit).map(toDiagnostic),
    missing: [],
    profileCount,
  }
}
