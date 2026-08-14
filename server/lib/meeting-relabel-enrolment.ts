// Turning "that unidentified voice was Kirstyn Blum" into a real voice profile.
//
// WHY THIS EXISTS. Relabelling was TEXT ONLY: it rewrote `speaker` strings in the
// meeting sidecar and never touched the voice store. Naming a voice over 109
// segments labelled that one meeting and taught the system nothing — she never
// appeared in /api/voice/profiles, the review panel still offered her as `new
// name` inside the SAME meeting, no later meeting could match her, and there was
// no profile to accumulate further chunks against. Verified live 2026-08-13:
// `Kirstyn Blum` appears 70x in one sidecar and 112x in another while
// voice-profiles.json held 77 profiles and no Kirstyn.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ITS OWN MODULE AND WHY IT IS THIS PARANOID
//
// 6.27.10 shipped this inline in the route and was reverted the same night.
// It joined TWO DIFFERENT INDEX SPACES:
//
//   plan.value.changed      positions in the COMPACTED sidecar array
//                           (meeting-relabel.ts, iterating rows already filtered
//                           to those carrying text)
//   chunk-embedding store   keyed on the RAW CAPTURE INDEX
//                           (transcribe-stream.ts writes `i: chunkIndex`)
//
// `getSessionChunks` is `session.chunks.filter(c => c && c.text)` while an
// embedding is written for every chunk with 2s+ of audio, BEFORE ASR is known.
// The two diverge at the first text-less chunk and the gap grows from there.
// 73 of 74 live sessions with embeddings have gaps, so divergence was the NORMAL
// case, not an edge case.
//
// Consequence, measured on `meeting_1786628481833_eagkaz`: naming one voice
// enrolled 73 of 103 rows belonging to OTHER PEOPLE — 22 chunks of MU (the device
// owner), 16 Vikas, 10 Vishnu, 8 Niranjan, 7 Anil, 6 Chris, 3 Manoj, 1 Navaz, and
// only 30 that were actually the named voice. It reported SUCCESS, because rows do
// come back from the store; they were simply the wrong rows.
//
// This writes to a SHARED, LONG-LIVED store that drives speaker attribution across
// every future meeting. A wrong write is permanent and silent. So every step below
// fails CLOSED: no mapping means no enrolment, never a fall back to positions.

import {
  chunkEmbeddingTtlMs,
  chunkEmbeddingsEnabled,
  readChunkEmbeddings,
} from './chunk-embedding-store.js'
import {
  enrollEmbedding,
  isEmbeddingAvailable,
  readVoiceProfiles,
} from './speaker-embeddings.js'
import { attachRawChunkIndices, type ReviewChunk } from './meeting-speaker-review.js'
import {
  MAX_ENROL_PER_CORRECTION,
  dominantCoherentCluster,
  greedyDiversitySelect,
} from './voice-enrolment-selection.js'

/** Labels the diariser invents when it does not know who is speaking. Naming one
 *  of these is a FIRST TRAINING RUN for a new person, not a correction. */
const PLACEHOLDER_LABEL = /^(ext|unknown|unidentified(\s+\d+)?|speaker\s*\d+)$/i

export const isPlaceholderLabel = (label: string): boolean => PLACEHOLDER_LABEL.test(label.trim())

/**
 * Why nothing was enrolled, when the answer is not "it worked".
 *
 * Reported rather than inferred, because there are four ways this silently
 * enrols zero and they are indistinguishable from the outside:
 *   1. the ~26 MB 3dspeaker model is absent (it is .npmignore'd, and a managed
 *      cutover has stranded it before)     -> store_unavailable
 *   2. COS_CHUNK_EMBEDDINGS=0              -> disabled
 *   3. the 14-day embedding TTL has passed -> expired
 *   4. the meeting predates the store      -> no_embeddings
 *
 * `null` means nothing BLOCKED enrolment. It does not mean samples were written —
 * read `enrolled` for that, and `clusterSkipped` for the coherence verdict.
 */
export type EnrolmentSkipReason =
  | null
  | 'no_index_mapping'
  | 'no_embeddings'
  | 'disabled'
  | 'expired'
  | 'store_unavailable'

export interface EnrolmentReport {
  /** Samples the voice store actually accepted. */
  enrolled: number
  /** Candidate embeddings found for the relabelled chunks, before any gating.
   *  Zero here means this correction was never an enrolment (a real name being
   *  corrected to another real name), not that enrolment failed. */
  attempted: number
  /** True ONLY when a profile did not exist for this name and now does. An
   *  existing name is APPENDED to, and must never be reported as created. */
  created: boolean
  /** Candidates rejected as a different voice. `clusterSkipped === attempted`
   *  means the bucket had no dominant voice at all and nothing was written. */
  clusterSkipped: number
  skipped: EnrolmentSkipReason
}

const IDLE: EnrolmentReport = {
  enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, skipped: null,
}

/**
 * Compacted sidecar positions -> RAW capture indices, or null.
 *
 * `attachRawChunkIndices` signals "I cannot map this" by returning the SAME ARRAY
 * it was given — when `chunkEntries` is absent, or when the text-bearing count
 * disagrees with the compacted count. That unchanged case is exactly the
 * poisoning case, so it is detected by REFERENCE IDENTITY and refused. There is
 * deliberately no fall back to positions: a shifted mapping is worse than none,
 * because it looks like it worked.
 *
 * A single unmappable position refuses the WHOLE set, for the same reason a
 * partial mapping is refused: enrolling the subset that happened to map still
 * writes whoever the unmapped ones turned out to be, and there is no way to tell
 * from the result which happened.
 */
export function resolveRawChunkIndices(
  sidecar: Record<string, unknown>,
  positions: number[],
): number[] | null {
  const chunks = sidecar.chunks
  if (!Array.isArray(chunks)) return null
  const withRaw = attachRawChunkIndices(chunks as ReviewChunk[], sidecar.chunkEntries)
  if (withRaw === chunks) return null

  const raw: number[] = []
  for (const position of positions) {
    const index = withRaw[position]?.chunkIndex
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
    raw.push(index)
  }
  return raw
}

/**
 * A missing embedding file is either aged out or never written, and the two are
 * worth telling apart: 'expired' means the correction arrived too late and the
 * loop would have worked, 'no_embeddings' means this meeting could never train
 * anything. The store cannot distinguish them — the file is simply gone — so the
 * meeting's own start time against the live TTL is the evidence.
 */
function missingReason(sidecar: Record<string, unknown>): EnrolmentSkipReason {
  const startTime = sidecar.startTime
  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime <= 0) return 'no_embeddings'
  return Date.now() - startTime > chunkEmbeddingTtlMs() ? 'expired' : 'no_embeddings'
}

/** Does a profile already exist under this name? Read from the PERSISTED store
 *  rather than `isEnrolled`, which asks the sherpa manager and therefore answers
 *  "no" for every name on an install with no model — which would report every
 *  append as a creation. */
function profileExists(name: string): boolean {
  try {
    return readVoiceProfiles().profiles.some(p => p.name === name)
  } catch {
    // Unknowable is not "new". Claiming creation is the lie that matters here.
    return true
  }
}

export interface EnrolNamedVoiceInput {
  sessionId: string
  from: string
  to: string
  /** `plan.value.changed` — COMPACTED sidecar positions. Never raw indices. */
  changed: number[]
  /** The parsed sidecar, for `chunks` + `chunkEntries` + `startTime`. */
  sidecar: Record<string, unknown>
}

/**
 * Enrol the voice a human just named.
 *
 * SCOPED to placeholder -> real name. Correcting one real name to another is left
 * alone deliberately: moving a voice between existing people is `merge-profiles`,
 * which is explicit and confirmation-gated, and a sweep of this store put two
 * DISTINCT people at 0.85 similarity, so doing it implicitly would poison both.
 *
 * An EXISTING name is appended to without a prompt, and reports `created: false`.
 *
 * Samples are stamped `correction:<sessionId>`, not a bare source string. The
 * prefix is load-bearing in four places: `isSampleFromSession` accepts only
 * `auto:` / `correction:` / `g2-training:`, so a bare tag makes the app's only
 * undo ("Not in this meeting") retract NOTHING; `untraceableSampleCount` counts
 * it as untraceable; `provenanceTier` falls to 'unknown', ranking a human-typed
 * name BELOW Fireflies attendee metadata for eviction; and `isCorrection()` is a
 * `startsWith('correction')` test, so the correction quota never protects it.
 *
 * NEVER THROWS. Enrolment is a bonus on top of a rename that is already durable
 * on disk; a voice store that refuses must not undo what the user asked for.
 */
export function enrolNamedVoice(input: EnrolNamedVoiceInput): EnrolmentReport {
  const { sessionId, from, to, changed, sidecar } = input

  // Not an enrolment at all. `attempted: 0` with `skipped: null` is how the
  // caller tells this apart from an enrolment that found no candidates.
  if (!isPlaceholderLabel(from) || isPlaceholderLabel(to) || changed.length === 0) return IDLE

  if (!chunkEmbeddingsEnabled()) return { ...IDLE, skipped: 'disabled' }
  // No extractor/manager means every enrollEmbedding would return success:false.
  // Naming that beats looping twenty times and reporting a bare zero.
  if (!isEmbeddingAvailable()) return { ...IDLE, skipped: 'store_unavailable' }

  const rawIndices = resolveRawChunkIndices(sidecar, changed)
  if (!rawIndices) return { ...IDLE, skipped: 'no_index_mapping' }

  let read: ReturnType<typeof readChunkEmbeddings>
  try {
    read = readChunkEmbeddings(sessionId)
  } catch {
    return { ...IDLE, skipped: 'store_unavailable' }
  }
  if (read.missing) return { ...IDLE, skipped: missingReason(sidecar) }

  const wanted = new Set(rawIndices)
  const candidates = read.rows.filter(r => wanted.has(r.i) && r.embedding && r.embedding.length > 0)
  if (candidates.length === 0) return { ...IDLE, skipped: 'no_embeddings' }

  const attempted = candidates.length
  const cluster = dominantCoherentCluster(candidates.map(r => r.embedding))
  const clusterSkipped = attempted - cluster.members.length
  // Every candidate disagreed with every other one. There is no voice here to
  // learn, only a bucket of strangers sharing one placeholder label.
  if (cluster.members.length === 0) {
    return { enrolled: 0, attempted, created: false, clusterSkipped, skipped: null }
  }

  // Diversity trims the coherent group to a bounded, spread-out sample. Those
  // trimmed are NOT counted in clusterSkipped — they were the right voice, just
  // redundant, and reporting them as rejected would read as a coherence problem.
  const coherent = cluster.members.map(m => candidates[m].embedding)
  const selected = greedyDiversitySelect(coherent, MAX_ENROL_PER_CORRECTION)

  const existedBefore = profileExists(to)
  const source = `correction:${sessionId}`
  let enrolled = 0
  try {
    for (const embedding of selected) {
      if (enrollEmbedding(to, embedding, source).success) enrolled += 1
    }
  } catch {
    return {
      enrolled, attempted, created: !existedBefore && enrolled > 0, clusterSkipped,
      skipped: 'store_unavailable',
    }
  }

  return {
    enrolled, attempted, created: !existedBefore && enrolled > 0, clusterSkipped, skipped: null,
  }
}
