// Held voices, grouped by who they sound like — across every meeting in the window.
//
// `ext-audio/<sessionId>/ext_chunk<N>_<ts>.wav` is one unidentified chunk. The
// Add-a-voice panel listed those by SESSION, which is the wrong grain twice
// over: a session with five strangers in it is not one voice, and the same
// stranger across four meetings is not four voices. Miles, 2026-09-12: "group
// those samples together… clump users together so that we're not constantly
// having to train. Realistically, people are only talking to up to a thousand
// different people at a time, so we should see many more groupings than
// individual exts that are unique." And: "bad random artifacts… ability to
// throw out those samples."
//
// So this module answers three questions over the whole retention window:
//
//   groups   which held samples are ONE voice (mutually coherent at the
//            identifier's own floor, carved cluster by cluster out of one
//            pairwise matrix — the same rule that guards profile corrections)
//   loose    which samples cohere with nothing — the random artifacts
//   sounds like  the enrolled profile that VOUCHES for a group: two or more of
//            its samples above the floor, one of them from a source that may
//            vouch (`vouchesForIdentity`), scored on the group's seed sample
//            against the profile's second-best — so one polluted sample cannot
//            vouch alone. That is the self-healing loop: a voice enrolled once,
//            in one room, misses in the next room; its misses land here as a
//            group that "may be X"; one confirmation appends them.
//
// WHERE THE VECTORS COME FROM. `chunk-embedding-store.ts` has banked every
// chunk's embedding — 'Ext' included — for 14 days since 6.21.15, and the ext
// wav and the banked row share the chunk index (verified: both writes use the
// same buffer in one call). So the ordinary case costs no audio decode at all.
// A sample without a banked row is decoded inside a time budget and cached in
// its own directory (the 72-hour purge reads the mtime of the first entry in a
// session folder, so nothing new may live there), and finished by a background
// sweep. The banked row outlives a wav that is named or discarded: it belongs
// to the meeting's corrections, not to this panel.
//
// WHAT THE REAL STORE TAUGHT (2026-09-12, a copy of Miles's data): best-of let
// one polluted sample vouch (0.894 against one of 40 samples, the other 39 at a
// median of 0.098); every "high" match was carried by `ext-retroactive` samples
// alone, a whole-session bulk enrol that had written one household voice into
// two people's profiles; 49 exact-duplicate chunk pairs from recordings started
// twice 12 ms apart made twelve perfect-coherence "voices"; and a centroid
// scores higher than any single sample, so the auto-enrol bar only means what
// it says on a real sample.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'
import { extAudioChunkPath, listExtAudioChunks } from './meeting-audio-archive.js'
import { EXPECTED_EMBEDDING_DIM, decodeEmbedding, encodeEmbedding, readChunkEmbeddings } from './chunk-embedding-store.js'
import {
  AUTO_ENROLL_THRESHOLD, MAX_EMBEDDINGS_PER_SPEAKER, enrollEmbedding, extractEmbedding, isEmbeddingAvailable, rawCosineSimilarity, readVoiceProfiles,
  type VoiceProfile,
} from './speaker-embeddings.js'
import { chooseEviction, vouchesForIdentity } from './embedding-eviction.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { alignedSources, appendEmbedding, dropEmbeddingAt, profileSimilarity } from './voice-profile-store.js'
import {
  MAX_ENROL_PER_CORRECTION,
  VOICE_COHERENCE_FLOOR,
  dominantCoherentClusterFromMatrix,
  greedyDiversitySelect,
  pairwiseSimilarityMatrix,
} from './voice-enrolment-selection.js'

/** Where decoded-on-demand vectors are kept. One JSON file per held session. */
export const HELD_EMBEDDING_CACHE_DIR = 'held-voice-embeddings'

/** A group whose SEED sample clears this against a profile's second-best sample
 *  is "high": the bar `autoEnroll` itself enrols at (0.88), applied at the same
 *  grain — one sample against a profile — never to a centroid, which scores
 *  higher than any of its samples. */
export const HELD_GROUP_HIGH_CONFIDENCE = AUTO_ENROLL_THRESHOLD

/** Below the identifier's own accept floor, no name is suggested at all.
 *  Speaker identity is a suggestion, never an assertion; under the floor the
 *  honest word is "unidentified". */
export const HELD_GROUP_SUGGESTION_FLOOR = VOICE_COHERENCE_FLOOR

/** A profile vouches only when at least this many of ITS samples clear the
 *  floor, and the score is the SECOND-best of them. */
export const HELD_SUGGESTION_MIN_SUPPORT = 2

/** Two held chunks this alike are the same recording banked twice, not two
 *  samples of a voice. They fold into one before grouping and before enrolment. */
export const HELD_DUPLICATE_SIMILARITY = 0.999

/** How long one listing may spend decoding audio for samples the bank does not
 *  hold. Past this they are `pending`, finished by the sweep. */
export const HELD_EXTRACTION_BUDGET_MS = 1_000

/** How long a naming request may spend decoding. A sample past this is
 *  `notReady` — untouched, listed for the next attempt — rather than a blocked
 *  event loop: one decode is ~126 ms on this Mac, so an unbudgeted request of
 *  a few hundred samples would stall live transcription for a minute. */
export const HELD_ENROLL_DECODE_BUDGET_MS = 2_000

/** A naming or discard request names at most this many samples. The live
 *  window measured 906 held chunks over 32 sessions (2026-09-12); forty per
 *  session over a hundred sessions is the honest ceiling. Guards a runaway
 *  client, not a product limit. */
export const MAX_HELD_MEMBERS_PER_REQUEST = 4_000

/** The listing is memoised this long while nothing held has changed. Control
 *  reloads it with every sessions refresh, and the matrix is synchronous. */
export const HELD_LISTING_MEMO_MS = 15_000

/** The provenance stamped on a profile sample that came from a held group:
 *  `ext-group:<sessionId>`, so the meeting's "not in this meeting" retraction
 *  can find it. */
export const HELD_GROUP_SOURCE = 'ext-group'

export interface HeldSampleRef {
  sessionId: string
  chunkIndex: number
  suggestion?: HeldGroupSuggestion | null
}

export interface HeldSample extends HeldSampleRef {
  embedding: Float32Array
}

export type HeldSuggestionTier = 'high' | 'likely'

export interface HeldGroupSuggestion {
  name: string
  /** Cosine of the group's seed sample against the profile's SECOND-best sample
   *  (its only sample, for a one-sample profile). Never the single best. */
  similarity: number
  tier: HeldSuggestionTier
  /** How many of the profile's samples clear the floor, out of all of them. */
  agreeing: number
  of: number
  /** The provenance of the strongest agreeing sample that may vouch. */
  anchor: string
  runnerUpSimilarity?: number
  margin?: number
  ownerSimilarity?: number
  ownerCaution?: boolean
}

export interface HeldVoiceGroup {
  /** The first member's key. Stable while that member is held. */
  id: string
  /** Every wav, duplicates included. Sorted by session then chunk. */
  members: HeldSampleRef[]
  sessions: string[]
  /** Wavs on disk — what naming or discarding consumes. */
  sampleCount: number
  /** Samples after exact duplicates fold. A group needs two of these. */
  distinctCount: number
  /** Mean pairwise cosine among the distinct samples. Always at or above the floor. */
  coherence: number
  /** The member closest to everyone else — the one to play first, and the one scored. */
  seed: HeldSampleRef
  suggestion: HeldGroupSuggestion | null
}

export interface HeldVoiceGroupsResult {
  groups: HeldVoiceGroup[]
  loose: HeldSampleRef[]
  sessions: number
  /** Wavs on disk. */
  samples: number
  /** Samples that have a vector and took part in grouping. */
  embedded: number
  /** Samples still waiting for a decode — or, with the speaker model not
   *  loaded, waiting for it. */
  pending: number
  /** Samples whose wav can never be turned into a vector. */
  unusable: number
  /** Whether the speaker model is loaded on this Mac. Without it, nothing
   *  outside the bank can be grouped and nothing can be enrolled. */
  speakerModel: boolean
  generatedAt: string
}

export interface CollectedHeldSamples {
  samples: HeldSample[]
  pending: HeldSampleRef[]
  unusable: HeldSampleRef[]
  sessions: number
  totalChunks: number
  /** Vectors decoded from audio during THIS call. */
  decoded: number
}

export class HeldGroupError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HeldGroupError'
  }
}

// ── Paths ──────────────────────────────────────────────────────────────────

/** The shape the chunk store and the meeting store accept. Session ids reach a
 *  filesystem path on every side; a looser validator than the writer's would
 *  only admit ids nothing else can find. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9:_-]{3,96}$/

function normalizeSessionId(sessionId: string): string { return sessionId.replace(/:/g, '_') }

function extAudioRoot(): string { return dataPath('ext-audio') }

/** Held session directory names: the listing's `sessionId` values. */
export function heldSessionIds(): string[] {
  const root = extAudioRoot()
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (!SESSION_ID_SHAPE.test(d.name)) continue
    if (listExtAudioChunks(d.name).length === 0) continue
    out.push(d.name)
  }
  return out.sort()
}

function cachePath(sessionId: string): string | null {
  if (!SESSION_ID_SHAPE.test(sessionId)) return null
  const dir = dataPath(HELD_EMBEDDING_CACHE_DIR)
  const path = join(dir, `${normalizeSessionId(sessionId)}.json`)
  return resolve(path).startsWith(resolve(dir) + '/') ? path : null
}

function readCache(sessionId: string): Record<string, string> {
  const path = cachePath(sessionId)
  if (!path || !existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

function writeCache(sessionId: string, cache: Record<string, string>): void {
  const path = cachePath(sessionId)
  if (!path) return
  try {
    if (Object.keys(cache).length === 0) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    mkdirSync(dataPath(HELD_EMBEDDING_CACHE_DIR), { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    console.warn(`[held-voice] cache write failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Drop cache files for sessions the 72-hour purge has already removed, and
 *  any temp file a crash left behind. */
function pruneStaleCaches(liveSessionIds: Set<string>): void {
  const dir = dataPath(HELD_EMBEDDING_CACHE_DIR)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json.tmp')) { try { unlinkSync(join(dir, f)) } catch {} continue }
    if (!f.endsWith('.json')) continue
    if (liveSessionIds.has(f.slice(0, -'.json'.length))) continue
    try { unlinkSync(join(dir, f)) } catch {}
  }
}

// ── Samples ────────────────────────────────────────────────────────────────

export function sampleKey(ref: HeldSampleRef): string { return `${ref.sessionId}#${ref.chunkIndex}` }

function compareRefs(a: HeldSampleRef, b: HeldSampleRef): number {
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.chunkIndex - b.chunkIndex
}

export interface CollectOptions {
  /** Milliseconds of audio decoding allowed. 0 decodes nothing; Infinity decodes all. */
  budgetMs?: number
  /** Restrict to these sessions and chunk indices. */
  only?: Map<string, Set<number>>
  now?: () => number
}

/**
 * Every held sample that has a vector, plus the ones that do not yet.
 *
 * Bank first, cache second, audio third — audio only inside the budget and
 * only with the speaker model loaded. Without the model every unbanked sample
 * is `pending`: nothing can decode it now, and the sweep does not run.
 */
export function collectHeldSamples(opts: CollectOptions = {}): CollectedHeldSamples {
  const budgetMs = opts.budgetMs ?? HELD_EXTRACTION_BUDGET_MS
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + budgetMs
  const modelReady = isEmbeddingAvailable()
  const sessionIds = opts.only ? [...opts.only.keys()].filter(id => SESSION_ID_SHAPE.test(id)).sort() : heldSessionIds()
  const samples: HeldSample[] = []
  const pending: HeldSampleRef[] = []
  const unusable: HeldSampleRef[] = []
  let totalChunks = 0
  let decoded = 0

  for (const sessionId of sessionIds) {
    const wanted = opts.only?.get(sessionId)
    const indices = listExtAudioChunks(sessionId).filter(i => !wanted || wanted.has(i))
    if (indices.length === 0) continue
    totalChunks += indices.length

    const banked = new Map<number, Float32Array>()
    for (const row of readChunkEmbeddings(sessionId).rows) banked.set(row.i, row.embedding)
    const cache = readCache(sessionId)
    let cacheDirty = false

    for (const chunkIndex of indices) {
      const ref = { sessionId, chunkIndex }
      const fromBank = banked.get(chunkIndex)
      if (fromBank) { samples.push({ ...ref, embedding: fromBank }); continue }
      const fromCache = cache[String(chunkIndex)]
      if (fromCache !== undefined) {
        const vector = fromCache === '' ? null : decodeEmbedding(fromCache)
        if (vector && vector.length === EXPECTED_EMBEDDING_DIM) { samples.push({ ...ref, embedding: vector }); continue }
        // '' is a remembered refusal: the wav decoded to the wrong shape once
        // and will again. Anything else that fails to decode is a corrupt
        // entry, re-decoded below.
        if (fromCache === '') { unusable.push(ref); continue }
      }
      if (!modelReady || now() >= deadline) { pending.push(ref); continue }
      const wav = extAudioChunkPath(sessionId, chunkIndex)
      let vector: Float32Array | null = null
      try { vector = wav ? extractEmbedding(readFileSync(wav)) : null } catch { vector = null }
      decoded++
      if (vector && vector.length === EXPECTED_EMBEDDING_DIM) {
        cache[String(chunkIndex)] = encodeEmbedding(vector)
        cacheDirty = true
        samples.push({ ...ref, embedding: vector })
      } else if (vector) {
        cache[String(chunkIndex)] = ''
        cacheDirty = true
        unusable.push(ref)
      } else {
        // The model is loaded and still returned nothing: the audio itself is
        // the problem (unreadable wav). Nothing to retry.
        cache[String(chunkIndex)] = ''
        cacheDirty = true
        unusable.push(ref)
      }
    }
    if (cacheDirty) writeCache(sessionId, cache)
  }
  if (!opts.only) pruneStaleCaches(new Set(sessionIds.map(normalizeSessionId)))
  return { samples, pending, unusable, sessions: sessionIds.length, totalChunks, decoded }
}

// ── Grouping ───────────────────────────────────────────────────────────────

/** Exact duplicates fold onto the lowest index; `copies` lists every index
 *  each representative stands for. */
export function foldDuplicates(sim: number[][], count: number): { reps: number[]; copies: Map<number, number[]> } {
  const copies = new Map<number, number[]>()
  const rep = Array.from({ length: count }, (_, i) => i)
  for (let i = 0; i < count; i++) {
    if (rep[i] !== i) continue
    copies.set(i, [i])
    for (let j = i + 1; j < count; j++) {
      if (rep[j] === j && sim[i][j] >= HELD_DUPLICATE_SIMILARITY) { rep[j] = i; copies.get(i)!.push(j) }
    }
  }
  return { reps: [...copies.keys()], copies }
}

export const HELD_SUGGESTION_MIN_MARGIN = 0.05
export const HELD_NEAR_PROFILE_SIMILARITY = 0.95

export interface SuggestOptions {
  /** The wearer's own label. Never offered: one click would write a stranger
   *  into the profile that drives owner detection. */
  ownerLabel?: string
}

/**
 * The enrolled profile that VOUCHES for a sample.
 *
 * Every profile is scored: its samples' cosines against `embedding`, sorted.
 * With two or more samples a profile is a candidate only when at least
 * `HELD_SUGGESTION_MIN_SUPPORT` of them clear the floor, and its score is the
 * second-best; a one-sample profile is a candidate at its one score and can
 * only ever be "likely". The best-scoring candidate wins — and if that winner
 * has no agreeing sample from a source that may vouch (`vouchesForIdentity`),
 * the answer is NO suggestion, not the runner-up: the runner-up is a different
 * person, and the voice most likely belongs to the profile that cannot vouch.
 */
export function suggestProfile(embedding: Float32Array, profiles: VoiceProfile[], opts: SuggestOptions = {}): HeldGroupSuggestion | null {
  type Candidate = { name: string; score: number; tier: HeldSuggestionTier; agreeing: number; of: number; anchor: string | null }
  let best: Candidate | null = null
  const candidates: Candidate[] = []
  let ownerScore = 0
  for (const profile of profiles) {
    const rows: Array<{ sim: number; source: string }> = []
    profile.embeddings.forEach((candidate, i) => {
      if (candidate.length !== embedding.length || !candidate.every(Number.isFinite)) return
      rows.push({ sim: rawCosineSimilarity(embedding, new Float32Array(candidate)), source: profile.sources?.[i] ?? 'unknown' })
    })
    if (rows.length === 0) continue
    rows.sort((a, b) => b.sim - a.sim)
    // Caution is proximity evidence, not permission to suggest/enrol the owner.
    // One very close owner sample warrants listening even without two anchors.
    if (opts.ownerLabel && profile.name.normalize('NFKC').toLowerCase() === opts.ownerLabel.normalize('NFKC').toLowerCase()) {
      ownerScore = Math.max(ownerScore, rows[0].sim)
      continue
    }
    const agreeing = rows.filter(r => r.sim >= HELD_GROUP_SUGGESTION_FLOOR)
    let score: number
    let tier: HeldSuggestionTier
    if (rows.length >= 2) {
      if (agreeing.length < HELD_SUGGESTION_MIN_SUPPORT) continue
      score = rows[1].sim
      tier = score >= HELD_GROUP_HIGH_CONFIDENCE ? 'high' : 'likely'
    } else {
      if (rows[0].sim < HELD_GROUP_SUGGESTION_FLOOR) continue
      score = rows[0].sim
      tier = 'likely'
    }
    const anchored = agreeing.find(r => vouchesForIdentity(r.source))
    const candidate: Candidate = {
      name: profile.name, score, tier, agreeing: agreeing.length, of: profile.embeddings.length,
      anchor: anchored ? anchored.source.split(':')[0] : null,
    }
    candidates.push(candidate)
    if (!best || candidate.score > best.score) best = candidate
  }
  if (!best || best.anchor === null) return null
  const winner = profiles.find(p => p.name === best!.name)!
  // Near-duplicate profile pairs represent an existing identity ambiguity, not
  // independent competing acoustic evidence. Do not let that pair erase the
  // margin against genuinely different voices. Never merge or rename here.
  const runnerUp = candidates.filter(c => c.name !== best!.name).filter(c => {
    const other = profiles.find(p => p.name === c.name)!
    return profileSimilarity(winner, other) < HELD_NEAR_PROFILE_SIMILARITY
  }).reduce((score, c) => Math.max(score, c.score), 0)
  const margin = best.score - runnerUp
  if (margin < HELD_SUGGESTION_MIN_MARGIN) return null
  return {
    name: best.name, similarity: Number(best.score.toFixed(4)), tier: best.tier,
    agreeing: best.agreeing, of: best.of, anchor: best.anchor,
    runnerUpSimilarity: Number(runnerUp.toFixed(4)), margin: Number(margin.toFixed(4)),
    ownerSimilarity: Number(ownerScore.toFixed(4)), ownerCaution: ownerScore >= 0.65 || ownerScore > best.score,
  }
}

export interface BuildOptions extends SuggestOptions {
  floor?: number
}

/**
 * Carve the held samples into voices.
 *
 * One pairwise matrix. Exact duplicates fold into one distinct sample first, or
 * every doubled recording would read as a two-sample voice of perfect
 * coherence. Then repeatedly take the dominant mutually coherent cluster out of
 * what remains until nothing coheres. Whatever is left is loose. A group is at
 * least TWO distinct samples: a lone sample has no evidence of being a voice
 * rather than a noise, and it is listed loose so the reviewer can throw it out
 * or, hearing a real person in it, name it on its own. Members and loose carry
 * EVERY wav, duplicates included, so naming or discarding consumes the copies.
 */
export function buildHeldVoiceGroups(samples: HeldSample[], profiles: VoiceProfile[], opts: BuildOptions = {}): { groups: HeldVoiceGroup[]; loose: HeldSampleRef[] } {
  const floor = opts.floor ?? VOICE_COHERENCE_FLOOR
  const groups: HeldVoiceGroup[] = []
  if (samples.length === 0) return { groups, loose: [] }
  const sim = pairwiseSimilarityMatrix(samples.map(s => s.embedding))
  const { reps, copies } = foldDuplicates(sim, samples.length)
  const refsOf = (idx: number[]): HeldSampleRef[] =>
    idx.flatMap(i => copies.get(i)!).map(i => ({ sessionId: samples[i].sessionId, chunkIndex: samples[i].chunkIndex })).sort(compareRefs)
  let active = reps
  for (;;) {
    // ONE guard, load-bearing on its own: a lone candidate comes back from the
    // matrix search as its own cluster of one, and a group needs two.
    const cluster = dominantCoherentClusterFromMatrix(sim, active, floor)
    if (cluster.members.length < 2) break
    const memberIdx = cluster.members
    let sum = 0, pairs = 0
    for (let a = 0; a < memberIdx.length; a++) {
      for (let b = a + 1; b < memberIdx.length; b++) { sum += sim[memberIdx[a]][memberIdx[b]]; pairs++ }
    }
    const members = refsOf(memberIdx)
    const seedSample = samples[cluster.seed]
    groups.push({
      id: sampleKey(members[0]),
      members,
      sessions: [...new Set(members.map(m => m.sessionId))].sort(),
      sampleCount: members.length,
      distinctCount: memberIdx.length,
      coherence: Number((pairs > 0 ? sum / pairs : 1).toFixed(4)),
      seed: { sessionId: seedSample.sessionId, chunkIndex: seedSample.chunkIndex },
      suggestion: suggestProfile(seedSample.embedding, profiles, opts),
    })
    const taken = new Set(memberIdx)
    active = active.filter(i => !taken.has(i))
  }
  groups.sort((a, b) => b.sampleCount - a.sampleCount || b.coherence - a.coherence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const byKey = new Map(samples.map(s => [sampleKey(s), s]))
  const loose = refsOf(active).map(ref => {
    const suggestion = suggestProfile(byKey.get(sampleKey(ref))!.embedding, profiles, opts)
    return suggestion ? { ...ref, suggestion } : ref
  })
  return { groups, loose }
}

// ── Listing ────────────────────────────────────────────────────────────────

let listingMemo: { fingerprint: string; at: number; result: HeldVoiceGroupsResult } | null = null

/** What the listing depends on: which wavs are held, and the profile store. */
function listingFingerprint(sessionIds: string[]): string {
  let profilesStamp = '0'
  try { profilesStamp = String(statSync(dataPath('voice-profiles.json')).mtimeMs) } catch {}
  return `${isEmbeddingAvailable() ? 'm' : '-'}|${getOwnerSpeakerLabel()}|${profilesStamp}|` + sessionIds.map(id => `${id}:${listExtAudioChunks(id).join(',')}`).join(';')
}

export function __resetHeldListingMemoForTests(): void { listingMemo = null }

/** The listing. Decodes within the budget; anything past it is `pending` and
 *  the background sweep finishes it for the next call. Memoised briefly while
 *  nothing held has changed. */
export function heldVoiceGroups(opts: { budgetMs?: number; now?: () => number } = {}): HeldVoiceGroupsResult {
  const now = opts.now ?? (() => Date.now())
  const sessionIds = heldSessionIds()
  const fingerprint = listingFingerprint(sessionIds)
  if (listingMemo && listingMemo.fingerprint === fingerprint && now() - listingMemo.at < HELD_LISTING_MEMO_MS && listingMemo.result.pending === 0) {
    return listingMemo.result
  }
  const started = performance.now()
  const collected = collectHeldSamples({ budgetMs: opts.budgetMs, now })
  const { groups, loose } = buildHeldVoiceGroups(collected.samples, readVoiceProfiles().profiles, { ownerLabel: getOwnerSpeakerLabel() })
  if (collected.pending.length > 0) scheduleHeldEmbeddingSweep()
  const result: HeldVoiceGroupsResult = {
    groups,
    loose,
    sessions: collected.sessions,
    samples: collected.totalChunks,
    embedded: collected.samples.length,
    pending: collected.pending.length,
    unusable: collected.unusable.length,
    speakerModel: isEmbeddingAvailable(),
    generatedAt: new Date().toISOString(),
  }
  console.log(`[held-voice] scored listing: samples=${result.samples} suggestions=${loose.filter(r => r.suggestion).length} ms=${(performance.now() - started).toFixed(1)} floor=${HELD_GROUP_SUGGESTION_FLOOR} support=${HELD_SUGGESTION_MIN_SUPPORT} margin=${HELD_SUGGESTION_MIN_MARGIN}`)
  for (const ref of loose) if (ref.suggestion) {
    const p = ref.suggestion
    console.log(`[held-voice] suggestion: key=${sampleKey(ref)} voice=${JSON.stringify(p.name)} secondBest=${p.similarity} agreeing=${p.agreeing}/${p.of} anchor=${p.anchor} runnerUp=${p.runnerUpSimilarity} margin=${p.margin} ownerScore=${p.ownerSimilarity} ownerCaution=${p.ownerCaution}`)
  }
  listingMemo = { fingerprint, at: now(), result }
  return result
}

// ── Background decode ──────────────────────────────────────────────────────

export const SWEEP_SLICE_MS = 250
export const SWEEP_GAP_MS = 50
let sweepTimer: NodeJS.Timeout | null = null
let sweepLastPending: number | null = null

/** One slice of the sweep. `progressed` is false when the pending count did
 *  not fall — the scheduler stops rather than spin. */
export function runHeldEmbeddingSweepTick(budgetMs: number = SWEEP_SLICE_MS): { pending: number; progressed: boolean } {
  let pending = 0
  try { pending = collectHeldSamples({ budgetMs }).pending.length } catch { pending = 0 }
  const progressed = sweepLastPending === null || pending < sweepLastPending
  sweepLastPending = pending
  if (pending === 0) listingMemo = null
  return { pending, progressed }
}

/**
 * Finish the decodes a listing could not afford, a slice at a time, off the
 * request path. Single-flight; each slice persists through the cache; stops
 * when nothing is pending, when a slice made no progress, or when the speaker
 * model is not loaded (nothing could decode).
 */
export function scheduleHeldEmbeddingSweep(): void {
  if (sweepTimer || !isEmbeddingAvailable()) return
  sweepLastPending = null
  const tick = () => {
    sweepTimer = null
    const { pending, progressed } = runHeldEmbeddingSweepTick()
    if (pending > 0 && progressed && isEmbeddingAvailable()) {
      sweepTimer = setTimeout(tick, SWEEP_GAP_MS)
      sweepTimer.unref()
    }
  }
  sweepTimer = setTimeout(tick, SWEEP_GAP_MS)
  sweepTimer.unref()
}

export function __heldSweepArmedForTests(): boolean { return sweepTimer !== null }

export function __resetHeldEmbeddingSweepForTests(): void {
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = null
  sweepLastPending = null
  listingMemo = null
}

// ── Corrections ────────────────────────────────────────────────────────────

/** Validate a request body's member list into refs: de-duplicated, normalised,
 *  then capped. Throws on shape errors. */
export function parseHeldMembers(raw: unknown): HeldSampleRef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HeldGroupError(400, 'invalid_members', 'members must be a non-empty array of { sessionId, chunkIndex }')
  }
  const seen = new Set<string>()
  const refs: HeldSampleRef[] = []
  for (const item of raw) {
    const rawSession = (item as { sessionId?: unknown })?.sessionId
    const rawChunk = (item as { chunkIndex?: unknown })?.chunkIndex
    const sessionId = typeof rawSession === 'string' ? normalizeSessionId(rawSession) : ''
    const chunkIndex = typeof rawChunk === 'number' ? rawChunk
      : typeof rawChunk === 'string' && /^\d{1,9}$/.test(rawChunk) ? Number(rawChunk) : NaN
    if (!SESSION_ID_SHAPE.test(sessionId) || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new HeldGroupError(400, 'invalid_members', 'each member needs a sessionId and a non-negative integer chunkIndex')
    }
    const ref = { sessionId, chunkIndex }
    if (seen.has(sampleKey(ref))) continue
    seen.add(sampleKey(ref))
    refs.push(ref)
  }
  if (refs.length > MAX_HELD_MEMBERS_PER_REQUEST) {
    throw new HeldGroupError(400, 'too_many_members', `members is capped at ${MAX_HELD_MEMBERS_PER_REQUEST} distinct samples per request`, { distinct: refs.length })
  }
  return refs.sort(compareRefs)
}

function onlyMap(refs: HeldSampleRef[]): Map<string, Set<number>> {
  const only = new Map<string, Set<number>>()
  for (const r of refs) {
    const set = only.get(r.sessionId) ?? new Set<number>()
    set.add(r.chunkIndex)
    only.set(r.sessionId, set)
  }
  return only
}

/** Which of these refs are still held on disk. */
export function previewDiscard(refs: HeldSampleRef[]): { present: HeldSampleRef[]; missing: HeldSampleRef[] } {
  const present: HeldSampleRef[] = []
  const missing: HeldSampleRef[] = []
  for (const ref of refs) (extAudioChunkPath(ref.sessionId, ref.chunkIndex) ? present : missing).push(ref)
  return { present, missing }
}

/** Remove the wavs behind these refs. Returns what was removed and what was not there. */
export function discardHeldSamples(refs: HeldSampleRef[]): { removed: HeldSampleRef[]; missing: HeldSampleRef[] } {
  const removed: HeldSampleRef[] = []
  const missing: HeldSampleRef[] = []
  const touched = new Map<string, Record<string, string>>()
  for (const ref of refs) {
    const cache = touched.get(ref.sessionId) ?? readCache(ref.sessionId)
    delete cache[String(ref.chunkIndex)]
    touched.set(ref.sessionId, cache)
    const wav = extAudioChunkPath(ref.sessionId, ref.chunkIndex)
    if (!wav) { missing.push(ref); continue }
    try { unlinkSync(wav); removed.push(ref) } catch { missing.push(ref) }
  }
  for (const [sessionId, cache] of touched) writeCache(sessionId, cache)
  listingMemo = null
  console.log(`[held-voice] discard: removed=${removed.length} missing=${missing.length} sessions=[${[...new Set(refs.map(r => r.sessionId))].join(',')}]`)
  return { removed, missing }
}

export interface EnrollHeldGroupPlan {
  speaker: string
  /** True when no profile of that name existed before. */
  created: boolean
  /** Distinct samples the request named. */
  submitted: number
  /** Of those, the ones held on disk with a usable vector. */
  resolved: number
  /** Resolved samples after exact duplicates fold. */
  distinct: number
  missing: HeldSampleRef[]
  /** Held but not yet decoded within the request budget: untouched, listed for
   *  the next attempt. The sweep is working on them. */
  notReady: HeldSampleRef[]
  /** Wavs in the mutually coherent core that was treated as this one voice. */
  coherent: number
  /** Submitted samples that did NOT cohere with the core. Left on disk, untouched. */
  leftBehind: HeldSampleRef[]
  /** Diverse subset of the distinct core to be written to the profile. */
  selected: number
  sessions: string[]
  profileEmbeddings: number
  /** Whether the speaker model is loaded: false means a confirmed request will
   *  be refused (503) even though this preview could be computed. */
  speakerModel: boolean
}

export interface EnrollHeldGroupResult extends EnrollHeldGroupPlan {
  dryRun: boolean
  coreMembers?: HeldSampleRef[]
  /** Exact selected vectors accepted/refused by the store, not expanded duplicates. */
  enrolledMembers?: HeldSampleRef[]
  rejectedMembers?: HeldSampleRef[]
  enrolled: number
  /** Wavs removed: the whole core, selected or not, because all of it is now a known voice. */
  deleted: number
}

/**
 * Name a set of held samples as one person.
 *
 * NEVER cuts a corner on coherence: the submitted set is re-clustered here
 * regardless of what the client believed, duplicates folded first, and only
 * the mutually coherent core is written. A set that agrees on nothing is
 * refused outright rather than enrolled as "whichever stranger came first". A
 * single sample is allowed — naming sample by sample is exactly what a
 * low-confidence voice needs — and a human hearing one chunk is the evidence.
 *
 * Deletes only the core's wavs, and only after at least one sample was
 * written. With the speaker model not loaded nothing can be written, so the
 * request is refused before it touches anything.
 */
export function enrollHeldGroup(name: string, refs: HeldSampleRef[], opts: { dryRun?: boolean; deleteAudio?: boolean } = {}): EnrollHeldGroupResult {
  const dryRun = opts.dryRun === true
  const collected = collectHeldSamples({ only: onlyMap(refs), budgetMs: HELD_ENROLL_DECODE_BUDGET_MS })
  if (collected.pending.length > 0) scheduleHeldEmbeddingSweep()
  const have = new Map(collected.samples.map(s => [sampleKey(s), s]))
  const notReadyKeys = new Set(collected.pending.map(sampleKey))
  const notReady = refs.filter(r => notReadyKeys.has(sampleKey(r)))
  const missing = refs.filter(r => !have.has(sampleKey(r)) && !notReadyKeys.has(sampleKey(r)))
  const resolved = refs.filter(r => have.has(sampleKey(r))).map(r => have.get(sampleKey(r))!)
  if (resolved.length === 0) {
    throw new HeldGroupError(404, 'no_samples', notReady.length > 0
      ? 'Those samples are still being read; try again in a moment.'
      : 'None of those samples are held any more, or none could be turned into a voiceprint.', {
      missing, notReady, unusable: collected.unusable.length,
    })
  }

  const sim = pairwiseSimilarityMatrix(resolved.map(s => s.embedding))
  const { reps, copies } = foldDuplicates(sim, resolved.length)
  const cluster = reps.length === 1 ? { members: reps, seed: reps[0] } : dominantCoherentClusterFromMatrix(sim, reps)
  if (cluster.members.length === 0) {
    throw new HeldGroupError(409, 'incoherent', 'Those samples do not sound like one person. Nothing was enrolled; name them separately or discard the odd ones out.', {
      submitted: refs.length, resolved: resolved.length, distinct: reps.length,
    })
  }
  const coreReps = cluster.members
  const coreSet = new Set(coreReps)
  const expand = (idx: number[]): HeldSample[] => idx.flatMap(i => copies.get(i)!).map(i => resolved[i])
  const core = expand(coreReps)
  const leftBehind = expand(reps.filter(i => !coreSet.has(i))).map(s => ({ sessionId: s.sessionId, chunkIndex: s.chunkIndex })).sort(compareRefs)

  const existing = readVoiceProfiles().profiles.find(p => p.name === name)
  // A primitive snapshot, taken BEFORE the loop: the store hands back its live
  // `embeddings` array by reference, and enrolment appends to that same array
  // until the first write invalidates the cache. Reading `.length` afterwards
  // counted the new samples twice (caught by the route test, 2026-09-12).
  const existingCount = existing?.embeddings.length ?? 0
  const bySample = new Map<Float32Array, HeldSample>(coreReps.map(i => [resolved[i].embedding, resolved[i]]))
  const selected = greedyDiversitySelect(coreReps.map(i => resolved[i].embedding), MAX_ENROL_PER_CORRECTION)
  const plan: EnrollHeldGroupPlan = {
    speaker: name,
    created: !existing,
    submitted: refs.length,
    resolved: resolved.length,
    distinct: reps.length,
    missing,
    notReady,
    coherent: core.length,
    leftBehind,
    selected: selected.length,
    sessions: [...new Set(core.map(s => s.sessionId))].sort(),
    profileEmbeddings: existingCount,
    speakerModel: isEmbeddingAvailable(),
  }
  // A dry run writes no profile and deletes no wav. It may still decode and
  // cache vectors for the samples it was asked about, and arm the sweep.
  if (dryRun) return { ...plan, coreMembers: core.map(({ sessionId, chunkIndex }) => ({ sessionId, chunkIndex })), dryRun: true, enrolled: 0, deleted: 0 }
  if (!isEmbeddingAvailable()) {
    throw new HeldGroupError(503, 'speaker_model_unavailable', 'The speaker model is not loaded on this Mac, so nothing can be enrolled. Nothing was changed.', { ...plan })
  }

  let enrolled = 0
  const enrolledMembers: HeldSampleRef[] = [], rejectedMembers: HeldSampleRef[] = []
  for (const emb of selected) {
    const sample = bySample.get(emb)
    const source = sample ? `${HELD_GROUP_SOURCE}:${sample.sessionId}` : HELD_GROUP_SOURCE
    const accepted = enrollEmbedding(name, emb, source, true).success
    if (accepted) enrolled++
    if (sample) (accepted ? enrolledMembers : rejectedMembers).push({ sessionId: sample.sessionId, chunkIndex: sample.chunkIndex })
  }
  if (enrolled === 0) {
    throw new HeldGroupError(409, 'nothing_enrolled', `The profile store refused every sample for ${name}; nothing was deleted.`, { ...plan, enrolledMembers, rejectedMembers })
  }
  const coreMembers = core.map(s => ({ sessionId: s.sessionId, chunkIndex: s.chunkIndex }))
  const { removed } = opts.deleteAudio === false ? { removed: [] } : discardHeldSamples(coreMembers)
  console.log(`[held-voice] enroll "${name}" (${existing ? 'appended' : 'created'}): submitted=${refs.length} resolved=${resolved.length} distinct=${reps.length} coherent=${core.length} selected=${selected.length} enrolled=${enrolled} deleted=${removed.length} leftBehind=${leftBehind.length} notReady=${notReady.length} sessions=[${plan.sessions.join(',')}]`)
  return { ...plan, coreMembers, enrolledMembers, rejectedMembers, dryRun: false, enrolled, deleted: removed.length, profileEmbeddings: existingCount + enrolled }
}


/** Preview the exact evidence enrollment will retain, without touching the store.
 * Duplicate recordings count once; selection and cap eviction match enrollment.
 * Wider matching must use this projection, never every submitted held vector. */
export function projectHeldEnrollment(name: string, refs: HeldSampleRef[]): {
  plan: EnrollHeldGroupResult; profiles: VoiceProfile[]; selectedMembers: HeldSampleRef[]
} {
  const plan = enrollHeldGroup(name, refs, { dryRun: true })
  const coreRefs = plan.coreMembers ?? []
  const collected = collectHeldSamples({ only: onlyMap(coreRefs), budgetMs: HELD_ENROLL_DECODE_BUDGET_MS })
  const byKey = new Map(collected.samples.map(sample => [sampleKey(sample), sample]))
  const core = coreRefs.map(ref => byKey.get(sampleKey(ref)))
  if (core.some(sample => !sample)) throw new HeldGroupError(409, 'samples_changed', 'The held samples changed while preparing the preview. Preview again.')
  const samples = core as HeldSample[]
  const matrix = pairwiseSimilarityMatrix(samples.map(sample => sample.embedding))
  const { reps } = foldDuplicates(matrix, samples.length)
  const representatives = reps.map(i => samples[i])
  const selected = greedyDiversitySelect(representatives.map(sample => sample.embedding), MAX_ENROL_PER_CORRECTION)
  const byEmbedding = new Map(representatives.map(sample => [sample.embedding, sample]))
  // readVoiceProfiles shares embedding arrays with the cache. Clone every row
  // before simulating append/eviction so a preview cannot alter live evidence.
  const profiles = readVoiceProfiles().profiles.map(profile => ({
    ...profile, embeddings: profile.embeddings.map(row => [...row]), sources: [...(profile.sources ?? [])],
  }))
  let target = profiles.find(profile => profile.name === name)
  if (!target) { target = { name, embeddings: [], sources: [] }; profiles.push(target) }
  const selectedMembers: HeldSampleRef[] = []
  for (const embedding of selected) {
    const sample = byEmbedding.get(embedding)!
    const source = `${HELD_GROUP_SOURCE}:${sample.sessionId}`
    if (target.embeddings.length >= MAX_EMBEDDINGS_PER_SPEAKER) {
      const choice = chooseEviction(alignedSources(target), source, MAX_EMBEDDINGS_PER_SPEAKER)
      dropEmbeddingAt(target, choice?.index ?? 0)
    }
    appendEmbedding(target, Array.from(embedding), source)
    selectedMembers.push({ sessionId: sample.sessionId, chunkIndex: sample.chunkIndex })
  }
  return { plan, profiles, selectedMembers }
}
