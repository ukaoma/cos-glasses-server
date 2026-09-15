/**
 * What may be used as VOICE EVIDENCE (6.47.0, WS5).
 *
 * A voice profile is built from audio this Mac captured. An imported meeting has
 * no audio at all — Fireflies sends text — and a derived record (a merge, or one
 * piece of a split) is a FUNCTION of other records rather than a recording. Its
 * speaker names came from the vendor's own diarization or from a voice match
 * suggestion, so training a profile on either would fold a cloud label back into
 * the local identity store and then present it as local evidence. That is the
 * one loop the speaker system must never close (CLAUDE.md: "Cloud speaker names
 * training voice profiles (never)").
 *
 * REFUSES BY ID KIND ONLY. The rule is a property of the identifier in hand:
 * an `imported:` or `blended:` record id, or an `.import.json` / `.derived.json`
 * evidence path. It is NOT a property of the underlying meeting. A G2 session
 * that happens to have a merged record derived from it is still a real capture
 * with real audio, and relabelling it is exactly how its profile gets better —
 * so this guard must never refuse a G2 session merely because derived records
 * exist. The plan states that explicitly, and the execution gate pins it.
 *
 * PURE. No filesystem, no lookups: a guard that has to read the disk to decide
 * fails open the moment the disk is slow, and this one runs before every voice
 * mutation.
 */

/** A record id that names an imported or derived record rather than a capture. */
export const IMPORTED_EVIDENCE_ID_PATTERN = /^(imported|blended):/

/** The two sidecars of the imported library. Never chunk audio, never `.g2-chunks.json`. */
export const IMPORTED_EVIDENCE_PATH_PATTERN = /\.(?:import|derived)\.json$/i

export type VoiceEvidenceReason = 'imported_read_only' | 'blended_derived_record'

export interface VoiceEvidenceRefusal {
  status: 409
  body: {
    error: string
    reason: VoiceEvidenceReason
    /** The exact value that was refused, so a caller can say which input failed. */
    source: string
  }
}

/** The kind of an id, or null when it names neither. */
export function importedEvidenceKind(value: unknown): 'imported' | 'blended' | null {
  if (typeof value !== 'string') return null
  const id = value.match(IMPORTED_EVIDENCE_ID_PATTERN)
  if (id) return id[1] as 'imported' | 'blended'
  // A path is only ever evidence of a derived record, so it refuses as `blended`
  // when it is a `.derived.json` and as `imported` when it is an `.import.json`.
  if (IMPORTED_EVIDENCE_PATH_PATTERN.test(value)) {
    return /\.derived\.json$/i.test(value) ? 'blended' : 'imported'
  }
  return null
}

export function isImportedVoiceEvidence(value: unknown): boolean {
  return importedEvidenceKind(value) !== null
}

/**
 * Refuse the first value that names an imported or derived record.
 *
 * Returns null when every value is acceptable, so a caller reads as
 * `const refusal = assertVoiceEvidenceSource([...]); if (refusal) ...`.
 */
export function assertVoiceEvidenceSource(values: ReadonlyArray<unknown>): VoiceEvidenceRefusal | null {
  for (const value of values) {
    const kind = importedEvidenceKind(value)
    if (!kind) continue
    return {
      status: 409,
      body: kind === 'imported'
        ? {
          error: 'Imported meetings carry no audio, so they cannot train or correct a voice',
          reason: 'imported_read_only',
          source: String(value),
        }
        : {
          error: 'This record was derived from other meetings. Open the recording it came from',
          reason: 'blended_derived_record',
          source: String(value),
        },
    }
  }
  return null
}
