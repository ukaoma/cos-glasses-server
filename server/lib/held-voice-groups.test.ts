// Grouping is exercised by EXECUTION over synthetic voiceprints, not by reading
// the code: three voices across four meetings plus noise must come out as three
// groups and the noise as loose.
import { describe, expect, it } from 'vitest'
import { HELD_GROUP_HIGH_CONFIDENCE, HELD_GROUP_SUGGESTION_FLOOR, buildHeldVoiceGroups, suggestProfile, type HeldSample } from './held-voice-groups.js'
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
  return { sessionId, chunkIndex, embedding: voiceSample(voiceAxis, wobbleAxis), embeddingSource: 'banked' }
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

describe('buildHeldVoiceGroups', () => {
  it('carves three voices out of four meetings and leaves the artifacts loose', () => {
    const { groups, loose } = buildHeldVoiceGroups(crowd(), [])
    expect(groups.map(g => g.sampleCount)).toEqual([5, 3, 2])
    expect(groups[0].sessions).toEqual(['meeting_a', 'meeting_b', 'meeting_c', 'meeting_d'])
    expect(groups[0].members).toEqual([
      { sessionId: 'meeting_a', chunkIndex: 0 }, { sessionId: 'meeting_a', chunkIndex: 3 },
      { sessionId: 'meeting_b', chunkIndex: 1 }, { sessionId: 'meeting_c', chunkIndex: 0 },
      { sessionId: 'meeting_d', chunkIndex: 6 },
    ])
    expect(groups[0].id).toBe('meeting_a#0')
    expect(groups.map(g => g.distinctCount)).toEqual([5, 3, 2])
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

  it('suggests the profile that VOUCHES for a group: two agreeing samples, scored on the second-best', () => {
    // Chris has two samples at 0.80 and 0.78 to voice 0: both clear the floor,
    // the score is the second (0.78), above the auto-enrol bar -> high.
    // Pat has two at 0.64 and 0.60 to voice 1: -> likely at 0.60.
    // Sam has one sample at 0.40 to voice 2: under the floor -> nothing.
    const chrisA = voiceSample(0, 5, 0.75), chrisB = voiceSample(0, 6, 0.8)
    const patA = voiceSample(1, 7, 1.2), patB = voiceSample(1, 8, 4 / 3)
    const sam = voiceSample(2, 9, 2.29)
    expect(rawCosineSimilarity(chrisB, voiceSample(0, 20, 0))).toBeCloseTo(0.78, 2)
    expect(rawCosineSimilarity(patB, voiceSample(1, 20, 0))).toBeCloseTo(0.6, 2)
    const profiles = [
      { name: 'Chris', embeddings: [Array.from(chrisA), Array.from(chrisB)], sources: ['manual', 'manual'] },
      { name: 'Pat', embeddings: [Array.from(patA), Array.from(patB)], sources: ['manual', 'manual'] },
      { name: 'Sam', embeddings: [Array.from(sam)], sources: ['manual'] },
    ]
    const { groups } = buildHeldVoiceGroups(crowd(), profiles)
    expect(groups[0].suggestion).toMatchObject({ name: 'Chris', tier: 'high', agreeing: 2, of: 2, anchor: 'manual' })
    expect(groups[0].suggestion!.similarity).toBeGreaterThanOrEqual(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[0].suggestion!.similarity).toBeLessThan(0.79)
    expect(groups[1].suggestion).toMatchObject({ name: 'Pat', tier: 'likely', agreeing: 2, of: 2 })
    expect(groups[1].suggestion!.similarity).toBeLessThan(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[2].suggestion).toBeNull()
  })

  it('one polluted sample in a big profile cannot vouch for a group (live store, 2026-09-12)', () => {
    // 19 samples of somebody else plus ONE sample that is nearly this voice:
    // best-of says 0.99, the profile as a whole says no.
    const polluted = {
      name: 'Jessica',
      embeddings: [Array.from(voiceSample(0, 30, 0.05)), ...Array.from({ length: 19 }, (_, k) => Array.from(voiceSample(60 + k, 61 + k)))],
      sources: Array.from({ length: 20 }, () => 'correction'),
    }
    const { groups } = buildHeldVoiceGroups(crowd(), [polluted])
    expect(groups[0].suggestion).toBeNull()
    // The same voice with a SECOND agreeing sample is vouched for.
    const repaired = { ...polluted, embeddings: [...polluted.embeddings, Array.from(voiceSample(0, 31, 0.8))] }
    expect(buildHeldVoiceGroups(crowd(), [repaired]).groups[0].suggestion).toMatchObject({ name: 'Jessica', agreeing: 2, of: 21 })
  })

  it('samples from a bulk session enrol cannot vouch on their own (live store, 2026-09-12)', () => {
    // Five ext-retroactive samples agree with voice 0 — that is the household
    // voice an earlier "name this session" wrote into somebody's profile.
    const bulk = {
      name: 'Jessie',
      embeddings: [0.75, 0.8, 0.85, 0.9, 1.0].map((w, k) => Array.from(voiceSample(0, 40 + k, w))),
      sources: ['ext-retroactive', 'ext-retroactive', 'ext-retroactive:meeting_9', 'ext-retroactive', 'ext-retroactive'],
    }
    expect(buildHeldVoiceGroups(crowd(), [bulk]).groups[0].suggestion).toBeNull()
    // One agreeing sample from an anchored source, and the profile can vouch.
    const anchored = { ...bulk, embeddings: [...bulk.embeddings, Array.from(voiceSample(0, 45, 0.7))], sources: [...bulk.sources, 'correction:meeting_3'] }
    expect(buildHeldVoiceGroups(crowd(), [anchored]).groups[0].suggestion).toMatchObject({ name: 'Jessie', agreeing: 6, of: 6, anchor: 'correction' })
    // An auto-enrolled or unknown-provenance sample is not an anchor either.
    for (const src of ['auto:meeting_1', 'unknown']) {
      const weak = { ...bulk, embeddings: anchored.embeddings, sources: [...bulk.sources, src] }
      expect(buildHeldVoiceGroups(crowd(), [weak]).groups[0].suggestion).toBeNull()
    }
  })

  it('a one-sample profile can only vouch as likely', () => {
    const solo = { name: 'Solo', embeddings: [Array.from(voiceSample(0, 5, 0.3))], sources: ['manual'] }
    expect(rawCosineSimilarity(new Float32Array(solo.embeddings[0]), voiceSample(0, 20, 0))).toBeGreaterThan(HELD_GROUP_HIGH_CONFIDENCE)
    expect(buildHeldVoiceGroups(crowd(), [solo]).groups[0].suggestion).toMatchObject({ name: 'Solo', tier: 'likely', agreeing: 1, of: 1 })
  })

  it('folds the same chunk banked twice into one sample, and keeps both wavs in the members', () => {
    // A recording started twice 12 ms apart banks every chunk under two ids.
    const twice = [
      sample('meeting_x', 0, 0, 20), sample('meeting_x_dup', 0, 0, 20),
      sample('meeting_x', 1, 0, 21), sample('meeting_x_dup', 1, 0, 21),
      sample('meeting_x', 2, 0, 22),
      sample('meeting_x', 9, 40, 41), sample('meeting_x_dup', 9, 40, 41),
    ]
    const { groups, loose } = buildHeldVoiceGroups(twice, [])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ sampleCount: 5, distinctCount: 3 })
    expect(groups[0].coherence).toBeLessThan(0.999)
    // The doubled artifact is NOT a two-sample voice; it is one loose sample with two wavs.
    expect(loose).toEqual([{ sessionId: 'meeting_x', chunkIndex: 9 }, { sessionId: 'meeting_x_dup', chunkIndex: 9 }])
  })

  it('suggestProfile ignores profile samples of another dimension and empty profiles', () => {
    const profiles = [
      { name: 'Legacy', embeddings: [[1, 0, 0]], sources: ['manual'] },
      { name: 'Empty', embeddings: [], sources: [] },
    ]
    expect(suggestProfile(voiceSample(0, 20), profiles)).toBeNull()
  })
})
