// Pure preparation/qualification only. The caller verifies WAVs, runs extraction,
// authenticates these receipts and applies reviewed exact-span candidates.
import { createHash } from 'node:crypto'
import { isVoiceLabel } from './mac-voice-labels.js'
import {
  createMacSpeakerMemory, matchMacSpeakerProfile, normalizedSpeakerCosine, normalizedSpeakerEmbedding,
  reconcileMacSpeakerObservation, type MacSpeakerObservation, type MacSpeakerProfile,
} from './mac-speaker-reconcile.js'
import type { SidecarEntry } from './nemotron-final.js'
const SR = 16_000
const SHA = /^[a-f0-9]{64}$/
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const samplePosition = (value: number): number => Number.isFinite(value) && Math.abs(value - Math.round(value)) <= 1e-6 ? Math.round(value) : Number.NaN
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const MAC_SPEAKER_WINDOW_VERSION = 'exact-window-v1'
export interface VerifiedMacRawChunk {
  chunkIndex: number
  audioSHA256: string
  pcmSHA256: string
  sampleRate: 16000
  channels: 1
  format: 'pcm_s16le'
  sampleCount: number
  verified: true
}
export interface MacWindowSource extends VerifiedMacRawChunk {
  startSample: number
  endSample: number
  /** Automatic segment span coverage, not independent VAD/purity ground truth. */
  speechSamples: number
  textSHA256: string
  segmentsSHA256: string
}
export interface PreparedMacSpeakerWindow {
  id: string
  captureId: string
  originalVoiceHint: string
  startSample: number
  endSample: number
  sampleCount: number
  speechSamples: number
  sources: MacWindowSource[]
  bindingSHA256: string
}
export interface MacSpeakerWindowPlan {
  version: typeof MAC_SPEAKER_WINDOW_VERSION
  captureId: string
  /** These families are candidate scheduling hints, never speaker identities. */
  families: { originalVoiceHint: string; windowIds: string[] }[]
  windows: PreparedMacSpeakerWindow[]
  rejected: { chunkIndexes: number[]; reason: string }[]
  thresholds: { windowSamples: number; minimumWindowSamples: number; minimumSpeechSamples: number }
}
export interface MacSpeakerWindowInput {
  sidecar: { sessionId: string; correctionRevision?: number; chunkEntries?: SidecarEntry[] }
  rawChunks: VerifiedMacRawChunk[]
  /** Includes ledger-only legacy corrections; unavailable must fail closed. */
  correctionHistory: 'verified-clear' | 'human-corrected' | 'unavailable'
  correctedChunkIndexes?: readonly number[]
  minimumSpeechSamples?: number
}
function sourceOf(entry: SidecarEntry, raw: VerifiedMacRawChunk | undefined): { source?: MacWindowSource; hint?: string; reason?: string } {
  const c = entry?.chunk
  if (!c || !raw || !uint(entry.chunkIndex) || raw.chunkIndex !== entry.chunkIndex || raw.verified !== true
    || raw.sampleRate !== SR || raw.channels !== 1 || raw.format !== 'pcm_s16le' || !uint(raw.sampleCount) || !raw.sampleCount || raw.sampleCount > 480_000
    || !SHA.test(raw.audioSHA256) || !SHA.test(raw.pcmSHA256) || c.audioSha256 !== raw.audioSHA256) return { reason: 'unverified_raw_binding' }
  if (c.speakerPolicy !== 'high-confidence' || !isVoiceLabel(c.speaker) || typeof c.text !== 'string' || !c.text.trim()) return { reason: 'not_automatic_homogeneous' }
  if (c.speakerOrigin === 'manual' || c.speakerSource === 'manual' || c.manuallyCorrected === true) return { reason: 'human_corrected' }
  const segments = c.segments
  if (!Array.isArray(segments) || !segments.length || segments.length > 1024 || segments.some(s => s?.speaker !== c.speaker)
    || segments.map(s => s.text).join(' ').trim().split(/\s+/).join(' ') !== c.text.trim().split(/\s+/).join(' ')) return { reason: 'not_automatic_homogeneous' }
  const startSample = samplePosition(Number(c.elapsed) * SR / 1000)
  if (!uint(startSample) || !Number.isSafeInteger(startSample + raw.sampleCount)) return { reason: 'bad_clock' }
  let end = 0, speechSamples = 0
  for (const s of segments) {
    const a = samplePosition(Number(s.startSec) * SR), b = samplePosition(Number(s.endSec) * SR)
    if (!uint(a) || !uint(b) || a < end || b <= a || b > raw.sampleCount || (s as unknown as Record<string, unknown>).overlap === true || (s as unknown as Record<string, unknown>).mixedSpeakers === true) return { reason: 'mixed_or_invalid_segments' }
    speechSamples += b - a; end = b
  }
  return { source: { ...structuredClone(raw), startSample, endSample: startSample + raw.sampleCount, speechSamples,
    textSHA256: hash(c.text), segmentsSHA256: hash(segments) }, hint: c.speaker }
}
/** Non-overlapping original chunks only. No cross-label concatenation, gap
 * filling, arbitrary crops, inferred names or automatic enrollment. */
export function planMacSpeakerWindows(input: MacSpeakerWindowInput): MacSpeakerWindowPlan {
  const captureId = input.sidecar.sessionId
  const minimumSpeechSamples = input.minimumSpeechSamples ?? 320_000
  const plan: MacSpeakerWindowPlan = { version: MAC_SPEAKER_WINDOW_VERSION, captureId, families: [], windows: [], rejected: [], thresholds: { windowSamples: 480_000, minimumWindowSamples: 448_000, minimumSpeechSamples } }
  if (typeof captureId !== 'string' || !captureId || captureId.length > 200 || !uint(minimumSpeechSamples) || minimumSpeechSamples < 32_000 || minimumSpeechSamples > 480_000) throw new Error('mac_window_input')
  const entries = input.sidecar.chunkEntries
  if (!Array.isArray(entries) || entries.length > 65536 || !Array.isArray(input.rawChunks) || input.rawChunks.length > 65536) throw new Error('mac_window_bound')
  const refuse = (indexes: number[], reason: string) => { plan.rejected.push({ chunkIndexes: indexes, reason }) }
  if (input.correctionHistory !== 'verified-clear' || !uint(input.sidecar.correctionRevision ?? 0) || Number(input.sidecar.correctionRevision ?? 0) > 0) {
    refuse(entries.map(e => e.chunkIndex), 'human_history_not_clear'); return plan
  }
  const raw = new Map<number, VerifiedMacRawChunk>()
  const duplicates = new Set<number>()
  for (const r of input.rawChunks) { if (raw.has(r.chunkIndex)) duplicates.add(r.chunkIndex); raw.set(r.chunkIndex, r) }
  const entryCounts = new Map<number, number>()
  for (const e of entries) entryCounts.set(e.chunkIndex, (entryCounts.get(e.chunkIndex) ?? 0) + 1)
  for (const [index, count] of entryCounts) if (count > 1) duplicates.add(index)
  const seenChunks = new Set<number>(), seenAudio = new Set<string>(), seenPCM = new Set<string>()
  const corrected = new Set(input.correctedChunkIndexes ?? [])
  let pending: MacWindowSource[] = [], hint = ''
  let lastSource: MacWindowSource | undefined
  const flush = (reason: string) => { if (pending.length) refuse(pending.map(s => s.chunkIndex), reason); pending = []; hint = '' }
  const finish = () => {
    const first = pending[0], last = pending.at(-1)!
    const sampleCount = pending.reduce((n, s) => n + s.sampleCount, 0)
    const speechSamples = pending.reduce((n, s) => n + s.speechSamples, 0)
    if (speechSamples < minimumSpeechSamples) { flush('insufficient_speech'); return }
    const body = { captureId, originalVoiceHint: hint, startSample: first.startSample, endSample: last.endSample, sampleCount, speechSamples, sources: pending }
    const bindingSHA256 = hash(body)
    plan.windows.push({ ...structuredClone(body), id: `window_${bindingSHA256}`, bindingSHA256 })
    pending = []; hint = ''
  }
  const close = (reason: string) => {
    if (pending.reduce((n, s) => n + s.sampleCount, 0) >= plan.thresholds.minimumWindowSamples) finish()
    else flush(reason)
  }
  for (const entry of entries) {
    const index = entry?.chunkIndex
    if (seenChunks.has(index) || duplicates.has(index)) { close('duplicate_raw_index'); refuse([index], 'duplicate_raw_index'); continue }
    seenChunks.add(index)
    const candidate = sourceOf(entry, raw.get(index))
    if (corrected.has(index) || candidate.reason) { close('interrupted_window'); refuse([index], corrected.has(index) ? 'human_corrected' : candidate.reason!); continue }
    const source = candidate.source!
    if (seenAudio.has(source.audioSHA256) || seenPCM.has(source.pcmSHA256)) { close('duplicate_audio'); refuse([index], 'duplicate_audio'); continue }
    seenAudio.add(source.audioSHA256); seenPCM.add(source.pcmSHA256)
    if (lastSource && source.startSample < lastSource.endSample) { close('clock_overlap'); refuse([index], 'clock_overlap'); continue }
    lastSource = source
    if (pending.length && (source.startSample !== pending.at(-1)!.endSample || index !== pending.at(-1)!.chunkIndex + 1)) close('clock_or_raw_gap')
    if (pending.length && candidate.hint !== hint) close('hint_changed')
    if (pending.reduce((n, s) => n + s.sampleCount, 0) + source.sampleCount > 480_000) close('partial_window')
    if (pending.length >= 240) close('source_count_bound')
    hint = candidate.hint!; pending.push(source)
    if (pending.reduce((n, s) => n + s.sampleCount, 0) === 480_000) finish()
  }
  close('partial_window')
  const families = new Map<string, string[]>()
  for (const w of plan.windows) { const ids = families.get(w.originalVoiceHint) ?? []; ids.push(w.id); families.set(w.originalVoiceHint, ids) }
  plan.families = [...families].map(([originalVoiceHint, windowIds]) => ({ originalVoiceHint, windowIds }))
  return plan
}
export interface MacWindowEmbeddingReceipt {
  windowId: string
  windowBindingSHA256: string
  modelSHA256: string
  /** Verified bytes of the exact prepared concatenation, not a crop. */
  audioSHA256: string
  pcmSHA256: string
  sampleCount: number
  embedding: readonly number[]
  /** Sensitivity evidence only, never two additional independent observations. */
  halfEmbeddings?: readonly [readonly number[], readonly number[]]
}
export interface QualifiedMacWindowCandidate {
  windowId: string
  startSample: number
  endSample: number
  originalVoiceHint: string
  status: 'qualified' | 'preserve'
  reason: string
  /** Opaque cohort identity. Never a global rename of originalVoiceHint. */
  acousticIdentity?: string
  profileName?: string
  evidence: string[]
  provenance: { algorithm: typeof MAC_SPEAKER_WINDOW_VERSION; modelSHA256: string; profileSHA256?: string; anonymousCosine: .90; anonymousMargin: .06; identityCosine: .88; identityMargin: .05 }
}
function preparedWindowValid(w: PreparedMacSpeakerWindow, plan: MacSpeakerWindowPlan): boolean {
  if (!w || w.captureId !== plan.captureId || !isVoiceLabel(w.originalVoiceHint) || !uint(w.startSample) || !uint(w.endSample)
    || !uint(w.sampleCount) || w.sampleCount < 448_000 || w.sampleCount > 480_000 || w.endSample - w.startSample !== w.sampleCount || !uint(w.speechSamples)
    || w.speechSamples < plan.thresholds.minimumSpeechSamples || w.speechSamples > w.sampleCount || !Array.isArray(w.sources) || !w.sources.length || w.sources.length > 240) return false
  let samples = 0, speech = 0
  for (let i = 0; i < w.sources.length; i++) {
    const s = w.sources[i], previous = w.sources[i - 1]
    if (!s || s.verified !== true || s.sampleRate !== SR || s.channels !== 1 || s.format !== 'pcm_s16le' || !uint(s.chunkIndex)
      || !uint(s.startSample) || !uint(s.endSample) || !uint(s.sampleCount) || s.sampleCount <= 0 || s.endSample - s.startSample !== s.sampleCount
      || !uint(s.speechSamples) || s.speechSamples > s.sampleCount || !SHA.test(s.audioSHA256) || !SHA.test(s.pcmSHA256) || !SHA.test(s.textSHA256) || !SHA.test(s.segmentsSHA256)
      || (previous && (s.chunkIndex !== previous.chunkIndex + 1 || s.startSample !== previous.endSample))) return false
    samples += s.sampleCount; speech += s.speechSamples
  }
  return samples === w.sampleCount && speech === w.speechSamples && w.sources[0].startSample === w.startSample && w.sources.at(-1)!.endSample === w.endSample
}

/** Cohorts require independent whole windows. Old Voice labels supply no votes.
 * A qualified candidate is a proposal for this exact span, never permission to
 * rename every occurrence of its hint. Frozen profiles are only read. */
export function qualifyMacSpeakerWindows(plan: MacSpeakerWindowPlan, receipts: readonly MacWindowEmbeddingReceipt[], profiles: readonly MacSpeakerProfile[], modelSHA256: string, dimensions = 192): QualifiedMacWindowCandidate[] {
  if (plan.version !== MAC_SPEAKER_WINDOW_VERSION || plan.thresholds.windowSamples !== 480_000 || plan.thresholds.minimumWindowSamples !== 448_000 || !uint(plan.thresholds.minimumSpeechSamples) || plan.thresholds.minimumSpeechSamples < 32_000 || plan.thresholds.minimumSpeechSamples > 480_000 || !SHA.test(modelSHA256) || !uint(dimensions) || !dimensions || dimensions > 4096 || plan.windows.length > 8192 || receipts.length > 8192) throw new Error('mac_window_qualification_input')
  let memory = createMacSpeakerMemory(plan.captureId, modelSHA256, { dimensions, maxIdentities: 128, maxOriginals: 8192 })
  const byId = new Map<string, MacWindowEmbeddingReceipt>(), duplicate = new Set<string>()
  for (const r of receipts) { if (byId.has(r.windowId)) duplicate.add(r.windowId); byId.set(r.windowId, r) }
  const candidates: QualifiedMacWindowCandidate[] = []
  const cohorts = new Map<number, { index: number; observation: MacSpeakerObservation }[]>()
  const seenSources = new Set<number>(), seenRawPCM = new Set<string>(), seenRawAudio = new Set<string>()
  for (let i = 0; i < plan.windows.length; i++) {
    const w = plan.windows[i], r = byId.get(w.id)
    const provenance: QualifiedMacWindowCandidate['provenance'] = { algorithm: MAC_SPEAKER_WINDOW_VERSION, modelSHA256, anonymousCosine: .90 as const, anonymousMargin: .06 as const, identityCosine: .88 as const, identityMargin: .05 as const }
    const candidate: QualifiedMacWindowCandidate = { windowId: w.id, startSample: w.startSample, endSample: w.endSample, originalVoiceHint: w.originalVoiceHint, status: 'preserve', reason: 'missing_embedding', evidence: [], provenance }
    candidates.push(candidate)
    const { id: _id, bindingSHA256, ...body } = w
    if (!r) continue
    if (!preparedWindowValid(w, plan) || duplicate.has(w.id) || r.modelSHA256 !== modelSHA256 || r.windowBindingSHA256 !== bindingSHA256 || hash(body) !== bindingSHA256 || w.id !== `window_${bindingSHA256}`
      || w.captureId !== plan.captureId || !uint(w.sampleCount) || w.sampleCount < 448_000 || w.sampleCount > 480_000 || w.endSample - w.startSample !== w.sampleCount || r.sampleCount !== w.sampleCount
      || !SHA.test(r.audioSHA256) || !SHA.test(r.pcmSHA256) || !normalizedSpeakerEmbedding(r.embedding, dimensions)
      || w.sources.some(s => seenSources.has(s.chunkIndex) || seenRawPCM.has(s.pcmSHA256) || seenRawAudio.has(s.audioSHA256))) { candidate.reason = 'receipt_or_lineage_conflict'; continue }
    for (const source of w.sources) { seenSources.add(source.chunkIndex); seenRawPCM.add(source.pcmSHA256); seenRawAudio.add(source.audioSHA256) }
    if (r.halfEmbeddings && (r.halfEmbeddings.length !== 2 || r.halfEmbeddings.some(v => !normalizedSpeakerEmbedding(v, dimensions))
      || normalizedSpeakerCosine(r.halfEmbeddings[0], r.halfEmbeddings[1])! < .90
      || r.halfEmbeddings.some(v => normalizedSpeakerCosine(v, r.embedding)! < .90))) { candidate.reason = 'incoherent_halves'; continue }
    const observation: MacSpeakerObservation = { captureId: plan.captureId, modelSHA256,
      original: { chunkIndex: i, audioSHA256: r.audioSHA256, pcmSHA256: r.pcmSHA256, startSample: w.startSample, sampleCount: w.sampleCount },
      startSample: w.startSample, endSample: w.endSample, exclusiveSamples: w.speechSamples, purity: 1, overlapSamples: 0, mixedSpeakers: false, embedding: r.embedding }
    const next = reconcileMacSpeakerObservation(memory, observation)
    memory = next.state; candidate.reason = next.decision.reason; candidate.evidence = next.decision.evidence
    if (next.decision.identityId !== undefined) {
      const group = cohorts.get(next.decision.identityId) ?? []; group.push({ index: i, observation }); cohorts.set(next.decision.identityId, group)
    }
  }
  for (const [identity, group] of cohorts) {
    if (memory.identities[identity - 1]?.voice === null || group.length < 2) continue
    if (group.some(a => group.some(b => normalizedSpeakerCosine(a.observation.embedding, b.observation.embedding)! < .90))) {
      for (const item of group) candidates[item.index].reason = 'inconsistent_complete_link'
      continue
    }
    const acousticIdentity = `acoustic_${hash(group.map(g => plan.windows[g.index].bindingSHA256).sort())}`
    const proposal = matchMacSpeakerProfile(memory, group.map(g => g.observation), profiles)
    const evidence = group.map(g => plan.windows[g.index].bindingSHA256)
    for (const item of group) {
      const c = candidates[item.index]
      c.status = 'qualified'; c.reason = proposal.reason === 'matched_profile' ? 'qualified_profile' : 'qualified_anonymous'
      c.acousticIdentity = acousticIdentity; c.evidence = evidence
      if (proposal.reason === 'matched_profile') { c.profileName = proposal.label!; c.provenance.profileSHA256 = proposal.provenance.profileSHA256 }
    }
  }
  return candidates
}
