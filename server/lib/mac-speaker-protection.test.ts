// Synthetic only. No natural audio/vectors/profiles, playback or native models.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasMacSpeakerProtectedRows, isMacSpeakerHumanProtected } from './mac-speaker-protection.js'
import { planMacSpeakerWindows, type VerifiedMacRawChunk } from './mac-speaker-windows.js'
import { projectMacSpeakerRepair, hashMacSpeakerDocument, hashMacSpeakerMachineBinding, type MacSpeakerRepairPlan } from './mac-speaker-repair-projection.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { runQualifiedMacProfilePass } from './mac-speaker-profile-finalizer.js'
import { qualifiedMacMachineSidecar } from './__fixtures__/mac-machine-evidence.js'
import { wavHeader } from './nemotron-segments.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const surfaces = ['chunk', 'segments', 'finalSegments', 'words'] as const
const markers = [{ speakerOrigin: 'manual' }, { manuallyCorrected: true }]
const cases = surfaces.flatMap(surface => markers.map(marker => ({ surface, marker })))
function fixture() {
  const input = qualifiedMacMachineSidecar(), receipt = input.speakerRepair.machineEvidence.receipt
  for (const p of [...receipt.patches].reverse()) { let row = input; for (const key of p.path.slice(0, -1)) row = row[key]; row[p.path.at(-1)!] = p.before }
  delete input.speakerRepair; input.correctionRevision = 0
  for (const [i, c] of input.chunks.entries()) {
    c.finalSegments = structuredClone(c.segments)
    c.words = [{ word: c.text, speaker: c.speaker, start: .1, end: .8 }]
    input.chunkEntries[i].chunk = structuredClone(c)
  }
  const plan: MacSpeakerRepairPlan = { id: receipt.id, evidenceHash: receipt.evidenceHash, expectedDocumentHash: hashMacSpeakerDocument(input), protectedRawChunkIndices: [], rawAudioSampleCounts: Object.fromEntries(input.chunkEntries.map((e: any) => [e.chunkIndex, 96000])), assignments: structuredClone(receipt.assignments) }
  const raw: VerifiedMacRawChunk[] = input.chunkEntries.map((e: any) => ({ chunkIndex: e.chunkIndex, audioSHA256: e.chunk.audioSha256, pcmSHA256: sha(`pcm-${e.chunkIndex}`), sampleCount: 96000, sampleRate: 16000, channels: 1, format: 'pcm_s16le', verified: true }))
  return { input, plan, raw }
}
function mark(input: Record<string, any>, surface: typeof surfaces[number], marker: Record<string, unknown>) {
  Object.assign(surface === 'chunk' ? input.chunks[0] : input.chunks[0][surface][0], marker)
  input.chunkEntries[0].chunk = structuredClone(input.chunks[0])
}
describe('shared human speaker protection across acoustic support and label writes', () => {
  it('keeps ordinary machine provenance and originalSpeaker diagnostics eligible', () => {
    const f = fixture()
    for (const c of f.input.chunks) { c.originalSpeaker = 'Voice 99'; c.speakerOrigin = 'automatic'; c.manuallyCorrected = false }
    f.input.chunkEntries = f.input.chunks.map((chunk: any, chunkIndex: number) => ({ chunkIndex, chunk: structuredClone(chunk) }))
    expect(hasMacSpeakerProtectedRows(f.input.chunks[0])).toBe(false)
    expect(planMacSpeakerWindows({ sidecar: f.input as any, rawChunks: f.raw, correctionHistory: 'verified-clear' }).windows).toHaveLength(2)
    const p = projectMacSpeakerRepair(f.input, { ...f.plan, expectedDocumentHash: hashMacSpeakerDocument(f.input) })
    p.doc.correctionRevision = 1
    p.doc.speakerRepair = { id: f.plan.id, evidenceHash: f.plan.evidenceHash, machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(p.doc), receipt: p.receipt, rawAudioSampleCounts: f.plan.rawAudioSampleCounts } }
    expect(readMacSpeakerMachineEvidence(p.doc).positions.size).toBe(10)
  })
  it.each(cases)('excludes marked $surface audio from positive evidence: $marker', ({ surface, marker }) => {
    const f = fixture(); mark(f.input, surface, marker)
    const before = JSON.stringify(f.input), p = planMacSpeakerWindows({ sidecar: f.input as any, rawChunks: f.raw, correctionHistory: 'verified-clear' })
    expect(p.windows.flatMap(w => w.sources).some(s => s.chunkIndex === 0)).toBe(false)
    expect(p.rejected).toContainEqual({ chunkIndexes: [0], reason: 'human_corrected' })
    expect(JSON.stringify(f.input)).toBe(before)
  })
  it.each(cases)('refuses named AND anonymous writes on marked $surface: $marker', ({ surface, marker }) => {
    const f = fixture(); mark(f.input, surface, marker)
    f.plan.expectedDocumentHash = hashMacSpeakerDocument(f.input)
    const before = JSON.stringify(f.input)
    expect(() => projectMacSpeakerRepair(f.input, f.plan)).toThrow(/manual/)
    const anonymous = structuredClone(f.plan)
    for (const a of anonymous.assignments) { a.to = 'Voice 4'; delete a.targetEvidence }
    expect(() => projectMacSpeakerRepair(f.input, anonymous)).toThrow(/manual/)
    expect(JSON.stringify(f.input)).toBe(before)
  })
  it.each(cases)('withdraws named reader support for a marked source $surface: $marker', ({ surface, marker }) => {
    const f = fixture(), p = projectMacSpeakerRepair(f.input, f.plan)
    p.doc.correctionRevision = 1; mark(p.doc, surface, marker)
    p.doc.speakerRepair = { id: f.plan.id, evidenceHash: f.plan.evidenceHash, machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(p.doc), receipt: p.receipt, rawAudioSampleCounts: f.plan.rawAudioSampleCounts } }
    expect(readMacSpeakerMachineEvidence(p.doc)).toMatchObject({ status: 'invalid', reason: 'proof_rejected' })
    expect(readMacSpeakerMachineEvidence(p.doc).positions.size).toBe(0)
  })
  it.each(markers)('protects marked batch speaker words and unlabeled ASR words: %j', marker => {
    const f = fixture(); Object.assign(f.input.batchSegments[0].speakerWords[0], marker); f.plan.expectedDocumentHash = hashMacSpeakerDocument(f.input)
    expect(() => projectMacSpeakerRepair(f.input, f.plan)).toThrow(/manual batch word/)
    const g = fixture(); delete g.input.chunks[0].words[0].speaker; Object.assign(g.input.chunks[0].words[0], marker); g.input.chunkEntries[0].chunk = structuredClone(g.input.chunks[0]); g.plan.expectedDocumentHash = hashMacSpeakerDocument(g.input)
    expect(planMacSpeakerWindows({ sidecar: g.input as any, rawChunks: g.raw, correctionHistory: 'verified-clear' }).windows.flatMap(w => w.sources).some(s => s.chunkIndex === 0)).toBe(false)
    expect(() => projectMacSpeakerRepair(g.input, g.plan)).toThrow(/manual/)
  })
  it('recognizes the full existing marker vocabulary and fails closed on malformed surfaces', () => {
    for (const marker of [{ speakerCorrectionBatchId: 'batch' }, { speakerCorrectionId: 'correction' }, { manualSpeaker: true }, { speakerManuallyAssigned: true }, { confirmedByHuman: true }, { manuallyAssigned: true }, { speakerOrigin: 'human-confirmed' }, { speakerSource: 'manual-correction' }, { speakerPolicy: 'human' }, { speakerProvenance: 'confirmed' }, { source: 'manual' }]) expect(isMacSpeakerHumanProtected(marker)).toBe(true)
    expect(hasMacSpeakerProtectedRows({ words: 'malformed' })).toBe(true)
    expect(hasMacSpeakerProtectedRows({ segments: [null] })).toBe(true)
  })
})

describe('actual saved names-only profile path refuses marker-only legacy manual rows', () => {
  it.each(cases)('preserves $surface $marker without native extraction or sidecar/markdown writes', async ({ surface, marker }) => {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), 'mac-human-protection-')); roots.push(root)
    const audioDir = join(root, 'audio'); mkdirSync(audioDir)
    f.input.sessionId = 'mac_11111111-1111-4111-8111-111111111111'; f.input.finalizationState = 'batch_pending'
    for (const [i, c] of f.input.chunks.entries()) {
      const pcm = Buffer.alloc(192000); pcm.writeInt16LE(i + 1, 0)
      const wav = Buffer.concat([wavHeader(pcm.length), pcm]); writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
      c.audioSha256 = sha(wav); f.input.chunkEntries[i].chunk = structuredClone(c)
    }
    mark(f.input, surface, marker)
    const sidecarPath = join(root, 'capture.json'), meetingPath = join(root, 'capture.md'), modelPath = join(root, 'model.onnx'), profilesPath = join(root, 'profiles.json'), ledgerPath = join(root, 'ledger.jsonl')
    const before = JSON.stringify(f.input), markdown = `## Transcript\n${f.input.batchTranscript}`
    writeFileSync(sidecarPath, before); writeFileSync(meetingPath, markdown); writeFileSync(modelPath, 'synthetic-no-native'); writeFileSync(ledgerPath, '')
    const vector = Array.from({ length: 192 }, (_, i) => Number(i === 0))
    writeFileSync(profilesPath, JSON.stringify({ profiles: [{ name: 'Qualified Person', embeddings: [vector] }] }))
    const extract = vi.fn(async () => [vector, vector, vector])
    const result = await runQualifiedMacProfilePass({ sidecarPath, meetingPath, audioDir }, { runtime: async () => ({ modelPath, profilesPath }), ledgerPath: () => ledgerPath, extract })
    expect(result.status).toBe('skipped'); expect(extract).not.toHaveBeenCalled()
    expect(readFileSync(sidecarPath, 'utf8')).toBe(before); expect(readFileSync(meetingPath, 'utf8')).toBe(markdown)
  })
})
