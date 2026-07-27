import { describe, expect, it } from 'vitest'
import { patchRecordingForG2Pipeline } from './g2-ops-handoff.js'

describe('patchRecordingForG2Pipeline', () => {
  it('rewrites standalone summaries into pipeline markers sync_meetings accepts', () => {
    const input = [
      '# G2 Recording',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Source** | G2 Glasses |',
      '',
      '## Summary',
      '',
      '*Standalone recording — canonical transcript shown in meeting detail.*',
      '',
      '## Transcript',
      '',
      '[MU]: hello',
      '',
    ].join('\n')

    const patched = patchRecordingForG2Pipeline(input)
    expect(patched).toContain('summary pending pipeline processing')
    expect(patched).toContain('g2-needs-domain-review')
    expect(patched).not.toContain('Standalone recording')
  })
})
