import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { qualifiedMacMachineSidecar } from './__fixtures__/mac-machine-evidence.js'
import { wavHeader } from './nemotron-segments.js'
import { runQualifiedMacProfilePass, selectQualifiedProfileWindows, type QualifiedMacProfileDeps } from './mac-speaker-profile-finalizer.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { markCanonicalFinalizationState } from './meeting-finalization-jobs.js'
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const vector = (i = 0) => Array.from({ length: 192 }, (_, j) => Number(i === j))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mac-profile-final-')); roots.push(root)
  const audioDir = join(root, 'pending-batch', 'capture'); mkdirSync(audioDir, { recursive: true })
  const recordings = join(root, 'recordings'); mkdirSync(recordings)
  const doc = qualifiedMacMachineSidecar(); doc.sessionId = 'mac_11111111-1111-4111-8111-111111111111'
  const receipt = doc.speakerRepair.machineEvidence.receipt
  // Restore only label preimages to create a realistic automatic capture.
  for (const patch of [...receipt.patches].reverse()) { let row = doc; for (const key of patch.path.slice(0, -1)) row = row[key]; row[patch.path.at(-1)!] = patch.before }
  doc.batchSegments[0].text = doc.chunks.map((c: any) => c.text).join(' ')
  doc.batchSegments[0].startSec = 0; doc.batchSegments[0].endSec = 60
  delete doc.speakerRepair; doc.correctionRevision = 0; doc.finalizationState = 'batch_pending'
  const modelPath = join(root, 'model.onnx'), profilesPath = join(root, 'voice-profiles.json'), ledger = join(root, 'ledger.jsonl')
  writeFileSync(modelPath, 'synthetic-model-no-native')
  writeFileSync(profilesPath, JSON.stringify({ profiles: [{ name: 'Qualified Person', embeddings: [vector()] }, { name: 'Other Person', embeddings: [vector(1)] }] }))
  for (let i = 0; i < doc.chunks.length; i++) {
    const pcm = Buffer.alloc(192000); for (let n = 0; n < pcm.length / 2; n++) pcm.writeInt16LE((n + 1) % (100 + i), n * 2)
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]); writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    doc.chunks[i].audioSha256 = hash(wav); doc.chunkEntries[i].chunk.audioSha256 = hash(wav)
  }
  const sidecarPath = join(recordings, 'capture.g2-chunks.json'), meetingPath = join(recordings, 'capture.md')
  writeFileSync(sidecarPath, JSON.stringify(doc)); writeFileSync(meetingPath, `# Capture\n\n## Transcript\n\n${doc.batchTranscript}\n`)
  const extract = vi.fn(async () => [vector(), vector(), vector()])
  const deps: QualifiedMacProfileDeps = { runtime: async () => ({ modelPath, profilesPath }), extract, ledgerPath: () => ledger }
  return { root, doc, input: { sidecarPath, meetingPath, audioDir }, deps, extract, modelPath, profilesPath, ledger }
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
describe('future Mac qualified profile finalization', () => {
  it('accepts an actual-shaped97-profile dense snapshot above8MiB across initial, commit and crash-recovery reads', async () => {
    const f = fixture()
    const profiles = Array.from({ length: 97 }, (_, i) => ({ name: i === 0 ? 'Qualified Person' : `Frozen Person ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`, embeddings: Array.from({ length: 20 }, () => Array.from({ length: 192 }, (_, j) => j === i ? 1 : .001234567891234)) }))
    const bytes = JSON.stringify({ profiles }, null, 2)
    expect(Buffer.byteLength(bytes)).toBeGreaterThan(8 * 1024 * 1024)
    expect(Buffer.byteLength(bytes)).toBeLessThan(32 * 1024 * 1024)
    writeFileSync(f.profilesPath, bytes)
    f.deps.afterWrite = () => { throw Error('death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow('death')
    delete f.deps.afterWrite
    expect((await runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).status).toBe('applied')
    expect(f.extract).toHaveBeenCalledTimes(2)
  })
  it('spreads the12-window budget across the complete call in independent pairs', () => {
    const all = Array.from({ length: 100 }, (_, i) => i), selected = selectQualifiedProfileWindows(all)
    expect(selected).toHaveLength(12); expect(selected.slice(0, 2)).toEqual([0, 1]); expect(selected.slice(-2)).toEqual([98, 99])
    for (let i = 0; i < selected.length; i += 2) expect(selected[i + 1]).toBe(selected[i] + 1)
  })
  it.each([8, 33])('accepts frozen capture-shaped %i unhashed ASR placeholders without treating them as identity evidence', async count => {
    const f = fixture(), d = f.doc
    for (let i = 9; i >= 5; i--) {
      const oldPath = join(f.input.audioDir, `chunk_${String(i).padStart(4, '0')}.wav`)
      writeFileSync(join(f.input.audioDir, `chunk_${String(i + count).padStart(4, '0')}.wav`), readFileSync(oldPath))
      d.chunks[i].elapsed += count * 6000; d.chunkEntries[i].chunk.elapsed += count * 6000; d.chunkEntries[i].chunkIndex += count
      d.batchSegments[0].speakerWords[i].start += count * 6; d.batchSegments[0].speakerWords[i].end += count * 6
    }
    const placeholders = Array.from({ length: count }, (_, j) => {
      const raw = 5 + j, pcm = Buffer.alloc(192000, j + 20)
      writeFileSync(join(f.input.audioDir, `chunk_${String(raw).padStart(4, '0')}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]))
      // Frozen natural shape: no audioSha256/audioDurationMs/segments on empty ASR entries.
      return { chunkIndex: raw, chunk: { text: '', speaker: 'Ext', elapsed: raw * 6000, similarity: 0, backend: 'local', asrProvider: 'parakeet', model: 'parakeet', latencyMs: 0 } }
    })
    d.chunkEntries.splice(5, 0, ...placeholders); d.batchSegments[0].endChunkIdx += count; d.durationMs += count * 6000
    writeFileSync(f.input.sidecarPath, JSON.stringify(d))
    expect(await runQualifiedMacProfilePass(f.input, f.deps)).toMatchObject({ status: 'applied', assignments: 10 })
    markCanonicalFinalizationState(f.input.sidecarPath, 'complete', false)
    const result = readMacSpeakerMachineEvidence(read(f.input.sidecarPath))
    expect(result.status).toBe('qualified'); expect(result.positions.size).toBe(10)
    expect([...result.positions.values()].some(p => p.rawChunkIndex >= 5 && p.rawChunkIndex < 5 + count)).toBe(false)
  })
  it('rejects a corrupted prepared afterimage before resuming any write', async () => {
    const f = fixture(); f.deps.afterWrite = () => { throw Error('death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow()
    const path = `${f.input.sidecarPath}.speaker-profile-pass.json`, journal = read(path)
    const bad = JSON.parse(journal.images[1].after); bad.chunks[0].text = 'must not overwrite source text'
    journal.images[1].after = JSON.stringify(bad); writeFileSync(path, JSON.stringify(journal))
    delete f.deps.afterWrite
    await expect(runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).rejects.toThrow('integrity')
    expect(read(f.input.sidecarPath).chunks[0].text).toBe('speech0')
  })
  it('applies exact two-window names without changing capture scores/human state, then survives final complete and copied sidecars', async () => {
    const f = fixture()
    expect(await runQualifiedMacProfilePass(f.input, f.deps)).toMatchObject({ status: 'applied', assignments: 10 })
    expect(f.extract).toHaveBeenCalledTimes(2)
    expect(readMacSpeakerMachineEvidence(read(f.input.sidecarPath)).status).toBe('invalid') // staging is not a closed public claim
    markCanonicalFinalizationState(f.input.sidecarPath, 'complete', false)
    for (const copy of ['local-copy', 'operations-copy']) {
      const path = join(f.root, `${copy}.json`); copyFileSync(f.input.sidecarPath, path)
      const doc = read(path), result = readMacSpeakerMachineEvidence(doc)
      expect(result.status).toBe('qualified'); expect(result.positions.size).toBe(10)
      expect(doc.chunks.every((c: any) => c.similarity === 0 && !c.confirmedByHuman)).toBe(true)
      expect(doc.chunks.every((c: any) => c.speaker === 'Qualified Person')).toBe(true)
    }
    expect((await runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).reason).toBe('already_applied')
    expect(f.extract).toHaveBeenCalledTimes(2)
  })
  it.each(['profile', 'model', 'ledger', 'source', 'raw'])('refuses %s drift before writes', async field => {
    const f = fixture(), before = readFileSync(f.input.meetingPath, 'utf8')
    f.deps.beforeCommit = () => {
      if (field === 'profile') writeFileSync(f.profilesPath, '{}')
      if (field === 'model') writeFileSync(f.modelPath, 'changed')
      if (field === 'ledger') writeFileSync(f.ledger, 'human correction intent')
      if (field === 'source') { const d = read(f.input.sidecarPath); d.supersededBy = 'mac_other'; writeFileSync(f.input.sidecarPath, JSON.stringify(d)) }
      if (field === 'raw') writeFileSync(join(f.input.audioDir, 'chunk_0000.wav'), 'changed')
    }
    expect((await runQualifiedMacProfilePass(f.input, f.deps)).status).toBe('skipped')
    expect(readFileSync(f.input.meetingPath, 'utf8')).toBe(before)
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
    await runQualifiedMacProfilePass(f.input, f.deps)
    expect(f.extract).toHaveBeenCalledTimes(2) // durable attempted marker, no duplicate native work
  })
  it.each(['manual', 'superseded', 'ledger'])('protects existing %s evidence before extraction', async field => {
    const f = fixture()
    if (field === 'manual') { f.doc.correctionRevision = 1; writeFileSync(f.input.sidecarPath, JSON.stringify(f.doc)) }
    if (field === 'superseded') { f.doc.supersededBy = 'mac_other'; writeFileSync(f.input.sidecarPath, JSON.stringify(f.doc)) }
    if (field === 'ledger') writeFileSync(f.ledger, '{"phase":"intent"}')
    expect((await runQualifiedMacProfilePass(f.input, f.deps)).status).toBe('skipped')
    expect(f.extract).not.toHaveBeenCalled()
  })
  it('resumes a torn two-file commit before ASR, without repeating extraction', async () => {
    const f = fixture(); f.deps.afterWrite = i => { if (i === 0) throw Error('simulated death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow('simulated death')
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
    expect(readFileSync(f.input.meetingPath, 'utf8')).toContain('[Qualified Person]')
    delete f.deps.afterWrite
    expect((await runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).status).toBe('applied')
    expect(f.extract).toHaveBeenCalledTimes(2)
    expect(read(f.input.sidecarPath).speakerRepair.machineEvidence).toBeTruthy()
  })
  it.each(['profile', 'model'])('refuses changed %s on crash resume', async field => {
    const f = fixture(); f.deps.afterWrite = () => { throw Error('death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow()
    writeFileSync(field === 'profile' ? f.profilesPath : f.modelPath, 'changed')
    delete f.deps.afterWrite
    await expect(runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).rejects.toThrow('profile/model drift')
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
    expect(f.extract).toHaveBeenCalledTimes(2)
  })
  it('blocks finalizer filing after a partial commit even when the pending audio vanished', async () => {
    const f = fixture(); f.deps.afterWrite = () => { throw Error('death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow()
    delete f.deps.afterWrite; rmSync(f.input.audioDir, { recursive: true })
    const { scheduleFinalizationJob } = await import('../routes/meeting.js')
    const { MeetingFinalizationJobStore } = await import('./meeting-finalization-jobs.js')
    const jobs = new MeetingFinalizationJobStore(join(f.root, 'meeting-finalization-jobs'))
    const job = jobs.save({ ...f.input, sessionId: f.doc.sessionId, streamingWordCount: 10, phase: 'batch_pending', claimPending: false })
    const background: Promise<void>[] = [], asr = vi.fn(async () => { throw Error('ASR cannot run') })
    scheduleFinalizationJob(job, { finalizationJobs: jobs, runBatch: asr, scheduleBackground: task => { background.push(task) }, qualifiedProfilePass: input => runQualifiedMacProfilePass(input, f.deps) })
    await Promise.all(background)
    expect(asr).not.toHaveBeenCalled()
    expect(jobs.get(f.doc.sessionId)).toMatchObject({ phase: 'batch_pending', claimPending: false })
    expect(jobs.get(f.doc.sessionId)?.lastError).toBeTruthy()
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
    expect(read(f.input.sidecarPath).finalizationState).toBe('batch_pending')
  }, 30000)
  it('will not overwrite a correction after a partial publication', async () => {
    const f = fixture(); f.deps.afterWrite = () => { throw Error('death') }
    await expect(runQualifiedMacProfilePass(f.input, f.deps)).rejects.toThrow()
    writeFileSync(f.input.sidecarPath, '{"manual":"preserve me"}')
    delete f.deps.afterWrite
    await expect(runQualifiedMacProfilePass({ ...f.input, resumeOnly: true }, f.deps)).rejects.toThrow('drift')
    expect(read(f.input.sidecarPath).manual).toBe('preserve me')
  })
  it.each(['ambiguous', 'halves', 'floor', 'two_people'])('withholds %s acoustic evidence', async mode => {
    const f = fixture()
    if (mode === 'ambiguous') writeFileSync(f.profilesPath, JSON.stringify({ profiles: [{ name: 'Qualified Person', embeddings: [vector()] }, { name: 'Near Person', embeddings: [vector()] }] }))
    let n = 0
    f.deps.extract = async () => { n++; const v = mode === 'floor' ? vector(2) : mode === 'two_people' && n === 2 ? vector(1) : vector(); return [v, v, mode === 'halves' ? vector(1) : v] }
    expect((await runQualifiedMacProfilePass(f.input, f.deps)).status).toBe('skipped')
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
  })
  it('yields and terminates on its wall budget without labels', async () => {
    const f = fixture(); let clock = 0
    f.deps.now = () => clock
    f.deps.extract = async () => { clock = 90001; return [vector(), vector(), vector()] }
    expect((await runQualifiedMacProfilePass(f.input, f.deps)).reason).toContain('budget_exhausted')
    expect(read(f.input.sidecarPath).speakerRepair).toBeUndefined()
  })
  it('runs through the real batch hook before WAV deletion, preserving proof through final complete', async () => {
    const f = fixture(), { finalizeBatch } = await import('../routes/meeting.js')
    const order: string[] = []
    await finalizeBatch({ ...f.input, sessionId: f.doc.sessionId, entries: f.doc.chunkEntries, streamingWordCount: 10,
      runBatch: async () => { order.push('asr'); return { transcriptionQuality: 'batch', batchTranscript: f.doc.batchTranscript, batchSegments: f.doc.batchSegments.map((s: any) => ({ ...s, segment: { startChunkIdx: s.startChunkIdx, endChunkIdx: s.endChunkIdx, startElapsed: 0, endElapsed: 60000 } })) } as any },
      finalDiarize: async () => { order.push('diarize'); return { status: 'skipped', reason: 'test' } as any },
      qualifiedProfilePass: async input => { order.push(input.resumeOnly ? 'resume' : 'qualified'); expect(existsSync(input.audioDir)).toBe(true); return runQualifiedMacProfilePass(input, f.deps) },
    })
    expect(order).toEqual(['resume', 'asr', 'diarize', 'qualified'])
    const asr = vi.fn(async () => { throw Error('ASR must not replay') })
    await finalizeBatch({ ...f.input, sessionId: f.doc.sessionId, entries: [], streamingWordCount: 10, runBatch: asr, qualifiedProfilePass: input => runQualifiedMacProfilePass(input, f.deps) })
    expect(asr).not.toHaveBeenCalled(); expect(f.extract).toHaveBeenCalledTimes(2)
    expect(existsSync(f.input.audioDir)).toBe(false)
    markCanonicalFinalizationState(f.input.sidecarPath, 'ops_pending', false)
    markCanonicalFinalizationState(f.input.sidecarPath, 'complete', false)
    expect(readMacSpeakerMachineEvidence(read(f.input.sidecarPath)).positions.size).toBe(10)
    for (const name of ['local', 'operations']) { const path = join(f.root, `${name}.copy.json`); copyFileSync(f.input.sidecarPath, path); expect(readMacSpeakerMachineEvidence(read(path)).positions.size).toBe(10) }
  }, 30000)
})
