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

  it('suggests the enrolled profile a group sounds like, tiered by the live identifier\'s own bars', () => {
    // Chris sits at cosine 0.80 to voice 0: above the auto-enrol bar (0.72) -> high.
    // Pat sits at 0.64 to voice 1: above the floor (0.55) but below the bar -> likely.
    // Sam sits at 0.40 to voice 2: under the floor -> no suggestion at all.
    const chris = voiceSample(0, 5, 0.75)
    const pat = voiceSample(1, 6, 1.2)
    const sam = voiceSample(2, 7, 2.29)
    expect(rawCosineSimilarity(chris, voiceSample(0, 20, 0))).toBeCloseTo(0.8, 2)
    expect(rawCosineSimilarity(pat, voiceSample(1, 20, 0))).toBeCloseTo(0.64, 2)
    expect(rawCosineSimilarity(sam, voiceSample(2, 20, 0))).toBeCloseTo(0.4, 2)
    const profiles = [
      { name: 'Chris', embeddings: [Array.from(chris)], sources: ['manual'] },
      { name: 'Pat', embeddings: [Array.from(pat)], sources: ['manual'] },
      { name: 'Sam', embeddings: [Array.from(sam)], sources: ['manual'] },
    ]
    const { groups } = buildHeldVoiceGroups(crowd(), profiles)
    expect(groups[0].suggestion).toMatchObject({ name: 'Chris', tier: 'high' })
    expect(groups[0].suggestion!.similarity).toBeGreaterThanOrEqual(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[1].suggestion).toMatchObject({ name: 'Pat', tier: 'likely' })
    expect(groups[1].suggestion!.similarity).toBeLessThan(HELD_GROUP_HIGH_CONFIDENCE)
    expect(groups[2].suggestion).toBeNull()
  })

  it('suggestProfile ignores profile samples of another dimension and empty profiles', () => {
    const profiles = [
      { name: 'Legacy', embeddings: [[1, 0, 0]], sources: ['manual'] },
      { name: 'Empty', embeddings: [], sources: [] },
    ]
    expect(suggestProfile(voiceSample(0, 20), profiles)).toBeNull()
  })
})
