// The voice evidence guard as a predicate (6.47.0, WS5).
//
// The route-level execution test proves the six call sites refuse. This proves
// the RULE, including the half that is easy to lose: the guard refuses by id
// kind, and a real G2 session is never refused merely because derived records
// exist. A guard that grew into "anything touched by a merge" would quietly turn
// off voice correction for every meeting that had ever been merged.

import { describe, expect, it } from 'vitest'
import {
  assertVoiceEvidenceSource,
  importedEvidenceKind,
  isImportedVoiceEvidence,
} from './voice-evidence-guard.js'

describe('voice evidence guard', () => {
  it('names the kind of an imported or derived id', () => {
    expect(importedEvidenceKind('imported:fireflies:00112233445566aa')).toBe('imported')
    expect(importedEvidenceKind('blended:00112233445566aa')).toBe('blended')
  })

  it('refuses the two sidecars of the imported library by path', () => {
    // The evidence files of a record with no audio. Never `.g2-chunks.json`,
    // which IS capture evidence.
    expect(importedEvidenceKind('/data/imports/2026-09/2026-09-10_fireflies_00112233445566aa.import.json')).toBe('imported')
    expect(importedEvidenceKind('/data/imports/2026-09/2026-09-10_merged_00112233445566aa.derived.json')).toBe('blended')
    expect(isImportedVoiceEvidence('/data/recordings/2026-09/2026-09-10_Call.g2-chunks.json')).toBe(false)
  })

  it('never refuses a capture, whatever has been derived from it', () => {
    for (const value of [
      'meeting_1758043200_abc',
      'auto:meeting_1758043200_abc',
      'standalone:meeting_1758043200_abc',
      'ops:personal:2026-09:2026-09-10_Launch_Review.md',
      'direct:2026-09:2026-09-10_Launch_Review.md',
      undefined,
      null,
      42,
    ]) {
      expect(isImportedVoiceEvidence(value), String(value)).toBe(false)
      expect(assertVoiceEvidenceSource([value])).toBeNull()
    }
  })

  it('refuses the first offending value and says which it was', () => {
    const refusal = assertVoiceEvidenceSource(['meeting_ok', 'blended:00112233445566aa', 'imported:fireflies:00112233445566aa'])
    expect(refusal?.status).toBe(409)
    expect(refusal?.body.reason).toBe('blended_derived_record')
    expect(refusal?.body.source).toBe('blended:00112233445566aa')
    // Plain words, no arrows or em dashes: this text reaches a person in Control.
    expect(refusal?.body.error).not.toMatch(/[—→]/)
  })

  it('returns null for an empty list rather than refusing by default', () => {
    expect(assertVoiceEvidenceSource([])).toBeNull()
  })
})
