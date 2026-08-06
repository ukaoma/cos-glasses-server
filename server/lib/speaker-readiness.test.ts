// /api/health asserts the speaker subsystem rather than only reporting it.
//
// The load-bearing asymmetry is that 'unavailable' must NOT degrade. Getting it
// wrong in either direction defeats the purpose: degrade on 'unavailable' and
// every public install (the model ships outside the tarball) reads degraded
// forever, so the operator learns to ignore the field; don't degrade on 'error'
// and a rejected model stays invisible behind a green status, which is how 78
// trained profiles went unnoticed as missing across a managed cutover.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// data-dir.ts mkdirs DATA_DIR at import, so redirect it before importing.
process.env.COS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cos-speaker-readiness-'))
const { speakerReadiness } = await import('./speaker-embeddings.js')

describe('speaker readiness verdict', () => {
  it('degrades when a model is installed and the runtime rejected it', () => {
    expect(speakerReadiness('error')).toBe('degraded')
  })

  it('does NOT degrade when no model is configured — that is the shipped default', () => {
    expect(speakerReadiness('unavailable')).toBe('unavailable')
    expect(speakerReadiness('unavailable')).not.toBe('degraded')
  })

  it('is ready when diarization is actually running', () => {
    expect(speakerReadiness('active')).toBe('ready')
  })

  it('maps every state to a distinct verdict', () => {
    const verdicts = (['active', 'unavailable', 'error'] as const).map(speakerReadiness)
    expect(new Set(verdicts).size).toBe(3)
  })
})
