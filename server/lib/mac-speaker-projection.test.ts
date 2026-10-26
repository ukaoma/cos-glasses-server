import { describe, expect, it, vi } from 'vitest'
import { canonicalTextBinding, MacSpeakerProjection, newProjectionState, validateProjectionState,
  type ConfirmationProof, type ChunkProjection } from './mac-speaker-projection.js'

const capture = 'mac_00000000-0000-4000-8000-000000000001'
const hash = (n: number) => n.toString(16).padStart(64, '0')
const proof = (i: number): ConfirmationProof => ({ originalChunkIndex: i, audioSHA256: hash(i + 10), pcmSHA256: hash(i + 100),
  chunkStartSample: i * 96_000, chunkSampleCount: 96_000, startSample: i * 96_000, endSample: i * 96_000 + 64_000,
  exclusiveSamples: 64_000, purity: 0.99 })
function fixture() {
  const persist = vi.fn(); const projection = new MacSpeakerProjection(newProjectionState(capture), persist)
  projection.beginGeneration('00000000-0000-4000-8000-000000000011'); return { projection, persist }
}
function confirm(p: MacSpeakerProjection, slot = 0, start = 0): string | null {
  let label: string | null = null
  for (let i = start; i < start + 3; i++) label = p.observe('00000000-0000-4000-8000-000000000011', slot, proof(i))
  return label
}
function chunk(speaker = 'Voice 1'): Omit<ChunkProjection, 'generation' | 'changedAtRevision'> {
  return { chunkIndex: 0, audioSHA256: hash(10), canonicalBinding: canonicalTextBinding('Hello there', [
    { text: 'Hello', startSample: 0, endSample: 1000 }, { text: 'there', startSample: 1000, endSample: 2000 }]),
  wordCount: 2, startSample: 0, endSample: 96_000, coveredThroughSample: 96_000,
  segments: [{ wordStart: 0, wordEnd: 2, startSample: 0, endSample: 2000, speaker, similarity: 0 }] }
}

describe('capture-scoped anonymous speaker projection', () => {
  it('requires three distinct original observations and never claims named identity', () => {
    const { projection: p } = fixture()
    expect(p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))).toBeNull()
    expect(p.observe('00000000-0000-4000-8000-000000000011', 0, proof(1))).toBeNull()
    expect(p.observe('00000000-0000-4000-8000-000000000011', 0, proof(2))).toBe('Voice 1')
    p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk()); expect(p.read().chunks[0].segments[0]).toMatchObject({ speaker: 'Voice 1', similarity: 0 })
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk('Dana Reyes'))).toThrow('unconfirmed_label')
  })
  it('exact retry, other snippets of one chunk and changed WAV header do not add support', () => {
    const { projection: p } = fixture(); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))
    p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))
    p.observe('00000000-0000-4000-8000-000000000011', 0, { ...proof(0), startSample: 1000, endSample: 65_000 })
    p.observe('00000000-0000-4000-8000-000000000011', 0, { ...proof(1), pcmSHA256: proof(0).pcmSHA256 })
    expect(p.snapshot().slots[0].proofs).toHaveLength(1); expect(p.snapshot().labelHighWater).toBe(0)
  })
  it('rejects a changed raw identity for an already observed original index', () => {
    const { projection: p } = fixture(); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 1, { ...proof(0), audioSHA256: hash(99) })).toThrow('proof_conflict')
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, { ...proof(0), pcmSHA256: hash(99) })).toThrow('proof_conflict')
  })
  it('rejects overlapping raw original spans even under different indexes/hashes', () => {
    const { projection: p } = fixture(); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, { ...proof(1), chunkStartSample: 0, startSample: 0, endSample: 64_000 })).toThrow('overlapping_originals')
  })
  it('one mixed original can support two slots only on disjoint clean exclusive spans', () => {
    const { projection: p } = fixture(); const a = { ...proof(0), endSample: 32_000, exclusiveSamples: 32_000 }
    p.observe('00000000-0000-4000-8000-000000000011', 0, a)
    p.observe('00000000-0000-4000-8000-000000000011', 1, { ...a, startSample: 16_000, endSample: 48_000 })
    expect(p.snapshot().slots).toHaveLength(1)
    p.observe('00000000-0000-4000-8000-000000000011', 1, { ...a, startSample: 48_000, endSample: 80_000 })
    expect(p.snapshot().slots).toHaveLength(2)
  })
  it.each([
    ['short', { exclusiveSamples: 31_999 }], ['impure', { purity: 0.899 }], ['nonfinite', { purity: NaN }],
    ['outside original', { endSample: 100_000 }], ['negative', { startSample: -1 }], ['missing hash', { pcmSHA256: '' }],
  ])('withholds invalid %s evidence', (_, change) => {
    const { projection: p } = fixture(); expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, { ...proof(0), ...change })).toThrow('proof')
    expect(p.snapshot().slots).toEqual([])
  })
  it('keeps only three confirmation proofs per slot after arbitrarily many observations', () => {
    const { projection: p } = fixture(); confirm(p)
    for (let i = 3; i < 100; i++) expect(p.observe('00000000-0000-4000-8000-000000000011', 0, proof(i))).toBe('Voice 1')
    expect(p.snapshot().slots[0].proofs).toHaveLength(3)
  })
  it('publishes nothing on persistence failure and reuses no reserved number', () => {
    const { projection: p, persist } = fixture(); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0)); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(1))
    const previous = p.snapshot(); persist.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, proof(2))).toThrow('disk full'); expect(p.snapshot()).toEqual(previous)
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, proof(3))).toThrow('uncommitted')
    expect(() => p.beginGeneration('00000000-0000-4000-8000-000000000012')).toThrow('uncommitted')
    expect(p.observe('00000000-0000-4000-8000-000000000011', 0, proof(2))).toBe('Voice 1')
    expect(persist.mock.calls.at(-1)![0].labelHighWater).toBe(1)
  })
  it('restores high-water while refusing old generation support after restart', () => {
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const restored = new MacSpeakerProjection(p.snapshot(), () => {})
    expect(() => restored.observe('00000000-0000-4000-8000-000000000011', 0, proof(3))).toThrow('stale_generation')
    restored.beginGeneration('00000000-0000-4000-8000-000000000012')
    expect(() => restored.observe('00000000-0000-4000-8000-000000000011', 0, proof(3))).toThrow('stale_generation')
    for (let i = 3; i < 6; i++) restored.observe('00000000-0000-4000-8000-000000000012', 0, proof(i))
    expect(restored.snapshot().slots[0].label).toBe('Voice 2')
    expect(restored.snapshot().chunks[0].generation).toBe('00000000-0000-4000-8000-000000000011')
    const reset = restored.read({ generation: '00000000-0000-4000-8000-000000000011', speakerRevision: 999 })
    expect(reset.reset).toBe(true); expect(reset.chunks[0].segments[0].speaker).toBe('Voice 1')
  })
  it('never accepts another capture or silently repairs missing/corrupt high-water', () => {
    expect(() => newProjectionState('meeting_x')).toThrow('capture')
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const missing = p.snapshot(); delete (missing as Partial<typeof missing>).labelHighWater
    expect(() => new MacSpeakerProjection(missing, () => {})).toThrow('corrupt_state')
    const lowered = p.snapshot(); lowered.labelHighWater = 0
    expect(() => validateProjectionState(lowered)).toThrow()
  })
  it('ending generation fences late observations/revisions but retains accepted old projections', () => {
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk()); p.endGeneration('00000000-0000-4000-8000-000000000011')
    expect(() => p.observe('00000000-0000-4000-8000-000000000011', 0, proof(3))).toThrow('stale_generation')
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', { ...chunk(), segments: [] })).toThrow('stale_generation')
    expect(p.read().chunks[0].segments[0].speaker).toBe('Voice 1')
    expect(() => p.beginGeneration('00000000-0000-4000-8000-000000000011')).toThrow('generation')
  })
  it('sends late settled-index replacements independently of the ASR text cursor', () => {
    const { projection: p } = fixture(); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk('Ext'))
    const first = p.read(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const update = p.read({ generation: first.generation, speakerRevision: first.speakerRevision })
    expect(update.reset).toBe(false); expect(update.chunks).toHaveLength(1); expect(update.chunks[0].chunkIndex).toBe(0)
    expect(update.chunks[0].canonicalBinding).toBe(first.chunks[0].canonicalBinding)
    expect(update.chunks[0].changedAtRevision).toBe(update.speakerRevision)
    expect(p.read({ generation: update.generation, speakerRevision: update.speakerRevision }).chunks).toEqual([])
  })
  it('full-chunk replacement and explicit empty clear cannot retain stale segments', () => {
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const before = p.snapshot().speakerRevision
    p.replaceChunk('00000000-0000-4000-8000-000000000011', { ...chunk(), segments: [] })
    const update = p.read({ generation: '00000000-0000-4000-8000-000000000011', speakerRevision: before })
    expect(update.chunks).toHaveLength(1); expect(update.chunks[0].segments).toEqual([])
  })
  it.each(['canonicalBinding', 'audioSHA256', 'wordCount', 'startSample', 'endSample'])('refuses immutable %s changes', key => {
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const changed = { ...chunk(), [key]: key.includes('SHA') || key === 'canonicalBinding' ? hash(99) : 999 }
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', changed)).toThrow('immutable_binding')
  })
  it.each(['gap', 'duplicate', 'drop', 'name', 'similarity', 'sparse'])('rejects %s segment projection', kind => {
    const { projection: p } = fixture(); confirm(p); const c = chunk()
    if (kind === 'gap') c.segments[0].wordStart = 1
    if (kind === 'duplicate') c.segments.push({ ...c.segments[0] })
    if (kind === 'drop') c.segments[0].wordEnd = 1
    if (kind === 'name') c.segments[0].speaker = 'Dana Reyes'
    if (kind === 'similarity') (c.segments[0] as { similarity: number }).similarity = 0.99
    if (kind === 'sparse') delete c.segments[0]
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', c)).toThrow()
  })
  it('preserves words as binding and rejects sparse canonical word input', () => {
    const words = [{ text: 'hello', startSample: 0, endSample: 100 }]
    expect(canonicalTextBinding('hello', words)).not.toBe(canonicalTextBinding('Hello', words))
    delete words[0]; expect(() => canonicalTextBinding('hello', words)).toThrow('canonical_word')
  })
  it('returns defensive snapshots and forces reset for future or invalid cursors', () => {
    const { projection: p } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const read = p.read(); read.chunks[0].segments[0].speaker = 'Dana Reyes'
    expect(p.read().chunks[0].segments[0].speaker).toBe('Voice 1')
    expect(p.read({ generation: '00000000-0000-4000-8000-000000000011', speakerRevision: 1000 }).reset).toBe(true)
    expect(p.read({ generation: '00000000-0000-4000-8000-000000000011', speakerRevision: -1 }).reset).toBe(true)
  })
  it('exhausts Voice 99 safely rather than reusing numbers', () => {
    const state = newProjectionState(capture); state.labelHighWater = 99
    const p = new MacSpeakerProjection(state, () => {}); p.beginGeneration('00000000-0000-4000-8000-000000000011')
    expect(confirm(p)).toBeNull(); expect(p.snapshot().labelHighWater).toBe(99)
  })
  it('refuses sparse restored proof/chunk arrays and missing generation metadata', () => {
    const { projection: p } = fixture(); confirm(p)
    for (const bad of ['proofs', 'chunks', 'generation']) {
      const s = p.snapshot()
      if (bad === 'proofs') delete s.slots[0].proofs[0]
      if (bad === 'chunks') s.chunks = new Array(1)
      if (bad === 'generation') s.generations = []
      expect(() => validateProjectionState(s)).toThrow()
    }
  })
})

describe('projection acceptance and budgets', () => {
  it('does not acknowledge async persistence or publish its tentative state', () => {
    const p = new MacSpeakerProjection(newProjectionState(capture), async () => {})
    expect(() => p.beginGeneration('00000000-0000-4000-8000-000000000011')).toThrow('async_persist')
    expect(p.snapshot().speakerRevision).toBe(0)
  })
  it('makes exact chunk replacement retry idempotent, including reordered properties', () => {
    const { projection: p, persist } = fixture(); confirm(p); p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    const revision = p.snapshot().speakerRevision; const count = persist.mock.calls.length
    p.replaceChunk('00000000-0000-4000-8000-000000000011', Object.fromEntries(Object.entries(chunk()).reverse()) as ReturnType<typeof chunk>)
    expect(p.snapshot().speakerRevision).toBe(revision); expect(persist).toHaveBeenCalledTimes(count)
  })
  it('rejects labels beyond emitted coverage and backwards coverage', () => {
    const { projection: p } = fixture(); confirm(p)
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', { ...chunk(), coveredThroughSample: 1000 })).toThrow()
    p.replaceChunk('00000000-0000-4000-8000-000000000011', chunk())
    expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', { ...chunk(), coveredThroughSample: 2000 })).toThrow('coverage_regression')
  })
  it('caps restored generations/chunks and canonical word bytes', () => {
    const state = newProjectionState(capture)
    state.generations = Array.from({ length: 101 }, (_, i) => `g_${i}`)
    expect(() => validateProjectionState(state)).toThrow('corrupt_state')
    state.generations = []; state.chunks = Array.from({ length: 4097 }, () => ({} as ChunkProjection))
    expect(() => validateProjectionState(state)).toThrow('corrupt_state')
    expect(() => canonicalTextBinding('x', [{ text: 'x'.repeat(128001), startSample: 0, endSample: 1 }])).toThrow('word_bound')
  })
})

it('rejects hidden identity/training fields rather than retaining unknown snapshot metadata', () => {
  const { projection: p } = fixture(); confirm(p)
  const s = Object.assign(p.snapshot(), { profiles: ['Dana Reyes'] })
  expect(() => validateProjectionState(s)).toThrow('corrupt_state')
  expect(() => p.replaceChunk('00000000-0000-4000-8000-000000000011', Object.assign(chunk(), { namedEvidence: 'Dana Reyes' }))).toThrow()
})
it('rejects conflicting/repeated support in a restored cross-slot state', () => {
  const { projection: p } = fixture(); p.observe('00000000-0000-4000-8000-000000000011', 0, proof(0))
  const s = p.snapshot(); s.slots.push({ slot: 1, proofs: [proof(0)] })
  expect(() => validateProjectionState(s)).toThrow('corrupt_repeated_support')
})
