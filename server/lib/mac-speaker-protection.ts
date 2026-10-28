/** One conservative predicate for automatic acoustic support and label writes.
 * Human markers protect even still-anonymous labels and unlabeled ASR words. */
export function isMacSpeakerHumanProtected(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (['speakerCorrectionBatchId', 'speakerCorrectionId', 'manualSpeaker', 'speakerManuallyAssigned', 'confirmedByHuman', 'manuallyAssigned', 'manuallyCorrected'].some(key => !!row[key])) return true
  return ['speakerOrigin', 'speakerSource', 'speakerPolicy', 'speakerProvenance', 'source'].some(key =>
    typeof row[key] === 'string' && /(?:manual|human|correction|confirmed)/i.test(row[key] as string))
}
/** Inspect every stored chunk representation before using any of its audio as
 * positive evidence. Malformed declared surfaces also fail closed. */
export function hasMacSpeakerProtectedRows(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const chunk = value as Record<string, unknown>
  if (isMacSpeakerHumanProtected(chunk)) return true
  for (const key of ['segments', 'finalSegments', 'words']) {
    if (chunk[key] === undefined) continue
    if (!Array.isArray(chunk[key])) return true
    if ((chunk[key] as unknown[]).some(row => !row || typeof row !== 'object' || isMacSpeakerHumanProtected(row))) return true
  }
  return false
}
