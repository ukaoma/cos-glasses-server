import { describe, expect, it } from 'vitest'
import {
  createMacSpeakerMemory, matchMacSpeakerProfile, normalizedSpeakerCosine,
  reconcileMacSpeakerObservation, validateMacSpeakerMemory,
  type MacSpeakerMemory, type MacSpeakerObservation, type MacSpeakerProfile,
} from './mac-speaker-reconcile.js'

const sha = (n: number) => n.toString(16).padStart(64, '0')
const A = [1, 0, 0], B = [0, 1, 0]
const vector = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180), 0]
const fresh = (overrides: Parameters<typeof createMacSpeakerMemory>[2] = {}) => createMacSpeakerMemory('capture-fixture', sha(10000), { dimensions: 3, ...overrides })
function observation(index: number, embedding = A): MacSpeakerObservation {
  return {
    captureId: 'capture-fixture', modelSHA256: sha(10000),
    original: { chunkIndex: index, audioSHA256: sha(index * 2 + 1), pcmSHA256: sha(index * 2 + 2), startSample: index * 96_000, sampleCount: 96_000 },
    startSample: index * 96_000, endSample: index * 96_000 + 96_000,
    exclusiveSamples: 96_000, purity: 1, overlapSamples: 0, mixedSpeakers: false, embedding: [...embedding],
  }
}
function feed(s: MacSpeakerMemory, index: number, embedding = A) { return reconcileMacSpeakerObservation(s, observation(index, embedding)) }
const profile = (name: string, embedding: number[], n = 999): MacSpeakerProfile => ({ name, embeddings: [embedding], profileSHA256: sha(n) })

describe('persistent anonymous acoustic memory', () => {
  it('keeps A through B and a long silent gap without equating Voice with identity', () => {
    let state = fresh()
    expect(feed(state, 0).decision).toMatchObject({ reason: 'provisional', label: null, confidence: 'provisional' })
    state = feed(state, 0).state
    const a = feed(state, 1); state = a.state
    expect(a.decision.label).toBe('Voice 1')
    state = feed(state, 2, B).state
    const b = feed(state, 3, B); state = b.state
    expect(b.decision.label).toBe('Voice 2')
    const back = feed(JSON.parse(JSON.stringify(state)), 600, [80, 0, 0])
    expect(back.decision).toMatchObject({ label: 'Voice 1', confidence: 'acoustic', reason: 'recurring_anonymous' })
    expect(back.state.identities).toHaveLength(2)
    expect(back.decision.provenance.thresholds.identityCosine).toBe(.88)
  })
  it('does not mutate inputs or retain caller-owned embeddings', () => {
    const state = fresh(), input = observation(0), original = JSON.stringify(state)
    const next = reconcileMacSpeakerObservation(state, input)
    input.original.audioSHA256 = sha(123); (input.embedding as number[])[0] = 0
    expect(JSON.stringify(state)).toBe(original)
    expect(next.state.identities[0].anchors[0].embedding).toEqual(A)
    expect(() => validateMacSpeakerMemory(next.state)).not.toThrow()
  })
  it('rejects top-two anonymous ambiguity instead of choosing the nearest number', () => {
    let state = fresh()
    state = feed(state, 0, vector(-20)).state
    state = feed(state, 1, vector(-20)).state
    state = feed(state, 2, vector(20)).state
    state = feed(state, 3, vector(20)).state
    const result = feed(state, 4, A)
    expect(result.decision.reason).toBe('ambiguous')
    expect(result.state).toEqual(state)
  })
  it('rejects a transitive acoustic bridge and freezes initial witnesses', () => {
    let state = fresh()
    state = feed(state, 0, vector(0)).state
    state = feed(state, 1, vector(20)).state
    const bridge = feed(state, 2, vector(40))
    expect(bridge.decision).toMatchObject({ reason: 'inconsistent_anchors', label: null })
    expect(bridge.state).toEqual(state)
    for (let i = 2; i < 14; i++) state = feed(state, i, vector(10)).state
    expect(state.identities[0].anchors).toHaveLength(4)
    expect(state.identities[0].anchors[0].original.chunkIndex).toBe(0)
    expect(state.identities[0].anchors[1].original.chunkIndex).toBe(1)
    expect(feed(state, 20, vector(35)).decision.reason).toBe('inconsistent_anchors')
  })
  it('does not count crops, original replays or copied PCM as independent evidence', () => {
    const first = feed(fresh(), 0)
    const crop = observation(0); crop.startSample += 16_000; crop.endSample -= 16_000; crop.exclusiveSamples = 64_000
    expect(reconcileMacSpeakerObservation(first.state, crop).decision.reason).toBe('duplicate_source')
    const copied = observation(1); copied.original.pcmSHA256 = observation(0).original.pcmSHA256
    expect(reconcileMacSpeakerObservation(first.state, copied).decision.reason).toBe('duplicate_source')
    const conflict = observation(0); conflict.original.audioSHA256 = sha(99999)
    expect(reconcileMacSpeakerObservation(first.state, conflict).decision.reason).toBe('source_conflict')
    expect(first.state.voiceHighWater).toBe(0)
  })
  it('remembers old audio lineage after anchor retention drops its vector', () => {
    let state = fresh({ maxAnchorsPerIdentity: 3 })
    for (let i = 0; i < 10; i++) state = feed(state, i).state
    expect(state.identities[0].anchors).toHaveLength(3)
    expect(state.originals).toHaveLength(10)
    expect(feed(state, 4).decision.reason).toBe('duplicate_source')
  })
  it('keeps current proof in decision provenance with only two permanent anchors', () => {
    let state = fresh({ maxAnchorsPerIdentity: 2 })
    state = feed(state, 0).state; state = feed(state, 1).state
    const result = feed(state, 2)
    expect(result.state.identities[0].anchors).toHaveLength(2)
    expect(result.decision.evidence).toHaveLength(3)
  })
  it('rejects crossed original intervals even when extracted subintervals are disjoint', () => {
    const state = feed(fresh(), 0).state
    const crossed = observation(1); crossed.original.startSample = 48_000; crossed.startSample = 96_000; crossed.endSample = 144_000; crossed.exclusiveSamples = 48_000
    expect(reconcileMacSpeakerObservation(state, crossed).decision.reason).toBe('crossed_originals')
  })
  it.each([
    { mixedSpeakers: true }, { overlapSamples: 1 }, { purity: .94 }, { exclusiveSamples: 31_999 },
  ])('withholds impure or inadequate intervals %j', patch => {
    const result = reconcileMacSpeakerObservation(fresh(), { ...observation(0), ...patch })
    expect(result.decision.label).toBeNull()
    expect(result.state.identities).toHaveLength(0)
  })
  it.each([[0, 0, 0], [NaN, 0, 0], [Infinity, 0, 0], [1, 0], []].map(embedding => ({ embedding })))('rejects garbage embedding %j', ({ embedding }) => {
    expect(feed(fresh(), 0, embedding).decision.reason).toBe('invalid_observation')
  })
  it('uses normalized cosine for nonunit, tiny and huge vectors', () => {
    expect(normalizedSpeakerCosine([20, 0, 0], [1e-300, 0, 0])).toBe(1)
    expect(normalizedSpeakerCosine([1e300, 0, 0], [1e300, 0, 0])).toBe(1)
  })
  it('preserves existing named/manual spans without using their audio as evidence', () => {
    for (const origin of ['named', 'manual'] as const) {
      const state = fresh()
      const result = reconcileMacSpeakerObservation(state, { ...observation(0, B), mixedSpeakers: true, protectedLabel: { label: 'Gina', origin } })
      expect(result.decision).toMatchObject({ label: 'Gina', reason: 'protected_label' })
      expect(result.state).toEqual(state)
    }
  })
  it('fails closed at an identity budget without eviction, number reuse or attendee inference', () => {
    let state = fresh({ maxIdentities: 1 })
    state = feed(state, 0).state; state = feed(state, 1).state
    const full = feed(state, 2, B)
    expect(full.decision.reason).toBe('budget_exhausted')
    expect(full.state).toEqual(state)
    expect(feed(full.state, 500).decision.label).toBe('Voice 1')
    expect(full.state.voiceHighWater).toBe(1)
  })
  it('never allocates Voice 100 even with a larger identity memory budget', () => {
    let state = fresh({ dimensions: 100 })
    for (let voice = 0; voice < 99; voice++) {
      const v = Array.from({ length: 100 }, (_, i) => i === voice ? 1 : 0)
      state = feed(state, voice * 2, v).state; state = feed(state, voice * 2 + 1, v).state
    }
    expect(state.voiceHighWater).toBe(99)
    const last = Array.from({ length: 100 }, (_, i) => i === 99 ? 1 : 0)
    state = feed(state, 198, last).state
    expect(feed(state, 199, last).decision.reason).toBe('budget_exhausted')
    expect(state.voiceHighWater).toBe(99)
  })
  it('bounds replay ledger and withholds at exhaustion', () => {
    let state = fresh({ maxOriginals: 2 })
    state = feed(state, 0).state; state = feed(state, 1).state
    expect(feed(state, 2).decision.reason).toBe('budget_exhausted')
    expect(state.originals).toHaveLength(2)
  })
  it('rejects corrupt saved high-water, receipt, or mixed model evidence', () => {
    let state = feed(fresh(), 0).state; state = feed(state, 1).state
    const tampered = structuredClone(state); tampered.identities[0].anchors[0].embedding = B
    expect(() => validateMacSpeakerMemory(tampered)).toThrow()
    expect(() => validateMacSpeakerMemory({ ...state, voiceHighWater: 0 })).toThrow()
    const foreign = observation(2); foreign.modelSHA256 = sha(12345)
    expect(reconcileMacSpeakerObservation(state, foreign).decision.reason).toBe('invalid_observation')
  })
})

describe('separate strict profile proposals', () => {
  it('requires multiple independent observations and records the exact profile source hash', () => {
    const state = fresh(), profiles = [profile('Gina', [12, 0, 0])]
    expect(matchMacSpeakerProfile(state, [observation(0)], profiles).reason).toBe('insufficient_independent_matches')
    const result = matchMacSpeakerProfile(state, [observation(0), observation(1, [7, 0, 0])], profiles)
    expect(result).toMatchObject({ reason: 'matched_profile', label: 'Gina', confidence: 'profile', provenance: { profileSHA256: sha(999) } })
    expect(state.identities).toEqual([])
  })
  it('withholds ambiguous top-two names even when both clear .88', () => {
    const result = matchMacSpeakerProfile(fresh(), [observation(0), observation(1)], [profile('Gina', A), profile('Ryan', vector(10))])
    expect(result).toMatchObject({ reason: 'profile_ambiguity', label: null })
  })
  it('does not relax the .88 identity floor when anonymous thresholds are injected', () => {
    expect(() => fresh({ identityCosine: .87 })).toThrow()
    const result = matchMacSpeakerProfile(fresh({ anonymousCosine: .70 }), [observation(0), observation(1)], [profile('Gina', vector(30))])
    expect(result.reason).toBe('profile_below_floor')
    expect(result.provenance.thresholds.identityCosine).toBe(.88)
  })
  it('does not treat crops as multiple profile matches', () => {
    const a = observation(0), crop = observation(0); crop.startSample += 16_000; crop.endSample -= 16_000; crop.exclusiveSamples = 64_000
    expect(matchMacSpeakerProfile(fresh(), [a, crop], [profile('Gina', A)]).reason).toBe('duplicate_source')
  })
  it('uses production raw-average centroid rather than best profile row', () => {
    const p = { ...profile('Gina', A), embeddings: [[1, 0, 0], [0, 100, 0]] }
    expect(matchMacSpeakerProfile(fresh(), [observation(0), observation(1)], [p]).reason).toBe('profile_below_floor')
  })
  it.each(['Voice 3', 'Ext', 'Speaker 2', 'Please tell me more.', 'My voice'])('rejects unqualified profile name %s', name => {
    expect(matchMacSpeakerProfile(fresh(), [observation(0), observation(1)], [profile(name, A)]).reason).toBe('invalid_observation')
  })
  it('withholds profile proposals over incompatible voices or mixed speaker evidence', () => {
    expect(matchMacSpeakerProfile(fresh(), [observation(0), observation(1, B)], [profile('Gina', A)]).reason).toBe('inconsistent_anchors')
    expect(matchMacSpeakerProfile(fresh(), [{ ...observation(0), mixedSpeakers: true }, observation(1)], [profile('Gina', A)]).reason).toBe('mixed_or_overlap')
  })
})
