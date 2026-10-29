import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SHADOW_GATES, buildShadowProposals, decide, exactOverlap, IntervalIndex, intervalSamples, isShadowVoiceLabel, nativeTurns,
  type ShadowDecision, type ShadowSegment, type ShadowSegmentSource,
} from './speaker-shadow-decide.js'
import { SR, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative, syntheticSegments } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

// Expected decisions written by the RESEARCH TOOL (hybrid.py decide() on CPython 3.15), not
// by this port: synthetic_python_decide.py runs it on the dumped synthetic meeting.
const python = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'speaker-shadow', 'synthetic-python-decide.json'), 'utf8'))
const total = SYNTHETIC_SECONDS * SR
const emb = syntheticEmbeddings()

function run(segs: ShadowSegment[], native = syntheticNative().segments, drop: number[] = [], extra: typeof emb = []): { D: ShadowDecision; turns: ReturnType<typeof nativeTurns>['turns'] } {
  const { turns } = nativeTurns(native, SYNTHETIC_SECONDS)
  const dropped = new Set(drop)
  return { D: decide(segs, total, turns, [...emb.filter((_, i) => !dropped.has(i)), ...extra]), turns }
}
const sourcesFor = (segs: readonly ShadowSegment[]): ShadowSegmentSource[] =>
  segs.map(([lo, hi]) => ({ chunkIndex: Math.floor(lo / SR / 10), start: (lo / SR) % 10, end: (hi - Math.floor(lo / SR / 10) * 10 * SR) / SR, abs: lo / SR }))

function expectMatchesPython(D: ShadowDecision, py: any): void {
  expect([...D.rows.keys()]).toEqual(Object.keys(py.rows))
  for (const [voice, row] of D.rows) {
    const o = row.outlier
    const outlier = 'reason' in o ? { pass: o.pass, reason: o.reason } : { pass: o.pass, fragmentCentroidDistance: o.fragmentCentroidDistance, clusterP95Distance: o.clusterP95Distance }
    expect({ voice, ...row, outlier }).toEqual({ voice, ...py.rows[voice] })
  }
  expect(D.groups).toEqual(py.groups)
  expect(D.rejected).toEqual(py.rejected)
  expect(Object.fromEntries(D.remap)).toEqual(py.remap)
  expect([D.proposed, D.accepted, D.agree, D.withOut, D.items.length, D.voiceBefore, D.voiceAfter])
    .toEqual([py.proposed, py.accepted, py.agree, py.withOut, py.items, py.voiceBefore, py.voiceAfter])
  expect(D.items.map(x => x.voice)).toEqual(py.itemVoices)
}

describe('speaker shadow decide(): parity with the research tool', () => {
  it('the fixture was written by the research tool on CPython', () => {
    expect(python.source).toMatch(/hybrid\.py decide\(\) on CPython 3\.1[2-9]/)
    // The variants carry the exact inputs Python saw; base must equal what the fixture generates.
    expect(python.variants.base.segs).toEqual(syntheticSegments().map(s => [...s]))
    expect(python.variants.base.native).toEqual(syntheticNative().segments)
  })

  for (const name of ['base', 'voice13_14995', 'voice6_majority_07996', 'thin_embeddings', 'straddling_window', 'later_longer']) {
    it(`reproduces every gate value, reason and merge (${name})`, () => {
      const v = python.variants[name]
      expectMatchesPython(run(v.segs, v.native, v.dropEmbeddings, v.extraEmbeddings).D, v)
    })
  }

  it('the boundary variants exercise what they are named for', () => {
    const rows = (name: string) => python.variants[name].rows
    expect(rows('voice13_14995')['Voice 13']).toMatchObject({ seconds: 14.99, reasons: ['(b) 15.0 s < 15 s'] })
    expect(rows('voice6_majority_07996')['Voice 6']).toMatchObject({ majority: 0.8, eligible: true })
    expect(rows('thin_embeddings')['Voice 13'].reasons).toEqual(['(c) insufficient embeddings (fragment 2, others 81)'])
    expect(rows('thin_embeddings')['Voice 12'].reasons).toEqual(['(c) insufficient embeddings (fragment 19, others 4)'])
    // No Voice holds half of the straddling window, so it is nobody's fragment (only Voice labels compete).
    expect(python.variants.straddling_window.itemVoices.at(-1)).toBeNull()
    // The anchor is the LONGEST eligible voice, not the earliest.
    expect(python.variants.later_longer.groups.find((g: any) => g.cluster === 'S4')).toEqual({ cluster: 'S4', voices: ['Voice 12', 'Voice 11'], anchor: 'Voice 12', mergedIntoAnchor: ['Voice 11'] })
  })
})

describe('speaker shadow decide(): each gate, by design', () => {
  const { D, turns } = run(syntheticSegments())
  const segs = syntheticSegments()
  const P = buildShadowProposals(D, segs, sourcesFor(segs), turns)
  const reasons = (v: string) => D.rows.get(v)!.reasons

  it('accepts same-person fragments into the longest eligible voice', () => {
    expect(P.accepted.map(a => [a.cluster, a.keepLabel, a.merge])).toEqual([
      ['S1', 'Voice 1', ['Voice 2', 'Voice 13']],
      ['S2', 'Voice 3', ['Voice 10']],
      ['S4', 'Voice 11', ['Voice 12']],
    ])
    expect([P.productionVoices, P.voicesAfter, P.proposedMerges, P.acceptedMerges, P.rejectedMerges]).toEqual([13, 9, 8, 4, 4])
  })

  it('(a) majority: a voice split across clusters is rejected', () => {
    expect(reasons('Voice 6')).toEqual(['(a) majority 0.60 < 0.80'])
  })

  it('(a) coverage: a voice FluidAudio mostly did not hear is rejected', () => {
    expect(reasons('Voice 7')).toEqual(['(a) covered 0.40 < 0.50'])
  })

  it('(b) floor: under 15 s is rejected, exactly 15.00 s passes', () => {
    expect(reasons('Voice 4')).toEqual(['(b) 10.0 s < 15 s'])
    expect(D.rows.get('Voice 13')!.seconds).toBe(SHADOW_GATES.floorSeconds)
    expect(reasons('Voice 13')).toEqual([])
  })

  it('(c) outlier: a different person FluidAudio put in the cluster is rejected', () => {
    expect(reasons('Voice 5')).toHaveLength(1)
    expect(reasons('Voice 5')[0]).toMatch(/^\(c\) centroid 1\.\d{3} > p95 0\.\d{3}$/)
    expect(P.rejected.find(r => r.voice === 'Voice 5')?.wouldJoin).toBe('Voice 1')
  })

  it('never merges into or out of a named label, and reports it as a hint only', () => {
    expect(D.rows.has('Dana Fictional')).toBe(false)
    expect(D.rows.has('Ext')).toBe(false)
    expect([...D.remap.keys(), ...D.remap.values()].some(v => !isShadowVoiceLabel(v))).toBe(false)
    expect(P.accepted.find(a => a.cluster === 'S1')!.otherLabelsInCluster).toEqual([{ label: 'Dana Fictional', seconds: 3 }])
    expect(P.accepted.find(a => a.cluster === 'S4')!.otherLabelsInCluster).toEqual([{ label: 'Ext', seconds: 40 }])
    expect(P.frozenOtherLabels).toEqual(['Dana Fictional', 'Ext'])
  })

  it('the anchor ratio is reported, and it does NOT decide', () => {
    const v12 = P.accepted.find(a => a.cluster === 'S4')!.voices.find(m => m.voice === 'Voice 12')!
    expect(v12.anchorRatioPostHoc).toBeGreaterThan(SHADOW_GATES.anchorRatioPostHoc)
    expect(v12.eligible).toBe(true)
    expect(D.remap.get('Voice 12')).toBe('Voice 11')
  })

  it('lists voices no proposal touched, with the reason', () => {
    expect(P.untouched).toEqual([
      { voice: 'Voice 8', seconds: 30, why: 'the only voice on FluidAudio cluster S3' },
      { voice: 'Voice 9', seconds: 16, why: 'FluidAudio did not cover this voice' },
    ])
  })

  it('gives listen pointers by chunk and time, never transcript text or a path', () => {
    const v2 = P.accepted[0].voices.find(m => m.voice === 'Voice 2')!
    expect(v2.listen.length).toBeGreaterThan(0)
    for (const p of v2.listen) expect(Object.keys(p).sort()).toEqual(['callTime', 'chunkIndex', 'inFileEnd', 'inFileStart'])
  })
})

describe('speaker shadow decide(): input contract', () => {
  it('exact_overlap accounts for every sample, overlap counted once', () => {
    const index = new IntervalIndex(intervalSamples([{ start: 0, end: 2, speaker: 'S1' }, { start: 1, end: 3, speaker: 'S2' }], 4 * SR))
    expect([...exactOverlap(0, 4 * SR, index)]).toEqual([['S1', SR], ['S1\u0000S2', SR], ['S2', SR], ['', SR]])
  })

  it('refuses FluidAudio turns outside the audio, like common.py asserts', () => {
    expect(() => intervalSamples([{ start: 0, end: 5, speaker: 'S1' }], 4 * SR)).toThrow(/turn time/)
    expect(() => intervalSamples([{ start: 1, end: 1, speaker: 'S1' }], 4 * SR)).toThrow(/turn time/)
  })

  it('widens CLI times through float32 and clips the end to the audio', () => {
    const { turns, clipped, dropped } = nativeTurns([{ speakerId: 'S1', startTimeSeconds: 0.1, endTimeSeconds: 9 }, { speakerId: 'S2', startTimeSeconds: 8.5, endTimeSeconds: 8.5 }], 8)
    expect(turns).toEqual([{ start: Math.fround(0.1), end: 8, speaker: 'S1' }])
    // to_turns counts the clip before it drops the now-empty turn.
    expect([clipped, dropped]).toEqual([2, 1])
  })

  it('treats only Voice labels as mergeable', () => {
    expect(['Voice 3', 'Voice12', 'Ext', 'Dana Fictional', 'voice 3', 'Voice 3 '].map(isShadowVoiceLabel)).toEqual([true, true, false, false, false, false])
  })
})
