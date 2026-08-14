// The two gates that decide which chunks of a corrected meeting become training
// data. Both are pure over Float32Array[], so every assertion here is made by
// EXECUTION — there is no source-shape assertion in this file, deliberately: the
// bug these exist to prevent shipped past a green suite whose tests read code
// rather than ran it.
import { describe, expect, it } from 'vitest'
import { MERGE_SIMILARITY_FLOOR, rawCosineSimilarity } from './speaker-embeddings.js'
import {
  MAX_ENROL_PER_CORRECTION,
  VOICE_COHERENCE_FLOOR,
  dominantCoherentCluster,
  greedyDiversitySelect,
} from './voice-enrolment-selection.js'

const DIM = 192

/**
 * A vector on one of two orthogonal subspaces, carrying a recoverable marker in
 * its last component.
 *
 * Same-axis vectors sit at cosine ~1.0 (one voice); cross-axis at ~0.0 (two
 * people). The marker is three orders of magnitude below the body, so it
 * identifies the vector without moving it.
 */
function voice(marker: number, axis: 'a' | 'b' = 'a'): Float32Array {
  const v = new Float32Array(DIM)
  const start = axis === 'a' ? 0 : 96
  for (let k = start; k < start + 95; k++) v[k] = 100
  v[DIM - 1] = marker
  return v
}

const markers = (rows: Float32Array[]): number[] => rows.map(r => r[DIM - 1])

describe('the coherence floor is the identifier\'s own threshold', () => {
  it('is derived from MERGE_SIMILARITY_FLOOR, not written as a literal', () => {
    // Pinned because the whole argument for the gate is that it uses the SAME
    // number identifySpeaker accepts on. A literal here would silently disagree
    // the day that threshold is tuned, and the gate would start rejecting voices
    // the identifier itself would have matched (or admitting ones it would not).
    expect(VOICE_COHERENCE_FLOOR).toBe(MERGE_SIMILARITY_FLOOR)
    expect(VOICE_COHERENCE_FLOOR).toBeCloseTo(0.55, 10)
  })

  it('the fixture really does straddle that floor', () => {
    // Guards the fixture itself: if `voice()` ever stopped producing genuinely
    // orthogonal axes, every two-cluster test below would pass vacuously.
    expect(rawCosineSimilarity(voice(1, 'a'), voice(2, 'a'))).toBeGreaterThan(0.99)
    expect(rawCosineSimilarity(voice(1, 'a'), voice(2, 'b'))).toBeLessThan(0.55)
  })
})

describe('dominantCoherentCluster', () => {
  it('returns nothing for an empty bag', () => {
    expect(dominantCoherentCluster([])).toEqual({ members: [], seed: -1 })
  })

  it('accepts a lone candidate — one chunk cannot contradict itself', () => {
    // A short correction covering a single segment must still be able to train.
    expect(dominantCoherentCluster([voice(7)])).toEqual({ members: [0], seed: 0 })
  })

  it('keeps every member when they are all one voice', () => {
    const cluster = dominantCoherentCluster([voice(1), voice(2), voice(3), voice(4)])
    expect(cluster.members).toEqual([0, 1, 2, 3])
  })

  it('keeps only the dominant voice when an Ext bucket holds two people', () => {
    // The measured shape of the real failure: one `Ext` label covering several
    // unrecognised speakers. 115 Ext embeddings on meeting_1786628481833_eagkaz
    // had a median pairwise cosine of 0.170.
    const bag = [voice(10, 'a'), voice(11, 'b'), voice(12, 'a'), voice(13, 'b'), voice(14, 'a')]
    const cluster = dominantCoherentCluster(bag)
    expect(cluster.members).toEqual([0, 2, 4])
    expect(markers(cluster.members.map(i => bag[i]))).toEqual([10, 12, 14])
  })

  it('returns EMPTY when nothing agrees with anything', () => {
    // Every candidate a different person. The seed with the most agreement still
    // has none, so there is no dominant voice — and picking one anyway would be
    // choosing an arbitrary stranger, which is the exact poisoning this stops.
    const orthogonal = [0, 1, 2, 3].map(k => {
      const v = new Float32Array(DIM)
      v[k * 40] = 100
      return v
    })
    expect(dominantCoherentCluster(orthogonal)).toEqual({ members: [], seed: -1 })
  })

  it('does NOT chain A~B~C into one cluster when A and C disagree', () => {
    // The case a star-shaped cluster gets WRONG and this one must not: b sits
    // between two orthogonal voices, so the star around b is the whole crowd.
    // Both connected components and a bare medoid star would admit all three.
    const a = new Float32Array(DIM); a[0] = 1
    const c = new Float32Array(DIM); c[1] = 1                 // orthogonal to a
    const b = new Float32Array(DIM); b[0] = 1; b[1] = 1       // 0.707 to both
    expect(rawCosineSimilarity(a, c)).toBeLessThan(0.55)
    expect(rawCosineSimilarity(a, b)).toBeGreaterThan(0.55)
    expect(rawCosineSimilarity(c, b)).toBeGreaterThan(0.55)

    // b is the only seed with any agreement, and its star is {a,b,c}. The
    // refinement has to drop one of the orthogonal pair; either answer is
    // acceptable, admitting BOTH is not.
    const cluster = dominantCoherentCluster([a, b, c])
    expect(cluster.members).toHaveLength(2)
    expect(cluster.members).toContain(1)
    expect(cluster.members).not.toEqual([0, 1, 2])
  })

  it('every surviving PAIR clears the floor, not just every member to the seed', () => {
    // The property in one assertion, over a bag built to break a star: two
    // tight voices plus three bridges that each sound like both.
    const bag = [
      voice(1, 'a'), voice(2, 'a'), voice(3, 'a'),
      voice(4, 'b'), voice(5, 'b'),
    ]
    const bridge = new Float32Array(DIM)
    for (let k = 0; k < 191; k++) bridge[k] = 100          // spans both axes
    bag.push(bridge)

    const cluster = dominantCoherentCluster(bag)
    expect(cluster.members.length).toBeGreaterThanOrEqual(2)
    for (const i of cluster.members) {
      for (const j of cluster.members) {
        if (i === j) continue
        expect(rawCosineSimilarity(bag[i], bag[j])).toBeGreaterThanOrEqual(VOICE_COHERENCE_FLOOR)
      }
    }
    expect(cluster.members).toContain(cluster.seed)
  })

  it('is deterministic across repeated calls on the same input', () => {
    const bag = [voice(1, 'a'), voice(2, 'b'), voice(3, 'a'), voice(4, 'b')]
    // A 2-2 split: the tie-break must resolve the same way every time or the
    // same correction would enrol different people on different runs.
    const first = dominantCoherentCluster(bag)
    for (let n = 0; n < 5; n++) expect(dominantCoherentCluster(bag)).toEqual(first)
    expect(first.members).toHaveLength(2)
  })
})

describe('greedyDiversitySelect', () => {
  it('returns everything untouched when under the cap', () => {
    const bag = [voice(1), voice(2), voice(3)]
    expect(greedyDiversitySelect(bag, MAX_ENROL_PER_CORRECTION)).toBe(bag)
  })

  it('bounds a large correction to the cap', () => {
    // 109 chunks against a 7.9 MB store is ~41 ms per enrollEmbedding cycle,
    // which blocks past COS Control's 30 s helper timeout and reports
    // "Server stopped" for a correction that applied.
    const bag = Array.from({ length: 109 }, (_, i) => voice(i))
    expect(greedyDiversitySelect(bag, MAX_ENROL_PER_CORRECTION)).toHaveLength(20)
    expect(MAX_ENROL_PER_CORRECTION).toBe(20)
  })

  it('spans both extremes rather than taking the first N', () => {
    const bag = [voice(0, 'a'), voice(1, 'a'), voice(2, 'a'), voice(3, 'b'), voice(4, 'b')]
    const picked = markers(greedyDiversitySelect(bag, 2))
    // The seed pair is the most dissimilar, so it must cross the two axes.
    expect(picked.some(m => m <= 2)).toBe(true)
    expect(picked.some(m => m >= 3)).toBe(true)
  })

  it('never returns duplicates', () => {
    const bag = Array.from({ length: 30 }, (_, i) => voice(i))
    const picked = markers(greedyDiversitySelect(bag, 20))
    expect(new Set(picked).size).toBe(20)
  })
})
