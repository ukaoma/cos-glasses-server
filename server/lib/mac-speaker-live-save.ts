/** Pure bridge from qualified live evidence to the existing closed-file repair
 * contract. No IO, inference, enrollment, or implied authorization to write.
 * Caller must verify current audio/model/profile/ledger bytes and journal all
 * files before applying the returned receipt. */
import { refreshMacSpeakerLiveState, replayMacSpeakerLiveEvidence, validateMacSpeakerLiveState, hashMacSpeakerLive, type MacSpeakerLiveState } from './mac-speaker-live-memory.js'
import { projectMacSpeakerLiveChunks, type MacSpeakerLiveSourceChunk } from './mac-speaker-live-projection.js'
import { normalizedSpeakerCosine, type MacSpeakerProfile } from './mac-speaker-reconcile.js'
import { hashMacSpeakerDocument, projectMacSpeakerRepair, type MacProfileMatchEvidence, type MacSpeakerRepairAssignment, type MacSpeakerRepairPlan, type MacSpeakerWordBinding } from './mac-speaker-repair-projection.js'
type Doc = Record<string, any>
const refuse = (why: string): never => { throw Error(`Mac live save: ${why}`) }
const MAX_RAW = 8192
/** Verified PCM counts include silent originals, because saved batch word
 * clocks concatenate audio files rather than using capture elapsed time. */
export function planMacSpeakerLiveSave(input: {
  doc: Doc; state: MacSpeakerLiveState; profiles: readonly MacSpeakerProfile[]
  rawAudioSampleCounts: Record<string, number>; correctionHistoryClear: boolean
}): MacSpeakerRepairPlan {
  const { doc, state, profiles, rawAudioSampleCounts: counts } = input
  validateMacSpeakerLiveState(state)
  if (!input.correctionHistoryClear || state.withheldReason || doc.sessionId !== state.captureId
    || doc.finalizationState !== 'complete' || doc.sourceType !== 'mac_system_audio'
    || doc.speakerRepair || (doc.correctionRevision ?? 0) !== 0 || doc.batchApplied !== true
    || !Array.isArray(doc.chunkEntries) || !Array.isArray(doc.batchSegments)
    || doc.chunkEntries.length > MAX_RAW || !doc.batchSegments.length) refuse('ineligible source or human history')
  // An unkeyed integrity hash cannot authenticate caller-supplied membership.
  // Rebuild membership from each source receipt; namespace reservation only
  // affects presentation labels, not acoustic memory or receipt assignment.
  const rebuilt = replayMacSpeakerLiveEvidence({ captureId: state.captureId, generation: state.generation,
    modelSHA256: state.modelSHA256, profileSHA256: state.profileSHA256, evidence: state.evidence, profiles })
  if (hashMacSpeakerLive(rebuilt.memory) !== hashMacSpeakerLive(state.memory)
    || hashMacSpeakerLive(rebuilt.evidence.map(e => e.cohortId ?? null)) !== hashMacSpeakerLive(state.evidence.map(e => e.cohortId ?? null))) refuse('unverified receipt membership')
  // Recompute the complete overlay against the frozen full profile cohort.
  const replay = refreshMacSpeakerLiveState(state, profiles)
  if (hashMacSpeakerLive(replay.projections) !== hashMacSpeakerLive(state.projections)) refuse('stale identity or profile claims')
  const indexed = doc.chunkEntries.filter((e: Doc) => e.chunk?.text).map((e: Doc) => ({ i: e.chunkIndex, c: e.chunk as MacSpeakerLiveSourceChunk }))
  const projection = projectMacSpeakerLiveChunks({ captureId: state.captureId, generation: state.generation, chunksIndexed: indexed, projections: state.projections })
  if (projection.withheld.length || projection.appliedRawChunkIndices.length !== state.projections.length) refuse('saved originals changed or became protected')
  const current = new Map<number, Doc>(doc.chunkEntries.map((e: Doc) => [e.chunkIndex, e.chunk]))
  const centroids = profiles.map(p => ({ name: p.name, embedding: Array.from({ length: 192 }, (_, i) => p.embeddings.reduce((sum, v) => sum + v[i] / p.embeddings.length, 0)) }))
  const proofs = new Map<string, MacProfileMatchEvidence>()
  for (const span of state.projections) if (span.profileName && !proofs.has(span.identityId)) {
    const identity = state.identities.find(i => i.identityId === span.identityId)!
    const group = state.evidence.filter(e => e.cohortId === identity.cohortId)
    const target = centroids.find(p => p.name === span.profileName) ?? refuse('profile missing')
    proofs.set(span.identityId, {
      kind: 'profile-match', profileName: span.profileName, profileSha256: state.profileSHA256,
      modelSha256: state.modelSHA256, algorithmVersion: 'mac-native-live-v1',
      crossWindowCosines: group.map(a => group.map(b => normalizedSpeakerCosine(a.receipt.embedding, b.receipt.embedding)!)),
      windows: group.map(e => ({ id: e.window.id, captureStartSample: e.window.startSample, captureEndSample: e.window.endSample,
        pcmSha256: e.receipt.pcmSHA256, similarity: normalizedSpeakerCosine(e.receipt.embedding, target.embedding)!,
        runnerUpSimilarity: Math.max(-1, ...centroids.filter(p => p !== target).map(p => normalizedSpeakerCosine(e.receipt.embedding, p.embedding)!)),
        rawChunks: e.window.sources.map(s => ({ rawChunkIndex: s.chunkIndex, audioSha256: s.audioSHA256, sampleCount: s.sampleCount })) })),
    })
  }
  const assignments: MacSpeakerRepairAssignment[] = state.projections.flatMap(span => {
    const original = current.get(span.rawChunkIndex) ?? refuse('missing original')
    if (original.speaker === span.displayLabel) return []
    return [{ rawChunkIndex: span.rawChunkIndex, from: original.speaker, to: span.displayLabel,
      evidenceId: span.identityId, batchWords: [], ...(span.profileName ? { targetEvidence: proofs.get(span.identityId)! } : {}) }]
  })
  if (!assignments.length) refuse('no qualified label changes')
  const selected = new Map(assignments.map(a => [a.rawChunkIndex, a]))
  const withheldBatchWords: Array<MacSpeakerWordBinding & { reason: 'outside-qualified-span' }> = []
  doc.batchSegments.forEach((segment: Doc, segmentIndex: number) => {
    if (!Number.isSafeInteger(segment.startChunkIdx) || !Number.isSafeInteger(segment.endChunkIdx)
      || segment.startChunkIdx < 0 || segment.endChunkIdx < segment.startChunkIdx
      || segment.endChunkIdx - segment.startChunkIdx >= MAX_RAW || !Array.isArray(segment.speakerWords)) refuse('invalid batch geometry')
    const ranges: Array<{ raw: number; start: number; end: number }> = []; let at = 0
    for (let raw = segment.startChunkIdx; raw <= segment.endChunkIdx; raw++) {
      const n = counts[String(raw)]
      if (!Number.isSafeInteger(n) || n <= 0 || n > 480000) refuse('unverified batch PCM clock')
      ranges.push({ raw, start: at, end: at + n / 16000 }); at += n / 16000
    }
    segment.speakerWords.forEach((word: Doc, wordIndex: number) => {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > at) refuse('invalid batch word clock')
      const overlapping = ranges.filter(r => word.start === word.end ? word.start >= r.start && word.start < r.end : word.start < r.end && word.end > r.start)
      if (!overlapping.some(r => selected.has(r.raw))) return
      const binding = { segmentIndex, wordIndex, from: word.speaker, word: word.word, start: word.start, end: word.end }
      if (overlapping.some(r => !selected.has(r.raw))) withheldBatchWords.push({ ...binding, reason: 'outside-qualified-span' })
      else if (new Set(overlapping.map(r => selected.get(r.raw)!.to)).size !== 1) refuse('word crosses two identities')
      else selected.get(overlapping[0].raw)!.batchWords.push(binding)
    })
  })
  const plan: MacSpeakerRepairPlan = { id: `live_${state.stateSHA256.slice(0, 24)}`, evidenceHash: state.stateSHA256,
    expectedDocumentHash: hashMacSpeakerDocument(doc), protectedRawChunkIndices: [], rawAudioSampleCounts: counts, assignments, withheldBatchWords }
  // Exercise all existing named-evidence and exact word/time protection gates
  // here; callers cannot accidentally treat plan construction as qualification.
  projectMacSpeakerRepair(doc, plan)
  return plan
}
