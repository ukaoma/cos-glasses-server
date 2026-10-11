import type { AskTurn } from './live-cos-ask.js'
import type { IndexedTranscriptChunk } from '../routes/transcribe-stream.js'
import type { BatchResult } from './batch-transcript-quality.js'
import { redactSecrets } from './lens-gist-engines.js'

/** Build one immutable Ask snapshot. Refined text replaces only a sealed range;
 * recent chunks remain present. Source turn IDs use original chunk indices.
 * Mixed speakers keep an unknown label rather than invent word attribution. */
export function meetingAskTranscript(
  entries: readonly IndexedTranscriptChunk[],
  refinements: readonly BatchResult[] = [],
): { turns: AskTurn[]; notices: string[] } {
  const turns: AskTurn[] = []
  const covered = new Set<number>()
  let used = 0
  for (const refinement of refinements) {
    const segment = refinement.segment
    const originals = entries.filter(e => e.chunkIndex >= segment.startChunkIdx && e.chunkIndex <= segment.endChunkIdx)
    if (!refinement.text.trim() || !originals.length
      || originals.some(e => covered.has(e.chunkIndex))
      || originals[0].chunkIndex !== segment.startChunkIdx
      || originals.at(-1)!.chunkIndex !== segment.endChunkIdx) continue
    const speakers = new Set(originals.filter(e => e.chunk.text.trim()).map(e => e.chunk.speaker))
    turns.push({ id: segment.startChunkIdx, elapsedMs: Math.max(0, segment.startElapsed),
      speaker: speakers.size === 1 ? [...speakers][0] : 'Unidentified',
      text: redactSecrets(refinement.text) })
    for (const original of originals) covered.add(original.chunkIndex)
    used++
  }
  for (const entry of entries) {
    if (!covered.has(entry.chunkIndex) && entry.chunk.text.trim()) turns.push({
      id: entry.chunkIndex, elapsedMs: Math.max(0, entry.chunk.elapsed),
      speaker: entry.chunk.speaker, text: redactSecrets(entry.chunk.text),
    })
  }
  turns.sort((a, b) => a.elapsedMs - b.elapsedMs || a.id - b.id)
  return { turns, notices: used ? [
    'Earlier passages were refined from recorded audio; recent speech still uses the live transcript. Speaker identity is withheld on passages containing multiple voices.',
  ] : [] }
}
