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
//   sounds like  the enrolled profile a group's centroid is nearest, above the
//            floor, so a group that the live identifier MISSED can be folded
//            back into the profile it belongs to. That is the self-healing
//            loop: a voice enrolled once, in one room, misses in the next room;
//            its misses land here as a group that "sounds like X"; one click
//            appends them and the profile gains the room.
//
// WHERE THE VECTORS COME FROM. `chunk-embedding-store.ts` has banked every
// chunk's embedding — 'Ext' included — for 14 days since 6.21.15, and the ext
// wav and the banked row share the chunk index. So the ordinary case costs no
// audio decode at all. A sample without a banked row (store disabled, or a
// session older than the bank) is extracted from its wav inside a time budget
// and cached beside the bank, so it is paid for once. The cache lives in its
// OWN directory rather than inside the session folder: the 72-hour purge in
// transcribe-stream reads the mtime of the first directory entry, and a cache
// file rewritten late would have extended a session's life by that much.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'
import { extAudioChunkPath, listExtAudioChunks } from './meeting-audio-archive.js'
import { EXPECTED_EMBEDDING_DIM, decodeEmbedding, encodeEmbedding, readChunkEmbeddings } from './chunk-embedding-store.js'
import { enrollEmbedding, extractEmbedding, rawCosineSimilarity, readVoiceProfiles, type VoiceProfile } from './speaker-embeddings.js'
import {
  MAX_ENROL_PER_CORRECTION,
  VOICE_COHERENCE_FLOOR,
  dominantCoherentCluster,
  dominantCoherentClusterFromMatrix,
  greedyDiversitySelect,
  pairwiseSimilarityMatrix,
} from './voice-enrolment-selection.js'

/** Where extracted-on-demand vectors are kept. One JSON file per held session. */
export const HELD_EMBEDDING_CACHE_DIR = 'held-voice-embeddings'

/** A group whose centroid clears this against a profile is offered as that
 *  person with one click. It is the bar the live path uses before it will
 *  auto-enrol a chunk (transcribe-stream: `similarity >= 0.72`), so "high"
 *  here means "the identifier would have trusted this itself". */
export const HELD_GROUP_HIGH_CONFIDENCE = 0.72

/** A profile vouches for a group only when at least this many of ITS samples
 *  clear the floor, and the score is the SECOND-best of them. Measured on the
 *  live store 2026-09-12: the largest held group (120 samples, 18 meetings)
 *  scored 0.894 against one of Jessica Thompson's 40 samples while her other 39
 *  sat at a median of 0.098 — that one sample is a stranger written into her
 *  profile by an earlier correction, and best-of would have offered a one-click
 *  way to write twenty more. Two agreeing samples cannot be one pollutant. */
export const HELD_SUGGESTION_MIN_SUPPORT = 2

/** Sources whose samples may vouch for a group. `ext-retroactive` — a whole held
 *  session enrolled under one typed name, the profile-poisoning default this
 *  module replaces — `auto` and `unknown` may not. On the live store, 2026-09-12,
 *  EVERY "high" suggestion was carried by ext-retroactive samples alone: a
 *  household voice heard in 18 meetings that an earlier bulk enrol had written
 *  into two people's profiles, offered back as those people. A correction, a
 *  Fireflies or manual enrolment, a G2 enrolment, a chunk banked on a live
 *  match, or a held group a human named after listening is an anchor; a bulk
 *  guess is not. */
export const HELD_ANCHOR_SOURCES: ReadonlySet<string> = new Set(['manual', 'fireflies', 'g2-enrollment', 'g2-training', 'correction', 'ext-group'])

/** Two held chunks this alike are the same recording banked twice (a session
 *  started twice 12 ms apart is 49 such pairs on the live store), not two
 *  samples of a voice. They fold into one before grouping. */
export const HELD_DUPLICATE_SIMILARITY = 0.999

/** Below the identifier's own accept floor, no name is suggested at all.
 *  Speaker identity is a suggestion, never an assertion; under the floor the
 *  honest word is "unidentified". */
export const HELD_GROUP_SUGGESTION_FLOOR = VOICE_COHERENCE_FLOOR

/** How long one listing may spend decoding audio for samples the bank does not
 *  hold. Past this they are reported as `pending` and finished in the
 *  background; the panel is never held for a whole window of decodes. */
export const HELD_EXTRACTION_BUDGET_MS = 1_000

/** A correction or discard names at most this many samples. 40 per session
 *  times a ten-session window is the realistic ceiling; the cap is a guard
 *  against a runaway client, not a product limit. */
export const MAX_HELD_MEMBERS_PER_REQUEST = 400

/** The provenance stamped on a profile sample that came from a held group. */
export const HELD_GROUP_SOURCE = 'ext-group'

export interface HeldSampleRef {
  sessionId: string
  chunkIndex: number
}

export interface HeldSample extends HeldSampleRef {
  embedding: Float32Array
  /** 'banked' — from the chunk-embedding store at capture time;
   *  'extracted' — decoded from the wav now or on an earlier listing. */
  embeddingSource: 'banked' | 'extracted'
}

export type HeldSuggestionTier = 'high' | 'likely'

export interface HeldGroupSuggestion {
  name: string
  /** Cosine of the group centroid against the profile's SECOND-best sample (its
   *  only sample, for a one-sample profile). Never the single best: see
   *  `HELD_SUGGESTION_MIN_SUPPORT`. */
  similarity: number
  tier: HeldSuggestionTier
  /** How many of the profile's samples clear the floor, out of how many. */
  agreeing: number
  of: number
  /** The provenance of the strongest agreeing sample from an anchored source. */
  anchor: string
}

export interface HeldVoiceGroup {
  /** The first member's key. Stable while that member is held. */
  id: string
  /** Sorted by session then chunk. */
  members: HeldSampleRef[]
  sessions: string[]
  /** Wavs on disk — what naming or discarding consumes. */
  sampleCount: number
  /** Samples after exact duplicates fold. A group needs two of these. */
  distinctCount: number
  /** Mean pairwise cosine among the distinct samples. Always at or above the floor. */
  coherence: number
  /** The member closest to everyone else — the one to play first. */
  seed: HeldSampleRef
  suggestion: HeldGroupSuggestion | null
}

export interface HeldVoiceGroupsResult {
  /** Largest first, then most coherent. */
  groups: HeldVoiceGroup[]
  /** Samples that cohere with nothing held. */
  loose: HeldSampleRef[]
  sessions: number
  /** Wavs on disk. */
  samples: number
  /** Samples that have a vector and took part in grouping. */
  embedded: number
  /** Samples still waiting for a decode. A later listing will have them. */
  pending: number
  /** Samples whose wav could not be decoded into a vector at all. */
  unusable: number
  generatedAt: string
}

export interface CollectedHeldSamples {
  samples: HeldSample[]
  pending: HeldSampleRef[]
  unusable: HeldSampleRef[]
  sessions: number
  totalChunks: number
  /** Vectors decoded from audio during THIS call. */
  extractedNow: number
}

export class HeldGroupError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HeldGroupError'
  }
}

// ── Paths ──────────────────────────────────────────────────────────────────

const SESSION_ID_SHAPE = /^[A-Za-z0-9:_.-]{3,96}$/

function extAudioRoot(): string { return dataPath('ext-audio') }

/** Held session directory names: the listing's `sessionId` values. */
export function heldSessionIds(): string[] {
  const root = extAudioRoot()
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (listExtAudioChunks(d.name).length === 0) continue
    out.push(d.name)
  }
  return out.sort()
}

function cachePath(sessionId: string): string | null {
  if (!SESSION_ID_SHAPE.test(sessionId) || sessionId.includes('..')) return null
  const dir = dataPath(HELD_EMBEDDING_CACHE_DIR)
  const path = join(dir, `${sessionId.replace(/:/g, '_')}.json`)
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

/** Drop cache files for sessions the 72-hour purge has already removed. */
function pruneStaleCaches(liveSessionIds: Set<string>): void {
  const dir = dataPath(HELD_EMBEDDING_CACHE_DIR)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
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
  /** Restrict to these sessions (and, when given, to these chunk indices). */
  only?: Map<string, Set<number> | null>
  now?: () => number
}

/**
 * Every held sample that has a vector, plus the ones that do not yet.
 *
 * Bank first, cache second, audio third — and audio only inside the budget.
 */
export function collectHeldSamples(opts: CollectOptions = {}): CollectedHeldSamples {
  const budgetMs = opts.budgetMs ?? HELD_EXTRACTION_BUDGET_MS
  const now = opts.now ?? (() => Date.now())
  const deadline = now() + budgetMs
  const sessionIds = opts.only ? [...opts.only.keys()].filter(id => SESSION_ID_SHAPE.test(id)).sort() : heldSessionIds()
  const samples: HeldSample[] = []
  const pending: HeldSampleRef[] = []
  const unusable: HeldSampleRef[] = []
  let totalChunks = 0
  let extractedNow = 0

  for (const sessionId of sessionIds) {
    const wanted = opts.only?.get(sessionId) ?? null
    const indices = listExtAudioChunks(sessionId).filter(i => wanted === null || wanted.has(i))
    if (indices.length === 0) continue
    totalChunks += indices.length

    const banked = new Map<number, Float32Array>()
    for (const row of readChunkEmbeddings(sessionId).rows) banked.set(row.i, row.embedding)
    const cache = readCache(sessionId)
    let cacheDirty = false

    for (const chunkIndex of indices) {
      const ref = { sessionId, chunkIndex }
      const fromBank = banked.get(chunkIndex)
      if (fromBank) { samples.push({ ...ref, embedding: fromBank, embeddingSource: 'banked' }); continue }
      const fromCache = cache[String(chunkIndex)]
      if (fromCache !== undefined) {
        const decoded = fromCache === '' ? null : decodeEmbedding(fromCache)
        if (decoded && decoded.length === EXPECTED_EMBEDDING_DIM) { samples.push({ ...ref, embedding: decoded, embeddingSource: 'extracted' }); continue }
        // '' is a remembered failure: the wav decoded to nothing once and will
        // again. Anything else that fails to decode is a corrupt cache entry.
        if (fromCache === '') { unusable.push(ref); continue }
      }
      if (now() >= deadline) { pending.push(ref); continue }
      const wav = extAudioChunkPath(sessionId, chunkIndex)
      let embedding: Float32Array | null = null
      try { embedding = wav ? extractEmbedding(readFileSync(wav)) : null } catch { embedding = null }
      extractedNow++
      if (embedding && embedding.length === EXPECTED_EMBEDDING_DIM) {
        cache[String(chunkIndex)] = encodeEmbedding(embedding)
        cacheDirty = true
        samples.push({ ...ref, embedding, embeddingSource: 'extracted' })
      } else if (embedding) {
        // Wrong dimension: the model changed. Remember the refusal.
        cache[String(chunkIndex)] = ''
        cacheDirty = true
        unusable.push(ref)
      } else {
        // null also means "the model is not loaded"; do not cache that, the
        // next listing may have it.
        unusable.push(ref)
      }
    }
    if (cacheDirty) writeCache(sessionId, cache)
  }
  if (!opts.only) pruneStaleCaches(new Set(sessionIds.map(id => id.replace(/:/g, '_'))))
  return { samples, pending, unusable, sessions: sessionIds.length, totalChunks, extractedNow }
}

// ── Grouping ───────────────────────────────────────────────────────────────

function centroid(embeddings: Float32Array[]): Float32Array {
  const out = new Float32Array(embeddings[0].length)
  for (const e of embeddings) for (let i = 0; i < out.length; i++) out[i] += e[i]
  for (let i = 0; i < out.length; i++) out[i] /= embeddings.length
  return out
}

/**
 * The enrolled profile that VOUCHES for a vector.
 *
 * Not best-of. A profile spans rooms and microphones, so its nearest sample is
 * the right measure of "could this be them" — but it is also exactly what one
 * mis-enrolled sample produces, and the live store has those. So a profile
 * with two or more samples must have at least `HELD_SUGGESTION_MIN_SUPPORT`
 * of them above the floor, and its score is the second-best: one pollutant
 * cannot clear that bar alone. At least one agreeing sample must come from an
 * anchored source (`HELD_ANCHOR_SOURCES`). A one-sample profile can only vouch
 * as "likely", never "high" — nothing corroborates it.
 */
export function suggestProfile(embedding: Float32Array, profiles: VoiceProfile[]): HeldGroupSuggestion | null {
  let best: HeldGroupSuggestion | null = null
  for (const profile of profiles) {
    const rows: Array<{ sim: number; source: string }> = []
    profile.embeddings.forEach((candidate, i) => {
      if (candidate.length !== embedding.length) return
      const source = (profile.sources?.[i] ?? 'unknown').split(':')[0]
      rows.push({ sim: rawCosineSimilarity(embedding, new Float32Array(candidate)), source })
    })
    if (rows.length === 0) continue
    rows.sort((a, b) => b.sim - a.sim)
    const agreeing = rows.filter(r => r.sim >= HELD_GROUP_SUGGESTION_FLOOR)
    const anchored = agreeing.find(r => HELD_ANCHOR_SOURCES.has(r.source))
    if (!anchored) continue
    let score: number
    let tier: HeldSuggestionTier
    if (rows.length >= 2) {
      if (agreeing.length < HELD_SUGGESTION_MIN_SUPPORT) continue
      score = rows[1].sim
      tier = score >= HELD_GROUP_HIGH_CONFIDENCE ? 'high' : 'likely'
    } else {
      score = rows[0].sim
      tier = 'likely'
    }
    if (!best || score > best.similarity) {
      best = { name: profile.name, similarity: Number(score.toFixed(4)), tier, agreeing: agreeing.length, of: rows.length, anchor: anchored.source }
    }
  }
  return best
}

/**
 * Carve the held samples into voices.
 *
 * One pairwise matrix. Exact duplicates (the same chunk banked under two
 * session ids) fold into one distinct sample first, or every doubled recording
 * would read as a two-sample voice of perfect coherence. Then repeatedly take
 * the dominant mutually coherent cluster out of what remains until nothing
 * coheres. Whatever is left is loose. A group is at least TWO distinct samples:
 * a lone sample has no evidence of being a voice rather than a noise, and it
 * is listed loose so the reviewer can throw it out or, hearing a real person
 * in it, name it on its own. Members and loose always carry EVERY wav,
 * duplicates included, so naming or discarding consumes the copies too.
 */
export function buildHeldVoiceGroups(
  samples: HeldSample[],
  profiles: VoiceProfile[],
  floor: number = VOICE_COHERENCE_FLOOR,
): { groups: HeldVoiceGroup[]; loose: HeldSampleRef[] } {
  const groups: HeldVoiceGroup[] = []
  if (samples.length === 0) return { groups, loose: [] }
  const sim = pairwiseSimilarityMatrix(samples.map(s => s.embedding))
  // Fold exact duplicates: each distinct sample is represented by its lowest
  // index and carries the refs of every copy.
  const copies = new Map<number, number[]>()
  const rep = samples.map((_, i) => i)
  for (let i = 0; i < samples.length; i++) {
    if (rep[i] !== i) continue
    copies.set(i, [i])
    for (let j = i + 1; j < samples.length; j++) {
      if (rep[j] === j && sim[i][j] >= HELD_DUPLICATE_SIMILARITY) { rep[j] = i; copies.get(i)!.push(j) }
    }
  }
  const refsOf = (idx: number[]): HeldSampleRef[] =>
    idx.flatMap(i => copies.get(i)!).map(i => ({ sessionId: samples[i].sessionId, chunkIndex: samples[i].chunkIndex })).sort(compareRefs)
  let active = [...copies.keys()]
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
      suggestion: suggestProfile(centroid(memberIdx.map(i => samples[i].embedding)), profiles),
    })
    const taken = new Set(memberIdx)
    active = active.filter(i => !taken.has(i))
  }
  groups.sort((a, b) => b.sampleCount - a.sampleCount || b.coherence - a.coherence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const loose = refsOf(active)
  return { groups, loose }
}

/** The listing. Decodes within the budget; anything past it is `pending` and
 *  the background sweep finishes it for the next call. */
export function heldVoiceGroups(opts: { budgetMs?: number } = {}): HeldVoiceGroupsResult {
  const collected = collectHeldSamples({ budgetMs: opts.budgetMs })
  const { groups, loose } = buildHeldVoiceGroups(collected.samples, readVoiceProfiles().profiles)
  if (collected.pending.length > 0) scheduleHeldEmbeddingSweep()
  return {
    groups,
    loose,
    sessions: collected.sessions,
    samples: collected.totalChunks,
    embedded: collected.samples.length,
    pending: collected.pending.length,
    unusable: collected.unusable.length,
    generatedAt: new Date().toISOString(),
  }
}

// ── Background decode ──────────────────────────────────────────────────────

const SWEEP_SLICE_MS = 250
const SWEEP_GAP_MS = 50
let sweepTimer: NodeJS.Timeout | null = null

/**
 * Finish the decodes a listing could not afford, a slice at a time, off the
 * request path. Single-flight; each slice persists through the cache, so a
 * server restart loses at most one slice of work.
 */
export function scheduleHeldEmbeddingSweep(): void {
  if (sweepTimer) return
  const tick = () => {
    sweepTimer = null
    let pending = 0
    try { pending = collectHeldSamples({ budgetMs: SWEEP_SLICE_MS }).pending.length } catch { pending = 0 }
    if (pending > 0) {
      sweepTimer = setTimeout(tick, SWEEP_GAP_MS)
      sweepTimer.unref()
    }
  }
  sweepTimer = setTimeout(tick, SWEEP_GAP_MS)
  sweepTimer.unref()
}

export function __resetHeldEmbeddingSweepForTests(): void {
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = null
}

// ── Corrections ────────────────────────────────────────────────────────────

/** Validate a request body's member list into refs. Throws on shape errors. */
export function parseHeldMembers(raw: unknown): HeldSampleRef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HeldGroupError(400, 'invalid_members', 'members must be a non-empty array of { sessionId, chunkIndex }')
  }
  if (raw.length > MAX_HELD_MEMBERS_PER_REQUEST) {
    throw new HeldGroupError(400, 'too_many_members', `members is capped at ${MAX_HELD_MEMBERS_PER_REQUEST} per request`)
  }
  const seen = new Set<string>()
  const refs: HeldSampleRef[] = []
  for (const item of raw) {
    const sessionId = typeof (item as { sessionId?: unknown })?.sessionId === 'string' ? String((item as { sessionId: string }).sessionId) : ''
    const chunkIndex = Number((item as { chunkIndex?: unknown })?.chunkIndex)
    if (!SESSION_ID_SHAPE.test(sessionId) || sessionId.includes('..') || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new HeldGroupError(400, 'invalid_members', 'each member needs a sessionId and a non-negative integer chunkIndex')
    }
    const ref = { sessionId, chunkIndex }
    if (seen.has(sampleKey(ref))) continue
    seen.add(sampleKey(ref))
    refs.push(ref)
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

/** Remove the wavs behind these refs. Returns what was removed and what was not there. */
export function discardHeldSamples(refs: HeldSampleRef[]): { removed: HeldSampleRef[]; missing: HeldSampleRef[] } {
  const removed: HeldSampleRef[] = []
  const missing: HeldSampleRef[] = []
  const touched = new Map<string, Record<string, string>>()
  for (const ref of refs) {
    const wav = extAudioChunkPath(ref.sessionId, ref.chunkIndex)
    if (!wav) { missing.push(ref); continue }
    try { unlinkSync(wav); removed.push(ref) } catch { missing.push(ref); continue }
    const cache = touched.get(ref.sessionId) ?? readCache(ref.sessionId)
    delete cache[String(ref.chunkIndex)]
    touched.set(ref.sessionId, cache)
  }
  for (const [sessionId, cache] of touched) writeCache(sessionId, cache)
  return { removed, missing }
}

export interface EnrollHeldGroupResult {
  speaker: string
  /** True when no profile of that name existed before. */
  created: boolean
  /** Samples the request named. */
  submitted: number
  /** Of those, the ones still held on disk with a usable vector. */
  resolved: number
  missing: HeldSampleRef[]
  /** The mutually coherent core that was treated as this one voice. */
  coherent: number
  /** Submitted samples that did NOT cohere with the core. Left on disk, untouched. */
  leftBehind: HeldSampleRef[]
  /** Diverse subset of the core actually written to the profile. */
  selected: number
  enrolled: number
  /** Wavs removed: the whole core, selected or not, because all of it is now a known voice. */
  deleted: number
  profileEmbeddings: number
}

/**
 * Name a set of held samples as one person.
 *
 * NEVER cuts a corner on coherence: the submitted set is re-clustered here
 * regardless of what the client believed, and only the mutually coherent core
 * is written. A set that agrees on nothing is refused outright rather than
 * enrolled as "whichever stranger came first". A single sample is allowed —
 * naming sample by sample is exactly what a low-confidence voice needs — and a
 * human hearing one chunk is the evidence.
 *
 * Deletes only the core's wavs. The existing enroll-ext route removed the WHOLE
 * session directory, which in a five-person meeting threw away four people's
 * evidence to name one; here the samples that were not this voice stay held.
 */
export function enrollHeldGroup(name: string, refs: HeldSampleRef[]): EnrollHeldGroupResult {
  const collected = collectHeldSamples({ only: onlyMap(refs), budgetMs: Infinity })
  const have = new Map(collected.samples.map(s => [sampleKey(s), s]))
  const missing = refs.filter(r => !have.has(sampleKey(r)))
  const resolved = refs.filter(r => have.has(sampleKey(r))).map(r => have.get(sampleKey(r))!)
  if (resolved.length === 0) {
    throw new HeldGroupError(404, 'no_samples', 'None of those samples are held any more, or none could be turned into a voiceprint.', {
      missing, unusable: collected.unusable.length,
    })
  }

  let coreIdx: number[]
  if (resolved.length === 1) {
    coreIdx = [0]
  } else {
    const cluster = dominantCoherentCluster(resolved.map(s => s.embedding))
    if (cluster.members.length === 0) {
      throw new HeldGroupError(409, 'incoherent', 'Those samples do not sound like one person. Nothing was enrolled; name them separately or discard the odd ones out.', {
        submitted: refs.length, resolved: resolved.length,
      })
    }
    coreIdx = cluster.members
  }
  const coreSet = new Set(coreIdx)
  const core = coreIdx.map(i => resolved[i])
  const leftBehind = resolved.filter((_, i) => !coreSet.has(i)).map(s => ({ sessionId: s.sessionId, chunkIndex: s.chunkIndex }))

  const existing = readVoiceProfiles().profiles.find(p => p.name === name)
  // A primitive snapshot, taken BEFORE the loop: the store hands back its live
  // `embeddings` array by reference, and enrolment appends to that same array
  // until the first write invalidates the cache. Reading `.length` afterwards
  // counted the new samples twice (caught by the route test, 2026-09-12).
  const existingCount = existing?.embeddings.length ?? 0
  const selected = greedyDiversitySelect(core.map(s => s.embedding), MAX_ENROL_PER_CORRECTION)
  let enrolled = 0
  for (const emb of selected) {
    if (enrollEmbedding(name, emb, HELD_GROUP_SOURCE, true).success) enrolled++
  }
  const { removed } = enrolled > 0
    ? discardHeldSamples(core.map(s => ({ sessionId: s.sessionId, chunkIndex: s.chunkIndex })))
    : { removed: [] as HeldSampleRef[] }

  return {
    speaker: name,
    created: !existing,
    submitted: refs.length,
    resolved: resolved.length,
    missing,
    coherent: core.length,
    leftBehind,
    selected: selected.length,
    enrolled,
    deleted: removed.length,
    profileEmbeddings: existingCount + enrolled,
  }
}
