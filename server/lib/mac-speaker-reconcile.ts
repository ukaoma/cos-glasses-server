// Pure, opt-in acoustic evidence engine. No audio/model loading, file IO, enrollment,
// transcript mutation, attendee inference or production enablement belongs here.
import { createHash } from 'node:crypto'
import { checkSpeakerName } from './speaker-name.js'

const SHA = /^[a-f0-9]{64}$/
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (why: string): never => { throw new Error(`mac_speaker_reconcile_${why}`) }
export const MAC_SPEAKER_RECONCILE_VERSION = 'acoustic-memory-v1'
export interface MacSpeakerThresholds {
  dimensions: number
  anonymousCosine: number
  anonymousMargin: number
  identityCosine: number
  identityMargin: number
  minimumIndependentMatches: number
  minimumSamples: number
  minimumPurity: number
  maxIdentities: number
  maxAnchorsPerIdentity: number
  maxOriginals: number
}
/** Anonymous recurrence is not real-name recognition. These are conservative,
 * unqualified defaults, not measured accuracy claims. Identity cannot go below .88. */
export const DEFAULT_MAC_SPEAKER_THRESHOLDS: Readonly<MacSpeakerThresholds> = Object.freeze({
  dimensions: 192, anonymousCosine: .90, anonymousMargin: .06,
  identityCosine: .88, identityMargin: .05, minimumIndependentMatches: 2,
  minimumSamples: 32_000, minimumPurity: .95,
  maxIdentities: 128, maxAnchorsPerIdentity: 4, maxOriginals: 8192,
})
export interface MacSpeakerOriginal {
  chunkIndex: number
  audioSHA256: string
  pcmSHA256: string
  startSample: number
  sampleCount: number
}
export interface MacSpeakerObservation {
  captureId: string
  modelSHA256: string
  original: MacSpeakerOriginal
  startSample: number
  endSample: number
  exclusiveSamples: number
  purity: number
  overlapSamples: number
  mixedSpeakers: boolean
  embedding: readonly number[]
  /** Existing human/manual identity is immutable and never contributes training. */
  protectedLabel?: { label: string; origin: 'named' | 'manual' }
}
export interface MacSpeakerAnchor {
  original: MacSpeakerOriginal
  startSample: number
  endSample: number
  exclusiveSamples: number
  purity: number
  embedding: number[]
  /** Binds normalized vector + exact original/sample geometry to model/capture. */
  observationSHA256: string
}
export interface MacAcousticIdentity {
  id: number
  /** Null means provisional evidence only; never display it as a settled voice. */
  voice: number | null
  anchors: MacSpeakerAnchor[]
}
export interface MacSpeakerMemory {
  version: typeof MAC_SPEAKER_RECONCILE_VERSION
  captureId: string
  modelSHA256: string
  thresholds: MacSpeakerThresholds
  voiceHighWater: number
  identities: MacAcousticIdentity[]
  /** Compact lineage survives per-identity anchor retention. Never prune it to
   * make a crop/replay appear independent; exhaustion explicitly withholds. */
  originals: MacSpeakerOriginal[]
}
export type MacSpeakerReason = 'invalid_observation' | 'protected_label' | 'duplicate_source' | 'source_conflict'
  | 'crossed_originals' | 'mixed_or_overlap' | 'insufficient_clean_audio' | 'budget_exhausted'
  | 'ambiguous' | 'inconsistent_anchors' | 'provisional' | 'confirmed_anonymous' | 'recurring_anonymous'
  | 'insufficient_independent_matches' | 'profile_below_floor' | 'profile_ambiguity' | 'profile_disagreement' | 'matched_profile'
export interface MacSpeakerDecision {
  reason: MacSpeakerReason
  label: string | null
  confidence: 'withheld' | 'provisional' | 'acoustic' | 'protected' | 'profile'
  identityId?: number
  evidence: string[]
  scores: { candidate: string; minimumCosine: number; maximumCosine: number }[]
  provenance: { algorithm: typeof MAC_SPEAKER_RECONCILE_VERSION; captureId: string; modelSHA256: string; thresholds: MacSpeakerThresholds; profileSHA256?: string }
}
function config(overrides: Partial<MacSpeakerThresholds> = {}): MacSpeakerThresholds {
  const c = { ...DEFAULT_MAC_SPEAKER_THRESHOLDS, ...overrides }
  for (const k of ['dimensions', 'minimumIndependentMatches', 'minimumSamples', 'maxIdentities', 'maxAnchorsPerIdentity', 'maxOriginals'] as const)
    if (!uint(c[k]) || c[k] < 1) fail('thresholds')
  if (c.dimensions > 4096 || c.minimumIndependentMatches < 2 || c.maxAnchorsPerIdentity < c.minimumIndependentMatches
    || c.maxAnchorsPerIdentity > 64 || c.maxIdentities > 1024 || c.maxOriginals > 65536) fail('thresholds')
  for (const k of ['anonymousCosine', 'anonymousMargin', 'identityCosine', 'identityMargin', 'minimumPurity'] as const)
    if (!Number.isFinite(c[k]) || c[k] < 0 || c[k] > 1) fail('thresholds')
  if (c.identityCosine < .88 || c.identityMargin <= 0 || c.anonymousMargin <= 0) fail('identity_floor_or_margin')
  return c
}
/** Scale before norm to avoid overflow/underflow; no unnormalized dot products. */
export function normalizedSpeakerEmbedding(values: readonly number[], dimensions: number): number[] | null {
  if (!Array.isArray(values) || values.length !== dimensions || Object.keys(values).length !== values.length || values.some(v => !Number.isFinite(v))) return null
  const scale = Math.max(...values.map(Math.abs))
  if (!(scale > 0)) return null
  const scaled = values.map(v => v / scale)
  const norm = Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0))
  return scaled.map(v => v / norm)
}
export function normalizedSpeakerCosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 1) return null
  const x = normalizedSpeakerEmbedding(a, a.length), y = normalizedSpeakerEmbedding(b, b.length)
  return x && y ? Math.max(-1, Math.min(1, x.reduce((sum, v, i) => sum + v * y[i], 0))) : null
}
function validOriginal(o: MacSpeakerOriginal): boolean {
  return !!o && uint(o.chunkIndex) && SHA.test(o.audioSHA256) && SHA.test(o.pcmSHA256)
    && uint(o.startSample) && uint(o.sampleCount) && o.sampleCount > 0 && o.sampleCount <= 480_000
    && Number.isSafeInteger(o.startSample + o.sampleCount)
}
function anchorHash(s: Pick<MacSpeakerMemory, 'captureId' | 'modelSHA256'>, a: Omit<MacSpeakerAnchor, 'observationSHA256'>): string {
  return digest({ captureId: s.captureId, modelSHA256: s.modelSHA256, ...a })
}
function independent(originals: readonly MacSpeakerOriginal[], o: MacSpeakerOriginal): MacSpeakerReason | null {
  for (const previous of originals) {
    if (previous.chunkIndex === o.chunkIndex) return digest(previous) === digest(o) ? 'duplicate_source' : 'source_conflict'
    if (previous.audioSHA256 === o.audioSHA256 || previous.pcmSHA256 === o.pcmSHA256) return 'duplicate_source'
    if (Math.max(previous.startSample, o.startSample) < Math.min(previous.startSample + previous.sampleCount, o.startSample + o.sampleCount)) return 'crossed_originals'
  }
  return null
}
export function createMacSpeakerMemory(captureId: string, modelSHA256: string, overrides: Partial<MacSpeakerThresholds> = {}): MacSpeakerMemory {
  if (!captureId || captureId.length > 200 || !SHA.test(modelSHA256)) fail('binding')
  return { version: MAC_SPEAKER_RECONCILE_VERSION, captureId, modelSHA256, thresholds: config(overrides), voiceHighWater: 0, identities: [], originals: [] }
}
/** Restored state never resets numbers or accepts modified observation receipts.
 * Integrity is structural; the caller must authenticate persisted bytes and verify
 * extractor/audio hashes. A receipt is not proof of acoustic speaker purity. */
export function validateMacSpeakerMemory(s: MacSpeakerMemory): void {
  if (!s || s.version !== MAC_SPEAKER_RECONCILE_VERSION || !s.captureId || s.captureId.length > 200 || !SHA.test(s.modelSHA256)) fail('state_binding')
  const c = config(s.thresholds)
  if (!uint(s.voiceHighWater) || s.voiceHighWater > 99 || !Array.isArray(s.identities) || s.identities.length > c.maxIdentities
    || !Array.isArray(s.originals) || s.originals.length > c.maxOriginals) fail('state_bound')
  const chunkKeys = new Set<number>(), audioKeys = new Set<string>(), pcmKeys = new Set<string>()
  for (const o of s.originals) {
    if (!validOriginal(o) || chunkKeys.has(o.chunkIndex) || audioKeys.has(o.audioSHA256) || pcmKeys.has(o.pcmSHA256)) fail('state_lineage')
    chunkKeys.add(o.chunkIndex); audioKeys.add(o.audioSHA256); pcmKeys.add(o.pcmSHA256)
  }
  const ordered = [...s.originals].sort((a, b) => a.startSample - b.startSample)
  if (ordered.some((o, i) => i > 0 && ordered[i - 1].startSample + ordered[i - 1].sampleCount > o.startSample)) fail('state_lineage')
  const originalBindings = new Map(s.originals.map(o => [o.chunkIndex, digest(o)]))
  const voices = new Set<number>()
  const used = new Set<string>()
  for (let i = 0; i < s.identities.length; i++) {
    const t = s.identities[i]
    if (!t || t.id !== i + 1 || !Array.isArray(t.anchors) || !t.anchors.length || t.anchors.length > c.maxAnchorsPerIdentity
      || (t.voice !== null && (!uint(t.voice) || t.voice < 1 || t.voice > s.voiceHighWater || voices.has(t.voice)))
      || (t.voice === null ? t.anchors.length >= c.minimumIndependentMatches : t.anchors.length < c.minimumIndependentMatches)) fail('state_identity')
    if (t.voice !== null) voices.add(t.voice)
    for (const a of t.anchors) {
      const { observationSHA256, ...body } = a
      const embedding = normalizedSpeakerEmbedding(a.embedding, c.dimensions)
      if (!embedding || !validOriginal(a.original) || originalBindings.get(a.original.chunkIndex) !== digest(a.original) || used.has(a.original.pcmSHA256)
        || !uint(a.startSample) || !uint(a.endSample) || a.startSample < a.original.startSample || a.endSample > a.original.startSample + a.original.sampleCount
        || a.endSample - a.startSample < c.minimumSamples || !uint(a.exclusiveSamples) || a.exclusiveSamples < c.minimumSamples || a.exclusiveSamples > a.endSample - a.startSample
        || !Number.isFinite(a.purity) || a.purity < c.minimumPurity || a.purity > 1
        || Math.abs(a.embedding.reduce((sum, v) => sum + v * v, 0) - 1) > 1e-8 || anchorHash(s, body) !== observationSHA256) fail('state_anchor')
      used.add(a.original.pcmSHA256)
      if (t.anchors.some(b => normalizedSpeakerCosine(a.embedding, b.embedding)! < c.anonymousCosine)) fail('state_incoherent')
    }
  }
  if (voices.size !== s.voiceHighWater) fail('state_high_water')
}
function decision(s: MacSpeakerMemory, reason: MacSpeakerReason, extras: Partial<MacSpeakerDecision> = {}): MacSpeakerDecision {
  return { reason, label: null, confidence: 'withheld', evidence: [], scores: [],
    provenance: { algorithm: MAC_SPEAKER_RECONCILE_VERSION, captureId: s.captureId, modelSHA256: s.modelSHA256, thresholds: { ...s.thresholds } }, ...extras }
}
function observationProblem(s: MacSpeakerMemory, o: MacSpeakerObservation): MacSpeakerReason | null {
  if (!o || o.captureId !== s.captureId || o.modelSHA256 !== s.modelSHA256 || !validOriginal(o.original)
    || !uint(o.startSample) || !uint(o.endSample) || o.startSample < o.original.startSample || o.endSample > o.original.startSample + o.original.sampleCount
    || o.endSample <= o.startSample || !uint(o.exclusiveSamples) || o.exclusiveSamples > o.endSample - o.startSample
    || !Number.isFinite(o.purity) || o.purity < 0 || o.purity > 1 || !uint(o.overlapSamples) || typeof o.mixedSpeakers !== 'boolean'
    || !normalizedSpeakerEmbedding(o.embedding, s.thresholds.dimensions)) return 'invalid_observation'
  if (o.mixedSpeakers || o.overlapSamples > 0) return 'mixed_or_overlap'
  if (o.exclusiveSamples < s.thresholds.minimumSamples || o.purity < s.thresholds.minimumPurity) return 'insufficient_clean_audio'
  return null
}
/** Immutable value transition: caller persists the returned state before publishing
 * a decision. No elapsed-time eviction, silent merge, number reuse or enrollment.
 * Memory budgets describe resources, never the number of people in a recording. */
export function reconcileMacSpeakerObservation(input: MacSpeakerMemory, o: MacSpeakerObservation): { state: MacSpeakerMemory; decision: MacSpeakerDecision } {
  validateMacSpeakerMemory(input)
  const state = structuredClone(input)
  const result = (reason: MacSpeakerReason, extras: Partial<MacSpeakerDecision> = {}) => ({ state, decision: decision(state, reason, extras) })
  if (o?.protectedLabel && typeof o.protectedLabel.label === 'string' && o.protectedLabel.label.length > 0 && o.protectedLabel.label.length <= 200
    && ['named', 'manual'].includes(o.protectedLabel.origin)) return result('protected_label', { label: o.protectedLabel.label, confidence: 'protected' })
  if (o?.protectedLabel) return result('invalid_observation')
  const problem = observationProblem(state, o)
  if (problem) return result(problem)
  const repeated = independent(state.originals, o.original)
  if (repeated) return result(repeated)
  if (state.originals.length >= state.thresholds.maxOriginals) return result('budget_exhausted')
  const embedding = normalizedSpeakerEmbedding(o.embedding, state.thresholds.dimensions)!
  const scores = state.identities.map(t => {
    const cosines = t.anchors.map(a => normalizedSpeakerCosine(a.embedding, embedding)!)
    return { candidate: String(t.id), minimumCosine: Math.min(...cosines), maximumCosine: Math.max(...cosines) }
  }).sort((a, b) => b.minimumCosine - a.minimumCosine || Number(a.candidate) - Number(b.candidate))
  const best = scores[0]
  let target: MacAcousticIdentity | undefined
  if (best && best.minimumCosine >= state.thresholds.anonymousCosine) {
    const competitor = Math.max(-1, ...scores.slice(1).map(s => s.maximumCosine))
    if (best.minimumCosine - competitor < state.thresholds.anonymousMargin) return result('ambiguous', { scores })
    target = state.identities[Number(best.candidate) - 1]
  } else if (scores.some(s => s.maximumCosine >= state.thresholds.anonymousCosine)) return result('inconsistent_anchors', { scores })
  if (!target) {
    if (state.identities.length >= state.thresholds.maxIdentities) return result('budget_exhausted', { scores })
    target = { id: state.identities.length + 1, voice: null, anchors: [] }
    state.identities.push(target)
  }
  if (target.voice === null && target.anchors.length + 1 >= state.thresholds.minimumIndependentMatches && state.voiceHighWater >= 99) return result('budget_exhausted', { scores })
  const body = { original: structuredClone(o.original), startSample: o.startSample, endSample: o.endSample, exclusiveSamples: o.exclusiveSamples, purity: o.purity, embedding }
  const anchor = { ...body, observationSHA256: anchorHash(state, body) }
  state.originals.push(structuredClone(o.original))
  const wasSettled = target.voice !== null
  target.anchors.push(anchor)
  // Keep initial independent witnesses forever; only replace later reference
  // observations. This prevents a chain of moving centroids drifting identities.
  if (target.anchors.length > state.thresholds.maxAnchorsPerIdentity) target.anchors.splice(state.thresholds.minimumIndependentMatches, 1)
  if (target.voice === null && target.anchors.length >= state.thresholds.minimumIndependentMatches) {
    if (state.voiceHighWater >= Number.MAX_SAFE_INTEGER) fail('number_exhausted')
    target.voice = ++state.voiceHighWater
  }
  const evidence = [...new Set([...target.anchors.map(a => a.observationSHA256), anchor.observationSHA256])]
  validateMacSpeakerMemory(state)
  return result(target.voice === null ? 'provisional' : wasSettled ? 'recurring_anonymous' : 'confirmed_anonymous', {
    confidence: target.voice === null ? 'provisional' : 'acoustic', label: target.voice === null ? null : `Voice ${target.voice}`, identityId: target.id, evidence, scores,
  })
}

export interface MacSpeakerProfile {
  name: string
  /** Freeze/hash the source profile file separately; these are its raw rows. */
  embeddings: readonly (readonly number[])[]
  profileSHA256: string
}
/** Deliberately preserves production raw-average then normalize centroid math.
 * Diagnostics based on best-row scores must never replace this recognition rule. */
function profileCentroid(rows: readonly (readonly number[])[], dimensions: number): number[] | null {
  if (!Array.isArray(rows) || !rows.length || rows.length > 8192 || Object.keys(rows).length !== rows.length || rows.some(r => !normalizedSpeakerEmbedding(r, dimensions))) return null
  let scale = 0
  for (const row of rows) for (const value of row) scale = Math.max(scale, Math.abs(value))
  const mean = Array.from({ length: dimensions }, (_, i) => rows.reduce((sum, r) => sum + r[i] / scale / rows.length, 0))
  return normalizedSpeakerEmbedding(mean, dimensions)
}
/** Separate, read-only real-name proposal. All independent query witnesses must
 * agree on the same profile, individually clear .88 and the top-two margin.
 * Does not mutate acoustic memory or enroll any evidence. */
export function matchMacSpeakerProfile(memory: MacSpeakerMemory, observations: readonly MacSpeakerObservation[], profiles: readonly MacSpeakerProfile[]): MacSpeakerDecision {
  validateMacSpeakerMemory(memory)
  const result = (reason: MacSpeakerReason, extras: Partial<MacSpeakerDecision> = {}) => decision(memory, reason, extras)
  if (!Array.isArray(observations) || observations.length > memory.thresholds.maxOriginals || !Array.isArray(profiles) || profiles.length > 1024) return result('invalid_observation')
  if (Object.keys(profiles).length !== profiles.length || profiles.some(p => !p || typeof p.name !== 'string')) return result('invalid_observation')
  const candidates = profiles.map(p => ({ ...p, centroid: profileCentroid(p.embeddings, memory.thresholds.dimensions) }))
  if (candidates.some(p => !checkSpeakerName(p.name).ok || /^(?:Voice\s+\d+|Ext|Speaker\s+\d+)$/i.test(p.name) || !SHA.test(p.profileSHA256) || !p.centroid)
    || new Set(candidates.map(p => p.name.toLowerCase())).size !== candidates.length) return result('invalid_observation')
  const originals: MacSpeakerOriginal[] = []
  const anchors: MacSpeakerAnchor[] = []
  for (const o of observations) {
    if (o?.protectedLabel) {
      if (typeof o.protectedLabel.label !== 'string' || !o.protectedLabel.label.length || o.protectedLabel.label.length > 200 || !['named', 'manual'].includes(o.protectedLabel.origin)) return result('invalid_observation')
      return result('protected_label', { label: o.protectedLabel.label, confidence: 'protected' })
    }
    const problem = observationProblem(memory, o)
    if (problem) return result(problem)
    const repeated = independent(originals, o.original)
    if (repeated) return result(repeated)
    originals.push(o.original)
    const body = { original: structuredClone(o.original), startSample: o.startSample, endSample: o.endSample, exclusiveSamples: o.exclusiveSamples, purity: o.purity, embedding: normalizedSpeakerEmbedding(o.embedding, memory.thresholds.dimensions)! }
    anchors.push({ ...body, observationSHA256: anchorHash(memory, body) })
  }
  if (anchors.length < memory.thresholds.minimumIndependentMatches) return result('insufficient_independent_matches')
  if (anchors.some(a => anchors.some(b => normalizedSpeakerCosine(a.embedding, b.embedding)! < memory.thresholds.anonymousCosine))) return result('inconsistent_anchors')
  let winner: typeof candidates[number] | undefined
  const scores: MacSpeakerDecision['scores'] = candidates.map(p => {
    const cosines = anchors.map(a => normalizedSpeakerCosine(a.embedding, p.centroid!)!)
    return { candidate: p.name, minimumCosine: Math.min(...cosines), maximumCosine: Math.max(...cosines) }
  }).sort((a, b) => b.minimumCosine - a.minimumCosine || a.candidate.localeCompare(b.candidate))
  for (const a of anchors) {
    const ranking = candidates.map(p => ({ profile: p, score: normalizedSpeakerCosine(a.embedding, p.centroid!)! })).sort((a, b) => b.score - a.score)
    if (!ranking.length || ranking[0].score < memory.thresholds.identityCosine) return result('profile_below_floor', { scores })
    if (ranking[0].score - (ranking[1]?.score ?? -1) < memory.thresholds.identityMargin) return result('profile_ambiguity', { scores })
    if (winner && winner.name !== ranking[0].profile.name) return result('profile_disagreement', { scores })
    winner = ranking[0].profile
  }
  return result('matched_profile', { label: winner!.name, confidence: 'profile', scores, evidence: anchors.map(a => a.observationSHA256), provenance: {
    algorithm: MAC_SPEAKER_RECONCILE_VERSION, captureId: memory.captureId, modelSHA256: memory.modelSHA256, thresholds: { ...memory.thresholds }, profileSHA256: winner!.profileSHA256,
  } })
}
