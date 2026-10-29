// Shared by cached parity and native replay: execute the exact same assertions
// without requiring model inference to test the replay comparison itself.
import { expect } from 'vitest'
import { pyRound } from '../../speaker-shadow-numeric.js'
import { round3View } from './round3-view.js'

export function assertAnchorGateParity(report: any, historicalReport: any, gate: any, options: { listen?: boolean } = {}) {
  const actual = round3View(report, options)
  const historical = round3View(historicalReport, options)
  expect(report.productionVoices).toBe(gate.voiceBefore)
  expect(report.voicesAfter).toBe(gate.voiceAfter)
  expect(report.acceptedMerges).toBe(gate.accepted)
  expect(actual.accepted.map(({ cluster, keepLabel, merge }: any) => ({ cluster, keepLabel, merge })))
    .toEqual(gate.groups.filter((g: any) => g.mergedIntoAnchor.length).map((g: any) => ({ cluster: g.cluster, keepLabel: g.anchor, merge: g.mergedIntoAnchor })))
  const oldRows = [...historical.accepted.flatMap((g: any) => g.voices), ...historical.rejected]
  const rows = [...actual.accepted.flatMap((g: any) => g.voices), ...actual.rejected]
  expect(rows.map(v => v.voice).sort()).toEqual(oldRows.map(v => v.voice).sort())
  const oldVoices = new Map<string, any>(oldRows.map(v => [v.voice, v]))
  for (const v of rows) {
    const reference = gate.rows[v.voice]
    expect(reference).toBeDefined()
    expect(v.eligible).toBe(reference.eligible)
    expect(v.reasons.filter((r: string) => r !== 'no other voice on this cluster passed every gate')).toEqual(reference.reasons)
    // A newly ineligible cluster can lose its historical fallback anchor.
    expect(v.anchorRatioPostHoc).toEqual(reference.anchorRatio === null ? null : pyRound(reference.anchorRatio, 2))
    const old = oldVoices.get(v.voice)!
    for (const key of ['seconds', 'coveredFraction', 'topCluster', 'majority', 'outlierPass', 'outlierDistance', 'outlierP95', 'outlierNote', 'listen'] as const)
      expect(v[key]).toEqual(old[key])
  }
  expect(actual.untouched).toEqual(historical.untouched)
}
