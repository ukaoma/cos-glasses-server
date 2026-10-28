/** Qualified, named, exact-window finalization only. No anonymous merging,
 * enrollment, guessed participant count, model-channel naming or lower floor.
 * A durable attempt and two-file before/after journal make retries fail closed. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import { dataPath } from './data-dir.js'
import { readPcm16Mono, wavHeader } from './nemotron-segments.js'
import { planMacSpeakerWindows, qualifyMacSpeakerWindows, type VerifiedMacRawChunk, type MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import { normalizedSpeakerCosine, type MacSpeakerProfile } from './mac-speaker-reconcile.js'
import { hashMacSpeakerDocument, hashMacSpeakerMachineBinding, projectMacSpeakerRepair, type MacProfileMatchEvidence, type MacSpeakerRepairAssignment, type MacSpeakerWordBinding } from './mac-speaker-repair-projection.js'
import { boundWords, renderBoundSpeakerLabels, renderMarkdown } from './mac-speaker-repair-render.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { extractQualifiedMacWindow } from './mac-speaker-profile-extractor.js'
type Doc = Record<string, any>
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const yieldLoop = () => new Promise<void>(r => setImmediate(r))
const MAX_WINDOWS = 12, MAX_RAW = 2048, MAX_MS = 90_000
export const MAX_PROFILE_BYTES = 32 * 1024 * 1024
function fail(reason: string): never { throw new Error(`qualified Mac profile pass: ${reason}`) }
export interface QualifiedMacProfileInput { sidecarPath: string; meetingPath: string; audioDir: string; resumeOnly?: boolean }
export interface QualifiedMacProfileDeps {
  /** Test seams never invoke native inference. Production freezes the complete cohort. */
  runtime?: () => Promise<{ modelPath: string; profilesPath: string } | null>
  extract?: (pcm: Buffer, modelPath: string, timeoutMs: number) => Promise<readonly number[][] | null>
  ledgerPath?: (sessionId: string) => string
  now?: () => number
  beforeCommit?: () => void
  afterWrite?: (index: number) => void
}
export interface QualifiedMacProfileOutcome { status: 'applied' | 'skipped'; reason: string; assignments?: number }
interface Image { path: string; before: string; after: string }
interface Journal { version: 1; status: 'attempted' | 'prepared' | 'complete'; sessionId: string; sourceSidecarHash: string; imageBinding?: string; rawBindings?: Array<{ name: string; sha256: string }>; reason?: string; images?: Image[]; ledgerPath: string; ledgerHash: string | null; profilePath: string; profileHash: string; modelPath: string; modelHash: string }
const active = new Set<string>()
let extractionBusy = false
function regularRead(path: string, max = 12 * 1024 * 1024): string {
  const s = lstatSync(path)
  if (!s.isFile() || s.isSymbolicLink() || s.size > max) fail('unsafe or oversized file')
  return readFileSync(path, 'utf8')
}
function ledgerHash(path: string): string | null {
  try { return sha(regularRead(path, 4 * 1024 * 1024)) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
function ledgerClear(path: string): boolean {
  const digest = ledgerHash(path)
  if (digest === null) return true
  // Every historical human action (including intent/revert) protects the capture.
  return regularRead(path).trim() === ''
}

function strictPcm(wav: Buffer) {
  if (wav.length < 44 || wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2) return null
  return readPcm16Mono(wav)
}
async function runtimeDefault() {
  const { speakerModelState } = await import('./speaker-embeddings.js')
  const model = speakerModelState()
  return model.state === 'active' && model.path ? { modelPath: model.path, profilesPath: dataPath('voice-profiles.json') } : null
}
function recover(journalPath: string, journal: Journal, input: QualifiedMacProfileInput, deps: QualifiedMacProfileDeps): QualifiedMacProfileOutcome {
  if (journal.version !== 1 || !MAC_CAPTURE_ID.test(journal.sessionId) || journal.images?.length !== 2
    || journal.images[0].path !== resolve(input.meetingPath) || journal.images[1].path !== resolve(input.sidecarPath)
    || ledgerHash(journal.ledgerPath) !== journal.ledgerHash) fail('journal or human history drift')
  if (journal.status !== 'complete' && (sha(regularRead(journal.profilePath, MAX_PROFILE_BYTES)) !== journal.profileHash || sha(readFileSync(journal.modelPath)) !== journal.modelHash)) fail('journal profile/model drift')
  const images = journal.images
  if (journal.imageBinding !== hashMacSpeakerDocument(images) || sha(images[1].before) !== journal.sourceSidecarHash) fail('journal image integrity drift')
  const beforeDoc = JSON.parse(images[1].before), afterDoc = JSON.parse(images[1].after)
  const proofRead = readMacSpeakerMachineEvidence({ ...afterDoc, finalizationState: 'complete' })
  if (beforeDoc.sessionId !== journal.sessionId || afterDoc.sessionId !== journal.sessionId || proofRead.status !== 'qualified' || !proofRead.positions.size || !afterDoc.speakerRepair?.machineEvidence?.receipt) fail('journal proof rejected')
  const expectedSequence = boundWords(beforeDoc, afterDoc)
  if (renderBoundSpeakerLabels(beforeDoc.batchTranscript, expectedSequence) !== afterDoc.batchTranscript || renderMarkdown(images[0].before, expectedSequence) !== images[0].after) fail('journal word invariant drift')
  if (journal.status !== 'complete') {
    if (!Array.isArray(journal.rawBindings) || !journal.rawBindings.length || journal.rawBindings.length > MAX_RAW) fail('journal raw bindings invalid')
    for (const raw of journal.rawBindings) { if (!/^chunk_\d{4,}\.wav$/.test(raw.name) || sha(readFileSync(join(input.audioDir, raw.name))) !== raw.sha256) fail('journal raw drift') }
  }
  const current = images.map(image => regularRead(image.path))
  if (journal.status !== 'complete' && current.some((bytes, i) => bytes !== images[i].before && bytes !== images[i].after)) fail('journal precondition drift')
  // Completed transactions never reapply over a later change; the exact speech
  // binding/revision guard in readers separately invalidates later stale claims.
  if (journal.status === 'complete') {
    if (current.every((bytes, i) => bytes === images[i].after)) return { status: 'applied', reason: 'already_applied' }
    const saved = JSON.parse(images[1].after), currentDoc = JSON.parse(current[1])
    if (hashMacSpeakerMachineBinding(currentDoc) === hashMacSpeakerMachineBinding(saved) && currentDoc.correctionRevision === saved.correctionRevision && readMacSpeakerMachineEvidence(currentDoc).status === 'qualified') return { status: 'applied', reason: 'already_applied' }
    fail('completed journal changed')
  }
  for (let i = 0; i < images.length; i++) {
    if (ledgerHash(journal.ledgerPath) !== journal.ledgerHash) fail('human history changed')
    for (let j = 0; j < images.length; j++) {
      const bytes = regularRead(images[j].path)
      if (bytes !== (j < i ? images[j].after : current[j])) fail('transaction changed during commit')
    }
    if (current[i] !== images[i].after) durableAtomicWriteFileSync(images[i].path, images[i].after)
    deps.afterWrite?.(i)
  }
  if (images.some(image => regularRead(image.path) !== image.after)) fail('postimage changed')
  journal.status = 'complete'; durableAtomicWriteFileSync(journalPath, JSON.stringify(journal))
  return { status: 'applied', reason: 'qualified_profile' }
}
/** Six deterministic adjacent pairs spread across the entire call. Scheduling
 * hints never add identity votes; each pair still needs acoustic qualification. */
export function selectQualifiedProfileWindows<T>(windows: readonly T[]): T[] {
  if (windows.length <= MAX_WINDOWS) return [...windows]
  const indexes = new Set<number>()
  for (let i = 0; i < MAX_WINDOWS / 2; i++) { const index = Math.floor(i * (windows.length - 2) / (MAX_WINDOWS / 2 - 1)); indexes.add(index); indexes.add(index + 1) }
  return [...indexes].sort((a, b) => a - b).map(i => windows[i])
}
/** Called twice by the finalizer: resumeOnly BEFORE any ASR retry, and ordinary
 * mode AFTER ASR+diarization, before raw deletion or downstream copies/sync. */
export async function runQualifiedMacProfilePass(input: QualifiedMacProfileInput, deps: QualifiedMacProfileDeps = {}): Promise<QualifiedMacProfileOutcome> {
  const key = resolve(input.sidecarPath), journalPath = `${key}.speaker-profile-pass.json`
  if (active.has(key)) return { status: 'skipped', reason: 'active' }
  active.add(key)
  let ownsExtraction = false
  try {
    if (existsSync(journalPath)) {
      const prior = JSON.parse(regularRead(journalPath, 64 * 1024 * 1024)) as Journal
      if (prior.status === 'prepared' || prior.status === 'complete') return recover(journalPath, prior, input, deps)
      if (prior.version !== 1 || prior.status !== 'attempted') fail('invalid attempt journal')
      return { status: 'skipped', reason: prior.reason ?? 'previous_attempt' }
    }
    if (input.resumeOnly) return { status: 'skipped', reason: 'no_transaction' }
    const now = deps.now ?? Date.now, deadline = now() + MAX_MS
    const budget = () => { if (now() >= deadline) fail('budget_exhausted') }
    const beforeSidecar = regularRead(key), source = JSON.parse(beforeSidecar) as Doc
    if (source.sourceType !== 'mac_system_audio' || !MAC_CAPTURE_ID.test(source.sessionId) || !['batch_pending', 'ops_pending', 'complete'].includes(source.finalizationState)
      || source.claimPending || source.active || source.isActive || source.status === 'recording' || source.isMerged || source.mergedFrom || source.sourceSessionIds || source.supersededBy || source.superseded || source.speakerRepair
      || (source.correctionRevision ?? 0) !== 0 || source.batchApplied !== true || !Array.isArray(source.batchSegments) || !Array.isArray(source.chunkEntries) || source.chunkEntries.length > MAX_RAW) return { status: 'skipped', reason: 'source_ineligible' }
    const ledgerPath = deps.ledgerPath?.(source.sessionId) ?? dataPath('meeting-corrections', `${source.sessionId}.jsonl`)
    if (!ledgerClear(ledgerPath)) return { status: 'skipped', reason: 'human_corrected' }
    const ledger = ledgerHash(ledgerPath), beforeMarkdown = regularRead(input.meetingPath, 4 * 1024 * 1024)
    const runtime = await (deps.runtime ?? runtimeDefault)()
    if (!runtime) return { status: 'skipped', reason: 'model_unavailable' }
    const profileBytes = regularRead(runtime.profilesPath, MAX_PROFILE_BYTES), profileSHA256 = sha(profileBytes)
    const cohort = JSON.parse(profileBytes).profiles
    if (!Array.isArray(cohort) || !cohort.length || cohort.length > 1024) return { status: 'skipped', reason: 'profile_cohort_invalid' }
    if ((await stat(runtime.modelPath)).size > 128 * 1024 * 1024) return { status: 'skipped', reason: 'model_oversized' }
    const modelBytes = await readFile(runtime.modelPath); budget()
    if (modelBytes.length > 128 * 1024 * 1024) return { status: 'skipped', reason: 'model_oversized' }
    if (cohort.some(p => !p || typeof p.name !== 'string' || !Array.isArray(p.embeddings) || !p.embeddings.length || p.embeddings.length > 128 || p.embeddings.some((r: unknown) => !Array.isArray(r) || r.length !== 192 || r.some(v => !Number.isFinite(v)))) || cohort.reduce((n, p) => n + p.embeddings.length, 0) > 8192) return { status: 'skipped', reason: 'profile_cohort_invalid' }
    const modelSHA256 = sha(modelBytes)
    const profiles: MacSpeakerProfile[] = cohort.map(p => ({ name: p.name, embeddings: p.embeddings, profileSHA256 }))
    // One bounded native profile job server-wide. A concurrent capture keeps
    // its saved labels rather than multiplying native processes/CPU load.
    if (extractionBusy) return { status: 'skipped', reason: 'profile_lane_busy' }
    extractionBusy = true; ownsExtraction = true
    const journal: Journal = { version: 1, status: 'attempted', sessionId: source.sessionId, sourceSidecarHash: sha(beforeSidecar), ledgerPath, ledgerHash: ledger, profilePath: resolve(runtime.profilesPath), profileHash: profileSHA256, modelPath: resolve(runtime.modelPath), modelHash: modelSHA256 }
    durableAtomicWriteFileSync(journalPath, JSON.stringify(journal))
    try {
      const raw: VerifiedMacRawChunk[] = [], counts: Record<string, number> = {}
      for (const entry of source.chunkEntries) {
        budget()
        if (!Number.isSafeInteger(entry.chunkIndex) || entry.chunkIndex < 0) fail('invalid raw index')
        const path = join(input.audioDir, `chunk_${String(entry.chunkIndex).padStart(4, '0')}.wav`)
        const info = await stat(path)
        if (!info.isFile() || info.size > 960044) fail('invalid raw file')
        const wav = await readFile(path), audioSHA256 = sha(wav), pcm = strictPcm(wav)
        if (!pcm || pcm.sampleRate !== 16000 || wav.length > 960044 || (entry.chunk.audioSha256 !== undefined && audioSHA256 !== entry.chunk.audioSha256)) fail('raw hash/format drift')
        const sampleCount = pcm.pcm.length / 2
        counts[entry.chunkIndex] = sampleCount
        raw.push({ chunkIndex: entry.chunkIndex, audioSHA256, pcmSHA256: sha(pcm.pcm), sampleRate: 16000, channels: 1, format: 'pcm_s16le', sampleCount, verified: true })
        if (raw.length % 4 === 0) await yieldLoop()
      }
      const plan = planMacSpeakerWindows({ sidecar: source as any, rawChunks: raw, correctionHistory: 'verified-clear' })
      plan.windows = selectQualifiedProfileWindows(plan.windows)
      if (plan.windows.length < 2) fail('insufficient_long_windows')
      const receipts: MacWindowEmbeddingReceipt[] = []
      for (const window of plan.windows) {
        budget(); await yieldLoop()
        const buffers: Buffer[] = []
        for (const s of window.sources) {
          const wav = await readFile(join(input.audioDir, `chunk_${String(s.chunkIndex).padStart(4, '0')}.wav`)), pcm = strictPcm(wav)
          if (sha(wav) !== s.audioSHA256 || !pcm || sha(pcm.pcm) !== s.pcmSHA256) fail('raw changed before extraction')
          buffers.push(pcm.pcm)
        }
        const pcm = Buffer.concat(buffers), wav = Buffer.concat([wavHeader(pcm.length), pcm])
        const vectors = await (deps.extract ?? extractQualifiedMacWindow)(pcm, runtime.modelPath, Math.min(15_000, deadline - now()))
        budget()
        if (!vectors || vectors.length !== 3) continue
        receipts.push({ windowId: window.id, windowBindingSHA256: window.bindingSHA256, modelSHA256, audioSHA256: sha(wav), pcmSHA256: sha(pcm), sampleCount: pcm.length / 2, embedding: vectors[0], halfEmbeddings: [vectors[1], vectors[2]] })
      }
      const qualified = qualifyMacSpeakerWindows(plan, receipts, profiles, modelSHA256)
      const byWindow = new Map(plan.windows.map(w => [w.id, w])), byReceipt = new Map(receipts.map(r => [r.windowId, r]))
      const assignments: MacSpeakerRepairAssignment[] = []
      const groups = new Map<string, typeof qualified>()
      for (const c of qualified) if (c.status === 'qualified' && c.profileName) { const k = `${c.acousticIdentity}:${c.profileName}`; groups.set(k, [...(groups.get(k) ?? []), c]) }
      for (const group of groups.values()) {
        if (group.length < 2) continue
        const profile = profiles.find(p => p.name === group[0].profileName)!
        // Same raw-average centroid used by the production recognizer. The
        // qualifier already rejected corrupt/mismatched rows and profile ties.
        const rows = profile.embeddings, dimensions = rows[0].length
        const centroid = Array.from({ length: dimensions }, (_, i) => rows.reduce((n, r) => n + r[i] / rows.length, 0))
        const centroids = profiles.map(p => ({ name: p.name, vector: Array.from({ length: dimensions }, (_, i) => p.embeddings.reduce((n, r) => n + r[i] / p.embeddings.length, 0)) }))
        const proof: MacProfileMatchEvidence = { kind: 'profile-match', profileName: profile.name, profileSha256: profileSHA256, modelSha256: modelSHA256, algorithmVersion: 'qualified-long-window-profile-v1',
          crossWindowCosines: group.map(a => group.map(b => normalizedSpeakerCosine(byReceipt.get(a.windowId)!.embedding, byReceipt.get(b.windowId)!.embedding)!)),
          windows: group.map(c => { const w = byWindow.get(c.windowId)!, r = byReceipt.get(c.windowId)!; return { id: w.id, captureStartSample: w.startSample, captureEndSample: w.endSample, pcmSha256: r.pcmSHA256,
            similarity: normalizedSpeakerCosine(r.embedding, centroid)!, runnerUpSimilarity: Math.max(-1, ...centroids.filter(p => p.name !== profile.name).map(p => normalizedSpeakerCosine(r.embedding, p.vector)!)),
            rawChunks: w.sources.map(s => ({ rawChunkIndex: s.chunkIndex, audioSha256: s.audioSHA256, sampleCount: s.sampleCount })) } }) }
        for (const c of group) for (const s of byWindow.get(c.windowId)!.sources) assignments.push({ rawChunkIndex: s.chunkIndex, from: c.originalVoiceHint, to: profile.name, evidenceId: c.acousticIdentity!, targetEvidence: proof, batchWords: [] })
      }
      if (!assignments.length) fail('no_qualified_profile')
      const selected = new Map(assignments.map(a => [a.rawChunkIndex, a])), withheldBatchWords: Array<MacSpeakerWordBinding & { reason: 'outside-qualified-span' }> = []
      source.batchSegments.forEach((segment: Doc, segmentIndex: number) => {
        const spans: { raw: number; start: number; end: number }[] = []; let end = 0
        if (!Number.isSafeInteger(segment.startChunkIdx) || !Number.isSafeInteger(segment.endChunkIdx) || segment.endChunkIdx - segment.startChunkIdx > MAX_RAW) fail('invalid batch range')
        for (let raw = segment.startChunkIdx; raw <= segment.endChunkIdx; raw++) { if (!counts[raw]) fail('missing batch raw clock'); spans.push({ raw, start: end, end: end + counts[raw] / 16000 }); end += counts[raw] / 16000 }
        segment.speakerWords.forEach((word: Doc, wordIndex: number) => {
          const overlaps = spans.filter(s => word.end === word.start ? word.start >= s.start && word.start < s.end : word.start < s.end && word.end > s.start)
          if (!overlaps.some(s => selected.has(s.raw))) return
          const binding = { segmentIndex, wordIndex, word: word.word, from: word.speaker, start: word.start, end: word.end }
          if (overlaps.some(s => !selected.has(s.raw))) withheldBatchWords.push({ ...binding, reason: 'outside-qualified-span' })
          else if (new Set(overlaps.map(s => selected.get(s.raw)!.to)).size === 1) selected.get(overlaps[0].raw)!.batchWords.push(binding)
          else fail('crossed identities')
        })
      })
      budget()
      const staging = { ...source, finalizationState: 'complete' }, repairPlan = { id: `profile_${sha(beforeSidecar).slice(0, 24)}`, evidenceHash: hashMacSpeakerDocument(receipts), expectedDocumentHash: hashMacSpeakerDocument(staging), protectedRawChunkIndices: [], rawAudioSampleCounts: counts, assignments, withheldBatchWords }
      const projected = projectMacSpeakerRepair(staging, repairPlan), after = projected.doc, sequence = boundWords(staging, after)
      after.batchTranscript = renderBoundSpeakerLabels(source.batchTranscript, sequence)
      const afterMarkdown = renderMarkdown(beforeMarkdown, sequence)
      after.finalizationState = source.finalizationState
      after.correctionRevision = 1; after.lifecycleRevision = (source.lifecycleRevision ?? 0) + 1
      after.speakerRepair = { version: 1, id: repairPlan.id, evidenceHash: repairPlan.evidenceHash, machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(after), receipt: projected.receipt, rawAudioSampleCounts: counts } }
      after.speakerProfilePass = { version: 1, status: 'applied', windows: receipts.length, assignments: assignments.length }
      deps.beforeCommit?.(); budget()
      for (const c of assignments) {
        const rawBytes = await readFile(join(input.audioDir, `chunk_${String(c.rawChunkIndex).padStart(4, '0')}.wav`))
        if (sha(rawBytes) !== raw.find(r => r.chunkIndex === c.rawChunkIndex)!.audioSHA256) fail('raw changed before commit')
      }
      const currentModelHash = sha(await readFile(runtime.modelPath))
      if (regularRead(key) !== beforeSidecar || regularRead(input.meetingPath) !== beforeMarkdown || ledgerHash(ledgerPath) !== ledger || sha(regularRead(runtime.profilesPath, MAX_PROFILE_BYTES)) !== profileSHA256 || currentModelHash !== modelSHA256) fail('source/profile/model/history drift')
      journal.images = [{ path: resolve(input.meetingPath), before: beforeMarkdown, after: afterMarkdown }, { path: key, before: beforeSidecar, after: JSON.stringify(after, null, 2) + '\n' }]
      journal.imageBinding = hashMacSpeakerDocument(journal.images)
      journal.rawBindings = assignments.map(a => ({ name: `chunk_${String(a.rawChunkIndex).padStart(4, '0')}.wav`, sha256: raw.find(r => r.chunkIndex === a.rawChunkIndex)!.audioSHA256 }))
      journal.status = 'prepared'; durableAtomicWriteFileSync(journalPath, JSON.stringify(journal))
      const outcome = recover(journalPath, journal, input, deps)
      return { ...outcome, assignments: assignments.length }
    } catch (error) {
      // Prepared transactions must be retried before ASR, never reported as an
      // ordinary no-match that permits downstream filing of mixed generations.
      if (journal.status === 'prepared') throw error
      journal.reason = error instanceof Error ? error.message : 'unqualified'; durableAtomicWriteFileSync(journalPath, JSON.stringify(journal))
      return { status: 'skipped', reason: journal.reason }
    }
  } catch (error) {
    // Recovery failures must block ASR/copying; ordinary unavailable resources
    // leave the already saved recording alone.
    if (existsSync(journalPath)) {
      const saved = JSON.parse(regularRead(journalPath, 64 * 1024 * 1024)) as Journal
      if (saved.status === 'prepared' || saved.status === 'complete') throw error
    }
    return { status: 'skipped', reason: error instanceof Error ? error.message : 'unavailable' }
  } finally { if (ownsExtraction) extractionBusy = false; active.delete(key) }
}
