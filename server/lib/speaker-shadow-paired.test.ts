import { describe, expect, it } from 'vitest'
import { evaluatePairedSpeakerShadow, isPairedShadowName, renderPairedSpeakerShadow, type PairedShadowInput } from './speaker-shadow-paired.js'
import type { ShadowVoiceEntry } from './speaker-shadow-decide.js'

const SR = 16_000
const epoch = Date.parse('2026-10-29T14:00:00.000Z')
function acoustic(voice: string, seconds = 40, overrides: Partial<ShadowVoiceEntry> = {}): ShadowVoiceEntry {
  return { voice, seconds, coveredFraction: 1, topCluster: 'S1', majority: 1, outlierPass: true, outlierDistance: 0.1, outlierP95: 0.2,
    outlierNote: null, anchorRatioPostHoc: 1, eligible: true, reasons: [], listen: [], ...overrides }
}
function fixture(): PairedShadowInput {
  const a = acoustic('Voice 1'), b = acoustic('Voice 2')
  return { macStartTime: epoch, totalSamples: 100 * SR,
    segments: [[0, 40 * SR, a.voice], [40 * SR, 80 * SR, b.voice]],
    regularTurns: [{ start: 0, end: 100, speaker: 'S1' }],
    acceptedGroups: [{ cluster: 'S1', keepLabel: a.voice, merge: [b.voice], voices: [a, b], otherLabelsInCluster: [] }],
    voiceEvidence: [a, b], g2: { startTime: epoch, chunks: [{ elapsed: 0, audioDurationMs: 100_000, speaker: 'Avery Sample' }] },
    alignment: { status: 'qualified', evidenceId: 'synthetic-audio-alignment', offsetMs: 0, maxErrorMs: 0 } }
}
const run = (change: (input: PairedShadowInput) => void = () => {}) => { const x = fixture(); change(x); return evaluatePairedSpeakerShadow(x) }

describe('paired speaker shadow diagnostics', () => {
  it('reports group and per-voice support without mutating any input or remap', () => {
    const x = fixture(), before = JSON.stringify(x), result = evaluatePairedSpeakerShadow(x)
    expect(JSON.stringify(x)).toBe(before)
    expect(result.groups[0]).toMatchObject({ candidateName: 'Avery Sample', allSpeechSeconds: 80, knownNameSeconds: 80, diagnosticAllSpeechGate: true })
    expect(result.voices.map(v => v.names[0].seconds)).toEqual([40, 40])
    expect(result).toMatchObject({ mode: 'provisional_shadow_only', accuracyClaim: false, humanTruthClaim: false })
    expect(result).not.toHaveProperty('remap')
  })
  it.each(['Ext', 'Unknown', 'MU', 'Speaker1', 'Speaker 2', 'SpeakerN', 'Speaker N', 'Voice17', 'Voice 17', 'VoiceN', 'Me', ''])('never counts %s as a name', label => {
    expect(isPairedShadowName(label)).toBe(false)
    const result = run(x => { x.g2!.chunks = [{ speaker: label || 'Unknown', elapsed: 0, durationMs: 100_000 }] })
    expect(result.groups[0].candidateName).toBeNull()
    expect(result.groups[0].knownNameSeconds).toBe(0)
    expect(result.groups[0].allSpeechSeconds).toBe(80)
  })
  it('separates ALL speech and known-name denominators: 100% known subset cannot qualify 40% overall', () => {
    const result = run(x => { x.g2!.chunks = [{ speaker: 'Avery Sample', elapsed: 0, durationMs: 32_000 }, { speaker: 'Ext', elapsed: 32_000, durationMs: 48_000 }] })
    expect(result.groups[0]).toMatchObject({ allSpeechSeconds: 80, knownNameSeconds: 32, unknownOrUnpairedSeconds: 48, candidateName: null })
    expect(result.groups[0].names[0]).toMatchObject({ seconds: 32, fractionOfAllSpeech: 0.4, fractionOfKnownName: 1 })
  })
  it('requires the inclusive 80% ALL and 30-second support floors without rounding', () => {
    expect(run(x => { x.g2!.chunks = [{ speaker: 'Avery Sample', elapsed: 0, durationMs: 64_000 }] }).groups[0].candidateName).toBe('Avery Sample')
    expect(run(x => { x.g2!.chunks = [{ speaker: 'Avery Sample', elapsed: 0, durationMs: 63_999 }] }).groups[0].candidateName).toBeNull()
    const small = fixture(); small.segments = [[0, 29 * SR, 'Voice 1']]
    expect(evaluatePairedSpeakerShadow(small).groups[0].candidateName).toBeNull()
  })
  it('unions repeated same-name/production/native intervals instead of multiplying votes', () => {
    const result = run(x => {
      x.segments = [...x.segments, ...x.segments]
      x.regularTurns = [...x.regularTurns, ...x.regularTurns]
      x.g2!.chunks = [...x.g2!.chunks, ...x.g2!.chunks]
    })
    expect(result.groups[0]).toMatchObject({ allSpeechSeconds: 80, knownNameSeconds: 80, conflictingG2Seconds: 0 })
    expect(result.groups[0].names[0].seconds).toBe(80)
  })
  it('withholds conflicting G2 names, including a named/unknown overlap', () => {
    for (const speaker of ['Blake Sample', 'Ext']) {
      const result = run(x => { x.g2!.chunks = [...x.g2!.chunks, { elapsed: 0, durationMs: 20_000, speaker }] })
      expect(result.groups[0]).toMatchObject({ allSpeechSeconds: 80, knownNameSeconds: 60, conflictingG2Seconds: 20, candidateName: null })
      expect(result.groups[0].names[0].seconds).toBe(60)
    }
  })
  it('withholds overlapping regular clusters and production labels rather than selecting one', () => {
    const native = run(x => { x.regularTurns = [...x.regularTurns, { start: 0, end: 20, speaker: 'S2' }] })
    expect(native.groups[0]).toMatchObject({ nativeConflictSeconds: 20, candidateName: null })
    const production = run(x => { x.segments = [...x.segments, [0, 20 * SR, 'Voice 3']] })
    expect(production.groups[0]).toMatchObject({ allSpeechSeconds: 80, productionConflictSeconds: 20, candidateName: null })
  })
  it('includes native gaps in the group speech denominator and does not name from the wrong cluster', () => {
    const result = run(x => { x.regularTurns = [{ start: 0, end: 30, speaker: 'S1' }, { start: 40, end: 80, speaker: 'S2' }] })
    expect(result.groups[0]).toMatchObject({ allSpeechSeconds: 80, nativeUncoveredSeconds: 10, wrongClusterSeconds: 40, candidateName: null })
    expect(result.groups[0].names[0].seconds).toBe(30)
  })
  it.each(['time_only', 'ambiguous', 'unpaired'] as const)('%s alignment gives diagnostics but no nominations', status => {
    const result = run(x => {
      x.alignment = { status }; x.segments = [...x.segments, [80 * SR, 90 * SR, 'Ext']]
    })
    expect(result.groups[0].diagnosticTopName).toBe('Avery Sample')
    expect(result.groups[0].candidateName).toBeNull()
    expect(result.candidateNominationAllowed).toBe(false)
    expect(result.extCandidates).toEqual([])
  })
  it('reports no pair and malformed clocks explicitly as uncertain', () => {
    const absent = run(x => { delete x.g2 })
    expect(absent.warnings).toContain('no paired G2 recording')
    expect(absent.groups[0]).toMatchObject({ allSpeechSeconds: 80, unknownOrUnpairedSeconds: 80, candidateName: null })
    const bad = run(x => { x.g2!.chunks = [...x.g2!.chunks, { speaker: 'Blake Sample', elapsed: NaN, durationMs: 3000 }] })
    expect(bad.candidateNominationAllowed).toBe(false)
    expect(bad.warnings).toContain('invalid or conflicting G2 elapsed/duration')
  })
  it('aligns startTime + elapsed in milliseconds and applies explicit offset', () => {
    const result = run(x => {
      x.g2!.startTime = '2026-10-29T13:59:00.000Z'
      x.g2!.chunks = [{ speaker: 'Avery Sample', elapsed: 55_000, audioDurationMs: 80_000 }]
      x.alignment = { status: 'qualified', evidenceId: 'synthetic', offsetMs: 5000, maxErrorMs: 0 }
    })
    expect(result.groups[0].names[0].seconds).toBe(80)
  })
  it('erodes G2 intervals by alignment error and never fills unsupported edges', () => {
    const result = run(x => {
      x.g2!.chunks = [{ speaker: 'Avery Sample', elapsed: 0, durationMs: 80_000 }]
      x.alignment = { status: 'qualified', evidenceId: 'synthetic', offsetMs: 0, maxErrorMs: 1000 }
    })
    expect(result.groups[0]).toMatchObject({ knownNameSeconds: 78, unknownOrUnpairedSeconds: 2 })
  })
  it('nominates exact Ext spans only when same-time G2 and named final group agree', () => {
    const result = run(x => {
      x.segments = [...x.segments, [80 * SR, 100 * SR, 'Ext']]
      x.g2!.chunks = [{ elapsed: 0, durationMs: 85_000, speaker: 'Avery Sample' }, { elapsed: 85_000, durationMs: 15_000, speaker: 'Blake Sample' }]
    })
    expect(result.extCandidates).toEqual([{ startSample: 80 * SR, endSample: 85 * SR, cluster: 'S1', candidateName: 'Avery Sample' }])
  })
  it('never extends Ext nominations through native overlap or a source name', () => {
    const result = run(x => {
      x.segments = [...x.segments, [80 * SR, 100 * SR, 'Ext'], [95 * SR, 100 * SR, 'Avery Sample']]
      x.regularTurns = [...x.regularTurns, { start: 85, end: 90, speaker: 'S2' }]
    })
    expect(result.extCandidates).toEqual([
      { startSample: 80 * SR, endSample: 85 * SR, cluster: 'S1', candidateName: 'Avery Sample' },
      { startSample: 90 * SR, endSample: 95 * SR, cluster: 'S1', candidateName: 'Avery Sample' },
    ])
  })
})

function withShort(overrides: Partial<ShadowVoiceEntry> = {}): PairedShadowInput {
  const x = fixture(), fragment = acoustic('Voice 17', 10, { eligible: false, ...overrides })
  x.segments = [...x.segments, [80 * SR, 90 * SR, fragment.voice]]
  x.voiceEvidence = [...x.voiceEvidence, fragment]
  return x
}
describe('paired short fragments remain shadow-only acoustic proposals', () => {
  it('nominates 5–15s only with acoustic gates, anchor <=1.1 and same group/fragment G2 name', () => {
    const result = evaluatePairedSpeakerShadow(withShort({ anchorRatioPostHoc: 1.1 }))
    expect(result.shortCandidates).toEqual([{ voice: 'Voice 17', cluster: 'S1', candidateName: 'Avery Sample', seconds: 10 }])
    expect(result.groups[0].voices).not.toContain('Voice 17')
  })
  it('field-test2 Voice17 majority .68 fails even with perfect same-time names', () => {
    const result = evaluatePairedSpeakerShadow(withShort({ majority: 0.68 }))
    expect(result.shortCandidates).toEqual([])
    expect(result.shortWithheld).toContainEqual({ voice: 'Voice 17', reasons: ['acoustic majority below 0.8'] })
  })
  it.each([
    { coveredFraction: 0.49 }, { outlierPass: false }, { anchorRatioPostHoc: null }, { anchorRatioPostHoc: 1.10001 }, { seconds: 9 }, { majority: NaN },
  ])('retains each existing acoustic refusal: %j', overrides => {
    expect(evaluatePairedSpeakerShadow(withShort(overrides)).shortCandidates).toEqual([])
  })
  it('refuses conflicting fragment name, missing group name or unknown fragment name', () => {
    for (const speaker of ['Blake Sample', 'Ext']) {
      const x = withShort(); x.g2!.chunks = [{ elapsed: 0, durationMs: 80_000, speaker: 'Avery Sample' }, { elapsed: 80_000, durationMs: 10_000, speaker }]
      expect(evaluatePairedSpeakerShadow(x).shortCandidates).toEqual([])
    }
    const x = withShort(); x.alignment = { status: 'time_only' }
    expect(evaluatePairedSpeakerShadow(x).shortCandidates).toEqual([])
  })
  it('is permutation-invariant and preserves short duration limits', () => {
    const a = withShort(), b = withShort()
    b.segments = [...b.segments].reverse(); b.regularTurns = [...b.regularTurns].reverse(); b.g2!.chunks = [...b.g2!.chunks].reverse()
    expect(evaluatePairedSpeakerShadow(a).shortCandidates).toEqual(evaluatePairedSpeakerShadow(b).shortCandidates)
    const x = withShort({ seconds: 4 }); x.segments = [...x.segments.slice(0, 2), [80 * SR, 84 * SR, 'Voice 17']]
    expect(evaluatePairedSpeakerShadow(x).shortCandidates).toEqual([])
  })
  it('refuses ambiguous accepted groups and malformed intervals', () => {
    const x = fixture(); x.acceptedGroups = [...x.acceptedGroups, ...x.acceptedGroups]
    expect(() => evaluatePairedSpeakerShadow(x)).toThrow('ambiguous accepted paired group')
    expect(run(y => { y.segments = [...y.segments, [NaN, 1, 'Voice 99']] }).candidateNominationAllowed).toBe(false)
  })
})

it('renders both denominators and explicitly withholds time-only nominations', () => {
  const report=run(x => { x.alignment={status:'time_only'}; x.g2!.chunks=[{speaker:'Avery Sample',elapsed:0,durationMs:32000}] })
  const text=renderPairedSpeakerShadow(report)
  expect(text).toContain('Nominations withheld; overlap statistics are diagnostic only.')
  expect(text).toContain('80.0 s | 32.0 s | Avery Sample: 32.0 s; 40.0% | 100.0% | Withheld')
  expect(text).toContain('no accuracy or human-truth claim')
})
