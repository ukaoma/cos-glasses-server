import { describe, it, expect } from 'vitest'
import { planMacSpeakerWindows } from './mac-speaker-windows.js'
import { appendMacSpeakerLiveEvidence, createMacSpeakerLiveState, hashMacSpeakerLive, type MacSpeakerLiveEvidence } from './mac-speaker-live-memory.js'
import { planMacSpeakerLiveSave } from './mac-speaker-live-save.js'
import { applyMacSpeakerRepair, projectMacSpeakerRepair } from './mac-speaker-repair-projection.js'
import { boundWords, renderBoundSpeakerLabels } from './mac-speaker-repair-render.js'
const h = hashMacSpeakerLive, captureId = 'mac_11111111-1111-4111-8111-111111111111'
const modelSHA256 = h('model'), profileSHA256 = h('profiles')
const vector = (n = 0) => [Math.cos(n), Math.sin(n), ...Array(190).fill(0)]
function fixture(named = true, split = false) {
  const raw = Array.from({ length: split ? 20 : 10 }, (_, i) => ({ chunkIndex: i, audioSHA256: h(`wav${i}`), pcmSHA256: h(`pcm${i}`), sampleRate: 16000 as const, channels: 1 as const, format: 'pcm_s16le' as const, sampleCount: 96000, verified: true as const }))
  const chunkEntries = raw.map(r => ({ chunkIndex: r.chunkIndex, chunk: { text: `token${r.chunkIndex}`, speaker: 'Voice 1', elapsed: r.chunkIndex * 6000, audioDurationMs: 6000, audioSha256: r.audioSHA256, similarity: 0, speakerPolicy: 'high-confidence' as const, segments: [{ text: `token${r.chunkIndex}`, speaker: 'Voice 1', startSec: 0, endSec: 6, similarity: 0 }] } }))
  const plan = planMacSpeakerWindows({ sidecar: { sessionId: captureId, chunkEntries }, rawChunks: raw, correctionHistory: 'verified-clear' })
  const profiles = named ? [{ name: 'Avery Sample', embeddings: [vector()], profileSHA256 }, { name: 'Blake Sample', embeddings: [vector(Math.PI / 2)], profileSHA256 }] : []
  let state = createMacSpeakerLiveState(captureId, 'generation', modelSHA256, profileSHA256, 1)
  for (const window of plan.windows) {
    const angle = split && window.startSample >= 960000 ? Math.PI / 2 : 0
    const receipt = { windowId: window.id, windowBindingSHA256: window.bindingSHA256, modelSHA256, audioSHA256: h(`aggregate${window.id}`), pcmSHA256: h(`aggregatePCM${window.id}`), sampleCount: window.sampleCount, embedding: vector(angle), halfEmbeddings: [vector(angle), vector(angle)] as const }
    const e: MacSpeakerLiveEvidence = { window, receipt, nativeReceiptSHA256: h({ window, receipt }) }
    state = appendMacSpeakerLiveEvidence(state, e, profiles)
  }
  const doc = { sessionId: captureId, finalizationState: 'complete', sourceType: 'mac_system_audio', batchApplied: true, chunkEntries, chunks: chunkEntries.map(e => structuredClone(e.chunk)), batchSegments: [{ startChunkIdx: 0, endChunkIdx: raw.length - 1, speakerWords: raw.map(r => ({ word: `token${r.chunkIndex}`, speaker: 'Voice 1', start: r.chunkIndex * 6, end: r.chunkIndex * 6 + 1 })) }], batchTranscript: `[Voice 1]: ${raw.map(r => `token${r.chunkIndex}`).join(' ')}`, speakers: [] }
  return { doc, state, profiles, rawAudioSampleCounts: Object.fromEntries(raw.map(r => [r.chunkIndex, r.sampleCount])), correctionHistoryClear: true }
}
describe('live-to-saved Mac speaker evidence bridge', () => {
  it('projects the same existing profile into all label surfaces and preserves every spoken token, time, original and rollback', () => {
    const input = fixture(), before = structuredClone(input)
    const plan = planMacSpeakerLiveSave(input), result = projectMacSpeakerRepair(input.doc, plan)
    expect(plan.assignments).toHaveLength(10)
    expect(plan.assignments.every(a => a.targetEvidence?.windows.length === 2)).toBe(true)
    expect(result.doc.chunks.every((c: any) => c.speaker === 'Avery Sample' && c.segments[0].speaker === 'Avery Sample')).toBe(true)
    expect(result.doc.batchSegments[0].speakerWords.every((w: any) => w.speaker === 'Avery Sample')).toBe(true)
    const words = boundWords(input.doc, result.doc)
    expect(renderBoundSpeakerLabels(input.doc.batchTranscript, words)).toBe(input.doc.batchTranscript.replace('[Voice 1]', '[Avery Sample]'))
    expect(applyMacSpeakerRepair(result.doc, result.receipt, 'reverse')).toEqual(input.doc)
    expect(input).toEqual(before)
    for (const [i, c] of result.doc.chunks.entries()) {
      expect({ ...c, speaker: input.doc.chunks[i].speaker, segments: input.doc.chunks[i].segments }).toEqual(input.doc.chunks[i])
    }
  })
  it('uses a noncolliding anonymous identity without inventing a profile', () => {
    const input = fixture(false), plan = planMacSpeakerLiveSave(input)
    expect(plan.assignments.every(a => a.to === 'Voice 2' && a.targetEvidence === undefined)).toBe(true)
  })
  it('refuses human history, prior machine receipts, pending captures and changed raw geometry', () => {
    const input = fixture()
    expect(() => planMacSpeakerLiveSave({ ...input, correctionHistoryClear: false })).toThrow('human history')
    for (const patch of [{ speakerRepair: {} }, { correctionRevision: 1 }, { finalizationState: 'batch_pending' }, { active: true }]) {
      expect(() => planMacSpeakerLiveSave({ ...input, doc: { ...input.doc, ...patch } })).toThrow()
    }
    const changed = structuredClone(input); changed.doc.chunkEntries[0].chunk.audioSha256 = h('changed')
    expect(() => planMacSpeakerLiveSave(changed)).toThrow('originals changed')
    const clock = structuredClone(input); clock.rawAudioSampleCounts['0']++
    expect(() => planMacSpeakerLiveSave(clock)).toThrow()
  })
  it('refuses stale profile cohorts and forged well-shaped profile claims', () => {
    const input = fixture()
    expect(() => planMacSpeakerLiveSave({ ...input, profiles: input.profiles.map(p => ({ ...p, profileSHA256: h('changed') })) })).toThrow()
    const forged = structuredClone(input)
    for (const p of forged.state.projections) p.displayLabel = p.profileName = 'Blake Sample'
    const { stateSHA256: _, ...body } = forged.state; forged.state.stateSHA256 = h(body)
    expect(() => planMacSpeakerLiveSave(forged)).toThrow('stale identity')
  })
  it('replays receipt membership rather than trusting a resealed but swapped cohort', () => {
    const input = fixture(true, true)
    expect(input.state.evidence.map(e => e.cohortId)).toEqual([1, 1, 2, 2])
    for (const e of input.state.evidence) e.cohortId = e.cohortId === 1 ? 2 : 1
    input.state.projections = []
    const { stateSHA256: _, ...body } = input.state; input.state.stateSHA256 = h(body)
    expect(() => planMacSpeakerLiveSave(input)).toThrow(/receipt.membership/)
  })
  it('refuses mixed named nested spans and missing or crossing canonical words', () => {
    const input = fixture()
    const mixed = structuredClone(input); mixed.doc.chunkEntries[0].chunk.segments[0].speaker = 'Human Correction'
    expect(() => planMacSpeakerLiveSave(mixed)).toThrow()
    const words = structuredClone(input); (words.doc.batchSegments[0] as any).speakerWords = undefined
    expect(() => planMacSpeakerLiveSave(words)).toThrow('batch geometry')
    const range = structuredClone(input); range.doc.batchSegments[0].speakerWords[0].end = 1000
    expect(() => planMacSpeakerLiveSave(range)).toThrow('word clock')
  })
})
