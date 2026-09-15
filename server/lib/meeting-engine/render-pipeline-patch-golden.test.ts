/**
 * The committed pipeline-patch golden (QA round 2, blocker 7).
 *
 * WHY THIS EXISTS. `renderPipelinePatch` produces the only server bytes that land in a
 * person's permanent operations tree, and the COS pipeline validates against a fixture
 * generated from it. Every other test here asserts a PROPERTY of the patch: it contains a
 * section, a row, a marker. None of them can see a change that keeps every property and moves
 * the bytes, which is exactly the class the em dash in the capture heading belonged to. This
 * one regenerates the whole patch and compares it byte for byte.
 *
 * WHEN IT FAILS. Either the change is wrong, or it is a deliberate output change and the
 * golden is regenerated with it IN THE SAME COMMIT, from
 * `__fixtures__/pipeline-patch-golden.ts --write`. The pipeline's copy of this fixture must
 * be regenerated from the same sha.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GOLDEN_PATCH_PATH, renderGoldenPatchBytesPinned } from './__fixtures__/pipeline-patch-golden.js'

describe('the committed pipeline patch golden', () => {
  it('matches the renderer byte for byte', () => {
    expect(renderGoldenPatchBytesPinned()).toBe(readFileSync(GOLDEN_PATCH_PATH, 'utf8'))
  })

  it('is a patch worth pinning, not an empty object', () => {
    // A golden that regenerated to `{}` would pass the comparison above forever. These
    // assertions are what make the comparison mean "the renderer still emits a real patch".
    const golden = JSON.parse(readFileSync(GOLDEN_PATCH_PATH, 'utf8')) as {
      sections: string[]
      rows: string[]
      markers: string[]
      speakerMap: Record<string, unknown>
      verification: unknown[]
    }
    expect(golden.sections.join('\n')).toContain('## G2 Capture')
    expect(golden.sections.join('\n')).toContain('## Alternate Transcript')
    expect(golden.rows).toHaveLength(2)
    expect(golden.markers).toContain('<!-- g2-transcript-blended -->')
    expect(golden.markers.some(marker => marker.startsWith('<!-- g2-source: '))).toBe(true)
    expect(golden.markers.some(marker => marker.startsWith('<!-- g2-session: '))).toBe(true)
    expect(golden.markers.some(marker => marker.startsWith('<!-- merge-action: '))).toBe(true)
    expect(Object.keys(golden.speakerMap)).toHaveLength(1)
    expect(golden.verification).toHaveLength(1)
  })

  it('carries the capture heading the pipeline splices, in its dash-free form', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATCH_PATH, 'utf8')) as { sections: string[] }
    expect(golden.sections.join('\n')).toContain('### Capture 1, 15:00, 30 min')
  })
})
