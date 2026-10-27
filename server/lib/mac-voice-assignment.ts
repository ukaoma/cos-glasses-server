// 6.93.0: assign a Mac recording's `Voice N` to an EXISTING voice profile.
//
// Mac audio is call, video and podcast playback through one global tap. Until now a
// Mac rename was text only (6.90.0) and `enrolNamedVoice` still refuses every Mac
// capture on purpose. Miles asked for the one exception: when a person picks an
// ENROLLED name for a `Voice N` and says so, that voice's audio from THIS meeting
// teaches that person's profile. This module is that exception and nothing wider.
//
// WHERE THE AUDIO COMES FROM. A Mac recording banks no per-chunk embeddings
// (transcribe-stream.ts never calls appendChunkEmbedding for a Mac capture), so the
// chunk-embedding store holds nothing for it. What survives a save is the chunk
// WAVs in the 7-day meeting-audio archive, keyed on the RAW capture index, plus the
// sidecar's per-turn `startSec`/`endSec`. So embeddings are extracted here, now, from
// those WAVs. Nothing is invented: no archived audio means no samples and a named
// refusal reason (`audio_not_retained`).
//
// WHICH AUDIO COUNTS. Only chunks the rename actually relabels (their dominant turn
// is `from`). Inside such a chunk:
//   - every turn is `from` (or the chunk has no turns): the whole chunk;
//   - another voice also speaks: only this voice's turns of at least
//     MAC_ASSIGN_MIN_SLICE_SEC, trimmed by MAC_ASSIGN_SLICE_INSET_SEC at each end so
//     a neighbour's word estimate cannot leak in;
//   - nothing long enough: the chunk is skipped (`multiVoiceSkipped`).
// Then the same two gates a G2 rename uses: the dominant mutually coherent group
// (dominantCoherentCluster, floor = the merge/search floor) and the diversity cap
// (greedyDiversitySelect, MAX_ENROL_PER_CORRECTION). Neither is changed here.
//
// FAIL CLOSED. `planMacVoiceAssignment` reads and writes nothing in the profile
// store; the caller shows its report, and only `commitMacVoiceAssignment` writes,
// using the SAME selected vectors the plan produced. The person must already be a
// profile: this path never creates one, and never the owner's.
//
// THREE GATES, all refused with a 409 unless the request carries `force: true` (6.93.0,
// the 2026-10-26 QA). A Mac `Voice N` is not a person: the saved pass keeps every live
// number, so a clean hand-over at a chunk boundary (R1) leaves two people under one
// number, and a name typed over it would write the wrong voice into a real profile.
//   below_floor      the voice's group sounds unlike the person's stored profile (cosine
//                    under MERGE_SIMILARITY_FLOOR, the same floor merge-profiles refuses at).
//   mixed_voice      the coherence gate threw out units as a different voice AND the
//                    kept group is under two thirds of what was embedded: the label
//                    holds more than one voice and the dominant one may be the wrong one.
//   too_little_audio fewer than MAC_ASSIGN_MIN_UNITS coherent units and under
//                    MAC_ASSIGN_MIN_SINGLE_SEC of audio: one short unit cannot contradict itself.
// The report carries every number a person needs to judge it (attempted, clusterSkipped,
// similarity), so the caller shows them rather than a warning.
//
// SAMPLES ARE `mac-assign:<sessionId>`, NOT `correction:`. They rank as assisted, are not
// protected, do not vouch for identity, cannot displace any other sample (only another
// Mac-assigned one), and are capped per profile (embedding-eviction.ts). "Not in this
// meeting" still retracts them (training-audio-provenance.ts).
//
// DOES NOT STALL THE SERVER. Embedding is a synchronous native call (about 0.14 s a unit
// on an M3). The plan yields to the event loop between units, stops at a wall-clock
// deadline, and caches each vector, so the apply after a preview re-embeds nothing and a
// plan that hit the deadline resumes where it stopped when asked again. The commit is one
// batched store write (enrollEmbeddingsBatch).

import { readFileSync, statSync } from 'node:fs'
import { chunkEmbeddingsEnabled } from './chunk-embedding-store.js'
import { isMacCaptureSidecar, isVoiceLabel } from './mac-voice-labels.js'
import { meetingAudioChunkPath } from './meeting-audio-archive.js'
import { isPlaceholderLabel, resolveRawChunkIndices } from './meeting-relabel-enrolment.js'
import { pcm16ToWav, readPcm16Mono } from './nemotron-segments.js'
import { MAC_ASSIGN_SOURCE, isMacAssign, macAssignCapFor } from './embedding-eviction.js'
import {
  MAX_EMBEDDINGS_PER_SPEAKER,
  MERGE_SIMILARITY_FLOOR,
  enrollEmbeddingsBatch,
  extractEmbedding,
  isEmbeddingAvailable,
  rawCosineSimilarity,
  readVoiceProfiles,
} from './speaker-embeddings.js'
import {
  MAX_ENROL_PER_CORRECTION,
  dominantCoherentCluster,
  greedyDiversitySelect,
} from './voice-enrolment-selection.js'
import { VOICEPRINT_MIN_AUDIO_SEC } from './voiceprint-floor.js'

/** A turn shorter than this is not sliced out of a mixed chunk. */
export const MAC_ASSIGN_MIN_SLICE_SEC = 3.0
/** Trimmed from each end of a sliced turn. */
export const MAC_ASSIGN_SLICE_INSET_SEC = 0.15
/** Most audio units embedded per assignment, spread across the meeting. Bounds the CPU a request can spend. */
export const MAC_ASSIGN_MAX_UNITS = 40
/** A coherent group of fewer units than this needs MAC_ASSIGN_MIN_SINGLE_SEC of audio, or it is `too_little_audio`. */
export const MAC_ASSIGN_MIN_UNITS = 2
export const MAC_ASSIGN_MIN_SINGLE_SEC = 6
/** Wall-clock budget for one plan. A plan that hits it reports `deadline`; the vectors it made are kept for the retry. */
export const MAC_ASSIGN_DEADLINE_MS = 12_000
/** A kept group under this fraction of what was embedded, with units thrown out, is `mixed_voice`. */
export const MAC_ASSIGN_MIXED_FRACTION = 2 / 3
const SAMPLE_RATE = 16_000
const VECTOR_CACHE_MAX = 160

export type MacAssignSkip =
  | null
  | 'not_mac_capture'
  | 'not_a_voice_label'
  | 'unknown_profile'
  | 'disabled'
  | 'store_unavailable'
  | 'no_index_mapping'
  | 'audio_not_retained'
  | 'no_usable_audio'
  | 'owner_profile'
  | 'no_stored_voice'
  | 'profile_full'
  | 'deadline'

/** Why a plan that has audio still needs `force: true` to be written. */
export type MacAssignGate = 'below_floor' | 'mixed_voice' | 'too_little_audio'

export interface MacAssignReport {
  /** The enrolled person the samples would go to. */
  person: string
  /** Samples written, or, on a plan, the most that would be (the store's near-duplicate gate can still drop some). */
  enrolled: number
  /** Audio units embedded for this voice, before the coherence gate. */
  attempted: number
  /** Always false: this path appends to an existing profile and never makes one. */
  created: false
  /** Units rejected as a different voice by the coherence gate. */
  clusterSkipped: number
  /** Chunks where another voice also speaks and this one had no turn long enough to use. */
  multiVoiceSkipped: number
  /** Whole chunks under the voiceprint minimum. */
  shortSkipped: number
  /** Chunks whose archived audio is gone. */
  missingAudio: number
  /** Cosine of this voice's group centroid against the person's stored centroid, or null when there is no group. A suggestion, not a verdict. */
  similarity: number | null
  /** True when `similarity` is under the merge floor: the voice sounds unlike the stored profile. */
  belowFloor: boolean
  floor: number
  /** Coherent units kept, before the diversity cap, and their total audio in seconds. */
  groupSize: number
  groupSec: number
  /** Gates that need `force: true`, strongest first. Empty when the plan can be written as it stands. */
  gates: MacAssignGate[]
  skipped: MacAssignSkip
}

export interface MacAssignInput {
  sessionId: string
  from: string
  to: string
  /** `plan.value.changed`: COMPACTED sidecar positions, never raw indices. */
  changed: number[]
  /** The parsed sidecar BEFORE the rename (turn labels are still `from`). */
  sidecar: Record<string, unknown>
  /** The wearer's own speaker label. Never a target: Mac capture has no microphone. */
  ownerLabel?: string
  /** Test seams. */
  deadlineMs?: number
  now?: () => number
  yieldToLoop?: () => Promise<void>
}

export interface MacAssignPlan {
  report: MacAssignReport
  /** The vectors `commitMacVoiceAssignment` will write. Empty unless `report.skipped === null`. */
  selected: Float32Array[]
  /** Counts for the log and the timing receipts. */
  stats: { units: number; embedded: number; reused: number; ms: number }
}

const sameName = (a: string, b: string): boolean => a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase()

function deadlineMsFromEnv(): number {
  const raw = Number(process.env.COS_MAC_ASSIGN_DEADLINE_MS)
  return Number.isFinite(raw) && raw >= 1000 && raw <= 25_000 ? Math.floor(raw) : MAC_ASSIGN_DEADLINE_MS
}

// One plan's vectors, kept for the next. Keyed on the chunk file's size and mtime plus the slice, so a changed
// file never reuses a stale vector. In memory only: a voiceprint never goes to disk from here.
const vectorCache = new Map<string, { vec: Float32Array; sec: number }>()
function cacheGet(key: string): { vec: Float32Array; sec: number } | undefined {
  const hit = vectorCache.get(key)
  if (hit) { vectorCache.delete(key); vectorCache.set(key, hit) }
  return hit
}
function cacheSet(key: string, value: { vec: Float32Array; sec: number }): void {
  vectorCache.delete(key)
  vectorCache.set(key, value)
  while (vectorCache.size > VECTOR_CACHE_MAX) vectorCache.delete(vectorCache.keys().next().value as string)
}
export function __clearMacAssignVectorCacheForTests(): void { vectorCache.clear() }

function emptyReport(person: string, skipped: MacAssignSkip): MacAssignReport {
  return {
    person, enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, multiVoiceSkipped: 0,
    shortSkipped: 0, missingAudio: 0, similarity: null, belowFloor: false, floor: MERGE_SIMILARITY_FLOOR,
    groupSize: 0, groupSec: 0, gates: [], skipped,
  }
}

interface Turn { speaker: string; startSec?: number; endSec?: number }
interface Unit { raw: number; slice: { startSec: number; endSec: number } | null }

function turnsOf(chunk: Record<string, unknown> | undefined): Turn[] {
  if (!chunk) return []
  const final = chunk.finalSegments
  const live = chunk.segments
  const list = Array.isArray(final) && final.length > 0 ? final : Array.isArray(live) ? live : []
  return list.filter((t): t is Turn => !!t && typeof t === 'object' && typeof (t as Turn).speaker === 'string')
}

function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  for (let k = 0; k < max; k++) out.push(items[Math.floor((k * items.length) / max)])
  return out
}

function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null
  const out = new Float32Array(vectors[0].length)
  for (const v of vectors) {
    if (v.length !== out.length) return null
    for (let i = 0; i < out.length; i++) out[i] += v[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length
  return out
}

/** Read what assigning `from` to `to` WOULD add. Writes nothing to the profile store. Yields to the event loop between units. */
export async function planMacVoiceAssignment(input: MacAssignInput): Promise<MacAssignPlan> {
  const { sessionId, from, to, changed, sidecar } = input
  const now = input.now ?? Date.now
  const yieldToLoop = input.yieldToLoop ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  const started = now()
  const stats = { units: 0, embedded: 0, reused: 0, ms: 0 }
  const none = (skipped: MacAssignSkip): MacAssignPlan => ({ report: emptyReport(to, skipped), selected: [], stats })

  if (!isMacCaptureSidecar(sidecar, sessionId)) return none('not_mac_capture')
  if (!isVoiceLabel(from)) return none('not_a_voice_label')
  if (isPlaceholderLabel(to)) return none('unknown_profile')
  if (input.ownerLabel && sameName(to, input.ownerLabel)) return none('owner_profile')
  let profile: { name: string; embeddings: number[][]; sources?: string[] } | undefined
  try { profile = readVoiceProfiles().profiles.find(p => p.name === to) } catch { return none('store_unavailable') }
  if (!profile) return none('unknown_profile')
  if (!chunkEmbeddingsEnabled()) return none('disabled')
  if (!isEmbeddingAvailable()) return none('store_unavailable')

  const stored = centroid(profile.embeddings.map(e => new Float32Array(e)))
  if (!stored) return none('no_stored_voice')
  const macCount = (profile.sources ?? []).filter(src => isMacAssign(src)).length
  const capacity = Math.min(macAssignCapFor(profile.embeddings.length, macCount), Math.max(0, MAX_EMBEDDINGS_PER_SPEAKER - profile.embeddings.length) + macCount)
  if (capacity <= 0) return none('profile_full')

  const rawIndices = resolveRawChunkIndices(sidecar, changed)
  if (!rawIndices) return none('no_index_mapping')

  const chunksByRaw = new Map<number, Record<string, unknown>>()
  for (const entry of Array.isArray(sidecar.chunkEntries) ? sidecar.chunkEntries as Array<Record<string, unknown>> : []) {
    if (typeof entry?.chunkIndex === 'number' && entry.chunk && typeof entry.chunk === 'object') chunksByRaw.set(entry.chunkIndex, entry.chunk as Record<string, unknown>)
  }

  const report = emptyReport(to, null)
  const units: Unit[] = []
  for (const raw of [...new Set(rawIndices)].sort((a, b) => a - b)) {
    const turns = turnsOf(chunksByRaw.get(raw))
    if (turns.length === 0 || turns.every(t => t.speaker === from)) { units.push({ raw, slice: null }); continue }
    const usable = turns.filter(t => t.speaker === from
      && Number.isFinite(t.startSec) && Number.isFinite(t.endSec)
      && (t.endSec as number) - (t.startSec as number) >= MAC_ASSIGN_MIN_SLICE_SEC)
    if (usable.length === 0) { report.multiVoiceSkipped += 1; continue }
    for (const t of usable) units.push({
      raw,
      slice: { startSec: (t.startSec as number) + MAC_ASSIGN_SLICE_INSET_SEC, endSec: (t.endSec as number) - MAC_ASSIGN_SLICE_INSET_SEC },
    })
  }

  const embeddings: Float32Array[] = []
  const secs: number[] = []
  let foundAudio = 0
  const picked = spread(units, MAC_ASSIGN_MAX_UNITS)
  stats.units = picked.length
  const deadline = started + (input.deadlineMs ?? deadlineMsFromEnv())
  for (const unit of picked) {
    if (now() >= deadline) {
      // Not a partial answer: a subset of the meeting's spread is not what the person previewed. The vectors made
      // so far are cached, so asking again continues from here.
      stats.ms = now() - started
      report.attempted = embeddings.length
      report.skipped = 'deadline'
      console.warn(`[mac-assign] plan hit its ${input.deadlineMs ?? deadlineMsFromEnv()} ms deadline: units=${picked.length} embedded=${stats.embedded} reused=${stats.reused}`)
      return { report, selected: [], stats }
    }
    await yieldToLoop()
    const path = meetingAudioChunkPath(sessionId, unit.raw)
    if (!path) { report.missingAudio += 1; continue }
    let key: string
    try {
      const info = statSync(path)
      key = `${sessionId}|${unit.raw}|${unit.slice ? `${unit.slice.startSec.toFixed(3)}-${unit.slice.endSec.toFixed(3)}` : 'whole'}|${info.size}|${Math.round(info.mtimeMs)}|${info.ino}|${Math.round(info.ctimeMs)}`
    } catch { report.missingAudio += 1; continue }
    foundAudio += 1
    const hit = cacheGet(key)
    if (hit) { stats.reused += 1; embeddings.push(hit.vec); secs.push(hit.sec); continue }
    let wav: Buffer
    try { wav = readFileSync(path) } catch { report.missingAudio += 1; continue }
    const pcm = readPcm16Mono(wav)
    if (!pcm || pcm.sampleRate !== SAMPLE_RATE) continue
    let audio = wav
    if (unit.slice) {
      const from16 = Math.max(0, Math.round(unit.slice.startSec * SAMPLE_RATE)) * 2
      const to16 = Math.min(pcm.pcm.length, Math.round(unit.slice.endSec * SAMPLE_RATE) * 2)
      if (to16 <= from16) continue
      audio = pcm16ToWav(pcm.pcm.subarray(from16, to16))
    }
    const sec = (audio.length - 44) / (SAMPLE_RATE * 2)
    if (sec < VOICEPRINT_MIN_AUDIO_SEC) { report.shortSkipped += 1; continue }
    const embedding = extractEmbedding(audio)
    stats.embedded += 1
    if (embedding && embedding.length === 192) {
      cacheSet(key, { vec: embedding, sec })
      embeddings.push(embedding)
      secs.push(sec)
    }
  }
  stats.ms = now() - started
  console.log(`[mac-assign] plan: units=${picked.length} embedded=${stats.embedded} reused=${stats.reused} ${stats.ms} ms`)

  report.attempted = embeddings.length
  if (foundAudio === 0) { report.skipped = units.length === 0 ? 'no_usable_audio' : 'audio_not_retained'; return { report, selected: [], stats } }
  const cluster = dominantCoherentCluster(embeddings)
  report.clusterSkipped = embeddings.length - cluster.members.length
  if (cluster.members.length === 0) { report.skipped = 'no_usable_audio'; return { report, selected: [], stats } }
  report.groupSize = cluster.members.length
  report.groupSec = Math.round(cluster.members.reduce((sum, m) => sum + secs[m], 0) * 10) / 10
  // greedyDiversitySelect seeds with a PAIR, so a cap of 1 would return 2: slice to the room this profile really has.
  const selected = greedyDiversitySelect(cluster.members.map(m => embeddings[m]), Math.min(MAX_ENROL_PER_CORRECTION, capacity)).slice(0, capacity)

  const voice = centroid(selected)
  if (voice) {
    report.similarity = Math.round(rawCosineSimilarity(voice, stored) * 1000) / 1000
    report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR
  }
  if (report.belowFloor) report.gates.push('below_floor')
  // With nothing thrown out the group IS everything embedded, so this only fires when units were rejected as a different voice.
  if (report.groupSize < embeddings.length * MAC_ASSIGN_MIXED_FRACTION) report.gates.push('mixed_voice')
  if (report.groupSize < MAC_ASSIGN_MIN_UNITS && report.groupSec < MAC_ASSIGN_MIN_SINGLE_SEC) report.gates.push('too_little_audio')
  report.enrolled = selected.length
  return { report, selected, stats }
}

/** Write a plan's vectors into the person's profile in ONE store write. NEVER THROWS: the rename is already durable. */
export function commitMacVoiceAssignment(sessionId: string, plan: MacAssignPlan): MacAssignReport {
  if (plan.report.skipped !== null || plan.selected.length === 0) return { ...plan.report, enrolled: 0 }
  const source = `${MAC_ASSIGN_SOURCE}:${sessionId}`
  try {
    const result = enrollEmbeddingsBatch(plan.report.person, plan.selected.map(embedding => ({ embedding, source })))
    if (!result.persisted) return { ...plan.report, enrolled: 0, skipped: 'store_unavailable' }
    return { ...plan.report, enrolled: result.enrolled }
  } catch {
    return { ...plan.report, enrolled: 0, skipped: 'store_unavailable' }
  }
}
