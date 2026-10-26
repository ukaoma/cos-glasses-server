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
// profile: this path never creates one.
//
// SIMILARITY IS A SUGGESTION. The report carries how close this voice's group is to
// the person's stored centroid, and whether that is under the merge floor. It does
// not refuse on it: a call heard through speakers legitimately sounds unlike a
// glasses mic, and the person choosing the name is the authority. Samples are tagged
// `correction:<sessionId>`, so the existing "Not in this meeting" undo retracts them.

import { readFileSync } from 'node:fs'
import { chunkEmbeddingsEnabled } from './chunk-embedding-store.js'
import { isMacCaptureSidecar, isVoiceLabel } from './mac-voice-labels.js'
import { meetingAudioChunkPath } from './meeting-audio-archive.js'
import { isPlaceholderLabel, resolveRawChunkIndices } from './meeting-relabel-enrolment.js'
import { pcm16ToWav, readPcm16Mono } from './nemotron-segments.js'
import {
  MERGE_SIMILARITY_FLOOR,
  enrollEmbedding,
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
const SAMPLE_RATE = 16_000

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
}

export interface MacAssignPlan {
  report: MacAssignReport
  /** The vectors `commitMacVoiceAssignment` will write. Empty unless `report.skipped === null`. */
  selected: Float32Array[]
}

function emptyReport(person: string, skipped: MacAssignSkip): MacAssignReport {
  return {
    person, enrolled: 0, attempted: 0, created: false, clusterSkipped: 0, multiVoiceSkipped: 0,
    shortSkipped: 0, missingAudio: 0, similarity: null, belowFloor: false, floor: MERGE_SIMILARITY_FLOOR, skipped,
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

/** Read what assigning `from` to `to` WOULD add. Writes nothing anywhere. */
export function planMacVoiceAssignment(input: MacAssignInput): MacAssignPlan {
  const { sessionId, from, to, changed, sidecar } = input
  const none = (skipped: MacAssignSkip): MacAssignPlan => ({ report: emptyReport(to, skipped), selected: [] })

  if (!isMacCaptureSidecar(sidecar, sessionId)) return none('not_mac_capture')
  if (!isVoiceLabel(from)) return none('not_a_voice_label')
  if (isPlaceholderLabel(to)) return none('unknown_profile')
  let profile: { name: string; embeddings: number[][] } | undefined
  try { profile = readVoiceProfiles().profiles.find(p => p.name === to) } catch { return none('store_unavailable') }
  if (!profile) return none('unknown_profile')
  if (!chunkEmbeddingsEnabled()) return none('disabled')
  if (!isEmbeddingAvailable()) return none('store_unavailable')

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
  let foundAudio = 0
  for (const unit of spread(units, MAC_ASSIGN_MAX_UNITS)) {
    const path = meetingAudioChunkPath(sessionId, unit.raw)
    if (!path) { report.missingAudio += 1; continue }
    foundAudio += 1
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
    if ((audio.length - 44) / (SAMPLE_RATE * 2) < VOICEPRINT_MIN_AUDIO_SEC) { report.shortSkipped += 1; continue }
    const embedding = extractEmbedding(audio)
    if (embedding && embedding.length === 192) embeddings.push(embedding)
  }

  report.attempted = embeddings.length
  if (foundAudio === 0) { report.skipped = units.length === 0 ? 'no_usable_audio' : 'audio_not_retained'; return { report, selected: [] } }
  const cluster = dominantCoherentCluster(embeddings)
  report.clusterSkipped = embeddings.length - cluster.members.length
  if (cluster.members.length === 0) { report.skipped = 'no_usable_audio'; return { report, selected: [] } }
  const selected = greedyDiversitySelect(cluster.members.map(m => embeddings[m]), MAX_ENROL_PER_CORRECTION)

  const voice = centroid(selected)
  const stored = centroid(profile.embeddings.map(e => new Float32Array(e)))
  if (voice && stored) {
    report.similarity = Math.round(rawCosineSimilarity(voice, stored) * 1000) / 1000
    report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR
  }
  report.enrolled = selected.length
  return { report, selected }
}

/** Write a plan's vectors into the person's profile. NEVER THROWS: the rename is already durable. */
export function commitMacVoiceAssignment(sessionId: string, plan: MacAssignPlan): MacAssignReport {
  if (plan.report.skipped !== null || plan.selected.length === 0) return { ...plan.report, enrolled: 0 }
  const source = `correction:${sessionId}`
  let enrolled = 0
  try {
    for (const embedding of plan.selected) if (enrollEmbedding(plan.report.person, embedding, source).success) enrolled += 1
  } catch {
    return { ...plan.report, enrolled, skipped: 'store_unavailable' }
  }
  return { ...plan.report, enrolled }
}
