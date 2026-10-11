import type { AskInput } from './live-cos-ask.js'
import { getSessionAudioDirectory, getSessionAsrCompletedIndices, getSessionChunkEntries } from '../routes/transcribe-stream.js'
import { readProgressiveAskRefinements } from './meeting-batch-transcribe.js'
import { meetingAskTranscript } from './meeting-ask-transcript.js'

/** Apply at request admission: current Control sends its live feed directly,
 * rather than calling /meeting-ask/transcript. Freeze the improved evidence
 * once; retries continue to fingerprint the original submitted request. */
export function refineActiveMeetingAsk(input: AskInput): { input: AskInput; notices: string[] } {
  if (process.env.COS_MEETING_ASK_HQ_EVIDENCE !== '1') return { input, notices: [] }
  try {
    const root = getSessionAudioDirectory(input.sessionId)
    const canonical = getSessionChunkEntries(input.sessionId)
    if (!root || !canonical) return { input, notices: [] }
    const entries = canonical.filter(e => e.chunk.elapsed <= input.elapsedMs)
    const refined = readProgressiveAskRefinements(root, input.sessionId, entries, getSessionAsrCompletedIndices(input.sessionId))
      .filter(result => result.segment.endElapsed <= input.elapsedMs)
    const submitted = input.turns.map(turn => ({ chunkIndex: turn.id, chunk: {
      text: turn.text, speaker: turn.speaker, elapsed: turn.elapsedMs, similarity: 0,
    } }))
    const snapshot = meetingAskTranscript(submitted, refined)
    return { input: { ...input, turns: snapshot.turns }, notices: snapshot.notices }
  } catch {
    return { input, notices: ['Refined passages are unavailable; this answer uses the live transcript.'] }
  }
}
