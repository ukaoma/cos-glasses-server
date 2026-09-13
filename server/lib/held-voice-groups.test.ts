// Grouping and suggestion are exercised by EXECUTION over synthetic voiceprints.
import { describe, expect, it } from 'vitest'
import {
  HELD_DUPLICATE_SIMILARITY, HELD_GROUP_HIGH_CONFIDENCE, HELD_GROUP_SUGGESTION_FLOOR,
  buildHeldVoiceGroups, foldDuplicates, suggestProfile, type HeldSample,
} from './held-voice-groups.js'
import { pairwiseSimilarityMatrix } from './voice-enrolment-selection.js'
import { rawCosineSimilarity } from './speaker-embeddings.js'

const DIM = 192

/** Unit vector along one axis plus a small unique wobble, so every sample of a
 *  voice is distinct yet all of them agree with each other far above the floor. */
function voiceSample(voiceAxis: number, wobbleAxis: number, wobble = 0.15): Float32Array {
  const v = new Float32Array(DIM)
  v[voiceAxis] = 1
  v[wobbleAxis] = wobble
  return v
}

function sample(sessionId: string, chunkIndex: number, voiceAxis: number, wobbleAxis: number): HeldSample {
  return { sessionId, chunkIndex, embedding: voiceSample(voiceAxis, wobbleAxis) }
}

/** Three voices (axes 0, 1, 2) spread over four meetings, plus three artifacts
 *  on axes nothing else touches. */
function crowd(): HeldSample[] {
  return [
    sample('meeting_a', 0, 0, 20), sample('meeting_a', 3, 0, 21), sample('meeting_a', 7, 1, 22),
    sample('meeting_b', 1, 0, 23), sample('meeting_b', 2, 1, 24), sample('meeting_b', 9, 2, 25),
    sample('meeting_c', 0, 0, 26), sample('meeting_c', 4, 2, 27),
    sample('meeting_d', 5, 1, 28), sample('meeting_d', 6, 0, 29),
    sample('meeting_b', 30, 100, 101), sample('meeting_c', 31, 110, 111), sample('meeting_d', 32, 120, 121),
  ]
}

const profile = (name: string, embeddings: Float32Array[], sources: string[]) =>
  ({ name, embeddings: embeddings.map(e => Array.from(e)), sources })

describe('buildHeldVoiceGroups', () => {
  it('carves three voices out of four meetings and leaves the artifacts loose', () => {
    const { groups, loose } = buildHeldVoiceGroups(crowd(), [])
    expect(groups.map(g => g.sampleCount)).toEqual([5, 3, 2])
    expect(groups.map(g => g.distinctCount)).toEqual([5, 3, 2])
    expect(groups[0].sessions).toEqual(['meeting_a', 'meeting_b', 'meeting_c', 'meeting_d'])
    expect(groups[0].members).toEqual([
      { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 3 },
      { sessionId: 'meeting_b', chunkIndex: 1 }, { sessionId: 'meeting_c', chunkIndex: 0 },
      { sessionId: 'meeting_d', chunkIndex: 6 },
    ])
    expect(groups[0].id).toBe('meeting_a#0')
    for (const g of groups) {
      expect(g.coherence).toBeGreaterThanOrEqual(HELD_GROUP_SUGGESTION_FLOOR)
      expect(g.members.some(m => m.sessionId === g.seed.sessionId && m.chunkIndex === g.seed.chunkIndex)).toBe(true)
      expect(g.suggestion).toBeNull()
    }
    expect(loose).toEqual([
      { sessionId: 'meeting_b', chunkIndex: 30 }, { sessionId: 'meeting_c', chunkIndex: 31 }, { sessionId: 'meeting_d', chunkIndex: 32 },
    ])
  })

  it('never reports a single sample as a group', () => {
    const one = [sample('meeting_a', 0, 0, 20)]
    expect(buildHeldVoiceGroups(one, [])).toEqual({ groups: [], loose: [{ sessionId: 'meeting_a', chunkIndex: 0 }] })
    // Two coherent samples plus one leftover: the leftover is loose, not a group of one.
    const three = [sample('meeting_a', 0, 0, 20), sample('meeting_a', 1, 0, 21), sample('meeting_a', 2, 5, 22)]
    const r = buildHeldVoiceGroups(three, [])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].sampleCount).toBe(2)
    expect(r.loose).toEqual([{ sessionId: 'meeting_a', chunkIndex: 2 }])
  })

  it('a crowd that agrees on nothing is all loose', () => {
    const noise = [sample('m', 0, 10, 11), sample('m', 1, 20, 21), sample('m', 2, 30, 31), sample('m', 3, 40, 41)]
    const r = buildHeldVoiceGroups(noise, [])
    expect(r.groups).toEqual([])
    expect(r.loose).toHaveLength(4)
  })

  it('folds the same chunk banked twice into one sample, and keeps both wavs in the members', () => {
    // A recording started twice 12 ms apart banks every chunk under two ids.
    const twice = [
      sample('meeting_x', 0, 0, 20), sample('meeting_x_dup', 0, 0, 20),
      sample('meeting_x', 1, 0, 21), sample('meeting_x_dup', 1, 0, 21),
      sample('meeting_x', 2, 0, 22),
      sample('meeting_x', 9, 40, 41), sample('meeting_x_dup', 9, 40, 41),
    ]
    const sim = pairwiseSimilarityMatrix(twice.map(s => s.embedding))
    expect(sim[0][1]).toBeGreaterThanOrEqual(HELD_DUPLICATE_SIMILARITY)
    expect(foldDuplicates(sim, twice.length).reps).toEqual([0, 2, 4, 5])
    const { groups, loose } = buildHeldVoiceGroups(twice, [])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ sampleCount: 5, distinctCount: 3 })
    expect(groups[0].coherence).toBeLessThan(HELD_DUPLICATE_SIMILARITY)
    // The doubled artifact is NOT a two-sample voice; it is one loose sample with two wavs.
    expect(loose).toEqual([{ sessionId: 'meeting_x', chunkIndex: 9 }, { sessionId: 'meeting_x_dup', chunkIndex: 9 }])
  })
})

describe('suggestions', () => {
  it('names the profile that VOUCHES for a group: two agreeing samples, scored on the seed against the second-best', () => {
    // Chris has two samples at 0.95 and 0.93 to a voice-0 sample: both clear
    // the floor, the score is the second (0.93), above the auto-enrol bar -> high.
    // Pat has two at 0.63 and 0.59 to voice 1 -> likely.
    // Sam has one sample at 0.40 to voice 2: under the floor -> nothing.
    const chrisA = voiceSample(0, 5, 0.3), chrisB = voiceSample(0, 6, 0.35)
    const patA = voiceSample(1, 7, 1.2), patB = voiceSample(1, 8, 4 / 3)
    const sam = voiceSample(2, 9, 2.29)
    const seedLike = voiceSample(0, 20)
    expect(rawCosineSimilarity(chrisB, seedLike)).toBeCloseTo(0.933, 2)
    expect(rawCosineSimilarity(patB, voiceSample(1, 20))).toBeCloseTo(0.593, 2)
    const profiles = [
      profile('Chris', [chrisA, chrisB], ['manual', 'manual']),
      profile('Pat', [patA, patB], ['manual', 'manual']),
      profile('Sam', [sam], ['manual']),
    ]
    const { groups } = buildHeldVoiceGroups(crowd(), profiles)
    expect(groups[0].suggestion).toMatchObject({ name: 'Chris', tier: 'high', agreeing: 2, of: 2, anchor: 'manual' })
    expect(groups[0].suggestion!.similarity).toBeGreaterThanOrEqual(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[0].suggestion!.similarity).toBeLessThan(0.94)
    expect(groups[1].suggestion).toMatchObject({ name: 'Pat', tier: 'likely', agreeing: 2, of: 2 })
    expect(groups[1].suggestion!.similarity).toBeLessThan(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[2].suggestion).toBeNull()
  })

  it('scores the seed SAMPLE, never a centroid: the bar means what it says on one chunk', () => {
    // Twenty noisy samples of one voice; the profile sits at 0.87 to EACH of
    // them (just under the 0.88 bar) but their centroid averages the noise away
    // and would clear it. Measured on the live store 2026-09-12 (Tina Hetzler
    // vs Allison Kelley: centroid 0.76 against a best single pair of 0.70).
    const samples = Array.from({ length: 20 }, (_, k) => ({ sessionId: 'meeting_n', chunkIndex: k, embedding: voiceSample(0, 40 + k, 0.5) }))
    const near = voiceSample(0, 70, 0.35)  // cos to each sample = 1/(1.118*1.059) ≈ 0.84; to their centroid ≈ 0.94
    expect(rawCosineSimilarity(near, samples[0].embedding)).toBeLessThan(HELD_GROUP_HIGH_CONFIDENCE)
    const centroid = new Float32Array(DIM); for (const s of samples) for (let d = 0; d < DIM; d++) centroid[d] += s.embedding[d] / samples.length
    expect(rawCosineSimilarity(near, centroid)).toBeGreaterThan(HELD_GROUP_HIGH_CONFIDENCE)
    const p = profile('Allison', [near, voiceSample(0, 71, 0.36)], ['manual', 'manual'])
    const { groups } = buildHeldVoiceGroups(samples, [p])
    expect(groups).toHaveLength(1)
    expect(groups[0].suggestion?.tier).toBe('likely')
    expect(groups[0].suggestion!.similarity).toBeLessThan(HELD_GROUP_HIGH_CONFIDENCE)
  })

  it('one polluted sample in a big profile cannot vouch for a group (live store, 2026-09-12)', () => {
    // 19 samples of somebody else plus ONE sample that is nearly this voice:
    // best-of says 0.99, the profile as a whole says no.
    const polluted = profile('Jessica',
      [voiceSample(0, 30, 0.05), ...Array.from({ length: 19 }, (_, k) => voiceSample(60 + k, 61 + k))],
      Array.from({ length: 20 }, () => 'correction'))
    expect(buildHeldVoiceGroups(crowd(), [polluted]).groups[0].suggestion).toBeNull()
    // The same voice with a SECOND agreeing sample is vouched for.
    const repaired = { ...polluted, embeddings: [...polluted.embeddings, Array.from(voiceSample(0, 31, 0.8))], sources: [...polluted.sources, 'correction'] }
    expect(buildHeldVoiceGroups(crowd(), [repaired]).groups[0].suggestion).toMatchObject({ name: 'Jessica', agreeing: 2, of: 21 })
  })

  it('samples from a bulk session enrol cannot vouch on their own, and the runner-up is not offered instead', () => {
    // Five ext-retroactive samples agree with voice 0 — the household voice an
    // earlier "name this session" wrote into somebody's profile.
    const bulk = profile('Jessie', [0.75, 0.8, 0.85, 0.9, 1.0].map((w, k) => voiceSample(0, 40 + k, w)),
      ['ext-retroactive', 'ext-retroactive', 'ext-retroactive:meeting_9', 'ext-retroactive', 'ext-retroactive'])
    expect(buildHeldVoiceGroups(crowd(), [bulk]).groups[0].suggestion).toBeNull()
    // A weaker but anchored profile does NOT become the suggestion: the voice
    // most likely belongs to the profile that cannot vouch, and the runner-up
    // is a different person.
    const runnerUp = profile('Pat', [voiceSample(0, 50, 1.2), voiceSample(0, 51, 4 / 3)], ['manual', 'manual'])
    expect(buildHeldVoiceGroups(crowd(), [bulk, runnerUp]).groups[0].suggestion).toBeNull()
    expect(buildHeldVoiceGroups(crowd(), [runnerUp]).groups[0].suggestion).toMatchObject({ name: 'Pat' })
    // One agreeing sample from an anchored source, and the profile can vouch.
    const anchored = { ...bulk, embeddings: [...bulk.embeddings, Array.from(voiceSample(0, 45, 0.7))], sources: [...bulk.sources, 'Correction:meeting_3'] }
    expect(buildHeldVoiceGroups(crowd(), [anchored]).groups[0].suggestion).toMatchObject({ name: 'Jessie', agreeing: 6, of: 6, anchor: 'Correction' })
    // An auto-enrolled or unknown-provenance sample is not an anchor either.
    for (const src of ['auto:meeting_1', 'unknown']) {
      const weak = { ...bulk, embeddings: anchored.embeddings, sources: [...bulk.sources, src] }
      expect(buildHeldVoiceGroups(crowd(), [weak]).groups[0].suggestion).toBeNull()
    }
  })

  it('never offers the wearer\'s own profile', () => {
    const owner = profile('MU', [voiceSample(0, 5, 0.75), voiceSample(0, 6, 0.8)], ['fireflies', 'fireflies'])
    expect(buildHeldVoiceGroups(crowd(), [owner], { ownerLabel: 'MU' }).groups[0].suggestion).toBeNull()
    expect(buildHeldVoiceGroups(crowd(), [owner]).groups[0].suggestion).toMatchObject({ name: 'MU' })
  })

  it('a one-sample profile can only vouch as likely', () => {
    const solo = profile('Solo', [voiceSample(0, 5, 0.3)], ['manual'])
    expect(rawCosineSimilarity(new Float32Array(solo.embeddings[0]), voiceSample(0, 20))).toBeGreaterThan(HELD_GROUP_HIGH_CONFIDENCE)
    expect(buildHeldVoiceGroups(crowd(), [solo]).groups[0].suggestion).toMatchObject({ name: 'Solo', tier: 'likely', agreeing: 1, of: 1 })
  })

  it('suggestProfile ignores profile samples of another dimension and empty profiles', () => {
    const profiles = [
      { name: 'Legacy', embeddings: [[1, 0, 0]], sources: ['manual'] },
      { name: 'Empty', embeddings: [], sources: [] },
    ]
    expect(suggestProfile(voiceSample(0, 20), profiles)).toBeNull()
  })
})
