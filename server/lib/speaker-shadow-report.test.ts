import { describe, expect, it } from 'vitest'
import { buildShadowProposals, decide, nativeTurns } from './speaker-shadow-decide.js'
import { renderShadowReport, renderShadowRunFacts, renderShadowSkipReport, shadowReportRelativePath, shadowVoiceRow } from './speaker-shadow-report.js'
import { SR, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative, syntheticSegments } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const segs = syntheticSegments()
const { turns } = nativeTurns(syntheticNative().segments, SYNTHETIC_SECONDS)
const D = decide(segs, SYNTHETIC_SECONDS * SR, turns, syntheticEmbeddings())
const sources = segs.map(([lo, hi]) => ({ chunkIndex: Math.floor(lo / SR / 10), start: (lo / SR) % 10, end: (hi - Math.floor(lo / SR / 10) * 10 * SR) / SR, abs: lo / SR }))
const P = buildShadowProposals(D, segs, sources, turns)
const facts = { minutes: 5.7, originals: 34, verifiedAgainstSidecar: 34, unhashedOriginals: 0, unhashedWithText: [], humanProtectedVoices: [] as string[] }
const md = renderShadowReport({ title: 'Avery and Blake sync', sessionId: 'mac_x', proposals: P, facts, audioDir: '/data/meeting-audio/mac_x', chunkText: new Map([[4, '  Avery said the launch moves to Tuesday.  '], [0, 'x'.repeat(200)]]) })

describe('speaker shadow report (round3/propose.py render)', () => {
  it('leads with what would change, and says nothing was applied', () => {
    expect(md.split('\n').slice(0, 3)).toEqual(['# Avery and Blake sync', '', '**13 voices would become 9.** FluidAudio proposed 8 merges; 4 pass every gate, 4 do not. Shadow mode only: nothing was renamed or written.'])
  })

  it('lists each accepted merge with its gate rows and listen pointers (file, time, text)', () => {
    expect(md).toContain('### S2: merge Voice 10 into **Voice 3**')
    expect(md).toMatch(/\| Voice 10 \| 16\.0 s \| 100% \| S2 1\.00 \| outlier \d\.\d{3} ≤ p95 \d\.\d{3} \| \d\.\d{2}x \|/)
    expect(md).toContain('  - Voice 2: `/data/meeting-audio/mac_x/chunk_0004.wav` 0.0 to 10.0 s (call time 0:40) "Avery said the launch moves to Tuesday."')
    expect(md).toContain(`"${'x'.repeat(140)}"`)
  })

  it('names the labels sharing a group as a hint, in the words Miles asked for', () => {
    expect(md).toContain('Caution: this group also holds 3 s labelled Dana Fictional. Those labels stay as they are.')
    expect(md).toContain('Caution: this group also holds 40 s labelled Ext. Those labels stay as they are.')
  })

  it('lists rejections with reasons, and untouched voices', () => {
    expect(md).toContain('- **Voice 4** would have joined Voice 3 on S2. Rejected: (b) 10.0 s < 15 s.')
    expect(md).toContain('- **Voice 7** would have joined Voice 3 on S2. Rejected: (a) covered 0.40 < 0.50.')
    expect(md).toContain('- Voice 8 (30.0 s): the only voice on FluidAudio cluster S3.')
    expect(md).toContain('- Voice 9 (16.0 s): FluidAudio did not cover this voice.')
  })

  it('flags voices a person already corrected', () => {
    const touched = renderShadowReport({ title: 't', sessionId: 's', proposals: P, facts: { ...facts, humanProtectedVoices: ['Voice 2'] }, audioDir: '/a', chunkText: new Map() })
    expect(touched).toContain('- A person already edited chunks holding Voice 2. Those edits outrank any proposal here.')
    expect(touched).toContain("Human edit: Voice 2 carries a person's correction on some chunks.")
  })

  it('formats a voice row like fmt_voice', () => {
    const base = { voice: 'Voice 1', seconds: 22, coveredFraction: 0.995, topCluster: 'S1', majority: 0.825, outlierPass: true, outlierDistance: 0.0125, outlierP95: 0.5, outlierNote: null, anchorRatioPostHoc: 1.5, eligible: true, reasons: [], listen: [] }
    expect(shadowVoiceRow(base)).toBe('| Voice 1 | 22.0 s | 100% | S1 0.82 | outlier 0.013 ≤ p95 0.500 | 1.50x |')
    expect(shadowVoiceRow({ ...base, outlierPass: false, anchorRatioPostHoc: 1.51 })).toBe('| Voice 1 | 22.0 s | 100% | S1 0.82 | outlier 0.013 > p95 0.500 | 1.51x (above 1.5x) |')
    expect(shadowVoiceRow({ ...base, outlierPass: false, outlierDistance: null, outlierP95: null, outlierNote: 'insufficient embeddings (fragment 1, others 9)', anchorRatioPostHoc: null }))
      .toBe('| Voice 1 | 22.0 s | 100% | S1 0.82 | outlier: insufficient embeddings (fragment 1, others 9) | — |')
  })

  it('writes a short page for a meeting with no proposals', () => {
    expect(renderShadowSkipReport({ title: 'T', sessionId: 'mac_x', status: 'skipped', reason: 'models_missing', detail: 'the pinned models are not on this Mac' }))
      .toBe('# T\n\n**No proposals: skipped** (`models_missing`). the pinned models are not on this Mac\n\n- Session `mac_x`. Shadow mode only: nothing was renamed or written.\n')
  })

  it('appends the run facts', () => {
    const f = renderShadowRunFacts({ rebuildMs: 455, nativeMs: 19225, wallMs: 20314, peakRssBytes: 1146 * 1048576, osTempDirsLeft: 0, sidecarPath: '/r/x.g2-chunks.json', pcmSHA256: '00820c132219d685', cliTrust: 'developer-id' })
    expect(f).toContain('- Rebuild 0.5 s, diarization 19.2 s, total 20.3 s. Peak memory 1146 MB.')
    expect(f).toContain('fluidaudiocli trust: developer-id. Network denied by sandbox-exec.')
  })

  it('files the report by meeting day and a safe title stem, with the whole session id', () => {
    expect(shadowReportRelativePath('Bottle 2027: Retention & Pólya / plan', 'mac_620cbd5f-1bcd-497e-84d3-dc0a1314f5fc', '2026-10-28'))
      .toBe('reports/2026-10-28/Bottle_2027_Retention_Polya_plan__mac_620cbd5f-1bcd-497e-84d3-dc0a1314f5fc.md')
    expect(shadowReportRelativePath('../../etc', 'mac_a', '../x')).toBe('reports/undated/etc__mac_a.md')
    expect(shadowReportRelativePath('', 'mac_a', '2026-10-29')).toBe('reports/2026-10-29/Mac_recording__mac_a.md')
  })
})
