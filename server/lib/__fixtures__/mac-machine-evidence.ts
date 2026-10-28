// Synthetic pure fixture. No profile, audio, native model or production data.
import { hashMacSpeakerDocument, hashMacSpeakerMachineBinding, projectMacSpeakerRepair, type MacProfileMatchEvidence, type MacSpeakerRepairPlan } from '../mac-speaker-repair-projection.js'
const sha = (n: number) => n.toString(16).padStart(64, '0')
export function qualifiedMacMachineSidecar() {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ speaker: 'Voice 1', speakerPolicy: 'high-confidence', text: `speech${i}`, elapsed: i * 6000, audioDurationMs: 6000, audioSha256: sha(i + 1), similarity: 0,
    segments: [{ speaker: 'Voice 1', text: `speech${i}`, startSec: 0, endSec: 6, similarity: 0 }] }))
  const input: Record<string, any> = { sessionId: 'mac_fixture', sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, correctionRevision: 0, lifecycleRevision: 2,
    speakers: [], chunks, chunkEntries: chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk: structuredClone(chunk) })), durationMs: 60000,
    batchTranscript: `[Ext]: ${chunks.map(c => c.text).join(' ')}`, batchSegments: [{ startChunkIdx: 0, endChunkIdx: 9, startElapsed: 0, speakerWords: chunks.map((c, i) => ({ word: c.text, speaker: 'Ext', start: i * 6 + .1, end: i * 6 + .8, similarity: 0 })) }] }
  const targetEvidence: MacProfileMatchEvidence = { kind: 'profile-match', profileName: 'Qualified Person', profileSha256: sha(1000), modelSha256: sha(1001), algorithmVersion: 'frozen-raw-centroid-v1', crossWindowCosines: [[1, .95], [.95, 1]], windows: [0, 1].map(i => ({ id: `whole-window-${i}`, captureStartSample: i * 480000, captureEndSample: (i + 1) * 480000, pcmSha256: sha(2000 + i), similarity: .93, runnerUpSimilarity: .7,
    rawChunks: Array.from({ length: 5 }, (_, j) => ({ rawChunkIndex: i * 5 + j, audioSha256: sha(i * 5 + j + 1), sampleCount: 96000 })) })) }
  const plan: MacSpeakerRepairPlan = { id: 'qualified-fixture', evidenceHash: sha(3000), expectedDocumentHash: hashMacSpeakerDocument(input), protectedRawChunkIndices: [], rawAudioSampleCounts: Object.fromEntries(chunks.map((_, i) => [i, 96000])), assignments: chunks.map((c, i) => ({ rawChunkIndex: i, from: c.speaker, to: 'Qualified Person', evidenceId: 'qualified-whole-windows', targetEvidence: structuredClone(targetEvidence),
    batchWords: [{ segmentIndex: 0, wordIndex: i, word: c.text, from: 'Ext', start: i * 6 + .1, end: i * 6 + .8 }] })) }
  const { doc, receipt } = projectMacSpeakerRepair(input, plan)
  doc.correctionRevision = 1
  doc.speakerRepair = { id: plan.id, evidenceHash: plan.evidenceHash, machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(doc), receipt, rawAudioSampleCounts: plan.rawAudioSampleCounts } }
  return doc
}
