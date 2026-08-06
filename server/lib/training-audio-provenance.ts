// Tracing a stored voice sample back to the meeting that produced it.
//
// WHY THIS IS NEEDED. De-attribution has to undo more than a label. When a voice
// is falsely attributed to someone, the identifier may ALSO have auto-enrolled
// those segments into that person's profile — so the wrong voice is now part of
// what the system thinks they sound like, and it will keep matching. Removing the
// label without removing the samples fixes the transcript and leaves the profile
// poisoned. That is the mechanism behind the phantom "Erick Hernandez": three
// mislabelled seeds compounded to eighteen samples through self-training.
//
// WHAT CAN AND CANNOT BE TRACED. Provenance strings differ in whether they name
// a session:
//
//   auto:<sessionId>           traceable — autoEnroll stamps it
//   correction:<sessionId>     traceable — the relabel ledger stamps it
//   g2-training:<sessionId>    traceable ONLY from 2026-08-06 onward (see below)
//   g2-training                NOT traceable — every sample written before that
//   fireflies / manual / …     NOT traceable — no session concept
//
// `train-g2` used to stamp a bare `g2-training`, discarding which meeting each
// sample came from even though the source WAV filename carries it
// (`meeting_1785190805524_uzxmn4_chunk327_sim0.57.wav`). Samples written before
// the stamp landed cannot be retracted per-meeting, and de-attribution reports
// that count rather than implying a clean sweep.

/** Session id embedded in a training-audio WAV name, or null if absent. */
export function sessionIdFromTrainingWav(filename: string): string | null {
  // Session ids contain underscores (`meeting_1785190805524_uzxmn4`), so the
  // split has to be on the `_chunk` marker, not on the last underscore.
  const at = filename.indexOf('_chunk')
  if (at <= 0) return null
  const id = filename.slice(0, at)
  return /^[A-Za-z0-9:_-]{3,96}$/.test(id) ? id : null
}

/** Provenance to record for a sample trained out of `filename`. */
export function trainingSourceFor(filename: string): string {
  const id = sessionIdFromTrainingWav(filename)
  return id ? `g2-training:${id}` : 'g2-training'
}

/**
 * Did this stored sample come from `sessionId`?
 *
 * Exact match on the session part — a prefix test would let
 * `auto:meeting_123_extra` match session `meeting_123` and retract a different
 * meeting's evidence.
 */
export function isSampleFromSession(source: string | undefined | null, sessionId: string): boolean {
  const s = String(source ?? '')
  if (!sessionId) return false
  for (const prefix of ['auto:', 'correction:', 'g2-training:']) {
    if (s.startsWith(prefix) && s.slice(prefix.length) === sessionId) return true
  }
  return false
}

/**
 * Samples that belong to this speaker but cannot be tied to any meeting.
 *
 * Reported so a de-attribution is honest about its reach: "retracted 4, and 9
 * older samples cannot be traced to a meeting" is actionable, while silence
 * implies the profile was fully cleaned.
 */
export function untraceableSampleCount(sources: Array<string | undefined | null>): number {
  return sources.filter(s => {
    const str = String(s ?? '')
    return !str.includes(':')
  }).length
}
