import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindMacSpeakerShadowRepair, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { reconcileMacSpeaker256Snapshot } from './mac-speaker-live-memory.js'
import { prepareMacSpeakerCallPacket, readMacSpeakerCallView, resolveMacSpeakerCallView } from './mac-speaker-call-view.js'
import { applyMacCallHumanAnnotation, commitMacCallHumanAnnotation, isMacCallHumanName, macCallHumanPaths, macCallHumanScopes, previewMacCallHumanAnnotation, recoverMacCallHumanAnnotation } from './mac-speaker-call-human.js'
import { SYNTHETIC_SPANS, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'
import { projectMacSpeakerRepair, hashMacSpeakerDocument, hashMacSpeakerMachineBinding } from './mac-speaker-repair-projection.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { closeInterruptedCorrections, confirmedChunks, pendingCorrections } from './meeting-corrections.js'
import { reviewMeetingSpeakers } from './meeting-speaker-review.js'

await vi.hoisted(async () => { const { realpathSync } = await import('node:fs'); process.env.COS_DATA_DIR = realpathSync(process.env.COS_DATA_DIR!) })

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const roots: string[] = [], ledgers: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); for (const p of ledgers.splice(0)) rmSync(p, { force: true }) })
function fixture(namedProof = false, edit?: (doc: any) => void) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'call-human-')); roots.push(root)
  const sid = 'mac_00000000-0000-4000-8000-0000000000dd', chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `words for raw ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: sha(`wav${raw}`), similarity: 0, segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], finalSegments: [{ speaker: span.label, startSec: 0, endSec: seconds }], words: [{ word: `raw${raw}`, speaker: span.label, start: 0, end: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.map(({ chunk }) => { const start = offset; offset += chunk.audioDurationMs / 1000; return { word: chunk.text, speaker: chunk.speaker, start, end: offset } })
  let doc: any = { sessionId: sid, sourceType: 'mac_system_audio', finalizationState: 'complete', batchApplied: true, chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  edit?.(doc)
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: sha(`pcm${e.chunkIndex}`), sampleCount: e.chunk.audioDurationMs * 16 }))
  const source: MacShadowRepairSource = { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows: rawAudio.map((r, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: r.sampleCount, usedSampleCount: r.sampleCount })), total: SYNTHETIC_SECONDS * 16000, pcmSHA256: sha('timeline') }, cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: sha('model'), cliSHA256: sha('cli') } }
  if (namedProof) {
    const starts = [0, 11], counts = Object.fromEntries(rawAudio.map(a => [a.rawChunkIndex, a.sampleCount]))
    const windows = starts.map((start, i) => ({ id: `humanprior${i}`, captureStartSample: doc.chunkEntries[start].chunk.elapsed * 16, captureEndSample: doc.chunkEntries[start].chunk.elapsed * 16 + 480000, pcmSha256: String(i + 1).repeat(64), similarity: .95, runnerUpSimilarity: .1, rawChunks: Array.from({ length: 5 }, (_, j) => ({ rawChunkIndex: start + j, audioSha256: rawAudio[start + j].wavSHA256, sampleCount: 96000 })) }))
    const proof = { kind: 'profile-match' as const, profileName: 'Jeremy Example', profileSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64), algorithmVersion: 'human-prior-proof', crossWindowCosines: [[1, .95], [.95, 1]], windows }
    const assignments = starts.flatMap(start => Array.from({ length: 5 }, (_, j) => start + j)).map(raw => { const w = doc.batchSegments[0].speakerWords[raw]; return { rawChunkIndex: raw, from: doc.chunks[raw].speaker, to: 'Jeremy Example', evidenceId: 'prior_named', targetEvidence: proof, batchWords: [{ segmentIndex: 0, wordIndex: raw, from: w.speaker, word: w.word, start: w.start, end: w.end }] } })
    const prior = projectMacSpeakerRepair(doc, { id: 'prior_named', evidenceHash: sha('evidence'), expectedDocumentHash: hashMacSpeakerDocument(doc), protectedRawChunkIndices: [], rawAudioSampleCounts: counts, assignments })
    doc = prior.doc; doc.correctionRevision = 1
    doc.speakerRepair = { id: 'prior_named', evidenceHash: sha('evidence'), machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(doc), receipt: prior.receipt, rawAudioSampleCounts: counts } }
    source.currentJSON = JSON.stringify(doc)
  }
  const input = { ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source), generation: 'test-human-generation' }, state = reconcileMacSpeaker256Snapshot(null, input), packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'anonymous-estimate' })
  const files = { sidecarPath: join(root, 'record.g2-chunks.json'), meetingPath: join(root, 'record.md') }, paths = macCallHumanPaths(files, sid)
  ledgers.push(paths.ledger); mkdirSync(join(paths.ledger, '..'), { recursive: true })
  const markdown = '# Test\n\n## Transcript\n' + doc.batchSegments[0].speakerWords.map((w: any) => `[${w.speaker}]: ${w.word}`).join('\n')
  writeFileSync(files.sidecarPath, input.currentJSON); writeFileSync(files.meetingPath, markdown); writeFileSync(paths.packet, JSON.stringify(packet))
  const view = resolveMacSpeakerCallView(input.currentJSON, '', packet)
  const scopes = macCallHumanScopes({ baseJSON: input.currentJSON, markdown, ledgerJSONL: '', annotationJSON: null, packet, view })
  const scope = scopes.find(s => s.members.some(m => m.before === 'Voice 2')) ?? scopes[0]
  const member = scope.members.find(m => m.before === 'Voice 2') ?? scope.members[0], selected = [member.rawChunkIndex]
  return { root, sid, doc, input, packet, files, paths, markdown, view, scopes, scope, member, selected }
}
function commit(f: ReturnType<typeof fixture>, afterWrite?: (index: number) => void) { return commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: f.scope, selectedRawChunkIndices: f.selected, to: 'Human Example', afterWrite }) }

describe('scoped human call annotations', () => {
  it('rejects machine placeholders at preview, publication, and retained human evidence boundaries without changing journals', () => {
    const f = fixture()
    expect(isMacCallHumanName('Brigitta Pólya')).toBe(true)
    for (const to of ['Ext', 'ext', 'Unknown', 'MU', 'Unidentified', 'Speaker', 'Voice 1']) {
      expect(isMacCallHumanName(to)).toBe(false)
      expect(() => previewMacCallHumanAnnotation(f.input.currentJSON, f.markdown, f.view, f.scope, f.selected, to)).toThrow('explicit name')
      expect(() => commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: f.scope, selectedRawChunkIndices: f.selected, to })).toThrow('explicit name')
    }
    expect(() => readFileSync(f.paths.ledger)).toThrow(); expect(() => readFileSync(f.paths.journal)).toThrow()
    commit(f)
    const journal = readFileSync(f.paths.journal, 'utf8'), annotation = readFileSync(f.paths.annotation, 'utf8'), ledger = readFileSync(f.paths.ledger, 'utf8')
    const bad = JSON.parse(annotation); bad.actions[0].to = 'Ext'
    const { annotationSHA256: _old, ...body } = bad; bad.annotationSHA256 = sha(JSON.stringify(body))
    expect(() => applyMacCallHumanAnnotation(f.input.currentJSON, ledger, JSON.stringify(bad), f.view)).toThrow('annotation action')
    expect(readFileSync(f.paths.journal, 'utf8')).toBe(journal); expect(readFileSync(f.paths.annotation, 'utf8')).toBe(annotation); expect(readFileSync(f.paths.ledger, 'utf8')).toBe(ledger)
  })
  it('names only explicit members/fields, preserves BASE+MD and makes low-similarity names human-confirmed in actual reader output', () => {
    const f = fixture(), preview = previewMacCallHumanAnnotation(f.input.currentJSON, f.markdown, f.view, f.scope, f.selected, 'Human Example')
    expect(preview.members).toEqual([f.member]); expect(preview.fields).toBeGreaterThan(2)
    expect(f.member.text).toBe(f.doc.chunks[f.member.position].text); expect(f.member.elapsedMs).toBe(f.doc.chunks[f.member.position].elapsed)
    commit(f)
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.input.currentJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.markdown)
    const view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    expect(view.metadata.humanAnnotation?.members).toBe(1)
    expect(view.doc.chunks[f.member.position].speaker).toBe('Human Example')
    expect(view.doc.chunkEntries[f.member.rawChunkIndex].chunk.speaker).toBe('Human Example')
    expect(view.doc.batchSegments[0].speakerWords[f.member.rawChunkIndex].speaker).toBe('Human Example')
    expect(view.markdown).toContain(`[Human Example]: words for raw ${f.member.rawChunkIndex}`)
    for (const [i, c] of f.doc.chunks.entries()) if (i !== f.member.position) expect(view.doc.chunks[i]).toEqual(c)
    const review = reviewMeetingSpeakers(view.doc.chunks, { confirmedChunks: confirmedChunks(f.sid), batchSegments: view.doc.batchSegments })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
    expect(JSON.stringify(view.doc.speakerRepair)).toBe(JSON.stringify(f.doc['speakerRepair' as keyof typeof f.doc]))
  })
  it('keeps a qualified prior named machine repair on immutable BASE while adding disjoint human annotations', () => {
    const f = fixture(true), proof = JSON.stringify(f.doc.speakerRepair)
    expect(readMacSpeakerMachineEvidence(JSON.parse(f.input.currentJSON)).status).toBe('qualified')
    expect(f.scope.members.every(m => f.doc.chunks[m.position].speaker !== 'Jeremy Example')).toBe(true)
    commit(f)
    const base = JSON.parse(readFileSync(f.files.sidecarPath, 'utf8')), view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    expect(readMacSpeakerMachineEvidence(base).status).toBe('qualified')
    expect(JSON.stringify(view.doc.speakerRepair)).toBe(proof)
    for (const [i, c] of f.doc.chunks.entries()) if (c.speaker === 'Jeremy Example') expect(view.doc.chunks[i]).toEqual(c)
    expect(view.doc.chunks[f.member.position].speaker).toBe('Human Example')
  })
  it('keeps a crossing HQ word and foreign nested speaker outside an explicit one-raw selection', () => {
    const f = fixture(false, doc => {
      const raw = doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 2')
      doc.batchSegments[0].speakerWords[raw].end += 1
      for (const c of [doc.chunks[raw], doc.chunkEntries[raw].chunk]) c.finalSegments.push({ speaker: 'Voice 3', startSec: 1, endSec: 2 })
    })
    commit(f)
    const view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    expect(view.doc.chunks[f.member.position].speaker).toBe('Human Example')
    expect(view.doc.chunks[f.member.position].finalSegments[1].speaker).toBe('Voice 3')
    expect(view.doc.chunkEntries[f.member.rawChunkIndex].chunk.finalSegments[1].speaker).toBe('Voice 3')
    expect(view.doc.batchSegments[0].speakerWords[f.member.rawChunkIndex].speaker).toBe('Voice 2')
    expect(view.doc.chunks[f.member.position + 1].speaker).toBe('Voice 2')
  })
  it('makes an unaccepted automatic Voice nameable only through an explicitly reviewed singleton selection', () => {
    const f = fixture(), scope = f.scopes.find(s => s.displayLabel === 'Voice 4')!
    expect(scope.reviewBasis).toBe('automatic-label-only'); expect(scope.identityId).toMatch(/^review_/)
    expect(f.packet.groups.some(g => g.memberVoices.includes('Voice 4'))).toBe(false)
    expect(scope.members.length).toBeGreaterThan(1)
    const selected = [scope.members[0].rawChunkIndex]
    expect(() => commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope, selectedRawChunkIndices: [f.member.rawChunkIndex], to: 'Review Example' })).toThrow('selection outside reviewed group')
    commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope, selectedRawChunkIndices: selected, to: 'Review Example' })
    const view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    expect(view.doc.chunks[scope.members[0].position].speaker).toBe('Review Example')
    for (const member of scope.members.slice(1)) expect(view.doc.chunks[member.position].speaker).toBe('Voice 4')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.input.currentJSON)
  })
  it('never creates singleton scopes for named, generic Ext, or protected automatic rows', () => {
    const f = fixture(false, doc => { for (const [i, c] of doc.chunks.entries()) if (c.speaker === 'Voice 9') { c.manuallyCorrected = true; doc.chunkEntries[i].chunk.manuallyCorrected = true } })
    const singleton = f.scopes.filter(s => s.reviewBasis === 'automatic-label-only')
    expect(singleton.some(s => s.members.some(m => m.before === 'Voice 9'))).toBe(false)
    expect(f.scopes.every(s => s.members.every(m => /^Voice [1-9]\d?$/.test(m.before)))).toBe(true)
    expect(f.scopes.some(s => s.members.some(m => ['Ext', 'Dana Fictional'].includes(m.before)))).toBe(false)
    const protectedRaw = f.doc.chunkEntries.flatMap((e: any) => e.chunk.manuallyCorrected ? [e.chunkIndex] : [])
    expect(f.scopes.every(s => s.members.every(m => !protectedRaw.includes(m.rawChunkIndex)))).toBe(true)
  })
  it('refuses missing/duplicate/out-of-group selections, stale full source, Markdown, ledger and packet reviews before writing', () => {
    const f = fixture()
    for (const selectedRawChunkIndices of [[], [f.selected[0], f.selected[0]], [9999]]) expect(() => commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: f.scope, selectedRawChunkIndices, to: 'Human Example' })).toThrow()
    const changes = [[f.files.sidecarPath, `${f.input.currentJSON}\n`], [f.files.meetingPath, f.markdown + '\n'], [f.paths.ledger, '{"human":"later"}\n'], [f.paths.packet, JSON.stringify({ ...f.packet, generation: 'new-generation' })]]
    for (const [path, bytes] of changes) {
      const original = path === f.paths.ledger ? null : readFileSync(path, 'utf8'); writeFileSync(path, bytes)
      expect(() => commit(f)).toThrow(/reviewed source changed/)
      if (original === null) rmSync(path); else writeFileSync(path, original)
    }
    expect(() => readFileSync(f.paths.annotation)).toThrow()
  })
  it('recovers a ledger-first interruption exactly and refuses later human bytes instead of overwriting them', () => {
    const f = fixture()
    expect(() => commit(f, i => { if (i === 0) throw Error('interrupted after ledger') })).toThrow('interrupted after ledger')
    expect(() => readFileSync(f.paths.annotation)).toThrow()
    const interruptedLedger = readFileSync(f.paths.ledger, 'utf8')
    // This is the actual startup closeout called by recoverInterruptedNaming.
    // All rows of the human decision became visible in the same atomic rename.
    expect(pendingCorrections(f.sid)).toHaveLength(0)
    expect(closeInterruptedCorrections()).toBe(0)
    expect(readFileSync(f.paths.ledger, 'utf8')).toBe(interruptedLedger)
    recoverMacCallHumanAnnotation(f.files, f.sid)
    const after = readFileSync(f.paths.annotation, 'utf8'), ledger = readFileSync(f.paths.ledger, 'utf8')
    recoverMacCallHumanAnnotation(f.files, f.sid)
    expect(readFileSync(f.paths.annotation, 'utf8')).toBe(after); expect(readFileSync(f.paths.ledger, 'utf8')).toBe(ledger)
    writeFileSync(f.paths.ledger, ledger + '{"later":"human"}\n')
    expect(() => recoverMacCallHumanAnnotation(f.files, f.sid)).toThrow('completed annotation changed')
    expect(readFileSync(f.paths.ledger, 'utf8')).toContain('later')
  })
  it('refuses a copy missing another copy’s prior human decisions even after its automatic packet is freshly prepared', () => {
    const a = fixture(), b = fixture()
    commit(a)
    const ledger = readFileSync(a.paths.ledger, 'utf8'), annotationA = readFileSync(a.paths.annotation, 'utf8')
    const { generation, sourceBindingSHA256: _oldBinding, ...oldSource } = b.input
    const source = { ...oldSource, ledgerJSONL: ledger }, input = { ...source, generation, sourceBindingSHA256: bindMacSpeakerShadowRepair(source) }
    const state = reconcileMacSpeaker256Snapshot(null, input), packet = prepareMacSpeakerCallPacket(input, state, { admission: 'qualified', projectionPolicy: 'anonymous-estimate' })
    const view = resolveMacSpeakerCallView(input.currentJSON, ledger, packet)
    expect(view.metadata.status).toBe('applied')
    writeFileSync(b.paths.packet, JSON.stringify(packet))
    expect(() => macCallHumanScopes({ baseJSON: input.currentJSON, markdown: b.markdown, ledgerJSONL: ledger, annotationJSON: null, packet, view })).toThrow('copy is missing prior human decisions')
    // Exercise the commit fence independently of the scope-creation refusal:
    // this previously reviewable OTHER group has current full source hashes.
    const old = b.scopes.find(s => s.members.some(m => m.before === 'Voice 3'))!
    const { scopeSHA256: _oldScope, ...body } = { ...old, ledgerSHA256: sha(ledger), packetSHA256: packet.packetSHA256, generation: packet.generation, packetRevision: packet.revision }
    const scope = { ...body, scopeSHA256: sha(JSON.stringify(body)) }
    expect(() => commitMacCallHumanAnnotation({ files: b.files, captureId: b.sid, scope, selectedRawChunkIndices: [scope.members[0].rawChunkIndex], to: 'Other Example' })).toThrow('copy is missing prior human decisions')
    expect(readFileSync(a.paths.ledger, 'utf8')).toBe(ledger); expect(readFileSync(a.paths.annotation, 'utf8')).toBe(annotationA)
    expect(readFileSync(b.files.sidecarPath, 'utf8')).toBe(b.input.currentJSON); expect(readFileSync(b.files.meetingPath, 'utf8')).toBe(b.markdown)
    expect(() => readFileSync(b.paths.annotation)).toThrow(); expect(() => readFileSync(b.paths.journal)).toThrow(); expect(() => readFileSync(b.paths.lock)).toThrow()
  })
  it('refuses a source edit after the first target and preserves a foreign journal replacement', () => {
    const f = fixture()
    expect(() => commit(f, i => { if (i === 0) writeFileSync(f.files.sidecarPath, `${f.input.currentJSON}\n`) })).toThrow('source changed')
    expect(() => readFileSync(f.paths.annotation)).toThrow()
    expect(() => recoverMacCallHumanAnnotation(f.files, f.sid)).toThrow('source changed')
    writeFileSync(f.files.sidecarPath, f.input.currentJSON)
    expect(() => recoverMacCallHumanAnnotation(f.files, f.sid, i => { if (i === 0) writeFileSync(f.paths.journal, 'EXTERNAL JOURNAL\n') })).toThrow('journal changed')
    expect(readFileSync(f.paths.journal, 'utf8')).toBe('EXTERNAL JOURNAL\n')
  })
  it('refuses to publish the second target after losing its capture lock and leaves the foreign lock untouched', () => {
    const f = fixture()
    expect(() => commit(f, i => { if (i === 0) writeFileSync(f.paths.lock, 'FOREIGN LOCK\n') })).toThrow('lock drift')
    expect(readFileSync(f.paths.lock, 'utf8')).toBe('FOREIGN LOCK\n')
    expect(() => readFileSync(f.paths.annotation)).toThrow()
  })
  it('human evidence remains independent of automatic packet withdrawal; stale or forged ledger links fail closed', () => {
    const f = fixture(); commit(f)
    rmSync(f.paths.packet)
    const view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON)
    expect(view.doc.chunks[f.member.position].speaker).toBe('Human Example')
    const annotation = readFileSync(f.paths.annotation, 'utf8'), ledger = readFileSync(f.paths.ledger, 'utf8')
    expect(() => applyMacCallHumanAnnotation(f.input.currentJSON, ledger + '\n', annotation, f.view)).toThrow('annotation source binding')
    const forged = JSON.parse(annotation); forged.actions[0].members[0].position++
    const { annotationSHA256: _, ...body } = forged; forged.annotationSHA256 = sha(JSON.stringify(body))
    expect(() => applyMacCallHumanAnnotation(f.input.currentJSON, ledger, JSON.stringify(forged), f.view)).toThrow('human member source')
    const shifted = JSON.parse(annotation); shifted.actions[0].fields.pop()
    const { annotationSHA256: _h, ...shiftedBody } = shifted; shifted.annotationSHA256 = sha(JSON.stringify(shiftedBody))
    expect(() => applyMacCallHumanAnnotation(f.input.currentJSON, ledger, JSON.stringify(shifted), f.view)).toThrow('human reviewed field scope')
  })
  it('re-reviews only previously authored human members, including after packet removal, without reopening protected automatic rows', () => {
    const f = fixture(); commit(f); rmSync(f.paths.packet)
    const ledger = readFileSync(f.paths.ledger, 'utf8'), annotation = readFileSync(f.paths.annotation, 'utf8'), view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    const scopes = macCallHumanScopes({ baseJSON: f.input.currentJSON, markdown: f.markdown, ledgerJSONL: ledger, annotationJSON: annotation, packet: null, view })
    expect(scopes).toHaveLength(1); expect(scopes[0]).toMatchObject({ kind: 'human', displayLabel: 'Human Example' })
    expect(scopes[0].members.map(m => m.rawChunkIndex)).toEqual(f.selected)
    expect(scopes[0].members[0].before).toBe('Human Example')
    commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: scopes[0], selectedRawChunkIndices: f.selected, to: 'Corrected Example' })
    const renamed = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    expect(renamed.doc.chunks[f.member.position].speaker).toBe('Corrected Example')
    expect(renamed.doc.speakers).toContain('Corrected Example'); expect(renamed.doc.speakers).not.toContain('Human Example')
    expect(confirmedChunks(f.sid).get(f.member.position)).toBe('Corrected Example')
    expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.input.currentJSON)
  })
  it('refuses to cut an already human-confirmed HQ word when correcting only part of its source members', () => {
    const f = fixture(false, doc => { const raw = doc.chunkEntries.findIndex((e: any) => e.chunk.speaker === 'Voice 2'); doc.batchSegments[0].speakerWords[raw].end += 1 })
    const selected = [f.member.rawChunkIndex, f.member.rawChunkIndex + 1]
    commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope: f.scope, selectedRawChunkIndices: selected, to: 'Human Example' })
    const ledger = readFileSync(f.paths.ledger, 'utf8'), annotationJSON = readFileSync(f.paths.annotation, 'utf8'), view = readMacSpeakerCallView(f.files.sidecarPath, f.input.currentJSON, f.files.meetingPath)
    const scope = macCallHumanScopes({ baseJSON: f.input.currentJSON, markdown: f.markdown, ledgerJSONL: ledger, annotationJSON, packet: null, view })[0]
    expect(() => previewMacCallHumanAnnotation(f.input.currentJSON, f.markdown, view, scope, f.selected, 'Corrected Example')).toThrow('previously human-confirmed word')
    expect(() => commitMacCallHumanAnnotation({ files: f.files, captureId: f.sid, scope, selectedRawChunkIndices: f.selected, to: 'Corrected Example' })).toThrow('previously human-confirmed word')
    expect(readFileSync(f.paths.ledger, 'utf8')).toBe(ledger); expect(readFileSync(f.paths.annotation, 'utf8')).toBe(annotationJSON)
  })
  it('rejects a guessed Markdown relabel before creating a correction and never enrolls or writes profiles', () => {
    const f = fixture(), bad = f.markdown.replace(`words for raw ${f.member.rawChunkIndex}`, 'different spoken tokens')
    expect(() => previewMacCallHumanAnnotation(f.input.currentJSON, bad, f.view, f.scope, f.selected, 'Human Example')).toThrow()
    expect(() => readFileSync(f.paths.ledger)).toThrow()
    expect(() => readFileSync(f.paths.annotation)).toThrow()
  })
  it('actual HTTP preview/confirm uses exact scope membership, rejects legacy/profile bypasses and refreshes the panel/copy', async () => {
    const f = fixture(), { default: express } = await import('express'), { createMeetingRouter } = await import('../routes/meeting.js')
    const oldOps = process.env.COS_OPERATIONS_DIR, oldMeetings = process.env.COS_MEETINGS_ROOT; delete process.env.COS_OPERATIONS_DIR; delete process.env.COS_MEETINGS_ROOT
    const app = express(); app.use(express.json()); app.use('/api', createMeetingRouter({ store: { findBySessionId: () => ({ sidecarPath: f.files.sidecarPath, filepath: f.files.meetingPath, title: 'Human review', domain: 'personal', filename: 'record.md', durationMin: 6 }) } as any }))
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/meeting/${f.sid}`
      const panel = await (await fetch(`${origin}/speakers`)).json(), group = panel.groupScopes.find((g: any) => g.identityId === f.scope.identityId)
      expect(panel.mutable).toBe(false); expect(group.members).toContainEqual(f.member)
      writeFileSync(f.paths.journal, JSON.stringify({ phase: 'prepared' }))
      const competing = await fetch(`${origin}/relabel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Voice 2', to: 'Other Example', dryRun: true }) })
      expect(competing.status).toBe(409); expect((await competing.json()).reason).toBe('human_annotation_recovery_required')
      rmSync(f.paths.journal)
      const payload = { recordId: panel.recordId, expectedRevision: panel.sourceRevision, scopeSHA256: group.scopeSHA256, rawChunkIndices: f.selected, to: 'Human Example' }
      const post = (body: unknown) => fetch(`${origin}/speaker-groups/${f.scope.identityId}/relabel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      expect((await post({ ...payload, dryRun: true, assignVoiceProfile: true })).status).toBe(400)
      expect((await post({ ...payload, dryRun: true, rawChunkIndices: [9999] })).status).toBe(409)
      const preview = await post({ ...payload, dryRun: true }); expect(preview.status).toBe(200); expect((await preview.json()).preview.members).toEqual([f.member])
      expect(() => readFileSync(f.paths.ledger)).toThrow()
      const applied = await post({ ...payload, confirm: true }); expect(applied.status).toBe(200)
      expect((await post({ ...payload, confirm: true })).status).toBe(409)
      const refreshed = await (await fetch(`${origin}/speakers`)).json(), content = await (await fetch(`${origin}/content`)).json()
      expect(refreshed.sourceRevision).not.toBe(panel.sourceRevision)
      expect(refreshed.voices.find((v: any) => v.label === 'Human Example')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
      expect(content.attendees.some((v: any) => v.label === 'Human Example' || v.name === 'Human Example')).toBe(true)
      expect(JSON.stringify(content)).toContain('Human Example')
      const authored = refreshed.groupScopes.find((g: any) => g.displayLabel === 'Human Example')
      expect(authored.members.map((m: any) => m.rawChunkIndex)).toEqual(f.selected)
      const correction = await fetch(`${origin}/speaker-groups/${authored.identityId}/relabel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: refreshed.recordId, expectedRevision: refreshed.sourceRevision, scopeSHA256: authored.scopeSHA256, rawChunkIndices: f.selected, to: 'Corrected Example', confirm: true }) })
      expect(correction.status).toBe(200)
      const corrected = await (await fetch(`${origin}/speakers`)).json()
      expect(corrected.voices.find((v: any) => v.label === 'Corrected Example')).toMatchObject({ nameAsserted: true, confirmedByHuman: true })
      writeFileSync(f.paths.annotation, 'CORRUPT HUMAN ANNOTATION')
      const invalid = await (await fetch(`${origin}/speakers`)).json()
      expect(invalid).toMatchObject({ mutable: false, mutationBlockedReason: 'human_annotation_invalid' })
      const legacy = await fetch(`${origin}/relabel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Voice 2', to: 'Other Example', dryRun: true }) })
      expect(legacy.status).toBe(409); expect((await legacy.json()).reason).toBe('human_annotation_invalid')
      expect(readFileSync(f.files.sidecarPath, 'utf8')).toBe(f.input.currentJSON); expect(readFileSync(f.files.meetingPath, 'utf8')).toBe(f.markdown)
    } finally { await new Promise<void>(r => server.close(() => r())); if (oldOps === undefined) delete process.env.COS_OPERATIONS_DIR; else process.env.COS_OPERATIONS_DIR = oldOps; if (oldMeetings === undefined) delete process.env.COS_MEETINGS_ROOT; else process.env.COS_MEETINGS_ROOT = oldMeetings }
  })
})
