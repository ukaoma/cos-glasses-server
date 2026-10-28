import { describe, expect, it } from 'vitest'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { hashMacSpeakerDocument, hashMacSpeakerMachineBinding } from './mac-speaker-repair-projection.js'
import { qualifiedMacMachineSidecar as fixture } from './__fixtures__/mac-machine-evidence.js'
import { reviewMeetingSpeakers } from './meeting-speaker-review.js'
import { renderProvenance } from './meeting-scribe-content.js'
const sha = (n: number) => n.toString(16).padStart(64, '0')

function rebind(doc: Record<string, any>) { doc.speakerRepair.machineEvidence.documentBinding = hashMacSpeakerMachineBinding(doc) }
function resign(doc: Record<string, any>) { const { receiptHash: _, ...unsigned } = doc.speakerRepair.machineEvidence.receipt; doc.speakerRepair.machineEvidence.receipt.receiptHash = hashMacSpeakerDocument(unsigned) }

describe('reader-scoped machine assertions preserve original confidence provenance', () => {
  it('validates exact current raw map/receipt and asserts qualified names without faking human or capture scores', () => {
    const doc = fixture(), before = JSON.stringify(doc), read = readMacSpeakerMachineEvidence(doc)
    expect(read.status).toBe('qualified'); expect(read.positions.size).toBe(10)
    const review = reviewMeetingSpeakers(doc.chunks, { machineQualifiedPositions: read.positions, durationMs: doc.durationMs, batchSegments: doc.batchSegments })
    expect(review.voices[0]).toMatchObject({ label: 'Qualified Person', meanSimilarity: null, confirmedByHuman: false, confirmedSegments: 0, machineQualified: true, machineQualifiedSegments: 10, nameAsserted: true, assertionSource: 'qualified-profile', reliability: 'confident' })
    expect(doc.chunks.every((c: any) => c.similarity === 0)).toBe(true)
    expect(JSON.stringify(doc)).toBe(before)
    const provenance = renderProvenance([{ label: 'Qualified Person', asserted: true, speakingMs: 1000, share: 1, isOwner: false, confirmedByHuman: false, machineQualified: true }], 1)
    expect(provenance).toContain('qualified independent long-window profile evidence (not human confirmation)')
    expect(provenance).not.toContain('because a human named')
  })
  it('does not waive confidence for unqualified occurrences of the same name', () => {
    const doc = fixture()
    const extra = { ...structuredClone(doc.chunks[0]), text: 'unqualified extra', elapsed: 60000, audioSha256: sha(9999) }
    doc.chunks.push(extra); doc.chunkEntries.push({ chunkIndex: 10, chunk: structuredClone(extra) }); rebind(doc)
    const read = readMacSpeakerMachineEvidence(doc)
    expect(read.status).toBe('qualified')
    const voice = reviewMeetingSpeakers(doc.chunks, { machineQualifiedPositions: read.positions }).voices[0]
    expect(voice).toMatchObject({ segments: 11, machineQualifiedSegments: 10, machineQualified: false, confirmedByHuman: false, nameAsserted: false })
  })
  it('can combine real capture matches with scoped machine evidence without relabelling their provenance as human', () => {
    const doc = fixture(), extra = { ...structuredClone(doc.chunks[0]), text: 'existing capture', elapsed: 60000, audioSha256: sha(9999), similarity: .9 }
    doc.chunks.push(extra); doc.chunkEntries.push({ chunkIndex: 10, chunk: structuredClone(extra) }); rebind(doc)
    const read = readMacSpeakerMachineEvidence(doc)
    expect(reviewMeetingSpeakers(doc.chunks, { machineQualifiedPositions: read.positions }).voices[0]).toMatchObject({ machineQualified: false, machineQualifiedSegments: 10, nameAsserted: true, assertionSource: 'capture-and-qualified-profile', confirmedByHuman: false, meanSimilarity: .9 })
    expect(renderProvenance([{ label: 'Qualified Person', asserted: true, speakingMs: 1000, share: 1, isOwner: false, confirmedByHuman: false, machineQualifiedSegments: 10 }], 1)).toContain('capture matches plus qualified independent long-window profile evidence')
  })
  it('will not let a positive capture row vouch for a separate unsupported repaired-record occurrence', () => {
    const doc = fixture()
    for (const [offset, score] of [[0, .9], [1, 0]]) {
      const c = { ...structuredClone(doc.chunks[0]), text: `extra ${offset}`, elapsed: 60000 + offset * 6000, audioSha256: sha(9000 + offset), similarity: score }
      doc.chunks.push(c); doc.chunkEntries.push({ chunkIndex: 10 + offset, chunk: structuredClone(c) })
    }
    rebind(doc)
    const read = readMacSpeakerMachineEvidence(doc)
    expect(read.status).toBe('qualified')
    expect(reviewMeetingSpeakers(doc.chunks, { machineEvidenceStatus: read.status, machineQualifiedPositions: read.positions }).voices[0]).toMatchObject({ nameAsserted: false, machineQualifiedSegments: 10 })
    doc.chunks[0].text = 'proof drift'
    const stale = readMacSpeakerMachineEvidence(doc)
    expect(stale.status).toBe('invalid')
    expect(reviewMeetingSpeakers(doc.chunks, { machineEvidenceStatus: stale.status, machineQualifiedPositions: stale.positions }).voices[0]).toMatchObject({ nameAsserted: false, machineQualifiedSegments: 0, meanSimilarity: .9 })
    expect(reviewMeetingSpeakers(doc.chunks, { owner: 'Qualified Person', machineEvidenceStatus: stale.status, machineQualifiedPositions: stale.positions }).voices[0].nameAsserted).toBe(false)
  })
  it.each(['label', 'text', 'time', 'rawhash', 'revision', 'receipt'])('withholds machine claims after %s drift', field => {
    const doc = fixture()
    if (field === 'label') doc.chunks[0].speaker = 'Later Person'
    if (field === 'text') doc.chunks[0].text = 'changed text'
    if (field === 'time') doc.chunks[0].elapsed++
    if (field === 'rawhash') doc.chunks[0].audioSha256 = sha(9999)
    if (field === 'revision') doc.correctionRevision++
    if (field === 'receipt') doc.speakerRepair.machineEvidence.receipt.assignments[0].to = 'Later Person'
    const read = readMacSpeakerMachineEvidence(doc)
    expect(read.status).toBe('invalid'); expect(read.positions.size).toBe(0)
  })
  it('rejects ambiguous raw maps even if someone recomputes the current document binding', () => {
    const doc = fixture(); doc.chunkEntries[1].chunkIndex = 0; rebind(doc)
    expect(readMacSpeakerMachineEvidence(doc)).toMatchObject({ status: 'invalid', reason: 'raw_map_ambiguous' })
    const text = fixture(); text.chunkEntries[1].chunk.text = text.chunkEntries[0].chunk.text; rebind(text)
    expect(readMacSpeakerMachineEvidence(text).status).toBe('invalid')
  })
  it.each(['floor', 'margin', 'repeat', 'source', 'short', 'mixed', 'anonymous_policy'])('revalidates immutable source proof gate %s', bad => {
    const doc = fixture(), proof = doc.speakerRepair.machineEvidence.receipt.assignments[0].targetEvidence
    if (bad === 'floor') proof.windows[0].similarity = .879
    if (bad === 'margin') proof.windows[0].runnerUpSimilarity = .92
    if (bad === 'repeat') proof.windows[1] = structuredClone(proof.windows[0])
    if (bad === 'source') proof.windows[0].rawChunks[0].audioSha256 = sha(9999)
    if (bad === 'short') proof.windows[0].captureEndSample = 32000
    if (bad === 'mixed') { doc.chunks[0].segments[0].speaker = 'Other Person'; doc.chunkEntries[0].chunk.segments[0].speaker = 'Other Person' }
    if (bad === 'anonymous_policy') { doc.chunks[0].speakerPolicy = 'anonymous'; doc.chunkEntries[0].chunk.speakerPolicy = 'anonymous' }
    resign(doc); rebind(doc)
    expect(readMacSpeakerMachineEvidence(doc).status).toBe('invalid')
  })
  it('conservatively invalidates every machine claim after an unrelated human revision', () => {
    const doc = fixture(); doc.correctionRevision++
    const read = readMacSpeakerMachineEvidence(doc)
    expect(read).toMatchObject({ status: 'invalid', reason: 'revision_drift' })
    expect(read.positions.size).toBe(0)
    // Human confirmations still come only from the real correction ledger.
    expect(reviewMeetingSpeakers(doc.chunks, { machineQualifiedPositions: read.positions, confirmed: new Set(['Qualified Person']) }).voices[0]).toMatchObject({ nameAsserted: true, confirmedByHuman: true, machineQualified: false })
  })
  it('preserves qualification through unrelated prose/lifecycle updates', () => {
    const doc = fixture(); doc.summary = 'Later summary'; doc.lifecycleRevision++
    expect(readMacSpeakerMachineEvidence(doc).positions.size).toBe(10)
  })
  it('does not assert a name from an anonymous-only repair receipt', () => {
    const doc = fixture(); for (const a of doc.speakerRepair.machineEvidence.receipt.assignments) delete a.targetEvidence
    resign(doc)
    const read = readMacSpeakerMachineEvidence(doc)
    expect(read.positions.size).toBe(0)
    expect(reviewMeetingSpeakers(doc.chunks, { machineQualifiedPositions: read.positions }).voices[0].nameAsserted).toBe(false)
  })
  it('keeps thrashing-name guard and raw index disagreement even for machine summaries', () => {
    const doc = fixture(), read = readMacSpeakerMachineEvidence(doc)
    const chunks = Array.from({ length: 20 }, (_, i) => ({ ...doc.chunks[0], speaker: i % 2 ? 'Other Person' : 'Qualified Person', text: `turn ${i}`, elapsed: i * 1000 }))
    const proof = read.positions.get(0)!
    const positions = new Map(chunks.map((c, i) => [i, { ...proof, label: c.speaker }]))
    expect(reviewMeetingSpeakers(chunks, { machineQualifiedPositions: positions }).voices.every(v => !v.nameAsserted)).toBe(true)
    const rawMismatch = doc.chunks.map((c: any, i: number) => ({ ...c, chunkIndex: i + 100 }))
    expect(reviewMeetingSpeakers(rawMismatch, { machineQualifiedPositions: read.positions }).voices[0].nameAsserted).toBe(false)
  })
})
