/** Read-only bridge from a labels-only repair receipt to scoped machine claims.
 * Capture similarities, human confirmations and profile training are untouched.
 * Persisted bytes are trusted only after current speech/raw-map/receipt checks.
 */
import {
  hashMacSpeakerDocument, hashMacSpeakerMachineBinding, validateMacSpeakerTargetEvidence,
  type MacSpeakerMachineEvidence, type MacSpeakerRepairPlan,
} from './mac-speaker-repair-projection.js'
import { checkSpeakerName } from './speaker-name.js'
type Doc = Record<string, any>
const SHA = /^[a-f0-9]{64}$/
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function refuse(reason: string): never { throw new Error(reason) }
export interface QualifiedMachinePosition {
  label: string
  rawChunkIndex: number
  evidenceId: string
  receiptHash: string
  modelSHA256: string
  profileSHA256: string
  algorithmVersion: string
  independentWindows: number
  minimumSimilarity: number
  minimumMargin: number
}
export interface MacMachineEvidenceRead {
  status: 'absent' | 'qualified' | 'invalid'
  reason?: string
  /** Compacted positions, obtained by the strict raw join below. Never guess
   * positions from raw indexes, text similarity or repeated phrases. */
  positions: Map<number, QualifiedMachinePosition>
}
export function readMacSpeakerMachineEvidence(value: unknown): MacMachineEvidenceRead {
  const positions = new Map<number, QualifiedMachinePosition>()
  const doc = value as Doc | null
  const evidence = doc?.speakerRepair?.machineEvidence as MacSpeakerMachineEvidence | undefined
  if (!evidence) return { status: 'absent', positions }
  try {
    if (!doc || doc.sourceType !== 'mac_system_audio' || typeof doc.sessionId !== 'string' || !doc.sessionId.startsWith('mac_')
      || doc.finalizationState !== 'complete' || doc.claimPending === true || doc.active === true || doc.isActive === true || doc.isMerged || doc.mergedFrom || doc.sourceSessionIds) refuse('source_not_closed_original')
    // Deliberately global: any later human revision invalidates all machine
    // claims until requalification. Real ledger confirmations still prevail.
    if (evidence.version !== 1 || !uint(evidence.correctionRevision) || evidence.correctionRevision < 1 || doc.correctionRevision !== evidence.correctionRevision) refuse('revision_drift')
    if (!SHA.test(evidence.documentBinding) || hashMacSpeakerMachineBinding(doc) !== evidence.documentBinding) refuse('speech_binding_mismatch')
    const receipt = evidence.receipt
    if (!receipt || receipt.version !== 1 || !SHA.test(receipt.receiptHash) || receipt.id !== doc.speakerRepair.id || receipt.evidenceHash !== doc.speakerRepair.evidenceHash
      || !SHA.test(receipt.evidenceHash) || !Array.isArray(receipt.assignments) || !receipt.assignments.length || receipt.assignments.length > 65536
      || !Array.isArray(receipt.patches) || receipt.patches.length > 1_000_000) refuse('receipt_invalid')
    const { receiptHash, ...unsigned } = receipt
    if (hashMacSpeakerDocument(unsigned) !== receiptHash) refuse('receipt_invalid')
    if (!Array.isArray(doc.chunks) || !Array.isArray(doc.chunkEntries) || doc.chunks.length > 65536 || doc.chunkEntries.length > 65536) refuse('raw_map_ambiguous')
    const byRaw = new Map<number, { position: number; chunk: Doc }>()
    let position = 0, previous = -1
    for (const entry of doc.chunkEntries) {
      if (!entry || !uint(entry.chunkIndex) || entry.chunkIndex <= previous) refuse('raw_map_ambiguous')
      previous = entry.chunkIndex
      if (typeof entry.chunk?.text !== 'string' || !entry.chunk.text.trim()) continue
      const chunk = doc.chunks[position]
      if (!chunk || ['text', 'speaker', 'elapsed', 'audioDurationMs', 'audioSha256', 'segments', 'finalSegments', 'words'].some(key => !equal(chunk[key], entry.chunk[key]))) refuse('raw_map_ambiguous')
      byRaw.set(entry.chunkIndex, { position, chunk }); position++
    }
    if (position !== doc.chunks.length) refuse('raw_map_ambiguous')
    const source = structuredClone(doc)
    // Reconstruct only the original label surfaces from the validated receipt.
    // Lifecycle/prose/profile metadata are never inverse-applied by this reader.
    const paths = new Set<string>()
    for (const patch of [...receipt.patches].reverse()) {
      if (!Array.isArray(patch.path) || !patch.path.length || patch.path.length > 8 || patch.path.some(k => !['string', 'number'].includes(typeof k) || ['__proto__', 'prototype', 'constructor'].includes(String(k)))) refuse('receipt_invalid')
      const rootSpeakers = patch.path.length === 1 && patch.path[0] === 'speakers'
      if (!rootSpeakers && (!['chunks', 'chunkEntries', 'batchSegments'].includes(String(patch.path[0])) || patch.path.at(-1) !== 'speaker')) refuse('receipt_invalid')
      const key = JSON.stringify(patch.path)
      if (paths.has(key)) refuse('receipt_invalid')
      paths.add(key)
      let row = source
      for (const part of patch.path.slice(0, -1)) {
        if (!row || typeof row !== 'object' || !Object.hasOwn(row, part)) refuse('receipt_invalid')
        row = row[part]
      }
      const last = patch.path.at(-1)!
      if (!row || !equal(row[last], patch.after)) refuse('receipt_label_drift')
      if (patch.before === undefined) delete row[last]
      else row[last] = structuredClone(patch.before)
    }
    if (!evidence.rawAudioSampleCounts || typeof evidence.rawAudioSampleCounts !== 'object') refuse('receipt_invalid')
    const plan: MacSpeakerRepairPlan = { id: receipt.id, evidenceHash: receipt.evidenceHash, expectedDocumentHash: receipt.beforeHash,
      protectedRawChunkIndices: [], rawAudioSampleCounts: evidence.rawAudioSampleCounts, assignments: receipt.assignments, withheldBatchWords: receipt.withheldBatchWords }
    const seen = new Set<number>()
    for (const assignment of receipt.assignments) {
      if (!uint(assignment.rawChunkIndex) || seen.has(assignment.rawChunkIndex)) refuse('receipt_invalid')
      seen.add(assignment.rawChunkIndex)
      const proof = assignment.targetEvidence
      if (!proof) continue // Anonymous recurrence cannot authorize a name.
      if (!checkSpeakerName(assignment.to).ok || !proof.windows?.length || proof.windows.length > 128) refuse('proof_rejected')
      try { validateMacSpeakerTargetEvidence(source, plan, assignment) } catch { refuse('proof_rejected') }
      const current = byRaw.get(assignment.rawChunkIndex)
      if (!current || current.chunk.speaker !== assignment.to || !SHA.test(current.chunk.audioSha256)) refuse('receipt_label_drift')
      const restored = source.chunkEntries.find((entry: Doc) => entry.chunkIndex === assignment.rawChunkIndex)?.chunk
      if (restored?.speaker !== assignment.from) refuse('receipt_label_drift')
      positions.set(current.position, {
        label: assignment.to, rawChunkIndex: assignment.rawChunkIndex, evidenceId: assignment.evidenceId, receiptHash,
        modelSHA256: proof.modelSha256, profileSHA256: proof.profileSha256, algorithmVersion: proof.algorithmVersion,
        independentWindows: proof.windows.length, minimumSimilarity: Math.min(...proof.windows.map(w => w.similarity)),
        minimumMargin: Math.min(...proof.windows.map(w => w.similarity - w.runnerUpSimilarity)),
      })
    }
    return { status: 'qualified', positions }
  } catch (error) {
    return { status: 'invalid', positions: new Map(), reason: error instanceof Error ? error.message : 'proof_rejected' }
  }
}
