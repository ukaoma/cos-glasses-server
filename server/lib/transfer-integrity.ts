// 6.88.0: transfer integrity counts what the phone captured, not only what the Mac heard of.
//
// WHAT HAPPENED. 2026-10-23 07:59, meeting t2xs9u (glasses 6.10.651). A relaunched COS window saved
// the meeting from the 74 chunks the Mac held while the window still recording it had captured
// through index 120. The saved file said "Transfer integrity 100%": the gap report only looks for
// holes in [0, highest index received], so 47 chunks the Mac never heard of did not count.
//
// THE RULE. When the phone has said how far it captured (the Stop's `finalChunkIndex`, or a save's
// own `finalChunkIndex`, glasses 6.10.652), the expected count is that index plus one, and every
// index from the Mac's highest received chunk to it is missing. 74 of 121 reads 61.1%.
//
// And a phone's ORIGIN-WIPE RECOVERY save (`recovery: 'origin_wipe'`, glasses 6.10.652) is refused
// with 409 `chunks_outstanding` while the phone has said it captured chunks the Mac does not hold,
// unless it says it waited them out (`acceptMissing: true`). The phone checks the same thing before
// it asks; this closes the moment between its status read and its save (a Stop landing in between).
// A save without `recovery` is never refused here: every existing caller behaves as before.

import type { TranscriptGapReport } from '../routes/transcribe-stream.js'

/** The stop route's own bound on a final index. */
export const PHONE_FINAL_INDEX_LIMIT = 1_000_000
/** A phone-said index this far past the Mac's highest chunk is capped (about 30 hours of 6 s chunks),
 *  so one bad number cannot write a huge missing list into the sidecar. */
export const PHONE_FINAL_INDEX_MAX_AHEAD = 20_000

/** A final index as the stop route accepts it (a whole number, -1 or more), else null. */
export function parsePhoneFinalChunkIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= PHONE_FINAL_INDEX_LIMIT ? value : null
}

/** The highest index any phone window said it captured, or null when none said. */
export function phoneFinalChunkIndex(...said: Array<number | null | undefined>): number | null {
  const known = said.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0)
  return known.length > 0 ? Math.max(...known) : null
}

/** The gap report with the phone's final index counted. Unchanged when the phone said nothing new. */
export function withPhoneFinalIndex(report: TranscriptGapReport | null, phoneFinal: number | null): TranscriptGapReport | null {
  if (!report || phoneFinal === null || phoneFinal <= report.maxIndex) return report
  const final = Math.min(phoneFinal, Math.max(report.maxIndex, 0) + PHONE_FINAL_INDEX_MAX_AHEAD)
  const missingIndices = [...report.missingIndices]
  for (let index = report.maxIndex + 1; index <= final; index++) missingIndices.push(index)
  const expected = final + 1
  return {
    ...report,
    maxIndex: final,
    expected,
    missingIndices,
    completeness: expected > 0 ? report.received / expected : 1,
  }
}

/** Chunks in [0, phoneFinal] the Mac does not hold. */
export function chunksOutstanding(report: TranscriptGapReport | null, phoneFinal: number | null): number {
  if (phoneFinal === null) return 0
  const counted = withPhoneFinalIndex(report, phoneFinal)
  if (!counted) return phoneFinal + 1
  return counted.missingIndices.filter(index => index <= phoneFinal).length
}
