import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashMacSpeakerDocument, hashMacSpeakerMachineBinding } from '../lib/mac-speaker-repair-projection.js'
import { executeMacSpeakerRepair, macSpeakerRepairMain, prepareMacSpeakerRepair, previewMacSpeakerRepair, renderSparseBoundSpeakerLabels, renderTruncatedBoundSpeakerLabels, type MacRepairManifest } from './mac-speaker-repair.js'
const roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
function wav(seed: number) {
  const bytes = Buffer.alloc(44 + 64000)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(64000, 40); bytes.writeInt16LE(seed, 44)
  return bytes
}
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-speaker-repair-test-'))); roots.push(root)
  writeFileSync(join(root, '.mac-speaker-repair-offline.json'), JSON.stringify({ kind: 'cos-mac-speaker-repair-offline', version: 1 }), { mode: 0o600 })
  const audioFiles = [0, 1].map(rawChunkIndex => { const bytes = wav(rawChunkIndex + 1), path = join(root, `raw-${rawChunkIndex}.wav`); writeFileSync(path, bytes); return { rawChunkIndex, path, sha256: sha(bytes) } })
  const proofPath = join(root, 'proof.json'); writeFileSync(proofPath, '{"evidence":"frozen"}')
  const chunks = [0, 1].map(i => ({ text: i ? 'beta later' : 'alpha first', speaker: i ? 'Voice 7' : 'Voice 3', elapsed: i * 2000, audioDurationMs: 2000, audioSha256: audioFiles[i].sha256, similarity: .12, words: [{ word: i ? 'beta later' : 'alpha first', start: .1, end: .8 }], segments: [{ text: i ? 'beta later' : 'alpha first', speaker: i ? 'Voice 7' : 'Voice 3', startSec: .1, endSec: .8, similarity: .21 }] }))
  const before = { sourceType: 'mac_system_audio', sessionId: 'mac_fixture', finalizationState: 'complete', claimPending: false, batchApplied: true, lifecycleRevision: 2, correctionRevision: 0, summary: 'Unchanged prose.', speakers: ['Voice 3', 'Voice 7'], chunks, chunkEntries: chunks.map((chunk, chunkIndex) => ({ chunkIndex, chunk: structuredClone(chunk) })), batchTranscript: '[Ext]: alpha first beta later', batchSegments: [{ startChunkIdx: 0, endChunkIdx: 1, startElapsed: 99000, speakerWords: [{ word: 'alpha', start: .1, end: .3, speaker: 'Ext', similarity: .1 }, { word: 'first', start: .3, end: .8, speaker: 'Ext', similarity: .1 }, { word: 'beta', start: 2.1, end: 2.3, speaker: 'Ext', similarity: .1 }, { word: 'later', start: 2.3, end: 2.8, speaker: 'Ext', similarity: .1 }] }], diarization: { engine: 'nemotron3', status: 'applied', channelMap: { 0: 'Voice 3' }, outputSha256: 'old' } }
  const manifest: MacRepairManifest = {
    version: 1, id: 'fixture-repair-1', at: '2026-10-28T20:00:00.000Z', evidenceHash: sha(readFileSync(proofPath)), offlineRoot: root,
    preconditions: [{ path: proofPath, sha256: sha(readFileSync(proofPath)) }], audioFiles,
    copies: (['local', 'operations'] as const).map((copy, ci) => {
      const doc = structuredClone(before); doc.lifecycleRevision += ci
      const sidecar = join(root, `${copy}.g2-chunks.json`), markdown = join(root, `${copy}.md`)
      writeFileSync(sidecar, JSON.stringify(doc, null, 2) + '\n'); writeFileSync(markdown, '# fixture\n\n## Summary\nUnchanged prose.\n\n## Transcript\n\n[Ext]: alpha first beta later\n')
      return { copy, sidecar: { path: sidecar, sha256: sha(readFileSync(sidecar)) }, markdown: { path: markdown, sha256: sha(readFileSync(markdown)) }, ledger: { path: join(root, `${copy}.corrections.jsonl`), sha256: null }, plan: { id: 'fixture-repair-1', evidenceHash: sha(readFileSync(proofPath)), expectedDocumentHash: hashMacSpeakerDocument(doc), protectedRawChunkIndices: [], rawAudioSampleCounts: { 0: 32000, 1: 32000 }, assignments: [{ rawChunkIndex: 0, from: 'Voice 3', to: 'Voice 1', evidenceId: 'independent-proof', batchWords: [{ segmentIndex: 0, wordIndex: 0, from: 'Ext', word: 'alpha', start: .1, end: .3 }, { segmentIndex: 0, wordIndex: 1, from: 'Ext', word: 'first', start: .3, end: .8 }] }] } }
    }),
  }
  return { root, manifest, before, transaction: join(root, 'transaction') }
}
function targetHashes(manifest: MacRepairManifest) { return manifest.copies.flatMap(copy => [copy.sidecar, copy.markdown]).map(file => sha(readFileSync(file.path))) }

describe('offline Mac speaker repair transaction', () => {
  it('defaults to zero-write preview and preserves all input bytes', () => {
    const { root, manifest } = setup(), initial = targetHashes(manifest), files = readdirSync(root).sort()
    const preview = previewMacSpeakerRepair(manifest)
    expect(targetHashes(manifest)).toEqual(initial); expect(readdirSync(root).sort()).toEqual(files)
    expect(preview.transaction.state).toBe('prepared'); expect(preview.summary.offlineOnly).toBe(true)
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest)); const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    macSpeakerRepairMain(['--manifest', manifestPath])
    expect(JSON.parse(log.mock.calls[0][0]).mode).toBe('dry-run'); expect(targetHashes(manifest)).toEqual(initial)
  })
  it('durably saves private exact before-images, applies all copies coherently and supports exact undo', () => {
    const { manifest, transaction } = setup(), initial = targetHashes(manifest)
    const preview = prepareMacSpeakerRepair(manifest, transaction)
    expect(statSync(transaction).mode & 0o777).toBe(0o700)
    for (const image of preview.images) { expect(readFileSync(join(transaction, image.name), 'utf8')).toBe(image.bytes); expect(statSync(join(transaction, image.name)).mode & 0o777).toBe(0o600) }
    expect(targetHashes(manifest)).toEqual(initial)
    expect(executeMacSpeakerRepair(transaction, 'apply').state).toBe('applied')
    for (const [index, copy] of manifest.copies.entries()) {
      const after = JSON.parse(readFileSync(copy.sidecar.path, 'utf8'))
      expect(after.chunks[0].speaker).toBe('Voice 1'); expect(after.chunks[1].speaker).toBe('Voice 7')
      expect(after.batchTranscript).toContain('[Voice 1]: alpha first'); expect(after.batchTranscript).toContain('[Ext]: beta later')
      expect(after.lifecycleRevision).toBe(3 + index); expect(after.correctionRevision).toBe(1)
      expect(after.diarization.outputSha256).toBe(sha(after.batchTranscript)); expect(after.diarization.channelMap).toBeUndefined()
      const machine=after.speakerRepair.machineEvidence
      expect(machine.version).toBe(1);expect(machine.correctionRevision).toBe(after.correctionRevision)
      expect(machine.documentBinding).toBe(hashMacSpeakerMachineBinding(after))
      expect(machine.receipt.assignments).toEqual(manifest.copies[index].plan.assignments)
      expect(machine.rawAudioSampleCounts).toEqual(manifest.copies[index].plan.rawAudioSampleCounts)
      expect(after.chunks[0].similarity).toBe(.12)
      expect(after.summary).toBe('Unchanged prose.'); expect(after.speakers).toEqual([])
      const md = readFileSync(copy.markdown.path, 'utf8'); expect(md).toContain('## Summary\nUnchanged prose.'); expect(md).toContain('[Voice 1]: alpha first')
    }
    expect(executeMacSpeakerRepair(transaction, 'apply').state).toBe('applied')
    expect(executeMacSpeakerRepair(transaction, 'undo').state).toBe('reverted'); expect(targetHashes(manifest)).toEqual(initial)
    expect(executeMacSpeakerRepair(transaction, 'undo').state).toBe('reverted')
  })
  it('refuses stale local/operations copies, evidence drift, audio drift and active captures before writing', () => {
    for (const which of ['local', 'operations', 'proof', 'audio', 'active'] as const) {
      const { manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction)
      if (which === 'proof') writeFileSync(manifest.preconditions[0].path, 'drift')
      else if (which === 'audio') writeFileSync(manifest.audioFiles[0].path, wav(90))
      else { const file = manifest.copies[which === 'operations' ? 1 : 0].sidecar.path; const doc = JSON.parse(readFileSync(file, 'utf8')); if (which === 'active') doc.active = true; else doc.summary += ' later'; writeFileSync(file, JSON.stringify(doc)) }
      const beforeAttempt = targetHashes(manifest)
      expect(() => executeMacSpeakerRepair(transaction, 'apply')).toThrow(/drift|active/); expect(targetHashes(manifest)).toEqual(beforeAttempt)
    }
  })
  it('records partial failure, refuses silent replay and explicitly resumes or reverses safely', () => {
    const { manifest, transaction } = setup(), initial = targetHashes(manifest); prepareMacSpeakerRepair(manifest, transaction)
    expect(() => executeMacSpeakerRepair(transaction, 'apply', { beforeWrite: index => { if (index === 1) throw new Error('simulated disk failure') } })).toThrow(/disk failure/)
    expect(JSON.parse(readFileSync(join(transaction, 'transaction.json'), 'utf8')).state).toBe('partial')
    expect(() => executeMacSpeakerRepair(transaction, 'apply')).toThrow(/explicit --resume/)
    expect(executeMacSpeakerRepair(transaction, 'apply', { resume: true }).state).toBe('applied')
    expect(executeMacSpeakerRepair(transaction, 'undo').state).toBe('reverted'); expect(targetHashes(manifest)).toEqual(initial)
  })
  it('undo refuses later user edits without restoring any other file', () => {
    const { manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction); executeMacSpeakerRepair(transaction, 'apply')
    writeFileSync(manifest.copies[1].markdown.path, readFileSync(manifest.copies[1].markdown.path, 'utf8') + '\nHuman note\n')
    const later = targetHashes(manifest); expect(() => executeMacSpeakerRepair(transaction, 'undo')).toThrow(/later edit/); expect(targetHashes(manifest)).toEqual(later)
  })
  it('checks all remaining file CAS immediately before each write', () => {
    const { manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction)
    expect(() => executeMacSpeakerRepair(transaction, 'apply', { beforeWrite: index => { if (index === 1) writeFileSync(manifest.copies[1].sidecar.path, 'external concurrent edit') } })).toThrow(/immediately before/)
    expect(readFileSync(manifest.copies[1].sidecar.path, 'utf8')).toBe('external concurrent edit')
  })
  it('detects drift of an already-published file and marks transaction partial', () => {
    const { manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction)
    expect(() => executeMacSpeakerRepair(transaction, 'apply', { beforeWrite: index => { if(index===2) writeFileSync(manifest.copies[0].sidecar.path,'later user edit') } })).toThrow(/completed copy drift/)
    expect(readFileSync(manifest.copies[0].sidecar.path,'utf8')).toBe('later user edit')
    expect(JSON.parse(readFileSync(join(transaction,'transaction.json'),'utf8')).state).toBe('partial')
  })
  it('can explicitly reclaim a dead offline lock, and refuses symlink transaction parents', () => {
    const { root, manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction)
    writeFileSync(join(root,'.mac-speaker-repair.lock'),JSON.stringify({pid:2147483647}))
    expect(executeMacSpeakerRepair(transaction,'apply',{resume:true}).state).toBe('applied')
    const other=setup(), link=join(other.root,'link');symlinkSync(root,link)
    expect(()=>prepareMacSpeakerRepair(other.manifest,join(link,'outside-transaction'))).toThrow(/parent symlink/)
    expect(existsSync(join(root,'outside-transaction'))).toBe(false)
  })
  it('refuses legacy ledger-only correction, incomplete intent, or divergent copy mappings', () => {
    for (const phase of ['confirmed-chunks', 'intent']) {
      const { manifest } = setup(), ledger = manifest.copies[0].ledger
      writeFileSync(ledger.path, JSON.stringify({ id: 'prior', phase, chunks: [0] }) + '\n'); ledger.sha256 = sha(readFileSync(ledger.path))
      expect(() => previewMacSpeakerRepair(manifest)).toThrow(/protected|incomplete prior/)
    }
    const { manifest } = setup(); manifest.copies[1].plan.assignments[0].to = 'Voice 2'
    expect(() => previewMacSpeakerRepair(manifest)).toThrow(/mappings disagree/)
  })
  it('refuses image tampering, symlink targets, occupied lock and missing offline assertion', () => {
    const { root, manifest, transaction } = setup(); prepareMacSpeakerRepair(manifest, transaction)
    writeFileSync(join(transaction, '0-sidecar.after'), 'tamper'); expect(() => executeMacSpeakerRepair(transaction, 'apply')).toThrow(/image drift/)
    const symlink = join(root, 'symlink.md'); symlinkSync(manifest.copies[0].markdown.path, symlink); manifest.copies[0].markdown.path = symlink
    expect(() => previewMacSpeakerRepair(manifest)).toThrow(/symlink/)
    writeFileSync(join(root, '.mac-speaker-repair.lock'), 'occupied'); expect(() => executeMacSpeakerRepair(transaction, 'undo')).toThrow()
    const missing = setup(); rmSync(join(missing.root, '.mac-speaker-repair-offline.json'))
    expect(() => previewMacSpeakerRepair(missing.manifest)).toThrow()
  })
  it('allows omitted unaffected lines only with complete unique proof for changed full lines', () => {
    const words = ['omitted', 'unaffected', 'precisely', 'bound', 'tail'].map((word, i) => ({ word, before: 'Ext', after: i >= 2 ? 'Named Profile' : 'Ext' }))
    expect(renderSparseBoundSpeakerLabels('[Unknown]: unrelated saved line\n[Ext]: precisely  bound tail\n', words)).toBe('[Unknown]: unrelated saved line\n[Named Profile]: precisely  bound tail\n')
    expect(() => renderSparseBoundSpeakerLabels('[Ext]: precisely bound\n', words)).toThrow(/lack unique complete/)
    expect(renderTruncatedBoundSpeakerLabels('[Ext]: omitted unaf\n... [Transcript truncated for length]\nfooter', words)).toBe('[Ext]: omitted unaf\n... [Transcript truncated for length]\nfooter')
    expect(() => renderTruncatedBoundSpeakerLabels('[Ext]: omitted precisely\n... [Transcript truncated for length]', words)).toThrow(/exact canonical prefix/)
    const repeated = [...words.slice(2), ...words.slice(2)]
    expect(() => renderSparseBoundSpeakerLabels('[Ext]: precisely bound tail', repeated)).toThrow(/ambiguous/)
  })
})
