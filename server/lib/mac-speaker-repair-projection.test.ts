import { describe, expect, it, vi } from 'vitest'
// A regression tripwire: this module must never acquire a filesystem writer.
vi.mock('node:fs', () => ({ writeFileSync: vi.fn(() => { throw new Error('live write forbidden') }), renameSync: vi.fn(() => { throw new Error('live write forbidden') }) }))
vi.mock('node:fs/promises', () => ({ writeFile: vi.fn(() => { throw new Error('live write forbidden') }) }))
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { applyMacSpeakerRepair, hashMacSpeakerDocument, hashMacSpeakerMachineBinding, projectMacSpeakerRepair, type MacSpeakerRepairPlan } from './mac-speaker-repair-projection.js'

function fixture(): Record<string, any> {
  const chunk = (speaker: string, text: string, elapsed: number) => ({
    speaker, text, elapsed, audioDurationMs: 2000, similarity: .37, audioSha256: 'immutable-audio',
    originalSpeaker: speaker, speakerPolicy: 'high-confidence',
    words: [{ word: text, start: .1, end: .8 }],
    segments: [{ speaker, text, startSec: .1, endSec: .8, similarity: .29 }],
    finalSegments: [{ speaker, text, startSec: .1, endSec: .8, originalSpeaker: speaker }],
  })
  const chunks = [chunk('Voice 3', 'return first', 0), chunk('Voice 7', 'return later', 99000), chunk('Jane Doe', 'preserve person', 150000)]
  return {
    sourceType: 'mac_system_audio', sessionId: 'mac_fixture', finalizationState: 'complete', claimPending: false,
    correctionRevision: 0, lifecycleRevision: 2, summary: 'Jane owns the decision.', speakers: ['Voice 3', 'Voice 7', 'Jane Doe'],
    chunks, chunkEntries: [{ chunkIndex: 0, chunk: structuredClone(chunks[0]) }, { chunkIndex: 1, chunk: { text: '' } }, { chunkIndex: 2, chunk: structuredClone(chunks[1]) }, { chunkIndex: 3 }, { chunkIndex: 4, chunk: structuredClone(chunks[2]) }],
    batchTranscript: '[Ext]: return first return later\n[Jane Doe]: preserve person',
    batchSegments: [{ startChunkIdx: 0, endChunkIdx: 4, startElapsed: 85000, endElapsed: 999999, text: 'unchanged batch text', words: [{ word: 'return', start: .1, end: .3 }], speakerWords: [
      { word: 'return first', start: .1, end: .8, speaker: 'Ext', similarity: .1, originalSpeaker: 'Ext' },
      { word: 'return later', start: 3.1, end: 3.8, speaker: 'Ext', similarity: .2 },
      { word: 'preserve person', start: 6.1, end: 6.8, speaker: 'Jane Doe', similarity: .9 },
    ] }],
  }
}
function plan(doc: Record<string, any>): MacSpeakerRepairPlan {
  return {
    id: 'repair-fixture-v1', evidenceHash: 'e'.repeat(64), expectedDocumentHash: hashMacSpeakerDocument(doc), protectedRawChunkIndices: [],
    rawAudioSampleCounts: { 0: 32000, 1: 16000, 2: 32000, 3: 16000, 4: 32000 },
    assignments: [0, 1].map((position) => ({
      rawChunkIndex: position * 2, from: doc.chunks[position].speaker, to: 'Voice 1', evidenceId: `independent-evidence-${position}`,
      batchWords: [{ segmentIndex: 0, wordIndex: position, from: 'Ext', word: doc.batchSegments[0].speakerWords[position].word, start: position ? 3.1 : .1, end: position ? 3.8 : .8 }],
    })),
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const row of Object.values(value)) frozen(row) }
  return value
}
function eraseLabels(value: any): any {
  if (Array.isArray(value)) return value.map(eraseLabels)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'speaker' && key !== 'speakers').map(([key, row]) => [key, eraseLabels(row)]))
  return value
}
describe('pure reversible Mac anonymous speaker projection', () => {
  it('projects long-gap recurrence across every label surface without live writes or content mutations', () => {
    const input = frozen(fixture()), request = frozen(plan(input))
    const result = projectMacSpeakerRepair(input, request)
    expect(input.chunks.map((c: any) => c.speaker)).toEqual(['Voice 3', 'Voice 7', 'Jane Doe'])
    expect(result.doc.chunks.map((c: any) => c.speaker)).toEqual(['Voice 1', 'Voice 1', 'Jane Doe'])
    expect(result.doc.chunkEntries[2].chunk.speaker).toBe('Voice 1')
    expect(result.doc.chunks[1].segments[0].speaker).toBe('Voice 1')
    expect(result.doc.chunkEntries[2].chunk.finalSegments[0].speaker).toBe('Voice 1')
    expect(result.doc.batchSegments[0].speakerWords.map((w: any) => w.speaker)).toEqual(['Voice 1', 'Voice 1', 'Jane Doe'])
    expect(result.doc.speakers).toEqual(['Jane Doe'])
    expect(eraseLabels(result.doc)).toEqual(eraseLabels(input))
    expect(result.doc.chunks[0].originalSpeaker).toBe('Voice 3')
    expect(result.doc.batchSegments[0].speakerWords[0].originalSpeaker).toBe('Ext')
    expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.renameSync).not.toHaveBeenCalled(); expect(fsp.writeFile).not.toHaveBeenCalled()
  })
  it('binds exact speech surfaces without circular machine/lifecycle metadata', () => {
    const input=fixture(), initial=hashMacSpeakerMachineBinding(input), metadata=structuredClone(input)
    metadata.speakerRepair={machineEvidence:{documentBinding:initial}};metadata.lifecycleRevision++;metadata.correctionRevision++;metadata.summary='later title prose'
    expect(hashMacSpeakerMachineBinding(metadata)).toBe(initial)
    for (const mutate of [(d:any)=>{d.chunks[0].speaker='later name'},(d:any)=>{d.chunks[0].similarity=.99},(d:any)=>{d.chunkEntries[0].chunkIndex=99},(d:any)=>{d.batchSegments[0].speakerWords[0].start+=.1},(d:any)=>{d.batchTranscript+=' later'}]) {
      const changed=structuredClone(input);mutate(changed);expect(hashMacSpeakerMachineBinding(changed)).not.toBe(initial)
    }
  })
  it('has serializable inverse patches and idempotent apply/undo', () => {
    const input = fixture(), { doc, receipt } = projectMacSpeakerRepair(input, plan(input))
    const saved = JSON.parse(JSON.stringify(receipt))
    expect(applyMacSpeakerRepair(input, saved)).toEqual(doc)
    expect(applyMacSpeakerRepair(doc, saved)).toEqual(doc)
    expect(applyMacSpeakerRepair(doc, saved, 'reverse')).toEqual(input)
    expect(applyMacSpeakerRepair(input, saved, 'reverse')).toEqual(input)
  })
  it('refuses source/profile evidence gaps and stale document preimages', () => {
    const input = fixture(), request = plan(input)
    request.expectedDocumentHash = '0'.repeat(64)
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/CAS mismatch/)
    request.expectedDocumentHash = hashMacSpeakerDocument(input); request.evidenceHash = ''
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/evidence/)
    request.evidenceHash = 'e'.repeat(64); request.assignments[0].evidenceId = ''
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/explicit evidence/)
  })
  it('undo refuses later label, word, lifecycle and unrelated metadata drift', () => {
    const input = fixture(), result = projectMacSpeakerRepair(input, plan(input))
    for (const mutate of [(d: any) => { d.chunks[0].speaker = 'Human corrected' }, (d: any) => { d.chunks[0].text += ' edit' }, (d: any) => { d.lifecycleRevision++ }, (d: any) => { d.summary += ' later' }]) {
      const drift = structuredClone(result.doc); mutate(drift)
      expect(() => applyMacSpeakerRepair(drift, result.receipt, 'reverse')).toThrow(/drift/)
    }
  })
  it('rejects partial states and tampered receipts', () => {
    const input = fixture(), result = projectMacSpeakerRepair(input, plan(input)), partial = structuredClone(input)
    partial.chunks[0].speaker = 'Voice 1'
    expect(() => applyMacSpeakerRepair(partial, result.receipt)).toThrow(/drift/)
    result.receipt.patches[0].after = 'Voice 99'
    expect(() => applyMacSpeakerRepair(input, result.receipt)).toThrow(/integrity/)
  })
  it('rejects mixed turns and disagreeing chunk/entry surfaces', () => {
    const mixed = fixture(); mixed.chunks[0].segments[0].speaker = 'Voice 2'; mixed.chunkEntries[0].chunk = structuredClone(mixed.chunks[0])
    expect(() => projectMacSpeakerRepair(mixed, plan(mixed))).toThrow(/mixed chunk/)
    const inconsistent = fixture(); inconsistent.chunkEntries[0].chunk.finalSegments[0].speaker = 'Voice 2'
    expect(() => projectMacSpeakerRepair(inconsistent, plan(inconsistent))).toThrow(/surfaces disagree/)
  })
  it('preserves named spans and refuses manual markers and ledger-only legacy edits', () => {
    for (const marker of [{ speakerCorrectionBatchId: 'prior' }, { speakerPolicy: 'manual' }, { confirmedByHuman: true }]) {
      const input = fixture(); Object.assign(input.chunks[0].segments[0], marker); input.chunkEntries[0].chunk = structuredClone(input.chunks[0])
      expect(() => projectMacSpeakerRepair(input, plan(input))).toThrow(/manual span/)
    }
    const input = fixture(), request = plan(input); request.protectedRawChunkIndices = [2]
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/ledger-protected/)
    const named = fixture(); named.chunks[0].segments[0].speaker = 'Jane Doe'; named.chunkEntries[0].chunk = structuredClone(named.chunks[0])
    expect(() => projectMacSpeakerRepair(named, plan(named))).toThrow(/named or manual/)
    const batch = fixture(); batch.batchSegments[0].speakerWords[0].speaker = 'Jane Doe'
    expect(() => projectMacSpeakerRepair(batch, plan(batch))).toThrow(/batch word is protected/)
  })
  it('requires exact complete batch coverage and word/time agreement', () => {
    for (const mutate of [(p: MacSpeakerRepairPlan) => { p.assignments[0].batchWords = [] }, (p: MacSpeakerRepairPlan) => { p.assignments[0].batchWords[0].start += .01 }, (p: MacSpeakerRepairPlan) => { p.assignments[0].batchWords[0].word = 'different' }, (p: MacSpeakerRepairPlan) => { p.assignments[0].batchWords[0].from = 'Voice 3' }, (p: MacSpeakerRepairPlan) => { p.assignments[0].batchWords.push(p.assignments[0].batchWords[0]) }]) {
      const input = fixture(), request = plan(input); mutate(request)
      expect(() => projectMacSpeakerRepair(input, request)).toThrow(/coverage|evidence disagrees|duplicate/)
    }
  })
  it('counts silent raw PCM when mapping batch offsets and rejects boundary crossings', () => {
    const input = fixture(), request = plan(input)
    // Second spoken chunk is raw 2, after 2 seconds + 1 silent second,
    // although its elapsed is 99000 and batch startElapsed is 85000.
    expect(projectMacSpeakerRepair(input, request).doc.batchSegments[0].speakerWords[1].speaker).toBe('Voice 1')
    delete request.rawAudioSampleCounts['1']
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/sample count/)
    const boundary = fixture(); boundary.batchSegments[0].speakerWords[0].end = 2.1
    expect(() => projectMacSpeakerRepair(boundary, plan(boundary))).toThrow(/crosses/)
  })
  it('requires explicit withholding for words partly outside qualified spans', () => {
    const input=fixture();input.batchSegments[0].speakerWords[0].end=2.1
    const request=plan(input);request.assignments[0].batchWords=[]
    request.withheldBatchWords=[{segmentIndex:0,wordIndex:0,word:'return first',from:'Ext',start:.1,end:2.1,reason:'outside-qualified-span'}]
    expect(projectMacSpeakerRepair(input,request).doc.batchSegments[0].speakerWords[0].speaker).toBe('Ext')
    request.withheldBatchWords[0].end=.8;input.batchSegments[0].speakerWords[0].end=.8;request.expectedDocumentHash=hashMacSpeakerDocument(input)
    expect(()=>projectMacSpeakerRepair(input,request)).toThrow(/withheld boundary/)
  })
  it('rejects missing raw text mapping, duplicate raw indexes, names as repair targets and active/merged captures', () => {
    const input = fixture(), request = plan(input); request.assignments[0].to = 'Jane Doe'
    expect(() => projectMacSpeakerRepair(input, request)).toThrow(/profile evidence/)
    const wrong = fixture(); wrong.chunkEntries[0].chunk.text = 'different'
    expect(() => projectMacSpeakerRepair(wrong, plan(wrong))).toThrow(/ordered text/)
    const duplicate = fixture(); duplicate.chunkEntries[1].chunkIndex = 0
    expect(() => projectMacSpeakerRepair(duplicate, plan(duplicate))).toThrow(/ordering/)
    for (const change of [{ active: true }, { finalizationState: 'running' }, { sourceSessionIds: ['another'] }, { sourceType: 'merged' }]) {
      const doc = Object.assign(fixture(), change)
      expect(() => projectMacSpeakerRepair(doc, plan(doc))).toThrow(/closed|original Mac/)
    }
  })
})


describe('qualified profile targets', () => {
  function named() {
    const input = fixture(), request = plan(input)
    input.chunks[0].audioSha256 = '1'.repeat(64); input.chunkEntries[0].chunk.audioSha256 = '1'.repeat(64)
    input.chunks[1].audioSha256 = '2'.repeat(64); input.chunkEntries[2].chunk.audioSha256 = '2'.repeat(64)
    for (const position of [0,1]) {
      input.chunks[position].audioDurationMs = 30000
      input.chunks[position].segments[0].endSec = 29.9
      input.chunks[position].finalSegments[0].endSec = 29.9
      input.chunkEntries[position*2].chunk = structuredClone(input.chunks[position])
    }
    input.batchSegments[0].speakerWords[1].start=31.1; input.batchSegments[0].speakerWords[1].end=31.8
    input.batchSegments[0].speakerWords[2].start=62.1; input.batchSegments[0].speakerWords[2].end=62.8
    request.assignments[1].batchWords[0].start=31.1; request.assignments[1].batchWords[0].end=31.8
    request.rawAudioSampleCounts['0']=480000; request.rawAudioSampleCounts['2']=480000
    request.expectedDocumentHash = hashMacSpeakerDocument(input)
    const proof = { kind: 'profile-match' as const, profileName: 'Qualified Person', profileSha256: '3'.repeat(64), modelSha256: '4'.repeat(64), algorithmVersion: 'production-raw-centroid-v1', crossWindowCosines: [[1,.95],[.95,1]], windows: [0,1].map(i => ({ id: `window-${i}`, captureStartSample: input.chunks[i].elapsed * 16, captureEndSample: input.chunks[i].elapsed * 16 + 480000, pcmSha256: String(i+5).repeat(64), similarity: .9, runnerUpSimilarity: .7, rawChunks: [{ rawChunkIndex: i*2, audioSha256: String(i+1).repeat(64), sampleCount: 480000 }] })) }
    for (const assignment of request.assignments) { assignment.to = 'Qualified Person'; assignment.targetEvidence = structuredClone(proof) }
    return { input, request }
  }
  it('names only exact spans supported by two disjoint high-confidence original-window proofs', () => {
    const { input, request } = named(), result = projectMacSpeakerRepair(input, request)
    expect(result.doc.speakers).toEqual(['Qualified Person', 'Jane Doe'])
    expect(result.doc.chunks[0].speaker).toBe('Qualified Person'); expect(result.doc.chunks[2]).toEqual(input.chunks[2])
    expect(result.receipt.assignments[0].targetEvidence).toEqual(request.assignments[0].targetEvidence)
  })
  it('rejects weak, competing, overlapping/repeated or wrong-source evidence', () => {
    for (const mutate of [(p: any) => { p.windows[0].captureEndSample = p.windows[0].captureStartSample + 32000 }, (p: any) => { p.crossWindowCosines = [[1,.84],[.84,1]] }, (p: any) => { p.windows[1].similarity = .879 }, (p: any) => { p.windows[1].runnerUpSimilarity = .89 }, (p: any) => { p.windows[1] = structuredClone(p.windows[0]) }, (p: any) => { p.windows[1].captureStartSample = 1 }, (p: any) => { p.windows[1].rawChunks[0].audioSha256 = 'f'.repeat(64) }, (p: any) => { p.windows[1].rawChunks[0].sampleCount++ }]) {
      const { input, request } = named(); mutate(request.assignments[0].targetEvidence)
      expect(() => projectMacSpeakerRepair(input, request)).toThrow(/evidence/)
    }
  })
})
