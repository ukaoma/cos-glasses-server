// Anonymous, derived projection only; no identity/profile/training or recording imports.
import { createHash } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAC = /^mac_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const MAX_CHUNKS = 4096
const MAX_WORDS = 8192
const MAX_GENERATIONS = 100
const MAX_TOTAL_SEGMENTS = 8192
const MAX_STATE_BYTES = 4 * 1024 * 1024
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const fail = (reason: string): never => { throw new Error(`mac_projection_${reason}`) }
const keys = (value: object, names: string[]): boolean => Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k))
export interface ConfirmationProof {
  originalChunkIndex: number; audioSHA256: string; pcmSHA256: string
  chunkStartSample: number; chunkSampleCount: number
  startSample: number; endSample: number; exclusiveSamples: number; purity: number
}
interface Slot { slot: number; proofs: ConfirmationProof[]; label?: string }
export interface SpeakerSegment {
  wordStart: number; wordEnd: number; startSample: number; endSample: number
  speaker: string; similarity: 0
}
export interface ChunkProjection {
  chunkIndex: number; generation: string; audioSHA256: string; canonicalBinding: string
  wordCount: number; startSample: number; endSample: number; coveredThroughSample: number
  changedAtRevision: number; segments: SpeakerSegment[]
}
export interface ProjectionState {
  version: 1; captureId: string; generation: string | null; generations: string[]
  speakerRevision: number; labelHighWater: number; slots: Slot[]; chunks: ChunkProjection[]
}
export interface ProjectionRead {
  version: 1; captureId: string; generation: string | null; speakerRevision: number
  reset: boolean; chunks: ChunkProjection[]
}
export function canonicalTextBinding(text: string, words: readonly { text: string; startSample: number; endSample: number }[]): string {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 128_000 || !Array.isArray(words) || words.length > MAX_WORDS) fail('canonical')
  let wordBytes = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!Object.hasOwn(words, i) || !w || typeof w.text !== 'string' || !uint(w.startSample) || !uint(w.endSample) || w.endSample < w.startSample) fail('canonical_word')
    wordBytes += Buffer.byteLength(w.text)
    if (wordBytes > 128_000) fail('canonical_word_bound')
  }
  return createHash('sha256').update(JSON.stringify({ text, words })).digest('hex')
}
export function newProjectionState(captureId: string): ProjectionState {
  if (!matches(captureId, MAC)) fail('capture')
  return { version: 1, captureId, generation: null, generations: [], speakerRevision: 0, labelHighWater: 0, slots: [], chunks: [] }
}
function dense<T>(value: T[], max: number): boolean {
  if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) return false
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false
  return true
}
function proofValid(p: ConfirmationProof): boolean {
  return !!p && keys(p, ['originalChunkIndex', 'audioSHA256', 'pcmSHA256', 'chunkStartSample', 'chunkSampleCount', 'startSample', 'endSample', 'exclusiveSamples', 'purity']) && uint(p.originalChunkIndex) && matches(p.audioSHA256, SHA) && matches(p.pcmSHA256, SHA)
    && uint(p.chunkStartSample) && uint(p.chunkSampleCount) && p.chunkSampleCount > 0 && p.chunkSampleCount <= 480_000
    && uint(p.startSample) && uint(p.endSample) && p.startSample >= p.chunkStartSample
    && p.endSample > p.startSample && p.endSample <= p.chunkStartSample + p.chunkSampleCount
    && uint(p.exclusiveSamples) && p.exclusiveSamples >= 32_000 && p.exclusiveSamples <= p.endSample - p.startSample
    && Number.isFinite(p.purity) && p.purity >= 0.9 && p.purity <= 1
}
function chunkValid(c: ChunkProjection, state: ProjectionState): boolean {
  if (!c || !keys(c, ['chunkIndex', 'generation', 'audioSHA256', 'canonicalBinding', 'wordCount', 'startSample', 'endSample', 'coveredThroughSample', 'changedAtRevision', 'segments']) || !uint(c.chunkIndex) || !state.generations.includes(c.generation) || !matches(c.audioSHA256, SHA) || !matches(c.canonicalBinding, SHA)
    || !uint(c.wordCount) || c.wordCount > MAX_WORDS || !uint(c.startSample) || !uint(c.endSample) || c.endSample < c.startSample
    || !uint(c.coveredThroughSample) || c.coveredThroughSample < c.startSample || c.coveredThroughSample > c.endSample
    || !uint(c.changedAtRevision) || c.changedAtRevision < 1 || c.changedAtRevision > state.speakerRevision || !dense(c.segments, MAX_WORDS)) return false
  let word = 0; let sample = c.startSample
  for (const segment of c.segments) {
    if (!segment || !keys(segment, ['wordStart', 'wordEnd', 'startSample', 'endSample', 'speaker', 'similarity']) || segment.wordStart !== word || !uint(segment.wordEnd) || segment.wordEnd <= word || segment.wordEnd > c.wordCount
      || !uint(segment.startSample) || !uint(segment.endSample) || segment.startSample < sample || segment.endSample < segment.startSample
      || segment.endSample > c.endSample || (segment.speaker !== 'Ext' && segment.endSample > c.coveredThroughSample) || segment.similarity !== 0
      || (segment.speaker !== 'Ext' && !matches(segment.speaker, /^Voice [1-9]\d?$/))
      || (segment.speaker !== 'Ext' && Number(segment.speaker.slice(6)) > state.labelHighWater)) return false
    word = segment.wordEnd; sample = segment.endSample
  }
  // Empty segments is an explicit clear: clients fall back to immutable canonical labels.
  return c.segments.length === 0 || word === c.wordCount
}
/** Strict restore: missing/corrupt high-water or partial arrays never reset numbering. */
export function validateProjectionState(state: ProjectionState): void {
  if (!state || !keys(state, ['version', 'captureId', 'generation', 'generations', 'speakerRevision', 'labelHighWater', 'slots', 'chunks']) || state.version !== 1 || !matches(state.captureId, MAC) || !uint(state.speakerRevision) || !uint(state.labelHighWater) || state.labelHighWater > 99
    || !dense(state.generations, MAX_GENERATIONS) || new Set(state.generations).size !== state.generations.length
    || state.generations.some(g => typeof g !== 'string' || !matches(g, TOKEN))
    || (state.generation !== null && !state.generations.includes(state.generation)) || !dense(state.slots, 8) || !dense(state.chunks, MAX_CHUNKS)
    || new Set(state.slots.map(s => s?.slot)).size !== state.slots.length || new Set(state.chunks.map(c => c?.chunkIndex)).size !== state.chunks.length) fail('corrupt_state')
  const labels = new Set<string>()
  for (const slot of state.slots) {
    if (!slot || !keys(slot, slot.label === undefined ? ['slot', 'proofs'] : ['slot', 'proofs', 'label']) || !uint(slot.slot) || slot.slot > 7 || !dense(slot.proofs, 3) || slot.proofs.some(p => !proofValid(p))
      || new Set(slot.proofs.map(p => p.originalChunkIndex)).size !== slot.proofs.length
      || new Set(slot.proofs.map(p => p.pcmSHA256)).size !== slot.proofs.length
      || (slot.label !== undefined && (slot.proofs.length !== 3 || !matches(slot.label, /^Voice [1-9]\d?$/)
        || Number(slot.label.slice(6)) > state.labelHighWater || labels.has(slot.label)))) fail('corrupt_slot')
    if (slot.label) labels.add(slot.label)
  }
  const proofs = state.slots.flatMap(slot => slot.proofs)
  for (let i = 0; i < proofs.length; i++) for (let j = i + 1; j < proofs.length; j++) {
    const a = proofs[i], b = proofs[j]
    if (a.originalChunkIndex === b.originalChunkIndex && (a.audioSHA256 !== b.audioSHA256 || a.pcmSHA256 !== b.pcmSHA256
      || a.chunkStartSample !== b.chunkStartSample || a.chunkSampleCount !== b.chunkSampleCount)) fail('corrupt_provenance')
    if (a.originalChunkIndex !== b.originalChunkIndex && Math.max(a.chunkStartSample, b.chunkStartSample)
      < Math.min(a.chunkStartSample + a.chunkSampleCount, b.chunkStartSample + b.chunkSampleCount)) fail('corrupt_overlap')
    const samePCM = a.pcmSHA256 === b.pcmSHA256
    const startA = samePCM ? a.startSample - a.chunkStartSample : a.startSample
    const startB = samePCM ? b.startSample - b.chunkStartSample : b.startSample
    if ((samePCM || a.originalChunkIndex === b.originalChunkIndex) && Math.max(startA, startB)
      < Math.min(startA + a.endSample - a.startSample, startB + b.endSample - b.startSample)) fail('corrupt_repeated_support')
  }
  let totalSegments = 0
  for (const c of state.chunks) {
    if (!c || !Array.isArray(c.segments)) fail('corrupt_chunk')
    totalSegments += c.segments.length
    if (totalSegments > MAX_TOTAL_SEGMENTS || !chunkValid(c, state)) fail('corrupt_chunk_or_bound')
    if (c.generation !== state.generation && c.segments.some(segment => labels.has(segment.speaker))) fail('corrupt_reused_label')
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) fail('state_bound')
}
/** All mutation is staged and synchronously atomically persisted before publication. */
export class MacSpeakerProjection {
  private state: ProjectionState
  private admittedGeneration: string | null = null
  private pending?: ProjectionState
  private committing = false
  constructor(state: ProjectionState, private readonly persist: (state: Readonly<ProjectionState>) => void) {
    validateProjectionState(state); this.state = structuredClone(state)
  }
  snapshot(): ProjectionState { return structuredClone(this.state) }
  private commit(edit: (state: ProjectionState) => void): void {
    if (this.committing) fail('reentrant_persist')
    const next = structuredClone(this.state); edit(next)
    if (next.speakerRevision >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted')
    next.speakerRevision++
    validateProjectionState(next)
    if (this.pending && JSON.stringify(this.pending) !== JSON.stringify(next)) fail('uncommitted')
    this.pending = next
    this.committing = true
    try {
      const accepted: unknown = this.persist(Object.freeze(structuredClone(next)))
      if (accepted && typeof (accepted as { then?: unknown }).then === 'function') fail('async_persist')
      this.state = next
      this.pending = undefined
    } finally { this.committing = false }
  }
  beginGeneration(generation: string): void {
    if (!matches(generation, TOKEN) || this.state.generations.includes(generation) || this.state.generations.length >= MAX_GENERATIONS) fail('generation')
    this.commit(s => { s.generation = generation; s.generations.push(generation); s.slots = [] })
    this.admittedGeneration = generation
  }
  endGeneration(generation: string): void {
    this.assertGeneration(generation)
    this.commit(s => { s.generation = null; s.slots = [] })
    this.admittedGeneration = null
  }
  private assertGeneration(generation: string): void { if (this.state.generation !== generation || this.admittedGeneration !== generation) fail('stale_generation') }
  observe(generation: string, slotIndex: number, proof: ConfirmationProof): string | null {
    this.assertGeneration(generation)
    if (!uint(slotIndex) || slotIndex > 7 || !proofValid(proof)) fail('proof')
    for (const slot of this.state.slots) for (const p of slot.proofs) {
      if (p.originalChunkIndex === proof.originalChunkIndex && (p.audioSHA256 !== proof.audioSHA256 || p.pcmSHA256 !== proof.pcmSHA256
        || p.chunkStartSample !== proof.chunkStartSample || p.chunkSampleCount !== proof.chunkSampleCount)) fail('proof_conflict')
      if (p.originalChunkIndex !== proof.originalChunkIndex && Math.max(p.chunkStartSample, proof.chunkStartSample)
        < Math.min(p.chunkStartSample + p.chunkSampleCount, proof.chunkStartSample + proof.chunkSampleCount)) fail('overlapping_originals')
    }
    const existing = this.state.slots.find(s => s.slot === slotIndex)
    if (existing?.proofs.some(p => p.originalChunkIndex === proof.originalChunkIndex || p.pcmSHA256 === proof.pcmSHA256)) return existing.label ?? null
    // Repeated canonical PCM/overlapping support cannot confirm another slot either.
    for (const slot of this.state.slots) for (const p of slot.proofs) {
      const samePCM = p.pcmSHA256 === proof.pcmSHA256
      const a = samePCM ? p.startSample - p.chunkStartSample : p.startSample
      const b = samePCM ? proof.startSample - proof.chunkStartSample : proof.startSample
      if ((samePCM || p.originalChunkIndex === proof.originalChunkIndex) && Math.max(a, b) < Math.min(a + p.endSample - p.startSample, b + proof.endSample - proof.startSample)) return existing?.label ?? null
    }
    if (existing?.proofs.length === 3) return existing.label ?? null
    this.commit(s => {
      let slot = s.slots.find(item => item.slot === slotIndex)
      if (!slot) { slot = { slot: slotIndex, proofs: [] }; s.slots.push(slot) }
      slot.proofs.push(structuredClone(proof))
      if (slot.proofs.length === 3 && s.labelHighWater < 99) slot.label = `Voice ${++s.labelHighWater}`
    })
    return this.state.slots.find(s => s.slot === slotIndex)?.label ?? null
  }
  /** Whole-chunk replacement; [] explicitly clears prior segments. Text/word anchors never change. */
  replaceChunk(generation: string, chunk: Omit<ChunkProjection, 'generation' | 'changedAtRevision'>): void {
    this.assertGeneration(generation)
    const old = this.state.chunks.find(c => c.chunkIndex === chunk.chunkIndex)
    if (old && chunk.coveredThroughSample < old.coveredThroughSample) fail('coverage_regression')
    if (old && (old.generation !== generation || old.audioSHA256 !== chunk.audioSHA256 || old.canonicalBinding !== chunk.canonicalBinding
      || old.wordCount !== chunk.wordCount || old.startSample !== chunk.startSample || old.endSample !== chunk.endSample)) fail('immutable_binding')
    if (old) {
      const { generation: _generation, changedAtRevision: _revision, ...previous } = old
      if (Object.keys(previous).every(k => JSON.stringify(previous[k as keyof typeof previous]) === JSON.stringify(chunk[k as keyof typeof chunk]))) return
    }
    if (!old && this.state.chunks.length >= MAX_CHUNKS) fail('chunk_bound')
    const validLabels = new Set(this.state.slots.map(s => s.label).filter(Boolean))
    if (!dense(chunk.segments, MAX_WORDS) || chunk.segments.some(s => s.speaker !== 'Ext' && !validLabels.has(s.speaker))) fail('unconfirmed_label')
    this.commit(s => {
      const replacement: ChunkProjection = { ...structuredClone(chunk), generation, changedAtRevision: s.speakerRevision + 1 }
      const i = s.chunks.findIndex(c => c.chunkIndex === chunk.chunkIndex)
      if (i < 0) s.chunks.push(replacement); else s.chunks[i] = replacement
    })
  }
  read(cursor?: { generation: string | null; speakerRevision: number }): ProjectionRead {
    const reset = !cursor || cursor.generation !== this.state.generation || !uint(cursor.speakerRevision) || cursor.speakerRevision > this.state.speakerRevision
    return { version: 1, captureId: this.state.captureId, generation: this.state.generation, speakerRevision: this.state.speakerRevision,
      reset, chunks: structuredClone(this.state.chunks.filter(c => reset || c.changedAtRevision > cursor!.speakerRevision)) }
  }
}
