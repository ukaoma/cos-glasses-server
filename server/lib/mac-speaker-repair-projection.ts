/** Pure, conservative label projection. No file access, capture, inference or enrollment.
 * V1 accepts whole automatic anonymous chunks only. Mixed chunks and words crossing
 * their boundaries require a future, independently reviewed span-level projection.
 * The caller owns durable intents, byte-level file CAS, revisions and rendering.
 */
import { createHash } from 'node:crypto'
import { checkSpeakerName } from './speaker-name.js'

type Doc = Record<string, any>
export type MacSpeakerRepairPath = Array<string | number>
export interface MacSpeakerRepairPatch {
  path: MacSpeakerRepairPath
  before: unknown
  after: unknown
}
export interface MacSpeakerWordBinding {
  segmentIndex: number
  wordIndex: number
  from: string
  word: string
  /** Exact segment-relative seconds, not rounded timestamps. */
  start: number
  end: number
}
export interface MacProfileMatchEvidence {
  kind: 'profile-match'
  profileName: string
  profileSha256: string
  modelSha256: string
  algorithmVersion: string
  /** Complete-link consistency; every independent pair must meet .90. */
  crossWindowCosines: number[][]
  windows: Array<{
    id: string
    captureStartSample: number
    captureEndSample: number
    pcmSha256: string
    similarity: number
    runnerUpSimilarity: number
    rawChunks: Array<{ rawChunkIndex: number; audioSha256: string; sampleCount: number }>
  }>
}
export interface MacSpeakerRepairAssignment {
  rawChunkIndex: number
  from: string
  /** A settled Voice N label, or an existing profile name with targetEvidence. */
  to: string
  evidenceId: string
  batchWords: MacSpeakerWordBinding[]
  targetEvidence?: MacProfileMatchEvidence
}
export interface MacSpeakerRepairPlan {
  id: string
  evidenceHash: string
  expectedDocumentHash: string
  /** Explicit ledger-only protection, even for legacy edits without markers. */
  protectedRawChunkIndices: number[]
  /** Verified mono 16 kHz PCM sample counts, including silent/untranscribed raw files. */
  rawAudioSampleCounts: Record<string, number>
  assignments: MacSpeakerRepairAssignment[]
  /** Explicitly withheld words partly outside qualified chunk unions. */
  withheldBatchWords?: Array<MacSpeakerWordBinding & { reason: 'outside-qualified-span' }>
}
export interface MacSpeakerRepairReceipt {
  version: 1
  id: string
  evidenceHash: string
  beforeHash: string
  afterHash: string
  rawChunkIndices: number[]
  evidenceIds: string[]
  patches: MacSpeakerRepairPatch[]
  assignments: MacSpeakerRepairAssignment[]
  withheldBatchWords: Array<MacSpeakerWordBinding & { reason: 'outside-qualified-span' }>
  receiptHash: string
}
/** Persisted model/profile proof; never a human confirmation or training input. */
export interface MacSpeakerMachineEvidence {
  version: 1
  correctionRevision: number
  documentBinding: string
  receipt: MacSpeakerRepairReceipt
  rawAudioSampleCounts: Record<string, number>
}
/** Exact current speech surfaces, independent of lifecycle/sync metadata and
 * the proof itself. This deliberately binds diagnostics as well as labels. */
export function hashMacSpeakerMachineBinding(doc: Doc): string {
  return hashMacSpeakerDocument({
    sessionId: doc.sessionId, sourceType: doc.sourceType, captureSource: doc.captureSource,
    startTime: doc.startTime, durationMs: doc.durationMs,
    chunks: doc.chunks, chunkEntries: doc.chunkEntries,
    batchSegments: doc.batchSegments, batchTranscript: doc.batchTranscript, speakers: doc.speakers,
  })
}
export function hashMacSpeakerDocument(doc: Doc): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex')
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const anonymous = (label: unknown): label is string => typeof label === 'string' && /^(?:Ext|Unknown|Unidentified(?: \d+)?|Speaker \d+|Voice \d+)$/.test(label)
const hashPattern = /^[a-f0-9]{64}$/
function fail(message: string): never { throw new Error(`Mac speaker repair: ${message}`) }
function isProtected(row: any): boolean {
  if (!row || typeof row !== 'object') return false
  if (row.speakerCorrectionBatchId || row.speakerCorrectionId || row.manualSpeaker || row.speakerManuallyAssigned || row.confirmedByHuman || row.manuallyAssigned) return true
  return ['speakerSource', 'speakerPolicy', 'speakerProvenance', 'source'].some(key =>
    typeof row[key] === 'string' && /(?:manual|human|correction|confirmed)/i.test(row[key]))
}
/** Validate compacted position -> exact ordered raw chunk, without nearest joins. */
function rawMap(doc: Doc): Array<{ raw: number; entry: number }> {
  if (!Array.isArray(doc.chunks) || !Array.isArray(doc.chunkEntries)) fail('missing raw chunk map')
  const all = doc.chunkEntries.map((entry: any, i: number) => ({ entry, i }))
  if (all.some(({ entry }: any) => !entry || !Number.isInteger(entry.chunkIndex) || entry.chunkIndex < 0)) fail('invalid raw chunk entry')
  const indexes = all.map(({ entry }: any) => entry.chunkIndex)
  if (new Set(indexes).size !== indexes.length || indexes.some((raw: number, i: number) => i > 0 && raw <= indexes[i - 1])) fail('ambiguous raw index ordering')
  const spoken = all.filter(({ entry }: any) => entry.chunk?.text)
  if (spoken.length !== doc.chunks.length || spoken.some(({ entry }: any, i: number) => entry.chunk.text !== doc.chunks[i]?.text)) fail('raw map and ordered text disagree')
  return spoken.map(({ entry, i }: any) => ({ raw: entry.chunkIndex, entry: i }))
}
function labelRows(chunk: Doc, path: MacSpeakerRepairPath): Array<{ row: Doc; path: MacSpeakerRepairPath }> {
  const rows = [{ row: chunk, path }]
  for (const key of ['segments', 'finalSegments', 'words']) {
    if (chunk[key] !== undefined && !Array.isArray(chunk[key])) fail(`invalid ${key} surface`)
    for (const [i, row] of (chunk[key] ?? []).entries()) {
      if (!row || typeof row !== 'object') fail(`invalid ${key} row`)
      // Plain ASR words do not necessarily have any speaker field.
      if (key !== 'words' || 'speaker' in row) rows.push({ row, path: [...path, key, i] })
    }
  }
  return rows
}
function requireClosed(doc: Doc) {
  if (doc.finalizationState !== 'complete' || doc.claimPending === true || doc.active === true || doc.isActive === true || doc.status === 'recording') fail('capture is not closed and finalized')
  if (doc.sourceType !== 'mac_system_audio' || !/^mac_/.test(doc.sessionId ?? '') || doc.mergedFrom || doc.sourceSessionIds || doc.isMerged) fail('expected an original Mac capture')
}
function receiptDigest(receipt: Omit<MacSpeakerRepairReceipt, 'receiptHash'>): string { return hashMacSpeakerDocument(receipt) }

export function validateMacSpeakerTargetEvidence(input: Doc, plan: MacSpeakerRepairPlan, assignment: MacSpeakerRepairAssignment) {
  if (/^Voice (?:[1-9]|[1-9]\d)$/.test(assignment.to)) return
  const proof = assignment.targetEvidence
  if (!checkSpeakerName(assignment.to).ok || !assignment.to || assignment.to.trim() !== assignment.to || assignment.to.length > 120 || /[\[\]\r\n]/.test(assignment.to) || anonymous(assignment.to) || !proof || proof.kind !== 'profile-match' || proof.profileName !== assignment.to || !hashPattern.test(proof.profileSha256) || !hashPattern.test(proof.modelSha256) || !proof.algorithmVersion?.trim() || !Array.isArray(proof.windows) || proof.windows.length < 2) fail('named target requires immutable independent profile evidence')
  if (!Array.isArray(proof.crossWindowCosines) || proof.crossWindowCosines.length !== proof.windows.length || proof.crossWindowCosines.some(row => !Array.isArray(row) || row.length !== proof.windows.length)) fail('complete cross-window evidence matrix required')
  for (let i = 0; i < proof.windows.length; i++) for (let j = 0; j < proof.windows.length; j++) {
    const cosine = proof.crossWindowCosines[i][j]
    if (!Number.isFinite(cosine) || cosine < .9 || cosine > 1.000001 || Math.abs(cosine - proof.crossWindowCosines[j][i]) > 1e-8 || (i === j && Math.abs(cosine - 1) > 1e-6)) fail('cross-window evidence is inconsistent')
  }
  const rawSeen = new Set<number>(), pcmSeen = new Set<string>(), ids = new Set<string>(), spans: Array<[number, number]> = []
  let covered = false
  for (const window of proof.windows) {
    if (!window.id || ids.has(window.id) || !hashPattern.test(window.pcmSha256) || pcmSeen.has(window.pcmSha256) || !Number.isSafeInteger(window.captureStartSample) || !Number.isSafeInteger(window.captureEndSample) || window.captureStartSample < 0 || window.captureEndSample <= window.captureStartSample || !Number.isFinite(window.similarity) || window.similarity < .88 || window.similarity > 1 || !Number.isFinite(window.runnerUpSimilarity) || window.runnerUpSimilarity < -1 || window.runnerUpSimilarity > 1 || window.similarity - window.runnerUpSimilarity < .05 || !Array.isArray(window.rawChunks) || !window.rawChunks.length) fail('weak, repeated or invalid profile evidence')
    if (spans.some(([start, end]) => window.captureStartSample < end && window.captureEndSample > start)) fail('overlapping profile evidence windows')
    spans.push([window.captureStartSample, window.captureEndSample]); pcmSeen.add(window.pcmSha256); ids.add(window.id)
    const duration = (window.captureEndSample - window.captureStartSample) / 16000
    if (duration < 28 || duration > 31) fail('profile evidence requires full 28-31s windows')
    let samples = 0, previous = -1, pureSeconds = 0
    for (const raw of window.rawChunks) {
      if (!Number.isInteger(raw.rawChunkIndex) || rawSeen.has(raw.rawChunkIndex) || (previous >= 0 && raw.rawChunkIndex !== previous + 1) || !hashPattern.test(raw.audioSha256) || !Number.isSafeInteger(raw.sampleCount) || raw.sampleCount <= 0 || plan.rawAudioSampleCounts[String(raw.rawChunkIndex)] !== raw.sampleCount) fail('profile evidence raw bindings disagree')
      const chunk = input.chunkEntries.find((entry: Doc) => entry.chunkIndex === raw.rawChunkIndex)?.chunk
      if (!chunk || chunk.audioSha256 !== raw.audioSha256 || !Number.isFinite(chunk.elapsed) || chunk.elapsed * 16 !== window.captureStartSample + samples) fail('profile evidence capture coordinates disagree')
      if (chunk.speakerPolicy === 'anonymous' || !anonymous(chunk.speaker) || labelRows(chunk, []).some(({row}) => isProtected(row) || row.speaker !== chunk.speaker)) fail('profile evidence contains named/manual/mixed or anonymous-policy chunks')
      const segments = chunk.finalSegments?.length ? chunk.finalSegments : chunk.segments
      if (!Array.isArray(segments) || !segments.length) fail('profile evidence lacks automatic pure segment coverage')
      const ranges: Array<[number, number]> = segments.map((segment: Doc) => [segment.startSec, segment.endSec])
      if (ranges.some(([start,end]) => !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > raw.sampleCount / 16000)) fail('profile evidence segment coordinates disagree')
      ranges.sort((a,b)=>a[0]-b[0]); let end = 0
      for (const [start,stop] of ranges) { pureSeconds += Math.max(0,stop-Math.max(start,end)); end=Math.max(end,stop) }
      if (raw.rawChunkIndex === assignment.rawChunkIndex) covered = true
      rawSeen.add(raw.rawChunkIndex); previous = raw.rawChunkIndex; samples += raw.sampleCount
    }
    if (pureSeconds < 20) fail('profile evidence needs at least20s of automatic pure segment coverage')
    if (samples !== window.captureEndSample - window.captureStartSample) fail('profile evidence sample span disagrees')
  }
  if (!covered) fail('assignment lies outside qualified profile evidence')
}

export function projectMacSpeakerRepair(input: Doc, plan: MacSpeakerRepairPlan): { doc: Doc; receipt: MacSpeakerRepairReceipt } {
  requireClosed(input)
  if (!plan.id?.trim() || !hashPattern.test(plan.evidenceHash) || plan.expectedDocumentHash !== hashMacSpeakerDocument(input)) fail('plan evidence or document CAS mismatch')
  if (!Array.isArray(plan.protectedRawChunkIndices) || plan.protectedRawChunkIndices.some(i => !Number.isInteger(i) || i < 0)) fail('explicit ledger protection is required')
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) fail('no explicit assignments')
  const mapping = rawMap(input)
  const doc = structuredClone(input)
  const patches: MacSpeakerRepairPatch[] = []
  const patch = (path: MacSpeakerRepairPath, after: unknown) => {
    let row = doc
    for (const key of path.slice(0, -1)) row = row[key]
    const key = path.at(-1)!
    if (equal(row[key], after)) return
    patches.push({ path, before: structuredClone(row[key]), after: structuredClone(after) })
    row[key] = structuredClone(after)
  }
  if (!plan.rawAudioSampleCounts || typeof plan.rawAudioSampleCounts !== 'object') fail('verified raw audio sample counts are required')
  const selected = new Map<number, { assignment: MacSpeakerRepairAssignment }>()
  for (const assignment of plan.assignments) {
    if (selected.has(assignment.rawChunkIndex) || plan.protectedRawChunkIndices.includes(assignment.rawChunkIndex)) fail('duplicate or ledger-protected chunk')
    if (!anonymous(assignment.from) || !assignment.evidenceId?.trim() || !Array.isArray(assignment.batchWords)) fail('assignment requires anonymous labels and explicit evidence')
    validateMacSpeakerTargetEvidence(input, plan, assignment)
    const position = mapping.findIndex(row => row.raw === assignment.rawChunkIndex)
    if (position < 0) fail('unknown raw chunk')
    const chunk = input.chunks[position]
    const entry = input.chunkEntries[mapping[position].entry].chunk
    if (!Number.isFinite(chunk.elapsed) || !Number.isFinite(chunk.audioDurationMs) || chunk.audioDurationMs <= 0 || entry.elapsed !== chunk.elapsed || entry.audioDurationMs !== chunk.audioDurationMs) fail('raw chunk timing disagreement')
    // Surface identity must match, including text/times/original diagnostic fields.
    for (const key of ['speaker', 'segments', 'finalSegments', 'words']) if (!equal(chunk[key], entry[key])) fail('chunk and entry label surfaces disagree')
    for (const target of [{ chunk, path: ['chunks', position] }, { chunk: entry, path: ['chunkEntries', mapping[position].entry, 'chunk'] }]) {
      for (const { row, path } of labelRows(target.chunk, target.path)) {
        if (isProtected(row) || !anonymous(row.speaker)) fail('named or manual span is protected')
        if (row.speaker !== assignment.from) fail('mixed chunk requires exact span repair')
        patch([...path, 'speaker'], assignment.to)
      }
    }
    selected.set(assignment.rawChunkIndex, { assignment })
  }
  const withheld = new Map<string, MacSpeakerWordBinding>(), usedWithheld = new Set<string>()
  for (const binding of plan.withheldBatchWords ?? []) {
    const key = `${binding.segmentIndex}:${binding.wordIndex}`
    if (binding.reason !== 'outside-qualified-span' || withheld.has(key) || !Number.isInteger(binding.segmentIndex) || !Number.isInteger(binding.wordIndex)) fail('invalid withheld boundary word binding')
    withheld.set(key, binding)
  }
  const expectedWords = new Map<string, MacSpeakerRepairAssignment>()
  const batchSegments = input.batchSegments ?? []
  if (!Array.isArray(batchSegments)) fail('invalid batch segments')
  for (const [si, segment] of batchSegments.entries()) {
    if (!Array.isArray(segment.speakerWords)) fail('batch speaker words are missing')
    const rangeSelected = [...selected.keys()].some(raw => raw >= segment.startChunkIdx && raw <= segment.endChunkIdx)
    if (!rangeSelected) continue
    if (!Number.isInteger(segment.startChunkIdx) || !Number.isInteger(segment.endChunkIdx) || segment.startChunkIdx < 0 || segment.endChunkIdx < segment.startChunkIdx) fail('invalid batch raw range')
    // Batch seconds index concatenated PCM files, including silent files. They
    // are NOT startElapsed + seconds on the compacted transcript timeline.
    const intervals: Array<{ raw: number; start: number; end: number }> = []
    let offset = 0
    for (let raw = segment.startChunkIdx; raw <= segment.endChunkIdx; raw++) {
      const samples = plan.rawAudioSampleCounts[String(raw)]
      if (!Number.isSafeInteger(samples) || samples <= 0) fail('missing verified raw audio sample count')
      const end = offset + samples / 16000
      intervals.push({ raw, start: offset, end })
      offset = end
    }
    for (const [wi, word] of segment.speakerWords.entries()) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > offset) fail('invalid batch word timing')
      const overlaps = intervals.filter(s => word.end === word.start ? word.start >= s.start && word.start < s.end : word.start < s.end && word.end > s.start)
      if (!overlaps.some(s => selected.has(s.raw))) continue
      if (overlaps.some(s => !selected.has(s.raw))) {
        const key = `${si}:${wi}`, binding = withheld.get(key)
        if (!binding || word.word !== binding.word || word.start !== binding.start || word.end !== binding.end || word.speaker !== binding.from) fail('batch word crosses selected raw chunk boundaries')
        usedWithheld.add(key); continue
      }
      if (new Set(overlaps.map(s => selected.get(s.raw)?.assignment.to)).size !== 1) fail('batch word crosses selected raw chunk boundaries')
      const span = selected.get(overlaps[0].raw)!
      if (isProtected(word) || !anonymous(word.speaker)) fail('named or manual batch word is protected')
      expectedWords.set(`${si}:${wi}`, span.assignment)
    }
  }
  if (usedWithheld.size !== withheld.size) fail('withheld boundary word is not outside qualified span')
  const seen = new Set<string>()
  for (const assignment of plan.assignments) for (const binding of assignment.batchWords) {
    const key = `${binding.segmentIndex}:${binding.wordIndex}`
    if (!Number.isInteger(binding.segmentIndex) || !Number.isInteger(binding.wordIndex) || seen.has(key) || expectedWords.get(key) !== assignment) fail('unexpected or duplicate batch word binding')
    seen.add(key)
    const word = batchSegments[binding.segmentIndex].speakerWords[binding.wordIndex]
    if (word.word !== binding.word || word.start !== binding.start || word.end !== binding.end || word.speaker !== binding.from) fail('batch word evidence disagrees')
    patch(['batchSegments', binding.segmentIndex, 'speakerWords', binding.wordIndex, 'speaker'], assignment.to)
  }
  if (seen.size !== expectedWords.size) fail('incomplete batch word coverage')
  const labels: string[] = []
  for (const chunk of doc.chunks) for (const { row } of labelRows(chunk, [])) if (typeof row.speaker === 'string' && row.speaker && !anonymous(row.speaker)) labels.push(row.speaker)
  for (const segment of doc.batchSegments ?? []) for (const word of segment.speakerWords ?? []) if (typeof word.speaker === 'string' && word.speaker && !anonymous(word.speaker)) labels.push(word.speaker)
  // Do not invent identities, and do not carry anonymous voices into a real-name list.
  patch(['speakers'], [...new Set(labels)])
  const unsigned: Omit<MacSpeakerRepairReceipt, 'receiptHash'> = {
    version: 1, id: plan.id, evidenceHash: plan.evidenceHash,
    beforeHash: hashMacSpeakerDocument(input), afterHash: hashMacSpeakerDocument(doc),
    assignments: structuredClone(plan.assignments), withheldBatchWords: structuredClone(plan.withheldBatchWords ?? []),
    rawChunkIndices: plan.assignments.map(row => row.rawChunkIndex), evidenceIds: plan.assignments.map(row => row.evidenceId), patches,
  }
  return { doc, receipt: { ...unsigned, receiptHash: receiptDigest(unsigned) } }
}

/** Full-document CAS is intentionally conservative: even unrelated drift needs
 * a fresh review. This pure operation never overwrites a later correction.
 * Replaying a completed apply/undo is idempotent; partial states fail closed.
 */
export function applyMacSpeakerRepair(input: Doc, receipt: MacSpeakerRepairReceipt, direction: 'forward' | 'reverse' = 'forward'): Doc {
  const { receiptHash, ...unsigned } = receipt
  if (receipt.version !== 1 || receiptDigest(unsigned) !== receiptHash) fail('receipt integrity mismatch')
  const forward = direction === 'forward'
  const before = forward ? receipt.beforeHash : receipt.afterHash
  const after = forward ? receipt.afterHash : receipt.beforeHash
  const current = hashMacSpeakerDocument(input)
  if (current === after) return structuredClone(input)
  if (current !== before) fail('document drift; review before apply or undo')
  const doc = structuredClone(input)
  const ordered = forward ? receipt.patches : [...receipt.patches].reverse()
  for (const patch of ordered) {
    if (!patch.path.length || patch.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(String(key)))) fail('unsafe patch path')
    let row = doc
    for (const key of patch.path.slice(0, -1)) { if (!row || typeof row !== 'object' || !(key in row)) fail('patch shape drift'); row = row[key] }
    const key = patch.path.at(-1)!
    if (!equal(row[key], forward ? patch.before : patch.after)) fail('patch value drift')
    const value = forward ? patch.after : patch.before
    if (value === undefined) delete row[key]
    else row[key] = structuredClone(value)
  }
  if (hashMacSpeakerDocument(doc) !== after) fail('projection postimage mismatch')
  return doc
}
